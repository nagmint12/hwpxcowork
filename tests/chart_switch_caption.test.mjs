// 한/글 차트의 hp:switch 안 캡션(2026-11-17): 한/글 2022 는 캡션 단 차트를 <hp:switch><hp:case ooxmlchart><hp:chart>…<hp:caption>…</hp:case>
// <hp:default><hp:ole>…<hp:caption>…</hp:default></hp:switch> 처럼 두 갈래에 캡션을 두 벌 쓴다. 엔진은 첫 갈래 캡션만 문단 주소 하나로 보이고
// (대체 갈래 사본 = alt, ref '/d'), 사본의 표식은 변경이 아니며(한/글은 사본을 TcId="0" 넣음으로 감싸 쓴다), 캡션 글을 고쳐 저장하면 사본을 첫 갈래
// 글에 맞춘다(engine/chart-parts.js syncSwitchCopies). 한/글 COM 실측 근거는 engine/section.js·engine/chart-parts.js 주석.
//  · chart_hangul_caption_tracked.hwpx = 엔진이 캡션(변경 추적 넣음)을 단 차트 문서를 한/글 2022 가 다시 저장한 것
//  · chart_hangul_caption.hwpx = 그 캡션 사본을 첫 갈래와 같게 한 파일을 한/글 2022 가 모두 수락하고 다시 저장한 것(사본에 TcId="0" 표식만 남음)
//   node --test tests/chart_switch_caption.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { fixture } from './helpers/server.mjs';

const TRACKED = fixture('chart_hangul_caption_tracked.hwpx');
const PLAIN = fixture('chart_hangul_caption.hwpx');
const load = async (f) => HwpxDoc.load(fs.readFileSync(f));
const refs = (d, view) => d.paragraphs(view ? { view } : {}).map((p) => [p.ref, p.text]);
/** 저장한 구역 XML 의 캡션 글(case, default 차례) — 자동 번호는 # */
const captions = (xml) => [...xml.matchAll(/<hp:caption\b[\s\S]*?<\/hp:caption>/g)]
  .map((m) => m[0].replace(/<hp:autoNum\b[\s\S]*?<\/hp:autoNum>/g, '#').replace(/<[^>]*>/g, ''));
const branchXml = (xml, tag) => { const s = xml.slice(xml.indexOf(`<${tag}`)); return s.slice(0, s.indexOf(`</${tag}>`)); };

test('한/글 저장본: 캡션 문단은 주소 하나(s0/p1/n0) — 모든 보기에서 대체 갈래 사본은 없다', async () => {
  for (const f of [TRACKED, PLAIN]) {
    const d = await load(f);
    const cap = '[그림 ] 시험 차트 캡션';
    assert.deepEqual(refs(d), [['s0/p0', ''], ['s0/p1', ''], ['s0/p1/n0', cap]]);
    for (const view of ['original', 'markup', 'all']) assert.equal(d.paragraphs({ view }).filter((p) => p.parent).length, 1, `${view} 보기`);
    assert.equal(d.paragraphs().find((p) => p.ref === 's0/p1/n0').container, 'hp:switch');
    assert.throws(() => d.resolve('s0/p1/n1'), /NO_PARAGRAPH|찾을 수 없습니다/);
    // 사본은 '/d' 기록으로 남아 있다(지운 개체 안 문단처럼 주소로 고칠 수 없다)
    const alt = d.sections[0].paras.filter((p) => p.alt);
    assert.deepEqual(alt.map((p) => [p.ref, p.hidden]), [['s0/p1/d0', true]]);
    assert.ok(!Section.visibleParagraph(alt[0], 'original') && !Section.visibleParagraph(alt[0], 'all'));
  }
});

test('사본의 표식은 변경이 아니다(유령 변경·머리 항목 없음) — 고치지 않고 저장하면 구역 XML 그대로', async () => {
  const t = await load(TRACKED);
  assert.equal(t.normalized, 0);
  assert.deepEqual(t.changes().map((c) => [c.id, c.type, c.ref, c.text]), [[1, 'Insert', 's0/p1/n0', '시험 차트 캡션']]);
  assert.equal(t.header.changes().length, 1);
  const p = await load(PLAIN); // 한/글이 모두 수락한 뒤: 사본에만 TcId="0" 넣음 표식이 남아 있다
  assert.match(branchXml(p.sections[0].xml, 'hp:default'), /<hp:insertBegin Id="1" TcId="0"\/>/);
  assert.deepEqual(p.changes(), []);
  assert.deepEqual(p.header.changes(), []);
  for (const f of [TRACKED, PLAIN]) {
    const d = await load(f); const before = d.sections[0].xml;
    const re = await HwpxDoc.load(Buffer.from(await d.save()));
    assert.equal(re.sections[0].xml, before, '글이 같으면 사본을 건드리지 않는다');
  }
  assert.deepEqual(t.memos(), []);
});

