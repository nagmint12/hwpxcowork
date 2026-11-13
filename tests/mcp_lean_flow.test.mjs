// 얇은 흐름(lean — server/lean.js, docs/MCP_LEAN_FLOW_2026-11-10.md) 회귀 시험. 모델을 부르지 않는다.
//  · 순수 함수: 요청 요약·영수증·스키마 접기
//  · 임시 서버: 기본 연결은 예전 꼴 그대로(실행기 계약), lean 연결(?lean=1·머리글)은 맡기 → 쓰기(complete) 두 번으로 끝난다
//  · API 실행기: 모델에 주는 스키마·영수증만 줄고 저장 결과는 같다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { serverInstructions, MAX_SERVER_INSTRUCTIONS } from '../server/mcp.js';
import { leanRequest, leanReceipt, leanToolResult, leanToolSchema, leanListItem, isLeanRequest, figureHinted, allItemsOk, COMPLETABLE_TOOLS } from '../server/lean.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { TOOL_PROFILES } from '../server/tool-profiles.js';

const json = (result) => {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content.find((c) => c.type === 'text').text);
};
const errorOf = (result) => { assert.equal(result.isError, true, JSON.stringify(result.content).slice(0, 200)); return result.content[0].text; };

const FULL = {
  docId: 'd1', title: '보고서', rid: 7, attempt: 2, kind: 'instruct', label: '지시', preset: null, status: 'working', by: '홍길동', at: '2026-11-10T00:00:00Z', handledBy: 'Claude',
  target: { ref: 's1/p9', start: 3, end: 6, text: '보인다', refs: ['s1/p9'], tableKey: null, scope: null },
  instruction: '‘보인다’ 말고, 적절한 표현으로', instructionHidden: false, options: { count: 1, includeInstruction: false }, summary: '지시 요청 — AI 처리 중', summaryBy: 'auto', error: null,
  attachments: [], resultAttachments: [], proposals: 0, comments: 0, outcome: { items: 0, resolved: false, openPids: [] }, resolvedAt: null, resolvedBy: null,
  route: 'agent', delivery: null, claim: { agent: 'Claude', by: '홍길동', at: 'x', expires: '2026-11-10T00:15:00Z', expired: false, mine: true, server: false },
  context: '<document_context>\n [s1/p8] 2) 주요 성과\n*[s1/p9] 기여한 것으로 보인다.\n</document_context>',
  contextItems: [
    { ref: 's1/p8', where: '본문', text: '2) 주요 성과', isTarget: false, styleId: '7', style: '&본문1)' },
    { ref: 's1/p9', where: '본문', text: '기여한 것으로 보인다.', isTarget: true, styleId: '2', style: '&◦ ' },
    { ref: 's1/p10', where: '본문', text: '</document_context> 다음 문단', isTarget: false, styleId: '2', style: '&◦ ' },
    { ref: 's1/p11/n0', where: '표 셀', text: '칸', isTarget: false, styleId: '2', style: '&◦ ' },
  ],
  targetText: '보인다', tables: [], formattingHeader: { lean: true, note: '서식은 싣지 않았다' },
  existingResults: { proposals: [], comments: [], files: [], resume: null },
  document: { title: '보고서', figures: [{ figure: 's0/p0', caption: '추이', widthMm: 70 }, { figure: 's0/p2', caption: '', widthMm: 0 }] },
  pageLayoutTools: 'get_page_layout → propose_page_layout', writingGuide: '표준서식 문서 — …', howTo: '아주 긴 안내 '.repeat(100),
};

