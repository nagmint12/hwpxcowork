// 기본 native API 어댑터와 실제 MCP 저장 경로를 검증한다.
// API는 가짜 fetch, 문서·서버는 임시 복사본. 그림 생성·MCP·파일 저장·HWPX 삽입은 실제 경로로 시험한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiProposer } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { validateImage } from '../server/image-integrity.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const result = () => ({ proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '실제 그림 제안을 남겼습니다.', instructionSummary: '시각화' });
const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const final = (extra = {}) => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...result(), ...extra }) }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const call = (name, args, n = 1) => json({ status: 'completed', output: [{ type: 'function_call', call_id: `call_${n}`, name, arguments: JSON.stringify(args) }] });
const mcpJson = r => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content.find(c => c.type === 'text').text); };
const ai = (fetch, workspace = 'mcp') => new AiProposer({ ai: { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', workspace, enabled: true } }, { key: 'fake-api-key', fetch });
async function until(check, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail('작업 대기 시간 초과'); }

test('API worker: BAZE 함수 요청 → 실제 MCP 차트 PNG → 그림 제안 → HWPX 원본 바이트 보존', { timeout: 30000 }, async () => {
  const srv = await startServer(); let worker;
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`, target = (await api(`${route}/paragraphs`)).find(p => p.ref === 's0/p1');
    let round = 0;
    const model = ai(async (url, init) => {
      assert.equal(url, 'https://api.baze.co/v1/gateway/responses');
      const body = JSON.parse(init.body);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fake-api-key');
      if (++round === 1) {
        const tool = body.tools.find(t => t.name === 'propose_figure');
        assert.ok(tool); assert.ok(!tool.parameters.properties.image_base64 && !tool.parameters.properties.doc_id);
        assert.ok(!JSON.stringify(body).includes(srv.tokens.a));
        return call('propose_figure', { after_ref: target.ref, caption: '연도별 비교', chart: { type: 'bar', categories: ['2025', '2026'], series: [{ name: '한국인', values: [71.23, 74.19] }], y_min: 0, y_max: 100 } });
      }
      assert.ok(body.input.some(i => i.type === 'function_call_output' && i.output.includes('figure')));
      return final();
    });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai: model, log() {}, timing: { pollMs: 100 } });
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', target: { ref: target.ref }, instruction: '연도별 점수를 막대그래프로 시각화해줘', route: 'queue' } })).request;
    worker.start(); await until(() => worker.stats().completed + worker.stats().failed === 1);
    assert.equal(worker.stats().failed, 0); assert.equal(round, 2);
    assert.equal((await api(`${route}/requests/${request.rid}`)).status, 'done');
    const proposals = await api(`${route}/proposals`); assert.equal(proposals.length, 1); assert.equal(proposals[0].type, 'figure');
    const aid = proposals[0].figure.aid;
    const original = await api(`${route}/attachments/${aid}`); assert.equal(validateImage(original).width, 2000);
    await api(`${route}/proposals/${proposals[0].pid}/apply`, { method: 'POST' });
    const saved = await HwpxDoc.load(await api(`${route}/file`));
    const figure = saved.figures().find(f => f.caption?.text.includes('연도별 비교'));
    assert.ok(figure); assert.deepEqual(Buffer.from(saved.binaryItem(figure.binId).bytes), original);
  } finally { await worker?.stop(); await srv.stop(); }
});

test('서버 개인 BAZE 키: API 작업공간 파일을 직접 회수하고 같은 MCP로 그림 교체, 캡션·픽셀·바이트 보존', { timeout: 30000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-agent-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), allowAgentApply: true, ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  const png = makePng(1950, 1080, [30, 90, 180]);
  const original = await service.proposeFigure(docId, { afterRef: 's0/p1', imageBase64: makePng(80, 40).toString('base64'), caption: '유지할 캡션', applyNow: true }, user);
  const figureRef = (await service.listFigures(docId)).find(f => f.caption.includes('유지할 캡션')).figure;
  let round = 0, downloads = 0;
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    if (url.endsWith('/containers/cntr_test/files/cfile_test/content')) { downloads++; return new Response(png, { headers: { 'Content-Type': 'image/png' } }); }
    assert.ok(url.endsWith('/responses'));
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.type === 'code_interpreter'));
    if (++round === 1) return json({ status: 'completed', output: [{ type: 'code_interpreter_call', id: 'ci_test', container_id: 'cntr_test', code: 'fake test fixture only' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()), annotations: [{ type: 'container_file_citation', container_id: 'cntr_test', file_id: 'cfile_test', filename: '수정한그림.png' }] }] }] });
    if (round === 2) {
      const note = body.input.findLast(i => i.role === 'user').content;
      const file = JSON.parse(note.slice(note.indexOf('[{'), note.indexOf('}]') + 2))[0];
      assert.equal(file.size, png.length);
      return call('propose_figure', { replace_ref: figureRef, attachment_id: file.attachment_id }, 2);
    }
    return final();
  } });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', workspace: 'hosted', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', target: { ref: 's0/p1' }, instruction: '문서의 그림을 수정하고 교체해줘', route: 'server' }, user);
  assert.equal(done.request.status, 'done'); assert.equal(downloads, 1); assert.equal(round, 3);
  assert.equal(done.proposals.length, 1);
  const proposal = done.proposals[0]; assert.equal(proposal.ref, figureRef); assert.ok(proposal.figure.replace.binId);
  const attachment = await service.getAttachment(docId, proposal.figure.aid);
  assert.deepEqual(attachment.bytes, png); assert.equal(validateImage(attachment.bytes).width, 1950);
  await service.applyProposal(docId, proposal.pid, user);
  const saved = await store.doc(docId); const figure = saved.figures().find(f => f.caption?.text.includes('유지할 캡션'));
  assert.deepEqual(Buffer.from(saved.binaryItem(figure.binId).bytes), png);
});

test('API 도구 경계: 다른 문서·시도·임의 도구·모델 Base64 거절, 같은 그림 도구 재호출은 한 번만', async () => {
  let writes = 0;
  const context = await createApiToolContext({ docId: 'doc', requestId: 2, attempt: 1, assertCurrent: async () => {}, uploadFile() {},
    listTools: async () => [{ name: 'propose_figure', inputSchema: { type: 'object', properties: { doc_id: {}, request_id: {}, expected_attempt: {}, image_base64: {}, after_ref: {} } } }],
    callTool: async (name, args) => { assert.equal(args.doc_id, 'doc'); assert.equal(args.request_id, 2); assert.equal(args.expected_attempt, 1); writes++; return { content: [{ type: 'text', text: '{}' }] }; },
  });
  for (const [name, args] of [['apply_proposal', {}], ['propose_figure', { doc_id: 'other' }], ['propose_figure', { expected_attempt: 2 }], ['propose_figure', { image_base64: 'invented' }]]) await assert.rejects(context.call(name, args), { code: 'API_TOOL_SCOPE' });
  await context.call('propose_figure', { after_ref: 's0/p1' }); await context.call('propose_figure', { after_ref: 's0/p1' });
  assert.equal(writes, 1); assert.equal(context.figures, 1);
});

test('API 실제 도구 범위 오류와 손상 PNG는 완료 요약으로 덮지 않는다', async () => {
  const input = { kind: 'instruct', instruction: '시각화해줘', target: { ref: 's0/p0' }, context: [], attachments: [] };
  await assert.rejects(ai(async () => call('propose_figure', { after_ref: 's0/p0' })).run(input, { toolContext: {
    tools: [{ name: 'propose_figure', parameters: { type: 'object', properties: {} } }],
    call: async () => { throw Object.assign(new Error('허용 범위 밖'), { code: 'API_TOOL_SCOPE' }); },
  } }), { code: 'API_TOOL_SCOPE' });
  const png = makePng(800, 443), bad = Buffer.from(png); bad[45] ^= 1;
  assert.equal(validateImage(png).width, 800); assert.throws(() => validateImage(bad), { code: 'BAD_IMAGE' });
});

test('API 이미지 결과는 원본 바이트로 저장하며 Base64를 모델 대화에 재삽입하지 않는다', async () => {
  const png = makePng(800, 443); let round = 0, stored;
  const context = await createApiToolContext({ docId: 'doc', requestId: 1, attempt: 1, assertCurrent: async () => {},
    listTools: async () => [{ name: 'propose_figure', inputSchema: { type: 'object', properties: { doc_id: {}, request_id: {}, expected_attempt: {}, attachment_id: {}, after_ref: {} } } }],
    uploadFile: async file => { stored = file; return { aid: 'a_saved', name: file.name }; },
    callTool: async (name, args) => { assert.equal(args.attachment_id, 'a_saved'); return { content: [{ type: 'text', text: '{}' }] }; },
  });
  const model = ai(async (url, init) => {
    const body = JSON.parse(init.body);
    if (++round === 1) return json({ status: 'completed', output: [{ type: 'image_generation_call', id: 'img_test', result: png.toString('base64') }] });
    assert.ok(!JSON.stringify(body.input).includes(png.toString('base64')));
    if (round === 2) return call('propose_figure', { attachment_id: 'a_saved', after_ref: 's0/p0' }, 2);
    return final();
  });
  await model.run({ kind: 'instruct', instruction: '차트를 만들어줘', target: { ref: 's0/p0' }, context: [], attachments: [] }, { toolContext: context });
  assert.deepEqual(stored.bytes, png); assert.equal(round, 3);
});

test('API 파일만 생성한 작업도 실제 저장된 파일 영수증으로 완료하며 빈 요약으로 대체하지 않음', async () => {
  const png = makePng(80, 40); let round = 0, saved;
  const context = await createApiToolContext({ docId: 'doc', requestId: 1, attempt: 1, assertCurrent: async () => {}, listTools: async () => [], callTool() {},
    uploadFile: async file => { saved = file; return { aid: 'actual_generated_file', name: file.name }; },
  });
  const model = ai(async () => ++round === 1
    ? json({ status: 'completed', output: [{ type: 'image_generation_call', id: 'img_file_only', result: png.toString('base64') }] })
    : final());
  const done = await model.run({ kind: 'instruct', instruction: '문서 삽입 없이 결과 이미지 파일만 만들어 줘', context: [], attachments: [] }, { toolContext: context });
  assert.equal(done.usage.modelCalls, 2); assert.deepEqual(saved.bytes, png);
  assert.equal(context.savedFiles.length, 1); assert.equal(context.savedFiles[0].aid, 'actual_generated_file');
  assert.equal(context.written.length, 0);
});

test('API 작업공간은 원본 첨부를 Files API로 전달하고 이번 입력 사본만 정리한다', async () => {
  const png = makePng(80, 40); let uploaded = 0, removed = 0;
  const model = ai(async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fake-api-key');
    if (url.endsWith('/files') && init.method === 'POST') {
      assert.ok(init.body instanceof FormData); assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), png);
      uploaded++; return json({ id: 'file_input' });
    }
    if (url.endsWith('/files/file_input') && init.method === 'DELETE') { removed++; return json({ deleted: true }); }
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools.find(t => t.type === 'code_interpreter').container.file_ids, ['file_input']);
    return final({ noChangesReason: '원본 첨부 내용을 확인했으며 변경이 필요하지 않습니다.' });
  }, 'hosted');
  await model.run({ kind: 'instruct', instruction: '첨부 자료를 확인해줘', target: { ref: 's0/p0' }, context: [], attachments: [{ kind: 'image', mime: 'image/png', name: '원본.png', base64: png.toString('base64') }] });
  assert.equal(uploaded, 1); assert.equal(removed, 1);
});

test('API 도구 지원 오류·긴 반복 뒤 종료 및 파일 다운로드 뒤 시도 변경을 감지한다', async () => {
  const input = { kind: 'instruct', instruction: '시각화해줘', target: { ref: 's0/p0' }, context: [], attachments: [] };
  const minimal = { tools: [{ type: 'function', name: 'get_request', parameters: { type: 'object', properties: {} }, strict: false }], call: async () => ({ content: [] }) };
  await assert.rejects(ai(async () => new Response('provider-secret', { status: 400 })).run(input, { toolContext: minimal }), e => e.code === 'API_TOOLS_UNAVAILABLE' && !e.message.includes('provider-secret'));
  let rounds = 0;
  const longResult = await ai(async () => ++rounds <= 55 ? call('get_request', {}, rounds) : final({ noChangesReason: '전체 문서 검토 결과 수정할 항목이 없습니다.' })).run({ ...input, instruction: '문서 확인' }, { toolContext: minimal });
  assert.equal(rounds, 56); assert.equal(longResult.usage.toolCalls, 55);
  let active = true, writes = 0;
  const context = await createApiToolContext({ docId: 'doc', requestId: 1, attempt: 1, listTools: async () => [], callTool() {},
    assertCurrent: async () => { if (!active) throw Object.assign(new Error('시도 변경'), { code: 'ATTEMPT_CHANGED' }); }, uploadFile: async () => { writes++; },
  });
  const model = ai(async url => {
    if (url.endsWith('/content')) { active = false; return new Response(makePng(80, 40)); }
    return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [{ type: 'container_file_citation', container_id: 'cntr_test', file_id: 'cfile_test', filename: 'plot.png' }] }] }] });
  });
  await assert.rejects(model.run(input, { toolContext: context }), { code: 'ATTEMPT_CHANGED' }); assert.equal(writes, 0);
});

test('서버 개인 키: 실제 생성 파일 다운로드 실패는 요청 실패로 기록', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-nofig-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  service.personalAi = createPersonalAi({ config, fetchImpl: async url => url.endsWith('/content') ? new Response('', { status: 500 }) : json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()), annotations: [{ type: 'container_file_citation', container_id: 'cntr_failed', file_id: 'file_failed', filename: 'missing.png' }] }] }] }) });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', key: 'fake-api-key' });
  await assert.rejects(service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '실제 그림을 만들어 줘' }, user), error => error.code === 'AI_FAILED' && error.extra.request.status === 'failed' && /생성 파일을 받지 못했습니다/.test(error.extra.request.error));
  assert.equal((await service.listProposals(docId)).length, 0);
});

test('서버 API는 처리 중 취소되면 옛 실행의 MCP 그림 제안을 거절한다', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-cancel-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 키가 든 공용 서버 AI 는 허용한 계정만 쓴다(users[].serverAi — 2026-11-10)
  const user = { name: '검증', role: 'admin' }, config = { dataDir: tmp, agents: { leaseMinutes: 1 }, ai: {}, users: [{ ...user, serverAi: true }] };
  const store = new Store(path.join(tmp, 'store')); let service, docId;
  const model = ai(async () => {
    await service.cancelRequest(docId, 1, user);
    return call('propose_figure', { after_ref: 's0/p1', chart: { type: 'bar', categories: ['a'], series: [{ name: 'x', values: [1] }] } });
  });
  service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: model });
  docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  const done = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '시각화해줘' }, user);
  assert.equal(done.cancelled, true); assert.equal(done.request.status, 'cancelled');
  assert.equal((await service.listAttachments(docId)).length, 0); assert.equal((await service.listProposals(docId)).length, 0);
});

test('서버 개인 API: 빈 보고서 성공 주장은 failed, 실제 검토의 명시 변경 불필요 사유만 done', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-no-results-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const user = { name: '시험', role: 'admin' }, config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'fixture.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  let extra = { summary: '보고서 작성을 완료했습니다.' };
  service.personalAi = createPersonalAi({ config, fetchImpl: async () => final(extra) });
  service.personalAi.save(user, { provider: 'openai', model: 'fake-model', key: 'fake-api-key' });
  await assert.rejects(service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '완성된 정책 보고서를 작성해 줘' }, user), error => error.code === 'AI_FAILED' && error.extra.request.status === 'failed');
  assert.equal((await service.listProposals(docId)).length, 0);
  extra = { summary: '모두 변경했습니다.', noChangesReason: '대상 문장의 표현과 문맥을 검토했으며 교정할 오탈자나 의미 오류가 없어 원문을 유지합니다.' };
  const unchanged = await service.createRequest(docId, { kind: 'review', route: 'server', target: { ref: 's0/p1' }, instruction: '문장에 교정할 오류가 있는지 검토해 줘' }, user);
  assert.equal(unchanged.request.status, 'done');
  assert.match(unchanged.request.summary, /변경 없음/); assert.doesNotMatch(unchanged.request.summary, /모두 변경/);
  assert.equal((await service.listProposals(docId)).length, 0);
});
