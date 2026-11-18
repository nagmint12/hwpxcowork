// node --test tests/tutorial_backgrounds.test.mjs — 튜토리얼·설명서 원본 8개는 1~3쪽도 4쪽처럼 쪽배경(홀짝 바탕쪽)을 보인다
// (2026-11-18 사용자 결정. 11-17 에는 1~3쪽 바탕쪽을 감춰 두었다). 변환은 scripts/tutorial_backgrounds.py — 생성기가 표준서식 검사 뒤에 부른다.
// 웹 표시는 편집기 엔진 계산값(쪽마다 바탕쪽 그림)으로 본다. 한/글 쪽 그림 근거는 artifacts/tutorial-background-visible-20261118/hangul-check.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { HwpDocument } from './helpers/rhwp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = process.env.HWPX_COWORK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'manuals', 'manifest.json'), 'utf8'));
const SOURCES = [
  ...['결과보고서.hwpx', 'AI 연결 — 사용자 가이드.hwpx', 'AI 활용 심화 — 연습 보고서.hwpx'].map((f) => path.join('tutorial', f)),
  ...manifest.documents.map((d) => path.join('docs', 'manuals', d.file)),
];

async function sections(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  return Promise.all(names.map((n) => zip.file(n).async('string')));
}

test('원본 8개: 모든 구역에 홀짝 바탕쪽이 연결되고 바탕쪽 감추기가 없다', async () => {
  for (const rel of SOURCES) {
    const secs = await sections(fs.readFileSync(path.join(root, rel)));
    assert.ok(secs.length >= 2, rel);
    for (const [i, xml] of secs.entries()) {
      const secPr = /<hp:secPr\b[^>]*>[\s\S]*?<\/hp:secPr>/.exec(xml)?.[0] || '';
      assert.match(secPr, /masterPageCnt="2"/, `${rel} 구역 ${i}`);
      assert.equal((secPr.match(/<hp:masterPage\b/g) || []).length, 2, `${rel} 구역 ${i}`);
    }
    assert.doesNotMatch(secs.join(''), /<hp:pageHiding\b[^>]*hideMasterPage="1"/, rel);
    // 아무것도 감추지 않는 감추기 조판 부호는 남기지 않는다
    for (const tag of secs.join('').match(/<hp:pageHiding\b[^>]*\/>/g) || []) assert.match(tag, /="1"/, `${rel}: ${tag}`);
  }
});

test('편집기 엔진: 원본 8개의 모든 쪽(1~3쪽 포함)에 바탕쪽 그림이 그려진다', () => {
  for (const rel of SOURCES) {
    const doc = new HwpDocument(fs.readFileSync(path.join(root, rel)));
    try {
      doc.convertToEditable();
      const n = doc.pageCount();
      assert.ok(n >= 4, rel);
      const missing = [];
      for (let p = 0; p < n; p++) if (!JSON.parse(doc.getPageSourceImageKeys(p)).keys.length) missing.push(p + 1);
      assert.deepEqual(missing, [], `${rel}: 쪽배경이 없는 쪽`);
    } finally { doc.free(); }
  }
});

test('변환 스크립트: 표준서식 생성기 꼴(앞부분 바탕쪽 없음·표지 6가지 감추기)을 고치고 두 번 돌려도 같다', async (t) => {
  const probe = spawnSync(py, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('python 없음 — 미검증'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-bg-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // 생성기가 막 만든 꼴로 되돌린 사본: 앞 구역 바탕쪽 떼기 + 표지 감추기는 바탕쪽까지 + 11-17 식 '바탕쪽만 감추기' 하나
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, 'tutorial', '결과보고서.hwpx')));
  const name = 'Contents/section0.xml';
  let xml = await zip.file(name).async('string');
  xml = xml.replace(/<hp:masterPage\b[^>]*\/>/g, '').replace(/(<hp:secPr\b[^>]*\bmasterPageCnt=")\d+"/, '$10"').replace(/hideMasterPage="0"/g, 'hideMasterPage="1"');
  xml = xml.replace(/(<hp:p\b[^>]*pageBreak="1"[^>]*><hp:run\b[^>/]*>)/,'$1<hp:ctrl><hp:pageHiding hideHeader="0" hideFooter="0" hideMasterPage="1" hideBorder="0" hideFill="0" hidePageNum="0"/></hp:ctrl>');
  assert.match(xml, /masterPageCnt="0"/);
  zip.file(name, xml);
  const file = path.join(tmp, 'raw.hwpx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const run = (...args) => spawnSync(py, ['-X', 'utf8', '-I', path.join(root, 'scripts', 'tutorial_backgrounds.py'), ...args, file], { encoding: 'utf8' });
  assert.equal(run('--check').status, 1, '바꿀 것이 있으면 --check 는 1');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout.trim());
  assert.deepEqual(report.linked, [name]);
  assert.equal(report.removed, 1);
  const secs = await sections(fs.readFileSync(file));
  assert.match(secs[0], /masterPageCnt="2"/);
  assert.doesNotMatch(secs.join(''), /hideMasterPage="1"/);
  assert.match(secs[0], /hideHeader="1" hideFooter="1" hideMasterPage="0" hideBorder="1" hideFill="1" hidePageNum="1"/, '표지의 다른 감추기는 남는다');
  const again = run('--check');
  assert.equal(again.status, 0, '두 번째는 바꿀 것이 없다');
  const doc = new HwpDocument(fs.readFileSync(file));
  try {
    doc.convertToEditable();
    for (let p = 0; p < doc.pageCount(); p++) assert.ok(JSON.parse(doc.getPageSourceImageKeys(p)).keys.length > 0, `쪽 ${p + 1}`);
  } finally { doc.free(); }
});
