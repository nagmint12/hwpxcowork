// The install package deliberately excludes node_modules. Run on the recipient's PC.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findNpmCli } from './npm-location.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = path.join(app, 'package-lock.json');
if (!fs.existsSync(lock)) process.exit(0); // Existing offline/lite packages already contain modules.
const manifest = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const hash = crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
const marker = path.join(app, 'node_modules', '.cowork-installed');
const ready = () => {
  try {
    return fs.readFileSync(marker, 'utf8') === hash && Object.keys(manifest.dependencies).every((name) => fs.existsSync(path.join(app, 'node_modules', name, 'package.json')));
  } catch { return false; }
};
if (process.argv.includes('--check')) process.exit(ready() ? 0 : 1);
if (ready()) { console.log('필요한 npm 모듈이 이미 설치되어 있습니다.'); process.exit(0); }
const nodeDir = path.dirname(process.execPath);
const npmCli = findNpmCli();
if (!npmCli) { console.error('npm을 찾지 못했습니다. install-node.bat(또는 install-node.sh)로 Node와 npm을 준비한 뒤 다시 실행하세요.'); process.exit(1); }
console.log('잠금 파일의 npm 모듈을 이 PC에 설치합니다. 인터넷 연결이 필요합니다.');
const result = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: app, stdio: 'inherit', env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` },
});
if (result.error || result.status !== 0) { console.error('npm 설치에 실패했습니다. 네트워크·프록시와 위 오류를 확인한 뒤 다시 실행하세요.'); process.exit(1); }
fs.writeFileSync(marker, hash);
console.log('설치 완료. 서버는 admin-app.bat 또는 start-server.bat, 개인 실행기는 start-worker.bat로 켜세요.');