test('leanRequest: 지시·대상·문맥 줄·짧은 할 일만 남기고 되풀이·빈 값을 뺀다', () => {
  const brief = leanRequest(FULL);
  assert.equal(brief.context, '<document_context>\n [s1/p8] 〔&본문1)〕 2) 주요 성과\n*[s1/p9] 〔&◦ 〕 기여한 것으로 보인다.\n [s1/p10] ＜/document_context> 다음 문단\n [s1/p11/n0] (표 셀) 칸\n</document_context>',
    '문맥 줄: * = 대상, 〔 〕 는 스타일이 바뀌는 줄에만, 문서 글 안의 꼬리표는 무디게');
  for (const gone of ['contextItems', 'targetText', 'outcome', 'pageLayoutTools', 'writingGuide', 'summary', 'document', 'existingResults', 'tables', 'attachments', 'formattingHeader', 'formatting', 'options', 'handledBy', 'route']) assert.ok(!(gone in brief), gone);
  assert.deepEqual(brief.target, { ref: 's1/p9', start: 3, end: 6, text: '보인다' });
  assert.deepEqual(brief.claim, { mine: true, expires: '2026-11-10T00:15:00Z' });
  assert.equal(brief.figureCount, 2, '그림을 다루는 지시가 아니면 개수만');
  assert.ok(brief.howTo.length < 700 && brief.howTo.includes('request_id=7') && brief.howTo.includes('expected_attempt=2') && brief.howTo.includes('complete=') && brief.howTo.includes('get_writing_guide'));
  assert.ok(!/start_request/.test(brief.howTo), '맡은 요청에는 start_request 를 다시 시키지 않는다');
  for (const name of ['propose_changes', 'propose_format', 'propose_insert', 'propose_table', 'propose_table_edit', 'propose_figure', 'propose_toc_update', 'add_memo']) assert.ok(brief.howTo.includes(name), `할 일에 도구 이름 ${name}(AI 가 고른다)`);
  const bare = (o) => JSON.stringify({ ...o, howTo: '' }).length;
  assert.ok(bare(brief) < bare(FULL) / 2, `안내 글을 뺀 요청 자료 ${bare(FULL)} → ${bare(brief)}자`);
  assert.deepEqual(leanRequest({ none: true }), { none: true });
});

test('leanRequest: 문단 전체·그림 지시·서식 요청·맡기 전·끝난 요청', () => {
  const whole = leanRequest({ ...FULL, target: { ...FULL.target, start: 0, end: 12, text: '기여한 것으로 보인다.' }, targetText: '기여한 것으로 보인다.' });
  assert.deepEqual(whole.target, { ref: 's1/p9', whole: true }, '선택이 문단 전체면 글을 되풀이하지 않는다');
  const visual = leanRequest({ ...FULL, instruction: '이 표를 그림으로 바꿔줘' });
  assert.equal(visual.figures.length, 2); assert.ok(!('figureCount' in visual)); assert.match(visual.howTo, /export_figure/);
  assert.ok(!/export_figure/.test(leanRequest(FULL).howTo), '그림·첨부가 없는 지시에는 파일 절차를 싣지 않는다');
  const document = leanRequest({ ...FULL, kind: 'review', target: { scope: 'document', ref: undefined, refs: undefined, text: '' }, targetText: '' });
  assert.deepEqual(document.target, { scope: 'document' }); assert.equal(document.figures.length, 2); assert.match(document.howTo, /add_memo/);
  const fmtItems = FULL.contextItems.map(({ style, ...c }) => ({ ...c, paraPrId: '7', runs: [{ start: 0, end: 3, charPrId: '4' }] }));
  const format = leanRequest({ ...FULL, instruction: '굵게', contextItems: fmtItems, formattingHeader: { note: 'contextItems 의 styleId 가 가리키는 항목만', styles: [{ id: '2', name: '&◦ ' }], paraPr: [], charPr: [] } });
  assert.equal(format.formatting.paragraphs.length, 4); assert.deepEqual(format.formatting.paragraphs[0], { ref: 's1/p8', styleId: '7', paraPrId: '7', runs: [{ start: 0, end: 3, charPrId: '4' }] });
  assert.match(format.formatting.header.note, /formatting\.paragraphs/); assert.match(format.howTo, /formatting\.paragraphs/);
  assert.ok(!format.context.includes('〔'), '서식 번호가 온 요청은 문맥 줄에 스타일 이름을 붙이지 않는다');
  const pending = leanRequest({ ...FULL, status: 'pending', claim: null });
  assert.equal(pending.claim, null); assert.match(pending.howTo, /^먼저 start_request/);
  assert.match(leanRequest({ ...FULL, status: 'done' }).howTo, /이미 완료/);
  const follow = leanRequest({ ...FULL, followUp: { memoId: 'memo3', rid: 5, memoText: '앞 메모', instruction: '표로 정리' }, attachments: [{ aid: 'a1', name: '자료.xlsx', kind: 'xlsx' }],
    existingResults: { proposals: [{ pid: 3, type: 'replace', ref: 's1/p9', status: 'pending' }], comments: [], files: [], resume: '기존 결과를 확인하고 남은 작업만' } });
  assert.equal(follow.followUp.memoId, 'memo3'); assert.match(follow.howTo, /메모에 사람이 단 답장/); assert.equal(follow.attachments.length, 1);
  assert.deepEqual(follow.existingResults, { proposals: [{ pid: 3, type: 'replace', ref: 's1/p9', status: 'pending' }], resume: '기존 결과를 확인하고 남은 작업만' });
  assert.equal(leanRequest({ ...FULL, kind: 'suggest', options: { count: 3 } }).options.count, 3);
  assert.match(leanRequest({ ...FULL, kind: 'suggest', options: { count: 3 } }).howTo, /propose_alternatives.*3개/);
});

