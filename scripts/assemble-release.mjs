#!/usr/bin/env node
// 다운로드 페이지(/download)용 릴리즈 폴더 만들기(2026-11-16). 이미 만든 패키지를 모아 release.json·SHA256SUMS.txt 를 쓴다.
//   node scripts/assemble-release.mjs --pc <package-portable --target windows,worker-install 출력> --mac <package-macos-local 출력>
//        [--carry <이전 릴리즈 폴더> --carry-file <파일 이름>]... --out artifacts/release-candidate-<날짜> [--date YYYY-MM-DD]
// · 서버는 artifacts/release-YYYYMMDD 중 release.json 이 있는 최신 폴더를 바로 내보낸다. 후보는 이름이 맞지 않는 폴더에 만들고,
//   확인한 뒤 release-YYYYMMDD 로 이름을 바꿔 게시한다(반쯤 만든 릴리즈가 보이지 않게).
// · 각 패키지에 설치 안내 전문(guide)을 넣는다 — 다운로드 페이지의 '설치 안내 전체'. Windows 는 ZIP 안의 설치 안내.txt, Mac 은 설치 안내.txt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const one = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const pc = one('--pc'), mac = one('--mac'), out = one('--out');
const carry = all('--carry'), carryFiles = all('--carry-file');
const releasedOn = one('--date') || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const downloadBase = (one('--download-base') || 'https://cowork.example.com/download').replace(/\/$/, '');
if (!pc || !mac || !out || carry.length !== carryFiles.length) {
  console.error('node scripts/assemble-release.mjs --pc <폴더> --mac <폴더> [--carry <이전 릴리즈> --carry-file <파일>]... --out <새 폴더>');
  process.exit(2);
}
const outDir = path.resolve(out);
assert(!/^release-\d{8}$/.test(path.basename(outDir)), '후보는 release-YYYYMMDD 가 아닌 이름에 만든 뒤 확인하고 이름을 바꿉니다');
assert(!fs.existsSync(outDir), `이미 있는 폴더입니다: ${outDir}`);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function zipText(file, suffix) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = Object.values(zip.files).find((e) => !e.dir && e.name.endsWith(suffix));
  return entry ? (await entry.async('string')).replace(/^﻿/, '').replace(/\r\n/g, '\n') : undefined;
}

const packages = [];
fs.mkdirSync(outDir, { recursive: true });
function place(src, meta) {
  const name = path.basename(src);
  const bytes = fs.readFileSync(src);
  fs.writeFileSync(path.join(outDir, name), bytes);
  packages.push({ ...meta, file: name, bytes: bytes.length, sha256: sha(bytes), downloadUrl: `${downloadBase}/${encodeURIComponent(name)}` });
}

// Windows 개인용·공동 작업용, 서버 연결용 AI 실행기
const pcManifest = JSON.parse(fs.readFileSync(path.join(pc, 'release.json'), 'utf8'));
for (const mode of ['personal', 'shared']) {
  const p = pcManifest.packages.find((x) => x.target === `windows-${mode}`);
  assert(p, `windows-${mode} 패키지가 없습니다`);
  const file = path.join(pc, p.file);
  assert.equal(sha(fs.readFileSync(file)), p.sha256, `${p.file} 해시가 명세와 다릅니다`);
  place(file, { target: p.target, version: pcManifest.version, title: mode === 'personal' ? 'Windows 개인용' : 'Windows 공동 작업용', mode, platform: 'windows', arch: 'x64',
    node: pcManifest.node, install: 'online (Node.js·npm 모듈은 처음 실행할 때 받음)', guide: await zipText(file, '/설치 안내.txt') });
}
const worker = pcManifest.packages.find((x) => x.target === 'worker-install');
if (worker) place(path.join(pc, worker.file), { target: 'worker-install', version: pcManifest.version, title: '서버 연결용 AI 실행기', files: worker.files, extractedBytes: worker.extractedBytes });

// Mac 편집기
const macManifest = JSON.parse(fs.readFileSync(path.join(mac, 'macos-local.json'), 'utf8'));
for (const p of macManifest.packages) {
  const file = path.join(mac, p.file);
  assert.equal(sha(fs.readFileSync(file)), p.sha256, `${p.file} 해시가 명세와 다릅니다`);
  const { editorPatches, file: _file, bytes: _bytes, sha256: _sha, ...rest } = p;
  place(file, { ...rest, target: p.target, guide: await zipText(file, '설치 안내.txt') });
}

// 이전 릴리즈에서 그대로 옮기는 파일(예: Android APK) — 원래 명세의 해시와 같아야 한다
carry.forEach((dir, i) => {
  const name = carryFiles[i];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  const p = manifest.packages.find((x) => x.file === name);
  assert(p, `${dir} 명세에 ${name} 이 없습니다`);
  assert.equal(sha(fs.readFileSync(path.join(dir, name))), p.sha256, `${name} 해시가 이전 명세와 다릅니다`);
  const { downloadUrl, bytes, sha256, file, ...rest } = p;
  place(path.join(dir, name), rest);
});

const manifest = { version: rootPackage.version, releasedOn, builtAt: new Date().toISOString(), downloadBase, notes: [], packages };
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), packages.map((p) => `${p.sha256}  ${p.file}`).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const p of packages) console.log(`${p.target}\t${p.file}\t${(p.bytes / 1e6).toFixed(1)} MB`);
console.log(`완료: ${outDir}`);
