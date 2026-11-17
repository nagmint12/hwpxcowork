#!/usr/bin/env node
// 검증을 마친 Windows 오프라인 ZIP(파일 6천여 개)을 '빨리 풀리는' 꼴로 다시 싼다. 프로그램 내용은 바꾸지 않는다.
// 받은 ZIP = 파일 몇 개 + setup-files/payload.zip(무압축 보관). 탐색기는 그것만 풀고, 설치 시작.bat 이
// deploy/portable/offline/fast-install.ps1 로 본문을 한 번에 푼다(2026-11-16 실측: 탐색기 206초·경로 초과로 36개 누락 → 4초 + 15초).
// 맨 위 폴더를 두지 않고 파일 이름도 줄인다 — 가장 긴 안쪽 경로가 158자라 설치 폴더 경로는 100자까지만 된다.
//   node scripts/package-windows-offline-fast.mjs --source artifacts/release-<날짜> --out artifacts/<새 폴더>/packages --date <YYYYMMDD>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const BOM = '\uFEFF';
// 받는 사람이 고른 값만 다른 파일(본문 밖, 받은 ZIP 맨 위에 둔다)
const OUTER_ONLY = ['설치 시작.bat', '먼저 읽기.txt', 'install-options.json'];

/** ZIP 중앙 목록 → [{ name, dir, method, flags, crc32, size, packed }] (zip64 는 다루지 않는다) */
export function readZipDirectory(bytes) {
  let at = bytes.length - 22;
  while (at >= 0 && bytes.readUInt32LE(at) !== 0x06054b50) at--;
  assert(at >= 0, 'ZIP 끝 기록을 찾지 못했습니다');
  const count = bytes.readUInt16LE(at + 10), offset = bytes.readUInt32LE(at + 16);
  assert(count !== 0xffff && offset !== 0xffffffff, 'zip64 는 지원하지 않습니다');
  const entries = [];
  for (let p = offset, i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(p), 0x02014b50, 'ZIP 중앙 목록이 깨졌습니다');
    const nameLength = bytes.readUInt16LE(p + 28), extra = bytes.readUInt16LE(p + 30), comment = bytes.readUInt16LE(p + 32);
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLength);
    entries.push({ name, dir: name.endsWith('/'), flags: bytes.readUInt16LE(p + 8), method: bytes.readUInt16LE(p + 10), crc32: bytes.readUInt32LE(p + 16), packed: bytes.readUInt32LE(p + 20), size: bytes.readUInt32LE(p + 24) });
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** 파일 항목만 이름 → "crc32:크기" */
const contentMap = (entries, skip = () => false) => new Map(entries.filter((e) => !e.dir && !skip(e.name)).map((e) => [e.name, `${e.crc32}:${e.size}`]));
function assertSameContent(a, b, what) {
  assert.equal(a.size, b.size, `${what}: 파일 수가 다릅니다`);
  for (const [name, value] of a) assert.equal(b.get(name), value, `${what}: 내용이 다른 파일 ${name}`);
}

const startBat = [
  '@echo off', 'chcp 65001 >nul',
  'if exist "%~dp0setup-files\\install.ps1" (',
  '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-files\\install.ps1"',
  '  if errorlevel 1 (', '    pause', '    exit /b 1', '  )', ')',
  'if not exist "%~dp0offline-start.ps1" (',
  '  echo [hwpx-cowork] ZIP 전체를 먼저 압축 해제한 뒤 실행하세요. / Extract the whole ZIP first, then run this file.',
  '  pause', '  exit /b 1', ')',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0offline-start.ps1"',
  'if errorlevel 1 pause', '',
].join('\r\n');

