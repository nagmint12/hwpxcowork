// Work 계정·외부 API 없이 원본 전달과 결과 회수, 실제 HTTP/MCP 경로와 취소 경합을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../server/store.js';
import { Service } from '../server/service.js';
import { createMcpServer } from '../server/mcp.js';
import { createWorkFiles } from '../server/work-files.js';
import { downloadWorkFile, workDownloadUrl } from '../server/work-file-download.js';
import { requestResultLine, requestSummaryResultLine } from '../server/memotext.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const png = makePng(80, 40);
const file = { file_id: 'file-work-result', file_name: '수정한 그림.png', mime_type: 'image/png', download_url: 'https://files.example.test/output?signature=test' };
const resultJson = result => { assert.ok(!result.isError, result.content?.[0]?.text); return JSON.parse(result.content.find(c => c.type === 'text').text); };

function transport(responses, visits = []) {
  return (url, options, callback) => {
    visits.push({ url, options });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.end = () => queueMicrotask(() => {
      const item = responses.shift();
      assert.ok(item, '예상한 다운로드 횟수를 넘지 않는다');
      const response = Readable.from(item.chunks || []);
      response.statusCode = item.status || 200; response.headers = item.headers || {};
      callback(response);
    });
    return req;
  };
}

test('Work 다운로드: 공개 HTTPS·긴 서명 URL·리디렉션 재검사·크기 제한·실패 응답', async () => {
  for (const url of ['http://public.example/f', 'https://127.1/f', 'https://10.0.0.1/f', 'https://[::1]/f', 'https://user:pw@public.example/f', 'file:///tmp/f', 'sandbox:/mnt/data/f', 'https://public.example/f#x']) {
    assert.throws(() => workDownloadUrl(url), e => e.code === 'BAD_FILE_URL');
  }
  assert.ok(workDownloadUrl(`https://cdn.example/f?sig=${'a'.repeat(3000)}`));
  const visits = [];
  const out = await downloadWorkFile('https://files.example/start', { request: transport([
    { status: 302, headers: { location: 'https://cdn.example/result' } },
    { chunks: [png], headers: { 'content-type': 'image/png' } },
  ], visits) });
  assert.deepEqual(out.bytes, png); assert.equal(out.mime, 'image/png');
  assert.equal(visits.length, 2);
  for (const v of visits) { assert.equal(v.options.method, 'GET'); assert.equal(typeof v.options.lookup, 'function'); assert.equal(v.options.agent, false); assert.equal(v.options.headers.Authorization, undefined); }
  await assert.rejects(downloadWorkFile('https://files.example/f', { request: transport([{ status: 302, headers: { location: 'https://127.0.0.1/secret' } }]) }), e => e.code === 'BAD_FILE_URL');
  for (const response of [{ headers: { 'content-length': '11' } }, { chunks: [Buffer.alloc(6), Buffer.alloc(5)] }]) {
    await assert.rejects(downloadWorkFile('https://files.example/f', { maxBytes: 10, request: transport([response]) }), e => e.code === 'TOO_LARGE');
  }
  await assert.rejects(downloadWorkFile('https://files.example/f', { request: transport([{ status: 403, chunks: [Buffer.from('secret response')] }]) }), e => e.code === 'FILE_DOWNLOAD_FAILED' && !e.message.includes('secret'));
  await assert.rejects(downloadWorkFile('https://files.example/f', { request: transport([{}]) }), e => e.code === 'EMPTY');
});

async function setup() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-work-files-'));
  const users = [{ name: '작성자', token: 'test-only-a', role: 'editor' }, { name: '다른사람', token: 'test-only-b', role: 'editor' }];
  const config = { users, publicUrl: 'https://files.example.test', attachments: { maxBytes: 1048576, maxPerDoc: 100 }, agents: { leaseMinutes: 15 }, allowAgentApply: true };
  const store = new Store(temp);
  const service = new Service({ store, config, hub: { broadcast() {} }, ai: { enabled: false } });
  const user = { ...users[0], agentSession: 'work-session', agentAttempt: 1 };
  const doc = await service.createDocument({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), user });
  const attachment = await service.addAttachment(doc.id, { name: '원본.csv', bytes: Buffer.from('항목,값\n가,3\n나,4\n') }, user);
  const created = await service.createRequest(doc.id, { kind: 'instruct', instruction: '첨부를 분석해 그림과 파일로 돌려줘', route: 'queue', target: { ref: 's0/p1' }, attachments: [attachment.aid] }, user);
  const rid = created.request.rid;
  const args = { doc_id: doc.id, request_id: rid, expected_attempt: 1 };
  let time = Date.now(); let downloads = 0;
  const work = createWorkFiles({ config, service, now: () => time, download: async () => { downloads++; return { bytes: png, mime: 'image/png' }; } });
  service.workFiles = work;
  return { service, store, work, config, users, user, doc, rid, args, attachment, temp,
    tick: ms => { time += ms; }, downloads: () => downloads,
    close: () => { const resolved = path.resolve(temp); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('hwpx-work-files-')); fs.rmSync(resolved, { recursive: true, force: true }); },
  };
}

