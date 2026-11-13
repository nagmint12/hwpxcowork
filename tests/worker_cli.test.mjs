import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerArgs, checkWorkerConnection, createWorkerAi, workerAgentName } from '../scripts/ai-worker.mjs';
import { createApiWorker } from '../server/worker.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import fs from 'node:fs';

test('API 작업공간은 명시한 hosted 옵션을 전달하고 Codex·다른 제공자의 hosted 사용을 거절한다', () => {
  const env = { HWPX_COWORK_TOKEN: 't', BAZE_API_KEY: 'fake-api-key' };
  const options = parseWorkerArgs(['--provider', 'openai', '--gateway', 'baze', '--model', 'model', '--workspace', 'hosted'], env);
  assert.equal(createWorkerAi(options).cfg.workspace, 'hosted');
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--workspace', 'hosted'], env), /codex/);
  assert.throws(() => parseWorkerArgs(['--provider', 'gemini', '--gateway', 'baze', '--model', 'model', '--workspace', 'hosted'], env), /OpenAI/);
});

test('ChatGPT 로그인 실행기는 API 키 없이 선택하고 API 제공자 호환성은 유지한다', () => {
  const env = { HWPX_COWORK_TOKEN: 'local-token', OPENAI_API_KEY: 'do-not-use', CODEX_API_KEY: 'do-not-use-either', HWPX_COWORK_AI_MODEL: 'api-model' };
  const options = parseWorkerArgs(['--provider', 'codex', '--check'], env);
  assert.equal(options.provider, 'codex'); assert.equal(options.check, true);
  assert.equal(options.key, undefined); assert.equal(options.model, undefined);
  assert.equal(parseWorkerArgs(['--provider', 'codex', '--model', 'chosen', '--codex-command', 'C:/my codex/codex.exe'], env).command, 'C:/my codex/codex.exe');
  assert.equal(parseWorkerArgs(['--provider', 'codex'], { HWPX_COWORK_TOKEN: 't', HWPX_COWORK_CODEX_MODEL: 'my-model' }).model, 'my-model');
  assert.throws(() => parseWorkerArgs(['--provider', 'codex'], {}), /HWPX_COWORK_TOKEN/);
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--codex-command'], env), /값/);
  assert.throws(() => parseWorkerArgs(['--provider', 'openai'], { HWPX_COWORK_TOKEN: 't' }), /--model/);
  assert.equal(parseWorkerArgs(['--provider', 'chatgpt', '--model', 'api-model'], env).provider, 'openai');
});

