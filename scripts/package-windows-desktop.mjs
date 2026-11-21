#!/usr/bin/env node
// Windows 데스크톱 앱(Hwpx Cowork)과 설치 프로그램(setup.exe)을 만든다(2026-11-17).
// 아무것도 모르는 사용자가 클릭으로 설치하는 길 — 설치 마법사(NSIS) → 바탕화면·시작 메뉴 아이콘 → 앱 창에서 편집기·AI 연결.
//   앱 = deploy/desktop(Electron 창) + personal-lite 묶음(서버·편집기·npm 모듈 포함) + 공식 Node(Windows x64 — 서버 실행·AI CLI 설치용)
//   설치 = 사용자 폴더(%LOCALAPPDATA%\Programs\Hwpx Cowork) — 관리자 권한 없음. 제거는 설정 → 앱. 설정·문서 기록은 %APPDATA%\Hwpx Cowork 에 남는다.
//   코드 서명 인증서가 없다(사용자 결정 2026-11-17) — 첫 실행 때 SmartScreen 'Windows의 PC 보호' 가 뜨면 [추가 정보] → [실행] 으로 안내한다.
//
//   node scripts/package-windows-desktop.mjs [--out artifacts/windows-desktop-<날짜>] [--tools <패키징 도구 폴더>]
//                                            [--studio-dir <studio dist>] [--engine-pkg <rhwp pkg>]
// 몇 분 걸린다 — 띄운 뒤 scripts/cpu-cap.ps1 로 상한을 건다. 출력은 artifacts 아래 새 폴더에만 만든다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { MACOS_COMPAT } from '../deploy/macos-compat.mjs';
import { auditDesktopProduct } from './desktop-product-audit.mjs';
import { findNpmCli } from '../deploy/portable/common/npm-location.mjs';
import { assertFontDistributionTree } from './rhwp-original-font-policy.mjs';
import { RUNNER_PAYLOAD_FILES } from '../deploy/desktop/runners.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
const value = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; };
const out = path.resolve(value('--out', path.join(root, 'artifacts', `windows-desktop-${stamp}`)));
const studioDir = path.resolve(value('--studio-dir', path.join(root, 'studio/dist')));
const enginePkg = path.resolve(value('--engine-pkg', path.join(root, 'vendor/rhwp/pkg')));
// Electron 은 Mac 앱과 같은 판(43.8.10 — Windows 에서 tests/local_editor_electron.mjs 로 확인한 판), Node 는 Windows 설치 묶음과 같은 판
const ELECTRON = MACOS_COMPAT.electron; const NODE = '24.22.2'; const PACKAGER = '20.3.0'; const BUILDER = '26.18.0';
const version = JSON.parse(fs.readFileSync(path.join(root, 'deploy/desktop/package.json'))).version;
if (!out.startsWith(path.join(root, 'artifacts') + path.sep)) throw Error('출력은 artifacts 아래에 두세요.');
if (fs.existsSync(out) && fs.readdirSync(out).length) throw Error('이전 결과를 덮어쓰지 않고 새 출력 폴더에 빌드하세요.');
fs.mkdirSync(out, { recursive: true });
const cache = path.join(os.tmpdir(), 'hwpx-cowork-windows-runtime'); fs.mkdirSync(cache, { recursive: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const log = (text) => console.log(`[windows-desktop] ${text}`);
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
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
async function extractZip(file, destination, filter = () => true, rename = (n) => n) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const e of Object.values(zip.files)) {
    if (e.dir || !filter(e.name)) continue;
    const dst = path.resolve(destination, rename(e.name));
    if (!dst.startsWith(path.resolve(destination) + path.sep)) throw new Error('안전하지 않은 ZIP 경로');
    put(dst, await e.async('nodebuffer'));
  }
}

