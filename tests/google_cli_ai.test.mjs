import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GoogleCliProposer, parseGoogleCliResult, resolveGoogleCli } from '../server/google-cli-ai.js';
import { parseWorkerArgs, createWorkerAi, workerAgentName } from '../scripts/ai-worker.mjs';
import { parseOrchestrationArgs, createOrchestrationAi } from '../scripts/orchestration-worker.mjs';

const reply = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '검토 완료', instructionSummary: '검토' };
const input = { kind: 'review', instruction: '표현 확인', target: { ref: 's0/p1' }, context: [{ ref: 's0/p1', text: '검토할 문장입니다.' }], attachments: [] };

test('Windows npm Gemini는 package.json의 bin 경로를 읽어 최신 bundle과 이전 dist 설치를 모두 찾는다', { skip: process.platform !== 'win32' }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-google-test-'));
  try {
    const packageDir = path.join(base, 'node_modules', '@google', 'gemini-cli');
    const shim = path.join(base, 'gemini.cmd');
    await fs.mkdir(path.join(packageDir, 'bundle'), { recursive: true });
    await fs.writeFile(shim, '@echo off');
    const bundle = path.join(packageDir, 'bundle', 'gemini.js'); await fs.writeFile(bundle, '');
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'bundle/gemini.js' } }));
    assert.deepEqual(await resolveGoogleCli('gemini-cli', shim, {}), { file: process.execPath, args: [bundle] });
    const legacy = path.join(packageDir, 'dist', 'index.js'); await fs.mkdir(path.dirname(legacy)); await fs.writeFile(legacy, '');
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: '../../outside.js' } }));
    await fs.writeFile(path.join(base, 'node_modules', 'outside.js'), '');
    assert.deepEqual(await resolveGoogleCli('gemini-cli', shim, {}), { file: process.execPath, args: [legacy] }, '패키지 밖 bin은 실행하지 않고 이전 설치 경로를 사용');
  } finally {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^hwpx-google-test-/);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('Google CLI는 API 키·API 모델 환경과 구분하고 기존 gemini API를 유지한다', () => {
  const env = { HWPX_COWORK_TOKEN: 't', HWPX_COWORK_AI_MODEL: 'api-model', GEMINI_API_KEY: 'api-secret' };
  for (const provider of ['gemini-cli', 'antigravity']) {
    const parsed = parseWorkerArgs(['--provider', provider, '--cli-command', 'custom.exe'], env);
    assert.equal(parsed.model, undefined); assert.equal(parsed.key, undefined); assert.equal(parsed.command, 'custom.exe');
    assert.ok(createWorkerAi(parsed, env) instanceof GoogleCliProposer);
    assert.match(workerAgentName(parsed), /CLI/);
    assert.throws(() => parseWorkerArgs(['--provider', provider, '--gateway', 'baze'], env), /API/);
    const orchestrator = parseOrchestrationArgs(['--provider', provider, '--agent-id', 'google-worker'], env);
    assert.ok(createOrchestrationAi(orchestrator, {}, env) instanceof GoogleCliProposer);
  }
  const api = parseWorkerArgs(['--provider', 'gemini'], env);
  assert.equal(api.key, 'api-secret'); assert.equal(api.model, 'api-model');
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--cli-command', 'custom.exe'], env), /cli-command/);
});

test('Google CLI 결과는 오류·불완전 응답·거절된 작업을 완료로 처리하지 않는다', () => {
  assert.equal(parseGoogleCliResult(JSON.stringify({ response: JSON.stringify(reply), stats: { models: { test: { tokens: { input: 10, candidates: 2 } } } } }), 'gemini-cli').usage.input, 10);
  const event = { event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(reply), usage: { input_tokens: 4, output_tokens: 1 } } };
  assert.equal(parseGoogleCliResult(JSON.stringify(event), 'antigravity').usage.output, 1);
  for (const text of ['no JSON', '{}', JSON.stringify({ error: 'private detail', response: JSON.stringify(reply) }), JSON.stringify({ response: '{}' })]) {
    assert.throws(() => parseGoogleCliResult(text, 'gemini-cli'), e => e.code === 'GOOGLE_CLI_OUTPUT_INVALID' && !e.message.includes('private detail'));
  }
  event.result.denied_actions = ['command'];
  assert.throws(() => parseGoogleCliResult(JSON.stringify(event), 'antigravity'), { code: 'GOOGLE_CLI_OUTPUT_INVALID' });
});

