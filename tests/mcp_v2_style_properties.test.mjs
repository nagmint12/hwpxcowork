import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { editPageLayout, elements, pageLayoutState, restyleRefs } from '../engine/page-layout.js';
import { copyStyleDefinitionsFromSync, namedStyle, styleDetail, styleHeading, styleUsage } from '../engine/formatting.js';
import { docBytesSync, containerFromBytesSync } from '../engine/toc.js';
import { parseOps, prepareOps } from '../server/mcp2/ops.js';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';

const report = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const seed = fixture('h2022_format/seed.hwpx');
const openBytes = bytes => new HwpxDoc(containerFromBytesSync(bytes));
const open = file => openBytes(fs.readFileSync(file));
const allText = doc => doc.paragraphs({ nested: true }).map(p => p.text);
const original = '&\u{F02EA}'; // 한/글 표준서식의 이름. 글머리표 자체는 U+F071이고 본문 글에는 없다.
const solid = { heading: { type: 'BULLET', char: '■' } };
const clone = { op: 'styles', define: [{ name: '채운 네모', base: original, applyToBase: true, paragraph: solid }] };
const update = (name, paragraph, char) => ({ op: 'styles', update: [{ name, paragraph, ...(char && { char }) }] });
const prep = (doc, ops) => {
  const parsed = parseOps(ops); assert.deepEqual(parsed.errors, []);
  const p = prepareOps(doc, parsed.ok); assert.deepEqual(p.errors, []);
  assert.deepEqual(p.steps.map(s => s.kind), ['structure']);
  return p.steps[0].ops;
};
const nativeHead = (doc, ref) => {
  return elements(doc.header.block('paraPr', doc.inspectFormatting(ref).paraPrId), 'hh:heading')[0].attrs;
};

test('표준서식의 빈 네모로 새 스타일을 만들어 본문과 표 칸에 적용한다. 공유된 원래 모양과 직접 서식을 보존한다', () => {
  const d = open(report); const src = namedStyle(d, original); const refs = styleUsage(d).get(src.id);
  assert.equal(namedStyle(d, '&□').id, src.id);
  assert.equal(refs.length, 20); assert.equal(styleHeading(d, src).char, '\uf071');
  const cell = d.tables().at(-1).cells[0].refs[0];
  d.formatParagraphs([cell], { styleId: src.id });
  d.formatRange(refs[0], { start: 0, end: 1, char: { bold: true, color: '#A34000' } });
  d.formatParagraphs([refs[0]], { paragraph: { indentPt: 7 } });
  editPageLayout(d, [{ op: 'styles', define: [{ name: '공유 대조군', base: original }] }]);
  const other = namedStyle(d, '공유 대조군');
  assert.equal(other.paraPrId, src.paraPrId);
  d.formatParagraphs([refs[1]], { styleId: other.id });
  const text = allText(d); const beforeRuns = d.inspectFormatting(refs[0]).runs;
  const oldBullet = d.header.block('bullet', nativeHead(d, refs[1]).idRef);
  const changed = editPageLayout(d, prep(d, [clone]));
  assert.deepEqual(changed.labels, ['스타일 정의 「채운 네모」 사용 문단 20곳']);
  const back = openBytes(docBytesSync(d)); const newStyle = namedStyle(back, '채운 네모');
  assert.equal(elements(back.header.block('style', newStyle.id), 'hh:style')[0].attrs.nextStyleIDRef, newStyle.id);
  assert.equal(styleUsage(back).get(newStyle.id).length, 20);
  assert.equal(styleUsage(back).get(src.id), undefined);
  assert.deepEqual(styleUsage(back).get(other.id), [refs[1]]);
  assert.equal(back.header.block('bullet', nativeHead(back, refs[1]).idRef), oldBullet);
  assert.equal(back.inspectFormatting(cell).styleId, newStyle.id);
  assert.equal(back.inspectFormatting(refs[0]).paragraph.indentPt, 7);
  assert.deepEqual(back.inspectFormatting(refs[0]).runs, beforeRuns);
  for (const ref of styleUsage(back).get(newStyle.id)) assert.equal(elements(back.header.block('bullet', nativeHead(back, ref).idRef), 'hh:bullet')[0].attrs.char, '■');
  assert.deepEqual(allText(back), text);
  const recolor = update('채운 네모', { heading: { type: 'BULLET', color: '#BE123C', sizePt: 18 } });
  editPageLayout(back, prep(back, [recolor]));
  assert.deepEqual(styleHeading(back, namedStyle(back, '채운 네모')), { type: 'BULLET', char: '■', color: '#BE123C', sizePt: 18 });
  assert.deepEqual(back.inspectFormatting(refs[0]).runs, beforeRuns);
  const header = back.header.xml; const sections = back.sections.map(s => s.xml);
  editPageLayout(back, [recolor]);
  assert.equal(back.header.xml, header); assert.deepEqual(back.sections.map(s => s.xml), sections);
});

