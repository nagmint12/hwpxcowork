// Windows 오프라인 '빠른 설치' 묶음: 받은 ZIP 은 파일 몇 개 + 무압축 본문이고, 설치 시작.bat 이 본문을 한 번에 푼다.
// 작은 가짜 원본으로 묶는 쪽(scripts/package-windows-offline-fast.mjs)과 설치 도우미(deploy/portable/offline/fast-install.ps1)를 함께 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { buildFastOffline, readZipDirectory } from '../scripts/package-windows-offline-fast.mjs';
import { removeTree } from '../server/fs-safe.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const TOP = 'hwpx-cowork-server';
const DEEP = `app/tools/${'d'.repeat(40)}/${'e'.repeat(40)}/deep-file.txt`;   // 설치 폴더 경로 한도를 정하는 가장 긴 경로
// 설치 뒤 설치 시작.bat 이 부르는 시작 파일의 대역: 불린 횟수만 남긴다
const START_STUB = '﻿' + "Add-Content -LiteralPath (Join-Path $PSScriptRoot 'started.txt') -Value 'start'\r\n";
const PROGRAM = {
  'offline-start.ps1': START_STUB,
  '종료.bat': '@echo off\r\n',
  'runtime/node.exe': 'MZ-가짜 실행 파일',
  'app/server/index.js': 'console.log("server")\n',
  'app/docs/manuals/00 처음 읽기 — 둘러보기.hwpx': Buffer.from([80, 75, 3, 4, 1, 2, 3]),
  'app/big.bin': crypto.randomBytes(300000),
  [DEEP]: 'deep\n',
};
const VARIANTS = [['personal', 'none'], ['shared', 'codex']];

/** 지금 게시 꼴(맨 위 폴더 + 선택 파일 + 프로그램)의 가짜 원본 릴리스 */
async function makeSource(dir, { change } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const packages = [];
  for (const [mode, ai] of VARIANTS) {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(PROGRAM)) zip.file(`${TOP}/${name}`, data);
    zip.folder(`${TOP}/app/empty-folder`);
    zip.file(`${TOP}/설치 시작.bat`, '@echo off\r\nrem 옛 시작 파일\r\n');
    zip.file(`${TOP}/먼저 읽기.txt`, `옛 안내 ${mode} ${ai}`);
    zip.file(`${TOP}/install-options.json`, JSON.stringify({ schema: 1, mode, ai, offline: true }));
    if (change?.(mode, ai)) zip.file(`${TOP}/app/server/index.js`, 'console.log("다른 내용")\n');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const file = `${TOP}-0.5.0-20261114-win-x64-offline-${mode}-${ai}.zip`;
    fs.writeFileSync(path.join(dir, file), bytes);
    packages.push({ target: `windows-offline-${mode}-${ai}`, file, bytes: bytes.length, sha256: sha(bytes), version: '0.5.0', title: `Windows 오프라인 · ${mode} · ${ai}`, topFolder: TOP, mode, ai, offline: true, arch: 'x64', node: '24.22.2', cli: { codex: '0.169.0', claude: '2.1.323' }, downloadUrl: `https://example.test/download/${file}` });
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.5.0', packages }));
  return packages;
}

/** 탐색기의 '압축 풀기' 대역: 받은 ZIP 을 폴더에 그대로 푼다 */
async function unpack(zipFile, dst) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipFile));
  for (const [name, entry] of Object.entries(zip.files)) {
    const target = path.join(dst, name);
    if (entry.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
  return dst;
}
const run = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  child.once('error', (error) => resolve({ code: -1, output: String(error) })); child.once('exit', (code) => resolve({ code, output }));
});
const install = (dir) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'setup-files', 'install.ps1')]);
const startBat = (dir) => run(`"${path.join(dir, '설치 시작.bat')}"`, [], { shell: true });
function assertInstalled(dir) {
  for (const [name, data] of Object.entries(PROGRAM)) assert.deepEqual(fs.readFileSync(path.join(dir, name)), Buffer.from(data), name);
  assert.ok(fs.statSync(path.join(dir, 'app/empty-folder')).isDirectory());
  assert.ok(!fs.existsSync(path.join(dir, TOP)), '맨 위 폴더가 한 겹 더 생기지 않는다');
  assert.ok(!fs.existsSync(path.join(dir, 'setup-files')), '설치용 파일은 지운다');
}

