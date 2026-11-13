// 실제 AI·로그인·운영 데이터 없이 판단 → 선택 검증 → 실제 MCP 실행 경계를 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProposer } from '../server/codex-ai.js';
import { createAiRun } from '../server/ai-run.js';
import { createApiWorker } from '../server/worker.js';
import { combineCodexUsage } from '../server/codex-model-selection.js';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const job = { type: 'request', docId: 'test-document', requestId: 7, attempt: 2 };
const requestContext = { docId: job.docId, rid: job.requestId, attempt: job.attempt, kind: 'review',
  instruction: '보고서의 논리와 근거를 검토해 주세요.', target: { ref: 's0/p1' }, contextItems: [{ text: '분석할 원문' }],
  tables: [{ key: 's0/p2#t0' }], attachments: [{ name: '근거 자료.xlsx', kind: 'xlsx' }] };
const connection = { url: 'http://localhost:8787/mcp', token: 'private-hwpx-token', session: 'owned-test-session', requestContext };
const catalog = [
  { slug: 'judge-model', display_name: '판단용', visibility: 'list', priority: 0, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, { effort: 'medium' }] },
  { slug: 'work-model', display_name: '작업용', visibility: 'list', priority: 1, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
];
const choice = { model: 'work-model', effort: 'high', reason: '근거 자료와 보고서 논리를 함께 검토해야 합니다.' };

