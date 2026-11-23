#!/usr/bin/env node
// 통합 릴리즈 묶음 만들기(2026-11-04). 설치형 서버·개인 AI 실행기·참여자 앱(package-portable 의 기본 세 대상)을
// ZIP 하나(hwpx-cowork-<판>-<날짜>.zip)에 담고, /download 페이지가 이 파일 하나만 보이도록 release.json 을 쓴다.
//   node scripts/package-release-bundle.mjs [--stage <폴더>] [--out <폴더>] [--server-url <주소>]
//   · stage(기본 artifacts/release-build-<날짜>) 에서 package-portable 을 돌린다(비밀 값 검사 포함).
//   · out(기본 artifacts/release-<날짜>) 에 묶음·release.json·SHA256SUMS.txt 를 쓴다. 서버는 release.json 이 있는
//     가장 새 artifacts/release-<날짜> 를 내려 주므로, out 이 생기는 순간 /download 가 바뀐다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {assertFontDistributionZip} from './rhwp-original-font-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i < 0 ? def : argv[i + 1]; };
const stage = path.resolve(root, opt('--stage', path.join('artifacts', `release-build-${stamp}`)));
const out = path.resolve(root, opt('--out', path.join('artifacts', `release-${stamp}`)));
const serverUrl = opt('--server-url', '');
const downloadBase = opt('--download-base', 'https://github.com/nagmint12/hwpxcowork/releases/latest/download').replace(/\/$/, '');
const top = `hwpx-cowork-${version}`;
const bundleName = `hwpx-cowork-${version}-${stamp}.zip`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 1) 세 설치형 묶음(서버·개인 실행기·참여자 앱)
const args = ['scripts/package-portable.mjs', '--target', 'server-install,worker-install,user-app', '--out', stage, '--download-base', downloadBase];
if (serverUrl) args.push('--server-url', serverUrl);
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (r.status !== 0) { console.error('package-portable 실패'); process.exit(1); }
const staged = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'), 'utf8'));
const parts = ['server-install', 'worker-install', 'user-app'].map((t) => {
  const p = staged.packages.find((x) => x.target === t);
  if (!p) throw new Error(`묶음이 없습니다: ${t}`);
  return p;
});

// 2) 한 ZIP 으로 — 각 묶음의 최상위 폴더를 그대로 <top>/ 아래에 둔다(실행 권한 비트 유지)
const bundle = new JSZip();
const readme = [
  `hwpx-cowork ${version} 릴리즈 (${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)})`,
  '========================================',
  '',
  '빠른 시작(Windows): 이 폴더의 설치 시작.bat을 더블클릭하면 개인 서버를 AI 없이 준비하고 엽니다.',
  `개인·공동 서버와 Codex·Claude Code를 골라 설치: https://nagmint12.github.io/hwpxcowork/onboarding.html`,
  '선택한 설치 ZIP 안의 설치 시작.bat을 실행하면 필요한 준비와 VS Code용 안내가 이어집니다.',
  '',
  '이 ZIP 하나에 세 가지가 들어 있습니다. 필요한 폴더만 쓰면 됩니다.',
  '',
  '1. hwpx-cowork-server  — 공동 검토 서버(웹 화면·편집기·AI 연결). 관리자가 한 대에 설치합니다.',
  '   Windows: 폴더 안 install.bat → admin-app.bat.  macOS/Linux: sh install.sh → ./start-server.sh',
  '   자세한 안내: hwpx-cowork-server/INSTALL.txt, README.txt(Windows), README.md(Linux)',
  '',
  '2. hwpx-ai-worker      — 개인 AI 실행기(자기 PC 의 Codex·Claude Code 또는 개인 API 키로 요청 처리).',
  '   Windows: install.bat → worker-settings.txt 에 서버 주소·토큰 → start-worker.bat',
  '   자세한 안내: hwpx-ai-worker/README.txt',
  '',
  '3. hwpx-cowork-user-app — 참여자용 바로 가기(서버 화면을 앱 창으로 엽니다, 설치 필요 없음).',
  '   server-url.txt 에 서버 주소를 적고 hwpx-cowork.bat 또는 make-shortcut.bat',
  '',
  '설치형은 Node 런타임과 npm 라이브러리를 넣지 않았습니다. 설치 도우미가 인터넷에서 받습니다.',
  `브라우저 편집기: https://nagmint12.github.io/hwpxcowork/   최신 설치 파일: https://github.com/nagmint12/hwpxcowork/releases/latest`,
  '',
].join('\r\n');
bundle.file(`${top}/읽어보기.txt`, '﻿' + readme, { unixPermissions: 0o644 });
bundle.file(`${top}/설치 시작.bat`, '@echo off\r\nchcp 65001 >nul\r\ncall "%~dp0hwpx-cowork-server\\app\\scripts\\setup-user.bat" --mode personal --ai none --start\r\nif errorlevel 1 pause\r\n', { unixPermissions: 0o644 });
let files = 2;
for (const p of parts) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(stage, p.file)));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const data = await entry.async('nodebuffer');
    bundle.file(`${top}/${entry.name}`, data, { date: entry.date, unixPermissions: entry.unixPermissions ?? 0o644, binary: true });
    files++;
  }
}
const buf = await bundle.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
await assertFontDistributionZip(buf);

// 3) 검사 — 다시 열어 파일 수·각 묶음 파일 수 확인
const check = await JSZip.loadAsync(buf);
const count = Object.values(check.files).filter((e) => !e.dir).length;
if (count !== files) throw new Error(`묶음 파일 수가 다릅니다: ${count} ≠ ${files}`);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, bundleName), buf);
const hash = sha256(buf);
const manifest = {
  version,
  releasedOn: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}`,
  builtAt: new Date().toISOString(),
  node: staged.node,
  downloadBase,
  notes: [
    '이 파일 하나에 서버(hwpx-cowork-server)·개인 AI 실행기(hwpx-ai-worker)·참여자용 바로 가기(hwpx-cowork-user-app)가 들어 있습니다. 필요한 폴더만 쓰면 됩니다.',
    'Windows 빠른 시작: ZIP을 풀고 맨 위의 설치 시작.bat을 더블클릭하면 개인 서버를 AI 없이 준비합니다. 다른 운영 방식·구독은 시작 안내에서 선택한 설치 ZIP을 받으세요. 인터넷 연결이 필요합니다.',
    '처음 읽을 것: 압축을 푼 폴더의 읽어보기.txt',
  ],
  packages: [{ target: 'bundle', file: bundleName, bytes: buf.length, sha256: hash, title: '서버·개인 AI 실행기·참여자 앱', files: count, topFolder: top, downloadUrl: `${downloadBase}/${bundleName}` }],
  contents: parts.map((p) => ({ target: p.target, file: p.file, bytes: p.bytes, sha256: p.sha256, files: p.files, topFolder: p.topFolder })),
};
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${hash}  ${bundleName}\n`);
console.log(`[release-bundle] ${path.relative(root, path.join(out, bundleName))} ${(buf.length / 1e6).toFixed(2)} MB, 파일 ${count}개, sha256 ${hash}`);