test('MCP 원본 CSV → Work 파일 참조 결과 저장 → 중복 방지 → 그림 제안 → 완료·결과 복구', async () => {
  const s = await setup(); const client = new Client({ name: 'chatgpt', version: 'test' });
  const server = createMcpServer({ service: s.service, user: s.users[0], agentName: 'ChatGPT', agentSession: 'work-session' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const tools = (await client.listTools()).tools;
    const save = tools.find(t => t.name === 'save_result_file');
    assert.deepEqual(save._meta['openai/fileParams'], ['file']);
    const schema = save.inputSchema.properties.file;
    assert.deepEqual([...schema.required].sort(), ['download_url', 'file_id']);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.equal(save.annotations.openWorldHint, true);
    const call = (name, args) => client.callTool({ name, arguments: args });
    resultJson(await call('start_request', s.args));
    const source = await call('get_attachment_file', { ...s.args, attachment_id: s.attachment.aid });
    assert.equal(source.content.find(c => c.type === 'resource_link').mimeType, 'text/csv');
    const url = source.structuredContent.file.download_url;
    assert.ok(!url.includes(s.users[0].token));
    const downloaded = await s.work.resolve(new URL(url).pathname.split('/').pop());
    assert.deepEqual(downloaded.bytes, Buffer.from('항목,값\n가,3\n나,4\n'));
    const saved = resultJson(await call('save_result_file', { ...s.args, file }));
    assert.equal(saved.kind, 'image'); assert.deepEqual(saved.usedBy, [s.rid]);
    assert.deepEqual((await s.service.getAttachment(s.doc.id, saved.aid)).bytes, png);
    const repeated = resultJson(await call('save_result_file', { ...s.args, file }));
    assert.equal(repeated.aid, saved.aid); assert.equal(repeated.duplicate, true); assert.equal(s.downloads(), 1);
    const resumed = resultJson(await call('get_request', s.args));
    assert.equal(resumed.existingResults.files[0].aid, saved.aid);
    assert.match(resumed.howTo, /get_attachment_file/);
    const proposal = resultJson(await call('propose_figure', { ...s.args, after_ref: 's0/p1', caption: '분석 결과', attachment_id: saved.aid }));
    assert.equal(proposal.figure.aid, saved.aid);
    const done = resultJson(await call('complete_request', { ...s.args, summary: '분석 그림과 결과 파일을 만들었습니다.' }));
    assert.deepEqual(done.resultAttachments, [saved.aid]);
    await assert.rejects(s.work.resolve(new URL(url).pathname.split('/').pop()), e => e.code === 'REQUEST_CLOSED');
    const metaText = fs.readFileSync(path.join(s.store.dir, s.doc.id, 'meta.json'), 'utf8');
    assert.ok(!metaText.includes('signature=test'), '만료 URL은 저장하지 않는다');
  } finally { await client.close(); await server.close(); s.close(); }
});

test('원본 링크: 다른 사용자·연결 안 된 첨부·변조·만료·토큰 변경·삭제·재시도 차단', async () => {
  const s = await setup();
  try {
    const args = { ...s.args, attachment_id: s.attachment.aid };
    await assert.rejects(s.work.attachment(args, { ...s.users[1], agentAttempt: 1 }), e => e.code === 'NOT_OWNER');
    await assert.rejects(s.work.attachment({ ...args, attachment_id: 'a999' }, s.user), e => e.code === 'NOT_REQUEST_ATTACHMENT');
    const issue = async () => new URL((await s.work.attachment(args, s.user)).structuredContent.file.download_url).pathname.split('/').pop();
    const ticket = await issue();
    const restarted = createWorkFiles({ config: s.config, service: s.service });
    await assert.rejects(restarted.resolve(ticket), e => e.code === 'BAD_FILE_LINK');
    await assert.rejects(s.work.resolve(`${ticket}x`), e => e.code === 'BAD_FILE_LINK');
    s.tick(600001); await assert.rejects(s.work.resolve(ticket), e => e.code === 'FILE_LINK_EXPIRED');
    const next = await issue();
    s.users[0].token = 'test-only-replaced';
    await assert.rejects(s.work.resolve(next), e => e.code === 'BAD_FILE_LINK');
    s.users[0].token = s.user.token;
    await s.service.cancelRequest(s.doc.id, s.rid, s.user);
    await s.service.retryRequest(s.doc.id, s.rid, s.user);
    await assert.rejects(s.work.resolve(next), e => e.code === 'ATTEMPT_CHANGED');
    const updated = { ...s.user, agentAttempt: 2 };
    const current = (await s.work.attachment(args, updated)).structuredContent.file.download_url;
    await s.service.deleteAttachment(s.doc.id, s.attachment.aid, s.user);
    await assert.rejects(s.work.resolve(new URL(current).pathname.split('/').pop()), e => e.code === 'NO_ATTACHMENT');
    s.config.publicUrl = 'http://localhost:8787';
    await assert.rejects(s.work.attachment(args, updated), e => e.code === 'WORK_HTTPS_REQUIRED');
  } finally { s.close(); }
});

test('결과 파일: 다운로드 전 권한·시도·선점 검사, 동시 재전송 멱등성', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.work.save({ ...s.args, file }, { ...s.users[1], agentAttempt: 1 }, 'ChatGPT'), e => e.code === 'NOT_OWNER');
    await assert.rejects(s.work.save({ ...s.args, file }, { ...s.user, agentAttempt: 2 }, 'ChatGPT'), e => e.code === 'ATTEMPT_CHANGED');
    await s.service.startRequest(s.doc.id, s.rid, s.user, 'ChatGPT', { session: 'work-session' });
    await assert.rejects(s.work.save({ ...s.args, file }, { ...s.user, agentSession: 'other-session' }, 'ChatGPT'), e => e.code === 'CLAIMED');
    assert.equal(s.downloads(), 0);
    const results = await Promise.all(Array.from({ length: 4 }, () => s.work.save({ ...s.args, file }, s.user, 'ChatGPT')));
    assert.equal(new Set(results.map(r => r.aid)).size, 1);
    assert.equal((await s.service.listAttachments(s.doc.id)).length, 2);
  } finally { s.close(); }
});

