// 스타일 들여오기·여러 문단 서식(2026-11-18 — docs/MCP_REDESIGN_2026-11-16.md §15). 모델을 부르지 않는다.
// 근거가 된 실제 실행: '표준서식에 맞춰줘' 지시를 Codex 가 표 칸마다 format op 3,141개로 냈다(스타일을 들여올 길·표 전체 대상이 없어서) — op 한도 오류, 120초 시간 초과, 6분.
//  · 엔진: 여러 문단을 한 번에 고친 결과가 문단마다 고친 것과 같다(formatParagraphs = formatRange), 서식 목록은 머리가 같으면 다시 훑지 않는다
//  · 구조 op: styles(표준서식 스타일 들여오기·새 스타일)와 restyle(범위·구역·표·칸 범위 대상) — 글·주소는 그대로, 대기 제안의 주소 따라 옮기기
//  · 새 연결: format 의 범위·표 대상과 styles op 가 제안 하나(서식)로 묶이고, 칸마다 낸 op 도 같은 제안 하나가 된다. 문단 몇 개는 예전처럼 문단마다 제안
//   node --test tests/mcp_v2_restyle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { containerFromBytesSync, docBytesSync } from '../engine/toc.js';
import { editPageLayout, restyleRefs, remapLayoutOps, layoutOpsRefs, standardStyleNames } from '../engine/page-layout.js';
import { parseOps, prepareOps, OPS_BRIEF, opsGuide, VISIBLE_OP_NAMES } from '../server/mcp2/ops.js';
import { EDITOR_INSTRUCTIONS_V2 } from '../server/editor-instructions.js';
import { activityItem } from '../server/activity.js';

const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');   // 표준서식 스타일이 있는 문서(표 5개)
const PLAIN = fixture('tool_memo_tracked.hwpx');                                  // 표준서식 스타일이 없는 문서(바탕글·본문·개요 …)
const open = (file) => new HwpxDoc(containerFromBytesSync(fs.readFileSync(file)));
const textOf = (doc) => doc.paragraphs({ view: 'final', nested: true }).map((p) => p.text).join('\n');
const styleOf = (doc, ref) => { const f = doc.inspectFormatting(ref); return doc.formattingCatalog().styles.find((s) => s.id === f.styleId)?.name; };
const textOfResult = (result) => (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (result) => { assert.ok(!result.isError, textOfResult(result)); return JSON.parse(textOfResult(result)); };

async function connect(srv, who, { query = '?v=2&tools=core' } = {}) {
  const client = new Client({ name: 'v2-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}` } } });
  await client.connect(transport);
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }), close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); } };
}