test('빠른 설치 묶음: 받은 ZIP 은 파일 몇 개와 무압축 본문이고 프로그램 내용은 원본과 같다', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-fast-build-'));
  try {
    const source = path.join(work, 'source'), out = path.join(work, 'out');
    await makeSource(source);
    const result = await buildFastOffline({ source, out, date: '20261116' });
    assert.deepEqual(result.packages.map((p) => p.file), ['hwpx-cowork-server-0.5.0-20261116-win-personal-none.zip', 'hwpx-cowork-server-0.5.0-20261116-win-shared-codex.zip']);
    const longest = DEEP.length;
    assert.equal(result.payload.longestPath, longest);
    assert.equal(result.payload.maxFolderPath, 259 - 1 - longest);
    for (const p of result.packages) {
      const bytes = fs.readFileSync(path.join(out, p.file));
      assert.equal(bytes.length, p.bytes); assert.equal(sha(bytes), p.sha256);
      assert.ok(/^hwpx-cowork-server-[A-Za-z0-9._-]+\.zip$/.test(p.file), '다운로드 경로가 받는 이름');
      assert.equal(p.target, `windows-offline-${p.mode}-${p.ai}`); assert.equal(p.topFolder, undefined);
      assert.equal(p.downloadUrl, `https://example.test/download/${p.file}`);
      const entries = readZipDirectory(bytes);
      assert.deepEqual(entries.map((e) => e.name).sort(), ['install-options.json', 'setup-files/', 'setup-files/files.txt', 'setup-files/install.ps1', 'setup-files/payload.zip', '먼저 읽기.txt', '설치 시작.bat'].sort());
      const stored = entries.find((e) => e.name === 'setup-files/payload.zip');
      assert.equal(stored.method, 0); assert.equal(stored.size, result.payload.bytes);
      const zip = await JSZip.loadAsync(bytes);
      assert.deepEqual(JSON.parse(await zip.file('install-options.json').async('string')), { schema: 1, mode: p.mode, ai: p.ai, offline: true });
      assert.deepEqual([...(await zip.file('setup-files/install.ps1').async('nodebuffer')).subarray(0, 3)], [239, 187, 191]);
      assert.match(await zip.file('먼저 읽기.txt').async('string'), new RegExp(`${259 - 1 - longest}자 초과`));
      const bat = await zip.file('설치 시작.bat').async('string');
      assert.match(bat, /setup-files\\install\.ps1/); assert.match(bat, /offline-start\.ps1/); assert.ok(!/^:/m.test(bat), '한글이 든 bat 에 goto 꼬리표를 쓰지 않는다');
      assert.equal(sha(await zip.file('setup-files/payload.zip').async('nodebuffer')), result.payload.sha256);
      const list = (await zip.file('setup-files/files.txt').async('string')).split('\n');
      assert.equal(list[0], ['hwpx-fast-install-1', result.payload.bytes, TOP, Object.keys(PROGRAM).length, result.payload.extractedBytes].join('\t'));
      assert.ok(list.includes(`${Buffer.byteLength(PROGRAM['app/server/index.js'])}\tapp/server/index.js`));
      assert.ok(list.includes('D\tapp/empty-folder'));
    }
    const payload = await JSZip.loadAsync(fs.readFileSync(path.join(out, 'payload.zip')));
    for (const [name, data] of Object.entries(PROGRAM)) assert.deepEqual(await payload.file(`${TOP}/${name}`).async('nodebuffer'), Buffer.from(data));
    for (const name of ['설치 시작.bat', '먼저 읽기.txt', 'install-options.json']) assert.equal(payload.file(`${TOP}/${name}`), null);
    assert.equal(fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), result.packages.map((p) => `${p.sha256}  ${p.file}`).join('\n') + '\n');
    await assert.rejects(buildFastOffline({ source, out, date: '20261116' }), /덮어쓰지 않습니다/);

    // 묶음끼리 프로그램 내용이 다르거나 게시 해시와 다르면 묶지 않는다
    const mixed = path.join(work, 'mixed'); await makeSource(mixed, { change: (mode) => mode === 'shared' });
    await assert.rejects(buildFastOffline({ source: mixed, out: path.join(work, 'out-mixed'), date: '20261116' }), /내용이 다른 파일/);
    const tampered = path.join(work, 'tampered'); const [first] = await makeSource(tampered);
    fs.appendFileSync(path.join(tampered, first.file), 'x');
    await assert.rejects(buildFastOffline({ source: tampered, out: path.join(work, 'out-tampered'), date: '20261116' }), /크기가 다릅니다/);
  } finally { assert.ok(work.startsWith(os.tmpdir() + path.sep)); removeTree(work); }
});