async function fixture(provider, mode = 'ok') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-google-test-'));
  const script = path.join(base, 'fake-cli.mjs'); const receipt = path.join(base, 'receipt.json');
  await fs.writeFile(script, `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('--help')) { console.log('--prompt --output-format --input-format --extensions --allowed-mcp-server-names --json-schema --disable-slash-commands --mode --settings'); process.exit(0); }
    let input=''; for await(const chunk of process.stdin) input += chunk;
    const settings = args.includes('--settings') ? args[args.indexOf('--settings')+1] : process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args,input,env:process.env,cwd:process.cwd(),pid:process.pid,settings:JSON.parse(fs.readFileSync(settings,'utf8'))}));
    if (${JSON.stringify(mode)} === 'slow') await new Promise(r=>setTimeout(r,20000));
    if (${JSON.stringify(mode)} === 'fail') {console.error('private-secret');process.exit(1);}
    const response = JSON.stringify(${JSON.stringify(reply)});
    console.log(JSON.stringify(${JSON.stringify(provider)} === 'antigravity' ? {event:'result',result:{status:'SUCCESS',response,usage:{input_tokens:3,output_tokens:1}}} : {response}));
  `);
  return { base, receipt, dependencies: { tempRoot: base, env: { ...process.env, HWPX_COWORK_TOKEN: 'private-secret', GEMINI_API_KEY: 'api-secret', NODE_OPTIONS: '--trace-warnings' }, resolveCommand: async () => ({ file: process.execPath, args: [script] }) },
    async cleanup() { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^hwpx-google-test-/); await fs.rm(base, { recursive: true, force: true }); } };
}

test('두 CLI는 문서를 stdin으로 전송하고 토큰을 차단하며 임시 작업공간을 정리한다', async () => {
  for (const provider of ['gemini-cli', 'antigravity']) {
    const f = await fixture(provider);
    try {
      const ai = new GoogleCliProposer({ provider }, f.dependencies);
      const check = await ai.check(); assert.equal(check.ready, true); assert.equal(check.loginVerified, false);
      await assert.rejects(fs.stat(f.receipt), { code: 'ENOENT' });
      const result = await ai.run(input); assert.equal(result.summary, reply.summary);
      const saved = JSON.parse(await fs.readFile(f.receipt, 'utf8'));
      assert.ok(saved.input.includes(input.instruction)); assert.ok(!saved.args.join(' ').includes(input.instruction));
      for (const key of ['HWPX_COWORK_TOKEN', 'GEMINI_API_KEY', 'NODE_OPTIONS']) assert.equal(saved.env[key], undefined);
      if (provider === 'antigravity') { assert.ok(saved.settings.permissions.deny.includes('command(*)')); assert.equal(JSON.parse(saved.input).event, 'user'); }
      else assert.deepEqual(saved.settings.tools.core, ['hwpx_no_tools']);
      await assert.rejects(fs.stat(saved.cwd), { code: 'ENOENT' });
      await assert.rejects(ai.run({ ...input, attachments: [{ kind: 'image', base64: 'abc' }] }), { code: 'UNSUPPORTED_ATTACHMENT' });
    } finally { await f.cleanup(); }
  }
});

test('CLI 실패·취소·시간 초과는 결과를 저장하지 않고 자식 프로세스를 종료한다', async () => {
  for (const mode of ['fail', 'abort', 'timeout']) {
    const f = await fixture('gemini-cli', mode === 'fail' ? 'fail' : 'slow');
    try {
      const controller = new AbortController();
      const ai = new GoogleCliProposer({ timeoutMs: mode === 'timeout' ? 1000 : 10000 }, f.dependencies);
      const running = ai.run(input, { signal: controller.signal });
      const rejected = assert.rejects(running, { code: mode === 'fail' ? 'GOOGLE_CLI_FAILED' : mode === 'abort' ? 'ABORTED' : 'GOOGLE_CLI_TIMEOUT' });
      let saved;
      for (let i = 0; i < 200; i++) { try { saved = JSON.parse(await fs.readFile(f.receipt, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
      assert.ok(saved);
      if (mode === 'abort') controller.abort();
      await rejected;
      assert.throws(() => process.kill(saved.pid, 0));
      await assert.rejects(fs.stat(saved.cwd), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
  await assert.rejects(resolveGoogleCli('antigravity', path.join(os.tmpdir(), 'missing-agy-never.exe')), { code: 'GOOGLE_CLI_NOT_FOUND' });
});