test('캡션 글 바꿈(변경 추적) → 저장하면 대체 갈래 사본도 같은 글·같은 표식 번호, 다시 읽어도 주소 하나', async () => {
  const d = await load(PLAIN);
  const at = d.text('s0/p1/n0', 'final').indexOf('시험');
  d.replaceTracked('s0/p1/n0', at, at + 2, '새', { author: '시험' });
  assert.deepEqual(refs(d).at(-1), ['s0/p1/n0', '[그림 ] 새 차트 캡션']);
  const out = Buffer.from(await d.save());
  const xml = d.sections[0].xml;
  assert.deepEqual(captions(xml), ['[그림 #] 시험새 차트 캡션', '[그림 #] 시험새 차트 캡션']);
  const marks = (s) => [...s.matchAll(/<hp:(insert|delete)(Begin|End) Id="(\d+)" TcId="(\d+)"/g)].map((m) => m.slice(1).join(':'));
  const caseCap = branchXml(xml, 'hp:case'); const defCap = branchXml(xml, 'hp:default');
  assert.deepEqual(marks(defCap), marks(caseCap));
  assert.match(defCap, /lastWidth="4294967295"/, '캡션·subList 속성은 그대로');
  const re = await HwpxDoc.load(out);
  assert.equal(re.normalized, 0);
  assert.deepEqual(refs(re), [['s0/p0', ''], ['s0/p1', ''], ['s0/p1/n0', '[그림 ] 새 차트 캡션']]);
  assert.deepEqual(re.changes().map((c) => [c.type, c.ref, c.text]), [['Delete', 's0/p1/n0', '시험'], ['Insert', 's0/p1/n0', '새']]);
  // 수락하면 두 갈래 모두 표식이 풀린다(같은 번호의 범위를 모두 푼다)
  re.acceptAll();
  assert.deepEqual(re.changes(), []);
  assert.doesNotMatch(re.sections[0].xml, /<hp:(insert|delete)Begin/);
  assert.deepEqual(captions(re.sections[0].xml), ['[그림 #] 새 차트 캡션', '[그림 #] 새 차트 캡션']);
});

test('캡션 넣음 거절 → 사본도 같은 글로 맞춘다', async () => {
  const d = await load(TRACKED);
  d.rejectAll();
  assert.deepEqual(refs(d).at(-1), ['s0/p1/n0', '[그림 ] ']);
  await d.save();
  assert.deepEqual(captions(d.sections[0].xml), ['[그림 #] ', '[그림 #] ']);
});

test('구역 부분 다시 읽기 = 전체 다시 읽기(차트 앞에 문단 넣기·캡션 고치기)', async () => {
  const d = await load(PLAIN);
  d.insertParagraphAfter(0, 0, '앞 문단', { author: '시험' });
  const at = d.text('s0/p2/n0', 'final').indexOf('시험');
  d.replaceTracked('s0/p2/n0', at, at + 2, '다른', { author: '시험' });
  const sec = d.sections[0]; const full = new Section(sec.xml, 0);
  const shape = (s) => s.paras.map((p) => [p.ref, !!p.alt, !!p.hidden, Section.text(p, 'all')]);
  assert.deepEqual(shape(sec), shape(full));
  assert.deepEqual(refs(d).map((r) => r[0]), ['s0/p0', 's0/p1', 's0/p2', 's0/p2/n0']);
});

test('갈래 규칙: hp:case 없이 hp:default 만 있으면 그 갈래가 보이고, 빈 hp:case 뒤 hp:default 와 둘째 hp:case 는 사본', async () => {
  const d = await load(PLAIN);
  const xml = d.sections[0].xml;
  const i = xml.indexOf('<hp:case'); const j = xml.indexOf('</hp:case>') + '</hp:case>'.length;
  const caseXml = xml.slice(i, j);
  const vis = (x) => new Section(x, 0).paras.filter((p) => p.parent).map((p) => [p.ref, !!p.alt]);
  assert.deepEqual(vis(xml.slice(0, i) + xml.slice(j)), [['s0/p1/n0', false]], 'default 만');
  assert.deepEqual(vis(xml.slice(0, i) + '<hp:case hp:required-namespace="x"/>' + xml.slice(j)), [['s0/p1/d0', true]], '빈 case 뒤 default');
  assert.deepEqual(vis(xml.slice(0, j) + caseXml + xml.slice(j)), [['s0/p1/n0', false], ['s0/p1/d0', true], ['s0/p1/d1', true]], '둘째 case');
});
