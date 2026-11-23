#!/usr/bin/env node
// 개인 서버·편집기·Node를 넣은 macOS .app을 만든다. 개발·운영 폴더는 허용 목록으로 만든 personal-lite에 맡긴다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { MACOS_COMPAT } from '../deploy/macos-compat.mjs';
import { auditMacBinaries } from './macos-binary-audit.mjs';
import { mergeMacApps } from './macos-universal.mjs';
import { auditDesktopProduct } from './desktop-product-audit.mjs';
import { findNpmCli } from '../deploy/portable/common/npm-location.mjs';
import { assertFontDistributionTree, assertFontDistributionZip } from './rhwp-original-font-policy.mjs';
import { RUNNER_PAYLOAD_FILES } from '../deploy/desktop/runners.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
const value = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; };
const out = path.resolve(value('--out', path.join(root, 'artifacts', `personal-macos-${stamp}`)));
const requested = value('--arch', 'universal').split(',');
if (requested.some(arch => !['universal', 'arm64', 'x64'].includes(arch))) throw Error('지원하지 않는 아키텍처');
const archs = requested.includes('universal') ? ['x64', 'arm64'] : requested;
const studioDir = path.resolve(value('--studio-dir', path.join(root, 'studio/dist')));
const enginePkg = path.resolve(value('--engine-pkg', path.join(root, 'vendor/rhwp/pkg')));
const ELECTRON = MACOS_COMPAT.electron; const NODE = MACOS_COMPAT.node; const PACKAGER = '20.3.0';
const version = JSON.parse(fs.readFileSync(path.join(root, 'deploy/desktop/package.json'))).version;
if (!out.startsWith(path.join(root, 'artifacts') + path.sep)) throw Error('출력은 artifacts 아래에 두세요.');
if (process.argv.includes('--refresh') || (fs.existsSync(out) && fs.readdirSync(out).length)) throw Error('이전 앱을 덮어쓰지 않고 새 출력 폴더에 빌드하세요.');
const cache = path.join(os.tmpdir(), 'hwpx-cowork-macos-runtime');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(command)} 실패: ${(r.stderr || r.stdout || r.error?.message || '').slice(-3000)}`);
  return r.stdout;
}
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}: ${url}`); return Buffer.from(await r.arrayBuffer()); }
async function verified(url, hash) {
  const file = path.join(cache, url.split('/').pop());
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === hash) return file;
  const bytes = await get(url); if (sha(bytes) !== hash) throw new Error('공식 SHA-256 불일치: ' + url);
  fs.writeFileSync(file, bytes); return file;
}
function put(file, bytes, mode = 0o644) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode }); }
async function extractZip(file, destination, filter = () => true) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const e of Object.values(zip.files)) {
    if (e.dir || !filter(e.name)) continue;
    const dst = path.resolve(destination, e.name);
    if (!dst.startsWith(path.resolve(destination) + path.sep)) throw new Error('안전하지 않은 ZIP 경로');
    put(dst, await e.async('nodebuffer'), (e.unixPermissions || 0o644) & 0o777);
  }
}
function nodeFiles(file, destination) {
  const bytes = gunzipSync(fs.readFileSync(file));
  for (let at = 0; at + 512 < bytes.length;) {
    const h = bytes.subarray(at, at + 512); if (h.every(b => b === 0)) break;
    const text = (start, length) => h.subarray(start, start + length).toString().replace(/\0.*$/, '');
    const name = text(0, 100); const prefix = text(345, 155);
    const full = prefix ? prefix + '/' + name : name;
    const size = parseInt(text(124, 12).trim() || '0', 8); const mode = parseInt(text(100, 8).trim() || '644', 8);
    const rel = full.replace(/^[^/]+\//, '');
    if ((h[156] === 0 || h[156] === 48) && (rel === 'bin/node' || rel.startsWith('lib/node_modules/npm/') || rel === 'LICENSE')) {
      const dst = path.resolve(destination, rel);
      if (!dst.startsWith(path.resolve(destination) + path.sep)) throw new Error('안전하지 않은 tar 경로');
      put(dst, bytes.subarray(at + 512, at + 512 + size), mode & 0o777);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (!fs.existsSync(path.join(destination, 'bin/node')) || !fs.existsSync(path.join(destination, 'lib/node_modules/npm/bin/npm-cli.js'))) throw new Error('Node 또는 npm 누락');
}
function tree(dir) {
  const entries = [];
  const visit = (rel = '') => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name; const file = path.join(dir, name); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) entries.push({ name, link: fs.readlinkSync(file).replaceAll('\\', '/'), mode: 0o120777 });
    else if (stat.isDirectory()) visit(name);
    else {
      // Windows에서는 stat.mode에 POSIX 실행 비트가 없으므로 Mach-O·shebang 형식으로 결정한다.
      const head = Buffer.alloc(4); const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
      const macho = ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(head.toString('hex'));
      const executable = macho || head.subarray(0, 2).toString() === '#!';
      entries.push({ name, file, mode: executable ? 0o100755 : 0o100644 });
    }
  } };
  visit(); return entries;
}
async function archiveApp(appDir, file, readme, metadata) {
  const zip = new JSZip();
  for (const e of tree(appDir)) zip.file(`Hwpx Cowork.app/${e.name}`, e.link ?? fs.readFileSync(e.file), { unixPermissions: e.mode, createFolders: true });
  zip.file('먼저 읽어주세요.txt', '\ufeff' + readme, { unixPermissions: 0o100644 });
  zip.file('BUILD-INFO.json', JSON.stringify(metadata, null, 2) + '\n', { unixPermissions: 0o100644 });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await assertFontDistributionZip(bytes);
  fs.writeFileSync(file, bytes); return { bytes: bytes.length, sha256: sha(bytes), files: Object.values(zip.files).filter(e => !e.dir).length };
}
const tools = path.resolve(value('--tools', path.join(out, 'tools')));
if (!fs.existsSync(path.join(tools, 'node_modules/@electron/packager/package.json'))) {
  console.log('패키징 도구 준비…');
  run(process.execPath, [findNpmCli(), 'install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', `@electron/packager@${PACKAGER}`], { stdio: 'inherit' });
}
const requireTools = createRequire(path.join(tools, 'package.json'));
const { packager } = await import(pathToFileURL(requireTools.resolve('@electron/packager')).href);
// Freeze the host sources once: parallel work must not produce two architectures
// with different application code and consequently different ASAR integrity keys.
const desktopSource = path.join(out, 'desktop-source');
fs.cpSync(path.join(root, 'deploy/desktop'), desktopSource, { recursive: true, errorOnExist: true, force: false });
const stage = path.join(out, 'payload-source');
const inputs = [...(process.argv.includes('--studio-dir') ? ['--studio-dir', studioDir] : []), ...(process.argv.includes('--engine-pkg') ? ['--engine-pkg', enginePkg] : [])];
if (!fs.existsSync(path.join(stage, 'release.json'))) run(process.execPath, ['scripts/package-portable.mjs', '--target', 'personal-lite', '--out', stage, ...inputs], { stdio: 'inherit' });
const p = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'))).packages[0];
const payloadDir = path.join(out, 'payload');
if (!fs.existsSync(path.join(payloadDir, 'app/server/index.js'))) {
  const extracted = path.join(out, 'extracted');
  await extractZip(path.join(stage, p.file), extracted, name => name.startsWith('hwpx-cowork-personal/app/'));
  fs.renameSync(path.join(extracted, 'hwpx-cowork-personal'), payloadDir);
}
// 원래 personal-lite가 제공한 엔진·글꼴·npm의 원문 고지도 앱 안에 함께 넣는다.
const payloadZip = await JSZip.loadAsync(fs.readFileSync(path.join(stage, p.file)));
for (const e of Object.values(payloadZip.files)) if (!e.dir && e.name.startsWith('hwpx-cowork-personal/NOTICES/')) {
  put(path.join(payloadDir, e.name.slice('hwpx-cowork-personal/'.length)), await e.async('nodebuffer'));
}
// CLI 실행기 공통 경로를 그대로 쓰고, 데스크톱 로그인 보조 모듈만 추가한다.
fs.copyFileSync(path.join(root, 'scripts/setup-worker.mjs'), path.join(payloadDir, 'app/scripts/setup-worker.mjs'));
fs.copyFileSync(path.join(root, 'deploy/portable/personal.mjs'), path.join(payloadDir, 'app/portable/personal.mjs'));
put(path.join(payloadDir, 'app/scripts/desktop-ai.mjs'), fs.readFileSync(path.join(root, 'deploy/desktop/desktop-ai.mjs'), 'utf8').replaceAll("'../../server/", "'../server/"));
fs.copyFileSync(path.join(root, 'deploy/desktop/cli-versions.mjs'), path.join(payloadDir, 'app/scripts/cli-versions.mjs'));
for (const name of ['release-downloads.js', 'download-page.js', 'download-page.css']) fs.copyFileSync(path.join(root, 'server', name), path.join(payloadDir, 'app/server', name));
fs.cpSync(path.join(root, 'web/icons/download'), path.join(payloadDir, 'app/web/icons/download'), { recursive: true });
// AI 실행기 창(deploy/desktop/runners.mjs — Windows 앱과 같은 main.mjs)이 띄우는 실행기 파일
for (const need of RUNNER_PAYLOAD_FILES) if (!fs.existsSync(path.join(payloadDir, 'app', need))) throw new Error('앱 묶음에 실행기 파일이 없습니다: ' + need);
const productAudit = auditDesktopProduct({ payload: path.join(payloadDir, 'app'), studioDir, enginePkg, root });
await assertFontDistributionTree(path.join(payloadDir, 'app'));
put(path.join(payloadDir, 'desktop-product.json'), JSON.stringify(productAudit, null, 2) + '\n');
put(path.join(out, 'desktop-product.json'), JSON.stringify(productAudit, null, 2) + '\n');
const icon = path.join(out, 'app.icns');   // scripts/make-icons.mjs 가 만든 Mac 아이콘(16~1024px)
if (!fs.existsSync(icon)) fs.copyFileSync(path.join(root, 'web/icons/hwpx-cowork.icns'), icon);
const nodeBase = `https://nodejs.org/dist/v${NODE}/`;
const sums = (await get(nodeBase + 'SHASUMS256.txt')).toString();
const signerName = 'apple-codesign-0.29.0-x86_64-pc-windows-msvc.zip';
const signerBase = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/';
const signerHash = (await get(signerBase + signerName + '.sha256')).toString().trim().split(/\s+/)[0];
const signerArchive = await verified(signerBase + signerName, signerHash);
const signerDir = path.join(out, 'signer');
await extractZip(signerArchive, signerDir, name => name.endsWith('rcodesign.exe'));
const signerEntry = tree(signerDir).find(e => e.name.endsWith('rcodesign.exe'));
const signer = signerEntry?.file;
if (!signer) throw new Error('rcodesign 누락');
const entitlements = path.join(out, 'entitlements.plist');
put(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>');
const result = [];
const bundles = new Map(), runtimeHashes = {};
for (const arch of archs) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('지원하지 않는 CPU: ' + arch);
  console.log(`macOS ${arch}: 내장 런타임·앱 준비…`);
  const name = `node-v${NODE}-darwin-${arch}.tar.gz`;
  const hash = sums.split('\n').find(l => l.endsWith('  ' + name))?.split('  ')[0];
  if (!hash) throw new Error('공식 Node 체크섬 누락');
  runtimeHashes[arch] = hash;
  const nodeArchive = await verified(nodeBase + name, hash);
  const runtime = path.join(out, 'runtime-' + arch, 'runtime');
  if (!fs.existsSync(path.join(runtime, 'bin/node'))) nodeFiles(nodeArchive, runtime);
  const appOut = path.join(out, 'apps-' + arch);
  const appDir = path.join(appOut, `Hwpx Cowork-darwin-${arch}`, 'Hwpx Cowork.app');
  await packager({ dir: desktopSource, name: 'Hwpx Cowork', executableName: 'Hwpx Cowork', appBundleId: 'kr.hwpx.cowork.personal', appVersion: version, buildVersion: version, platform: 'darwin', arch, electronVersion: ELECTRON, out: appOut, overwrite: false, prune: false, asar: true, icon, extraResource: [payloadDir, runtime], extendInfo: { NSHighResolutionCapable: true, NSDocumentsFolderUsageDescription: '선택한 폴더의 한글 문서를 열고 저장합니다.', NSDownloadsFolderUsageDescription: '선택한 한글 문서를 열고 저장합니다.' } });
  const { downloadArtifact } = await import(pathToFileURL(requireTools.resolve('@electron/get')).href);
  const electronFile = await downloadArtifact({ version: ELECTRON, artifactName: 'electron', platform: 'darwin', arch });
  const electronZip = await JSZip.loadAsync(fs.readFileSync(electronFile));
  for (const [from, to] of [['LICENSE', 'Electron-LICENSE.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const entry = electronZip.file(from); if (!entry) throw new Error('Electron 원문 고지 누락: ' + from);
    put(path.join(appDir, 'Contents/Resources/NOTICES', to), await entry.async('nodebuffer'));
  }
  const plist = requireTools('plist');
  const infoFile = path.join(appDir, 'Contents/Info.plist');
  const appInfo = plist.parse(fs.readFileSync(infoFile, 'utf8'));
  const header = requireTools('@electron/asar').getRawHeader(path.join(appDir, 'Contents/Resources/app.asar')).headerString;
  appInfo.ElectronAsarIntegrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: sha(header) } };
  put(infoFile, plist.build(appInfo));
  auditMacBinaries(appDir, { arch, target: MACOS_COMPAT.target });
  bundles.set(arch, appDir);
}
if (requested.includes('universal')) {
  const appDir = path.join(out, 'apps-universal/Hwpx Cowork.app');
  const merged = mergeMacApps({ x64App: bundles.get('x64'), arm64App: bundles.get('arm64'), outApp: appDir, signer, target: MACOS_COMPAT.target });
  put(path.join(out, 'universal-merge.json'), JSON.stringify(merged, null, 2) + '\n');
  bundles.set('universal', appDir);
}
for (const arch of requested) {
  const appDir = bundles.get(arch);
  const minimumMacos = fs.readFileSync(path.join(appDir, 'Contents/Info.plist'), 'utf8').match(/<key>LSMinimumSystemVersion<\/key>\s*<string>(.*?)<\/string>/)?.[1];
  if (minimumMacos !== MACOS_COMPAT.minimum) throw new Error('상위 앱의 최소 macOS가 달라졌습니다. 지원 안내를 다시 확인하세요: ' + minimumMacos);
  const binaryAudit = auditMacBinaries(appDir, { arch, target: MACOS_COMPAT.target });
  put(path.join(out, `binary-audit-personal-${arch}.json`), JSON.stringify(binaryAudit, null, 2));
  console.log(`macOS ${arch}: 실행 파일 ad-hoc 서명…`);
  run(signer, ['sign', '--entitlements-xml-file', `*: ${entitlements}`.replace('*: ', '*:'), appDir], { maxBuffer: 16 * 1024 * 1024 });
  const file = `hwpx-cowork-server-${version}-${stamp}-macos-${arch}-app.zip`;
  const wasmSha256 = sha(fs.readFileSync(path.join(payloadDir, 'app/vendor/rhwp/pkg/rhwp_bg.wasm')));
  const info = { product: 'Hwpx Cowork 개인용 서버 앱', version, revision: `${stamp}-full-cowork-universal`, platform: 'darwin', arch, minimumMacos, targetMacos: MACOS_COMPAT.target, binaryAuditCount: binaryAudit.binaries.length, electron: ELECTRON, node: NODE, nodeArchiveSha256: arch === 'universal' ? runtimeHashes : runtimeHashes[arch], architectures: arch === 'universal' ? ['x64', 'arm64'] : [arch], coworkPlugin: true, webPatchCount: productAudit.editorPatches.length, frontend: 'full-web-product', wasmSha256, signing: 'ad-hoc (not Developer ID, not notarized)', signer: 'apple-codesign 0.29.0', builtAt: new Date().toISOString(), realMacTested: false };
  const readme = `Hwpx Cowork 개인용 앱\r\n\r\n1. ZIP을 풉니다.\r\n2. Hwpx Cowork.app을 더블클릭합니다. 개인 서버와 편집기가 함께 열립니다.\r\n\r\n별도 Node 설치·터미널 명령·서버 주소·로그인 토큰 입력이 필요 없습니다.\r\n문서 폴더 연결: 앱 메뉴 [파일 → 문서 폴더 연결].\r\nmacOS 12에서는 문서 편집과 개인 서버를 사용할 수 있습니다. 구독 AI 연결은 macOS 13 이상에서 지원하며, 해당 OS의 [AI → 실행기 관리]에서 실행기를 추가하고 켜면 본인 계정으로 로그인합니다(인터넷 필요).\r\n앱을 종료하면 이 앱의 개인 서버도 저장을 마친 뒤 종료합니다.\r\n설정·문서 기록은 사용자 Library/Application Support/Hwpx Cowork/personal에 보존됩니다.\r\n\r\nmacOS 12.1 이상(13·14 포함), ${arch === 'universal' ? 'Intel·Apple Silicon 공용' : arch === 'arm64' ? 'Apple Silicon(M1 이후)' : 'Intel'}용입니다.\r\n이 배포본은 개발자 ID 서명·Apple 공증을 받지 않았습니다. macOS가 실행을 막으면 시스템 설정 → 개인정보 보호 및 보안에서 이 앱의 ‘확인 없이 열기’를 확인하세요. 보안 기능을 끄거나 터미널 명령으로 우회할 필요는 없습니다.\r\n실제 Mac 실행·Gatekeeper 통과는 아직 검증하지 못했습니다.\r\n`;
  const archived = await archiveApp(appDir, path.join(out, file), readme, info);
  result.push({ target: `personal-macos-${arch}`, file, ...archived, title: `Mac 개인용 서버 앱 · ${arch === 'universal' ? 'Intel·Apple Silicon 공용' : arch === 'arm64' ? 'Apple Silicon(M1 이후)' : 'Intel'} · macOS 12.1 이상`, downloadUrl: `https://github.com/nagmint12/hwpxcowork/releases/latest/download/${file}`, ...info });
  fs.writeFileSync(path.join(out, 'macos-apps.json'), JSON.stringify({ version, packages: result }, null, 2) + '\n');
  console.log(`${file}: ${archived.bytes} bytes / ${archived.sha256}`);
}