test('다운로드 도중 취소·재시도·크기 초과이면 파일을 남기지 않는다', async () => {
  for (const action of ['cancel', 'retry', 'oversize']) {
    const s = await setup(); let finish;
    try {
      const work = createWorkFiles({ config: s.config, service: s.service, download: () => new Promise(resolve => { finish = resolve; }) });
      const pending = work.save({ ...s.args, file }, s.user, 'ChatGPT');
      await s.service.cancelRequest(s.doc.id, s.rid, s.user);
      if (action !== 'cancel') await s.service.retryRequest(s.doc.id, s.rid, s.user);
      finish({ bytes: action === 'oversize' ? Buffer.alloc(s.config.attachments.maxBytes + 1) : png });
      await assert.rejects(pending, e => ['REQUEST_CLOSED', 'ATTEMPT_CHANGED', 'TOO_LARGE'].includes(e.code));
      assert.equal((await s.service.listAttachments(s.doc.id)).length, 1);
      assert.deepEqual((await s.service.getRequestView(s.doc.id, s.rid, s.user)).resultAttachments, []);
    } finally { s.close(); }
  }
});

test('결과 파일만 있는 요청은 고칠 곳 없음 대신 파일 수를 요약한다', () => {
  const req = { status: 'done', comments: [], resultAttachments: ['a1', 'a2'] };
  assert.equal(requestResultLine(req), '결과: 결과 파일 2개');
  assert.equal(requestSummaryResultLine(req), '결과: 결과 파일 2개');
});

test('실제 HTTP MCP: 원본 PNG·XLSX·PDF 바이트 링크, 인증 토큰 노출 없이 다운로드·취소 차단', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { publicUrl: 'https://work.example.test' } });
  const client = new Client({ name: 'chatgpt', version: 'test' });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=ChatGPT`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const modern = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: {
      Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: 'files-test' }, 'io.modelcontextprotocol/clientCapabilities': {},
    } } }) });
    const modernTools = await modern.json();
    assert.deepEqual(modernTools.result.tools.find(t => t.name === 'save_result_file')._meta['openai/fileParams'], ['file']);
    assert.equal((await fetch(`${srv.base}/manual-resources/CHATGPT_WORK_FILES.md`)).status, 200);
    const book = new ExcelJS.Workbook(); book.addWorksheet('자료').addRows([['항목', '값'], ['가', 3]]);
    const xlsx = Buffer.from(await book.xlsx.writeBuffer());
    for (const [name, bytes] of [['원본.png', png], ['원본.xlsx', xlsx], ['원본.pdf', Buffer.from('%PDF-1.4\nsource')]]) {
      const added = await fetch(`${srv.base}/api/docs/${doc.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-File-Name': encodeURIComponent(name) }, body: bytes });
      assert.equal(added.status, 200); const att = await added.json();
      const created = await srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '첨부 원본을 처리해줘', route: 'queue', target: { ref: 's0/p1' }, attachments: [att.aid] } });
      const args = { doc_id: doc.id, request_id: created.request.rid, attachment_id: att.aid, expected_attempt: 1 };
      const source = await client.callTool({ name: 'get_attachment_file', arguments: args });
      assert.ok(!source.isError, source.content?.[0]?.text);
      const remote = source.structuredContent.file;
      const url = `${srv.base}${new URL(remote.download_url).pathname}`;
      const fetched = await fetch(url);
      assert.equal(fetched.status, 200); assert.equal(fetched.headers.get('cache-control'), 'private, no-store');
      const received = Buffer.from(await fetched.arrayBuffer());
      assert.deepEqual(received, bytes);
      if (name.endsWith('.xlsx')) { const opened = new ExcelJS.Workbook(); await opened.xlsx.load(received); assert.equal(opened.getWorksheet('자료').getCell('B2').value, 3); }
      await srv.api('a')(`/api/docs/${doc.id}/requests/${created.request.rid}/cancel`, { method: 'POST' });
      assert.equal((await fetch(url)).status, 409);
    }
  } finally { await client.close(); await srv.stop(); }
});
