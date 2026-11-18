// rhwp-studio(vendor/rhwp, v0.8.7 스냅샷)를 우리 통합 층(studio/)과 묶어 /studio/ 로 빌드한다.
// vendor/rhwp 는 손대지 않는다 — 바꿀 것은 모두 studio/ 의 빌드 시점 패치·플러그인으로 넣는다.
//   node scripts/build-studio.mjs              빌드(studio/dist)
//   node scripts/build-studio.mjs --check      패치 기준 글(anchor)만 확인
//   node scripts/build-studio.mjs --typecheck  cowork 플러그인·저장 작업자 형 검사 — vendor 의 tsc 사용
//   node scripts/build-studio.mjs --out artifacts/<작업>/studio-dist  서비스 빌드와 분리해 검증
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertFontDistributionTree } from './font-distribution-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceAt = process.argv.indexOf('--source');
if (sourceAt >= 0 && !process.argv[sourceAt + 1]) throw new Error('--source에 엔진 소스 폴더가 필요합니다');
const vendor = sourceAt < 0 ? path.join(root, 'vendor', 'rhwp') : path.resolve(root, process.argv[sourceAt + 1]);
const studioSrc = path.join(vendor, 'rhwp-studio');
const layer = path.join(root, 'studio');
const pluginDir = path.join(layer, 'plugin');
const outAt = process.argv.indexOf('--out');
const outDir = outAt < 0 ? path.join(layer, 'dist') : path.resolve(root, process.argv[outAt + 1] || '');
if (outAt >= 0 && (!process.argv[outAt + 1] || !outDir.startsWith(path.join(root, 'artifacts') + path.sep) || path.basename(outDir) !== 'studio-dist')) throw new Error('--out은 artifacts 아래의 별도 studio-dist 폴더여야 합니다');
if (sourceAt >= 0 && outAt < 0 && !process.argv.includes('--check')) throw new Error('별도 소스 빌드는 --out artifacts/<작업>/studio-dist로 분리해야 합니다');
const engineAt = process.argv.indexOf('--engine-pkg');
const enginePkg = engineAt < 0 ? path.join(vendor, 'pkg') : path.resolve(root, process.argv[engineAt + 1] || '');
if (engineAt >= 0 && (!process.argv[engineAt + 1] || !enginePkg.startsWith(path.join(root, 'artifacts') + path.sep))) throw new Error('--engine-pkg는 artifacts 아래의 검증용 WASM 패키지여야 합니다');
const staging = outAt < 0 ? path.join(layer, '.build', 'public') : path.join(path.dirname(outDir), 'studio-public');
const checkOnly = process.argv.includes('--check');
const typecheck = process.argv.includes('--typecheck');

function fail(msg) { console.error(`[build-studio] ${msg}`); process.exit(1); }
const posix = (p) => p.replace(/\\/g, '/');

if (!fs.existsSync(path.join(studioSrc, 'src', 'main.ts'))) fail(`vendor 스냅샷이 없습니다: ${studioSrc}`);

const { coworkBuildPlugins, patchesForStudio, verifyPatches } = await import(pathToFileURL(path.join(layer, 'build', 'patches.mjs')).href);
// 판별 패치 선택(0.9.0 원본이면 rhwp090-patches.mjs 덮어쓰기)은 시험 하네스와 같은 함수(patchesForStudio)를 쓴다.
const patches = patchesForStudio(studioSrc);

if (checkOnly) {
  const report = verifyPatches(studioSrc, patches);
  for (const r of report) console.log(`${r.ok ? 'OK ' : 'NG '} ${r.id} — ${r.file}${r.ok ? '' : ' : ' + r.error}`);
  process.exit(report.every((r) => r.ok) ? 0 : 1);
}

if (typecheck) {
  // 빌드와 별개: vendor 스냅샷에 설치된 TypeScript 로 플러그인만 검사한다(vendor 원본 tsconfig 와 같은 엄격도 — studio/plugin/tsconfig.json).
  const tsc = path.join(studioSrc, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) fail('vendor/rhwp/rhwp-studio/node_modules 에 typescript 가 없습니다 — 먼저 node scripts/build-studio.mjs 로 빌드 도구를 설치하세요');
  const t0 = Date.now();
  for (const project of [path.join(pluginDir, 'tsconfig.json'), path.join(layer, 'performance', 'tsconfig.json'), path.join(layer, 'fonts', 'tsconfig.json')]) {
    const r = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) fail(`형 검사 실패 ${path.relative(root, project)}(종료 코드 ${r.status ?? r.signal})`);
  }
  console.log(`[build-studio] 형 검사 통과 ${((Date.now() - t0) / 1000).toFixed(1)}s — studio/plugin + studio/performance + studio/fonts`);
  process.exit(0);
}

