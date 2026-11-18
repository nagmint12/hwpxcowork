// rhwp WASM 엔진(vendor/rhwp 의 Rust 소스)을 빌드해 vendor/rhwp/pkg 를 바꾼다. 편집기 빌드(build:studio)는 이 pkg 를 쓴다.
// 2026-10-27 부터 vendor/rhwp 는 독자 개선 대상이다(원본 v0.8.7 npm 배포본 pkg 는 backups/rhwp_pkg_npm_0.8.7_2026-10-27/).
//   node scripts/build-engine.mjs            release(LTO) 빌드 → vendor/rhwp/pkg
//   node scripts/build-engine.mjs --fast     release-test(LTO 없음 — 2분 남짓, 시험용) 빌드 → vendor/rhwp/pkg
// 필요: rustup(툴체인은 vendor/rhwp/rust-toolchain.toml 이 고정 — 1.93.1 + wasm32-unknown-unknown),
//       wasm-bindgen CLI 는 Cargo.lock 의 wasm-bindgen 과 같은 판(cargo install wasm-bindgen-cli --version <판> --locked).
// 끝나면 npm run build:studio 로 편집기를 다시 빌드한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 모르는 인자는 빌드하지 않고 멈춘다(2026-11-18: build-studio 가 `--help` 를 무시하고 운영 번들을 다시 빌드한 일 — 같은 꼴을 막는다).
{
  const FLAGS = new Set(['--fast', '--with-pdf', '--keep-names']); const VALUED = new Set(['--out', '--source', '--target-dir']);
  const args = process.argv.slice(2); const unknown = [];
  for (let i = 0; i < args.length; i++) { if (VALUED.has(args[i])) i++; else if (!FLAGS.has(args[i])) unknown.push(args[i]); }
  if (unknown.length) {
    const help = unknown.every((a) => a === '--help' || a === '-h');
    console[help ? 'log' : 'error'](`${help ? '' : `[build-engine] 모르는 인자: ${unknown.join(' ')}\n`}사용법: node scripts/build-engine.mjs [--fast] [--keep-names] [--with-pdf] [--out artifacts/<작업>/engine-pkg] [--source <엔진 소스 폴더>] [--target-dir <빌드 캐시>]\n  --out 이 없으면 운영 엔진 vendor/rhwp/pkg 를 바꿉니다.`);
    process.exit(help ? 0 : 1);
  }
}
const sourceAt = process.argv.indexOf('--source');
if (sourceAt >= 0 && !process.argv[sourceAt + 1]) throw new Error('--source에 엔진 소스 폴더가 필요합니다');
const vendor = sourceAt < 0 ? path.join(root, 'vendor', 'rhwp') : path.resolve(root, process.argv[sourceAt + 1]);
const outAt = process.argv.indexOf('--out');
const pkg = outAt < 0 ? path.join(vendor, 'pkg') : path.resolve(root, process.argv[outAt + 1] || '');
if (outAt >= 0 && (!process.argv[outAt + 1] || !pkg.startsWith(path.join(root, 'artifacts') + path.sep) || path.basename(pkg) !== 'engine-pkg')) throw new Error('--out은 artifacts 아래의 engine-pkg 폴더여야 합니다');
if (sourceAt >= 0 && outAt < 0) throw new Error('별도 소스 빌드는 --out artifacts/<작업>/engine-pkg로 분리해야 합니다');
const targetAt = process.argv.indexOf('--target-dir');
if (targetAt >= 0 && !process.argv[targetAt + 1]) throw new Error('--target-dir에 공유 빌드 캐시 경로가 필요합니다');
const targetDir = targetAt < 0 ? path.join(vendor, 'target', 'pr-review') : path.resolve(root, process.argv[targetAt + 1]);
const fast = process.argv.includes('--fast');
const profile = fast ? 'release-test' : 'release';
// [hwpx-cowork] 2026-11-10 엔진 크기(P2): 0.9.0 기본 feature 의 PDF 불러오기(pdf-import·pdf-jbig2·pdf-jpeg2000·pdf-icc —
// pdf_oxide·office_oxide·tiny-skia)는 우리 편집기·서버·MCP 가 부르지 않는다(fork 0.8.7 에는 없던 기능, 편집기는
// supportsPdfImport()=false 면 PDF 열기를 숨긴다). 이 스크립트는 웹·서버용 WASM 만 만들므로 여기서만 끈다 — 네이티브 CLI·
// cargo test 는 Cargo.toml 기본값 그대로. 되살리려면 --with-pdf.
const withPdf = process.argv.includes('--with-pdf');
const featureArgs = withPdf ? [] : ['--no-default-features', '--features', 'console_error_panic_hook,wasm-api'];
// [hwpx-cowork] 디버그용 name 섹션(함수 이름, 1.85MB·brotli 약 0.4MB)은 패닉 «메시지»(파일:줄 포함, 데이터 영역)에는
// 쓰이지 않고 JS 스택의 함수 이름에만 쓰인다. 운영 번들에서는 빼고, 필요하면 --keep-names 로 다시 만든다.
const keepNames = process.argv.includes('--keep-names');