function readme(p, maxFolder) {
  const cli = p.cli ? `·Codex${p.cli.codex}·Claude Code${p.cli.claude}` : '';
  return BOM + [
    `오프라인 완전 포함판 · Windows ${p.arch || 'x64'}`, '',
    '1. ZIP 전체를 압축 해제합니다. 파일 몇 개뿐이라 바로 끝납니다.',
    '2. 설치 시작.bat을 더블클릭합니다. 처음 한 번 프로그램 파일을 이 폴더에 풉니다(보통 1분 안).',
    '   다음부터는 같은 설치 시작.bat이 바로 문서함을 엽니다.', '',
    `선택: ${p.mode === 'personal' ? '개인' : '공동'} 서버 / ${p.ai}`,
    `프로그램·Node${p.node || ''}·라이브러리·편집기${cli}이 포함되어 있습니다. 원본 rhwp와 동일한 글꼴을 포함하며, PC에 설치된 글꼴도 사용합니다. 이 PC에서 다운로드나 npm 설치 없이 문서함을 시작합니다. 관리자 권한은 필요 없습니다.`,
    `폴더 경로가 길면(${maxFolder}자 초과) 설치 시작.bat이 알려 줍니다. 그때는 폴더를 C:\\HwpxCowork 처럼 짧은 위치로 옮겨 다시 실행하세요. 설치가 끝나면 setup-files 폴더는 자동으로 지워집니다.`,
    'AI를 골랐어도 문서함은 AI 없이 먼저 엽니다. 구독 AI 로그인·요청에는 인터넷과 본인 계정이 필요합니다. 인터넷 연결 후 VS Code에 붙여넣기.txt의 메시지로 연결합니다. VS Code 자체와 확장 프로그램은 포함하지 않습니다.',
    `종료.bat으로 이 설치의 서버를 끕니다. 실행 기록과 문서는 app/userdata-${p.mode}/에 저장되며, 다른 설치의 문서를 복사하거나 변경하지 않습니다.`,
    '공동 서버는 먼저 이 PC에서만 열립니다. 인터넷 공개 주소와 권한 설정은 별도입니다.',
    'admin-app/start-server는 직접 구성하는 고급 실행 파일입니다. 기본 사용은 설치 시작.bat을 쓰세요.', '',
  ].join('\r\n');
}

/**
 * source(release.json + windows-offline-* ZIP 들) → out 에 빠른 설치 ZIP 들·payload.zip·release.json·SHA256SUMS.txt
 * @returns {{ packages: object[], payload: object }}
 */
