// 포터블 배포물(scripts/package-portable.mjs) — 런타임을 내려받지 않는 대상(worker-lite·user-app)으로 허용 목록·제외·실행을 확인한다.
// 서버 묶음·런타임 포함판은 크고(nodejs.org 내려받기 포함) 오래 걸려 여기서 돌리지 않는다(검증 기록: artifacts/submission-*/04_PORTABLE_SERVER_AND_UBUNTU.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));

function pack(tmp, args) {
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'package-portable.mjs'), ...args, '--out', out], { cwd: root, encoding: 'utf8' });
  return out;
}
async function extract(zip, dir) {
  for (const entry of Object.values(zip.files)) {
    const dst = path.resolve(dir, entry.name);
    assert.ok(dst.startsWith(path.resolve(dir) + path.sep));
    if (entry.dir) fs.mkdirSync(dst, { recursive: true });
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, await entry.async('nodebuffer')); }
  }
}
function cleanup(tmp) {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}

test('worker-lite: 실행기 코드·의존성·Node 찾기/설치 도우미만 담고 설정·비밀·소스맵·런타임을 빼며, 풀어서 바로 --help 가 돈다', { timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-portable-'));
  try {
    const out = pack(tmp, ['--target', 'worker-node']);   // 옛 이름도 worker-lite 로
    const zipName = fs.readdirSync(out).find((f) => f.endsWith('-lite.zip'));
    assert.ok(zipName, 'ZIP 생성');
    const release = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    assert.equal(release.packages[0].file, zipName);
    assert.equal(release.packages[0].target, 'worker-lite');
    const nodeVersion = release.node;
    assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
    assert.match(fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), new RegExp(`${release.packages[0].sha256}  ${zipName.replace(/\./g, '\\.')}`));
    assert.ok(!fs.existsSync(path.join(out, '.staging')), 'staging 정리');

    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, zipName)));
    const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name);
    for (const must of ['app/scripts/ai-worker.mjs', 'app/server/mcp-stdio.js', 'app/scripts/setup-agent.mjs', 'app/agent/CLAUDE.md', 'app/package.json',
      'app/node_modules/@modelcontextprotocol/sdk/package.json', 'app/node_modules/zod/package.json', 'worker-settings.txt', 'start-worker.bat', 'start-worker.sh', 'NOTICES/node_modules.txt',
      'install-node.bat', 'install-node.sh', 'app/portable/find-node.cmd', 'app/portable/ensure-node.cmd', 'app/portable/find-node.sh', 'app/portable/install-node.ps1']) {
      assert.ok(names.includes(`hwpx-ai-worker/${must}`), `포함: ${must}`);
    }
    for (const name of names) {
      assert.doesNotMatch(name, /(^|\/)(config\.json|\.hwpx-cowork-secret|\.env|\.mcp\.json|settings\.local\.json)$/, `제외: ${name}`);
      assert.doesNotMatch(name, /\.(map|d\.ts)$/, `소스맵·타입 제외: ${name}`);
      assert.doesNotMatch(name, /^hwpx-ai-worker\/(data|tests|vendor|studio|backups)\//, `개발 자료 제외: ${name}`);
      assert.doesNotMatch(name, /^hwpx-ai-worker\/runtime\//, '런타임 없는 판');
    }
    for (const sh of ['start-worker.sh', 'install-node.sh']) assert.equal((zip.files[`hwpx-ai-worker/${sh}`].unixPermissions & 0o777), 0o755, `실행 권한: ${sh}`);
    assert.match(await zip.file('hwpx-ai-worker/start-worker.bat').async('string'), /\r\n/, '배치 파일은 CRLF');
    const ps1 = await zip.file('hwpx-ai-worker/app/portable/install-node.ps1').async('nodebuffer');
    assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell 5.1 이 한글을 읽게 UTF-8 BOM');
    assert.ok(ps1.toString('utf8').includes(`'${nodeVersion}'`), '설치할 Node 판 = 묶은 판');
    assert.ok(!ps1.toString('utf8').includes('__NODE_VERSION__'));
    assert.match(await zip.file('hwpx-ai-worker/install-node.sh').async('string'), new RegExp(`:-${nodeVersion.replace(/\./g, '\\.')}\\}`));
    const manifest = JSON.parse(await zip.file('hwpx-ai-worker/app/package.json').async('string'));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@modelcontextprotocol/sdk', 'zod']);

    // 개발 폴더의 node_modules 없이 풀린 폴더만으로 실행(설치된 Node 사용)
    const dir = path.join(tmp, 'x');
    await extract(zip, dir);
    const help = execFileSync(process.execPath, [path.join(dir, 'hwpx-ai-worker', 'app', 'scripts', 'ai-worker.mjs'), '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.match(help, /개인 AI 자동 처리 실행기/);
  } finally { cleanup(tmp); }
});

test('user-app: Node·서버 없이 서버 주소만 담은 작은 앱 창 바로 가기 묶음', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-portable-'));
  try {
    const out = pack(tmp, ['--target', 'user-app', '--server-url', 'https://hwpx.example.ac.kr/']);
    const zipName = fs.readdirSync(out).find((f) => f.startsWith('hwpx-cowork-user-app-'));
    assert.ok(zipName);
    assert.ok(fs.statSync(path.join(out, zipName)).size < 64 * 1024, '수십 KB 안');
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, zipName)));
    const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name.replace(/^hwpx-cowork-user-app\//, '')).sort();
    assert.deepEqual(names, ['README.txt', 'hwpx-cowork.bat', 'hwpx-cowork.ico', 'make-shortcut.bat', 'make-shortcut.ps1', 'server-url.txt']);
    assert.match(await zip.file('hwpx-cowork-user-app/server-url.txt').async('string'), /^HWPX_COWORK_SERVER=https:\/\/hwpx\.example\.ac\.kr\/\r$/m);
    assert.deepEqual([...(await zip.file('hwpx-cowork-user-app/make-shortcut.ps1').async('nodebuffer')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally { cleanup(tmp); }
});

test('worker-install: npm 모듈과 런타임 없이 잠금 파일과 실제 PC 설치기를 제공하고 설치 전 실행을 차단한다', { timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-portable-'));
  try {
    const out = pack(tmp, ['--target', 'worker-install', '--server-url', 'https://cowork.example.com']);
    const release = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    const p = release.packages[0];
    assert.equal(p.installRequired, true);
    assert.equal(p.attachmentEligible, true);
    assert.ok(p.bytes < 1000000, '개인 실행기는 1 MB 미만');
    assert.equal(p.downloadUrl, `https://cowork.example.com/download/${p.file}`);
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, p.file)));
    const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name);
    assert.ok(names.every((name) => !name.includes('/node_modules/') && !name.includes('/runtime/')));
    const base = 'hwpx-ai-worker/';
    for (const file of ['install-dependencies.bat', 'install-dependencies.sh', 'app/portable/install-dependencies.mjs', 'app/package-lock.json']) assert.ok(names.includes(base + file));
    const lock = JSON.parse(await zip.file(base + 'app/package-lock.json').async('string'));
    const manifest = JSON.parse(await zip.file(base + 'app/package.json').async('string'));
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.ok(!lock.packages['node_modules/vue'] && !lock.packages['node_modules/@rhwp/core'], '서버 전용 모듈은 잠금 파일에서도 제외');
    const dir = path.join(tmp, 'x');
    await extract(zip, dir);
    assert.throws(() => execFileSync(process.execPath, [path.join(dir, 'hwpx-ai-worker/app/portable/install-dependencies.mjs'), '--check'], { stdio: 'pipe' }), (error) => error.status === 1);
    assert.match(await zip.file(base + 'start-worker.bat').async('string'), /install-dependencies\.mjs" --check/);
    assert.match(await zip.file(base + 'worker-settings.txt').async('string'), /^HWPX_COWORK_URL=https:\/\/cowork\.example\.com\/mcp\r$/m);
    assert.match(await zip.file(base + 'app/portable/install-dependencies.mjs').async('string'), /'ci', '--omit=dev', '--ignore-scripts'/);
    const macInstaller = await zip.file(base + 'install-node.sh').async('string');
    assert.ok(macInstaller.includes('22.23.5'), '구형 macOS 호환 런타임 고정');
    assert.doesNotMatch(macInstaller, /__[A-Z_]+__|\r/, '셸 템플릿 치환·LF');
    assert.equal(zip.file(base + 'start-worker.sh').unixPermissions & 0o777, 0o755);
    assert.match(await zip.file(base + 'README.txt').async('string'), /macOS 14 포함 13.5 이상은 Node 24/);
  } finally { cleanup(tmp); }
});

