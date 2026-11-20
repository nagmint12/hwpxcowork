// 적용된 제안 이력의 UI 재현용 받침. 실제 서비스 경로로 합성 제안만 저장한다.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Service } from '../../server/service.js';
import { Store } from '../../server/store.js';
import { formCellDoc } from './form-cell-doc.mjs';
import { startServer } from './server.mjs';

export const APPLIED_COUNT = 159;
export const LAST_OLD = '소회의실';
export const LAST_NEW = '합성 기록 전용 장소 159';
export const PENDING_TEXT = '반영되지 않은 검색 단서 160';
export const UNDONE_TEXT = '되돌려진 검색 단서 161';
const USERS = [
  { name: '합성 문서 작성자', role: 'admin' },
  { name: '합성 문서 편집자', role: 'editor' },
  { name: '합성 문서 열람자', role: 'viewer' },
];
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** 멀티플렉스는 이 시험의 루프백 HTTP·WS에 한정. 후보 모듈만 basename으로 교체한다. */
async function webOverlay(backend, candidateDir) {
  const source = new URL(backend);
  const assets = new Map();
  if (candidateDir) for (const entry of fs.readdirSync(candidateDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z0-9_.-]+\.(?:js|css)$/i.test(entry.name)) {
      assets.set(`/${entry.name}`, fs.readFileSync(path.join(candidateDir, entry.name)));
    }
  }
  const requests = [];
  const sockets = new Set();
  const proxy = http.createServer((request, response) => {
    const route = new URL(request.url, source).pathname;
    requests.push({ method: request.method, path: route });
    const candidate = assets.get(route);
    if (candidate && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(200, { 'Content-Type': route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Content-Length': candidate.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : candidate);
      return;
    }
    const forwarded = http.request({ hostname: source.hostname, port: source.port, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { if (!response.writableFinished) forwarded.destroy(); });
    request.pipe(forwarded);
  });
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, source).pathname !== '/ws') return socket.destroy();
    const onward = net.connect(Number(source.port), source.hostname);
    onward.on('error', () => socket.destroy());
    socket.on('error', () => onward.destroy());
    socket.on('close', () => onward.destroy());
    onward.once('connect', () => {
      let headers = '';
      for (let index = 0; index < request.rawHeaders.length; index += 2) headers += `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`;
      onward.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
      if (head.length) onward.write(head);
      socket.pipe(onward).pipe(socket);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return { base: `http://127.0.0.1:${proxy.address().port}`, requests, assets: [...assets.keys()],
    close: () => new Promise((resolve) => { proxy.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}

export async function startAppliedHistoryFixture({ candidateDir } = {}) {
  const srv = await startServer({ ai: 'off', users: USERS, config: { verify: { pages: false }, tutorial: { enabled: false } } });
  let proxy;
  try {
    const owner = srv.users.admin;
    const viewer = srv.userList.find((user) => user.role === 'viewer');
    const store = new Store(srv.dataDir);
    const service = new Service({ store, config: { root: srv.tmpDir, dataDir: srv.dataDir, users: srv.userList, tutorial: { enabled: false }, verify: { pages: false } },
      hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
    const { doc, key } = await formCellDoc();
    doc.setTracking(false);
    const rows = Array.from({ length: APPLIED_COUNT - 1 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      const old = `원래 문단 ${number}`;
      return { old, revised: index === 157 ? '' : `수정된 문단 ${number}`,
        source: index === 0 ? `🌱 ${old} · 뒤쪽` : index === 157 ? `앞쪽 · ${old} · 뒤쪽` : old };
    });
    const refs = doc.insertFinalParagraphsAfter(0, doc.sections[0].bodyParas.length - 1, [...rows.map((row) => row.source), '남은 검토 문장', '되돌리기 준비 문장']);
    const location = doc.tables().find((table) => table.key === key).cells.find((cell) => cell.row === 0 && cell.col === 3);
    const id = store.create({ fileName: '합성 반영 이력.hwpx', bytes: Buffer.from(await doc.save()), by: owner.name,
      settings: { editMode: 'realtime', track: 'final', aiApply: 'manual', aiMemo: 'summary' } }).id;

    const makeRequest = async (instruction) => (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction, route: 'queue' }, owner)).request;
    const request = await makeRequest('문단 이름과 표의 장소를 바꿔 주세요.');
    const agent = '합성 AI';
    const body = rows.map((row, index) => ({ ref: refs[index], find: row.old, replace: row.revised }));
    body.push({ ref: location.refs[0], find: LAST_OLD, replace: LAST_NEW });
    const proposed = await service.proposeMany(id, body.map((item) => ({ ...item, type: 'replace', bundle: 'applied-history-test', reason: '이력 확인용 변경', memo: false })), owner, agent, { rid: request.rid });
    assert.equal(proposed.length, APPLIED_COUNT);
    assert.ok(proposed.every((item) => item.ok), JSON.stringify(proposed.find((item) => !item.ok)));
    await service.completeRequest(id, request.rid, { summary: '합성 검토가 끝났습니다.', model: 'fixture-model', execution: 'tool-agent' }, owner, agent);
    const applied = await service.resolveRequest(id, request.rid, { apply: 'rest' }, owner);
    assert.deepEqual([applied.counts.applied, applied.counts.failed], [APPLIED_COUNT, 0]);

    const pending = await makeRequest('남은 검토 문장을 바꿔 주세요.');
    await service.propose(id, { type: 'replace', ref: refs.at(-2), find: '남은 검토 문장', replace: PENDING_TEXT, rid: pending.rid, memo: false }, owner, agent);
    const undoTarget = await service.propose(id, { type: 'replace', ref: refs.at(-1), find: '되돌리기 준비 문장', replace: UNDONE_TEXT, rid: pending.rid, memo: false }, owner, agent);
    await service.completeRequest(id, pending.rid, { summary: '제안 하나를 남겼습니다.' }, owner, agent);
    await service.applyProposal(id, undoTarget.pid, owner);
    await service.undoProposal(id, undoTarget.pid, owner);

    // 한 이력의 글을 나중에 사람이 바꿔 둔다. 역사적 전후 글은 유지하고 이동은 문단까지만 할 수 있어야 한다.
    const later = await store.doc(id);
    later.mergeParagraphText(refs[156], '나중에 수동으로 바꾼 문단', { author: owner.name });
    later.acceptAll();
    const edit = await srv.api(owner).res(`/api/docs/${id}/live?base=${store.readMeta(id).version}&seq=1`, { method: 'PUT', body: Buffer.from(await later.save()) });
    assert.equal(edit.status, 200);
    const privateDoc = store.create({ fileName: '합성 비공개 문서.hwpx', bytes: Buffer.from(await doc.save()), by: owner.name,
      location: { space: 'private', spaceOwner: owner.name } }).id;

    const snapshot = () => {
      const meta = store.readMeta(id);
      return { version: meta.version, versions: meta.versions, milestones: meta.milestones,
        hwpx: hash(store.currentBytes(id)), proposals: hash(JSON.stringify(meta.proposals)), requests: hash(JSON.stringify(meta.requests)) };
    };
    const meta = store.readMeta(id);
    const proposals = meta.proposals;
    assert.equal(proposals.filter((proposal) => proposal.status === 'applied' && proposal.type === 'replace' && proposal.appliedRange).length, APPLIED_COUNT);
    assert.equal(proposals.filter((proposal) => proposal.status === 'pending').length, 1);
    assert.equal(proposals.filter((proposal) => proposal.status === 'undone').length, 1);
    assert.equal(proposals.find((proposal) => proposal.pid === 158).replace, '');
    assert.deepEqual(proposals.find((proposal) => proposal.pid === 1).appliedRange.start, 2);
    assert.equal(meta.settings.track, 'final');
    assert.equal((await store.doc(id)).changes().length, 0, '고친 글만 저장한 현재 문서에 미처리 추적 변경이 없다');
    assert.equal((await srv.api(viewer).res(`/api/docs/${id}/proposals`)).status, 200);
    const privateProposals = await srv.api(viewer).res(`/api/docs/${privateDoc}/proposals`);
    assert.ok([403, 404].includes(privateProposals.status));
    proxy = await webOverlay(srv.base, candidateDir);
    return { ...proxy, id, privateDoc, viewer, owner, requestId: request.rid, snapshot, lastRef: location.refs[0],
      firstRef: refs[0], staleRef: refs[156], deletedRef: refs[157],
      close: async () => { try { await proxy.close(); } finally { await srv.stop(); } } };
  } catch (error) { await proxy?.close(); await srv.stop(); throw error; }
}

// ego-browser의 Node 실행이 별도 OS 프로세스에 있으므로 서버 준비를 일반 Node에서 실행할 수 있다.
// node tests/helpers/applied-history.mjs <새 임시 정보 파일> [후보 웹 파일 폴더]
// 정보 파일은 시험 전용 루프백 자격을 담고 시험 종료 때 지운다.
async function serveFixture(infoPath, candidateDir) {
  assert.ok(infoPath && !fs.existsSync(infoPath), '새 임시 정보 파일 경로가 필요하다');
  const trial = await startAppliedHistoryFixture({ candidateDir });
  const key = randomBytes(20).toString('hex');
  const done = Promise.withResolvers();
  const controller = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) return response.writeHead(403).end();
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ snapshot: trial.snapshot(), requests: trial.requests }));
    }
    if (request.method === 'POST' && request.url === '/stop') {
      response.once('finish', done.resolve);
      return response.writeHead(204).end();
    }
    return response.writeHead(404).end();
  });
  const lease = setTimeout(done.resolve, 150000);
  let wroteInfo = false;
  try {
    controller.listen(0, '127.0.0.1');
    await once(controller, 'listening');
    const { base, assets, id, viewer, owner, requestId, lastRef, firstRef, staleRef, deletedRef } = trial;
    fs.writeFileSync(infoPath, JSON.stringify({ base, assets, id, viewer, owner, requestId, lastRef, firstRef, staleRef, deletedRef,
      control: `http://127.0.0.1:${controller.address().port}`, key }), { flag: 'wx', mode: 0o600 });
    wroteInfo = true;
    console.log('READY: isolated applied-history fixture');
    await done.promise;
  } finally {
    clearTimeout(lease);
    if (wroteInfo) fs.rmSync(infoPath, { force: true });
    await new Promise((resolve) => controller.close(resolve));
    await trial.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await serveFixture(process.argv[2], process.argv[3]);