test('엔진: 여러 문단을 한 번에 고친 결과는 문단마다 고친 것과 같고, 서식 목록은 머리가 같으면 다시 훑지 않는다', () => {
  const base = open(REPORT);
  const table = base.tables().find((t) => t.key === 's1/p17#t0');
  // 빈 문단(본문·표 칸)도 함께 — 빈 문단은 글자 대신 빈 run 의 모양을 바꾼다(다른 갈래)
  const empties = base.paragraphs({ view: 'final', nested: true }).filter((p) => p.text === '' && p.where !== '메모').slice(0, 8).map((p) => p.ref);
  assert.ok(empties.length >= 2, '빈 문단이 있는 문서여야 한다');
  // 한 번에 고치기는 구역별로 모아 고친다 — 새 모양 번호가 만들어지는 차례가 같도록(구역 XML 을 글자 그대로 견준다) 문단마다 고치는 쪽도 구역별 차례로 준다
  const mixed = [...new Set([...table.cells.flatMap((c) => c.refs), 's1/p3', 's1/p4', 's0/p1', ...empties])];
  const secOf = (r) => /^s\d+/.exec(r)[0]; const secOrder = [...new Set(mixed.map(secOf))];
  const refs = secOrder.flatMap((sec) => mixed.filter((r) => secOf(r) === sec));
  const style = base.formattingCatalog().styles.find((s) => s.name === '&표내용__');
  for (const spec of [
    { char: { font: '맑은 고딕', sizePt: 9, bold: true, color: '#1F4E79' }, paragraph: { align: 'CENTER', lineSpacing: { type: 'PERCENT', value: 120 } } },
    { styleId: style.id },
    { styleId: style.id, char: { italic: true }, paragraph: { indentPt: 0 } },
  ]) {
    const a = open(REPORT); const b = open(REPORT);
    const out = a.formatParagraphs(refs, spec);
    for (const ref of refs) { const len = b.inspectFormatting(ref).length; b.formatRange(ref, { ...spec, start: 0, end: len }); }
    assert.equal(out.total, refs.length);
    assert.ok(out.changed > 0 && out.changed <= refs.length);
    for (const s of a.sections.keys()) assert.equal(a.sections[s].xml, b.sections[s].xml, `구역 ${s} XML — ${JSON.stringify(spec).slice(0, 60)}`);
    for (const ref of refs) {
      const x = a.inspectFormatting(ref); const y = b.inspectFormatting(ref);
      assert.deepEqual([x.text, x.paragraph, x.runs.map((r) => [r.start, r.end, r.char])], [y.text, y.paragraph, y.runs.map((r) => [r.start, r.end, r.char])], ref);
    }
    assert.equal(textOf(a), textOf(base), '글은 그대로');
    // 다시 열어도 같은 글·같은 서식(저장되는 XML 이 깨지지 않았다)
    const again = new HwpxDoc(containerFromBytesSync(docBytesSync(a)));
    assert.equal(textOf(again), textOf(base));
    // 같은 서식을 다시 주면 바뀌는 문단이 없다
    assert.equal(a.formatParagraphs(refs, spec).changed, 0);
  }
  // 받지 않는 것: 범위·모양 번호·쪽 나눔, 바꿀 것이 없는 입력, 없는 문단(문서는 그대로)
  const d = open(REPORT); const before = [d.header.xml, ...d.sections.map((s) => s.xml)];
  assert.throws(() => d.formatParagraphs(['s1/p3'], { start: 0, end: 1, char: { bold: true } }), (e) => e.code === 'FORMAT_SPEC');
  assert.throws(() => d.formatParagraphs(['s1/p3'], { paragraph: { pageBreakBefore: true } }), (e) => e.code === 'FORMAT_SPEC');
  assert.throws(() => d.formatParagraphs(['s1/p3'], {}), (e) => e.code === 'FORMAT_SPEC');
  assert.throws(() => d.formatParagraphs(['s1/p3', 's1/p999'], { char: { bold: true } }));
  assert.deepEqual([d.header.xml, ...d.sections.map((s) => s.xml)], before, '실패하면 문서는 그대로');
  // 서식 목록: 머리가 그대로면 다시 훑지 않고 같은 내용의 새 사본을 준다(받은 쪽이 고쳐도 다음 조회는 그대로), 머리가 바뀌면(새 글자 모양) 새로 읽는다
  const cat = d.formattingCatalog();
  assert.deepEqual(d.formattingCatalog(), cat); assert.notEqual(d.formattingCatalog(), cat);
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 200; i++) d.formattingCatalog(); const perCall = Number(process.hrtime.bigint() - t0) / 200 / 1e6;
  assert.ok(perCall < 20, `서식 목록 조회 한 번 ${perCall.toFixed(2)}ms — 머리가 같으면 다시 훑지 않는다(훑으면 이 문서에서 20ms 를 넘는다)`);
  d.formattingCatalog().styles.length = 0;
  assert.equal(d.formattingCatalog().styles.length, cat.styles.length);
  d.formatParagraphs(['s1/p3'], { char: { sizePt: 33 } });
  const next = d.formattingCatalog();
  assert.notEqual(next, cat); assert.equal(next.charProperties.length, cat.charProperties.length + 1);
  assert.ok(next.charProperties.some((c) => c.props.sizePt === 33));
});

