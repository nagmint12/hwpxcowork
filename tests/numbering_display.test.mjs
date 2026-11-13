// node --test tests/numbering_display.test.mjs — 번호가 한/글과 같은 글자로 보이는가(각주·미주·쪽 번호·문단 번호·개요·글머리표).
// 정답지는 한/글 2022 PDF 글자(tests/fixtures/numbering/display/*.hangul.json). 시험지와 정답지를 다시 만들려면:
//   python -I tests/fixtures/numbering/display/gen_numbering.py <out.hwpx> [--begin77] [--no-last-footnotes]
//   python -I tests/fixtures/numbering/display/gen_pages.py <out.hwpx>
//   python -I tests/fixtures/numbering/display/gen_onpage.py <out.hwpx> [--begin77] [--break-at F11|W] [--split-newnum] [--chain [--chain2]]
//   python -I tests/fixtures/numbering/display/scramble_numbers.py <한/글 저장.hwpx> <out.hwpx>  (onpage_saved_scrambled = onpage 를 한/글이 저장한 것)
//   python -I tests/hangul_roundtrip.py <out.hwpx> <dir> --pdf  → <dir>/view.pdf 의 쪽별 get_text() 를 JSON 배열로.
// 문단마다 〔태그〕를 달아 번호 글자를 찾는다. 쪽 나눔 차이(어느 쪽에 실렸나)는 보지 않고 글자만 견준다.
// RHWP_PKG=<pkg 폴더> 로 다른 빌드를 볼 수 있다(기본 vendor/rhwp/pkg).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const dir = path.join(here, 'fixtures', 'numbering', 'display');
const pkgDir = process.env.RHWP_PKG ? path.resolve(process.env.RHWP_PKG) : path.join(root, 'vendor', 'rhwp', 'pkg');
if (typeof globalThis.measureTextWidth !== 'function') globalThis.measureTextWidth = (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!globalThis.__rhwpEngineReady?.has(pkgDir)) {
  mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });
  (globalThis.__rhwpEngineReady ??= new Set()).add(pkgDir);
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// PDF 글자 뽑기의 군더더기: 한자 六 이 호환 글자(U+F9D1)로 나온다.
const norm = (s) => s.replace(/\s+/g, '').replace(/六/g, '六');

function open(name) {
  const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(path.join(dir, name))));
  doc.convertToEditable();
  return doc;
}
function enginePages(doc) {
  const pages = [];
  for (let p = 0; p < doc.pageCount(); p++) {
    pages.push(norm([...doc.renderPageSvg(p).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1])).join('')));
  }
  return pages;
}

/** 쪽 글자에서 태그별 번호 글자. 머리말·쪽 번호 위치는 쪽마다(쪽 번호·총 쪽수). */
function extract(pages) {
  const out = {};
  const between = (txt, from, close) => txt.slice(from, txt.indexOf(close, from));
  pages.forEach((txt, pi) => {
    for (const m of txt.matchAll(/〔([A-Z]+[\d_]*)〕/g)) {
      const tag = m[1];
      const end = m.index + m[0].length;
      if (/^Q/.test(tag)) out[tag] = between(txt, end, '〔q〕');
      else if (/^[FE]\d+$/.test(tag)) out[`${tag} 본문 표시`] = between(txt, end, `〔${tag.toLowerCase()}〕`).replace(/^앞/, '');
      else if (/^P\d+$/.test(tag)) out[`${tag} 본문 쪽 번호`] = between(txt, end, `〔${tag.toLowerCase()}〕`);
      else if (tag === 'H') out[`${pi + 1}쪽 머리말 쪽/총`] = between(txt, end, '〔h〕');
      else {
        const before = txt.slice(0, m.index);
        // 주석 번호 앞에 꼬리말 쪽 번호(-x-)가 붙어 나오는 PDF 순서 군더더기는 뺀다
        const pre = before.slice(before.lastIndexOf('〕') + 1).replace(/^-[^-]{1,6}-/, '');
        if (/^G/.test(tag)) out[`${tag.slice(1)} 주석 번호`] = pre;
        else if (/^[ONBM]\d+$/.test(tag)) out[`${tag} 문단 번호`] = pre;
      }
    }
    const pn = [...txt.matchAll(/-([^-〔〕]{1,6})-/g)].map((m) => m[1]);
    if (pn.length) out[`${pi + 1}쪽 쪽 번호 위치`] = pn.join(',');
  });
  return out;
}

// PDF 글자 차례 군더더기: 쪽을 넘는 문단의 마지막 줄 글이 각주 번호 앞에 붙어 나온다.
const PDF_NOISE = { 'onpage_split_newnum.hwpx': ['F01 주석 번호'] };

