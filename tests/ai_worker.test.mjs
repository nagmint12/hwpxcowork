// 실제 API 호출·사용자 data 없이 개인 worker ↔ 격리 REST/MCP/SSE 서버를 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiWorker, workerInput } from '../server/worker.js';
import { parseWorkerArgs } from '../scripts/ai-worker.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const result = (over = {}) => {
  const value = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '검토 결과를 남겼습니다.', instructionSummary: '표현 검토', ...over };
  if (!['proposals', 'alternatives', 'comments', 'inserts', 'tables', 'formats', 'figures', 'tocUpdates', 'tableEdits'].some(key => value[key]?.length)) value.noChangesReason = '이 시험 검토의 결론은 기존 문서를 고칠 필요가 없다는 것입니다.';
  return value;
};
const timing = { pollMs: 100, backoffMs: 30, maxBackoffMs: 60, connectTimeoutMs: 3000, callTimeoutMs: 5000, deadMs: 3000 };
async function until(fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(15); }
  assert.fail(message);
}
async function setup(config = {}, prepare = null) {
  const srv = await startServer({ ai: 'off', config });
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  if (prepare) { await prepare(doc); doc.acceptAll(); }
  const uploaded = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await doc.save()));
  const api = srv.api('a'); const D = `/api/docs/${uploaded.id}`;
  return { srv, api, id: uploaded.id, D, create: async (instruction, over = {}, user = 'a') => (await srv.api(user)(`${D}/requests`, {
    method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' }, instruction, route: 'queue', ...over },
  })).request };
}
function makeWorker(srv, ai, options = {}) {
  return createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, agent: '개인 시험 AI', timing, log() {}, ...options });
}

test('개인 worker 설정: 명시한 모델·개인 환경키만 사용하고 구조화 문맥·전체 대상 글을 보존', () => {
  const opts = parseWorkerArgs(['--provider', 'chatgpt', '--model', 'my-model'], { HWPX_COWORK_TOKEN: 'personal-token', OPENAI_API_KEY: 'personal-api-key' });
  assert.equal(opts.provider, 'openai'); assert.equal(opts.key, 'personal-api-key');
  assert.throws(() => parseWorkerArgs(['--provider', 'gemini'], { GEMINI_API_KEY: 'x', HWPX_COWORK_TOKEN: 'y' }), /--model/);
  assert.equal(parseWorkerArgs(['--provider', 'gemini', '--model', 'test'], { HWPX_COWORK_TOKEN: 'y', GOOGLE_API_KEY: 'fallback' }).key, 'fallback');
  assert.throws(() => createApiWorker({ url: 'https://x/mcp?token=secret', token: 'x', ai: { run() {} } }), /인증정보/);
  const full = '긴 선택 글🙂'.repeat(200);
  const request = { kind: 'suggest', target: { ref: 's0/p1', text: '잘린 요약…' }, targetText: full, contextItems: [{ ref: 's0/p1', text: full, isTarget: true }] };
  assert.equal(workerInput(request).target.text, full);
  assert.equal(workerInput(request).context, request.contextItems);
  assert.throws(() => workerInput({ ...request, contextItems: undefined }), { code: 'SERVER_UPDATE_REQUIRED' });
});

