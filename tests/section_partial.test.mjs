// 구역 부분 다시 읽기(engine/section.js — 2026-11-16): 문단 하나를 고칠 때 구역 전체가 아니라 바뀐 본문 기록만 다시 읽는다.
// 검증 모드(HWPX_SECTION_VERIFY=1)로 돌린다 — 부분 다시 읽기마다 같은 XML 의 전체 다시 읽기와 토큰·기록(자리·번호·ref·묶인 member·변경 표식 짝)을
// 모두 견주고 다르면 던진다. 다시 읽기 전에 얻은 뒤쪽 기록을 다시 읽은 뒤에 읽는 부르는 쪽(staleReads)도 없어야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HWPX_SECTION_VERIFY = '1';
const { Section, sectionLoadStats, staleReads } = await import('../engine/section.js');
const { HwpxDoc } = await import('../engine/doc.js');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.hwpx')).sort();
const load = async (name) => HwpxDoc.load(fs.readFileSync(path.join(FIX, name)));
const counts = () => ({ partial: sectionLoadStats.partial, full: sectionLoadStats.full, why: { ...sectionLoadStats.why } });
const grew = (before, key) => (sectionLoadStats.why[key] || 0) - (before.why[key] || 0);

/** 본문 기록 몇 개(처음·가운데·끝·묶인 기록·표를 품은 기록)를 고른다 */
function sample(sec) {
  const b = sec.bodyParas; const out = new Set([0, b.length >> 1, b.length - 1]);
  b.forEach((p, i) => { if (p.members || p.children.length) out.add(i); });
  return [...out].filter((i) => i >= 0 && i < b.length).slice(0, 12);
}

test('XML 을 직접 바꿔도 부분 다시 읽기 = 전체 다시 읽기(모든 시험 문서·모든 구역)', async () => {
  const before = counts();
  for (const name of fixtures) {
    const doc = await load(name);
    for (const sec of doc.sections) {
      const xml0 = sec.xml;
      for (const i of sample(sec)) {
        const p = sec.bodyParas[i];
        const t = p.ts.find((x) => !x.selfclose && x.closeStart > x.openEnd);
        const cases = [
          // 글 바꾸기(hp:t 안)
          t && (xml0.slice(0, t.openEnd) + '바뀐글&amp;' + xml0.slice(t.closeStart)),
          // 기록 지우기 · 같은 기록을 뒤에 한 번 더 · 기록 앞에 넣기
          sec.bodyParas.length > 1 && (xml0.slice(0, p.start) + xml0.slice(p.end)),
          xml0.slice(0, p.end) + xml0.slice(p.start, p.end) + xml0.slice(p.end),
          xml0.slice(0, p.start) + '<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>새 문단</hp:t></hp:run></hp:p>' + xml0.slice(p.start),
          // 기록 안 아무 자리에 글자 하나(태그 안이면 속성이 깨진 XML — 전체 다시 읽기와 같기만 하면 된다)
          xml0.slice(0, (p.start + p.end) >> 1) + 'Z' + xml0.slice((p.start + p.end) >> 1),
        ].filter(Boolean);
        for (const x of cases) {
          sec.load(x);
          sec.load(xml0);
        }
      }
      assert.equal(sec.xml, xml0, `${name} s${sec.index} 되돌림`);
    }
  }
  assert.ok(sectionLoadStats.partial - before.partial > 200, `부분 다시 읽기 ${sectionLoadStats.partial - before.partial}번`);
  assert.equal(staleReads.size, 0, [...staleReads.keys()].join('\n'));
});