// ── 1. 패키징 도구(@electron/packager, electron-builder) — 정한 판만 ──
const tools = path.resolve(value('--tools', path.join(out, 'tools')));
const requireTools = createRequire(path.join(tools, 'package.json'));
const have = (name, wanted) => { try { return JSON.parse(fs.readFileSync(requireTools.resolve(`${name}/package.json`), 'utf8')).version === wanted; } catch { return false; } };
if (!have('@electron/packager', PACKAGER) || !have('electron-builder', BUILDER)) {
  log('패키징 도구 준비…');
  fs.mkdirSync(tools, { recursive: true });
  run(process.execPath, [findNpmCli(), 'install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', `@electron/packager@${PACKAGER}`, `electron-builder@${BUILDER}`], { stdio: 'inherit' });
}
const { packager } = await import(pathToFileURL(requireTools.resolve('@electron/packager')).href);
const builder = requireTools('electron-builder');

// ── 2. 앱 코드(deploy/desktop)를 한 번 고정해 쓴다 ──
const desktopSource = path.join(out, 'desktop-source');
fs.cpSync(path.join(root, 'deploy/desktop'), desktopSource, { recursive: true, errorOnExist: true, force: false });
// AI 실행기 창(2026-11-17 — 실행기 bat 을 대신한다): 창·관리 코드가 빠지면 메뉴 [AI → 실행기 관리]가 빈 창이 된다
for (const need of ['main.mjs', 'host.mjs', 'runners.mjs', 'runners.html', 'runners.js', 'runners.css', 'preload.cjs', 'mode.mjs', 'desktop-ai.mjs', 'cli-versions.mjs']) {
  if (!fs.existsSync(path.join(desktopSource, need))) throw new Error('앱 코드에 빠진 파일: deploy/desktop/' + need);
}

// ── 3. 서버·편집기 묶음(personal-lite) — 허용 목록·비밀 검사는 package-portable 이 한다 ──
const stage = path.join(out, 'payload-source');
const inputs = [...(process.argv.includes('--studio-dir') ? ['--studio-dir', studioDir] : []), ...(process.argv.includes('--engine-pkg') ? ['--engine-pkg', enginePkg] : [])];
log('서버·편집기 묶음(personal-lite) 만들기…');
run(process.execPath, ['scripts/package-portable.mjs', '--target', 'personal-lite', '--out', stage, ...inputs], { stdio: 'inherit' });
const lite = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'))).packages[0];
const payloadDir = path.join(out, 'payload');
await extractZip(path.join(stage, lite.file), payloadDir, (n) => n.startsWith('hwpx-cowork-personal/app/') || n.startsWith('hwpx-cowork-personal/NOTICES/'), (n) => n.slice('hwpx-cowork-personal/'.length));
// Mac 앱과 같은 덧붙임: CLI 실행기 공통 경로 + 데스크톱 로그인 보조 모듈
fs.copyFileSync(path.join(root, 'scripts/setup-worker.mjs'), path.join(payloadDir, 'app/scripts/setup-worker.mjs'));
fs.copyFileSync(path.join(root, 'deploy/portable/personal.mjs'), path.join(payloadDir, 'app/portable/personal.mjs'));
fs.copyFileSync(path.join(root, 'scripts/quick-tunnel.mjs'), path.join(payloadDir, 'app/scripts/quick-tunnel.mjs'));
put(path.join(payloadDir, 'app/scripts/desktop-ai.mjs'), fs.readFileSync(path.join(root, 'deploy/desktop/desktop-ai.mjs'), 'utf8').replaceAll("'../../server/", "'../server/"));
fs.copyFileSync(path.join(root, 'deploy/desktop/cli-versions.mjs'), path.join(payloadDir, 'app/scripts/cli-versions.mjs'));
for (const name of ['release-downloads.js', 'download-page.js', 'download-page.css']) fs.copyFileSync(path.join(root, 'server', name), path.join(payloadDir, 'app/server', name));
// AI 실행기(setup-worker → ai-worker → server/*·engine/*)가 도는 데 필요한 파일 — 없으면 실행기가 켜지자마자 끝난다
for (const need of RUNNER_PAYLOAD_FILES) if (!fs.existsSync(path.join(payloadDir, 'app', need))) throw new Error('앱 묶음에 실행기 파일이 없습니다: ' + need);
const productAudit = auditDesktopProduct({ payload: path.join(payloadDir, 'app'), studioDir, enginePkg, root });
await assertFontDistributionTree(path.join(payloadDir, 'app'));
put(path.join(payloadDir, 'desktop-product.json'), JSON.stringify({ ...productAudit, realMacTested: undefined, platform: 'win32' }, null, 2) + '\n');