test('개인 worker: snapshot·실시간 알림을 합쳐 내 요청만 FIFO 직렬 처리하고 본문 자동반영 없음', { timeout: 20000 }, async () => {
  const { srv, api, D, create } = await setup();
  const gate = deferred(); const inputs = []; let active = 0; let maxActive = 0;
  const ai = { async run(input) {
    inputs.push(input); active++; maxActive = Math.max(maxActive, active);
    if (inputs.length === 1) await gate.promise;
    active--;
    return result({ proposals: [{ ref: input.target.ref, find: input.target.text, replace: `${input.target.text} 확인`, reason: '표현 보완' }] });
  } };
  const worker = makeWorker(srv, ai);
  try {
    const before = (await api(`${D}/paragraphs`)).map((p) => p.text);
    const one = await create('첫째'); const two = await create('둘째'); const other = await create('남의 요청', {}, 'b');
    worker.start();
    await until(() => inputs.length === 1, 'snapshot 첫 요청 실행');
    await until(async () => (await api('/api/agent/status')).me.online, 'worker 채널 접속');
    const three = await create('셋째', { route: 'agent' });
    assert.equal(three.route, 'agent');
    worker.wake(); worker.wake(); worker.wake();
    gate.resolve();
    await until(() => worker.stats().completed === 3, '세 요청 완료');
    assert.deepEqual(inputs.map((i) => i.instruction), ['첫째', '둘째', '셋째']);
    assert.equal(maxActive, 1);
    for (const r of [one, two, three]) assert.equal((await api(`${D}/requests/${r.rid}`)).status, 'done');
    assert.equal((await api(`${D}/requests/${other.rid}`)).status, 'pending');
    const proposals = await api(`${D}/proposals`);
    assert.equal(proposals.length, 3); assert.ok(proposals.every((p) => p.status === 'pending'));
    assert.deepEqual((await api(`${D}/paragraphs`)).map((p) => p.text), before, '작업은 제안으로만 돌아옴');
  } finally { gate.resolve(); await worker.stop(); await srv.stop(); }
});