test('구역 뿌리 태그·짝 없는 태그·같은 XML 은 경계 규칙대로', async () => {
  const doc = await load('tool_memo_tracked.hwpx');
  const sec = doc.sections[0]; const xml0 = sec.xml;
  let c = counts();
  sec.load(xml0.replace('<hs:sec ', '<hs:sec data-x="1" '));
  assert.equal(grew(c, 'root'), 1, '뿌리 태그를 바꾸면 전체 다시 읽기');
  sec.load(xml0);
  c = counts();
  const p = sec.bodyParas[sec.bodyParas.length >> 1];
  sec.load(xml0.slice(0, p.end) + '<hp:p id="0"><hp:run charPrIDRef="0"><hp:t>열린 채' + xml0.slice(p.end));
  assert.ok(grew(c, 'unbalanced') + grew(c, 'open-tag') + grew(c, 'root') >= 1, `짝이 안 맞으면 전체 다시 읽기 ${JSON.stringify(sectionLoadStats.why)}`);
  sec.load(xml0);
  c = counts();
  const seq = sec.loadSeq; const stamp = sec.stamp; const paras = sec.paras;
  sec.load(xml0);
  assert.equal(sectionLoadStats.partial - c.partial, 1, '같은 XML 은 부분 다시 읽기');
  assert.ok(sec.loadSeq > seq && sec.stamp > stamp && sec.paras !== paras, '같은 XML 이어도 읽은 차례·새 배열');
  // 구역 끝(</hs:sec> 바로 앞)에 문단 넣기
  c = counts();
  const end = xml0.lastIndexOf('</hs:sec>');
  sec.load(xml0.slice(0, end) + '<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>끝</hp:t></hp:run></hp:p>' + xml0.slice(end));
  assert.equal(sectionLoadStats.partial - c.partial, 1, '구역 끝에 넣기도 부분');
  assert.equal(sec.bodyParas.at(-1).ref, `s0/p${sec.bodyParas.length - 1}`);
});

test('엔진 편집(변경 추적·문단 나눔·나눔 지우기·수락·거절)도 부분 다시 읽기 = 전체', async () => {
  const before = counts();
  const opts = { author: '부분 시험', date: new Date('2026-11-16T09:00:00Z') };
  for (const name of fixtures.filter((f) => /trk|tracked|memo|codes/.test(f))) {
    const doc = await load(name);
    const refs = () => doc.sections.flatMap((s) => s.bodyParas.map((p) => p.ref));
    const pick = (k) => { const r = refs(); return r[Math.min(r.length - 1, Math.floor(r.length * k))]; };
    const tryOp = (fn) => { try { fn(); } catch (e) { if (!e.code) throw e; } };   // 엔진이 그 자리에서 거절하는 편집(EngineError)은 넘긴다
    for (const k of [0.1, 0.5, 0.9]) {
      tryOp(() => { const ref = pick(k); const cur = doc.text(ref, 'final'); doc.mergeParagraphText(ref, `${cur.slice(0, 3)}(고침)${cur.slice(3)}`, opts); });
      tryOp(() => doc.splitParagraphTracked(pick(k), 1, opts));
      tryOp(() => doc.deleteBreakAfter(pick(k), opts));
      tryOp(() => doc.insertParagraphAfter?.(0, Math.floor(doc.sections[0].bodyParas.length * k), '넣은 문단', opts));
    }
    const ids = doc.changes().map((c) => Number(c.id)).filter(Number.isInteger);
    tryOp(() => doc.resolveChanges(ids.slice(0, Math.ceil(ids.length / 2)), 'accept', { tolerant: true }));
    tryOp(() => doc.resolveChanges(doc.changes().map((c) => Number(c.id)), 'reject', { tolerant: true, keepIfStuck: true }));
    // 저장한 것을 다시 열면 같은 문서
    const again = await HwpxDoc.load(Buffer.from(await doc.save()));
    assert.deepEqual(again.sections.map((s) => s.xml), doc.sections.map((s) => s.xml), name);
  }
  assert.ok(sectionLoadStats.partial - before.partial > 20, `부분 다시 읽기 ${sectionLoadStats.partial - before.partial}번 ${JSON.stringify(sectionLoadStats.why)}`);
  assert.equal(staleReads.size, 0, [...staleReads.keys()].join('\n'));
});