test('글머리표·번호·개요 수준·탭·테두리의 한/글 저장 구조와 실제 사용 문단을 확인한다', () => {
  const d = open(seed); const name = '목록 $& 예시';
  const tabs = { autoLeft: false, stops: [{ posPt: 144, type: 'RIGHT', leader: 'DOT' }, { posPt: 36, type: 'CENTER' }] };
  const border = { bottom: { type: 'SOLID', widthMm: 0.5, color: '#23547B' }, fill: '#E5F0FA', connect: true, offsetMm: { bottom: 1 } };
  const number = { type: 'NUMBER', level: 1, start: 3, format: 'HANGUL_SYLLABLE', pattern: '(^1)' };
  const ops = [{ op: 'styles', define: [{ name, base: '바탕글', applyToBase: true, paragraph: { heading: number, tabs, border } }] }];
  editPageLayout(d, prep(d, ops));
  let s = namedStyle(d, name);
  const p = d.header.block('paraPr', s.paraPrId);
  const n = nativeHead(d, 's0/p1');
  assert.equal(n.level, '0'); const numberXml = d.header.block('numbering', n.idRef);
  assert.match(numberXml, /<hh:paraHead start="3" level="1"[^>]*numFormat="HANGUL_SYLLABLE"[^>]*>\(\^1\)<\/hh:paraHead>/);
  const tab = d.header.block('tabPr', elements(p, 'hh:paraPr')[0].attrs.tabPrIDRef);
  assert.deepEqual(elements(tab, 'hh:tabItem').map(t => [t.attrs.pos, t.attrs.type, t.attrs.leader]), [
    ['3600', 'CENTER', 'NONE'], ['7200', 'CENTER', 'NONE'], ['14400', 'RIGHT', 'DOT'], ['28800', 'RIGHT', 'DOT'],
  ]);
  const b = elements(p, 'hh:border')[0].attrs;
  assert.equal(b.offsetBottom, '283'); assert.equal(b.connect, '1');
  const fill = d.header.block('borderFill', b.borderFillIDRef);
  assert.deepEqual(elements(fill, 'hh:bottomBorder')[0].attrs, { type: 'SOLID', width: '0.5 mm', color: '#23547B' });
  assert.equal(elements(fill, 'hc:winBrush')[0].attrs.faceColor, '#E5F0FA');
  assert.deepEqual(styleDetail(d, s).paragraph.heading, number);
  const dest = open(seed);
  copyStyleDefinitionsFromSync(dest, d);
  assert.deepEqual(styleDetail(dest, namedStyle(dest, name)).paragraph.heading, number);
  editPageLayout(d, [update(name, { heading: { type: 'OUTLINE', level: 3 }, tabs: { stops: [] } })]);
  assert.deepEqual(nativeHead(d, 's0/p1'), { type: 'OUTLINE', idRef: '0', level: '2' });
  s = namedStyle(d, name);
  assert.deepEqual(styleDetail(d, s).paragraph.tabs.stops, []);
  assert.equal(d.header.block('numbering', n.idRef), numberXml);
  editPageLayout(d, [update(name, { heading: { type: 'BULLET', char: '◆' } })]);
  const bullet = nativeHead(d, 's0/p1'); assert.equal(bullet.idRef, '1', '글머리표 없는 문서에서 첫 정의는 1');
  editPageLayout(d, [update(name, { heading: { type: 'NONE' }, border: { bottom: { type: 'NONE' }, fill: 'none' } })]);
  assert.equal(nativeHead(d, 's0/p1').type, 'NONE');
  assert.equal(styleDetail(d, namedStyle(d, name)).paragraph.border.bottom.type, 'NONE');
});

