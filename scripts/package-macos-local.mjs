#!/usr/bin/env node
// 서버 없는 로컬 편집기. 기본은 Intel + Apple Silicon 공용 앱 한 개/ZIP 한 개.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { findNpmCli } from '../deploy/portable/common/npm-location.mjs';
import { assertFontDistributionTree, assertFontDistributionZip } from './rhwp-original-font-policy.mjs';
import { MACOS_COMPAT } from '../deploy/macos-compat.mjs';
import { auditMacBinaries } from './macos-binary-audit.mjs';
import { mergeMacApps } from './macos-universal.mjs';
import { STANDALONE_EDITOR_PATCHES } from '../studio/build/standalone-editor-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
const opt = (key, fallback) => {
  const at = process.argv.indexOf(key);
  if (at < 0) return fallback;
  if (!process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw Error('Missing value: ' + key);
  return process.argv[at + 1];
};
const version = JSON.parse(fs.readFileSync(path.join(root, 'deploy/local-editor/package.json'))).version;
const out = path.resolve(opt('--out', path.join(root, `artifacts/local-editor-${stamp}-v${version}`)));
const requested = opt('--arch', 'universal').split(',');
if (new Set(requested).size !== requested.length || requested.some(a => !['universal', 'x64', 'arm64'].includes(a))
  || (requested.includes('universal') && requested.length !== 1)) throw Error('Use --arch universal, arm64, x64 or arm64,x64');
// Refresh used to create app.asar over an older unpacked app and stale Info.plist.
// A release must be a fresh bundle. Preserve all previous candidates/evidence.
if (process.argv.includes('--refresh')) throw Error('--refresh 대신 새 --out 폴더를 사용하세요. 이전 앱/서명/버전을 재사용하지 않습니다.');
const reuseApps = process.argv.includes('--reuse-apps');
if (reuseApps && !process.argv.includes('--reuse-web')) throw Error('--reuse-apps에는 --reuse-web도 필요합니다.');
for (const name of [...(reuseApps ? [] : ['apps-arm64', 'apps-x64']), 'apps-universal', 'macos-local.json']) {
  if (fs.existsSync(path.join(out, name))) throw Error('출력에 이전 앱이 있습니다. 새 --out 폴더를 사용하세요: ' + out);
}
const universal = requested[0] === 'universal';
const archs = universal ? ['x64', 'arm64'] : requested;
const tools = path.join(root, 'artifacts/macos-packaging-tools');
const electron = MACOS_COMPAT.electron;
const source = path.join(root, 'deploy/local-editor');
const editor = path.join(out, 'editor');
const enginePkg = path.resolve(opt('--engine-pkg', path.join(root, 'vendor/rhwp/pkg')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(file, args, extra = {}) {
  const result = spawnSync(file, args, { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...extra });
  if (result.error || result.status !== 0) throw Error((result.stderr || result.stdout || result.error?.message || '').slice(-3000));
  return result.stdout;
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
async function get(url) { const r = await fetch(url); if (!r.ok) throw Error(`${r.status}: ${url}`); return Buffer.from(await r.arrayBuffer()); }
function entries(dir) {
  const result = [];
  const visit = (rel = '') => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name; const file = path.join(dir, name);
      if (entry.isSymbolicLink()) result.push({ name, value: fs.readlinkSync(file).replaceAll('\\', '/'), mode: 0o120777 });
      else if (entry.isDirectory()) visit(name);
      else {
        const head = Buffer.alloc(4); const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
        const executable = ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(head.toString('hex')) || head.subarray(0, 2).toString() === '#!';
        result.push({ name, file, mode: executable ? 0o100755 : 0o100644 });
      }
    }
  };
  visit(); return result;
}

fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(tools, 'node_modules/@electron/packager/package.json'))) {
  run(process.execPath, [findNpmCli(), 'install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', '@electron/packager@20.3.0'], { stdio: 'inherit' });
}
const req = createRequire(path.join(tools, 'package.json'));
const { packager } = await import(pathToFileURL(req.resolve('@electron/packager')).href);
const { downloadArtifact } = await import(pathToFileURL(req.resolve('@electron/get')).href);
if (!process.argv.includes('--reuse-web')) {
  const engineArgs = process.argv.includes('--engine-pkg') ? ['--engine-pkg', enginePkg] : [];
  run(process.execPath, ['mobile-rhwp/scripts/build-web.mjs', '--desktop', '--out', editor, ...engineArgs], { stdio: 'inherit' });
}
const engine = JSON.parse(fs.readFileSync(path.join(editor, 'local-build.json')));
const wasmSha256 = sha(fs.readFileSync(path.join(enginePkg, 'rhwp_bg.wasm')));
if (engine.version !== version || engine.engineSha256 !== wasmSha256) throw Error('편집기 버전/WASM이 후보와 다릅니다. --reuse-web 없이 다시 빌드하세요.');
if (STANDALONE_EDITOR_PATCHES.some(p => !engine.editorPatches?.includes(p.id))) throw Error('웹과 공통인 입력/글꼴 패치가 누락됐습니다.');
const wasmAssets = entries(editor).filter(e => e.name.endsWith('.wasm') && sha(fs.readFileSync(e.file)) === wasmSha256);
if (wasmAssets.length !== 1) throw Error('실제로 포함된 문서 WASM이 원본과 같고 한 개여야 합니다.');
await assertFontDistributionTree(editor);