// 2026-11-16: Windows 개인용·공동 작업용 설치 묶음 — 프로그램만 담고(Node·npm 모듈은 받는 PC 에서 처음 실행할 때), 기관 자료는 넣지 않는다
test('windows: 개인용·공동 작업용 두 묶음은 실행 파일·안내·잠금 파일만 담고 튜토리얼·설명서·소개 화면·개발 PC 파일을 뺀다', { timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-portable-'));
  try {
    const out = pack(tmp, ['--target', 'windows']);
    const release = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
    assert.deepEqual(release.packages.map((p) => p.target), ['windows-personal', 'windows-shared']);
    for (const p of release.packages) {
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(out, p.file)));
      const top = `hwpx-cowork-${p.mode}/`;
      const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name);
      assert.ok(names.every((n) => n.startsWith(top)));
      const launchers = ['시작.bat', '종료.bat', 'AI 연결.bat', ...(p.mode === 'shared' ? ['외부 접속 열기.bat'] : [])];
      for (const file of [...launchers, '설치 안내.txt', 'install-options.json', 'app/portable/hwpx-windows.ps1', 'app/portable/install-node.ps1', 'app/portable/install-dependencies.mjs', 'app/package-lock.json']) assert.ok(names.includes(top + file), file);
      if (p.mode === 'personal') assert.ok(!names.includes(top + '외부 접속 열기.bat'));
      assert.deepEqual(JSON.parse(await zip.file(top + 'install-options.json').async('string')), { schema: 1, mode: p.mode });
      assert.ok(names.every((n) => !n.includes('/node_modules/') && !n.includes('/runtime/')), 'Node·npm 모듈은 받는 PC 에서 설치');
      for (const re of [/\/app\/tutorial\//, /\/app\/docs\/manuals\//, /\/app\/web\/teaser3?\//, /run-watchdog-silent\.vbs$/, /install-watchdog\.js$/, /\/server\/templates\/README\.md$/]) assert.ok(!names.some((n) => re.test(n)), String(re));
      // 한글 이름은 UTF-8 표시로 넣어 탐색기에서 깨지지 않는다
      assert.ok(Object.values(zip.files).some((e) => e.name === top + '시작.bat'));
      const ps1 = await zip.file(top + 'app/portable/hwpx-windows.ps1').async('nodebuffer');
      assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell 5.1 이 한글을 읽도록 BOM');
      assert.doesNotMatch(ps1.toString('utf8'), /__NODE_VERSION__/);
      assert.match(await zip.file(top + '시작.bat').async('string'), /hwpx-windows\.ps1" -Action Start\r\n/);
      const guide = await zip.file(top + '설치 안내.txt').async('string');
      assert.match(guide, p.mode === 'personal' ? /PC 폴더 연결/ : /외부 접속 열기\.bat/);
      const writingGuide = await zip.file(top + 'app/skill/hwpx-standard-report/reference/AI_작성지침.md').async('string');
      assert.doesNotMatch(writingGuide, /대학혁신센터/);
    }
  } finally { cleanup(tmp); }
});
