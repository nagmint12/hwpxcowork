// node --test tests/ai_run.test.mjs — 연결별 모델·추론 강도(server/ai-run.js): 웹 저장·검사, 실행기가 요청마다 적용·모델 목록 알리기,
// Codex 모델 목록(codex debug models — 가짜 codex), 개인 키 모델 목록(가짜 fetch), Claude Code 실행 인자(scripts/run-settings.mjs).
// 실제 AI·로그인 파일은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiRun, RUN_KINDS } from '../server/ai-run.js';
import { listCodexModels, CodexProposer } from '../server/codex-ai.js';
import { AiProposer } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { parseWorkerArgs } from '../scripts/ai-worker.mjs';
import { runArgs, main as runSettingsMain } from '../scripts/run-settings.mjs';
import { startServer } from './helpers/server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-airun-'));
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('저장·검사: 종류별 추론 강도, 모델 ID 글자, 비우면 기본, 실행기가 알린 목록 정리(Codex 모델별 강도)', () => {
  const dir = tmp();
  try {
    const run = createAiRun({ config: { dataDir: dir } });
    const me = { name: '홍길동' };
    const v0 = run.view(me);
    assert.deepEqual(v0.kinds.map((k) => k.id), RUN_KINDS.map((k) => k.id));
    assert.deepEqual(v0.settings, {});
    assert.equal(v0.kinds.find((k) => k.id === 'claude-code').modelsFrom, 'builtin');
    const v1 = run.save(me, { kind: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' });
    assert.deepEqual(v1.settings.codex, { model: 'gpt-6.1-sol', effort: 'ultra' });
    assert.throws(() => run.save(me, { kind: 'gemini-cli', effort: 'high' }), /추론 강도를 정할 수 없습니다/);
    assert.throws(() => run.save(me, { kind: 'claude-code', effort: 'ultra' }), /low·medium·high·xhigh·max/);
    assert.throws(() => run.save(me, { kind: 'codex', model: 'a b&c' }), /영문·숫자/);
    assert.throws(() => run.save(me, { kind: 'nope' }), /연결 종류/);
    assert.deepEqual(run.save(me, { kind: 'codex', model: '', effort: '' }).settings, {}, '둘 다 비우면 기본(지움)');
    // 실행기가 알린 목록: 이상한 ID·중복·모르는 강도는 뺀다
    const r = run.report(me, { kind: 'codex', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'ultra', 'bogus'], defaultEffort: 'medium' }, { id: 'gpt-6.1-sol' }, { id: 'bad id' }] });
    assert.equal(r.count, 1);
    const codex = run.view(me).kinds.find((k) => k.id === 'codex');
    assert.deepEqual([codex.modelsFrom, codex.models], ['reported', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'ultra'], defaultEffort: 'medium' }]]);
    // 다른 사람과 섞이지 않고, 다시 읽어도 남는다
    assert.deepEqual(run.view({ name: '김검토' }).kinds.find((k) => k.id === 'codex').models, []);
    run.save(me, { kind: 'claude-code', model: 'claude-opus-5-5', effort: 'high' });
    assert.deepEqual(createAiRun({ config: { dataDir: dir } }).view(me).settings, { 'claude-code': { model: 'claude-opus-5-5', effort: 'high' } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex 모델 목록: codex debug models 를 읽어 숨김 빼고 차례대로·모델별 추론 강도(가짜 codex)', async () => {
  const dir = tmp();
  try {
    const script = path.join(dir, 'fake-codex.mjs');
    const catalog = { models: [
      { slug: 'gpt-b', display_name: 'B', priority: 5, visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
      { slug: 'gpt-hidden', display_name: 'H', priority: 1, visibility: 'hide', supported_reasoning_levels: [] },
      { slug: 'gpt-a', display_name: 'A', priority: 0, visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }, { effort: 'weird' }] },
    ] };
    fs.writeFileSync(script, `const a = process.argv.slice(2); if (a[0] === 'debug' && a[1] === 'models') { console.log(${JSON.stringify(JSON.stringify(catalog))}); process.exit(0); } process.exit(3);`);
    const deps = { env: process.env, resolveCommand: async () => ({ file: process.execPath, args: [script] }) };
    const list = await listCodexModels(deps);
    assert.deepEqual(list, [{ id: 'gpt-a', label: 'A', efforts: ['medium', 'ultra'], defaultEffort: 'medium' }, { id: 'gpt-b', label: 'B', efforts: ['low', 'medium'], defaultEffort: 'low' }]);
    const ai = new CodexProposer({ model: 'gpt-b' }, deps);
    assert.deepEqual(await ai.listModels(), list);
    assert.deepEqual([ai.runKind, ai.runSettings], ['codex', { model: 'gpt-b', effort: null, modelSelection: 'manual' }]);
    ai.setRunSettings({ model: 'gpt-a', effort: 'ultra' });
    assert.deepEqual(ai.runSettings, { model: 'gpt-a', effort: 'ultra', modelSelection: 'manual' });
    assert.throws(() => ai.setRunSettings({ effort: 'huge' }), /추론 강도/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('개인 키 모델 목록: API는 이 제공자 방식만, OpenAI 직접은 /models(가짜 fetch — 목록 조회만)', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push([url, opts.method, opts.headers]);
    if (String(url).includes('baze')) return json({ data: [{ id: 'gpt-6.1-sol', endpoints: ['/v1/gateway/responses'] }, { id: 'claude-x', endpoints: ['/v1/gateway/claude/v1/messages'] }] });
    return json({ data: [{ id: 'gpt-a' }, { id: 'gpt-b', display_name: 'B 모델' }] });
  };
  const baze = new AiProposer({ ai: { provider: 'openai', gateway: 'baze', model: 'gpt-6.1-sol', enabled: true } }, { key: 'sk-test-0000', fetch });
  assert.deepEqual(await baze.listModels(), [{ id: 'gpt-6.1-sol' }]);
  const direct = new AiProposer({ ai: { provider: 'openai', model: 'gpt-a', enabled: true } }, { key: 'sk-test-0000', fetch });
  assert.deepEqual(await direct.listModels(), [{ id: 'gpt-a' }, { id: 'gpt-b', label: 'B 모델' }]);
  assert.ok(calls.every(([, method]) => method === 'GET'), '생성 호출 없이 GET 만');
  assert.deepEqual([direct.runKind, direct.runSettings], ['api', { model: 'gpt-a', effort: null }]);
  direct.setRunSettings({ model: 'gpt-b', effort: 'high' });
  assert.deepEqual(direct.runSettings, { model: 'gpt-b', effort: 'high' });
});

test('실행기: 요청마다 웹 값 적용(비우면 실행할 때 준 값), 모델 목록을 웹에 알림, 서버에 못 닿으면 그대로', async () => {
  let web = { settings: { codex: { model: 'gpt-web', effort: 'high' } } }; const puts = []; let down = false;
  const fetchImpl = async (url, opts = {}) => {
    if (down) throw new Error('offline');
    if (String(url).endsWith('/api/me/ai-run') && (opts.method || 'GET') === 'GET') return json(web);
    if (String(url).endsWith('/api/me/ai-run/catalog')) { puts.push(JSON.parse(opts.body)); return json({ ok: true }); }
    return json({}, 404);
  };
  const ai = { runKind: 'codex', model: 'gpt-cli', effort: 'low', run: async () => ({}),
    get runSettings() { return { model: this.model, effort: this.effort }; }, setRunSettings({ model, effort }) { this.model = model; this.effort = effort; },
    listModels: async () => [{ id: 'gpt-web' }, { id: 'gpt-cli' }] };
  const logs = [];
  const w = createApiWorker({ url: 'http://127.0.0.1:1/mcp', token: 't', ai, fetchImpl, log: (l) => logs.push(l) });
  await w.applyRunSettings();
  assert.deepEqual([ai.model, ai.effort], ['gpt-web', 'high']);
  web = { settings: { codex: { effort: 'max' } } };
  await w.applyRunSettings();
  assert.deepEqual([ai.model, ai.effort], ['gpt-cli', 'max'], '모델을 비우면 실행할 때 준 --model');
  web = { settings: {} };
  await w.applyRunSettings();
  assert.deepEqual([ai.model, ai.effort], ['gpt-cli', 'low']);
  down = true; await w.applyRunSettings(); down = false;
  assert.deepEqual([ai.model, ai.effort], ['gpt-cli', 'low'], '못 읽으면 지금 값 그대로');
  assert.equal(await w.reportModels(), 2);
  assert.deepEqual(puts, [{ kind: 'codex', models: [{ id: 'gpt-web' }, { id: 'gpt-cli' }] }]);
  assert.ok(logs.some((l) => l.includes('gpt-web') && l.includes('웹 설정')));
  await w.stop();
  // runKind 가 없는 AI(시험용 가짜)는 아무것도 하지 않는다
  const plain = createApiWorker({ url: 'http://127.0.0.1:1/mcp', token: 't', ai: { run: async () => ({}) }, fetchImpl: async () => { throw new Error('부르면 안 됨'); } });
  await plain.applyRunSettings(); assert.equal(await plain.reportModels(), null); await plain.stop();
});

test('실행기: 모델 목록을 켤 때와 일정 간격마다 다시 알림, 바뀐 때만 로그(2026-11-18)', async () => {
  const puts = []; let list = [{ id: 'gpt-6.1-sol' }];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('/api/me/ai-run/catalog')) { puts.push(JSON.parse(opts.body).models.map((m) => m.id)); return json({ ok: true }); }
    return json({}, 404);
  };
  const ai = { runKind: 'codex', run: async () => ({}), setRunSettings() {}, listModels: async () => list };
  const logs = [];
  const w = createApiWorker({ url: 'http://127.0.0.1:1/mcp', token: 't', ai, fetchImpl, timing: { modelsMs: 40, pollMs: 60000 }, log: (l) => logs.push(l) });
  w.start();
  const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok()); };
  await until(() => puts.length >= 2);
  list = [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.1-sol' }];
  await until(() => puts.some((p) => p.includes('gpt-6.2-sol')));
  await w.stop();
  const n = puts.length; await new Promise((r) => setTimeout(r, 100));
  assert.equal(puts.length, n, '멈춘 뒤에는 다시 알리지 않는다');
  const modelLogs = logs.filter((l) => l.includes('모델'));
  assert.equal(modelLogs.filter((l) => l.includes('개를 웹에 알렸습니다')).length, 1, '같은 목록은 로그를 되풀이하지 않는다');
  assert.ok(modelLogs.some((l) => l.includes('새 모델 gpt-6.2-sol')), modelLogs.join('\n'));
});

