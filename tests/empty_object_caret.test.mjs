// (2026-11-03) 글 없이 떠 있는 개체(글자처럼 취급 아님)만 든 문단의 캐럿 자리 — 렌더 트리에 그 문단의 줄이 없어 getCursorRect 가
// '커서 위치를 찾을 수 없습니다'였다(변경 추적으로 모든 글을 지운 문서의 첫 문단 — 편집기를 열 때마다 캐럿이 보이지 않음).
// 엔진 폴백(vendor/rhwp/src/document_core/queries/cursor_rect.rs empty_object_para_caret): 그 문단 첫 쪽 본문 단 왼쪽, 위아래 배치 개체 아래.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

test('빈 문단 + 떠 있는 위아래 배치 그림: 캐럿 자리를 찾고, 그림 아래·단 왼쪽이다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'toc_source.hwpx')));
  const sec = doc.sections[0]; const at = 11; const p = sec.bodyParas[at];
  assert.equal(doc.text(p.ref), '', '시험 문단은 글이 없다');
  const xml = sec.xml.slice(p.start, p.end);
  assert.match(xml, /<hp:pic [^>]*textWrap="TOP_AND_BOTTOM"[\s\S]*treatAsChar="1"/);
  sec.load(sec.xml.slice(0, p.start) + xml.replace('treatAsChar="1"', 'treatAsChar="0"') + sec.xml.slice(p.end));
  const d = new mod.HwpDocument(new Uint8Array(await doc.save()));
  const rect = JSON.parse(d.getCursorRect(0, at, 0));
  assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.height > 0, JSON.stringify(rect));
  // 그림 아래(그림 bbox 바닥 이상) — 같은 쪽 렌더 트리의 그 문단 그림
  const tree = JSON.parse(d.getPageRenderTree(rect.pageIndex));
  const pics = []; const walk = (n) => { if (n.type === 'Image' && n.pi === at) pics.push(n.bbox); (n.children || []).forEach(walk); }; walk(tree.root || tree);
  assert.ok(pics.length, '그 문단 그림이 같은 쪽에 그려진다');
  assert.ok(rect.y >= pics[0].y + pics[0].h - 0.5, `캐럿 y ${rect.y} ≥ 그림 바닥 ${pics[0].y + pics[0].h}`);
  // 글이 있는 문단·글자처럼 취급한 그림 문단의 캐럿은 그대로(폴백을 타지 않음)
  assert.doesNotThrow(() => d.getCursorRect(0, 0, 0));
});