test('무작위 잘라 붙이기(깨진 XML 포함, 이어서 여러 번)도 부분 다시 읽기 = 전체', async () => {
  // 고정 씨앗 난수(시험이 늘 같은 길로)
  let seed = Number(process.env.SECTION_FUZZ_SEED) || 20261116;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const before = counts();
  for (const name of ['tool_memo_tracked.hwpx', 'hangul_trk_brk_sel_para.hwpx', 'hangul_trk_tbl_insert.hwpx', 'codes_hangul_cells.hwpx', 'hangul_trk_brk_enter_mid.hwpx']) {
    const doc = await load(name);
    const sec = doc.sections.reduce((a, b) => (a.xml.length >= b.xml.length ? a : b));
    const xml0 = sec.xml;
    const pieces = ['<hp:p id="0">', '</hp:p>', '<hp:run charPrIDRef="0">', '</hp:run>', '<hp:t>', '</hp:t>', '가나', '&amp;', '<hp:lineBreak/>', '"', '>', '<', ''];
    for (let k = 0; k < 240; k++) {
      const x = sec.xml; const n = x.length; const b = sec.bodyParas;
      const op = rnd(10);
      const p = b.length ? b[rnd(b.length)] : null; const q = b.length ? b[rnd(b.length)] : null;
      const ts = p ? p.ts.filter((t) => !t.selfclose) : [];
      let next;
      if (op <= 2 && ts.length) { const t = ts[rnd(ts.length)]; next = x.slice(0, t.openEnd) + ['', '바뀐 글', '&lt;표&gt;', '가'.repeat(rnd(40))][rnd(4)] + x.slice(t.closeStart); } // 글 바꾸기
      else if (op === 3 && p && b.length > 2) next = x.slice(0, p.start) + x.slice(p.end);                         // 기록 지우기
      else if (op <= 5 && p && q) next = x.slice(0, q.end) + x.slice(p.start, p.end) + x.slice(q.end);             // 다른 기록 베껴 넣기
      else if (op === 6 && p && q && p !== q) { const [u, v] = p.start < q.start ? [p, q] : [q, p]; next = x.slice(0, u.start) + x.slice(v.start, v.end) + x.slice(u.end, v.start) + x.slice(u.start, u.end) + x.slice(v.end); } // 두 기록 맞바꾸기
      else if (op === 7) { const at = rnd(n); const len = rnd(3) === 0 ? rnd(Math.min(200, n - at)) : 0; next = x.slice(0, at) + pieces[rnd(pieces.length)] + x.slice(at + len); } // 아무 자리에 조각(깨질 수 있음)
      else if (op === 8) { const at = rnd(n); next = x.slice(0, at) + x.slice(at + 1 + rnd(50)); }                  // 아무 자리 지우기(깨질 수 있음)
      else next = xml0;                                                                                              // 처음으로(깨진 상태 → 온전한 상태)
      sec.load(next);
    }
    sec.load(xml0);
  }
  assert.ok(sectionLoadStats.partial - before.partial > 100, `부분 다시 읽기 ${sectionLoadStats.partial - before.partial}번 ${JSON.stringify(sectionLoadStats.why)}`);
  assert.equal(staleReads.size, 0);
});

test('Section 을 새로 만들면 전체 읽기, 읽다가 실패해도 구역은 그대로', () => {
  const s = new Section('<hs:sec><hp:p id="0"><hp:run charPrIDRef="0"><hp:t>가</hp:t></hp:run></hp:p></hs:sec>', 0);
  assert.equal(s.bodyParas.length, 1);
  const xml = s.xml; const paras = s.paras;
  const orig = Section.prototype._run;
  Section.prototype._run = function () { throw new Error('읽기 실패'); };
  try { assert.throws(() => s.load('<hs:sec><hp:p id="0"></hp:p></hs:sec>'), /읽기 실패/); } finally { Section.prototype._run = orig; }
  assert.equal(s.xml, xml); assert.equal(s.paras, paras);
});