test('Claude Code 기본 목록: 최신 별칭이 앞에', async () => {
  const { RUN_KINDS } = await import('../server/ai-run.js');
  const ids = RUN_KINDS.find((k) => k.id === 'claude-code').models.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 4), ['fable', 'opus', 'sonnet', 'haiku']);
});

test('실행기 인자: codex 도 --effort(ultra 까지)·HWPX_COWORK_AI_EFFORT, 틀린 값은 거절', () => {
  const env = { HWPX_COWORK_TOKEN: 't' };
  assert.equal(parseWorkerArgs(['--provider', 'codex', '--effort', 'ultra'], env).effort, 'ultra');
  assert.equal(parseWorkerArgs(['--provider', 'codex'], { ...env, HWPX_COWORK_AI_EFFORT: 'High' }).effort, 'high');
  assert.equal(parseWorkerArgs(['--provider', 'codex'], env).effort, null);
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--effort', 'huge'], env), /--effort/);
});

test('Claude Code 실행 인자(scripts/run-settings.mjs): 안전한 글자만, 서버에 못 닿으면 빈 줄', async () => {
  assert.equal(runArgs({ model: 'claude-opus-5-5', effort: 'high' }), '--model claude-opus-5-5 --effort high');
  assert.equal(runArgs({ model: 'x & del', effort: 'high' }), '--effort high');
  assert.equal(runArgs({}), '');
  const fetchImpl = async (url, opts) => { assert.equal(opts.headers.Authorization, 'Bearer tk'); assert.equal(url, 'http://localhost:9999/api/me/ai-run'); return json({ settings: { 'claude-code': { model: 'claude-sonnet-5-5' } } }); };
  assert.equal(await runSettingsMain(['claude-code', '--port', '9999'], { HWPX_COWORK_TOKEN: 'tk' }, fetchImpl), '--model claude-sonnet-5-5');
  assert.equal(await runSettingsMain(['claude-code'], {}, fetchImpl), '', '토큰 없으면 빈 줄');
  assert.equal(await runSettingsMain(['claude-code'], { HWPX_COWORK_TOKEN: 'tk' }, async () => { throw new Error('off'); }), '');
});

test('서버: GET·PUT /api/me/ai-run, 실행기 목록 알림(catalog) — 사람마다 따로', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a'); const B = srv.api('b');
    assert.deepEqual((await A('/api/me/ai-run')).settings, {});
    const v = await A('/api/me/ai-run', { method: 'PUT', body: { kind: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' } });
    assert.deepEqual(v.settings.codex, { model: 'gpt-6.1-sol', effort: 'xhigh' });
    assert.equal((await A.res('/api/me/ai-run', { method: 'PUT', body: { kind: 'gemini-cli', effort: 'high' } })).status, 400);
    assert.deepEqual(await A('/api/me/ai-run/catalog', { method: 'PUT', body: { kind: 'codex', models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'high'] }] } }), { kind: 'codex', count: 1 });
    assert.equal((await A('/api/me/ai-run')).kinds.find((k) => k.id === 'codex').modelsFrom, 'reported');
    assert.deepEqual((await B('/api/me/ai-run')).settings, {}, '다른 사람 설정은 안 보임');
    assert.equal((await A.res('/api/me/ai/models')).status, 404, '개인 키가 없으면 목록 없음');
  } finally { await srv.stop(); }
});