test('개요·번호 8~10수준은 한/글 2016 확장과 2011 대체값으로 기록하고 보통 수준으로 되돌릴 수 있다', () => {
  const d = open(seed);
  const headings = p => elements(p, 'hh:heading').map(h => h.attrs);
  const block = name => d.header.block('paraPr', namedStyle(d, name).paraPrId);
  const source = block('개요 8');
  const name = '확장 수준';
  editPageLayout(d, [{ op: 'styles', define: [{ name, base: '바탕글', applyToBase: true, paragraph: { heading: { type: 'OUTLINE', level: 8 } } }] }]);
  assert.deepEqual(headings(block(name)), headings(source));
  assert.match(block(name), /<hp:case hp:required-namespace="http:\/\/www\.hancom\.co\.kr\/hwpml\/2016\/paragraph"><hh:heading type="OUTLINE"/);
  const none = { type: 'NONE', idRef: '0', level: '0' };
  for (const level of [9, 10]) {
    editPageLayout(d, [update(name, { heading: { type: 'NUMBER', level, format: 'DIGIT' } })]);
    const [head, fallback] = headings(block(name));
    assert.equal(head.type, 'NUMBER'); assert.equal(head.level, String(level - 1)); assert.deepEqual(fallback, none);
    assert.deepEqual(nativeHead(d, 's0/p1'), head);
    assert.equal(styleHeading(d, namedStyle(d, name)).pattern, level === 10 ? '^:.' : '^9.');
  }
  editPageLayout(d, [update(name, { heading: { type: 'OUTLINE', level: 7 } })]);
  assert.deepEqual(headings(block(name)), headings(block('개요 7')));
  assert.equal(block('개요 8'), source);
});

test('이미 만든 스타일 적용은 실행 시점의 사용 문단을 고른다. 0건·잘못된 속성에 반쪽 변경이 남지 않는다', () => {
  const d = open(seed);
  const ops = [{ op: 'styles', define: [{ name: 'A' }, { name: 'B' }] },
    { op: 'format', at: 's0/p1', style: 'A' }, { op: 'format', at: { style: 'A' }, style: 'B' },
    { op: 'format', at: 's0/p2', style: 'A' }, { op: 'format', at: { style: 'A' }, char: { bold: true } }];
  editPageLayout(d, prep(d, ops));
  assert.deepEqual(restyleRefs(d, [{ style: 'B' }]), ['s0/p1']);
  assert.deepEqual(restyleRefs(d, [{ style: 'A' }]), ['s0/p2']); assert.ok(d.inspectFormatting('s0/p2').runs.every(r => r.char.bold));
  const q = [update('A', solid)]; const first = pageLayoutState(d, q);
  d.formatParagraphs(['s0/p1'], { paragraph: { indentPt: 6 } });
  assert.equal(pageLayoutState(d, q).styles, first.styles);
  d.formatParagraphs(['s0/p1'], { styleId: namedStyle(d, 'A').id });
  assert.notEqual(pageLayoutState(d, q).styles, first.styles);
  const before = [d.header.xml, ...d.sections.map(s => s.xml)];
  const rejected = [
    { op: 'styles', define: [{ name: '추가' }, { name: '실패', base: 'B', applyToBase: true }] },
    { op: 'styles', update: [{ name: 'A', char: { bold: true } }, { name: '없음', paragraph: solid }] },
    update('A', { tabs: { stops: [{ posPt: 36 }, { posPt: 36 }] } }),
    { op: 'styles', define: [{ name: '글자', type: 'CHAR', paragraph: solid }] },
  ];
  for (const op of rejected) {
    assert.throws(() => editPageLayout(d, [op]));
    assert.deepEqual([d.header.xml, ...d.sections.map(s => s.xml)], before);
  }
  for (const heading of [{ type: 'BULLET', char: '두글' }, { type: 'OUTLINE', level: 0 }, { type: 'OUTLINE', level: 11 }, { type: 'NUMBER', format: 'unknown' }])
    assert.equal(parseOps([update('A', { heading })]).errors.length, 1);
  assert.throws(() => editPageLayout(d, prep(d, [{ op: 'format', at: { style: 'B' }, style: 'A' }])), /쓰는 문단이 없습니다/);
  assert.throws(() => editPageLayout(d, prep(d, [{ op: 'styles', define: [{ name: '사본' }] }, { op: 'format', at: { style: 'B' }, style: '사본' }])), /쓰는 문단이 없습니다/);
  assert.deepEqual([d.header.xml, ...d.sections.map(s => s.xml)], before);
});

