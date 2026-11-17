// node --test tests/figure_replace.test.mjs — 문서 그림 교체: 엔진(replacePicture·restorePicture·binaryItem), 서버(list_figures·export_figure·
// 결과 파일 REST·propose_figure replace_ref → 적용·되돌리기), 브리지 로컬 파일 도구(download_attachment_file·upload_result_file — 작업 폴더 밖 거절).
// 한글 2022 확인은 tests/hangul_roundtrip.py 로 따로 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HwpxDoc } from '../engine/doc.js';
import { createBridge } from '../server/bridge.js';
import * as MT from '../server/memotext.js';
import { makePng } from './helpers/image.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const author = '홍길동(Claude)';
const reload = async (d) => HwpxDoc.load(await d.save());
const paraXml = (d, ref) => { const sec = d.sections[Number(/^s(\d+)/.exec(ref)[1])]; const p = sec.byRef(ref); return sec.xml.slice(p.start, p.end); };
const MM = 7200 / 25.4;

/** 그림 하나(캡션 '[그림 N] 응답률')가 든 문서 */
async function docWithFigure() {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  d.insertPictureAfter(0, 0, { data: makePng(400, 200), caption: '응답률' }, { author });
  return reload(d);
}

test('replacePicture: 그림 파일·크기만 바꾸고(폭은 그대로, 높이는 새 비율) 캡션·번호·자리는 그대로, restorePicture 로 되돌린다', async () => {
  const d = await docWithFigure();
  const before = paraXml(d, 's0/p1');
  assert.deepEqual(d.figures().map((f) => [f.ref, f.n, f.binId, f.width, f.height]), [['s0/p1', 1, 'image1', 30000, 15000]]);
  assert.deepEqual([d.binaryItem('image1').href, d.binaryItem('image1').mime, d.binaryItem('nope')], ['BinData/image1.png', 'image/png', null]);
  const r = d.replacePicture('s0/p1', { binId: 'image1', n: 1 }, { data: makePng(800, 600) });
  assert.deepEqual([r.binId, r.width, r.height], ['image2', 30000, 22500]);
  const re = await reload(d);
  assert.deepEqual(re.figures().map((f) => [f.ref, f.binId, f.width, f.height, f.caption?.text]), [['s0/p1', 'image2', 30000, 22500, '[그림 ] 응답률']]);
  const xml = paraXml(re, 's0/p1');
  assert.match(xml, /<hp:orgSz width="60000" height="45000"\/><hp:curSz width="30000" height="22500"\/>/);
  assert.match(xml, /<hc:scaMatrix e1="0\.5" e2="0" e3="0" e4="0" e5="0\.5" e6="0"\/>/);
  assert.match(xml, /<hp:imgClip left="0" right="60000" top="0" bottom="45000"\/>.*<hp:imgDim dimwidth="60000" dimheight="45000"\/><hc:img binaryItemIDRef="image2"/);
  assert.match(xml, /<hp:sz width="30000" widthRelTo="ABSOLUTE" height="22500"/);
  assert.match(xml, /<hp:autoNum num="1" numType="PICTURE">/, '캡션 자동 번호 그대로');
  assert.match(/<hp:pic\b[^>]*>/.exec(xml)[0], /numberingType="PICTURE"/);
  assert.ok(re.container.has('BinData/image1.png') && re.container.has('BinData/image2.png'), '옛 그림 파일은 되돌리기용으로 남긴다');
  // 되돌리기 → 캡션 앞 그림 XML 이 처음과 같고, 바꿔 넣은 그림 파일은 거둔다
  assert.equal(re.restorePicture('s0/p1', 'image2', r.prev), true);
  assert.equal(re.removeUnusedBinary('image2'), true);
  assert.equal(paraXml(re, 's0/p1'), before);
  assert.deepEqual([re.container.has('BinData/image2.png'), re.container.getText('Contents/content.hpf').includes('id="image2"')], [false, false]);
  // width_mm: 폭을 바꾸면 캡션 폭(lastWidth)도 따라간다
  const w = re.replacePicture('s0/p1', { binId: 'image1' }, { data: makePng(800, 600), widthMm: 60 });
  assert.equal(w.width, Math.round(60 * MM));
  assert.match(paraXml(re, 's0/p1'), new RegExp(`lastWidth="${w.width}"`));
  assert.throws(() => re.replacePicture('s0/p1', { binId: 'image9' }, { data: makePng(10, 10) }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => re.replacePicture('s0/p1', { binId: w.binId }, { data: Buffer.from('nope') }), (e) => e.code === 'BAD_IMAGE');
});

test('replacePicture: 가운데 정렬 문단의 본문 폭 그림을 좁히면 왼쪽 여백을 더하지 않고, 낡은 줄 정보(linesegarray)를 지운다', async () => {
  // 매크로테스트용_저장 v19: 본문 폭(42520) 그림을 120mm 로 줄이며 왼쪽 바깥 여백 4252 를 넣어, 가운데 정렬 문단에서 한/글 PDF 의 그림이
  // 가운데보다 28px 오른쪽에 놓였고, 옛 그림 높이의 줄 정보가 남아 편집기(rhwp)는 그림 아래에 빈자리를 남겼다.
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  d.insertPictureAfter(0, 0, { data: makePng(800, 400), caption: '응답률', widthMm: 500 }, { author }); // 본문 폭으로 줄어든다
  const sec = d.sections[0];
  const p = sec.byRef('s0/p1');
  const tw = d.figures()[0].width;
  const seg = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${tw / 2 + 2133}" textheight="${tw / 2 + 2133}" baseline="1" spacing="880" horzpos="0" horzsize="${tw}" flags="393216"/></hp:linesegarray>`;
  const xml = sec.xml.slice(p.start, p.end);
  sec.load(sec.xml.slice(0, p.start) + xml.replace(/<\/hp:p>$/, `${seg}</hp:p>`) + sec.xml.slice(p.end));
  const re = await reload(d);
  assert.match(paraXml(re, 's0/p1'), /<hp:outMargin left="0"/);
  assert.match(paraXml(re, 's0/p1'), /<hp:linesegarray>/);
  const r = re.replacePicture('s0/p1', { binId: 'image1' }, { data: makePng(800, 400), widthMm: 120 });
  assert.equal(r.width, Math.round(120 * MM));
  const after = paraXml(await reload(re), 's0/p1');
  assert.match(after, /<hp:outMargin left="0"/, '가운데 정렬 문단이면 왼쪽 여백 0 그대로');
  assert.doesNotMatch(after, /<hp:linesegarray>/, '그림 크기를 바꾼 문단의 줄 정보는 지운다');
  assert.match(after, /<hp:sz width="34016"/);
});

/** MCP 도구 한 번(브리지 세션 머리글 흉내) → 결과 JSON | { error } */
async function mcp(srv, name, args, session = 'sessA') {
  const r = await fetch(`${srv.base}/mcp?agent=ReplaceTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  const text = res.content[0].text;
  return res.isError ? { error: text } : JSON.parse(text);
}

/** 서버에 그림 하나 든 문서를 만들고(그림 제안 적용) 내 요청 하나 → { doc, D, req } */
async function setup(srv) {
  const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
  const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
  const fig = await A(`${D}/proposals`, { method: 'POST', body: { type: 'figure', afterRef: 's0/p1', caption: '응답률', imageBase64: makePng(400, 200).toString('base64'), fileName: '원본.png' } });
  await A(`${D}/proposals/${fig.pid}/apply`, { method: 'POST' });
  const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '[그림 1] 글꼴을 바꿔 다시 그려 줘', route: 'queue', target: { ref: 's0/p2' } } })).request;
  return { doc, D, req, A };
}

test('그림 교체(서버): list_figures·export_figure·결과 파일 REST(선점 세션·중복)·propose_figure replace_ref → 적용·되돌리기', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const { doc, D, req, A } = await setup(srv);
    const figs = await mcp(srv, 'list_figures', { doc_id: doc.id });
    assert.deepEqual(figs.map((f) => [f.figure, f.caption, f.px, f.type]), [['s0/p2', '[그림 ] 응답률', [400, 200], 'png']]);
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid });
    // 문서 그림 → 요청 입력 첨부(같은 그림은 한 번만)
    const ex = await mcp(srv, 'export_figure', { doc_id: doc.id, request_id: req.rid, figure: 's0/p2', expected_attempt: 1 });
    assert.deepEqual([ex.name, ex.kind, ex.figure, ex.usedBy], ['응답률.png', 'image', 's0/p2', [req.rid]]);
    assert.equal(Buffer.compare(Buffer.from(await A(`${D}/attachments/${ex.aid}`)), makePng(400, 200)), 0);
    const again = await mcp(srv, 'export_figure', { doc_id: doc.id, request_id: req.rid, figure: 's0/p2' });
    assert.deepEqual([again.aid, again.duplicate], [ex.aid, true]);
    assert.match((await mcp(srv, 'export_figure', { doc_id: doc.id, request_id: req.rid, figure: 's0/p0' })).error, /NO_FIGURE/);
    assert.match((await mcp(srv, 'export_figure', { doc_id: doc.id, request_id: req.rid, figure: 's0/p2' }, 'sessB')).error, /CLAIMED/);
    // 결과 파일 REST(브리지 upload_result_file 경로): 같은 세션·시도만, 같은 내용은 한 번
    const up = (session, bytes = makePng(800, 600), attempt = 1) => fetch(`${srv.base}${D}/requests/${req.rid}/files?agent=Claude%20Code&attempt=${attempt}`, {
      method: 'POST', body: bytes, headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('글꼴 바꾼 그림.png') } });
    const u1 = await (await up('sessA')).json();
    assert.deepEqual([u1.name, u1.kind, u1.usedBy], ['글꼴 바꾼 그림.png', 'image', [req.rid]]);
    assert.equal((await (await up('sessA')).json()).duplicate, true);
    const other = await up('sessB');
    assert.deepEqual([other.status, (await other.json()).error], [409, 'CLAIMED']);
    const stale = await up('sessA', makePng(10, 10), 2);
    assert.deepEqual([stale.status, (await stale.json()).error], [409, 'ATTEMPT_CHANGED']);
    // 교체 제안: 캡션은 문서 것 그대로(caption 무시), 대상 그림 기억
    assert.match((await mcp(srv, 'propose_figure', { doc_id: doc.id, after_ref: 's0/p1', replace_ref: 's0/p2', attachment_id: u1.aid })).error, /BAD_FIGURE/);
    assert.match((await mcp(srv, 'propose_figure', { doc_id: doc.id, replace_ref: 's0/p1', attachment_id: u1.aid, request_id: req.rid })).error, /NO_FIGURE/);
    const p = await mcp(srv, 'propose_figure', { doc_id: doc.id, replace_ref: 's0/p2', attachment_id: u1.aid, caption: '무시됨', request_id: req.rid, expected_attempt: 1 });
    assert.deepEqual([p.type, p.ref, p.afterRef, p.memo, p.figure.caption, p.figure.replace], ['figure', 's0/p2', 's0/p2', false, '', { binId: 'image1', n: 1, caption: '[그림 ] 응답률' }]);
    // 앞에 문단이 들어가도 교체 대상 주소를 따라간다
    const ins = await A(`${D}/proposals`, { method: 'POST', body: { type: 'insert', afterRef: 's0/p0', text: '앞에 넣은 문단' } });
    await A(`${D}/proposals/${ins.pid}/apply`, { method: 'POST' });
    const ap = await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
    assert.deepEqual([ap.status, ap.ref, ap.binId], ['applied', 's0/p3', 'image2']);
    const saved = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(saved.figures().map((f) => [f.ref, f.binId, f.width, f.height, f.caption?.text]), [['s0/p3', 'image2', 30000, 22500, '[그림 ] 응답률']]);
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === req.rid);
    assert.match(memo.text, /반영 1건/);
    const pm = MT.renderProposalMemo(ap);
    assert.ok(pm.startsWith(`[제안 ${p.pid} · 그림 교체 · AI 작업 #${req.rid}]`) && pm.includes('이 문단의 그림 「[그림 ] 응답률」을 새 그림(글꼴 바꾼 그림.png)으로 교체'), pm);
    // 되돌리기 → 처음 그림(image1)으로, 바꿔 넣은 그림 파일은 거둔다
    const un = await A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
    assert.equal(un.status, 'undone');
    const back = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(back.figures().map((f) => [f.ref, f.binId, f.width, f.height]), [['s0/p3', 'image1', 30000, 15000]]);
    assert.deepEqual([back.container.has('BinData/image2.png'), back.container.has('BinData/image1.png')], [false, true]);
  } finally { await srv.stop(); }
});

test('브리지 로컬 파일 도구: 작업 폴더로 내려받기·작업 폴더 안 파일만 올리기 → 교체 제안까지(파일은 대화로 오가지 않음)', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-outside-'));
  const open = async (opts) => {
    // 예전 연결 도구(propose_figure·get_attachment_file 등)를 재는 시험 — 브리지 기본이 새 연결로 바뀐 뒤(2026-11-17)에는 예전 연결을 밝힌다
    const bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, log: () => {}, surface: 'v1', ...opts });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await bridge.start(serverT);
    const client = new Client({ name: 'claude-code', version: '2.1.999-test' });
    await client.connect(clientT);
    return { bridge, client };
  };
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  try {
    const { doc, D, req, A } = await setup(srv);
    // 파일 도구 없이: 원격 목록 그대로(ChatGPT 파일 도구 포함)
    const plain = await open({});
    const plainNames = (await plain.client.listTools()).tools.map((t) => t.name);
    assert.ok(plainNames.includes('get_attachment_file') && !plainNames.includes('download_attachment_file'));
    await plain.bridge.stop();
    const { bridge, client } = await open({ filesDir: work });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(['download_attachment_file', 'upload_result_file', 'list_figures', 'export_figure', 'propose_figure'].every((n) => names.includes(n)), names.join(','));
    assert.ok(!names.includes('get_attachment_file') && !names.includes('save_result_file'), 'ChatGPT 전용 파일 도구는 숨긴다');
    await call(client, 'start_request', { doc_id: doc.id, request_id: req.rid });
    const ex = await call(client, 'export_figure', { doc_id: doc.id, request_id: req.rid, figure: 's0/p2', expected_attempt: 1 });
    const got = await call(client, 'download_attachment_file', { doc_id: doc.id, attachment_id: ex.aid });
    assert.equal(path.dirname(got.path), path.join(fs.realpathSync(work), 'in', doc.id));
    assert.equal(Buffer.compare(fs.readFileSync(got.path), makePng(400, 200)), 0);
    assert.deepEqual([got.name, got.size, got.mime], ['응답률.png', makePng(400, 200).length, 'image/png']);
    assert.match((await call(client, 'download_attachment_file', { doc_id: doc.id, attachment_id: 'a999' })).error, /NO_ATTACHMENT/);
    // 작업 폴더 안(상대 경로 = 작업 폴더 기준)만 올린다
    fs.writeFileSync(path.join(work, 'out', '새 그림.png'), makePng(800, 600));
    const up = await call(client, 'upload_result_file', { doc_id: doc.id, request_id: req.rid, path: 'out/새 그림.png', expected_attempt: 1 });
    assert.deepEqual([up.name, up.kind, up.usedBy], ['새 그림.png', 'image', [req.rid]]);
    fs.writeFileSync(path.join(outside, 'x.png'), makePng(10, 10));
    assert.match((await call(client, 'upload_result_file', { doc_id: doc.id, request_id: req.rid, path: path.join(outside, 'x.png') })).error, /OUTSIDE/);
    assert.match((await call(client, 'upload_result_file', { doc_id: doc.id, request_id: req.rid, path: `../${path.basename(outside)}/x.png` })).error, /OUTSIDE/);
    assert.match((await call(client, 'upload_result_file', { doc_id: doc.id, request_id: req.rid, path: 'out/없음.png' })).error, /NOT_FOUND/);
    assert.match((await call(client, 'upload_result_file', { doc_id: doc.id, request_id: req.rid, path: 'out' })).error, /NOT_FILE/);
    const p = await call(client, 'propose_figure', { doc_id: doc.id, replace_ref: 's0/p2', attachment_id: up.aid, request_id: req.rid, expected_attempt: 1 });
    assert.equal(p.figure.replace.binId, 'image1');
    const done = await call(client, 'complete_request', { doc_id: doc.id, request_id: req.rid, summary: '그림 글꼴을 바꿔 교체 제안을 남겼습니다.', expected_attempt: 1 });
    assert.ok(!done.error, done.error);
    await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
    const saved = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(saved.figures().map((f) => [f.binId, f.height]), [['image2', 22500]]);
    await bridge.stop();
  } finally {
    await srv.stop();
    fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  }
});