function fail(msg) { console.error(`[build-engine] ${msg}`); process.exit(1); }

// rustup 기본 설치 자리(~/.cargo/bin)는 PATH 에 없을 수 있다
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH || ''}` };
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const which = (name) => [cargoBin, ...(process.env.PATH || '').split(path.delimiter)]
  .map((d) => path.join(d, exe(name))).find((p) => fs.existsSync(p));

const cargo = which('cargo'); if (!cargo) fail('cargo 가 없습니다 — rustup 을 설치하세요(https://rustup.rs)');
const bindgen = which('wasm-bindgen');
const lock = fs.readFileSync(path.join(vendor, 'Cargo.lock'), 'utf8');
const want = /name = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock)?.[1];
if (!bindgen) fail(`wasm-bindgen CLI 가 없습니다 — cargo install wasm-bindgen-cli --version ${want} --locked`);
const have = spawnSync(bindgen, ['--version'], { encoding: 'utf8', env }).stdout.trim().split(/\s+/)[1];
if (want && have !== want) fail(`wasm-bindgen CLI ${have} ≠ Cargo.lock ${want} — cargo install wasm-bindgen-cli --version ${want} --locked --force`);

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: vendor, stdio: 'inherit', env });
  if (r.status !== 0) fail(`${path.basename(cmd)} ${args.join(' ')} 실패(종료 코드 ${r.status ?? r.signal})`);
};

const t0 = Date.now();
console.log(`[build-engine] cargo build --lib --target wasm32-unknown-unknown --profile ${profile} ${featureArgs.join(' ')}`.trimEnd());
run(cargo, ['build', '--locked', '--lib', '--target', 'wasm32-unknown-unknown', '--profile', profile, ...featureArgs, '--target-dir', targetDir]);
const wasm = path.join(targetDir, 'wasm32-unknown-unknown', profile, 'rhwp.wasm');
if (!fs.existsSync(wasm)) fail(`빌드 결과가 없습니다: ${wasm}`);

// 새 pkg 를 옆에 만든 뒤 바꿔 넣는다(실패하면 기존 pkg 그대로)
const next = `${pkg}.next`;
// 두 삭제 대상은 위에서 고정한 vendor/pkg 또는 artifacts/engine-pkg 안에만 있다.
if (path.resolve(pkg) !== path.join(vendor, 'pkg') && !path.resolve(pkg).startsWith(path.join(root, 'artifacts') + path.sep)) fail('출력 폴더가 작업 공간을 벗어납니다');
fs.mkdirSync(path.dirname(pkg), { recursive: true });
fs.rmSync(next, { recursive: true, force: true });
run(bindgen, ['--target', 'web', ...(keepNames ? [] : ['--remove-name-section']), '--out-dir', next, '--out-name', 'rhwp', wasm]);
for (const f of ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'rhwp_bg.wasm.d.ts']) {
  if (!fs.existsSync(path.join(next, f))) fail(`wasm-bindgen 결과에 ${f} 가 없습니다`);
}
fs.rmSync(pkg, { recursive: true, force: true });
fs.renameSync(next, pkg);
const head = spawnSync('git', ['-C', vendor, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null;
const dirty = spawnSync('git', ['-C', vendor, 'status', '--short', '--', 'src', 'crates', 'Cargo.toml'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(pkg, 'cowork-engine.json'), JSON.stringify({
  builtAt: new Date().toISOString(), profile, source: path.relative(root, vendor),
  base: { tag: `v${/^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(vendor, 'Cargo.toml'), 'utf8'))?.[1] || 'unknown'}`, commit: head },
  modified: dirty ? dirty.split(/\r?\n/).map((l) => l.trim()) : [],
  wasmBindgen: have,
  features: withPdf ? 'default' : 'console_error_panic_hook,wasm-api',
  nameSection: keepNames,
}, null, 2));
const mb = (fs.statSync(path.join(pkg, 'rhwp_bg.wasm')).size / 1048576).toFixed(1);
console.log(`[build-engine] 완료 ${((Date.now() - t0) / 1000).toFixed(0)}s → ${path.relative(root, pkg)} (wasm ${mb}MB, ${profile}). 다음: npm run build:studio`);
