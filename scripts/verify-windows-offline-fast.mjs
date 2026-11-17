#!/usr/bin/env node
// 빠른 설치 묶음(scripts/package-windows-offline-fast.mjs)을 받는 사람의 길 그대로 확인한다:
//   받은 파일 표시 → 탐색기 내장 압축 풀기(걸린 시간) → 설치 도우미(걸린 시간) → 풀린 파일이 게시 원본과 같은지(CRC32·크기)
//   → 문서함 시작·응답·종료(창을 열지 않고, 빈 포트, 빈 사용자 폴더). 모델·유료 API 는 부르지 않는다.
//   node scripts/verify-windows-offline-fast.mjs --packages <빠른 묶음 폴더> --reference <게시 원본 폴더> --work <아직 없는 짧은 폴더> [--target windows-offline-personal-none] [--no-start]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readZipDirectory } from './package-windows-offline-fast.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const packages = path.resolve(arg('--packages')), reference = path.resolve(arg('--reference')), work = path.resolve(arg('--work'));
const targetName = arg('--target', 'windows-offline-personal-none');
assert(process.platform === 'win32', 'Windows 에서만 확인합니다');
assert(!fs.existsSync(work), '이전 확인 폴더를 덮어쓰지 않습니다: ' + work);
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const fast = JSON.parse(fs.readFileSync(path.join(packages, 'release.json'), 'utf8'));
const published = JSON.parse(fs.readFileSync(path.join(reference, 'release.json'), 'utf8'));
const pack = fast.packages.find((p) => p.target === targetName), original = published.packages.find((p) => p.target === targetName);
assert(pack && original, '묶음을 찾지 못했습니다: ' + targetName);
const report = { target: targetName, file: pack.file, bytes: pack.bytes, files: pack.files };
const seconds = (from) => Math.round((Date.now() - from) / 100) / 10;
function run(command, args, { env = process.env, timeout = 600000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'timeout', output }); }, timeout);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error) }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));