test('MCP에서 요청·조회·미리보기·한 카드 저장·반영·HWPX 내려받기·되돌리기가 이어진다', async t => {
  const srv = await startServer({ ai: 'off' });
  const auth = { Authorization: 'Bearer ' + srv.tokens.a };
  const transport = new StreamableHTTPClientTransport(new URL(srv.base + '/mcp?v=2&tools=core'), { requestInit: { headers: auth } });
  const client = new Client({ name: 'v2-style-test', version: '1' });
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); await srv.stop(); });
  await client.connect(transport);
  const { id } = await uploadDoc(srv.base, srv.tokens.a, report); const api = srv.api('a'); const url = '/api/docs/' + id;
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: { doc_id: id, ...args } });
    assert.ok(!r.isError, r.content[0].text); return r.content[0].text;
  };
  const { request } = await api(url + '/requests', { method: 'POST', body: { instruction: '표준서식의 빈 네모를 채운 네모 스타일로 만들어 같은 스타일 전체에 적용해 주세요.', kind: 'instruct', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } });
  const req = { request_id: request.rid, expected_attempt: 1 };
  assert.match(JSON.parse(await call('task', req)).todo, /applyToBase/);
  assert.match(await call('read', { view: 'styles' }), /20 \[글머리표 \uf071/);
  assert.match(await call('read', { view: 'guide', id: 'styles' }), /type:'BULLET',char:'■'/);
  const get = async name => JSON.parse(await call('read', { view: 'styles', id: name }));
  const source = await get(original); assert.equal(source.paragraph.heading.char, '\uf071'); assert.equal(source.count, 20);
  assert.deepEqual(await get('&□'), source);
  const preview = JSON.parse(await call('edit', { ...req, ops: [clone], dry_run: true }));
  assert.deepEqual(preview.structure.labels, ['스타일 정의 「채운 네모」 사용 문단 20곳']);
  assert.equal((await api(url + '/proposals')).length, 0);
  const receipt = JSON.parse(await call('edit', { ...req, ops: [clone], done: '20개 문단의 글머리표를 바꾸는 제안을 저장했습니다.' }));
  assert.ok(receipt.completed); const [p] = await api(url + '/proposals'); assert.equal(p.pageLayout.title, '서식');
  assert.equal((await get(original)).count, 20);
  const resolved = await api(url + '/requests/' + request.rid + '/resolve', { method: 'POST', body: { apply: 'rest' } });
  assert.equal(resolved.counts.applied, 1); assert.equal(resolved.counts.failed, 0);
  const response = await fetch(srv.base + url + '/file', { headers: auth }); assert.ok(response.ok);
  const exported = openBytes(Buffer.from(await response.arrayBuffer()));
  assert.equal(restyleRefs(exported, [{ style: '채운 네모' }]).length, 20); assert.equal((await get('채운 네모')).paragraph.heading.char, '■');
  await api(url + '/proposals/' + p.pid + '/undo', { method: 'POST', body: {} });
  assert.equal((await get(original)).count, 20); assert.doesNotMatch(await call('read', { view: 'styles' }), /채운 네모/);
  // 같은 원본에 낸 두 제안. 하나가 원래 정의를 바꾸면 남은 제안은 검토 당시의 대상에만 쓸 수 있다.
  const proposal = async op => {
    const { request: r } = await api(url + '/requests', { method: 'POST', body: { kind: 'instruct', instruction: '같은 스타일 전체 수정', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } });
    await call('task', { request_id: r.rid });
    const result = JSON.parse(await call('edit', { request_id: r.rid, expected_attempt: 1, ops: [op], done: '스타일 변경을 제안했습니다.' }));
    assert.ok(result.completed); return r.rid;
  };
  const older = await proposal(clone);
  const newer = await proposal(update(original, { heading: { type: 'BULLET', char: '◆' } }));
  const accept = rid => api(url + '/requests/' + rid + '/resolve', { method: 'POST', body: { apply: 'rest' } });
  assert.equal((await accept(newer)).counts.applied, 1);
  const stale = await accept(older);
  assert.equal(stale.counts.failed, 1); assert.match(JSON.stringify(stale.results), /STALE/);
  assert.equal((await get(original)).paragraph.heading.char, '◆');
  assert.doesNotMatch(await call('read', { view: 'styles' }), /채운 네모/);
});