test('구조 op: 대상 풀기(범위·구역·표·칸 범위), 스타일 들여오기·정의, 여러 문단 서식, 대기 제안의 주소 옮기기', () => {
  const doc = open(REPORT);
  const table = doc.tables().find((t) => t.key === 's1/p17#t0');
  // 대상 풀기: 범위·구역·'*' 는 본문 문단만, 표는 칸 문단(캡션 제외)
  assert.deepEqual(restyleRefs(doc, ['s1/p3..p5']), ['s1/p3', 's1/p4', 's1/p5']);
  assert.equal(restyleRefs(doc, ['s0']).length, doc.sections[0].bodyParas.length);
  assert.equal(restyleRefs(doc, ['*']).length, doc.sections.reduce((n, s) => n + s.bodyParas.length, 0));
  assert.equal(restyleRefs(doc, ['s0/p6..s1/p1']).length, doc.sections[0].bodyParas.length - 6 + 2);
  assert.deepEqual(restyleRefs(doc, ['s1/p17#t0']), table.cells.flatMap((c) => c.refs));
  const head = restyleRefs(doc, [{ table: 's1/p17#t0', row_from: 0, row_to: 0 }]);
  assert.deepEqual(head, table.cells.filter((c) => c.row === 0).flatMap((c) => c.refs));
  assert.deepEqual(restyleRefs(doc, [{ table: 's1/p17#t0', row_from: 1, col_from: 0, col_to: 0 }]), table.cells.filter((c) => c.row + c.rowSpan - 1 >= 1 && c.col === 0).flatMap((c) => c.refs));
  assert.deepEqual(restyleRefs(doc, ['s1/p3', head[0]]), ['s1/p3', head[0]]);
  assert.throws(() => restyleRefs(doc, ['s1/p3#t9']), (e) => e.code === 'NO_TABLE');
  assert.throws(() => restyleRefs(doc, ['s9']), (e) => e.code === 'NO_PARAGRAPH');
  assert.throws(() => restyleRefs(doc, ['s1/p70..p999']), (e) => e.code === 'NO_PARAGRAPH');
  assert.throws(() => restyleRefs(doc, ['s1/p9..p3']), (e) => e.code === 'RANGE');
  assert.throws(() => restyleRefs(doc, [{ table: 's1/p17#t0', row_from: 99 }]), (e) => e.code === 'RANGE');

  // 표준서식 스타일이 없는 문서: 들여오기 → 그 이름으로 서식, 새 스타일 정의. 글·주소는 그대로
  const plain = open(PLAIN); const before = textOf(plain);
  assert.ok(standardStyleNames(plain).some((s) => s.name === '&본문 1.') && !plain.formattingCatalog().styles.some((s) => s.name === '&본문 1.'));
  const ops = [
    { op: 'styles', import: 'standard', define: [{ name: '내 강조', base: '&본문 1.', char: { color: '#C00000' } }] },
    { op: 'restyle', at: ['s0/p0'], style: '&본문제목' },
    { op: 'restyle', at: ['s0/p1..p2'], style: '내 강조', paragraph: { align: 'LEFT' } },
  ];
  const out = editPageLayout(plain, ops);
  assert.match(out.labels[0], /^표준서식 스타일 들여오기 \d+개 · 스타일 정의 「내 강조」$/);
  assert.deepEqual(out.labels.slice(1), ['서식 1곳: 스타일 「&본문제목」', '서식 2곳: 스타일 「내 강조」·문단 모양']);
  assert.ok(out.mapping.every((m) => m.to && m.old.join('/') === m.to.join('/')) && out.refMapping.every((m) => m.old === m.to), '주소는 그대로');
  assert.equal(textOf(plain), before);
  assert.deepEqual(['s0/p0', 's0/p1', 's0/p2'].map((r) => styleOf(plain, r)), ['&본문제목', '내 강조', '내 강조']);
  const f = plain.inspectFormatting('s0/p1');
  assert.equal(f.paragraph.align, 'LEFT'); if (f.runs.length) assert.equal(f.runs[0].char.color, '#C00000');
  const again = new HwpxDoc(containerFromBytesSync(docBytesSync(plain)));
  assert.equal(textOf(again), before); assert.equal(styleOf(again, 's0/p0'), '&본문제목');
  // 다시 들여오면 더할 것이 없다. 있는 이름 정의·없는 스타일·빈 styles 는 오류
  assert.deepEqual(editPageLayout(again, [{ op: 'styles', import: 'standard' }]).labels, ['표준서식 스타일 들여오기 0개(이미 모두 있음)']);
  assert.throws(() => editPageLayout(open(PLAIN), [{ op: 'styles', define: [{ name: '바탕글' }] }]), (e) => e.code === 'STYLE_EXISTS');
  assert.throws(() => editPageLayout(open(PLAIN), [{ op: 'restyle', at: ['s0/p0'], style: '&본문제목' }]), (e) => e.code === 'NO_STYLE' && /import:'standard'/.test(e.message));
  assert.throws(() => editPageLayout(open(PLAIN), [{ op: 'styles' }]), (e) => e.code === 'PAGE_LAYOUT');

  // 대기 제안의 주소 옮기기: 본문 번호만 옮기고 꼬리(/n2·#t0)는 그대로, 지워진 문단·표는 목록에서 빠진다. 범위의 끝이 지워지면 lost
  const pending = [{ op: 'styles', import: 'standard' }, { op: 'restyle', at: ['s0/p2', 's0/p4/n3', 's0/p5..p8', 's0/p9#t0', { table: 's0/p9#t0', row_from: 0, row_to: 0 }, 's1', '*'], style: '바탕글' }];
  assert.deepEqual(layoutOpsRefs(pending), { lead: [1], trailing: false });
  const shift = remapLayoutOps(pending, (r) => { const m = /^s(\d+)\/p(\d+)$/.exec(r); return m[1] === '0' && Number(m[2]) >= 3 ? `s0/p${Number(m[2]) + 1}` : r; });
  assert.deepEqual(shift.ops[1].at, ['s0/p2', 's0/p5/n3', 's0/p6..p9', 's0/p10#t0', { table: 's0/p10#t0', row_from: 0, row_to: 0 }, 's1', '*']);
  assert.deepEqual([shift.changed, shift.lost], [true, false]);
  const gone = remapLayoutOps(pending, (r) => (r === 's0/p9' || r === 's0/p2' ? null : r));
  assert.deepEqual(gone.ops[1].at, ['s0/p4/n3', 's0/p5..p8', 's1', '*']); assert.equal(gone.lost, false);
  assert.equal(remapLayoutOps(pending, (r) => (r === 's0/p8' ? null : r)).lost, true);
  assert.equal(remapLayoutOps([{ op: 'restyle', at: ['s0/p2'], style: '바탕글' }], () => null).lost, true);
});