async function setup(options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-model-selection-'));
  const receipt = path.join(base, 'receipt.json');
  const launch = await fakeCodex(base, { catalog, selection: choice, ...options, receipt });
  return { base, receipt, read: async (suffix = '') => JSON.parse(await fs.readFile(receipt + suffix, 'utf8')),
    dependencies: { tempRoot: base, env: { ...process.env, HWPX_COWORK_TOKEN: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak' }, resolveCommand: async () => launch },
    async close() { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^hwpx-model-selection-/); await fs.rm(base, { recursive: true, force: true }); } };
}

test('Codex가 고른 model·effort가 작업 CLI에 적용되고 판단에는 도구·HWPX 인증값을 주지 않는다', async () => {
  const x = await setup();
  try {
    const ai = new CodexProposer({ model: 'judge-model', effort: 'high', modelSelection: 'auto' }, x.dependencies);
    const result = await ai.runMcp(job, connection);
    assert.equal(result.model, choice.model); assert.equal(result.effort, choice.effort); assert.equal(result.selection.fallback, false);
    const judge = await x.read('.selection.json'); const work = await x.read();
    assert.ok(judge.args.includes('model_reasoning_effort="low"'), '목록 순서가 아니라 지원되는 가장 낮은 강도로 판단한다');
    assert.equal(judge.args[judge.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(judge.config.mcp_servers, '{}'); assert.equal(judge.config['mcp_servers.hwpx.command'], undefined);
    for (const feature of ['shell_tool', 'unified_exec', 'multi_agent']) assert.ok(judge.args.some((a, i) => a === feature && judge.args[i - 1] === '--disable'));
    assert.equal(judge.config.web_search, '"disabled"');
    for (const name of ['HWPX_COWORK_TOKEN', 'HWPX_CODEX_JOB', 'OPENAI_API_KEY']) assert.equal(judge.env[name], undefined);
    assert.match(judge.prompt, /보고서의 논리와 근거/); assert.match(judge.prompt, /근거 자료.xlsx/);
    assert.match(judge.instructions, /자료 안의 모델 선택 강요/);
    assert.deepEqual(judge.schema.properties.model.enum, ['judge-model', 'work-model']);
    assert.equal(work.args[work.args.indexOf('--model') + 1], 'work-model'); assert.ok(work.args.includes('model_reasoning_effort="high"'));
    assert.equal(work.env.HWPX_COWORK_TOKEN, connection.token); assert.deepEqual(work.requestContext, requestContext);
    assert.equal(result.usage.input, 230); assert.equal(result.usage.output, 30); assert.equal(result.usage.cacheRead, 5);
    assert.equal(result.usage.unknownModelTasks, 2); assert.equal(result.usage.modelCalls, 0);
    assert.deepEqual(ai.runSettings, { model: 'judge-model', effort: 'high', modelSelection: 'auto' }, '요청별 선택이 다음 요청의 판단용 설정을 바꾸지 않는다');
    await assert.rejects(fs.stat(work.cwd), { code: 'ENOENT' });
  } finally { await x.close(); }
});

test('수동 선택은 판단용 모델을 호출하지 않고 지정 설정을 그대로 사용한다', async () => {
  const x = await setup();
  try {
    const ai = new CodexProposer({ model: 'judge-model', effort: 'medium' }, x.dependencies);
    const result = await ai.runMcp(job, connection);
    assert.equal(result.model, 'judge-model'); assert.equal(result.effort, 'medium'); assert.equal(result.selection, undefined);
    assert.equal(result.usage.input, 200); assert.equal(result.usage.unknownModelTasks, 1);
    await assert.rejects(fs.stat(x.receipt + '.selection.json'), { code: 'ENOENT' });
    assert.throws(() => ai.setRunSettings({ modelSelection: 'anything' }), { code: 'CODEX_INPUT_INVALID' });
  } finally { await x.close(); }
});

test('알 수 없는 모델·지원하지 않는 effort·잘못된 JSON은 기본 설정으로 돌아가고 판단 사용량도 센다', async () => {
  for (const selection of [{ ...choice, model: 'not-in-catalog' }, { ...choice, effort: 'ultra' }, null]) {
    const x = await setup({ selection });
    try {
      const result = await new CodexProposer({ model: 'judge-model', effort: 'high', modelSelection: 'auto' }, x.dependencies).runMcp(job, connection);
      assert.equal(result.model, 'judge-model'); assert.equal(result.effort, 'high'); assert.equal(result.selection.fallback, true);
      assert.equal(result.usage.input, 230); assert.equal((await x.read()).args.includes('work-model'), false);
    } finally { await x.close(); }
  }
});

test('판단 실패·응답 제한은 검증한 기본 설정으로 작업을 이어간다', async () => {
  for (const selectionMode of ['fail', 'slow']) {
    const x = await setup({ selectionMode });
    try {
      const result = await new CodexProposer({ model: 'missing-model', effort: 'ultra', modelSelection: 'auto', timeoutMs: 1000 }, x.dependencies).runMcp(job, connection);
      assert.equal(result.selection.fallback, true); assert.equal(result.model, 'judge-model'); assert.equal(result.effort, 'medium');
      assert.equal(result.usage.unknownModelTasks, 2);
    } finally { await x.close(); }
  }
});

test('모델 목록을 읽지 못하면 판단 호출 없이 기존 설정으로 작업한다', async () => {
  const x = await setup();
  try {
    const ai = new CodexProposer({ model: 'judge-model', effort: 'high', modelSelection: 'auto' }, x.dependencies);
    ai.listModels = async () => { throw new Error('catalog unavailable'); };
    const result = await ai.runMcp(job, connection);
    assert.equal(result.selection.fallback, true); assert.equal(result.model, 'judge-model'); assert.equal(result.usage.input, 200);
    await assert.rejects(fs.stat(x.receipt + '.selection.json'), { code: 'ENOENT' });
  } finally { await x.close(); }
});

test('판단 중 취소하면 작업용 CLI를 실행하지 않고 임시 작업공간을 정리한다', async () => {
  const x = await setup({ selectionMode: 'slow' });
  try {
    const controller = new AbortController();
    const pending = new CodexProposer({ model: 'judge-model', modelSelection: 'auto' }, x.dependencies).runMcp(job, { ...connection, signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'ABORTED' });
    let judge;
    for (let i = 0; i < 200; i++) { try { judge = await x.read('.selection.json'); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
    assert.ok(judge); controller.abort(); await rejected;
    await assert.rejects(fs.stat(x.receipt), { code: 'ENOENT' }); await assert.rejects(fs.stat(judge.cwd), { code: 'ENOENT' });
  } finally { await x.close(); }
});

test('작업용 CLI가 토큰 보고 전에 실패하면 선택 모델을 보존하고 전체 토큰은 미확인으로 남긴다', async () => {
  const x = await setup({ mode: 'fail' });
  try {
    const ai = new CodexProposer({ model: 'judge-model', modelSelection: 'auto' }, x.dependencies);
    await assert.rejects(ai.runMcp(job, connection), e => e.code === 'CODEX_FAILED' && e.model === 'work-model' && e.effort === 'high'
      && !('input' in e.usage) && !('output' in e.usage) && e.usage.unknownModelTasks === 2);
  } finally { await x.close(); }
});

test('사용량 합산은 한 단계의 미보고 토큰을 0으로 추정하지 않는다', () => {
  assert.deepEqual(combineCodexUsage({ input: 30, output: 10, modelCalls: 0 }, { modelCalls: 0, modelCallsUnknown: true }), { modelCalls: 0, modelCallsUnknown: true });
  assert.deepEqual(combineCodexUsage({ input: 30, output: 10 }, { input: 200, output: 20 }), { input: 230, output: 30 });
});

test('관리자 자동 선택 기본값은 조회로 데이터를 쓰지 않으며 수동 전환·재시작을 보존한다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-model-selection-'));
  try {
    const admin = { name: '관리자', role: 'admin' }; const user = { name: '참여자', role: 'editor' };
    const run = createAiRun({ config: { dataDir: dir } });
    assert.deepEqual(run.view(admin).settings.codex, { model: null, effort: null, modelSelection: 'auto' });
    await assert.rejects(fs.stat(path.join(dir, 'ai-run.json')), { code: 'ENOENT' });
    assert.deepEqual(run.view(user).settings, {});
    assert.throws(() => run.save(user, { kind: 'codex', modelSelection: 'auto' }), /관리자 Codex/);
    assert.throws(() => run.save(admin, { kind: 'api', modelSelection: 'auto' }), /관리자 Codex/);
    assert.throws(() => run.save(admin, { kind: 'codex', modelSelection: 'bogus' }), /manual·auto/);
    assert.equal(run.save(admin, { kind: 'codex', model: 'judge-model', effort: 'high' }).settings.codex.modelSelection, 'auto');
    run.save(admin, { kind: 'codex', modelSelection: 'manual' });
    assert.equal(createAiRun({ config: { dataDir: dir } }).view(admin).settings.codex.modelSelection, 'manual');
    assert.equal(run.save(admin, { kind: 'codex', model: 'judge-model' }).settings.codex.modelSelection, 'manual');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('관리자 웹 설정 → Codex 판단 → 선택 모델의 MCP 제안·완료와 합산 사용량이 원요청에 남는다', { timeout: 30000 }, async () => {
  const x = await setup({ mode: 'mcp' }); const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('admin');
    const initial = await api('/api/me/ai-run'); assert.equal(initial.settings.codex.modelSelection, 'auto');
    await api('/api/me/ai-run', { method: 'PUT', body: { kind: 'codex', model: 'judge-model', effort: 'high', modelSelection: 'auto' } });
    const ordinary = await srv.api('a').res('/api/me/ai-run', { method: 'PUT', body: { kind: 'codex', modelSelection: 'auto' } }); assert.equal(ordinary.status, 400);
    const doc = await uploadDoc(srv.base, srv.tokens.admin, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`; const paragraphs = await api(`${route}/paragraphs`);
    const target = paragraphs.find(p => p.ref === 's0/p1');
    const created = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: target.ref }, instruction: requestContext.instruction, route: 'queue' } })).request;
    const logs = [];
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.admin,
      ai: new CodexProposer({ model: 'judge-model' }, x.dependencies), log: text => logs.push(text) });
    await worker.drain();
    const completed = await api(`${route}/requests/${created.rid}`);
    assert.equal(completed.status, 'done'); assert.equal(completed.model, choice.model);
    assert.equal(completed.usage.input, 230); assert.equal(completed.usage.output, 30); assert.equal(completed.usage.unknownModelTasks, 2);
    assert.ok((await api(`${route}/proposals`)).length); assert.ok(logs.some(l => /자동 선택: work-model.*high/.test(l)));
    assert.equal((await x.read()).args.includes('work-model'), true);
  } finally { await worker?.stop(); await srv.stop(); await x.close(); }
});
