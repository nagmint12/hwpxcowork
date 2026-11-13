#!/usr/bin/env node
// 튜토리얼 HWPX 를 통째로 다시 만들지 않고 고친다(2026-11-13): 정한 글 바꾸기 + 미리보기 글(Preview/PrvText.txt)을 그 문서 본문으로 다시 쓰기.
//   node scripts/build-tutorial-refresh.mjs           → 아래 FIXES 의 문서를 고친다(이미 고친 문서는 그대로)
//   node scripts/build-tutorial-refresh.mjs --check   → 고치지 않고 남은 것만 알린다(남으면 종료 코드 1)
// 'AI 활용 심화 — 연습 보고서'는 build-tutorial-advanced.mjs 로 다시 만들면 수치가 바뀌어 예시 답변(실제 AI 로 만들고 검수함)도
// 다시 만들어야 한다 — 그래서 표지 제목·안내 글만 이 길로 고친다. 생성기(build-tutorial-advanced.mjs·tutorial-advanced/content.mjs)에도 같은 글을 넣었다.
// previewText 는 build-tutorial-connection.mjs·build-manuals.mjs 도 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 미리보기 글: 문서 순서대로 비지 않은 문단 글(표 칸 포함, 줄 나눔은 빈칸)을 줄마다 하나씩, limit 글자 안에서 문단 단위로 자른다.
 * 템플릿·다른 보고서의 미리보기 글이 남지 않게 늘 그 문서의 글로 다시 쓴다.
 */
export function previewText(doc, limit = 1000) {
  const lines = [];
  let size = 0;
  for (const p of doc.paragraphs({ nested: true })) {
    const text = String(p.text || '').replace(/\s*\n\s*/g, ' ').replace(/\t+/g, ' ').trim();
    if (!text) continue;
    if (lines.length && size + text.length + 2 > limit) break;
    lines.push(text); size += text.length + 2;
  }
  return lines.join('\r\n');
}

/** HWPX 바이트 → 한/글 꼴 ZIP(mimetype·version.xml 무압축으로 맨 앞, 폴더 항목 없음, 날짜 고정) */
export async function zipHwpx(files, order) {
  const zip = new JSZip(); const date = new Date(1980, 0, 1); const first = ['mimetype', 'version.xml'];
  for (const name of [...first.filter((n) => files.has(n)), ...order.filter((n) => !first.includes(n) && files.has(n))]) {
    zip.file(name, files.get(name), { compression: first.includes(name) ? 'STORE' : 'DEFLATE', date, createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/**
 * 글 바꾸기(replace: [{ file: 'Contents/section0.xml', from: 글 또는 정규식, to }] — from 이 정확히 한 번 있어야 한다. 이미 to 만 있으면 건너뜀)
 * + 미리보기 글 다시 쓰기. → { bytes, changed: [설명…], pending: [남은 것…] }
 */
export async function refreshHwpx(bytes, { replace = [], check = false } = {}) {
  const src = await JSZip.loadAsync(bytes);
  const order = Object.keys(src.files).filter((n) => !src.files[n].dir);
  const files = new Map();
  for (const name of order) files.set(name, await src.file(name).async('uint8array'));
  const changed = []; const pending = [];
  for (const { file, from, to } of replace) {
    const xml = Buffer.from(files.get(file) || []).toString('utf8');
    const old = from instanceof RegExp ? (xml.match(new RegExp(from.source, 'g')) || []).length : xml.split(from).length - 1;
    const now = xml.split(to).length - 1;
    if (old === 0 && now >= 1) continue;
    const what = String(from instanceof RegExp ? from.source : from).slice(0, 60);
    if (old !== 1) throw new Error(`${file}: 바꿀 글을 ${old}번 찾았습니다(1번이어야 함) — ${what}`);
    if (check) { pending.push(`${file}: ${what}`); continue; }
    files.set(file, new TextEncoder().encode(xml.replace(from, to))); changed.push(`${file}: ${to.slice(0, 60)}`);
  }
  const doc = await HwpxDoc.load(await zipHwpx(files, order));
  const preview = previewText(doc);
  const before = files.has('Preview/PrvText.txt') ? Buffer.from(files.get('Preview/PrvText.txt')).toString('utf8') : null;
  if (before !== preview) {
    if (check) pending.push('Preview/PrvText.txt');
    else { files.set('Preview/PrvText.txt', new TextEncoder().encode(preview)); if (!order.includes('Preview/PrvText.txt')) order.push('Preview/PrvText.txt'); changed.push('Preview/PrvText.txt'); }
  }
  return { bytes: changed.length ? await zipHwpx(files, order) : bytes, changed, pending };
}

/** 고칠 문서와 바꿀 글. 표지 제목에 메뉴 번호('6. 튜토리얼 —')를 넣지 않는다 — 같은 연습 보고서를 'AI 활용 심화'·'AI로 보고서 만들기'가 함께 쓴다 */
export const FIXES = [
  { file: path.join('tutorial', 'AI 활용 심화 — 연습 보고서.hwpx'), replace: [
    { file: 'Contents/section0.xml', from: '<hp:t>6. 튜토리얼 — AI 활용 심화<hp:lineBreak/>재수강 제도 운영 분석(연습용 가상 자료)</hp:t>', to: '<hp:t>튜토리얼 연습 보고서<hp:lineBreak/>재수강 제도 운영 분석(연습용 가상 자료)</hp:t>' },
    // 안내 글의 기관 부서 이름을 뺀다(배포 예제에 기관 표기를 두지 않는다 — scripts/release_branding.py 와 같은 원칙)
    { file: 'Contents/section1.xml', from: /보고서의 꼴만 \S+ 표준서식을 따름\./, to: '보고서의 꼴만 표준서식을 따름.' },
  ] },
];

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  // --preview <파일…>: 그 파일들의 미리보기 글만 다시 쓴다(build-tutorial-doc.py 처럼 템플릿 미리보기 글을 그대로 옮기는 생성기 뒤에 부른다)
  const at = args.indexOf('--preview');
  const targets = at >= 0 ? args.slice(at + 1).filter((a) => !a.startsWith('--')).map((f) => ({ file: path.resolve(f), replace: [] })) : FIXES;
  if (at >= 0 && !targets.length) throw new Error('--preview 뒤에 HWPX 파일을 주세요');
  let left = 0;
  for (const fix of targets) {
    const file = path.resolve(root, fix.file);
    const out = await refreshHwpx(fs.readFileSync(file), { replace: fix.replace, check });
    if (!check && out.changed.length) fs.writeFileSync(file, out.bytes);
    left += out.pending.length;
    console.log(JSON.stringify({ file: fix.file, changed: out.changed, pending: out.pending }));
  }
  if (check && left) process.exitCode = 1;
}

// 다른 생성기가 previewText·zipHwpx 만 가져다 쓸 때는 실행하지 않는다(Windows 드라이브 글자 크기는 무시)
if (path.resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
