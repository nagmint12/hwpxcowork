// 별도 엔진·편집기·빈 데이터·새 설정으로 독립 체험 서버를 실행한다.
// node scripts/run-engine-preview.mjs --bundle artifacts/rhwp090-merged --port 8790
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  if (!process.argv[at + 1]) throw new Error(`${name} 값이 필요합니다`);
  return process.argv[at + 1];
};
const bundle = path.resolve(root, option('--bundle', 'artifacts/rhwp090-merged'));
if (!bundle.startsWith(path.join(root, 'artifacts') + path.sep)) throw new Error('체험 서버는 artifacts 아래의 별도 폴더를 사용해야 합니다');
const port = Number(option('--port', '8790'));
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787) throw new Error('8787 이외의 유효한 체험 포트가 필요합니다');
const pkg = path.join(bundle, 'engine-pkg');
const studio = path.join(bundle, 'studio-dist');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const engineInfo = read(path.join(pkg, 'cowork-engine.json'));
const studioInfo = read(path.join(studio, 'cowork-build.json'));
if (path.resolve(root, studioInfo.enginePackage) !== pkg) throw new Error('편집기와 서버 엔진 패키지가 다릅니다');
if (hash(path.join(pkg, 'rhwp_bg.wasm')) !== hash(path.join(studio, 'rhwp_bg.wasm'))
    || hash(path.join(pkg, 'rhwp.js')) !== hash(path.join(studio, 'rhwp.js'))) throw new Error('편집기와 서버 WASM/JS 해시가 다릅니다');
if (engineInfo.base.tag !== studioInfo.upstream.tag) throw new Error('엔진과 편집기 버전이 다릅니다');

const configPath = path.join(bundle, 'preview-config.json');
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({
  host: '127.0.0.1', port, dataDir: './preview-data', allowAgentApply: true,
  users: [{ name: '독립 체험 관리자', role: 'admin', token: crypto.randomBytes(24).toString('hex') }],
  ai: { enabled: false, mock: true }, studio: { mode: 'local' }, clipboardBridge: { enabled: false },
}, null, 2), { flag: 'wx' });
const config = read(configPath);
const dataDir = path.join(bundle, 'preview-data');
fs.mkdirSync(dataDir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
Object.assign(env, {
  HWPX_COWORK_CONFIG: configPath, HWPX_COWORK_DATA_DIR: dataDir,
  HWPX_COWORK_HOST: '127.0.0.1', HWPX_COWORK_PORT: String(port),
  HWPX_COWORK_AI_MOCK: '1', HWPX_COWORK_ENGINE_PKG: pkg, HWPX_COWORK_STUDIO_DIR: studio,
});
const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
  cwd: root, env, windowsHide: true, stdio: 'inherit',
});
const url = `http://localhost:${port}/#/t/${encodeURIComponent(config.users[0].token)}`;
fs.writeFileSync(path.join(bundle, 'preview-runtime.json'), JSON.stringify({
  launcherPid: process.pid, serverPid: child.pid, startedAt: new Date().toISOString(), url, port,
  tag: engineInfo.base.tag, wasmSha256: hash(path.join(pkg, 'rhwp_bg.wasm')),
  jsSha256: hash(path.join(pkg, 'rhwp.js')), dataDir, configPath, enginePackage: pkg, studioDir: studio,
}, null, 2));
console.log(`[preview] ${engineInfo.base.tag} ${url}`);
const stop = () => { if (!child.killed) child.kill(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