// ── 4. 공식 Node(Windows x64) — node.exe 와 npm(AI CLI 설치용)만 ──
log(`공식 Node ${NODE} 받기…`);
const nodeBase = `https://nodejs.org/dist/v${NODE}/`;
const nodeName = `node-v${NODE}-win-x64.zip`;
const nodeHash = (await get(nodeBase + 'SHASUMS256.txt')).toString().split('\n').find((l) => l.endsWith('  ' + nodeName))?.split('  ')[0];
if (!nodeHash) throw new Error('공식 Node 체크섬 누락');
const nodeArchive = await verified(nodeBase + nodeName, nodeHash);
const runtime = path.join(out, 'runtime');
const prefix = `node-v${NODE}-win-x64/`;
await extractZip(nodeArchive, runtime, (n) => [`${prefix}node.exe`, `${prefix}LICENSE`].includes(n) || n.startsWith(`${prefix}node_modules/npm/`), (n) => n.slice(prefix.length));
if (!fs.existsSync(path.join(runtime, 'node.exe')) || !fs.existsSync(path.join(runtime, 'node_modules/npm/bin/npm-cli.js'))) throw new Error('Node 또는 npm 누락');

// ── 5. Electron 앱(win32 x64) ──
log(`Electron ${ELECTRON} 앱 만들기…`);
const icon = path.join(root, 'web/icons/hwpx-cowork.ico');   // 16~256px 아이콘(scripts/make-icons.mjs — 원본 icon/hwpx-cowork.png)
const appOut = path.join(out, 'app');
const [appDir] = await packager({
  dir: desktopSource, name: 'Hwpx Cowork', executableName: 'Hwpx Cowork', platform: 'win32', arch: 'x64', electronVersion: ELECTRON,
  appVersion: version, buildVersion: version, out: appOut, overwrite: false, prune: false, asar: true, icon,
  extraResource: [payloadDir, runtime],
  win32metadata: { CompanyName: 'hwpx-cowork', FileDescription: 'Hwpx Cowork', ProductName: 'Hwpx Cowork', InternalName: 'Hwpx Cowork', OriginalFilename: 'Hwpx Cowork.exe' },
});
for (const need of ['Hwpx Cowork.exe', 'resources/app.asar', 'resources/payload/app/server/index.js', 'resources/runtime/node.exe', 'LICENSE', 'LICENSES.chromium.html']) {
  if (!fs.existsSync(path.join(appDir, need))) throw new Error('앱에 빠진 파일: ' + need);
}