test('BAZE 게이트웨이 실행기는 BAZE_API_KEY 만 쓰고 연결 방식·추론 강도를 AI 설정과 처리자 이름에 넘긴다', () => {
  const env = { HWPX_COWORK_TOKEN: 't', OPENAI_API_KEY: 'provider-key', BAZE_API_KEY: 'baze-key' };
  const options = parseWorkerArgs(['--provider', 'openai', '--gateway', 'BAZE', '--model', 'gpt-6.1-sol', '--effort', 'medium'], env);
  assert.equal(options.gateway, 'baze'); assert.equal(options.key, 'baze-key'); assert.equal(options.effort, 'medium');
  const ai = createWorkerAi(options, env);
  assert.equal(ai.enabled, true); assert.equal(ai.baseUrl, 'https://api.baze.co/v1/gateway'); assert.equal(ai.cfg.effort, 'medium');
  assert.equal(workerAgentName(options), 'OpenAI API (게이트웨이)');
  assert.equal(workerAgentName(parseWorkerArgs(['--provider', 'openai', '--model', 'm'], env)), 'OpenAI API');
  assert.throws(() => parseWorkerArgs(['--provider', 'anthropic', '--gateway', 'baze', '--model', 'm'], { HWPX_COWORK_TOKEN: 't', ANTHROPIC_API_KEY: 'provider-key' }), /BAZE_API_KEY/);
  assert.throws(() => parseWorkerArgs(['--provider', 'gemini', '--gateway', 'baze', '--model', 'm'], { HWPX_COWORK_TOKEN: 't', GOOGLE_API_KEY: 'provider-key' }), /BAZE_API_KEY/);
  // 환경 변수로도 고를 수 있고, 잘못된 값은 시작 전에 거절
  const fromEnv = parseWorkerArgs(['--provider', 'gemini', '--model', 'gemini-3.5-flash-lite'], { ...env, HWPX_COWORK_AI_GATEWAY: 'baze' });
  assert.equal(fromEnv.gateway, 'baze'); assert.equal(fromEnv.key, 'baze-key');
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--gateway', 'other', '--model', 'm'], env), /--gateway/);
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--effort', 'turbo', '--model', 'm'], env), /--effort/);
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--base-url', 'http://remote.example/v1', '--model', 'm'], env), /https/);
  // 임의 주소는 보낼 키 변수를 --key-env 로 밝혀야 한다(환경의 제공자 키가 새지 않게)
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--base-url', 'https://gateway.example/v1', '--model', 'm'], env), /--key-env/);
  const custom = parseWorkerArgs(['--provider', 'openai', '--base-url', 'https://gateway.example/v1/', '--key-env', 'MY_GATEWAY_KEY', '--model', 'm'], { ...env, MY_GATEWAY_KEY: 'gateway-key' });
  assert.equal(custom.baseUrl, 'https://gateway.example/v1'); assert.equal(custom.key, 'gateway-key');
  assert.equal(workerAgentName(custom), 'OpenAI API (게이트웨이)');
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--base-url', 'https://gateway.example/v1', '--key-env', 'MY_GATEWAY_KEY', '--model', 'm'], env), /MY_GATEWAY_KEY/);
  assert.throws(() => parseWorkerArgs(['--provider', 'openai', '--base-url', 'https://gateway.example/v1', '--key-env', 'bad name', '--model', 'm'], env), /--key-env/);
  // codex 는 API 연결 옵션을 받지 않고, 환경 변수의 API 설정은 무시한다
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--gateway', 'baze'], env), /codex/);
  assert.equal(parseWorkerArgs(['--provider', 'codex'], { ...env, HWPX_COWORK_AI_GATEWAY: 'baze' }).provider, 'codex');
});

test('실제 격리 서버 사전 점검은 API 계정·도구만 읽고 대기열을 선점하지 않는다', { timeout: 15000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  let aiCalls = 0;
  const worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai: { run() { aiCalls++; } }, log() {} });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
    const api = srv.api('a');
    const request = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' }, route: 'queue' } })).request;
    const before = await api(`/api/docs/${doc.id}`);
    const checked = await checkWorkerConnection(worker);
    assert.equal(checked.user, srv.users.a.name); assert.equal(checked.toolsReady, true);
    const after = await api(`/api/docs/${doc.id}/requests/${request.rid}`);
    assert.equal(after.status, 'pending'); assert.equal(after.claim, null);
    assert.equal((await api(`/api/docs/${doc.id}`)).version, before.version);
    assert.equal(aiCalls, 0);
    assert.equal((await api('/api/agent/status')).me.online, false, '--check does not advertise a running channel');
  } finally { await worker.stop(); await srv.stop(); }
});

test('이전 서버의 누락 도구와 재시도 보호 없는 변경 도구를 사전 거절한다', async () => {
  const base = { url: new URL('https://example.test/mcp'), headers: () => ({ Authorization: 'Bearer hidden' }) };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ name: 'tester' }) });
  await assert.rejects(checkWorkerConnection({ ...base, connected: async () => ({ listTools: async () => ({ tools: [] }) }) }, { fetchImpl }), { code: 'PREFLIGHT_FAILED' });
  let attempts = 0;
  await assert.rejects(checkWorkerConnection({ ...base, connected: async () => ({ listTools: async () => { attempts++; return { tools: [], nextCursor: 'same' }; } }) }, { fetchImpl }), { code: 'PREFLIGHT_FAILED' });
  assert.equal(attempts, 2);
});