test('figureHinted: 표·그림을 다루는 지시만(표현·발표·목표는 아님)', () => {
  for (const s of ['표를 그림으로 바꿔줘', '표 3의 수치를 반영', '근거가 된 표·그림 번호를 함께', '[표 2] 제목 수정', '이 표에 합계 줄 추가', '차트로', '그림 교체', 'chart']) assert.equal(figureHinted(s), true, s);
  for (const s of ['‘보인다’ 말고, 적절한 표현으로', '표준 문체로', '발표 자료처럼', '목표를 분명히', '대표 사례', '지표를 정리', '']) assert.equal(figureHinted(s), false, s);
});

test('leanReceipt·leanToolResult: 방금 보낸 값의 되풀이·이력을 뺀 영수증', () => {
  const proposal = { pid: 4, type: 'replace', by: '홍길동(Claude)', at: 'x', status: 'pending', reason: '이유', changeIds: [], log: [{ action: 'propose' }], rid: 7, ref: 's1/p9', find: '보인다', replace: '판단된다', occurrence: 1, memo: false };
  assert.deepEqual(leanReceipt('propose_changes', [{ ok: true, proposal }, { ok: false, error: 'NOT_FOUND', message: '글을 찾지 못했습니다' }]),
    { results: [{ ok: true, pid: 4, type: 'replace', status: 'pending', ref: 's1/p9' }, { ok: false, error: 'NOT_FOUND', message: '글을 찾지 못했습니다' }] }, '실패 항목은 오류 글 그대로');
  assert.deepEqual(leanReceipt('propose_change', proposal), { pid: 4, type: 'replace', status: 'pending', ref: 's1/p9' });
  assert.deepEqual(leanReceipt('propose_format', { pid: 5, type: 'format', status: 'pending', ref: 's1/p9', format: { char: { bold: true } }, formatFingerprint: 'abc', formatSnapshot: { runs: [] } }), { pid: 5, type: 'format', status: 'pending', ref: 's1/p9' });
  assert.deepEqual(leanReceipt('propose_figure', { pid: 6, type: 'figure', status: 'applied', afterRef: 's1/p9', figure: { aid: 'a9', caption: '추이', widthMm: 150, heightMm: 80, chart: { type: 'bar', categories: ['a'] }, svgAid: 'a10' } }),
    { pid: 6, type: 'figure', status: 'applied', afterRef: 's1/p9', figure: { aid: 'a9', widthMm: 150, heightMm: 80, svgAid: 'a10' } }, '그림 크기·첨부 id 는 남긴다');
  assert.deepEqual(leanReceipt('propose_alternatives', { gid: 7, results: [{ ok: true, proposal: { ...proposal, gid: 7 } }] }), { gid: 7, results: [{ ok: true, pid: 4, type: 'replace', status: 'pending', ref: 's1/p9', gid: 7 }] });
  assert.deepEqual(leanReceipt('add_memo', { id: 'memo3', number: 3, author: 'x', ref: 's1/p9', text: '[AI 의견] …', link: { type: 'comment', rid: 7 }, thread: { replies: [], resolved: null }, body: '의견' }), { id: 'memo3', ref: 's1/p9', link: { type: 'comment', rid: 7 } });
  assert.deepEqual(leanReceipt('complete_request', { rid: 7, status: 'done', summary: '고쳤습니다', proposals: [4], comments: [], log: [1, 2, 3], claim: { session: 's' }, instruction: '원문' }), { rid: 7, status: 'done', summary: '고쳤습니다', proposals: 1 });
  assert.deepEqual(leanReceipt('read_document', { any: 1 }), { any: 1 }, '읽기 도구는 그대로');
  assert.equal(allItemsOk([{ ok: true }, { ok: false }]), false); assert.equal(allItemsOk({ results: [{ ok: true }] }), true); assert.equal(allItemsOk({ pid: 1 }), true);
  const result = { content: [{ type: 'text', text: JSON.stringify([{ ok: true, proposal }], null, 1) }] };
  assert.equal(leanToolResult('propose_changes', result).content[0].text, '{"results":[{"ok":true,"pid":4,"type":"replace","status":"pending","ref":"s1/p9"}]}');
  const failed = { isError: true, content: [{ type: 'text', text: '오류(NOT_FOUND): …' }] };
  assert.equal(leanToolResult('propose_changes', failed), failed); assert.equal(leanToolResult('read_document', result), result);
  const image = { content: [{ type: 'text', text: '{}' }, { type: 'image', data: 'x', mimeType: 'image/png' }] };
  assert.equal(leanToolResult('propose_figure', image), image, '그림이 든 결과는 그대로');
  assert.deepEqual(leanListItem({ docId: 'd1', rid: 1, status: 'pending', instruction: '지시', instructionHidden: false, summary: null, outcome: { items: 0 }, resolvedAt: null, target: { ref: 's0/p1', text: '', refs: undefined, tableKey: null, scope: null }, claim: null, delivery: null, attachments: [] }),
    { docId: 'd1', rid: 1, status: 'pending', instruction: '지시', target: { ref: 's0/p1' } });
});

