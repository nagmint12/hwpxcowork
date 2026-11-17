import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DesktopHost, desktopEnvironment } from '../deploy/desktop/host.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const payload = process.env.HWPX_DESKTOP_TEST_PAYLOAD || root;
const node = process.env.HWPX_DESKTOP_TEST_NODE || process.execPath;
test('unsupported Mac AI mode rejects before any CLI or worker starts', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-desktop-ai-gate-'));
  const host=new DesktopHost({payload,node,userdata:dir,spawnImpl:()=>{throw Error('CLI must not start');}});
  host.state.aiSupported=false;host.state.aiSupportMessage='macOS 13 required';
  try{await assert.rejects(host.prepareAi('codex'),/macOS 13 required/);assert.equal(host.operations.size,0);assert.equal(host.worker,null);}
  finally{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-desktop-test-')); }
function cleanup(dir) { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

test('데스크톱 환경은 운영 설정·API 키를 물려받지 않고 전용 설정과 내장 Node를 쓴다', () => {
  const env = desktopEnvironment({ PATH: '/usr/bin', HWPX_COWORK_CONFIG: 'production.json', HWPX_COWORK_TOKEN: 'production-token', HWPX_COWORK_PORT: '8787', ANTHROPIC_API_KEY: 'paid-key', OPENAI_API_KEY: 'paid-key', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil.js', HOME: os.homedir() }, '/test/settings', '/bundled/bin/node');
  assert.equal(env.HWPX_COWORK_CONFIG, path.join('/test/settings', 'config.json'));
  for (const key of ['HWPX_COWORK_TOKEN', 'HWPX_COWORK_PORT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
  assert.equal(env.HWPX_COWORK_AI, 'off'); assert.equal(env.HWPX_COWORK_DESKTOP_MANAGED, '1');
  assert.ok(env.PATH.startsWith(path.dirname('/bundled/bin/node') + path.delimiter));
});

test('AI 취소 중 인증 점검이 완료되어도 실행기·로그인을 새로 시작하지 않는다', async () => {
  const dir = temporary(); const host = new DesktopHost({ payload, node, userdata: dir });
  let finishAuth; let launched = false;
  host.auth = () => new Promise(resolve => { finishAuth = resolve; });
  host.launch = () => { launched = true; throw new Error('취소 뒤 실행되면 안 됩니다'); };
  try {
    const connecting = host.prepareAi('codex');
    await new Promise(resolve => setImmediate(resolve));
    await host.disconnectAi(); finishAuth({ installed: false, ready: false });
    await assert.rejects(connecting, /취소/);
    assert.equal(launched, false); assert.equal(host.state.aiPhase, 'off');
    assert.equal(host.preferences().ai, 'none');
  } finally { cleanup(dir); }
});

test('AI 실행기도 부모 앱 IPC가 끊기면 정리 후 종료한다(모의 AI, 모델 호출 없음)', { timeout: 15000 }, async () => {
  const dir = temporary();
  fs.copyFileSync(path.join(root, 'scripts/setup-worker.mjs'), path.join(dir, 'setup-worker.mjs'));
  fs.writeFileSync(path.join(dir, 'ai-worker.mjs'), 'export async function main(){ const timer=setInterval(()=>{},1000); process.on("SIGTERM",()=>{clearInterval(timer);console.log("STOPPED")}); console.log("READY"); }');
  const child = spawn(node, [path.join(dir, 'setup-worker.mjs')], { env: { ...process.env, HWPX_COWORK_DESKTOP_MANAGED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = ''; const done = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('모의 실행기 준비 시간 초과')), 5000);
      child.stdout.on('data', b => { output += b; if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
      child.stderr.resume();
    });
    child.disconnect(); assert.equal(await done, 0); assert.match(output, /STOPPED/);
  } finally { if (child.connected) child.send('stop'); await done; cleanup(dir); }
});

test('앱 시작→개인 서버·편집기·PC 폴더→종료→재실행 시 설정 보존', { timeout: 180000 }, async () => {
  const dir = temporary(); const userdata = path.join(dir, '설정'); const docs = path.join(dir, '문서'); fs.mkdirSync(docs);
  fs.copyFileSync(path.join(root, 'tests/fixtures/hangul_trk_brk_base.hwpx'), path.join(docs, '보고서.hwpx'));
  const before = fs.readFileSync(path.join(docs, '보고서.hwpx'));
  let host = new DesktopHost({ payload, node, userdata });
  try {
    const url = new URL(await host.start());
    assert.equal(url.hostname, 'localhost'); assert.notEqual(url.port, '8787'); assert.ok(url.hash.startsWith('#/t/'));
    const cfg = JSON.parse(fs.readFileSync(path.join(userdata, 'config.json')));
    assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.users.length, 1); assert.ok(cfg.users[0].token.length >= 24);
    assert.equal(cfg.ai.enabled, false); assert.equal(cfg.tutorial.enabled, false);
    assert.equal(host.preferences().ai, 'none');
    const web = await fetch(url.origin + '/'); assert.equal(web.status, 200); assert.match(await web.text(), /<html/);
    const studio = await fetch(url.origin + '/studio/'); assert.equal(studio.status, 200);
    await host.linkFolder(docs);
    const library = await host.api('/api/library');
    assert.equal(library.local.canLink, true); assert.ok(library.docs.some(d => d.fileName === '보고서.hwpx'));
    assert.equal(host.worker, null, '실행만으로 AI 요청을 시작하지 않는다');
    await host.stop();
    await assert.rejects(fetch(url.origin + '/api/config', { signal: AbortSignal.timeout(2000) }));
    assert.deepEqual(fs.readFileSync(path.join(docs, '보고서.hwpx')), before);
    host = new DesktopHost({ payload, node, userdata }); await host.start();
    const after = JSON.parse(fs.readFileSync(path.join(userdata, 'config.json')));
    assert.equal(after.users[0].token, cfg.users[0].token);
    assert.deepEqual((await host.api('/api/local')).links.map(l => l.path), [docs]);
    await host.stop();
  } finally { await host.stop(); cleanup(dir); }
});

test('부모 앱의 IPC가 끊기면 그 앱이 켠 개인 서버도 정상 종료', { timeout: 90000 }, async () => {
  const dir = temporary(); const script = fs.existsSync(path.join(payload, 'portable/personal.mjs')) ? 'portable/personal.mjs' : 'deploy/portable/personal.mjs';
  const child = spawn(node, [path.join(payload, script), '--no-window', '--ai', ''], { cwd: payload, env: desktopEnvironment(process.env, dir, node), stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let port;
  const done = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('서버 준비 시간 초과')), 60000);
      child.stdout.on('data', b => { text += b; const m = /PERSONAL (\d+)/.exec(text); if (m) { port = Number(m[1]); clearTimeout(timer); resolve(); } });
      child.stderr.resume();
      done.then(code => { clearTimeout(timer); reject(new Error('준비 전에 종료: ' + code)); });
    });
    child.disconnect();
    assert.equal(await done, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2000) }));
  } finally { if (child.connected) child.send('stop'); await done; cleanup(dir); }
});