if (!fs.existsSync(path.join(enginePkg, 'rhwp_bg.wasm'))) fail('선택한 엔진 패키지에 WASM이 없습니다');

// 빌드 도구는 vendor 스냅샷 안에 설치한다(package-lock 그대로). 없으면 한 번 설치.
const viteEntry = path.join(studioSrc, 'node_modules', 'vite', 'dist', 'node', 'index.js');
if (!fs.existsSync(viteEntry)) {
  console.log('[build-studio] 빌드 도구 설치: npm ci (vendor/rhwp/rhwp-studio)');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: studioSrc, stdio: 'inherit', shell: process.platform === 'win32' });
}
const vite = await import(pathToFileURL(viteEntry).href);

// public 폴더를 임시로 모은다: 스냅샷의 public/fonts 는 Windows 에서 읽을 수 없는 파일형 심볼릭 링크라
// assets/fonts 를 직접 복사한다.
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
// rhwp 아이콘(favicon.ico·icons/)은 빼고 hwpx-cowork 아이콘(web/favicon.ico·web/icons — scripts/make-icons.mjs)을 같은 이름으로 넣는다.
const RHWP_ICONS = new Set(['fonts', 'favicon.ico', 'icons']);
for (const name of fs.readdirSync(path.join(studioSrc, 'public'))) {
  if (RHWP_ICONS.has(name)) continue;
  fs.cpSync(path.join(studioSrc, 'public', name), path.join(staging, name), { recursive: true });
}
// HFT-derived outlines are offline research material, never build/deploy input.
fs.cpSync(path.join(vendor, 'assets', 'fonts'), path.join(staging, 'fonts'), {
  recursive: true, filter: source => path.basename(source).toLowerCase() !== 'hft',
});
for (const name of ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'rhwp_bg.wasm.d.ts']) fs.copyFileSync(path.join(enginePkg, name), path.join(staging, name));
fs.cpSync(path.join(root, 'web', 'favicon.ico'), path.join(staging, 'favicon.ico'));
fs.mkdirSync(path.join(staging, 'icons'));
// 편집기에는 낱장 PNG 만 넣는다(Windows·Mac 앱 아이콘 hwpx-cowork.ico·.icns 는 편집기가 쓰지 않는다)
for (const name of fs.readdirSync(path.join(root, 'web', 'icons')).filter((n) => /^icon-\d+\.png$/.test(n))) fs.cpSync(path.join(root, 'web', 'icons', name), path.join(staging, 'icons', name));
await assertFontDistributionTree(staging);

const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(studioSrc, 'vite.config.ts'), studioSrc);
if (!loaded) fail('vendor vite.config.ts 를 읽지 못했습니다');
const base = loaded.config;

// PWA(서비스 워커)는 뺀다 — 같은 출처에서 개발할 때 옛 빌드를 붙잡아 두는 문제를 막는다.
const vendorPlugins = (base.plugins || []).flat(Infinity).filter(Boolean)
  .filter((p) => !String(p.name || '').startsWith('vite-plugin-pwa'));

// 별칭: 배열 모양(앞에 있는 것이 먼저 맞는다). cowork 별칭을 vendor 별칭('@' 등)보다 앞에 둔다.
//  - '@cowork/studio-plugin' 은 그 이름 그대로만(패치된 main.ts 의 동적 import)
//  - '@cowork/web/*' → web/*(refmap·menumodel·annotations 등 순수 모듈), '@cowork/engine/*' → engine/*(diff.js — 서버와 같은 정렬 규칙)
//    engine/diff.js 가 가져오는 'diff' 패키지는 가져오는 파일 자리에서 찾으므로 이 프로젝트의 node_modules/diff 로 풀린다.
const vendorAlias = base.resolve?.alias || {};
const coworkAlias = [
  { find: /^\.\.\/\.\.\/pkg\/rhwp\.js$/, replacement: posix(path.join(enginePkg, 'rhwp.js')) },
  { find: /^@wasm\/rhwp\.js$/, replacement: posix(path.join(enginePkg, 'rhwp.js')) },
  { find: /^@wasm\/(.+)$/, replacement: `${posix(enginePkg)}/$1` },
  { find: /^@cowork\/studio-plugin$/, replacement: posix(path.join(pluginDir, 'index.ts')) },
  { find: /^@cowork\/performance\/(.+)$/, replacement: `${posix(path.join(layer, 'performance'))}/$1` },
  { find: /^@cowork\/web\/(.+)$/, replacement: `${posix(path.join(root, 'web'))}/$1` },
  { find: /^@cowork\/engine\/(.+)$/, replacement: `${posix(path.join(root, 'engine'))}/$1` },
];
const alias = [
  ...coworkAlias,
  ...(Array.isArray(vendorAlias) ? vendorAlias : Object.entries(vendorAlias).map(([find, replacement]) => ({ find, replacement }))),
];