function diffWith(oracle, doc, skip = []) {
  const hangul = extract(JSON.parse(fs.readFileSync(path.join(dir, oracle), 'utf8')).map(norm));
  const engine = extract(enginePages(doc));
  const diff = Object.keys(hangul).filter((k) => !skip.includes(k) && hangul[k] !== engine[k])
    .map((k) => `${k}: 한글 ${JSON.stringify(hangul[k])} / 엔진 ${JSON.stringify(engine[k] ?? null)}`);
  return { diff, count: Object.keys(hangul).length };
}

function compare(name, oracle = name.replace(/\.hwpx$/, '.hangul.json')) {
  const doc = open(name);
  try {
    return diffWith(oracle, doc, PDF_NOISE[name]);
  } finally {
    doc.free();
  }
}

for (const name of ['notes.hwpx', 'notes_begin77.hwpx', 'endnotes_no_footnote.hwpx', 'page_formats.hwpx']) {
  test(`번호 글자가 한/글과 같다 — ${name}`, () => {
    const { diff, count } = compare(name);
    assert.ok(count > 40, `정답지 항목이 너무 적다(${count})`);
    assert.deepEqual(diff, []);
  });
}

// 쪽마다 새로(ON_PAGE) 각주 — 쪽이 정해진 뒤 매긴다. 번호는 쪽마다 1(구역 newNum·문서 시작번호 무시), 새 번호는 그 쪽
// 끝까지, 표 칸 안은 문서 차례, 다단은 쪽 단위, 이어지는 긴 각주는 다음 쪽 셈 밖, 뒤 이어서 구역은 2(각주가 있었으면).
for (const [name, oracle] of [['onpage.hwpx'], ['onpage_begin77.hwpx'], ['onpage_saved_scrambled.hwpx', 'onpage.hangul.json'],
  ['onpage_break_f11.hwpx'], ['onpage_break_w.hwpx'], ['onpage_split_newnum.hwpx'], ['onpage_chain.hwpx'], ['onpage_chain2.hwpx']]) {
  test(`쪽마다 새로 각주 번호가 한/글과 같다 — ${name}`, () => {
    const { diff, count } = compare(name, oracle);
    assert.ok(count > 30, `정답지 항목이 너무 적다(${count})`);
    assert.deepEqual(diff, []);
  });
}

test('쪽마다 새로 — 편집으로 각주·새 번호가 다음 쪽으로 밀리면 그 쪽 셈으로 다시 매긴다', () => {
  // 시험지 구역 0 의 문단 차례: 3 = 〔W〕(새 번호 30), 45 = 〔F11〕. 한/글 정답지는 그 문단을 새 쪽에서 시작한 시험지.
  for (const [para, oracle] of [[45, 'onpage_break_f11.hangul.json'], [3, 'onpage_break_w.hangul.json']]) {
    const doc = open('onpage.hwpx');
    try {
      assert.equal(JSON.parse(doc.insertPageBreak(0, para, 0)).ok, true);
      const { diff } = diffWith(oracle, doc);
      assert.deepEqual(diff, [], oracle);
    } finally {
      doc.free();
    }
  }
});

test('각주·미주를 넣고 지우면 한/글 셈으로 다시 매긴다(다른 구역 표시까지)', () => {
  const doc = open('notes.hwpx');
  try {
    const marks = () => {
      const txt = enginePages(doc).join('');
      return Object.fromEntries([...txt.matchAll(/〔([FE]\d+)〕앞(.*?)〔[fe]\d+〕/g)].map((m) => [m[1], m[2]]));
    };
    const first = marks();
    assert.deepEqual([first.F01, first.F04, first.F05, first.F07, first.F08, first.E02, first.E04, first.E05, first.E06],
      ['1)', '77)', '⑤', '⑳', '[U]', '77)', '다)', '㉱)', '**']);
    JSON.parse(doc.insertFootnote(0, 0, 3)); // 구역 0 첫 각주 앞
    let m = marks();
    assert.deepEqual([m.F01, m.F03, m.F04, m.F05], ['2)', '4)', '77)', '⑤']); // 새 번호 77·구역마다 새로는 그대로
    const en = JSON.parse(doc.insertEndnote(2, 0, 3)); // 구역 2(미주 구역마다 새로 3) 첫 미주 앞
    assert.equal(en.endnoteNumber, 3);
    m = marks();
    assert.deepEqual([m.E04, m.E05, m.E06, m.E07], ['라)', '㉲)', '††', '‡‡']); // 뒤 구역(이어서)까지 하나씩 밀림
    JSON.parse(doc.deleteFootnote(0, 0, 4));
    m = marks();
    assert.deepEqual([m.F01, m.F03], ['1)', '3)']);
  } finally {
    doc.free();
  }
});
