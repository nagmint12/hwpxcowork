// 캡션 달린 그림의 편집 보존(2026-11-12): 한/글은 그림 설명 hp:shapeComment 를 캡션 앞에, 편집기(rhwp) 내보내기는 캡션 뒤에 쓴다.
// 그림 지문·옮기기가 캡션 앞(머리)만 보면 ① 손대지 않은 문서가 거짓 그림 덩어리를 내고(다른 창이 다시 열림 — shapes_sync 시험),
// ② 그림 효과를 실제로 바꾼 밀어 넣기를 반영할 때 서버 쪽 설명(shapeComment)이 지워졌다. 이 시험은 ②를 본다(엔진만, 서버 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const FX = path.join(root, 'tests', 'fixtures', 'toc_source.hwpx'); // 한/글 그림 1개(캡션 + 설명 '그림입니다.…')
const picXml = async (bytes) => {
  const z = await JSZip.loadAsync(bytes);
  const s = await z.file('Contents/section0.xml').async('string');
  return (/<hp:pic\b[\s\S]*?<\/hp:pic>/.exec(s) || [''])[0];
};

test('캡션 그림의 효과를 바꿔 반영해도 서버의 그림 설명(shapeComment)이 남고, 손대지 않은 왕복은 덩어리 0', async () => {
  const src = fs.readFileSync(FX);
  const orig = await picXml(src);
  assert.match(orig, /<hp:shapeComment>[\s\S]*<hp:caption\b/, '시험 전제: 한/글 원본은 설명이 캡션 앞');

  // 손대지 않은 왕복 — 그림 덩어리 없음
  const rt = Buffer.from(new mod.HwpDocument(new Uint8Array(src)).exportHwpx());
  assert.match(await picXml(rt), /<\/hp:caption>\s*<hp:shapeComment>/, '시험 전제: 편집기 내보내기는 설명이 캡션 뒤');
  const r0 = await diffDocs(src, rt);
  assert.deepEqual(r0.hunks.filter((h) => h.type === 'object').map((h) => h.ref), []);

  // 편집기에서 네온을 켬 → 덩어리 → 서버 문서에 반영
  const d = new mod.HwpDocument(new Uint8Array(src));
  let at = null;
  for (let p = 0; p < d.getParagraphCount(0) && !at; p++) for (let c = 0; c < 4; c++) {
    try { if (JSON.parse(d.getObjectInfoH2022(0, p, '', c)).kind === 'picture') { at = { p, c }; break; } } catch { /* 개체 아님 */ }
  }
  assert.ok(at, '그림을 찾음');
  const res = JSON.parse(d.setPictureEffectsH2022(0, at.p, '', at.c, JSON.stringify({ glow: { alpha: 0.5, radius: 1000, color: '#FF0000' } })));
  assert.equal(res.ok, true);
  const head = Buffer.from(d.exportHwpx());
  const base = await HwpxDoc.load(src);
  const df = await diffDocs(base, await HwpxDoc.load(head));
  const objs = df.hunks.filter((h) => h.type === 'object');
  assert.equal(objs.length, 1, JSON.stringify(df.hunks.map((h) => [h.type, h.ref, h.objectSummary])));
  for (const h of objs) base.copyObjectsFrom(await HwpxDoc.load(head), h.headRef, h.ref);
  const saved = await picXml(Buffer.from(await base.save()));
  assert.match(saved, /<hp:glow\b/, '네온이 서버 문서에 들어감');
  assert.match(saved, /<hp:shapeComment>그림입니다\./, '서버 문서의 그림 설명이 그대로 남음');
  assert.equal((saved.match(/<hp:shapeComment>/g) || []).length, 1, '설명이 한 번만');
});