const signerDir = path.join(tools, 'signer');
let signer = opt('--signer', process.platform === 'win32'
  ? (fs.existsSync(signerDir) ? entries(signerDir).find(e => e.name.endsWith('rcodesign.exe'))?.file : undefined)
  : 'rcodesign');
if (!signer) {
  const base = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/';
  const name = 'apple-codesign-0.29.0-x86_64-pc-windows-msvc.zip';
  const [bytes, checksum] = await Promise.all([get(base + name), get(base + name + '.sha256')]);
  if (sha(bytes) !== checksum.toString().trim().split(/\s+/)[0]) throw Error('서명 도구 체크섬 불일치');
  const zip = await JSZip.loadAsync(bytes);
  for (const e of Object.values(zip.files)) if (!e.dir && e.name.endsWith('rcodesign.exe')) {
    const dst = path.resolve(signerDir, e.name);
    if (!dst.startsWith(signerDir + path.sep)) throw Error('잘못된 도구 경로');
    put(dst, await e.async('nodebuffer')); signer = dst;
  }
}
if (!signer) throw Error('rcodesign을 찾지 못했습니다. --signer <경로>로 지정하세요.');
run(signer, ['--version']);
// Mac 아이콘(16~1024px, macOS 격자 824/1024) — scripts/make-icons.mjs 가 원본 icon/hwpx-cowork.png 로 만든 것
const icon = path.join(out, 'editor.icns');
fs.copyFileSync(path.join(root, 'web/icons/hwpx-cowork.icns'), icon);
const entitlements = path.join(out, 'entitlements.plist');
put(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>');

const bundles = new Map();
for (const arch of archs) {
  const appOut = path.join(out, `apps-${arch}`);
  const bundle = path.join(appOut, `Hwpx Editor-darwin-${arch}/Hwpx Editor.app`);
  console.log(`로컬 편집기 ${arch}: 동일한 편집기/WASM으로 앱 준비`);
  if (reuseApps) {
    const asar = req('@electron/asar');
    const archive = path.join(bundle, 'Contents/Resources/app.asar');
    const expected = entries(source);
    const archived = asar.listPackage(archive).filter(name => !asar.statFile(archive, name.replace(/^[/\\]/, '')).files);
    const sameSource = e => {
      if (e.value !== undefined) return false;
      const actual = asar.extractFile(archive, e.name), input = fs.readFileSync(e.file);
      // Electron Packager removes private from the packaged package.json.
      if (e.name === 'package.json') {
        const expectedPackage = JSON.parse(input); delete expectedPackage.private;
        return JSON.stringify(JSON.parse(actual)) === JSON.stringify(expectedPackage);
      }
      return sha(actual) === sha(input);
    };
    if (archived.length !== expected.length || !expected.every(sameSource)) {
      throw Error('이전 앱 코드가 현재 소스와 다릅니다. 새 출력에 빌드하세요.');
    }
    const embedded = path.join(bundle, 'Contents/Resources/editor');
    const webFiles = entries(editor);
    if (entries(embedded).length !== webFiles.length || webFiles.some(e => e.value !== undefined || sha(fs.readFileSync(path.join(embedded, e.name))) !== sha(fs.readFileSync(e.file)))) {
      throw Error('이전 앱의 편집기/WASM 자산이 현재 후보와 다릅니다.');
    }
    const appPlist = fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8');
    const runtimePlist = fs.readFileSync(path.join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'), 'utf8');
    const plistVersion = text => text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(.*?)<\/string>/)?.[1];
    const runtimeVersion = runtimePlist.match(/<key>CFBundleVersion<\/key>\s*<string>(.*?)<\/string>/)?.[1];
    if (plistVersion(appPlist) !== version || runtimeVersion !== electron) throw Error('이전 앱/런타임 버전 불일치');
  } else {
  await packager({ dir: source, name: 'Hwpx Editor', executableName: 'Hwpx Editor', appBundleId: 'kr.hwpx.editor.local',
    appVersion: version, buildVersion: version, platform: 'darwin', arch, electronVersion: electron, out: appOut,
    overwrite: false, prune: false, asar: true, icon, extraResource: [editor],
    extendInfo: { NSHighResolutionCapable: true, NSDocumentsFolderUsageDescription: '선택한 한글 문서를 열고 저장합니다.',
      NSDownloadsFolderUsageDescription: '선택한 한글 문서를 열고 저장합니다.',
      CFBundleDocumentTypes: [{ CFBundleTypeName: '한글 문서', CFBundleTypeExtensions: ['hwp', 'hwpx', 'hml'], CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate' }] } });
  const origin = await JSZip.loadAsync(fs.readFileSync(await downloadArtifact({ version: electron, artifactName: 'electron', platform: 'darwin', arch })));
  for (const [from, to] of [['LICENSE', 'Electron-LICENSE.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    put(path.join(bundle, 'Contents/Resources/NOTICES', to), await origin.file(from).async('nodebuffer'));
  }
  }
  // 편집기 화면은 한국어뿐이다. Chromium 메뉴·대화 상자 번역은 한국어·영어(기본 대체)만 남긴다(2026-11-16: 약 45MB 줄임).
  if (!reuseApps) {
    const localeDir = path.join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources');
    const kept = [];
    for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
      if (/^(ko|en)(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/.test(entry.name)) kept.push(entry.name);
      else fs.rmSync(path.join(localeDir, entry.name), { recursive: true, force: true });
    }
    if (!kept.includes('ko.lproj') || !kept.includes('en.lproj')) throw Error('Chromium 한국어·영어 번역 폴더를 찾지 못했습니다.');
  }
  // Electron Packager on Windows writes a Windows temporary path as the ASAR
  // integrity key. macOS expects a path relative to Contents with POSIX slashes.
  // Hash the actual ASAR header, as @electron/universal does, before signing.
  const plistApi = req('plist');
  const appInfoFile = path.join(bundle, 'Contents/Info.plist');
  const appInfo = plistApi.parse(fs.readFileSync(appInfoFile, 'utf8'));
  const header = req('@electron/asar').getRawHeader(path.join(bundle, 'Contents/Resources/app.asar')).headerString;
  appInfo.ElectronAsarIntegrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: sha(header) } };
  put(appInfoFile, plistApi.build(appInfo));
  auditMacBinaries(bundle, { arch, target: MACOS_COMPAT.target });
  bundles.set(arch, bundle);
}
if (universal) {
  console.log('Intel + Apple Silicon: Universal 앱 하나로 병합');
  const bundle = path.join(out, 'apps-universal/Hwpx Editor.app');
  const report = mergeMacApps({ x64App: bundles.get('x64'), arm64App: bundles.get('arm64'), outApp: bundle, signer, target: MACOS_COMPAT.target });
  put(path.join(out, 'universal-merge.json'), JSON.stringify(report, null, 2) + '\n');
  bundles.set('universal', bundle);
}
const packages = [];
for (const arch of requested) {
  const bundle = bundles.get(arch);
  const plist = fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8');
  const minimumMacos = plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>(.*?)<\/string>/)?.[1];
  if (minimumMacos !== MACOS_COMPAT.minimum) throw Error('최소 OS 안내를 다시 확인하세요: ' + minimumMacos);
  console.log(`로컬 편집기 ${arch}: 최종 앱 ad-hoc 서명`);
  run(signer, ['sign', '--entitlements-xml-file', '*:' + entitlements, bundle]);
  const binaryAudit = auditMacBinaries(bundle, { arch, target: MACOS_COMPAT.target });
  put(path.join(out, `binary-audit-local-${arch}.json`), JSON.stringify(binaryAudit, null, 2) + '\n');
  const info = { product: 'Hwpx Editor 로컬 편집기', version, arch, architectures: arch === 'universal' ? ['x64', 'arm64'] : [arch],
    revision: `${stamp}-local-editor-universal-input`, serverRequired: false, save: 'opened-local-file',
    minimumMacos, targetMacos: MACOS_COMPAT.target, binaryAuditCount: binaryAudit.binaries.length, electron,
    wasmSha256, wasmAsset: wasmAssets[0].name, editorPatches: engine.editorPatches,
    signing: 'ad-hoc; not Developer ID or notarized', realMacTested: false, builtAt: new Date().toISOString() };
  const cpu = arch === 'universal' ? 'Intel·Apple Silicon 공용' : arch === 'arm64' ? 'Apple Silicon' : 'Intel';
  const zip = new JSZip();
  for (const e of entries(bundle)) zip.file(`Hwpx Editor.app/${e.name}`, e.value ?? fs.readFileSync(e.file), { unixPermissions: e.mode });
  zip.file('BUILD-INFO.json', JSON.stringify(info, null, 2) + '\n', { unixPermissions: 0o100644 });
  zip.file('설치 안내.txt', String.fromCharCode(0xfeff) + [
    'Hwpx Editor (Mac) 설치 안내', '',
    'HWP·HWPX·HML 문서를 열어 고치고 원래 파일에 저장합니다. 서버·계정·인터넷 없이 동작합니다.', '',
    '필요한 것: macOS 12.1 이상 (' + cpu + ')', '',
    '설치',
    '1. ZIP을 더블클릭해 풀고 Hwpx Editor.app을 [응용 프로그램] 폴더로 옮깁니다.',
    '2. 처음 열 때: Hwpx Editor.app을 Control-클릭(또는 오른쪽 클릭) → [열기] → 확인 창에서 [열기].',
    '   (Apple 공증을 받지 않은 앱이라 첫 실행만 이렇게 엽니다. 다음부터는 더블클릭으로 열립니다.)', '',
    '사용',
    '- 파일 → 열기(⌘O), 또는 Finder에서 문서를 Control-클릭 → [다음으로 열기] → Hwpx Editor',
    '- 저장(⌘S): 열었던 파일에 저장 / 다른 이름으로 저장(⇧⌘S): 새 위치·HWP 또는 HWPX 형식 선택',
    '- 인쇄(⌘P)',
    '- 다른 프로그램이 그 사이 파일을 바꿨으면 덮어쓰지 않고 알려 줍니다. 다시 열거나 다른 이름으로 저장합니다.',
    '- 저장하지 않고 창을 닫으면 확인 창이 나옵니다.', '',
  ].join('\r\n'), { unixPermissions: 0o100644 });
  console.log(`로컬 편집기 ${arch}: 배포 ZIP 압축`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await assertFontDistributionZip(bytes);
    const file = `hwpx-cowork-macos-editor-${arch === 'universal' ? '' : arch + '-'}${version}-${stamp}.zip`;
  put(path.join(out, file), bytes);
  packages.push({ target: `local-editor-macos-${arch}`, file, bytes: bytes.length, sha256: sha(bytes),
    title: `Hwpx Editor (Mac) · ${cpu} · macOS 12.1 이상`, ...info });
  put(path.join(out, 'macos-local.json'), JSON.stringify({ version, packages }, null, 2) + '\n');
  console.log(`${file}: ${bytes.length} bytes / ${sha(bytes)}`);
}