test('빠른 설치 도우미: 한글·공백 경로, 다시 실행, 끊긴 설치 이어 하기, 손상·긴 경로에서 멈춤', { skip: process.platform !== 'win32' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-fast-'));
  try {
    const source = path.join(work, 'source'), out = path.join(work, 'out');
    await makeSource(source);
    const result = await buildFastOffline({ source, out, date: '20261116' });
    const zipFile = path.join(out, result.packages[0].file);

    // 설치 시작.bat: 처음에는 풀고 시작, 다음에는 바로 시작
    const first = await unpack(zipFile, path.join(work, '내려받기 (1)'));
    let r = await startBat(first); assert.equal(r.code, 0, r.output);
    assertInstalled(first);
    assert.equal(fs.readFileSync(path.join(first, 'started.txt'), 'utf8').trim().split(/\r?\n/).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'install-options.json'), 'utf8')).mode, 'personal');
    fs.writeFileSync(path.join(first, 'app/userdata-keep.txt'), '내 자료');
    r = await startBat(first); assert.equal(r.code, 0, r.output);
    assert.equal(fs.readFileSync(path.join(first, 'started.txt'), 'utf8').trim().split(/\r?\n/).length, 2);
    assert.equal(fs.readFileSync(path.join(first, 'app/userdata-keep.txt'), 'utf8'), '내 자료');

    // 풀다가 끊긴 폴더: 크기가 다른 파일은 바로잡고, 이미 맞게 풀린 파일은 다시 쓰지 않는다
    const broken = await unpack(zipFile, path.join(work, '끊김'));
    fs.mkdirSync(path.join(broken, 'app/server'), { recursive: true }); fs.writeFileSync(path.join(broken, 'app/server/index.js'), 'x');
    fs.mkdirSync(path.join(broken, 'runtime')); fs.writeFileSync(path.join(broken, 'runtime/node.exe'), PROGRAM['runtime/node.exe']);
    const before = new Date('2020-01-02T03:04:05Z'); fs.utimesSync(path.join(broken, 'runtime/node.exe'), before, before);
    r = await install(broken); assert.equal(r.code, 0, r.output); assertInstalled(broken);
    assert.equal(fs.statSync(path.join(broken, 'runtime/node.exe')).mtime.toISOString(), before.toISOString());
    // 본문에 든 이름 그대로 푼다(시스템 코드 페이지에 없는 '—' 를 '_' 로 바꾼 파일이 생기지 않는다)
    assert.deepEqual(fs.readdirSync(path.join(broken, 'app/docs/manuals')), ['00 처음 읽기 — 둘러보기.hwpx']);

    // 본문이 잘렸거나 없으면 풀지 않고 멈춘다
    const cut = await unpack(zipFile, path.join(work, '잘림'));
    fs.truncateSync(path.join(cut, 'setup-files/payload.zip'), 1000);
    r = await install(cut); assert.equal(r.code, 1, r.output); assert.ok(!fs.existsSync(path.join(cut, 'app')));
    const gone = await unpack(zipFile, path.join(work, '없음'));
    fs.unlinkSync(path.join(gone, 'setup-files/payload.zip'));
    r = await install(gone); assert.equal(r.code, 1, r.output); assert.ok(!fs.existsSync(path.join(gone, 'app')));
    // 압축을 풀지 않고 bat 만 꺼내 실행한 경우
    const alone = path.join(work, 'bat만'); fs.mkdirSync(alone); fs.copyFileSync(path.join(cut, '설치 시작.bat'), path.join(alone, '설치 시작.bat'));
    r = await startBat(alone); assert.equal(r.code, 1, r.output);

    // 경로 한도: 딱 맞는 폴더는 풀고, 한 글자 넘으면 풀기 전에 멈춘다
    const limit = result.payload.maxFolderPath;
    const padded = (length, tag) => path.join(work, tag + 'p'.repeat(length - work.length - 1 - tag.length));
    assert.ok(work.length + 10 < limit, '시험 폴더 경로가 너무 깁니다');
    const fits = await unpack(zipFile, padded(limit, 'f')); assert.equal(fits.length, limit);
    r = await install(fits); assert.equal(r.code, 0, r.output); assertInstalled(fits);
    const tooLong = await unpack(zipFile, padded(limit + 1, 'x'));
    r = await install(tooLong); assert.equal(r.code, 1, r.output);
    assert.ok(!fs.existsSync(path.join(tooLong, 'app')) && !fs.existsSync(path.join(tooLong, 'runtime')), '긴 경로에서는 아무것도 풀지 않는다');
    assert.ok(fs.existsSync(path.join(tooLong, 'setup-files/payload.zip')), '짧은 곳으로 옮겨 다시 실행할 수 있게 본문을 남긴다');
  } finally { assert.ok(work.startsWith(os.tmpdir() + path.sep)); removeTree(work); }
});
