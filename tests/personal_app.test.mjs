// 개인용 앱 실행기(deploy/portable/personal.mjs, docs/LOCAL_FOLDER_APP_2026-11-10.md) — 임시 설정 폴더·임시 PC 폴더로 창 없이 켠다.
//   node --test tests/personal_app.test.mjs
// 앱 창(Edge·Chrome 전용 창)·폴더 고르기 창·실제 AI 실행기는 여기서 띄우지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, authorName, personalConfig, workerCommand, appDir } from '../deploy/portable/personal.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'deploy', 'portable', 'personal.mjs');
const BASE = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'hangul_trk_brk_base.hwpx'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const cleanEnv = (more) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^HWPX_COWORK_/i.test(k)) env[k] = v;
  return { ...env, HWPX_COWORK_AI: 'off', ...more };
};
/** 실행기를 띄운다 → { child, lines, ready(→ port), done(→ 종료 코드) } */
function run(args, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let onLine = () => {};
  for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream }).on('line', (l) => { lines.push(l); onLine(l); });
  const done = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`개인용 앱이 뜨지 않았습니다:\n${lines.join('\n')}`)), 60000);
    onLine = (l) => { const m = /^PERSONAL (\d+)$/.exec(l); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    done.then((code) => { clearTimeout(timer); reject(new Error(`개인용 앱이 끝났습니다(${code}):\n${lines.join('\n')}`)); });
  });
  ready.catch(() => {});
  return { child, lines, ready, done };
}

test('인자·첫 설정·AI 실행기 명령', () => {
  assert.deepEqual(parseArgs(['C:\\문서', '--folder', 'D:\\b', '--port', '8801', '--name', '홍길동', '--ai', '--provider codex', '--no-window', '--keep']),
    { folders: ['C:\\문서', 'D:\\b'], port: 8801, name: '홍길동', ai: '--provider codex', shared: false, noWindow: true, keep: true, help: false });
  assert.equal(parseArgs(['--shared', '--no-window']).shared, true, '데스크톱 앱의 공동 작업용(2026-11-17)');
  assert.throws(() => parseArgs(['--port', 'abc']), /--port/);
  assert.throws(() => parseArgs(['--what']), /모르는 인자/);
  assert.equal(authorName('  홍\u0000길동  '), '홍 길동');
  assert.ok(authorName('').length > 0, '이름을 주지 않으면 PC 사용자 이름(없으면 나)');
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const cfg = personalConfig(example, { name: '홍길동', port: 8801, token: 'tok-1234' });
  assert.equal(cfg.host, '127.0.0.1', '이 PC 만');
  assert.deepEqual(cfg.users, [{ name: '홍길동', token: 'tok-1234', role: 'admin' }], '예제 사용자·예제 토큰을 넣지 않는다');
  assert.equal(cfg.local.enabled, true);
  assert.equal(cfg.ai.enabled, false); assert.equal(cfg.ai.keyFile, undefined);
  assert.equal(cfg.documents.defaultEditMode, 'realtime');
  assert.equal(cfg.changeRequests.allowDirectApply, true);
  assert.equal(cfg.studioUrl, undefined); assert.equal(cfg.publicUrl, undefined);
  assert.equal(cfg.tutorial.enabled, false, '첫 화면을 체험 문서로 보내지 않는다');
  assert.equal(path.resolve(appDir), path.resolve(root), '개발 폴더에서는 저장소가 프로그램 폴더');
  const cmd = workerCommand('--provider codex --effort low', { port: 8801, token: 'tok-1234', env: { A: '1' } });
  assert.deepEqual(cmd.args.slice(1), ['--provider', 'codex', '--effort', 'low', '--url', 'http://127.0.0.1:8801/mcp']);
  assert.ok(cmd.args[0].endsWith(path.join('scripts', 'ai-worker.mjs')));
  assert.deepEqual(cmd.env, { A: '1', HWPX_COWORK_TOKEN: 'tok-1234' }, '토큰은 환경 변수로만');
  assert.equal(workerCommand('', { port: 1, token: 'x' }), null);
  assert.throws(() => workerCommand('--provider codex --url http://x', { port: 1, token: 'x' }), /--url/);
});

test('창 없이 켜기: 첫 설정을 만들고 폴더를 연결한다 — 두 번째 실행은 폴더만 더 연결하고 끝난다 — quit 으로 끈다', { timeout: 180000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-personal-'));
  const userdata = path.join(tmp, '설정 폴더');
  const pc = path.join(tmp, '내 문서'); const pc2 = path.join(tmp, '둘째 폴더');
  fs.mkdirSync(pc); fs.mkdirSync(pc2);
  fs.writeFileSync(path.join(pc, '보고서.hwpx'), BASE);
  const port = await freePort();
  const env = { HWPX_COWORK_USERDATA: userdata, HWPX_COWORK_LOCAL_TRASH: path.join(tmp, 'trash') };
  let app = run([pc, '--port', String(port), '--name', '시험 사용자', '--no-window'], env);
  t.after(async () => {
    try { app.child.stdin.write('quit\n'); } catch { /* 이미 끝남 */ }
    await Promise.race([app.done, sleep(15000)]);
    try { app.child.kill(); } catch { /* 이미 끝남 */ }
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 남겨도 됨 */ }
  });
  assert.equal(await app.ready, port);
  const cfg = JSON.parse(fs.readFileSync(path.join(userdata, 'config.json'), 'utf8'));
  assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.port, port); assert.equal(cfg.local.enabled, true);
  assert.equal(cfg.users.length, 1); assert.equal(cfg.users[0].name, '시험 사용자'); assert.equal(cfg.users[0].role, 'admin');
  const token = cfg.users[0].token;
  assert.ok(token.length >= 20 && !app.lines.some((l) => l.includes(token)), '토큰은 무작위이고 창에 찍지 않는다');
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal((await get('/api/config')).local, true);
  const me = await get('/api/me');
  assert.equal(me.role, 'admin'); assert.equal(me.tutorial, undefined, '체험으로 보내지 않는다');
  const lib = await get('/api/library');
  assert.equal(lib.me.name, '시험 사용자');
  assert.equal(lib.local.canLink, true);
  assert.deepEqual(lib.local.links.map((l) => l.path), [pc]);
  assert.deepEqual(lib.docs.filter((d) => d.local).map((d) => d.fileName), ['보고서.hwpx']);
  assert.ok(fs.existsSync(path.join(userdata, 'data')), '기록은 설정 폴더 아래 data/');

  // 두 번째 실행: 이미 떠 있는 앱에 폴더만 더 연결하고 끝난다(서버를 또 띄우지 않는다)
  const second = run([pc2, '--no-window'], env);
  assert.equal(await second.done, 0);
  assert.ok(second.lines.some((l) => l.includes('이미 켜져 있습니다')), second.lines.join('\n'));
  assert.deepEqual((await get('/api/local')).links.map((l) => l.path).sort(), [pc, pc2].sort());

  // quit → 저장을 마치고 끝난다. 서버도 함께 꺼진다
  app.child.stdin.write('quit\n');
  assert.equal(await app.done, 0, app.lines.join('\n'));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2000) }));

  // 다시 켜면 같은 설정·연결 그대로
  app = run(['--no-window'], env);
  assert.equal(await app.ready, port);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userdata, 'config.json'), 'utf8')).users[0].token, token);
  assert.deepEqual((await get('/api/local')).links.map((l) => l.path).sort(), [pc, pc2].sort());
});