try {
  // 1. 내려받은 파일처럼: 사본에 '인터넷에서 받음' 표시를 붙이고 탐색기 엔진(Shell.Application)으로 푼다
  fs.mkdirSync(work, { recursive: true });
  const downloaded = path.join(work, pack.file), folder = path.join(work, pack.file.replace(/\.zip$/, ''));
  fs.copyFileSync(path.join(packages, pack.file), downloaded);
  fs.writeFileSync(downloaded + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
  fs.mkdirSync(folder);
  report.folderPathLength = folder.length; report.maxFolderPath = pack.maxFolderPath;
  const extractScript = path.join(work, 'explorer-extract.ps1');
  fs.writeFileSync(extractScript, '﻿' + [
    'param([string]$Zip, [string]$Dst)', "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject Shell.Application',
    '$shell.NameSpace($Dst).CopyHere($shell.NameSpace($Zip).Items(), 0x614)', ''].join('\r\n'));
  let from = Date.now();
  let r = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', extractScript, '-Zip', downloaded, '-Dst', folder], { timeout: 300000 });
  report.explorerExtractSeconds = seconds(from);
  assert.equal(r.code, 0, '탐색기 압축 풀기: ' + r.output);
  const outer = walk(folder).sort();
  assert.deepEqual(outer, ['install-options.json', 'setup-files/files.txt', 'setup-files/install.ps1', 'setup-files/payload.zip', '먼저 읽기.txt', '설치 시작.bat'].sort());
  report.explorerExtractedFiles = outer.length;
  report.payloadMarkedAsDownloaded = fs.existsSync(path.join(folder, 'setup-files/payload.zip:Zone.Identifier'));

  // 2. 설치 도우미(설치 시작.bat 이 부르는 것과 같은 명령)
  from = Date.now();
  r = await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'setup-files/install.ps1')]);
  report.installSeconds = seconds(from);
  assert.equal(r.code, 0, '설치 도우미: ' + r.output);
  assert(!fs.existsSync(path.join(folder, 'setup-files')), 'setup-files 가 남았습니다');

  // 3. 풀린 파일 = 게시 원본(이름·CRC32·크기). 더 있는 것은 맨 위의 선택 파일 셋뿐이어야 한다
  const top = original.topFolder + '/';
  const expected = new Map(readZipDirectory(fs.readFileSync(path.join(reference, original.file))).filter((e) => !e.dir).map((e) => [e.name.slice(top.length), e]));
  const installed = walk(folder);
  const outerOnly = ['설치 시작.bat', '먼저 읽기.txt', 'install-options.json'];
  let checkedBytes = 0, longest = 0;
  for (const rel of installed) {
    const entry = expected.get(rel); assert(entry, '원본에 없는 파일: ' + rel);
    longest = Math.max(longest, path.join(folder, rel).length);
    if (outerOnly.includes(rel)) continue;
    const bytes = fs.readFileSync(path.join(folder, rel));
    assert.equal(bytes.length, entry.size, '크기가 다릅니다: ' + rel);
    assert.equal(zlib.crc32(bytes), entry.crc32, '내용이 다릅니다: ' + rel);
    checkedBytes += bytes.length;
  }
  assert.equal(installed.length, expected.size, '파일 수가 원본과 다릅니다');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'install-options.json'), 'utf8')), { schema: 1, mode: pack.mode, ai: pack.ai, offline: true });
  report.installedFiles = installed.length; report.contentIdenticalToPublished = true; report.checkedBytes = checkedBytes; report.longestInstalledPath = longest;
  report.downloadMarksOnProgramFiles = ['runtime/node.exe', 'offline-start.ps1', '종료.bat'].filter((f) => fs.existsSync(path.join(folder, f) + ':Zone.Identifier')).length;

  // 4. 문서함 시작 → 응답 → 다시 시작(같은 서버) → 종료. 사용자 폴더·PATH 는 비워서 이 PC 의 설정·Node 를 쓰지 않는다
  if (!process.argv.includes('--no-start')) {
    const home = path.join(work, 'empty-home'); fs.mkdirSync(home);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HWPX_|^(NODE_OPTIONS|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|Path)$/i.test(k)));
    Object.assign(env, { PATH: `${process.env.SystemRoot}\\System32;${path.dirname(powershell)}`, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
    const start = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'offline-start.ps1'), '-NoOpen'];
    try {
      from = Date.now();
      r = await run(powershell, start, { env }); report.firstStartSeconds = seconds(from);
      assert.equal(r.code, 0, '시작: ' + r.output);
      const data = path.join(folder, `app/userdata-${pack.mode}`);
      const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')), state = JSON.parse(fs.readFileSync(path.join(data, 'setup-runtime.json'), 'utf8'));
      assert.equal(state.phase, 'running'); assert.notEqual(state.port, 8787);
      const base = `http://127.0.0.1:${state.port}`, token = config.users.find((u) => u.role === 'admin').token;
      const me = await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      assert.equal(me.status, 200); assert.equal((await me.json()).role, 'admin');
      for (const asset of ['/', '/app.js', '/studio/index.html', '/vendor/rhwp-core/rhwp_bg.wasm']) assert.equal((await fetch(base + asset, { method: 'HEAD', signal: AbortSignal.timeout(20000) })).status, 200, asset);
      r = await run(powershell, start, { env }); assert.equal(r.code, 0, '다시 시작: ' + r.output);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'setup-runtime.json'), 'utf8')).pid, state.pid, '다시 시작은 같은 서버를 쓴다');
      report.start = { port: state.port, api: true, assets: true, repeatUsesSameServer: true };
    } finally {
      r = await run(powershell, [...start, '-Stop'], { env }); report.stopExit = r.code;
      const stateFile = path.join(folder, `app/userdata-${pack.mode}/setup-runtime.json`);
      if (fs.existsSync(stateFile)) report.finalPhase = JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase;
    }
  }
  report.pass = true;
} catch (error) {
  report.pass = false; report.error = String(error.message).slice(0, 2000);
} finally {
  fs.writeFileSync(path.join(work, 'verify-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