const externalFonts = process.env.COWORK_STUDIO_EXTERNAL_FONTS === '1';
// [hwpx-cowork] 2026-11-11 옛 Safari(15.0~15.3, macOS Catalina) 보완: 맥 Safari 15.2 에서 편집기가 `Object.hasOwn` 없음으로
// 시작하자마자 멈춰 무한 로딩이 됐다(운영 client-log). 웹 앱과 같은 보완 파일(web/legacy-polyfills.js — '없을 때만' 채움)을
// index.html 맨 앞 일반 스크립트로, 작업자(worker) 청크에는 앞머리로 넣는다. 문법은 묶음 대상(Safari 16.4 기준)이 아니라
// 15.2 에서도 읽히는지 따로 확인했다(acorn es2022 — static 블록·정규식 lookbehind 는 첫 화면 청크에 없음).
const legacyPolyfills = fs.readFileSync(path.join(root, 'web', 'legacy-polyfills.js'), 'utf8');
const legacyPolyfillHtml = {
  name: 'cowork-legacy-polyfills-html',
  transformIndexHtml: () => [{ tag: 'script', children: `\n${legacyPolyfills}\n`, injectTo: 'head-prepend' }],
};
const legacyPolyfillWorker = {
  name: 'cowork-legacy-polyfills-worker',
  renderChunk: (code) => ({ code: `${legacyPolyfills}\n${code}`, map: null }),
};
const baseWorker = base.worker || {};
const baseWorkerPlugins = typeof baseWorker.plugins === 'function' ? baseWorker.plugins : () => (baseWorker.plugins || []);
const config = {
  ...base,
  configFile: false,
  root: studioSrc,
  base: '/studio/',
  publicDir: staging,
  logLevel: 'warn',
  define: {
    ...(base.define || {}),
    // 폐쇄망에서도 열리도록 기본은 번들 글꼴만 쓴다(COWORK_STUDIO_EXTERNAL_FONTS=1 이면 CDN 허용).
    __RHWP_DISABLE_EXTERNAL_WEBFONTS__: JSON.stringify(!externalFonts),
  },
  resolve: {
    ...(base.resolve || {}),
    alias,
  },
  server: undefined,
  plugins: [legacyPolyfillHtml, ...coworkBuildPlugins({ studioSrc, layer, patches }), ...vendorPlugins],
  worker: { ...baseWorker, plugins: () => [legacyPolyfillWorker, ...baseWorkerPlugins()] },
  build: {
    ...(base.build || {}),
    outDir,
    emptyOutDir: true,
    reportCompressedSize: false,
  },
};

const t0 = Date.now();
await vite.build(config);
await assertFontDistributionTree(outDir);
const pluginPkg = (() => { try { return /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(pluginDir, 'types.ts'), 'utf8'))?.[1] ?? null; } catch { return null; } })();
const info = {
  builtAt: new Date().toISOString(),
  enginePackage: path.relative(root, enginePkg),
  source: path.relative(root, vendor),
  upstream: {
    repo: 'edwardkim/rhwp',
    tag: `v${/^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(vendor, 'Cargo.toml'), 'utf8'))?.[1] || 'unknown'}`,
    commit: spawnSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null,
  },
  patches: patches.map((p) => ({ id: p.id, file: p.file, why: p.why })),
  plugin: { id: 'cowork', version: pluginPkg },
  externalFonts,
};
fs.writeFileSync(path.join(outDir, 'cowork-build.json'), JSON.stringify(info, null, 2));
console.log(`[build-studio] 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(root, outDir)} (패치 ${patches.length}개)`);