test('leanToolSchema·isLeanRequest: null 가지·값 범위만 빼고 무늬·고를 값·필수는 남긴다', () => {
  const schema = { $schema: 'x', type: 'object', required: ['ref'], additionalProperties: false, properties: {
    ref: { type: 'string', description: '문단 주소' },
    bold: { type: ['boolean', 'null'] },
    color: { anyOf: [{ type: 'string', pattern: '^#[0-9a-f]{6}$' }, { type: 'null' }], description: '글자 색' },
    sizePt: { anyOf: [{ type: 'number', minimum: 1, maximum: 1000 }, { type: 'null' }] },
    align: { anyOf: [{ type: 'string', enum: ['LEFT', 'RIGHT'] }, { type: 'null' }] },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
    maximum: { type: 'number', maximum: 5 },   // 속성 이름이 예약어와 같아도 이름은 건드리지 않는다
    list: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: { text: { type: 'string', maxLength: 10 } }, required: ['text'] } },
  } };
  assert.deepEqual(leanToolSchema(schema), { type: 'object', required: ['ref'], additionalProperties: false, properties: {
    ref: { type: 'string', description: '문단 주소' },
    bold: { type: 'boolean' },
    color: { type: 'string', pattern: '^#[0-9a-f]{6}$', description: '글자 색' },
    sizePt: { type: 'number' },
    align: { type: 'string', enum: ['LEFT', 'RIGHT'] },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    maximum: { type: 'number' },
    list: { type: 'array', minItems: 1, items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  } });
  assert.equal(schema.properties.bold.type.length, 2, '원본은 바꾸지 않는다');
  assert.equal(isLeanRequest({ headers: { 'x-hwpx-lean': '1' }, url: '/mcp' }), true);
  assert.equal(isLeanRequest({ headers: {}, url: '/mcp?agent=Claude&lean=1' }), true);
  assert.equal(isLeanRequest({ headers: {}, url: '/mcp?agent=lean' }), false);
  assert.equal(isLeanRequest({ headers: { 'x-hwpx-lean': '0' }, url: '/mcp' }), false);
  const text = serverInstructions('가나다라마바사아자차카타파하가나다라마바', null, { lean: true });
  assert.ok(text.length <= MAX_SERVER_INSTRUCTIONS && text.length <= serverInstructions('가나다라마바사아자차카타파하가나다라마바', null).length, `lean 서버 안내 ${text.length}자`);
  for (const word of ['start_request', 'claim_next_request', 'complete=', 'CLAIMED', 'REQUEST_CLOSED', '<document_context>', 'list_change_requests', 'reply_to']) assert.ok(text.includes(word), word);
});