export async function buildFastOffline({ source, out, date, installer = path.join(root, 'deploy/portable/offline/fast-install.ps1'), log = () => {} }) {
  assert(/^\d{8}$/.test(date), '--date 는 YYYYMMDD');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'release.json'), 'utf8'));
  const variants = (manifest.packages || []).filter((p) => !p.archived && /^windows-offline-/.test(p.target || ''));
  assert(variants.length, 'windows-offline 묶음이 없습니다');
  fs.mkdirSync(out, { recursive: true });
  const payloadFile = path.join(out, 'payload.zip');
  assert(!fs.existsSync(payloadFile), '이전 payload.zip 을 덮어쓰지 않습니다');

  // 1. 원본 확인: 게시 해시와 같고, 여섯 묶음의 프로그램 내용이 서로 같은지(선택 파일만 다름)
  const top = variants[0].topFolder;
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(top || ''), '원본 맨 위 폴더 이름이 없습니다');
  const outerOnly = new Set(OUTER_ONLY.map((name) => `${top}/${name}`));
  let baseBytes = null, baseContent = null;
  for (const p of variants) {
    assert(p.topFolder === top && ['personal', 'shared'].includes(p.mode) && ['none', 'codex', 'claude-code'].includes(p.ai), `묶음 정보가 맞지 않습니다: ${p.file}`);
    const bytes = fs.readFileSync(path.join(source, p.file));
    assert.equal(bytes.length, p.bytes, `크기가 다릅니다: ${p.file}`);
    assert.equal(sha(bytes), p.sha256, `해시가 다릅니다: ${p.file}`);
    const content = contentMap(readZipDirectory(bytes), (name) => outerOnly.has(name));
    if (!baseBytes) { baseBytes = bytes; baseContent = content; } else assertSameContent(baseContent, content, p.file);
    log(`원본 확인 ${p.file}`);
  }

  // 2. 본문 payload.zip: 원본에서 선택 파일만 뺀다. 압축된 내용은 다시 압축하지 않고 그대로 옮긴다.
  {
    const zip = await JSZip.loadAsync(baseBytes);
    for (const name of outerOnly) zip.remove(name);
    await pipeline(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' }), fs.createWriteStream(payloadFile));
  }
  baseBytes = null;
  const payloadBytes = fs.readFileSync(payloadFile);
  const entries = readZipDirectory(payloadBytes);
  assertSameContent(baseContent, contentMap(entries), 'payload.zip');
  const prefix = `${top}/`;
  const files = [], dirs = new Set(), filled = new Set();
  for (const e of entries) {
    assert(e.name.startsWith(prefix) && !e.name.includes('\\') && !e.name.includes(':') && !`/${e.name}/`.includes('/../'), `허용하지 않는 경로: ${e.name}`);
    assert(/^[\x20-\x7e]*$/.test(e.name) || (e.flags & 0x800), `UTF-8 표시가 없는 한글 이름: ${e.name}`);
    const rel = e.name.slice(prefix.length);
    assert(!/^app\/userdata-/.test(rel), `사용자 자료 폴더가 들어 있습니다: ${rel}`);
    if (e.dir) { if (rel) dirs.add(rel.replace(/\/$/, '')); continue; }
    files.push({ rel, size: e.size });
    for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) filled.add(d);
  }
  const emptyDirs = [...dirs].filter((d) => !filled.has(d) && ![...dirs].some((other) => other.startsWith(d + '/')));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const longestFile = files.reduce((a, f) => (f.rel.length > a.length ? f.rel : a), '');
  const longestDir = Math.max(...files.map((f) => f.rel.lastIndexOf('/')), ...emptyDirs.map((d) => d.length), 0);
  // 설치 폴더 경로가 이 길이를 넘으면 설치 도우미가 풀기 전에 멈춘다(파일 259자·폴더 247자 한도)
  const maxFolder = Math.min(259 - 1 - longestFile.length, 247 - 1 - longestDir);
  const list = [['hwpx-fast-install-1', payloadBytes.length, top, files.length, totalBytes].join('\t'), ...files.map((f) => `${f.size}\t${f.rel}`), ...emptyDirs.map((d) => `D\t${d}`), ''].join('\n');
  const payload = { file: 'payload.zip', bytes: payloadBytes.length, sha256: sha(payloadBytes), files: files.length, extractedBytes: totalBytes, longestPath: longestFile.length, maxFolderPath: maxFolder };
  log(`payload.zip ${payload.bytes} 바이트 · 파일 ${files.length}개 · 가장 긴 경로 ${longestFile.length}자 → 설치 폴더 ${maxFolder}자 이하`);

  // 3. 받는 ZIP: 맨 위에 파일 몇 개 + setup-files(설치 도우미·목록·무압축 본문)
  const installerText = BOM + fs.readFileSync(installer, 'utf8').replace(/^\uFEFF/, '');
  const packages = [];
  for (const p of variants) {
    const file = `${top}-${p.version}-${date}-win-${p.mode}-${p.ai}.zip`;
    const target = path.join(out, file);
    assert(!fs.existsSync(target), `이전 묶음을 덮어쓰지 않습니다: ${file}`);
    const outer = new JSZip();
    outer.file('설치 시작.bat', startBat);
    outer.file('먼저 읽기.txt', readme(p, maxFolder));
    outer.file('install-options.json', JSON.stringify({ schema: 1, mode: p.mode, ai: p.ai, offline: true }, null, 2));
    outer.file('setup-files/install.ps1', installerText);
    outer.file('setup-files/files.txt', list);
    outer.file('setup-files/payload.zip', payloadBytes, { compression: 'STORE', binary: true });
    await pipeline(outer.generateNodeStream({ type: 'nodebuffer', streamFiles: false, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' }), fs.createWriteStream(target));
    const bytes = fs.readFileSync(target);
    const stored = readZipDirectory(bytes).find((e) => e.name === 'setup-files/payload.zip');
    assert(stored && stored.method === 0 && stored.size === payloadBytes.length && !(stored.flags & 8), '본문이 무압축으로 들어가지 않았습니다');
    const { topFolder, ...rest } = p;
    packages.push({ ...rest, file, bytes: bytes.length, sha256: sha(bytes), layout: 'fast-install', files: files.length, extractedBytes: totalBytes, maxFolderPath: maxFolder, downloadUrl: p.downloadUrl ? p.downloadUrl.replace(/[^/]+$/, file) : undefined });
    log(`묶음 ${file} ${bytes.length} 바이트`);
  }
  const result = { version: variants[0].version, releasedOn: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`, builtAt: new Date().toISOString(), source: path.basename(source), payload, packages };
  fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), packages.map((p) => `${p.sha256}  ${p.file}`).join('\n') + '\n');
  return result;
}

// 직접 실행했을 때만(시험은 buildFastOffline 을 불러 쓴다). Windows 는 드라이브 글자의 대소문자가 달라도 같은 파일이다.
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const source = arg('--source'), out = arg('--out'), date = arg('--date');
  if (!source || !out || !date) { console.error('node scripts/package-windows-offline-fast.mjs --source <release.json 이 있는 폴더> --out <새 폴더> --date <YYYYMMDD>'); process.exit(2); }
  const result = await buildFastOffline({ source: path.resolve(source), out: path.resolve(out), date, log: console.log });
  console.log(`완료: 묶음 ${result.packages.length}개 → ${path.resolve(out)}`);
}