test('요청별 모델 설정: 지정한 실행기만 맡고 다시 요청에도 같은 값을 사용한다', { timeout: 15000 }, async () => {
  const { srv, api, id, D, create } = await setup();
  const calls = [];
  const codex = makeWorker(srv, {
    runKind: 'codex',
    runSettings: { model: 'gpt-cli', effort: 'low', modelSelection: 'auto' },
    setRunSettings(settings) { this.settings = settings; },
    async run(input) { calls.push({ instruction: input.instruction, ...this.settings }); return result(); },
  });
  const other = makeWorker(srv, {
    runKind: 'claude-code',
    runSettings: { model: 'sonnet', effort: 'low' },
    setRunSettings() {},
    async run(input) { calls.push({ instruction: input.instruction, worker: 'claude-code' }); return result(); },
  });
  const runSettings = { kind: 'codex', model: 'gpt-chosen', effort: 'xhigh' };
  try {
    const bad = await api.res(`${D}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' },
      route: 'server', options: { runSettings } } });
    assert.equal(bad.status, 400);
    other.start();
    await until(async () => (await api('/api/agent/status')).me.sessions.some(s => s.runKind === 'claude-code'), '다른 실행기 연결');
    const chosen = await create('지정 모델', { route: 'auto', options: { runSettings } });
    assert.equal(chosen.route, 'queue');
    assert.deepEqual(chosen.options.runSettings, runSettings);
    assert.equal((await other.callJson('claim_next_request', { doc_id: id, run_kind: 'claude-code' })).none, true);
    assert.equal((await other.callJson('claim_next_request', { doc_id: id })).none, true, '이전 실행기도 건너뜀');
    await assert.rejects(other.callJson('start_request', { doc_id: id, request_id: chosen.rid }), { code: 'AI_RUN_REQUIRED' });

    codex.start();
    await until(() => codex.stats().completed === 1, '지정한 실행기가 대기 요청 완료');
    await until(async () => (await api('/api/agent/status')).me.sessions.some(s => s.runKind === 'codex'), '지정 실행기 연결');
    const delivered = await create('연결된 실행기', { route: 'auto', options: { runSettings } });
    assert.equal(delivered.route, 'agent');
    assert.equal(delivered.delivery.session, codex.session);
    await until(() => codex.stats().completed === 2, '전달된 요청 완료');
    await api(`${D}/requests/${chosen.rid}/retry`, { method: 'POST' });
    await until(() => codex.stats().completed === 3, '재시도 완료');
    assert.deepEqual(calls, ['지정 모델', '연결된 실행기', '지정 모델'].map(instruction => ({
      instruction, model: 'gpt-chosen', effort: 'xhigh', modelSelection: 'manual',
    })));
    assert.deepEqual((await api('/api/me/ai-run')).settings, {});
  } finally { await Promise.all([codex.stop(), other.stop()]); await srv.stop(); }
});

test('개인 worker: 취소 신호가 늦은 AI 결과를 버리고 다음 요청을 처리', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup(); const late = deferred(); const inputs = [];
  const worker = makeWorker(srv, { async run(input, { signal }) {
    inputs.push({ input, signal });
    if (inputs.length === 1) return late.promise;
    return result();
  } });
  try {
    worker.start(); await until(async () => (await api('/api/agent/status')).me.online, 'worker online');
    const first = await create('취소할 요청', { route: 'agent' });
    await until(() => inputs.length === 1, 'AI 시작');
    await api(`${D}/requests/${first.rid}/cancel`, { method: 'POST' });
    await until(() => inputs[0].signal.aborted, 'provider signal 취소');
    late.resolve(result({ comments: [{ ref: 's0/p1', find: '', text: '늦게 온 결과' }] }));
    const next = await create('다음 요청', { route: 'agent' });
    await until(() => worker.stats().completed === 1, '다음 요청 완료');
    assert.equal((await api(`${D}/requests/${first.rid}`)).status, 'cancelled');
    assert.equal((await api(`${D}/requests/${next.rid}`)).status, 'done');
    assert.ok(!(await api(`${D}/memos`)).some((m) => m.text.includes('늦게 온 결과')));
  } finally { late.resolve(result()); await worker.stop(); await srv.stop(); }
});

test('개인 worker: API 오류를 실패로 알리고 비밀값·provider 오류원문은 저장·로그에 남기지 않음', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup(); const logs = [];
  const secret = `secret-api-key ${srv.tokens.a}`;
  const usage = { input: 123, output: 17, modelCalls: 2, toolCalls: 1 };
  const worker = makeWorker(srv, { async run() { throw Object.assign(new Error(`Provider raw private document: ${secret}`), { usage, model: 'failed-native-api-model', execution: 'tool-agent' }); } }, { log: (line) => logs.push(line) });
  try {
    const req = await create('실패 검증'); worker.start();
    const failed = await until(async () => { const view = await api(`${D}/requests/${req.rid}`); return view.status === 'failed' && view; }, '실패 상태 기록');
    assert.match(failed.error, /개인 AI 처리에 실패/);
    assert.deepEqual(failed.usage, usage); assert.equal(failed.model, 'failed-native-api-model'); assert.equal(failed.execution, 'tool-agent');
    assert.ok(!JSON.stringify(failed).includes(secret));
    assert.ok(!logs.join('\n').includes(secret));
    await sleep(150); assert.equal(worker.stats().failed, 1, '실패한 요청을 무한 재호출하지 않음');
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 첨부 자료 전달·부분 결과 이어받기 시 동일 제안과 의견 중복 방지', { timeout: 15000 }, async () => {
  const { srv, api, D, create, id } = await setup(); const inputs = [];
  const worker = makeWorker(srv, { async run(input) {
    inputs.push(input);
    return result({ proposals: [{ ref: 's0/p1', find: input.target.text, replace: '이미 제안한 글', reason: '기존 제안' }],
      comments: [{ ref: 's0/p1', find: '', text: '근거 확인 필요' }] });
  } });
  try {
    const att = await api(`${D}/attachments`, { method: 'POST', body: Buffer.from('첨부 검증 자료: 123'), headers: { 'x-file-name': encodeURIComponent('근거.txt') } });
    const req = await create('이어받기', { attachments: [att.aid] });
    const text = (await api(`${D}/paragraphs`)).find((p) => p.ref === 's0/p1').text;
    await api(`${D}/proposals`, { method: 'POST', body: { rid: req.rid, ref: 's0/p1', find: text, replace: '이미 제안한 글' } });
    await api(`${D}/memos`, { method: 'POST', body: { rid: req.rid, ref: 's0/p1', text: '근거 확인 필요' } });
    worker.start(); await until(() => worker.stats().completed === 1, '부분 결과 이어받아 완료');
    assert.match(inputs[0].attachments[0].text, /첨부 검증 자료: 123/);
    assert.equal(inputs[0].previousResults.proposals.length, 1); assert.equal(inputs[0].previousResults.comments.length, 1);
    assert.equal((await api(`${D}/proposals`)).filter((p) => p.rid === req.rid).length, 1);
    assert.equal((await api(`${D}/memos`)).filter((m) => m.link?.type === 'comment' && m.link.rid === req.rid).length, 1);
    assert.equal(worker.stats().duplicated, 2);
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 긴 AI 실행 중 lease를 갱신해 다른 세션의 중복 선점 차단', { timeout: 15000 }, async () => {
  const { srv, api, D, create, id } = await setup({ agents: { leaseMinutes: 0.007, othersCanTake: false } });
  const gate = deferred(); let called = false;
  const worker = makeWorker(srv, { async run() { called = true; await gate.promise; return result(); } });
  const competitor = new Client({ name: 'competing-worker', version: 'test' });
  try {
    const req = await create('오래 걸리는 작업'); worker.start(); await until(() => called, '실행 시작');
    await sleep(800);
    await competitor.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const denied = await competitor.callTool({ name: 'start_request', arguments: { doc_id: id, request_id: req.rid } });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /CLAIMED/);
    gate.resolve(); await until(() => worker.stats().completed === 1, 'lease 유지한 작업 완료');
    assert.equal((await api(`${D}/requests/${req.rid}`)).status, 'done');
  } finally { gate.resolve(); await competitor.close(); await worker.stop(); await srv.stop(); }
});

test('개인 worker: 알림 연결이 끊겨도 재접속 snapshot으로 누락된 대기 요청을 복구', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup();
  const worker = makeWorker(srv, { async run() { return result(); } }, { timing: { ...timing, pollMs: 60000, backoffMs: 300 } });
  try {
    worker.start(); await until(async () => (await api('/api/agent/status')).me.online, '첫 SSE 연결');
    worker.sseController.abort();
    await until(async () => !(await api('/api/agent/status')).me.online, 'SSE 연결 끊김');
    const req = await create('끊긴 사이 들어온 요청');
    await until(() => worker.stats().completed === 1, '재접속 snapshot 처리');
    assert.equal((await api(`${D}/requests/${req.rid}`)).status, 'done');
    assert.ok(worker.stats().reconnects >= 1);
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 기본은 단일 추천, 명시 비교만 묶음·같은 글의 선택 위치와 재시도 중복 방지', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup();
  const worker = makeWorker(srv, { async run(input) {
    assert.equal(input.target.text, '낱말');
    return result({ alternatives: Array.from({ length: input.options.count }, (_, i) => ({ text: `대안${i + 1}`, reason: '서로 다른 문장' })) });
  } });
  try {
    const text = (await api(`${D}/paragraphs`)).find((p) => p.ref === 's0/p1').text;
    const start = [...text.slice(0, text.lastIndexOf('낱말'))].length;
    const target = { ref: 's0/p1', start, end: start + 2 };
    const compare = await create('비교 세 가지', { kind: 'suggest', target, options: { count: 3 } });
    const single = await create('한 가지 추천', { kind: 'suggest', target });
    worker.start(); await until(() => worker.stats().completed === 2, '비교·단일 요청 완료');
    let proposals = await api(`${D}/proposals`);
    const group = proposals.filter((p) => p.rid === compare.rid);
    assert.equal(group.length, 3); assert.equal(new Set(group.map((p) => p.gid)).size, 1); assert.ok(group[0].gid);
    assert.ok(group.every((p) => p.occurrence === 2), '반복된 문자열의 두 번째 선택 위치');
    const one = proposals.filter((p) => p.rid === single.rid);
    assert.equal(one.length, 1); assert.equal(one[0].gid, undefined); assert.equal(one[0].occurrence, 2);
    await api(`${D}/requests/${compare.rid}/retry`, { method: 'POST' });
    worker.wake(); await until(() => worker.stats().completed === 3, '같은 요청 재시도');
    proposals = await api(`${D}/proposals`);
    assert.equal(proposals.filter((p) => p.rid === compare.rid).length, 3, '이미 저장한 원자적 비교안 묶음은 다시 만들지 않음');
    assert.equal(worker.stats().duplicated, 3);
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 문단·표 결과는 제안으로 저장하고 부분 결과 재시도 시 중복 생성하지 않음', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup();
  const worker = makeWorker(srv, { async run() { return result({
    inserts: [{ afterRef: 's0/p1', text: '새로운 설명 문단', reason: '설명 추가' }],
    tables: [{ afterRef: 's0/p1', rows: [['구분', '값'], ['근거', '12']], caption: '근거 정리', headerRows: 1, reason: '근거 비교' }],
  }); } });
  try {
    const before = (await api(`${D}/paragraphs`)).map((p) => p.text);
    const req = await create('설명과 근거표'); worker.start();
    await until(() => worker.stats().completed === 1, '문단·표 결과 저장');
    let proposals = (await api(`${D}/proposals`)).filter((p) => p.rid === req.rid);
    assert.deepEqual(proposals.map((p) => p.type), ['insert', 'table']);
    assert.ok(proposals.every((p) => p.status === 'pending'));
    assert.deepEqual((await api(`${D}/paragraphs`)).map((p) => p.text), before);
    await api(`${D}/requests/${req.rid}/retry`, { method: 'POST' });
    worker.wake(); await until(() => worker.stats().completed === 2, '부분 결과 중복 제거');
    proposals = (await api(`${D}/proposals`)).filter((p) => p.rid === req.rid);
    assert.equal(proposals.length, 2); assert.equal(worker.stats().duplicated, 2);
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 겹쳐 나오는 문자열도 엔진과 같은 등장 순번으로 선택 위치를 보존', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup({}, (doc) => doc.mergeParagraphText('s0/p1', 'aaaa', { author: '시험 준비' }));
  const worker = makeWorker(srv, { async run(input) {
    assert.equal(input.target.text, 'aa');
    return result({ alternatives: [{ text: 'bb', reason: '선택한 마지막 두 글자 교체' }] });
  } });
  try {
    const req = await create('선택한 부분만 고치기', { kind: 'suggest', target: { ref: 's0/p1', start: 2, end: 4 } });
    worker.start(); await until(() => worker.stats().completed === 1, '겹친 문자열 제안 완료');
    const proposal = (await api(`${D}/proposals`)).find((p) => p.rid === req.rid);
    assert.equal(proposal.occurrence, 3, 'aaaa 안의 aa는 0·1·2에서 등장하므로 마지막은 세 번째');
    assert.equal((await api(`${D}/paragraphs`)).find((p) => p.ref === 's0/p1').text, 'aaaa');
    await api(`${D}/proposals/${proposal.pid}/apply`, { method: 'POST' });
    assert.equal((await api(`${D}/paragraphs`)).find((p) => p.ref === 's0/p1').text, 'aabb');
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 비교안 일부 저장 실패를 완료로 숨기지 않고 실패 표시·성공한 안 보존', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup();
  const worker = makeWorker(srv, { async run(input) { return result({ alternatives: [
    { text: input.target.text, reason: '원문과 같아서 저장할 수 없는 안' },
    { text: '저장할 수 있는 첫째 안', reason: '표현 보완' },
    { text: '저장할 수 있는 둘째 안', reason: '다른 표현' },
  ] }); } });
  try {
    const req = await create('비교안을 만들어 주세요', { kind: 'suggest', options: { count: 3 } });
    worker.start();
    await until(async () => (await api(`${D}/requests/${req.rid}`)).status === 'failed', '부분 저장 실패 표시');
    assert.equal(worker.stats().completed, 0);
    assert.equal((await api(`${D}/proposals`)).filter((p) => p.rid === req.rid).length, 2, '이미 저장한 두 안은 보존');
    assert.match((await api(`${D}/requests/${req.rid}`)).error, /개인 AI 처리에 실패/);
  } finally { await worker.stop(); await srv.stop(); }
});

test('개인 worker: 취소 알림을 못 받은 뒤 즉시 재시도해도 옛 AI 결과를 새 시도에 쓰지 않음', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup(); const gate = deferred(); let calls = 0;
  const worker = makeWorker(srv, { async run(input) {
    calls++;
    if (calls === 1) { await gate.promise; return result({ comments: [{ ref: 's0/p1', find: '', text: '옛 시도의 늦은 결과' }] }); }
    return result({ comments: [{ ref: 's0/p1', find: '', text: '새 시도의 올바른 결과' }] });
  } }, { timing: { ...timing, backoffMs: 3000, maxBackoffMs: 3000 } });
  try {
    worker.start(); await until(async () => (await api('/api/agent/status')).me.online, 'SSE online');
    const req = await create('취소 후 다시 요청', { route: 'agent' }); await until(() => calls === 1, '옛 실행 시작');
    worker.sseController.abort(); await until(async () => !(await api('/api/agent/status')).me.online, '취소 알림을 받지 못하는 상태');
    await api(`${D}/requests/${req.rid}/cancel`, { method: 'POST' });
    await api(`${D}/requests/${req.rid}/retry`, { method: 'POST' }); gate.resolve();
    await until(() => worker.stats().completed === 1, '새 시도 완료');
    const comments = (await api(`${D}/memos`)).filter((m) => m.link?.type === 'comment' && m.link.rid === req.rid);
    assert.equal(comments.length, 1); assert.match(comments[0].body, /새 시도의 올바른 결과/);
    assert.equal(calls, 2); assert.equal(worker.stats().cancelled, 1);
  } finally { gate.resolve(); await worker.stop(); await srv.stop(); }
});

test('개인 worker: 저장 직전 취소·재시도 경합도 expected_attempt를 서버 트랜잭션에서 차단', { timeout: 15000 }, async () => {
  const { srv, api, D, create } = await setup(); let calls = 0; let raced = false; let req; let worker;
  const sentAttempts = [];
  const fetchImpl = async (url, options = {}) => {
    const request = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (request?.method === 'tools/call' && request.params?.name === 'propose_changes') {
      sentAttempts.push(request.params.arguments.expected_attempt);
      if (!raced) {
        raced = true;
        worker.sseController.abort(); await until(async () => !(await api('/api/agent/status')).me.online, '경합 중 취소 알림 차단');
        await api(`${D}/requests/${req.rid}/cancel`, { method: 'POST' });
        await api(`${D}/requests/${req.rid}/retry`, { method: 'POST' });
      }
    }
    return fetch(url, options);
  };
  worker = makeWorker(srv, { async run(input) {
    calls++;
    return result({ proposals: [{ ref: input.target.ref, find: input.target.text, replace: calls === 1 ? '옛 시도 제안' : '새 시도 제안', reason: '경합 시험' }] });
  } }, { fetchImpl, timing: { ...timing, backoffMs: 3000, maxBackoffMs: 3000 } });
  try {
    req = await create('저장 직전 다시 요청'); worker.start();
    await until(() => worker.stats().completed === 1, '새 시도만 완료');
    const proposals = (await api(`${D}/proposals`)).filter((p) => p.rid === req.rid);
    assert.equal(proposals.length, 1); assert.equal(proposals[0].replace, '새 시도 제안');
    assert.deepEqual(sentAttempts, [1, 2]);
    assert.equal(worker.stats().cancelled, 1); assert.equal(worker.stats().failed, 0);
  } finally { await worker.stop(); await srv.stop(); }
});


test('worker는 빈 결과를 완료로 숨기지 않고 변경 불필요 검토는 명시한 사유로만 완료한다', { timeout: 15000 }, async () => {
  const { srv, api, D, id, create } = await setup();
  let noChangesReason;
  const worker = makeWorker(srv, { async run() {
    return { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '보고서 작성을 완료했습니다.',
      ...(noChangesReason ? { noChangesReason } : {}) };
  } });
  try {
    const missing = await create('본문과 표, 그림을 실제로 작성해 주세요.', { kind: 'instruct' });
    await worker.process(await worker.callJson('claim_next_request', { doc_id: id }));
    const failed = await api(`${D}/requests/${missing.rid}`);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /실제로 저장한 결과가 없어/);
    assert.equal((await api(`${D}/proposals`)).length, 0);
    noChangesReason = '대상 원문의 내용과 서식이 검토 기준을 충족해 변경할 사항이 없습니다.';
    const review = await create('기존 원문을 검토해 변경이 필요한지 확인해 주세요.');
    await worker.process(await worker.callJson('claim_next_request', { doc_id: id }));
    const done = await api(`${D}/requests/${review.rid}`);
    assert.equal(done.status, 'done'); assert.match(done.summary, /문서 변경 없음/); assert.ok(done.summary.includes(noChangesReason));
    assert.ok(!done.summary.includes('보고서 작성을 완료했습니다.'));
    assert.equal(worker.stats().failed, 1); assert.equal(worker.stats().completed, 1);
  } finally { await worker.stop(); await srv.stop(); }
});