// ── 6. 설치 프로그램(NSIS, 한국어 마법사, 사용자 폴더 설치) ──
log('설치 프로그램(setup.exe) 만들기…');
const installerDir = path.join(out, 'installer');
const artifactName = `HwpxCowork-Setup-${version}-${stamp}.exe`;
await builder.build({
  projectDir: desktopSource, prepackaged: appDir, publish: 'never',
  targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
  config: {
    appId: 'kr.hwpx.cowork.desktop', productName: 'Hwpx Cowork', copyright: 'Copyright (c) 2026 hwpx-cowork contributors',
    electronVersion: ELECTRON, npmRebuild: false, directories: { output: installerDir, buildResources: path.join(root, 'deploy/installer') },
    // 서명 인증서가 없고, 실행 파일 정보(아이콘·이름)는 위 packager 가 이미 넣었다 — rcedit·서명 도구를 받지 않는다
    win: { icon, target: 'nsis', signAndEditExecutable: false },
    nsis: {
      include: path.join(root, 'deploy/installer/update.nsh'),
      oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: 'Hwpx Cowork', menuCategory: false,
      runAfterFinish: true, deleteAppDataOnUninstall: false, installerIcon: icon, uninstallerIcon: icon,
      // 설치 마법사 그림(2026-11-18 — 흰 바탕 + 앱 아이콘, scripts/make-icons.mjs). 없으면 NSIS 기본 그림(파란 metro)이 나온다
      installerSidebar: path.join(root, 'deploy/installer/installer-sidebar.bmp'), uninstallerSidebar: path.join(root, 'deploy/installer/installer-sidebar.bmp'),
      installerHeader: path.join(root, 'deploy/installer/installer-header.bmp'),
      installerLanguages: ['ko_KR'], language: '1042', multiLanguageInstaller: false, unicode: true,
      uninstallDisplayName: 'Hwpx Cowork', artifactName,
    },
  },
});
const setup = path.join(installerDir, artifactName);
if (!fs.existsSync(setup)) throw new Error('설치 프로그램이 만들어지지 않았습니다: ' + setup);
const bytes = fs.readFileSync(setup);
const info = {
  product: 'Hwpx Cowork (Windows 앱)', version, revision: stamp, platform: 'win32', arch: 'x64', electron: ELECTRON, node: NODE, nodeArchiveSha256: nodeHash,
  installer: { file: artifactName, bytes: bytes.length, sha256: sha(bytes), kind: 'NSIS (electron-builder ' + BUILDER + '), per-user, Korean' },
  wasmSha256: productAudit.wasmSha256, webPatchCount: productAudit.editorPatches.length, coworkPlugin: true,
  signing: 'none (Windows SmartScreen 경고 — 추가 정보 → 실행 안내)', builtAt: new Date().toISOString(),
};
put(path.join(out, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
put(path.join(installerDir, '설치 안내.txt'), '﻿' + [
  'Hwpx Cowork 설치 안내 (Windows 10·11, 64비트)',
  '',
  `1. ${artifactName} 을 두 번 누릅니다.`,
  '2. "Windows의 PC 보호" 창이 뜨면 [추가 정보] → [실행]을 누릅니다.',
  '   (이 설치 파일은 아직 코드 서명 인증서가 없어 Windows가 처음 보는 프로그램으로 알립니다.)',
  '3. 설치 마법사에서 [다음] → [설치] → [마침]을 누릅니다. 관리자 권한은 필요 없습니다.',
  '   기존 버전이 있으면 같은 설치 파일로 업데이트할 수 있습니다. 앱이 켜져 있으면 저장하고 종료한 뒤 설치를 계속합니다.',
  '4. 처음 실행하면 "혼자 쓰기", "여러 사람과 함께 쓰기", "AI 실행기만"(이미 있는 서버에 내 AI만 연결) 가운데 하나를 고릅니다.',
  '5. AI를 쓰려면 메뉴 [AI → 실행기 관리]에서 실행기(Codex·Claude Code·Gemini CLI·Antigravity)를 추가하고 켭니다.',
  '   Codex·Claude Code는 처음 켤 때 연결 프로그램을 준비하고 브라우저에서 본인 구독 계정으로 로그인합니다(인터넷 필요, API 키 아님).',
  '   다른 서버(운영·공동 작업 서버)에 붙일 때는 그 서버 주소와 내 토큰을 적습니다. 토큰은 이 PC에 암호화해 보관합니다.',
  '',
  '작업 표시줄 오른쪽 알림 영역(숨겨진 아이콘 ∧ 포함)의 Hwpx Cowork 아이콘에 서버 상태가 표시됩니다.',
  '창을 닫거나 아이콘을 오른쪽 클릭해 [앱과 서버 종료]를 고르면 저장 확인 후 서버도 꺼집니다. 바탕화면·시작 메뉴에서 다시 켭니다.',
  '지우기: 설정 → 앱 → Hwpx Cowork → 제거. 문서 기록·설정(%APPDATA%\\Hwpx Cowork)은 남습니다.',
  '',
].join('\r\n'));
log(`${artifactName}: ${bytes.length} bytes / ${info.installer.sha256}`);