test('op 풀기: 여러 문단 format 과 styles 는 구조 묶음 하나로(styles → 서식 → 나머지), 문단 몇 개는 문단마다 제안', () => {
  const doc = open(REPORT);
  const prep = (ops) => { const parsed = parseOps(ops); assert.deepEqual(parsed.errors, []); return prepareOps(doc, parsed.ok); };
  // 도구 설명: format 의 범위·표 대상과 styles 가 있고, 안쪽 이름 restyle 은 없다
  const formatLine = OPS_BRIEF.split('\n').find((l) => l.includes("op:'format'"));
  assert.match(formatLine, /범위 's0\/p3\.\.p9'·구역 's1'·'\*'\(본문 문단\) \| 표 's0\/p3#t0'\(모든 칸\) \| \{table, row_from\?, row_to\?, col_from\?, col_to\?\}/); assert.match(formatLine, /칸·문단마다 op 를 내지 않는다/);
  assert.match(OPS_BRIEF, /\{op:'styles', import\?:'standard', define\?:/); assert.doesNotMatch(OPS_BRIEF, /restyle/);
  assert.ok(VISIBLE_OP_NAMES.includes('styles') && !VISIBLE_OP_NAMES.includes('restyle'));
  assert.match(opsGuide(), /\{op:'styles', import\?:'standard'/); assert.doesNotMatch(opsGuide(), /op:'restyle'/);
  assert.doesNotMatch(opsGuide('page'), /restyle/); assert.match(opsGuide('page'), /"const":"styles"/); assert.match(opsGuide('page'), /objects_to_body/);
  assert.match(EDITOR_INSTRUCTIONS_V2, /format의 at에 범위·표를 줍니다\(칸·문단마다 op를 내지 않습니다\)/); assert.match(EDITOR_INSTRUCTIONS_V2, /styles\(import:'standard'\)로 스타일을 들여와 format의 style로 입힙니다/);
  assert.equal(activityItem('edit', { ops: [{ op: 'styles' }, { op: 'format' }] }).label, '스타일 들여오기 · 서식 제안');
  assert.equal(activityItem('read', { view: 'styles' }).label, '스타일 확인');

  // 문단 몇 개: 예전처럼 문단마다 서식 제안
  const few = prep([{ op: 'format', at: ['s1/p3', 's1/p4'], char: { bold: true } }, { op: 'format', at: { table: 's1/p17#t0', row: 0, col: 0 }, char: { bold: true } }]);
  assert.deepEqual(few.errors, []); assert.deepEqual(few.steps.map((s) => s.kind), ['proposals']); assert.equal(few.steps[0].items.length, 3);
  // 범위·표 꼴이 하나라도 있으면 그 호출의 문단 전체 서식은 모두 묶음으로. 글 일부(find)는 그대로 문단별 제안
  const mixed = prep([
    { op: 'format', at: 's1/p3', find: '가', char: { bold: true } },
    { op: 'format', at: 's1/p17#t0', style: '&표내용__' },
    { op: 'format', at: { table: 's1/p17#t0', row_from: 0, row_to: 0 }, char: { bold: true }, paragraph: { align: 'CENTER' } },
    { op: 'format', at: ['s1/p3..p5', 's1/p8'], style: '&본문 1.' },
    { op: 'paper', section: 1, margins: { left: 20 } },
  ]);
  assert.deepEqual(mixed.errors.filter((e) => !/찾을 수 없|없습니다/.test(e.error)), []);
  const st = mixed.steps.find((s) => s.kind === 'structure');
  assert.deepEqual(st.ops.map((o) => o.op), ['restyle', 'restyle', 'restyle', 'paper']);
  assert.deepEqual(st.ops[0], { op: 'restyle', at: ['s1/p17#t0'], style: '&표내용__' });
  assert.deepEqual(st.ops[1].at, [{ table: 's1/p17#t0', row_from: 0, row_to: 0 }]);   // 표 전체 → 머리행: 겹치니 합치지 않고 차례 그대로
  assert.deepEqual(st.indexes, [1, 2, 3, 4]);
  // styles 가 있으면 문단 하나짜리 서식도 묶음으로(스타일이 들어온 뒤에야 번호가 정해진다) — styles 가 맨 앞, 기호만 다른 이름은 정확한 이름으로
  const withStyles = prep([{ op: 'format', at: 's1/p3', style: '새 스타일' }, { op: 'objects_to_body', at: 's0' }, { op: 'styles', define: [{ name: '새 스타일', char: { bold: true } }] }, { op: 'format', at: 's1/p4', style: '&■' }]);
  const st2 = withStyles.steps.find((s) => s.kind === 'structure');
  assert.deepEqual(st2.ops.map((o) => o.op), ['styles', 'restyle', 'restyle', 'objects_to_body']);
  assert.equal(st2.ops[1].style, '새 스타일'); assert.match(st2.ops[2].style, /^&/); assert.notEqual(st2.ops[2].style, '&■');
  assert.ok(withStyles.notes.some((n) => /스타일 「&■」 → /.test(n.note)));
  // 칸마다 낸 op(예전 Codex 꼴): 값이 같은 것끼리 합쳐 값 종류만큼의 서식으로 — 떨어져 있어도(대상이 겹치지 않으므로)
  const table = doc.tables().find((t) => t.key === 's1/p17#t0');
  const perCell = table.cells.map((c) => ({ op: 'format', at: { table: table.key, row: c.row, col: c.col }, char: { bold: c.row === 0 }, paragraph: { align: c.col === 0 ? 'LEFT' : 'CENTER' } }));
  assert.ok(perCell.length > 20);
  const cells = prep(perCell);
  assert.deepEqual(cells.errors, []); assert.deepEqual(cells.steps.map((s) => s.kind), ['structure']);
  assert.equal(cells.steps[0].ops.length, 4, '굵게 × 정렬 = 네 가지'); assert.equal(cells.steps[0].ops.reduce((n, o) => n + o.at.length, 0), perCell.length);
  // 오류: 없는 스타일(들여오는 길 안내), 없는 표·범위, find 와 범위 대상, 여러 문단에 쪽 나눔
  const bad = prepareOps(open(PLAIN), parseOps([{ op: 'format', at: 's0/p0', style: '&본문제목' }, { op: 'format', at: 's0/p0..p1', style: '없는 것' }]).ok);
  assert.match(bad.errors[0].error, /스타일 「&본문제목」 이 문서에 없습니다.*\{op:'styles', import:'standard'\}/);
  assert.match(bad.errors[1].error, /스타일 「없는 것」 이 문서에 없습니다.*\{op:'styles', define:/);
  // 새로 넣는 문단의 style 은 문서에 있는 스타일만 — 길잡이가 그렇게 말한다
  const badInsert = prepareOps(open(PLAIN), parseOps([{ op: 'styles', import: 'standard' }, { op: 'insert', after: 's0/p0', paragraphs: [{ text: '새 장', style: '&본문 1.' }] }]).ok);
  assert.match(badInsert.errors[0].error, /스타일 「&본문 1\.」 이 문서에 없습니다.*새로 넣는 글의 style 은 문서에 이미 있는 스타일만/);
  // 묶음 안의 칸 하나({table,row,col})는 그 칸의 첫 문단만(문단별 길과 같다), para 를 주면 그 문단
  const t17 = doc.tables().find((x) => x.key === 's1/p17#t0'); const c00 = t17.cells.find((c) => c.row === 0 && c.col === 0);
  const oneCell = prep([{ op: 'format', at: [{ table: 's1/p17#t0', row: 0, col: 0 }, 's1/p3..p5'], char: { bold: true } }]);
  assert.deepEqual(oneCell.steps[0].ops[0].at, [c00.refs[0], 's1/p3..p5']);
  assert.match(prep([{ op: 'format', at: [{ table: 's1/p17#t0', row: 99, col: 0 }, 's1/p3..p5'], char: { bold: true } }]).errors[0].error, /없는 칸\(99,0\)|문단을 찾을 수 없|표를 찾지 못/);
  const bad2 = prep([{ op: 'format', at: 's1/p3#t7', char: { bold: true } }, { op: 'format', at: 's1/p3..p5', find: '가', char: { bold: true } }, { op: 'format', at: 's1/p3..p5', paragraph: { pageBreakBefore: true } }]);
  assert.match(bad2.errors.find((e) => e.index === 0).error, /표를 찾지 못했습니다/);
  assert.match(bad2.errors.find((e) => e.index === 1).error, /find\(글 일부\)·부분 범위는 문단·칸 하나/);
  assert.match(bad2.errors.find((e) => e.index === 2).error, /쪽 나눔\(pageBreakBefore\)은 본문 문단 하나씩/);
});

test('임시 서버: 표준서식 맞추기가 호출 한 번·제안 하나로 저장되고, 반영·되돌리기가 된다', { timeout: 180000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open2 = [];
  t.after(async () => { for (const c of open2) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const v2 = await connect(srv, 'a'); open2.push(v2);
  const ask = async (docId, instruction) => (await api(`/api/docs/${docId}/requests`, { method: 'POST', body: { kind: 'instruct', instruction, target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;

  // ① 표준서식 스타일이 없는 문서: 스타일 보기 → 들여오기 + 스타일 입히기를 한 호출로
  const plain = await uploadDoc(srv.base, srv.tokens.a, PLAIN);
  const req = await ask(plain.id, '표준서식에 맞춰줘');
  const brief = json(await v2.call('task', { doc_id: plain.id, request_id: req.rid }));
  assert.match(brief.todo, /이 문서에는 표준서식 스타일이 없다 — edit 의 \{op:'styles', import:'standard'\}/, '표준서식 지시 + 스타일 없는 문서 → 길을 한 줄로');
  const stylesView = textOfResult(await v2.call('read', { doc_id: plain.id, view: 'styles' }));
  assert.match(stylesView, /^문서의 스타일 \d+개\(이름 — 쓰인 문단 수\): 바탕글 /); assert.match(stylesView, /표준서식 스타일 가운데 문서에 없는 것 \d+개: .*&본문 1\..*\{op:'styles', import:'standard'\}/);
  // 스타일만 주면(들여오지 않고) 저장되지 않고 길을 알려 준다
  const refused = json(await v2.call('edit', { doc_id: plain.id, request_id: req.rid, expected_attempt: 1, ops: [{ op: 'format', at: 's0/p0', style: '&본문제목' }] }));
  assert.equal(refused.saved.length, 0); assert.match(refused.failed[0].error, /\{op:'styles', import:'standard'\}/);
  const ops = [{ op: 'styles', import: 'standard' }, { op: 'format', at: 's0/p0', style: '&본문제목' }, { op: 'format', at: 's0/p1..p2', style: '&본문 1.' }];
  const dry = json(await v2.call('edit', { doc_id: plain.id, request_id: req.rid, expected_attempt: 1, dry_run: true, ops }));
  assert.equal(dry.failed, undefined, JSON.stringify(dry)); assert.deepEqual(dry.structure.ops, [0, 1, 2]);
  assert.match(dry.structure.labels[0], /^표준서식 스타일 들여오기 \d+개$/); assert.deepEqual(dry.structure.labels.slice(1), ['서식 1곳: 스타일 「&본문제목」', '서식 2곳: 스타일 「&본문 1.」']);
  assert.equal(dry.structure.after, undefined, '글·주소가 그대로라 뒤 글은 싣지 않는다');
  assert.equal((await api(`/api/docs/${plain.id}/proposals`)).length, 0);
  const saved = json(await v2.call('edit', { doc_id: plain.id, request_id: req.rid, expected_attempt: 1, ops, done: '표준서식 스타일을 들여와 제목과 본문에 입혔습니다.' }));
  assert.equal(saved.failed, undefined, JSON.stringify(saved)); assert.equal(saved.completed, true); assert.ok(Number.isInteger(saved.structure.pid));
  const proposals = await api(`/api/docs/${plain.id}/proposals`);
  assert.equal(proposals.length, 1);
  const p = proposals[0];
  assert.equal(p.type, 'page_layout'); assert.equal(p.pageLayout.title, '서식'); assert.equal(p.ref, 's0/p0'); assert.deepEqual(p.pageLayout.ops.map((o) => o.op), ['styles', 'restyle', 'restyle']);
  assert.equal(p.layoutUndo, undefined, '되돌리기 자료는 화면·도구에 싣지 않는다');
  const paragraphsBefore = (await api(`/api/docs/${plain.id}/paragraphs`)).filter((x) => !x.parent).map((x) => x.text);
  const resolved = await api(`/api/docs/${plain.id}/requests/${req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
  assert.equal(resolved.counts.failed, 0, JSON.stringify(resolved.results)); assert.equal(resolved.counts.applied, 1);
  const fmt = json(await v2.call('read', { doc_id: plain.id, view: 'format', at: 's0/p0..p2' }));
  const names = new Map(fmt.header.styles.map((s) => [String(s.id), s.name]));
  assert.deepEqual(fmt.paragraphs.map((x) => names.get(String(x.styleId))), ['&본문제목', '&본문 1.', '&본문 1.']);
  assert.deepEqual((await api(`/api/docs/${plain.id}/paragraphs`)).filter((x) => !x.parent).map((x) => x.text), paragraphsBefore, '글은 그대로');
  assert.match(textOfResult(await v2.call('read', { doc_id: plain.id, view: 'styles' })), /표준서식 스타일이 모두 있다/);
  // 되돌리기: 스타일이 예전으로(들여온 정의도 함께 사라진다 — 반영 전 사본으로 돌아간다)
  await api(`/api/docs/${plain.id}/proposals/${p.pid}/undo`, { method: 'POST', body: {} });
  const back = json(await v2.call('read', { doc_id: plain.id, view: 'format', at: 's0/p0' }));
  assert.ok(!back.header.styles.some((s) => s.name === '&본문제목'));

  // ② 표가 있는 문서: 표 전체·머리행 대상과 칸마다 낸 op — 모두 제안 하나. 문단 몇 개는 문단마다 제안
  const report = await uploadDoc(srv.base, srv.tokens.a, REPORT);
  const req2 = await ask(report.id, '표 서식을 맞춰줘');
  assert.doesNotMatch(json(await v2.call('task', { doc_id: report.id, request_id: req2.rid })).todo, /표준서식 스타일이 없다/);
  const tableFmt = json(await v2.call('read', { doc_id: report.id, view: 'format', at: 's1/p17#t0' }));   // 표 열쇠 → 머리행·첫 줄 칸
  assert.ok(tableFmt.paragraphs.length >= 4 && tableFmt.paragraphs.length <= 12 && tableFmt.paragraphs.every((x) => x.ref.startsWith('s1/p17/')));
  const first = json(await v2.call('edit', { doc_id: report.id, request_id: req2.rid, expected_attempt: 1, ops: [
    { op: 'format', at: ['s1/p17#t0', 's1/p35#t0'], style: '&표내용__' },
    { op: 'format', at: [{ table: 's1/p17#t0', row_from: 0, row_to: 0 }, { table: 's1/p35#t0', row_from: 0, row_to: 0 }], char: { bold: true }, paragraph: { align: 'CENTER' } },
    { op: 'format', at: ['s1/p3', 's1/p4'], char: { italic: true } },
  ] }));
  assert.equal(first.failed, undefined, JSON.stringify(first)); assert.equal((first.saved || []).length, 0, '문단마다의 제안은 없다'); assert.equal(first.structure.labels.length, 3);
  assert.match(first.structure.labels[0], /^서식 \d+곳: 스타일 「&표내용__」$/); assert.match(first.structure.labels[1], /^서식 \d+곳: 글자 모양·문단 모양$/);
  const doc = new HwpxDoc(containerFromBytesSync(fs.readFileSync(REPORT))); const table = doc.tables().find((x) => x.key === 's1/p43#t0');
  const perCell = table.cells.map((c) => ({ op: 'format', at: { table: table.key, row: c.row, col: c.col }, char: { bold: c.row === 0 }, paragraph: { align: 'CENTER' } }));
  const second = json(await v2.call('edit', { doc_id: report.id, request_id: req2.rid, expected_attempt: 1, ops: perCell }));
  assert.equal(second.failed, undefined, JSON.stringify(second)); assert.equal((second.saved || []).length, 0); assert.equal(second.structure.labels.length, 2);
  assert.match(String(second.structure.ops), /^0-\d+$/, '칸마다 낸 op 번호는 범위 글로');
  const few = json(await v2.call('edit', { doc_id: report.id, request_id: req2.rid, expected_attempt: 1, done: '표 서식을 맞췄습니다.', ops: [{ op: 'format', at: ['s1/p5', 's1/p6'], char: { underline: true } }] }));
  assert.equal(few.saved.reduce((n, x) => n + (x.count || 1), 0), 2, JSON.stringify(few)); assert.equal(few.structure, undefined);
  const all = await api(`/api/docs/${report.id}/proposals`);
  assert.deepEqual(all.map((x) => x.type), ['page_layout', 'page_layout', 'format', 'format']);
  const done = await api(`/api/docs/${report.id}/requests/${req2.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
  assert.equal(done.counts.failed, 0, JSON.stringify(done.results)); assert.equal(done.counts.applied, 4);
  // 반영 결과: 표 전체 스타일 뒤에 머리행 서식이 덮였다(차례대로), 칸마다 낸 op 도 그대로 들어갔다
  const t17 = doc.tables().find((x) => x.key === 's1/p17#t0');
  const headRef = t17.cells.find((c) => c.row === 0).refs[0]; const bodyRef = t17.cells.find((c) => c.row === 2).refs[0]; const head43 = table.cells.find((c) => c.row === 0).refs[0];
  const after = json(await v2.call('read', { doc_id: report.id, view: 'format', at: [headRef, bodyRef, head43, 's1/p3'] }));
  const styleNames = new Map(after.header.styles.map((x) => [String(x.id), x.name]));
  const paraPr = (x) => after.header.paraPr.find((q) => String(q.id) === String(x.paraPrId)); const charPr = (x) => after.header.charPr.find((q) => String(q.id) === String(x.runs?.[0]?.charPrId ?? x.emptyCharPrId));
  const [h, b, h43, body] = after.paragraphs;
  assert.deepEqual([styleNames.get(String(h.styleId)), paraPr(h).align, charPr(h).bold], ['&표내용__', 'CENTER', true]);
  assert.deepEqual([styleNames.get(String(b.styleId)), charPr(b).bold], ['&표내용__', false]);
  assert.deepEqual([paraPr(h43).align, charPr(h43).bold], ['CENTER', true]);
  assert.equal(charPr(body).italic, true);
});