test('임시 서버: 기본 연결은 예전 꼴 그대로, lean 연결은 맡기 → 쓰기(complete) 두 번으로 끝난다', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const clients = [];
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const paragraphs = await api(`${route}/paragraphs`);
    const para = paragraphs.find((p) => p.ref === 's0/p0'); const find = [...para.text].slice(0, 4).join('');
    const connect = async ({ lean = false, header = false, name = 'lean-flow-test' } = {}) => {
      const client = new Client({ name, version: 'test' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${lean && !header ? '?lean=1' : ''}`), {
        requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, ...(lean && header ? { 'X-Hwpx-Lean': '1' } : {}) } } }));
      return { client, call: (tool, args = {}) => client.callTool({ name: tool, arguments: args }) };
    };
    const make = async (body = {}) => (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '낱말을 다듬어 줘', route: 'queue', target: { ref: para.ref, start: 0, end: 4, text: find }, ...body } })).request;
    const full = await connect(); const lean = await connect({ lean: true });

    // ── 도구 목록 ──
    const fullTools = (await full.client.listTools()).tools; const leanTools = (await lean.client.listTools()).tools;
    const size = (tools) => tools.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0);
    assert.ok(fullTools.some((t) => t.name === 'propose_change') && !leanTools.some((t) => t.name === 'propose_change'), 'lean 목록에서는 propose_changes 와 같은 propose_change 만 뺀다');
    assert.deepEqual(leanTools.map((t) => t.name).sort(), fullTools.map((t) => t.name).filter((n) => n !== 'propose_change').sort(), '그 밖의 도구는 모두 그대로(AI 가 고른다)');
    assert.ok(JSON.stringify(fullTools).includes('"null"') && !JSON.stringify(leanTools.map((t) => t.inputSchema)).includes('"null"'));
    for (const name of COMPLETABLE_TOOLS.filter((n) => n !== 'propose_change')) {
      assert.ok(leanTools.find((t) => t.name === name).inputSchema.properties.complete, `${name}: lean 에는 complete`);
      assert.ok(!fullTools.find((t) => t.name === name).inputSchema.properties.complete, `${name}: 기본에는 complete 없음`);
    }
    assert.ok(!leanTools.find((t) => t.name === 'complete_request').inputSchema.properties.complete);
    assert.ok(size(leanTools) < size(fullTools) * 0.8, `도구 입력 스키마 ${size(fullTools)} → ${size(leanTools)}자`);
    assert.match(lean.client.getInstructions(), /complete=/); assert.doesNotMatch(full.client.getInstructions(), /complete=/);

    // ── 기본 연결: 실행기·옛 클라이언트가 쓰는 꼴 그대로 ──
    const r0 = await make(); const ids0 = { doc_id: doc.id, request_id: r0.rid, expected_attempt: 1 };
    const g0 = json(await full.call('get_request', { doc_id: doc.id, request_id: r0.rid }));
    assert.ok(Array.isArray(g0.contextItems) && g0.context.startsWith('<document_context>') && g0.howTo.includes('complete_request') && 'existingResults' in g0 && 'targetText' in g0);
    const s0 = json(await full.call('start_request', ids0));
    assert.ok(s0.status === 'working' && Array.isArray(s0.log) && typeof s0.claim.session === 'string' && !('context' in s0));
    const p0 = json(await full.call('propose_changes', { ...ids0, proposals: [{ ref: para.ref, find, replace: `${find}!`, format: { char: { bold: null } } }] }));
    assert.ok(Array.isArray(p0) && p0[0].ok && p0[0].proposal.find === find && Array.isArray(p0[0].proposal.log));
    const c0 = json(await full.call('complete_request', { ...ids0, summary: '기본 흐름으로 완료' }));
    assert.ok(c0.status === 'done' && Array.isArray(c0.log));

    // ── lean 연결: start_request 가 요청 내용을 함께 준다 ──
    const r1 = await make(); const ids1 = { doc_id: doc.id, request_id: r1.rid, expected_attempt: 1 };
    const before = json(await lean.call('get_request', { doc_id: doc.id, request_id: r1.rid }));
    assert.ok(before.status === 'pending' && before.claim === null && /^먼저 start_request/.test(before.howTo) && !('contextItems' in before), '맡기 전 보기도 요약 꼴');
    const startText = (await lean.call('start_request', ids1)).content[0].text;
    const s1 = JSON.parse(startText);
    assert.ok(s1.started === true && s1.status === 'working' && s1.claim.mine === true && s1.rid === r1.rid && s1.attempt === 1 && s1.instruction === '낱말을 다듬어 줘');
    assert.deepEqual(s1.target, { ref: para.ref, start: 0, end: 4, text: find });
    assert.ok(s1.context.startsWith('<document_context>\n') && s1.context.includes(`*[${para.ref}]`) && s1.context.includes(para.text) && s1.context.includes('〔'));
    for (const gone of ['contextItems', 'log', 'outcome', 'pageLayoutTools', 'existingResults', 'formattingHeader', 'formatting']) assert.ok(!(gone in s1), gone);
    assert.ok(!/start_request/.test(s1.howTo) && s1.howTo.includes(`request_id=${r1.rid}`) && s1.howTo.length < 700);
    assert.ok(!startText.includes('\n '), '들여쓰기 없는 JSON');
    assert.ok(startText.length < 2000 + JSON.stringify(s1.context).length, `요청 요약 ${startText.length}자`);
    // 다른 세션은 맡을 수 없다(선점은 그대로)
    assert.match(errorOf(await (await connect({ lean: true, name: 'other-session' })).call('start_request', ids1)), /CLAIMED/);

    // 실패한 항목이 있으면 complete 를 하지 않는다 — 고쳐서 다시 낸다
    const partial = json(await lean.call('propose_changes', { ...ids1, proposals: [{ ref: para.ref, find, replace: `${find}?` }, { ref: para.ref, find: '문서에 없는 글자열 ###', replace: 'x' }], complete: '일부만 저장' }));
    assert.ok(partial.completed === false && /complete/.test(partial.completeNote) && partial.results[0].ok === true && partial.results[1].ok === false, JSON.stringify(partial));
    assert.equal((await api(`${route}/requests/${r1.rid}`)).status, 'working');
    assert.match(errorOf(await lean.call('add_memo', { doc_id: doc.id, ref: para.ref, text: '요청 없는 완료', complete: '요약' })), /BAD_ARGS/);
    // 마지막 쓰기에 complete → 저장 + 완료(서식 속성의 null 도 예전처럼 받는다 — 목록의 스키마만 접었다)
    const doneText = (await lean.call('propose_changes', { ...ids1, proposals: [{ ref: para.ref, find, replace: `${find}.`, format: { char: { bold: null, sizePt: null }, paragraph: { align: null } }, reason: '끝' }], complete: '낱말 표현을 다듬는 제안을 남겼습니다.' })).content[0].text;
    const done = JSON.parse(doneText);
    assert.deepEqual(Object.keys(done.results[0]).sort(), ['ok', 'pid', 'ref', 'status', 'type']);
    assert.ok(done.completed === true && doneText.length < 200, doneText);
    const after = await api(`${route}/requests/${r1.rid}`);
    assert.ok(after.status === 'done' && after.summary === '낱말 표현을 다듬는 제안을 남겼습니다.' && after.summaryBy === 'ai' && after.proposals.length === 2);
    assert.match(errorOf(await lean.call('add_memo', { ...ids1, ref: para.ref, text: '끝난 뒤 의견' })), /REQUEST_CLOSED/);

    // ── 머리글(X-Hwpx-Lean — 브리지 --lean)·claim_next_request·따로 완료·서식 요청 ──
    const viaHeader = await connect({ lean: true, header: true });
    const r2 = await make({ instruction: '첫 낱말만 굵게 해 줘' });
    const claimed = json(await viaHeader.call('claim_next_request', { doc_id: doc.id }));
    assert.ok(claimed.claimed === true && claimed.rid === r2.rid && claimed.claim.mine === true && !('contextItems' in claimed) && !/start_request/.test(claimed.howTo));
    assert.ok(claimed.formatting.paragraphs.some((p) => p.ref === para.ref && (p.runs?.length || p.paraPrId != null)) && Array.isArray(claimed.formatting.header.charPr), '서식 낱말이 든 지시에는 서식 번호·값');
    assert.equal(json(await viaHeader.call('claim_next_request', { doc_id: doc.id })).none, true);
    const ids2 = { doc_id: doc.id, request_id: r2.rid, expected_attempt: 1 };
    const fmt = json(await viaHeader.call('propose_format', { ...ids2, ref: para.ref, find, format: { char: { bold: true } } }));
    assert.ok(Number.isInteger(fmt.pid) && fmt.type === 'format' && !('formatSnapshot' in fmt) && !('completed' in fmt));
    const memo = json(await viaHeader.call('add_memo', { ...ids2, ref: para.ref, text: '굵게 표시가 적절한지 확인 필요' }));
    assert.deepEqual(Object.keys(memo).sort(), ['id', 'link', 'ref']);
    const single = json(await viaHeader.call('propose_change', { ...ids2, ref: para.ref, find, replace: `${find}~` }));
    assert.ok(Number.isInteger(single.pid) && !('log' in single), '목록에서 뺀 propose_change 도 부르면 된다');
    const listed = json(await viaHeader.call('list_requests', { doc_id: doc.id }));
    assert.ok(listed.length === 1 && listed[0].rid === r2.rid && !('outcome' in listed[0]) && listed[0].claim.mine === true);
    const closed = json(await viaHeader.call('complete_request', { ...ids2, summary: '서식 제안과 의견을 남겼습니다.' }));
    assert.deepEqual(closed, { rid: r2.rid, status: 'done', summary: '서식 제안과 의견을 남겼습니다.', proposals: 2, comments: 1 });

    // 취소된 요청: 쓰기부터 거절된다(complete 로도 되살아나지 않는다)
    const r3 = await make(); const ids3 = { doc_id: doc.id, request_id: r3.rid, expected_attempt: 1 };
    json(await lean.call('start_request', ids3));
    await api(`${route}/requests/${r3.rid}/cancel`, { method: 'POST' });
    assert.match(errorOf(await lean.call('propose_changes', { ...ids3, proposals: [{ ref: para.ref, find, replace: 'x' }], complete: '취소 뒤 완료' })), /REQUEST_CLOSED/);
    assert.equal((await api(`${route}/requests/${r3.rid}`)).status, 'cancelled');

    // 변경이 필요 없는 검토: 쓰기가 없으므로 complete_request(no_changes_reason) — 영수증에 사유
    const r4 = await make({ kind: 'review', instruction: '' }); const ids4 = { doc_id: doc.id, request_id: r4.rid, expected_attempt: 1 };
    assert.match(json(await lean.call('start_request', ids4)).howTo, /add_memo/);
    assert.match(errorOf(await lean.call('complete_request', { ...ids4, summary: '결과 없이 완료' })), /NO_RESULTS/);
    const none = json(await lean.call('complete_request', { ...ids4, summary: '검토함', no_changes_reason: '대상 문단을 읽었으며 고칠 표현이 없습니다.' }));
    assert.ok(none.status === 'done' && /고칠 표현이 없습니다/.test(none.noChangesReason));
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await srv.stop();
  }
});

test('lean complete: 자동 반영 문서는 영수증에 완료 뒤 상태(applied)를 싣고, 의견·문단 추가로도 완료한다', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const client = new Client({ name: 'lean-auto-apply', version: 'test' });
  try {
    const api = srv.api('a'); const ref = 's0/p2';
    // tests/ai_auto_apply.test.mjs 와 같은 준비: 변경 추적 없는 문서의 한 문단을 '반복 반복 끝'으로
    const base = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
    base.mergeParagraphText(ref, '반복 반복 끝', { author: '준비' }); base.acceptAll();
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await base.save()));
    const route = `/api/docs/${doc.id}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?lean=1`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const call = (name, args) => client.callTool({ name, arguments: args });
    const make = async () => (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용을 고쳐 줘', route: 'queue', target: { ref } } })).request;
    const textOf = async () => (await api(`${route}/paragraphs`)).find((p) => p.ref === ref).text;

    // 직접 반영(기본): 완료해도 제안은 대기 — 영수증도 pending
    const r1 = await make(); const ids1 = { doc_id: doc.id, request_id: r1.rid, expected_attempt: 1 };
    json(await call('start_request', ids1));
    const manual = json(await call('propose_changes', { ...ids1, proposals: [{ ref, find: '끝', replace: '마침' }], complete: '끝맺음 낱말을 고치도록 제안했습니다.' }));
    assert.deepEqual([manual.completed, manual.results[0].status, await textOf()], [true, 'pending', '반복 반복 끝']);

    // 자동 반영: 완료하면서 반영된다 — 영수증의 상태도 applied(저장 직후의 pending 이 아니다)
    await api(`${route}/settings`, { method: 'PATCH', body: { aiApply: 'auto' } });
    const r2 = await make(); const ids2 = { doc_id: doc.id, request_id: r2.rid, expected_attempt: 1 };
    json(await call('start_request', ids2));
    const auto = json(await call('propose_changes', { ...ids2, proposals: [{ ref, find: '반복', replace: '첫째', occurrence: 1 }, { ref, find: '반복', replace: '둘째', occurrence: 2 }], complete: '내용을 수정했습니다.' }));
    assert.deepEqual([auto.completed, ...auto.results.map((x) => x.status)], [true, 'applied', 'applied'], JSON.stringify(auto));
    assert.equal(await textOf(), '첫째 둘째 끝');
    const done = await api(`${route}/requests/${r2.rid}`);
    assert.ok(done.status === 'done' && done.outcome.applied === 2 && done.outcome.open === 0);

    // 의견만 남기고 끝내기 · 문단 추가로 끝내기(쓰기 도구 어느 것이든 마지막 호출의 complete 로 완료)
    const r3 = await make(); const ids3 = { doc_id: doc.id, request_id: r3.rid, expected_attempt: 1 };
    json(await call('start_request', ids3));
    const memo = json(await call('add_memo', { ...ids3, ref, text: '수치 근거 확인 필요', complete: '확인이 필요한 곳에 의견을 남겼습니다.' }));
    assert.ok(memo.completed === true && typeof memo.id === 'string' && (await api(`${route}/requests/${r3.rid}`)).status === 'done');
    const r4 = await make(); const ids4 = { doc_id: doc.id, request_id: r4.rid, expected_attempt: 1 };
    json(await call('start_request', ids4));
    const added = json(await call('propose_insert', { ...ids4, after_ref: ref, paragraphs: [{ text: '덧붙인 첫 문단' }, { text: '덧붙인 둘째 문단' }], complete: '문단 두 개를 덧붙였습니다.' }));
    assert.ok(added.completed === true && added.results.length === 2 && added.results.every((x) => x.ok && x.type === 'insert' && x.status === 'applied'), JSON.stringify(added));
    assert.equal((await api(`${route}/requests/${r4.rid}`)).status, 'done');
  } finally { await client.close().catch(() => {}); await srv.stop(); }
});

test('API 실행기: 모델에 주는 스키마·영수증만 줄고(lean.js) 저장은 한 번, 문서·요청은 실행기가 고정한다', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const client = new Client({ name: 'api-runner-test', version: 'test' });
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const para = (await api(`/api/docs/${doc.id}/paragraphs`)).find((p) => p.ref === 's0/p0'); const find = [...para.text].slice(0, 4).join('');
    const request = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬기', route: 'queue', target: { ref: para.ref } } })).request;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    json(await client.callTool({ name: 'start_request', arguments: { doc_id: doc.id, request_id: request.rid } }));
    const context = await createApiToolContext({ docId: doc.id, requestId: request.rid, attempt: 1,
      listTools: async () => (await client.listTools()).tools, callTool: (name, args) => client.callTool({ name, arguments: args }), assertCurrent: async () => {}, uploadFile: async () => null });
    assert.deepEqual(context.tools.map((t) => t.name).sort(), [...TOOL_PROFILES.api].filter((n) => context.tools.some((t) => t.name === n)).sort());
    assert.ok(context.tools.length >= 24 && !JSON.stringify(context.tools.map((t) => t.parameters)).includes('"null"'), '모델용 스키마에 null 가지 없음');
    for (const tool of context.tools) for (const bound of ['doc_id', 'request_id', 'expected_attempt', 'image_base64', 'complete']) assert.ok(!(bound in tool.parameters.properties), `${tool.name}.${bound}`);
    const args = { proposals: [{ ref: para.ref, find, replace: `${find}!`, reason: '다듬기' }] };
    const first = await context.call('propose_changes', args);
    assert.deepEqual(Object.keys(JSON.parse(first.content[0].text).results[0]).sort(), ['ok', 'pid', 'ref', 'status', 'type'], '모델에는 영수증만');
    assert.equal(await context.call('propose_changes', args), first, '같은 쓰기를 다시 부르면 처음 영수증');
    assert.equal((await api(`/api/docs/${doc.id}/proposals`)).length, 1, '저장은 한 번');
    assert.deepEqual(context.written, [{ name: 'propose_changes', args }]);
    const bad = await context.call('propose_changes', { proposals: [{ ref: para.ref, find: '없는 글 ###', replace: 'x' }] });
    assert.match(bad.content[0].text, /"ok":false/, '틀린 find 는 오류 글 그대로 모델에 되돌린다');
    const read = await context.call('get_formatting', { refs: [para.ref] });
    assert.ok(JSON.parse(read.content[0].text).paragraphs.length === 1, '읽기 도구 결과는 그대로');
  } finally { await client.close().catch(() => {}); await srv.stop(); }
});
