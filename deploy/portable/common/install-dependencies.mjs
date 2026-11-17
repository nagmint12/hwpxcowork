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
// node_modules 안 모든 꾸러미(중첩·@범위 포함)의 package.json 이 읽히는지 본다 → 못 읽는 꾸러미 이름.
// 설치 직후 PC 가 갑자기 꺼지면 크기만 남고 내용이 0으로 채워진 파일이 생길 수 있고, 그러면 서버가 켜자마자 죽는다
// (2026-11-17 사용자 보고: pako/package.json). 있는지만 보면 그 상태로 계속 '설치됨'이라 고쳐지지 않는다.
// 같은 검사가 scripts/setup-personal.mjs 에도 있다(이 파일은 설치 묶음에서 혼자 돌아야 해서 따로 둔다).
function damagedModules(root) {
  const top = path.join(root, 'node_modules'); const bad = [];
  const readable = (file) => { try { const text = fs.readFileSync(file, 'utf8'); return !!text.trim() && text.charCodeAt(0) !== 0 && !!JSON.parse(text); } catch { return false; } };
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith('@')) { walk(p); continue; }
      if (!readable(path.join(p, 'package.json'))) bad.push(path.relative(top, p).replaceAll('\\', '/'));
      if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules'));
    }
  })(top);
  return bad;
}
let damaged = [];
const ready = () => {
  try {
    if (fs.readFileSync(marker, 'utf8') !== hash || !Object.keys(manifest.dependencies).every((name) => fs.existsSync(path.join(app, 'node_modules', name, 'package.json')))) return false;
    damaged = damagedModules(app);
    return damaged.length === 0;
  } catch { return false; }
};
if (process.argv.includes('--check')) process.exit(ready() ? 0 : 1);
if (ready()) { console.log('필요한 npm 모듈이 이미 설치되어 있습니다.'); process.exit(0); }
if (damaged.length) console.log(`손상된 라이브러리 파일이 있어 다시 설치합니다: ${damaged.slice(0, 3).join(', ')}${damaged.length > 3 ? ` 외 ${damaged.length - 3}개` : ''}\n(설치 직후 PC 가 갑자기 꺼지면 생길 수 있습니다.)`);
const nodeDir = path.dirname(process.execPath);
const npmCli = findNpmCli();
if (!npmCli) { console.error('npm을 찾지 못했습니다. install-node.bat(또는 install-node.sh)로 Node와 npm을 준비한 뒤 다시 실행하세요.'); process.exit(1); }
console.log('잠금 파일의 npm 모듈을 이 PC에 설치합니다. 인터넷 연결이 필요합니다.');
const result = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: app, stdio: 'inherit', env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` },
});
if (result.error || result.status !== 0) { console.error('npm 설치에 실패했습니다. 네트워크·프록시와 위 오류를 확인한 뒤 다시 실행하세요.'); process.exit(1); }
fs.writeFileSync(marker, hash);
console.log('라이브러리 설치를 마쳤습니다.');
