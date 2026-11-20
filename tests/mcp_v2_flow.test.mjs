// 새 MCP 연결(server/mcp2.js — 작업 도구 넷 task·read·edit·finish, docs/MCP_REDESIGN_2026-11-16.md) 회귀 시험. 모델을 부르지 않는다.
//  · 순수 함수: op 꼴 검사, 범위 글, 연결 판정, 안내 길이
//  · 임시 서버: 예전 연결은 그대로, 새 연결(?v=2·머리글)은 맡기 → (읽기) → 고치기(done) 로 끝난다. 보통 문서의 글·문단·표·서식·메모와
//    떠 있는 글상자 문서의 개체 → 본문(미리 해 보기·제안·적용·되돌리기)
//  · Codex 실행기: 새 연결의 도구 허용·고정, 첫 입력(요청 내용), 실행기용 요청 내용 REST
//   node --test tests/mcp_v2_flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, root } from './helpers/server.mjs';
import { floatingDoc } from './helpers/floating-doc.mjs';
import { MAX_SERVER_INSTRUCTIONS } from '../server/mcp.js';
import { isV2Request, v2Toolset, v2Keeps, v2Instructions, V2_TOOLS } from '../server/mcp2.js';
import { parseOps, prepareOps, OP_NAMES, HIDDEN_OPS, V3_ONLY_OPS, opsGuide, OPS_BRIEF, opsBrief } from '../server/mcp2/ops.js';
import { rangePicker, pageLines } from '../server/mcp2/views.js';
import { buildInstructions, CHANNEL_INSTRUCTIONS, CHANNEL_INSTRUCTIONS_V2, FALLBACK_INSTRUCTIONS_V2, instructionsBudget } from '../server/bridge.js';
import { codexToolPolicy, validateCodexJob } from '../server/codex-mcp.js';
import { codexMcpPromptV2, codexCodeModeHintV2 } from '../server/codex-ai.js';
import { EDITOR_INSTRUCTIONS_V2 } from '../server/editor-instructions.js';
import { activityItem } from '../server/activity.js';

const textOf = (result) => (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (result) => { assert.ok(!result.isError, textOf(result)); return JSON.parse(textOf(result)); };
const errorOf = (result) => { assert.equal(result.isError, true, textOf(result).slice(0, 200)); return textOf(result); };

async function connect(srv, who, { query = '', headers = {} } = {}) {
  const client = new Client({ name: 'v2-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}`, ...headers } } });
  await client.connect(transport);
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }), close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); } };
}

test('순수 함수: op 꼴 검사·범위 글·연결 판정·안내 길이', () => {
  // op 꼴: 틀린 op 는 번호와 그 op 의 꼴을 알려 준다
  const bad = parseOps([{ op: 'replace', at: 's0/p1', find: '가', with: '나' }, { op: 'replace', at: 's0/p1' }, { op: 'nope' }, { op: 'table', after: 's0/p1', rows: [] }]);
  assert.deepEqual(bad.ok.map((x) => x.name), ['replace']);
  assert.deepEqual(bad.errors.map((e) => e.index), [1, 2, 3]);
  assert.match(bad.errors[0].error, /ops\[1\] replace: .*꼴: \{op:'replace'/);
  assert.match(bad.errors[1].error, /모르는 op "nope"/);
  assert.equal(parseOps([]).errors.length, 1);
  assert.equal(parseOps([{ op: 'objects_to_body' }, { op: 'paper', section: 0, margins: { left: 20 } }, { op: 'header', section: 0, text: '머리말' }]).errors.length, 0);
  assert.ok(OP_NAMES.includes('objects_to_body') && OP_NAMES.includes('footer') && OP_NAMES.includes('delete_objects'));
  // 2026-11-16 밤: 2,200자 → 3,600자. 하위 에이전트 실험(docs/MCP_REDESIGN_2026-11-16.md §10)에서 18건 가운데 13건이 op 꼴을 보려고 read guide:ops 를 더 불러
  // 모든 op 를 한 줄씩 싣기로 했다(설명 +1,650자 ↔ 요청마다 읽기 한 번·3,000자). 더 늘릴 때는 같은 근거를 댄다
  // 2026-11-17(작업 C, §10.4 나-8): +250자 — table 의 unit·notes, chart 의 caption·notes, figure 의 notes 꼴. 실험 T06·P1·P2·T09 에서 이 인자가 없어
  // 단위 줄·주석을 insert 로 따로 넣거나(서식 명세와 다른 꼴) 차트 캡션을 못 달았다. 같은 날 다른 갈래가 더한 op 몫은 그 갈래가 근거와 함께 더한다
  // 2026-11-17(작업 D, §10.4 나-1): +250자 — delete_paragraphs·move_paragraphs 두 줄(242자). 실험 T10·T09 에서 문단을 지우는 op 가 없어 빈 문단 6·5개가
  // 남았고 절 옮기기가 표를 새로 만들었다 — 가장 큰 기능 구멍이라 op 꼴을 설명에 싣는다(꼴을 보려고 read guide 를 더 부르지 않게 — 위와 같은 근거)
  // 2026-11-17(작업 I): 갈래 C·D·F 가 op(unit·notes·caption, delete_paragraphs·move_paragraphs, replace_all·withdraw)를 더해 4,389자가 된 것을
  // op 마다 짧은 꼴(BRIEF — 인자 이름·필수 여부·틀리기 쉬운 규칙만, 자세한 뜻은 read view='guide' id='ops' 의 sig)로 줄여 3,192자. 한도 = 3,192 + 여유 150.
  // 더 늘릴 때는 위와 같은 근거(실험에서 그 꼴이 없어 틀리거나 지침을 더 읽었다)를 댄다
  // 2026-11-17(작업 P): +97자(3,289) — format·insert 의 pageBreakBefore. 실제 Codex Y05 는 쪽 나눔 키가 없어 장 제목을 지우고 다시 넣었다(한도는 그대로)
  // 2026-11-17(objects_to_body 안전장치): +117자(3,429) — 쪽 배경 그림도 지운다는 것·background:'behind'(+29, 실제 24쪽 PDF 변환 문서에서 남긴 배경 그림이 옮긴 글
  // 16쪽을 덮었다)와 쪽을 넘는 표 잇기·되풀이 머리행을 버린 줄로 알림·join_pages:false(+88, 같은 실행에서 모델이 join_pages:false 로 표 24개를 냈다). 한도 = 3,429 + 여유 40
  // 2026-11-18(사용자 결정 — 한/글 차트 개체는 숨긴 op, tests/mcp_v2_hidden_chart.test.mjs): chart 줄(−290)을 빼고 figure 줄에 직접 그리는 법(+215)을 실어 3,354자. 한도는 그대로
  // 2026-11-18(여러 문단 서식·스타일 들여오기 — tests/mcp_v2_restyle.test.mjs, §15): +421자(3,775) — format 의 범위·표 대상(+206)과 styles 줄(+215).
  // 실제 Codex 실행이 '표준서식에 맞춰줘'를 표 칸마다 format op 3,141개로 냈다(op 한도 오류 → 1,900개 미리 해 보기 120초 시간 초과 → 6분 뒤 칸 서식 포기):
  // 표 전체를 한 op 로 주는 꼴과 스타일을 들여오는 길이 설명에 없었다. 한도 = 3,775 + 여유 45
  // 2026-11-19(표 칸 안 문단 — tests/mcp_v2_cell_paragraphs.test.mjs, §17): +135자(3,910) — replace 의 칸 주소·whole 줄바꿈(+78), insert 의 칸 안 넣기(+12), delete_paragraphs 의
  // 칸 문단(+45). 실제 Codex 실행 3건(gpt-6.2-sol)이 회의록 서식의 내용 칸(문단 21개)을 다시 쓰지 못했다: 칸 주소의 whole:true 가 첫 문단만 바꾸고, 칸 문단 뒤 insert 는
  // 표 밖으로 가고, delete_paragraphs 는 칸 문단을 받지 않았다 — 설명에 칸 안 문단을 다루는 길이 없었다. 한도 = 3,910 + 여유 40
  assert.ok(OPS_BRIEF.length < 3950, `도구 설명의 op 목록 ${OPS_BRIEF.length}자`);
  // 짧은 꼴(BRIEF)이 실제 꼴과 맞는지: 꼴 줄에 적힌 인자만으로 만든 op 가 꼴 검사(zod)를 지난다(2026-11-17 작업 I — 틀린 꼴 한 줄이 중복 제안을 남긴 일이 있다, §10.4 2차 T09)
  const briefExamples = [
    { op: 'replace', at: 's0/p1', find: '가', with: '나', occurrence: 2, style: '바탕글', reason: '까닭' }, { op: 'replace', at: 's0/p1', whole: true, with: '' }, { op: 'replace', at: { table: 's0/p3#t0', row: 0, col: 1 }, find: '', with: '값' },
    { op: 'insert', after: 's0/p1', paragraphs: [{ text: '가', style: '바탕글' }, { runs: [{ text: '굵게', char: { bold: true } }, { text: ' 보통' }] }, { text: '' }] }, { op: 'insert', after: 's0/p1', text: '' },
    { op: 'table', after: 's0/p1', rows: [['가', '나'], ['1', '2']], header_rows: 1, caption: '제목', unit: '명, %', notes: ['주: 가', '자료: 나'] }, { op: 'table', after: 's0/p1', rows: [['가']], notes: '주: 가' },
    { op: 'table_edit', table: 's0/p3#t0', ops: [{ op: 'insert_rows', row: 1, position: 'below', values: [['합계', '3']] }, { op: 'delete_rows', rows: [2] }, { op: 'fill', range: { row_from: 0, row_to: 0 }, color: '#FF0000' }] },
    { op: 'format', at: ['s0/p1', 's0/p2'], find: '가', style: '바탕글', char: { bold: true, italic: true, underline: true, sizePt: 12, font: '바탕', color: '#000000' }, paragraph: { align: 'CENTER', lineSpacing: { type: 'PERCENT', value: 160 }, indentPt: 10 } },
    // 2026-11-18: format 의 여러 문단 대상(범위·구역·'*'·표·칸 범위·이들의 목록)과 styles
    ...['s0/p3..p9', 's1', '*', 's0/p3#t0', { table: 's0/p3#t0', row_from: 0, row_to: 0, col_from: 1, col_to: 2 }, ['s0/p3..p9', 's0/p3#t0', { table: 's0/p3#t0' }, 's0/p1', { table: 's0/p3#t0', row: 0, col: 1 }]].map((a) => ({ op: 'format', at: a, style: '바탕글', char: { bold: true }, paragraph: { align: 'CENTER' } })),
    { op: 'styles', import: 'standard', define: [{ name: '새 스타일', base: '바탕글', char: { bold: true }, paragraph: { align: 'CENTER' } }] }, { op: 'styles', import: 'standard' },
    ...['s0/p3', 's0/p3..p9', 's2', '*', ['s0/p3', 's0/p5']].map((a) => ({ op: 'delete_objects', at: a, kinds: ['table', 'figure', 'shape', 'chart'] })),
    ...['s1/p8', 's1/p8..p13', ['s1/p8', 's1/p9']].map((a) => ({ op: 'delete_paragraphs', at: a })),
    // 2026-11-19: 표 칸 안 문단(칸 주소의 whole 다시 쓰기·칸 문단 뒤 넣기·칸 문단 지우기)
    { op: 'replace', at: { table: 's0/p3#t0', row: 2, col: 1 }, whole: true, with: '첫 줄\n둘째 줄' }, { op: 'insert', after: 's0/p3/n9', paragraphs: [{ text: '칸 안 문단' }] },
    ...['s0/p3/n9', 's0/p3/n9..n12', ['s0/p3/n9', 's0/p3/n11']].map((a) => ({ op: 'delete_paragraphs', at: a })),
    { op: 'move_paragraphs', at: 's1/p8..p9', after: 's1/p20' }, { op: 'move_paragraphs', at: 's1/p8', before: 's1/p2' },
    { op: 'objects_to_body', remove_rest: true, drop: ['s0/p0:L3'] }, { op: 'objects_to_body', at: 's1' },
    { op: 'memo', at: 's0/p1', text: '의견', find: '가' }, { op: 'memo', reply_to: 'memo3', text: '답' },
    { op: 'alternatives', at: 's0/p1', find: '가', options: [{ text: '나', reason: '까닭' }, { text: '다' }] },
    { op: 'fill', fields: [{ name: '이름', value: '홍길동', occurrence: 0 }] },
    { op: 'toc', after: 's0/p1', create_if_missing: true, apply_styles: true, one_line: true, apply_now: true }, { op: 'toc', at: 's0/p5' },
    { op: 'chart', after: 's0/p1', chart: { type: 'bar', title: '제목', categories: ['가'], series: [{ name: '값', values: [1] }] }, width_mm: 100, height_mm: 60, caption: '제목', notes: '주: 가' },
    { op: 'chart', after: 's0/p1', chart: { type: 'line' }, source_table: { table: 's0/p3#t0', header_row: 0, category_col: 0, value_cols: [1], data_rows: [1, 2] } },
    { op: 'figure', after: 's0/p1', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', caption: '제목', notes: ['주: 가'], width_mm: 80 }, { op: 'figure', replace: 's0/p5', attachment_id: 'a1' },
    { op: 'replace_all', find: '가', with: '나', at: 's1', word: true, ignore_case: true }, { op: 'replace_all', find: '가', with: '나' },
    { op: 'withdraw', pids: [12, 13] }, { op: 'withdraw', all: true },
    { op: 'paper', section: 1, margins: { left: 20, right: 20, top: 15, bottom: 15, header: 10, footer: 10 }, width_mm: 210, height_mm: 297, orientation: 'landscape' },
    { op: 'header', section: 0, text: '머리말' }, { op: 'footer', section: 0, clear: true }, { op: 'page_number', section: 0, position: 'BOTTOM_CENTER', start: 1 }, { op: 'page_number', section: 0, clear: true },
  ];
  assert.deepEqual(parseOps(briefExamples).errors, []);
  // v3 실험 op(V3_ONLY_OPS — 문서 끼워 넣기 2026-11-20 §21)는 v2 에서 모르는 op 다: v2 꼴 목록에 없고 v3 꼴 목록에만 있다(시험 tests/mcp_insert_document.test.mjs)
  for (const name of OP_NAMES.filter((n) => !V3_ONLY_OPS.includes(n))) assert.ok(briefExamples.some((x) => x.op === name) || ['section', 'split_section', 'merge_section', 'master_page', 'restyle'].includes(name), `BRIEF 예시가 없는 op: ${name}`);
  for (const name of OP_NAMES.filter((n) => !['section', 'split_section', 'merge_section', 'master_page', 'footer', ...HIDDEN_OPS, ...V3_ONLY_OPS].includes(n))) assert.match(OPS_BRIEF, new RegExp(`op:'${name}'`), `OPS_BRIEF 에 없는 op: ${name}`);
  for (const name of V3_ONLY_OPS) { assert.doesNotMatch(OPS_BRIEF, new RegExp(`op:'${name}'`)); assert.match(opsBrief('v3'), new RegExp(`op:'${name}'`)); }
  for (const name of HIDDEN_OPS) assert.doesNotMatch(OPS_BRIEF, new RegExp(`op:'${name}'`), `숨긴 op 가 OPS_BRIEF 에 있다: ${name}`);
  assert.match(OPS_BRIEF, /section·split_section·merge_section·master_page/);
  assert.match(opsGuide(), /objects_to_body/); assert.match(opsGuide('table_edit'), /delete_rows/);
  // 범위 글
  assert.equal(rangePicker(null), null); assert.equal(rangePicker('*'), null);
  const one = rangePicker('s1/p3'); assert.deepEqual([one(1, 3), one(1, 4), one(0, 3)], [true, false, false]);
  const span = rangePicker('s0/p3..p5'); assert.deepEqual([span(0, 2), span(0, 3), span(0, 5), span(0, 6)], [false, true, true, false]);
  const cross = rangePicker('s0/p3..s2/p1'); assert.deepEqual([cross(1, 99), cross(2, 1), cross(2, 2)], [true, true, false]);
  const sec = rangePicker('s2'); assert.deepEqual([sec(2, 0), sec(2, 500), sec(1, 0)], [true, true, false]);
  assert.equal(rangePicker('s0/p3/n2')(0, 3), true, '중첩 주소는 그 본문 문단');
  assert.throws(() => rangePicker('3쪽'), (e) => e.code === 'BAD_RANGE');
  // 줄 자르기
  const lines = Array.from({ length: 10 }, (_, i) => ({ text: `줄 ${i} ${'가'.repeat(20)}` }));
  const p1 = pageLines(lines, { maxChars: 80 }); const p2 = pageLines(lines, { from: p1.to, maxChars: 100000 });
  assert.equal(p1.done, false); assert.equal(p2.done, true);
  assert.equal([p1.text, p2.text].join('\n'), lines.map((l) => l.text).join('\n'));
  // 연결 판정
  assert.equal(isV2Request({ url: '/mcp?v=2', headers: {} }), true);
  assert.equal(isV2Request({ url: '/mcp', headers: { 'x-hwpx-mcp': '2' } }), true);
  assert.equal(isV2Request({ url: '/mcp?lean=1', headers: {} }), false);
  assert.equal(v2Toolset({ url: '/mcp?v=2&tools=core', headers: {} }), 'core');
  assert.equal(v2Toolset({ url: '/mcp?v=2', headers: { 'x-hwpx-tools': 'nope' } }), 'all');
  for (const name of V2_TOOLS) assert.ok(v2Keeps(name, 'core'));
  for (const name of ['read_document', 'propose_changes', 'get_request', 'start_request', 'complete_request', 'add_memo', 'get_edit_workspace']) assert.equal(v2Keeps(name), false, name);
  for (const name of ['apply_proposal', 'review_change_request', 'claim_orchestration_task', 'create_document']) { assert.equal(v2Keeps(name), true, name); assert.equal(v2Keeps(name, 'core'), false, name); }
  assert.equal(v2Keeps('preview_figure', 'core'), true);
  // 안내 길이: 서버 안내는 브리지 몫 안, 채널 안내는 기본 채널 안내보다 길지 않게(브리지가 그 길이로 서버 안내 몫을 셈한다)
  assert.ok(v2Instructions('가'.repeat(20)).length <= MAX_SERVER_INSTRUCTIONS);
  assert.ok(CHANNEL_INSTRUCTIONS_V2.length <= CHANNEL_INSTRUCTIONS.length);
  assert.ok(FALLBACK_INSTRUCTIONS_V2.length <= instructionsBudget(true));
  const built = buildInstructions(v2Instructions('홍길동'), { channel: true, v2: true });
  assert.ok(built.length <= 2048 && built.startsWith(CHANNEL_INSTRUCTIONS_V2) && /task/.test(built) && !/start_request|propose_changes/.test(built));
  assert.ok(EDITOR_INSTRUCTIONS_V2.length < 2500 && !/propose_|get_request|read_document/.test(EDITOR_INSTRUCTIONS_V2));
  // 진행 기록 줄(문서 글·찾는 글은 싣지 않는다)
  assert.equal(activityItem('task', {}).label, '요청을 맡음');
  assert.equal(activityItem('read', { view: 'layout', at: 's0/p0', find: '비밀' }).label, '개체 배치 읽기 · s0/p0');
  assert.equal(activityItem('edit', { ops: [{ op: 'replace' }, { op: 'replace' }, { op: 'objects_to_body' }] }, { value: { completed: true } }).label, '수정 제안 2 · 개체 → 본문 · 완료');
  assert.equal(activityItem('edit', { ops: [{ op: 'table' }], dry_run: true }, { value: { failed: [{}] } }).label, '미리 해 보기 · 표 제안(1건은 다시 내야 함)');
  assert.equal(activityItem('finish', { error: 'x' }).label, '실패로 기록');
});

test('임시 서버: 예전 연결은 그대로이고 새 연결은 작업 도구 넷으로 맡기 → 읽기 → 고치기(done) 가 된다', async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'tutorial', '결과보고서.hwpx'));
  const D = `/api/docs/${doc.id}`;
  const paragraphs = await api(`${D}/paragraphs`);
  const para = paragraphs.find((p) => !p.parent && p.text.includes('일정 부분 기여한 것으로 보인다')) || paragraphs.find((p) => !p.parent && p.text.trim().length > 40);
  const find = para.text.includes('보인다') ? '보인다' : para.text.trim().slice(0, 6);
  const start = [...para.text.slice(0, para.text.indexOf(find))].length;
  const make = async (body) => (await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', ...body } })).request;

  // 도구 목록: 밝히지 않은 연결은 예전 그대로(시험 받침 설정 mcp.defaultSurface 'v1' — 운영 기본 v2 는 tests/mcp_default_v2.test.mjs), 새 연결(core)은 작업 도구 넷 + 그림·스킬 파일
  const legacy = await connect(srv, 'a'); open.push(legacy);
  const legacyNames = (await legacy.client.listTools()).tools.map((x) => x.name);
  assert.ok(legacyNames.includes('read_document') && legacyNames.includes('propose_changes') && !legacyNames.includes('task') && !legacyNames.includes('edit'));
  const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);
  const tools = (await v2.client.listTools()).tools;
  assert.deepEqual(tools.map((x) => x.name).sort(), ['edit', 'export_figure', 'export_skill_resource', 'finish', 'preview_figure', 'read', 'read_skill_resource', 'task']);
  const size = JSON.stringify(tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }))).length;
  // 2026-11-16 밤: 9,500자 → 10,400자(op 목록을 모두 싣기로 한 만큼 — 위 OPS_BRIEF 한도와 같은 근거)
  // 2026-11-17(작업 C, §10.4 나-8): +250자 — 위 OPS_BRIEF 의 unit·notes·caption 꼴과 같은 몫(도구 설명에 op 목록이 그대로 실린다)
  // 2026-11-17(작업 D, §10.4 나-1): +300자 — delete_paragraphs·move_paragraphs 의 op 꼴 두 줄과 ops 이름 목록(enum)
  // 2026-11-17(작업 I): 갈래 C·D·F 의 op 를 다 더한 11,300자(o200k 4,295토큰)를 OPS_BRIEF 짧은 꼴·edit·read 설명 줄이기로 9,852자(3,562토큰 —
  // node scripts/measure-mcp2.mjs --tokens)로. 한도 = 9,852 + 여유 200
  // 2026-11-17(작업 P): 9,949자 — 위 OPS_BRIEF 의 pageBreakBefore 몫(+97)
  // 2026-11-17(작업 Q): 10,017자 — finish 의 부분 달성 규칙·paper orientation 값·빈 ops dry_run·sparse(+118), edit 설명 한 구절을 줄이고 ops 의 minItems 를 뺌(−50)
  // 2026-11-17(objects_to_body 안전장치): 10,134자 — 위 OPS_BRIEF 의 objects_to_body 줄 몫(+117). 한도 = 10,134 + 여유 40
  // 2026-11-18(한/글 차트 개체는 숨긴 op — tests/mcp_v2_hidden_chart.test.mjs): 8,773자(−1,361) — op 목록의 chart 줄을 빼고 figure 줄에 직접 그리는 법을 실음(−75),
  // ops 의 이름 목록(enum)을 뺌(−330쯤 — 숨긴 이름을 드러내지 않게), preview_figure 를 새 연결 이름·svg 만으로(chart 자료 스키마 −950쯤). 한도 = 8,773 + 여유 47
  // 2026-11-18(여러 문단 서식·스타일 들여오기): 9,254자(+481) — 위 OPS_BRIEF 몫(+421)과 read 의 styles 보기(+60). 한도 = 9,254 + 여유 46
  // 2026-11-19(표 칸 안 문단 — §17): 위 OPS_BRIEF 몫(+135), read 의 at 에 표 칸 주소(설명 +62·입력 꼴 +230쯤 — 실제 Codex 실행 3건 모두 첫 호출이 read(at:{table,row,col})였고
  // 입력 검사에서 거절됐다), 칸 안 문단 나눔 ¶ 와 칸 주소 뜻(task·edit 설명 +88). 어림 9,770자 — 한도 = 어림 + 여유 80(검증에서 잰 값으로 맞춘다)
  assert.ok(size < 9850, `새 연결(core) 도구 정의 ${size}자`);
  assert.match(v2.client.getInstructions(), /task\(맡기/);
  const all = await connect(srv, 'a', { headers: { 'X-Hwpx-Mcp': '2' } }); open.push(all);
  const allNames = (await all.client.listTools()).tools.map((x) => x.name);
  assert.ok(allNames.includes('task') && allNames.includes('apply_proposal') && allNames.includes('claim_orchestration_task') && !allNames.includes('read_document') && !allNames.includes('propose_changes'));

  // 맡기: 대기 요청이 없으면 none, 있으면 요청 내용(지시·대상·얼개·주변 글·할 일)
  assert.deepEqual(json(await v2.call('task')), { none: true });
  const r1 = await make({ kind: 'instruct', instruction: '‘보인다’ 말고, 적절한 표현으로', target: { ref: para.ref, text: find, start, end: start + [...find].length } });
  const brief = json(await v2.call('task'));
  assert.deepEqual([brief.doc_id, brief.request_id, brief.attempt, brief.status, brief.kind], [doc.id, r1.rid, 1, 'working', 'instruct']);
  assert.equal(brief.instruction, '‘보인다’ 말고, 적절한 표현으로');
  assert.deepEqual(brief.target, { ref: para.ref, text: find, start, end: start + [...find].length });
  assert.match(brief.map, /^문서 「.+」: 구역 \d+ · 본문 문단 [\d,]+ · 글 [\d,]+자/);
  assert.ok(!brief.map.includes('⚠'));
  assert.ok(brief.context.startsWith('<document_context>\n') && brief.context.includes(`*[${para.ref}]`), '대상 문단에 * 표시');
  assert.ok(brief.context.split('\n').filter((l) => /^[ *]\[s\d+\/p\d+\]/.test(l)).length <= 5, '대상과 앞뒤 2문단');
  assert.match(brief.todo, /edit/); assert.match(brief.todo, new RegExp(`request_id=${r1.rid}·expected_attempt=1`));
  assert.ok(!('claim' in brief) && !('contextItems' in brief) && !('formattingHeader' in brief) && !('outcome' in brief));
  assert.ok(JSON.stringify(brief).length < 3500, `요청 내용 ${JSON.stringify(brief).length}자`);
  // 실행기용 요청 내용 REST 는 task 응답과 같은 꼴
  const rest = await api(`${D}/requests/${r1.rid}/brief`);
  assert.deepEqual({ ...rest, claim: undefined }, { ...brief, claim: undefined });
  // 다른 세션은 맡지 못한다(CLAIMED)
  const other = await connect(srv, 'a', { query: '?v=2', headers: { 'X-Hwpx-Agent-Session': 'other-session' } }); open.push(other);
  assert.match(errorOf(await other.call('task', { doc_id: doc.id, request_id: r1.rid })), /오류\(CLAIMED\)/);

  // 읽기: 본문(범위·찾기·이어 읽기)·제목 얼개·표·서식·op 안내
  const around = textOf(await v2.call('read', { doc_id: doc.id, at: para.ref }));
  assert.ok(around.includes(`[${para.ref}]`) && around.includes(para.text.slice(0, 20)));
  const found = textOf(await v2.call('read', { doc_id: doc.id, find }));
  assert.ok(found.includes(`[${para.ref}]`) && /이 든 줄 \d+개/.test(found));
  const first = textOf(await v2.call('read', { doc_id: doc.id, max_chars: 1000 }));
  const cursor = /cursor='(text:\d+:\d+)'/.exec(first)?.[1];
  assert.ok(cursor, '길면 끊고 cursor 를 준다');
  const next = textOf(await v2.call('read', { doc_id: doc.id, cursor, max_chars: 1000 }));
  assert.ok(next.includes('<document_context>') && next !== first);
  assert.match(errorOf(await v2.call('read', { doc_id: doc.id, view: 'outline', cursor })), /오류\(BAD_CURSOR\)/);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'outline' })), /\[s\d+\/p\d+\] 〔/);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'map' })), /^문서 「/);
  const tableList = textOf(await v2.call('read', { doc_id: doc.id, view: 'tables' }));
  const tableKey = /(s\d+\/p\d+(?:\/n\d+)*#t\d+) \d+×\d+/.exec(tableList)?.[1];
  assert.ok(tableKey, tableList.slice(0, 200));
  const tableText = textOf(await v2.call('read', { doc_id: doc.id, view: 'tables', id: tableKey }));
  assert.match(tableText, new RegExp(`▦ ${tableKey.replace(/[#/]/g, '\\$&')} 표`)); assert.match(tableText, / r0 \| /);
  const fmt = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: para.ref }));
  assert.ok(fmt.paragraphs || fmt.refs || fmt.styles, JSON.stringify(fmt).slice(0, 200));
  assert.match(errorOf(await v2.call('read', { doc_id: doc.id, view: 'format' })), /오류\(BAD_ARGS\)/);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'guide', id: 'ops' })), /objects_to_body/);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'objects' })), /표|그림|없습니다/);

  // 고치기: 틀린 op 가 하나라도 있으면 아무것도 저장하지 않는다
  const ids = { doc_id: doc.id, request_id: r1.rid, expected_attempt: 1 };
  const refused = json(await v2.call('edit', { ...ids, ops: [{ op: 'replace', at: para.ref, find, with: '판단된다' }, { op: 'replace', at: para.ref, find: '문서에 없는 글 XYZ', with: '가' }, { op: 'insert', after: para.ref, text: '새 문단', style: '없는 스타일' }] }));
  assert.equal(refused.saved.length, 0); assert.match(refused.failed[0].error, /없는 스타일/);
  assert.equal((await api(`${D}/proposals`)).length, 0);
  // 한 호출에 글·문단(스타일 이름)·표·서식·메모를 모아 내고 done 으로 완료까지
  const styleName = (/〔([^〕]+)〕/.exec(around) || [])[1];
  const chars = [...para.text]; const boldFind = (start >= 4 ? chars.slice(0, 4) : chars.slice(-4)).join('');
  const done = json(await v2.call('edit', { ...ids, done: '요청한 표현을 고치고 보충 문단과 표를 제안했습니다.', ops: [
    { op: 'replace', at: para.ref, find, with: '판단된다', reason: '단정 표현으로' },
    { op: 'insert', after: para.ref, paragraphs: [{ text: '보충 문단 하나', ...(styleName ? { style: styleName } : {}) }, { text: '' }] },
    { op: 'table', after: para.ref, rows: [['구분', '값'], ['가', '1']], caption: '시험 표' },
    // 서식은 바꿈과 겹치지 않는 글에(2026-11-17: 바꿀 글(find)에 굵게를 주면 [모두 반영]에서 바꿈 뒤 그 글이 없어 STALE — done 이 완료를 막는다, tests/page_estimate.test.mjs '완료 막기')
    { op: 'format', at: para.ref, find: boldFind, char: { bold: true } },
    { op: 'memo', at: para.ref, text: '근거 수치 확인 필요' },
  ] }));
  assert.equal(done.completed, true); assert.ok(!done.failed);
  assert.deepEqual(done.saved.map((x) => x.op), [0, 1, 1, 2, 3, 4]);
  assert.ok(done.saved.slice(0, 5).every((x) => Number.isInteger(x.pid)) && done.saved[5].memo);
  const state = await api(`${D}/requests/${r1.rid}`);
  assert.equal(state.status, 'done');
  const proposals = await api(`${D}/proposals`);
  assert.deepEqual(proposals.map((p) => [p.type, p.rid]), [['replace', r1.rid], ['insert', r1.rid], ['insert', r1.rid], ['table', r1.rid], ['format', r1.rid]]);
  assert.equal(proposals[0].replace, '판단된다');
  if (styleName) assert.ok(proposals[1].format?.styleId != null, '스타일 이름 → 번호');
  assert.equal(proposals[2].blank, true);
  const activity = await api(`${D}/requests/${r1.rid}/activity`);
  assert.deepEqual(activity.items.map((i) => i.label).filter((l) => !/조판 확인/.test(l)).slice(0, 2), ['요청을 맡음', `문서 읽기 · ${para.ref}`]);
  assert.ok(activity.items.some((i) => /수정 제안 · 문단 추가 · 표 제안 · 서식 제안 · 의견 · 완료/.test(i.label)), JSON.stringify(activity.items.map((i) => i.label)));
  // 끝난 요청에는 더 쓰지 못한다
  const closed = json(await v2.call('edit', { ...ids, ops: [{ op: 'memo', at: para.ref, text: '늦은 의견' }] }));
  assert.equal(closed.stopped, 'REQUEST_CLOSED');

  // 표 칸 고치기(표 열쇠·줄·칸), 문단 통째 바꾸기(whole), 쓰기 없이 끝내기
  const r2 = await make({ kind: 'review', instruction: '', target: { scope: 'document' } });
  const b2 = json(await v2.call('task', { doc_id: doc.id, request_id: r2.rid }));
  assert.deepEqual(b2.target, { scope: '문서 전체' }); assert.match(b2.todo, /memo/);
  // 짧은 문서는 문서 전체가 요청 내용에 실린다(읽기 호출이 필요 없다). 긴 문서는 앞부분만 싣고 more 에 이어 읽을 자리를 준다
  assert.ok(!b2.more && b2.context.includes('[s1/p16]') && b2.context.includes(`▦ ${tableKey}`), b2.more);
  const cellEdit = json(await v2.call('edit', { doc_id: doc.id, request_id: r2.rid, ops: [{ op: 'replace', at: { table: tableKey, row: 0, col: 0 }, whole: true, with: '고친 머리 칸' }] }));
  assert.equal(cellEdit.saved.length, 1, JSON.stringify(cellEdit));
  assert.match(json(await v2.call('edit', { doc_id: doc.id, request_id: r2.rid, ops: [{ op: 'replace', at: { table: tableKey, row: 999, col: 0 }, find: '', with: '가' }] })).failed[0].error, /칸이 없습니다/);
  const fin = json(await v2.call('finish', { doc_id: doc.id, request_id: r2.rid, summary: '머리 칸 표현을 고쳤습니다.' }));
  assert.deepEqual([fin.request_id, fin.status], [r2.rid, 'done']);
  const r3 = await make({ kind: 'review', instruction: '', target: { ref: para.ref } });
  json(await v2.call('task', { doc_id: doc.id, request_id: r3.rid }));
  assert.match(errorOf(await v2.call('finish', { doc_id: doc.id, request_id: r3.rid, summary: '끝' })), /오류\(NO_RESULTS\)/);
  assert.equal(json(await v2.call('finish', { doc_id: doc.id, request_id: r3.rid, no_changes_reason: '대상 문단을 읽었고 고칠 곳이 없습니다.' })).status, 'done');
  const r4 = await make({ kind: 'review', instruction: '', target: { ref: para.ref } });
  json(await v2.call('task', { doc_id: doc.id, request_id: r4.rid }));
  assert.equal(json(await v2.call('finish', { doc_id: doc.id, request_id: r4.rid, error: '첨부를 읽지 못했습니다' })).status, 'failed');
});

test('임시 서버: 떠 있는 글상자 문서 — 요청 내용에 배치 요약이 오고 objects_to_body 한 번으로 제안·적용·되돌리기가 된다', async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const COLS = [5200, 14000, 11000, 17600];
  const rows = (n, from) => Array.from({ length: n }, (_, i) => [i === 0 ? '분류' : '', `Action${from + i}`, '없음', `설명 글 ${from + i} 번째 줄`]);
  const source = await floatingDoc({ pages: [
    { title: '동작 목록', pageNumber: '1', table: { cols: COLS, header: true, merge: [[1, 0, 6]], rows: [['기능', 'Action', 'ParameterSet', 'explanation'], ...rows(6, 1)] } },
    { pageNumber: '2', table: { cols: COLS, merge: [[0, 0, 5]], rows: rows(5, 7).map((r) => ['', ...r.slice(1)]) } },
  ] });
  const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()), '동작목록.hwpx');
  const D = `/api/docs/${doc.id}`;
  const before = (await api(`${D}/paragraphs`)).length;
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '문서 전체의 내용을 표로 만들고 불필요한 양식 및 개체는 삭제해줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);

  const brief = json(await v2.call('task'));
  assert.match(brief.map, /⚠ 글의 100%가 떠 있는 글상자 안에 있다/);
  assert.match(brief.context, /\[s0\/p0\] 글상자 \d+ · 선 \d+ · 면 1 → L1 "동작 목록" · 표 7×4\(머리 1줄 — 첫 줄: 기능 \| Action \| ParameterSet \| explanation\) · L2 "1"\(쪽 번호\)/);
  assert.match(brief.context, /objects_to_body 로 옮기면: 표 1개 — ① s0\/p0~s1\/p0 12줄×4칸\(합친 칸 1\) · 문단 1개 · 버릴 줄 2개\(쪽 번호\)/);
  assert.ok(JSON.stringify(brief).length < 2500);
  // 본문 보기는 조각을 줄줄이 싣지 않고 한 줄로 알린다. 배치 보기(자세히)는 줄 번호와 표 줄
  const text = textOf(await v2.call('read', { doc_id: doc.id }));
  assert.match(text, /◰ 떠 있는 개체: .*read view='layout' at='s0\/p0'/); assert.ok(!text.includes('Action3'));
  const layout = textOf(await v2.call('read', { doc_id: doc.id, view: 'layout', at: 's0/p0' }));
  assert.match(layout, / L1 동작 목록\n 표 7×4 \(머리 1줄\)\n  r0 \| 기능 \| Action \| ParameterSet \| explanation \|\n  r1 \| 분류 \| Action1 \| 없음 \| 설명 글 1 번째 줄 \|\n  r2 \| ↑ \| Action2 /);
  assert.match(layout, / L2 1 {2}← 쪽 번호로 보임/);

  // 미리 해 보기: 저장하지 않고 결과와 새 주소를 보여 준다
  const ids = { doc_id: doc.id, request_id: req.rid, expected_attempt: 1 };
  const dry = json(await v2.call('edit', { ...ids, ops: [{ op: 'objects_to_body' }], dry_run: true }));
  assert.equal(dry.dry_run, true);
  assert.match(dry.structure.labels[0], /^개체 → 본문: 표 1개\(12×4\) · 문단 1개 · 글상자·선 \d+개 지움 · 쪽 번호 2줄 버림 · 구역 2→1 · 여백 좌우 20mm$/);
  assert.match(dry.structure.result[0].text, /빠진 글자 0\)$/);
  assert.match(dry.structure.after, /^\[s0\/p0\] 〔.+〕 동작 목록\n\[s0\/p1\]\n ▦ s0\/p1#t0 표 12×4\n  r0 \| 기능 \| Action/);
  assert.equal((await api(`${D}/proposals`)).length, 0);

  // 제안(쪽 구성 제안 하나) + 완료
  const out = json(await v2.call('edit', { ...ids, ops: [{ op: 'objects_to_body' }], done: '글상자·선으로 흩어져 있던 내용을 표 하나와 제목 문단으로 옮기고 기존 개체를 정리했습니다.' }));
  assert.equal(out.completed, true); assert.deepEqual(out.structure.ops, [0]);
  assert.deepEqual(out.structure.result[0].tables.map((x) => [x.rows, x.cols, x.merges, x.pages]), [[12, 4, 1, 2]]);
  const [p] = await api(`${D}/proposals`);
  assert.deepEqual([p.type, p.status, p.rid], ['page_layout', 'pending', req.rid]);
  assert.ok(!('layoutUndo' in p));
  // 사람이 적용 → 문서가 표와 제목 문단으로
  await api(`${D}/proposals/${p.pid}/apply`, { method: 'POST', body: {} });
  const after = await api(`${D}/paragraphs`);
  assert.deepEqual(after.filter((x) => !x.parent).map((x) => x.text), ['동작 목록', '']);
  const tables = await api(`${D}/tables`);
  assert.deepEqual(tables.map((x) => [x.key, x.rows, x.cols]), [['s0/p1#t0', 12, 4]]);
  assert.deepEqual(tables[0].cells.filter((c) => c.rowSpan > 1).map((c) => [c.row, c.col, c.rowSpan, c.text]), [[1, 0, 11, '분류']]);
  const map = textOf(await v2.call('read', { doc_id: doc.id, view: 'map' }));
  assert.match(map, /구역 1 · 본문 문단 2 · .* · 표 1 · 그림 0$/);
  // 되돌리기 → 글상자 문서로 돌아온다
  await api(`${D}/proposals/${p.pid}/undo`, { method: 'POST', body: {} });
  assert.equal((await api(`${D}/paragraphs`)).length, before);

  // 개체 지우기 범위(문서 전체)와 대상이 없을 때
  const req2 = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '도형을 모두 지워줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  json(await v2.call('task'));
  const del = json(await v2.call('edit', { doc_id: doc.id, request_id: req2.rid, ops: [{ op: 'delete_objects', at: '*', kinds: ['shape'] }] }));
  assert.deepEqual(del.saved.map((x) => x.ref), ['s0/p0', 's1/p0']);
  assert.match(json(await v2.call('edit', { doc_id: doc.id, request_id: req2.rid, ops: [{ op: 'delete_objects', at: '*', kinds: ['figure'] }] })).failed[0].error, /지울 개체\(figure\)가 없습니다/);

  // 같은 호출에 objects_to_body 와 delete_objects 를 함께 내면(2026-11-16 실제 Codex 가 그렇게 냈다) 옮기는 문단의 개체 지우기는 따로 제안하지 않고
  // 쪽 구성 제안 하나에 합친다 — 따로 두면 먼저 반영했을 때 옮길 글이 사라지고 나중에 반영하면 대상이 없다
  const req3 = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표로 옮기고 필요 없는 개체는 지워줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  json(await v2.call('task', { doc_id: doc.id, request_id: req3.rid }));
  const bothOps = [{ op: 'objects_to_body', join_pages: true }, { op: 'delete_objects', at: '*', kinds: ['shape'], reason: '표로 옮긴 뒤 남는 개체를 지웁니다.' }];
  const dryBoth = json(await v2.call('edit', { doc_id: doc.id, request_id: req3.rid, ops: bothOps, dry_run: true }));
  assert.deepEqual(dryBoth.notes.map((x) => x.op), [1]);
  const both = json(await v2.call('edit', { doc_id: doc.id, request_id: req3.rid, ops: bothOps, done: '글상자 내용을 표로 옮기고 개체를 정리했습니다.' }));
  assert.equal(both.completed, true); assert.equal(both.saved, undefined); assert.equal(both.failed, undefined);
  assert.match(both.notes[0].note, /^ops\[0\] objects_to_body 가 옮기는 문단 2개의 개체 지우기는 그 제안에 합쳤습니다\(따로 제안하지 않음\)/);
  const mine = (await api(`${D}/proposals`)).filter((x) => x.rid === req3.rid);
  assert.deepEqual(mine.map((x) => x.type), ['page_layout']);
  assert.deepEqual(mine[0].pageLayout.ops[0].remove_rest, [{ kinds: ['shape'], at: ['s0/p0', 's1/p0'] }]);
  await api(`${D}/proposals/${mine[0].pid}/apply`, { method: 'POST', body: {} });
  assert.deepEqual((await api(`${D}/tables`)).map((x) => [x.key, x.rows, x.cols]), [['s0/p1#t0', 12, 4]]);
  await api(`${D}/proposals/${mine[0].pid}/undo`, { method: 'POST', body: {} });

  // 두 호출로 나눠 내도 같다: 앞선 호출의 objects_to_body 제안이 대기 중이면 같은 요청의 개체 지우기를 따로 만들지 않는다
  const req4 = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표로 옮기고 필요 없는 개체는 지워줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  json(await v2.call('task', { doc_id: doc.id, request_id: req4.rid }));
  const first = json(await v2.call('edit', { doc_id: doc.id, request_id: req4.rid, ops: [{ op: 'objects_to_body' }] }));
  const second = json(await v2.call('edit', { doc_id: doc.id, request_id: req4.rid, ops: [{ op: 'delete_objects', at: '*', kinds: ['shape'] }], done: '글상자 내용을 표로 옮겼습니다.' }));
  assert.equal(second.completed, true); assert.equal(second.saved, undefined);
  assert.match(second.notes[0].note, new RegExp(`^이 요청이 앞서 낸 objects_to_body 제안\\(#${first.structure.pid}\\)이 그 문단 2개의`));
  assert.deepEqual((await api(`${D}/proposals`)).filter((x) => x.rid === req4.rid).map((x) => x.type), ['page_layout']);

  // 실행기의 도구 연결이 쓰기 직전에 보는 선점 상태(문서를 읽지 않는다): 맡은 세션만 mine
  const req5 = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '확인', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  assert.deepEqual(await api(`${D}/requests/${req5.rid}/claim`), { doc_id: doc.id, request_id: req5.rid, attempt: 1, status: 'pending', mine: false, expired: true });
  const worker = await connect(srv, 'a', { query: '?v=2&tools=core', headers: { 'X-Hwpx-Agent-Session': 'claim_s1' } }); open.push(worker);
  json(await worker.call('task', { doc_id: doc.id, request_id: req5.rid }));
  assert.deepEqual(await api(`${D}/requests/${req5.rid}/claim`, { headers: { 'X-Hwpx-Agent-Session': 'claim_s1' } }), { doc_id: doc.id, request_id: req5.rid, attempt: 1, status: 'working', mine: true, expired: false });
  const other = await api(`${D}/requests/${req5.rid}/claim`, { headers: { 'X-Hwpx-Agent-Session': 'claim_s2' } });
  assert.deepEqual([other.status, other.mine, other.expired], ['working', false, false]);
  const asB = await srv.api('b')(`${D}/requests/${req5.rid}/claim`, { headers: { 'X-Hwpx-Agent-Session': 'claim_s1' } });
  assert.equal(asB.mine, false, '맡은 세션 id 를 흉내 내도 사용자가 다르면 mine 이 아니다');
  assert.equal((await api.res(`${D}/requests/999/claim`)).status, 404);
});

test('같은 호출의 objects_to_body 와 delete_objects: 옮기는 문단의 개체 지우기는 그 op 에 합치고 나머지만 따로 제안한다', async () => {
  const COLS = [8000, 20000, 19800];
  const table = { cols: COLS, header: true, rows: [['이름', '값', '설명'], ['가', '1', '첫째']] };
  const make = () => floatingDoc({ pages: [{ title: '첫 쪽', table }, { title: '둘째 쪽', table }] });
  const prep = (doc, ops) => { const parsed = parseOps(ops); assert.deepEqual(parsed.errors, []); return prepareOps(doc, parsed.ok); };
  // 옮기는 문단(s0/p0)만 합치고, 옮기지 않는 문단(s1/p0)의 개체 지우기는 따로 제안으로 — op 차례가 바뀌어도 같다
  const part = prep(await make(), [{ op: 'delete_objects', at: '*', kinds: ['shape'] }, { op: 'objects_to_body', at: 's0/p0', remove_rest: ['figure'] }]);
  assert.deepEqual(part.errors, []);
  assert.deepEqual(part.steps.map((s) => s.kind), ['proposals', 'structure']);
  assert.deepEqual(part.steps[0].items.map((x) => [x.input.type, x.input.ref]), [['delete', 's1/p0']]);
  assert.deepEqual(part.steps[1].ops[0].remove_rest, [{ kinds: ['figure'] }, { kinds: ['shape'], at: ['s0/p0'] }]);
  assert.deepEqual(part.notes.map((x) => x.op), [0]);
  // 종류를 주지 않은 개체 지우기(모든 종류)와 종류를 준 것은 따로 싣고, 같은 종류는 한 항목으로 모은다
  const many = prep(await make(), [{ op: 'objects_to_body' }, { op: 'delete_objects', at: 's0/p0' }, { op: 'delete_objects', at: 's1/p0', kinds: ['shape'] }, { op: 'delete_objects', at: ['s0/p0'], kinds: ['shape'] }]);
  assert.deepEqual(many.steps.map((s) => s.kind), ['structure']);
  assert.deepEqual(many.steps[0].ops[0].remove_rest, [{ at: ['s0/p0'] }, { kinds: ['shape'], at: ['s1/p0', 's0/p0'] }]);
  assert.deepEqual(many.notes.map((x) => x.op), [1, 2, 3]);
  // objects_to_body 가 없으면 예전 그대로(문단마다 개체 지우기 제안), 그 op 가 옮길 것이 없는 문단을 가리키면 합치지 않는다
  const plain = prep(await make(), [{ op: 'delete_objects', at: '*', kinds: ['shape'] }]);
  assert.deepEqual([plain.steps[0].items.map((x) => x.input.ref), plain.notes], [['s0/p0', 's1/p0'], []]);
  // 없는 구역을 가리킨 objects_to_body 는 그 op 번호로 알린다(아무것도 저장하지 않는다)
  const bad = prepareOps(await make(), parseOps([{ op: 'objects_to_body', at: 's9' }]).ok);
  assert.match(bad.errors[0].error, /^ops\[0\] objects_to_body: /);
  // 앞선 호출에서 낸 objects_to_body 제안(대기 중)이 옮길 문단의 개체 지우기는 따로 제안하지 않고 알린다 — 그 밖의 문단은 그대로 제안
  const delAll = parseOps([{ op: 'delete_objects', at: '*', kinds: ['shape'] }]).ok;
  const after = prepareOps(await make(), delAll, { earlier: [{ pid: 7, at: '*' }] });
  assert.deepEqual([after.errors, after.steps, after.notes.map((x) => x.op)], [[], [], [0]]);
  assert.match(after.notes[0].note, /^이 요청이 앞서 낸 objects_to_body 제안\(#7\)이 그 문단 2개의 글상자·선을 옮기고 지웁니다 — 개체 지우기를 따로 제안하지 않았습니다/);
  const afterPart = prepareOps(await make(), delAll, { earlier: [{ pid: 7, at: 's1/p0' }] });
  assert.deepEqual([afterPart.steps[0].items.map((x) => x.input.ref), afterPart.notes.length], [['s0/p0'], 1]);
});

test('Codex 실행기: 새 연결의 도구 허용·고정과 첫 입력', async () => {
  const job = { type: 'request', docId: 'doc_1', requestId: 3, attempt: 2, surface: 'v2' };
  assert.equal(validateCodexJob(job), job);
  assert.throws(() => validateCodexJob({ ...job, surface: 'v4' }));
  assert.throws(() => validateCodexJob({ ...job, workflow: 'content_format' }));
  const calls = [];
  const policy = codexToolPolicy(job, async (name, args) => { calls.push([name, args]); return { attempt: 2, status: 'working', claim: { mine: true, expired: false } }; });
  for (const name of ['task', 'read', 'edit', 'finish', 'preview_figure', 'export_figure', 'download_attachment_file', 'upload_result_file']) assert.equal(policy.allows(name), true, name);
  for (const name of ['read_document', 'propose_changes', 'get_request', 'start_request', 'complete_request', 'apply_proposal', 'claim_orchestration_task']) assert.equal(policy.allows(name), false, name);
  // 읽기는 문서만, 쓰기는 요청·시도까지 고정하고 쓰기 직전에 요청 상태를 확인한다
  assert.deepEqual(await policy.bind('read', { view: 'layout' }), { view: 'layout', doc_id: 'doc_1' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await policy.bind('task', {}), { doc_id: 'doc_1', request_id: 3, expected_attempt: 2 });
  assert.equal(calls.length, 0, 'task 는 쓰기 직전 확인을 하지 않는다');
  assert.deepEqual(await policy.bind('edit', { ops: [{ op: 'objects_to_body' }], done: '끝' }), { ops: [{ op: 'objects_to_body' }], done: '끝', doc_id: 'doc_1', request_id: 3, expected_attempt: 2 });
  assert.deepEqual(calls, [['get_request', { doc_id: 'doc_1', request_id: 3 }]]);
  await assert.rejects(() => policy.bind('edit', { doc_id: 'other', ops: [] }), (e) => e.code === 'MCP_SCOPE');
  await assert.rejects(() => policy.bind('finish', { request_id: 9 }), (e) => e.code === 'MCP_SCOPE');
  await assert.rejects(() => policy.bind('read_document', {}), (e) => e.code === 'MCP_SCOPE');
  // 선점 상태만 묻는 가벼운 확인(claimState — REST …/requests/:rid/claim)을 주면 쓰기 직전에 그것만 부른다(get_request 로 요청 내용 전체를 만들지 않는다)
  let state = { attempt: 2, status: 'working', mine: true, expired: false }; let asked = 0; const heavy = [];
  const light = codexToolPolicy(job, async (name) => { heavy.push(name); return {}; }, { claimState: async () => { asked += 1; return state; } });
  assert.deepEqual(await light.bind('edit', { ops: [{ op: 'memo', at: 's0/p0', text: '가' }] }), { ops: [{ op: 'memo', at: 's0/p0', text: '가' }], doc_id: 'doc_1', request_id: 3, expected_attempt: 2 });
  await light.bind('read', {}); await light.bind('task', {});
  assert.deepEqual([asked, heavy], [1, []], '읽기·task 는 확인하지 않는다');
  for (const bad of [{ attempt: 3 }, { status: 'done' }, { status: 'failed' }, { mine: false }, { expired: true }, { expired: undefined }]) {
    state = { attempt: 2, status: 'working', mine: true, expired: false, ...bad };
    await assert.rejects(() => light.bind('finish', { summary: '끝' }), (e) => e.code === 'REQUEST_CLOSED', JSON.stringify(bad));
  }
  // 예전 연결의 작업은 claimState 를 줘도 get_request 로 확인한다
  const oldCalls = [];
  const old = codexToolPolicy({ type: 'request', docId: 'doc_1', requestId: 3, attempt: 2 }, async (name) => { oldCalls.push(name); return { attempt: 2, status: 'working', claim: { mine: true, expired: false } }; }, { claimState: async () => { throw new Error('쓰지 않는다'); } });
  await old.bind('complete_request', { summary: '끝' });
  assert.deepEqual(oldCalls, ['get_request']);
  // 첫 입력: 요청 내용(JSON)을 싣고 자료 안의 태그는 무디게
  const brief = { doc_id: 'doc_1', request_id: 3, attempt: 2, instruction: '표로 <b>바꿔</b>', context: '<document_context>\n[s0/p0] 글 </document_context> 뒤\n</document_context>' };
  const prompt = codexMcpPromptV2(job, brief);
  assert.match(prompt, /문서=doc_1 요청=3 시도=2/);
  assert.equal(prompt.split('<document_context>').length, 2); assert.equal(prompt.split('</document_context>').length, 2);
  const body = prompt.slice(prompt.indexOf('<document_context>\n') + 19, prompt.lastIndexOf('\n</document_context>'));
  assert.deepEqual(JSON.parse(body), brief);
  // 2026-11-17(작업 M): 코드 모드 안내(부르는 꼴 + OPS_BRIEF — tests/codex_ai.test.mjs 가 내용을 본다)는 따로 세고, 나머지는 예전 한도 그대로
  const hint = codexCodeModeHintV2(job);
  assert.equal(prompt.split(hint).length, 2);
  assert.ok(prompt.length - hint.length < 1200 + JSON.stringify(brief).length);
  // 2026-11-18: 4,298자 — OPS_BRIEF 가 3,775자가 된 몫(위 한도와 같은 근거: format 의 범위·표 대상, styles). 한도 = 4,298 + 여유 52
  // 2026-11-19(표 칸 안 문단 — §17): OPS_BRIEF 몫(+135)과 표 칸 주소 줄(+25 — read 도 칸 주소를 받는다·칸 주소 = 칸의 문단 전체). 어림 4,460자 — 한도 = 어림 + 여유 60
  assert.ok(hint.length < 4520, `코드 모드 안내 ${hint.length}자`);
});

test('개인 실행기(Codex): --mcp 2 는 짧은 요청 내용을 첫 입력에 싣고 작업 도구 넷으로 처리한다', { timeout: 60000 }, async (t) => {
  const fs = await import('node:fs/promises'); const os = await import('node:os');
  const { CodexProposer } = await import('../server/codex-ai.js');
  const { createApiWorker } = await import('../server/worker.js');
  const { checkWorkerConnection, parseWorkerArgs, createWorkerAi } = await import('../scripts/ai-worker.mjs');
  const { fakeCodex } = await import('./helpers/codex-cli.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-v2-codex-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  t.after(async () => { await worker?.stop(); await srv.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  // 명령줄: 기본(2026-11-17 사용자 결정)·--mcp 2 → 새 연결, --mcp 1(또는 HWPX_COWORK_MCP=1) → 예전 연결
  const env = { HWPX_COWORK_TOKEN: srv.tokens.a };
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex', '--mcp', '2'], env), env).mcpSurface, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex'], env), env).mcpSurface, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex', '--mcp', '1'], env), env).mcpSurface, null);
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex'], { ...env, HWPX_COWORK_MCP: '1' }), env).mcpSurface, null);
  assert.throws(() => parseWorkerArgs(['--provider', 'codex', '--mcp', '4'], env));

  const api = srv.api('a');
  const COLS = [5200, 14000, 11000, 17600];
  const source = await floatingDoc({ pages: [{ title: '동작 목록', pageNumber: '1', table: { cols: COLS, header: true, rows: [['기능', 'Action', 'ParameterSet', 'explanation'], ['창', 'SplitAll', '없음', '창 가로 세로 나누기'], ['', 'NoSplit', '없음', '창 나누지 않음']] } }] });
  const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()), '동작목록.hwpx');
  const D = `/api/docs/${doc.id}`;
  const receipt = path.join(temp, 'receipt.json');
  const launch = await fakeCodex(temp, { mode: 'v2', receipt });
  const ai = new CodexProposer({ model: 'fake-approved-model', mcp: 'v2' }, { tempRoot: temp, env: { ...process.env, HWPX_COWORK_TOKEN: srv.tokens.a }, resolveCommand: async () => launch });
  worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, agent: 'ChatGPT (Codex)', clientName: 'hwpx-codex-worker',
    timing: { pollMs: 80, connectTimeoutMs: 3000, callTimeoutMs: 15000, backoffMs: 30, maxBackoffMs: 60, deadMs: 5000 }, log() {} });
  assert.equal((await checkWorkerConnection(worker)).toolsReady, true, '서버가 새 연결을 안다(/api/config features.mcp2)');
  worker.start();
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '문서 전체의 내용을 표로 만들고 불필요한 양식 및 개체는 삭제해줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  const deadline = Date.now() + 40000;
  while (worker.stats().completed + worker.stats().failed < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const sub = JSON.parse(await fs.readFile(receipt, 'utf8'));
  assert.equal(sub.error, undefined, sub.error);
  assert.deepEqual(worker.stats().completed, 1);
  const done = await api(`${D}/requests/${req.rid}`);
  assert.deepEqual([done.status, done.summary, done.execution, done.model], ['done', '새 연결로 처리했습니다.', 'tool-agent', 'fake-approved-model']);
  assert.equal(done.usage.input, 300);
  // Codex 가 본 것: 작업 도구 넷과 파일 도구만, 짧은 지침, 첫 입력의 요청 내용
  assert.deepEqual(sub.tools, ['download_attachment_file', 'edit', 'export_figure', 'export_skill_resource', 'finish', 'preview_figure', 'read', 'read_skill_resource', 'task', 'upload_result_file']);
  assert.match(sub.instructions, /task·read·edit·finish/); assert.ok(!/propose_changes/.test(sub.instructions));
  assert.deepEqual([sub.requestContext.doc_id, sub.requestContext.request_id, sub.requestContext.attempt], [doc.id, req.rid, 1]);
  assert.match(sub.requestContext.map, /⚠/); assert.match(sub.requestContext.context, /objects_to_body 로 옮기면: 표 1개/);
  // 2026-11-17(작업 M): 코드 모드 안내(부르는 꼴 + OPS_BRIEF)는 따로 세고 나머지는 예전 한도 그대로
  const hint = codexCodeModeHintV2({ docId: doc.id, requestId: req.rid, attempt: 1 });
  assert.ok(sub.prompt.includes(hint));
  assert.ok(sub.prompt.length - hint.length < 4000, `첫 입력(안내 ${hint.length}자 뺌) ${sub.prompt.length - hint.length}자`);
  assert.equal(sub.receipt.completed, true);
  assert.match(sub.receipt.structure.labels[0], /^개체 → 본문: 표 1개\(3×4\)/);
  const proposals = await api(`${D}/proposals`);
  assert.deepEqual(proposals.map((p) => [p.type, p.rid]), [['page_layout', req.rid]]);
  const activity = await api(`${D}/requests/${req.rid}/activity`);
  // 마지막 '완료' 는 실행기가 사용량·모델을 요청에 남기는 호출(예전 연결과 같다 — server/worker.js persistNativeUsage)
  assert.deepEqual(activity.items.map((i) => i.label).filter((l) => !/조판 확인/.test(l)), ['요청을 맡음', '문서 얼개 확인', '개체 → 본문 · 완료', '완료']);
});

test('브리지(--v2)와 에이전트 준비(setup-agent --v2): 새 연결 머리글·지침·허용 목록', { timeout: 60000 }, async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createBridge } = await import('../server/bridge.js');
  const { main: setupAgent, mcpEntry, V2_PERMISSIONS } = await import('../scripts/setup-agent.mjs');
  const srv = await startServer({ ai: 'off' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-v2-agent-'));
  let bridge; let client;
  t.after(async () => { await client?.close().catch(() => {}); await bridge?.stop().catch(() => {}); await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 브리지: --v2 는 서버에 X-Hwpx-Mcp: 2 를 보내 작업 도구 넷(+ 내 PC 파일 도구)을 중계하고, 채널 안내도 새 연결용이다
  bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, v2: true, toolset: 'core', channel: true, filesDir: path.join(tmp, 'work'), log() {} });
  assert.ok(bridge.instructions.startsWith(CHANNEL_INSTRUCTIONS_V2) && bridge.instructions.length <= 2048 && /task\(맡기/.test(bridge.instructions));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.start(serverSide);
  client = new Client({ name: 'claude-code', version: '2.1.300' });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['download_attachment_file', 'edit', 'export_figure', 'export_skill_resource', 'finish', 'preview_figure', 'read', 'read_skill_resource', 'task', 'upload_result_file']);
  assert.deepEqual(json(await client.callTool({ name: 'task', arguments: {} })), { none: true });
  // 주소의 ?v=2 도 같은 뜻
  const viaUrl = await createBridge({ url: `${srv.base}/mcp?v=2`, token: srv.tokens.a, log() {} });
  assert.match(viaUrl.instructions, /task\(맡기/);
  await viaUrl.stop();

  // 에이전트 준비(2026-11-17 — 기본 새 연결): .mcp.json 에 --v2, CLAUDE.md 는 새 연결 본보기(agent/CLAUDE.md), 허용 목록에 작업 도구 넷.
  // --v1 은 예전 연결(--v1 --lean, CLAUDE.md 는 agent/v1/CLAUDE.md) — 고른 것이 남아 다시 준비해도 그대로, --v2 로 돌아올 수 있다
  assert.deepEqual(mcpEntry('/b.js', 'http://x/mcp', '/w', { v2: true }).args, ['/b.js', '--channel', '--v2', '--url', 'http://x/mcp', '--files-dir', '/w']);
  assert.deepEqual(mcpEntry('/b.js', 'http://x/mcp').args, ['/b.js', '--channel', '--v2', '--url', 'http://x/mcp']);
  assert.deepEqual(mcpEntry('/b.js', 'http://x/mcp', null, { v2: false }).args, ['/b.js', '--channel', '--v1', '--lean', '--url', 'http://x/mcp']);
  const dir = path.join(tmp, 'agent');
  const quiet = async (argv) => { const log = console.log; const lines = []; console.log = (s = '') => lines.push(String(s)); try { return { code: await setupAgent(argv, { ...process.env, HWPX_COWORK_TOKEN: '' }), lines }; } finally { console.log = log; } };
  const args = ['--dir', dir, '--url', `${srv.base}/mcp`, '--no-claude', '--no-server', '--no-registry'];
  const v2Guide = fs.readFileSync(path.join(root, 'agent', 'CLAUDE.md'), 'utf8'); const v1Guide = fs.readFileSync(path.join(root, 'agent', 'v1', 'CLAUDE.md'), 'utf8');
  await quiet(args);   // 처음: 새 연결(기본)
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const hwpxArgs = () => JSON.parse(read('.mcp.json')).mcpServers.hwpx.args;
  assert.ok(hwpxArgs().includes('--v2') && !hwpxArgs().includes('--lean'));
  assert.equal(read('CLAUDE.md'), v2Guide); assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.v1.md')));
  const allow = JSON.parse(read(path.join('.claude', 'settings.json'))).permissions.allow;
  for (const p of V2_PERMISSIONS) assert.ok(allow.includes(p), p);
  await quiet([...args, '--v1']);   // 예전 연결로: 손대지 않은 새 연결 지침은 예전 본보기로 바꾼다
  assert.ok(hwpxArgs().includes('--v1') && hwpxArgs().includes('--lean') && !hwpxArgs().includes('--v2'));
  assert.equal(read('CLAUDE.md'), v1Guide, '--v1 은 예전 지침(agent/v1/CLAUDE.md)');
  await quiet(args);   // 방식을 주지 않으면 --v1 로 고른 예전 연결을 지킨다
  assert.ok(hwpxArgs().includes('--v1')); assert.equal(read('CLAUDE.md'), v1Guide);
  await quiet([...args, '--v2']);   // 새 연결로: 예전 지침은 CLAUDE.v1.md 로 남기고 바꾼다
  assert.ok(hwpxArgs().includes('--v2') && !hwpxArgs().includes('--lean'));
  assert.match(read('CLAUDE.md'), /task\(doc_id, request_id\)/); assert.ok(!/start_request/.test(read('CLAUDE.md')));
  assert.match(read('CLAUDE.v1.md'), /start_request/, '예전 지침은 남긴다');
  await quiet([...args, '--v1']);   // 다시 예전 연결로: 남겨 둔 CLAUDE.v1.md 를 되살린다
  assert.equal(read('CLAUDE.md'), v1Guide);
  // 예전 기본(--lean 만 — 고르지 않은 예전 연결)으로 준비된 옛 작업 공간: 인자 없이 다시 준비하면 새 기본으로 바꾸고 알린다(예전 지침은 CLAUDE.v1.md)
  const oldDir = path.join(tmp, 'agent-old-default');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, hwpx: { command: 'node', args: ['/old/mcp-stdio.js', '--channel', '--lean', '--url', `${srv.base}/mcp`], env: { HWPX_COWORK_TOKEN: '${HWPX_COWORK_TOKEN}' } } } }));
  fs.writeFileSync(path.join(oldDir, 'CLAUDE.md'), `${v1Guide}\n- 내가 더한 규칙 한 줄\n`);
  const switched = await quiet(['--dir', oldDir, '--url', `${srv.base}/mcp`, '--no-claude', '--no-server', '--no-registry']);
  const oldCfg = JSON.parse(fs.readFileSync(path.join(oldDir, '.mcp.json'), 'utf8'));
  assert.ok(oldCfg.mcpServers.hwpx.args.includes('--v2') && oldCfg.mcpServers.other.command === 'x');
  assert.ok(switched.lines.some((l) => /예전 기본\(예전 연결\)으로 준비된 작업 공간을 새 기본/.test(l)), switched.lines.join('\n'));
  assert.equal(fs.readFileSync(path.join(oldDir, 'CLAUDE.md'), 'utf8'), v2Guide);
  assert.match(fs.readFileSync(path.join(oldDir, 'CLAUDE.v1.md'), 'utf8'), /내가 더한 규칙 한 줄/, '고쳐 쓴 예전 지침도 CLAUDE.v1.md 로 남긴다');

  // 소스 폴더의 agent/(배포 묶음·시험이 읽는 새 연결 본보기)는 그 자리에서 예전 연결로 바꾸지 않는다 — 아무것도 쓰지 않고 다른 폴더를 안내한다
  const realAgent = path.join(root, 'agent');
  const snapshot = () => ['.mcp.json', 'CLAUDE.md', 'CLAUDE.v1.md'].map((name) => { try { return fs.readFileSync(path.join(realAgent, name), 'utf8'); } catch { return null; } });
  const beforeReal = snapshot();
  const inPlace = await quiet(['--no-claude', '--no-server', '--no-registry', '--v1']);
  assert.equal(inPlace.code, 2);
  assert.ok(inPlace.lines.some((l) => /새 연결 본보기라 그 자리에서 예전 연결\(--v1\)로 바꾸지 않습니다/.test(l)) && inPlace.lines.some((l) => /--dir agent-v1 --v1/.test(l)), inPlace.lines.join('\n'));
  assert.deepEqual(snapshot(), beforeReal, '진짜 agent/ 의 파일은 그대로');

  // 서버 확인: 새 연결을 모르는 서버(/api/config 에 features.mcp2 없음)에 --v2 로 준비하면 알린다 — 그 서버는 예전 도구로 답해 새 지침과 맞지 않는다
  const http = await import('node:http');
  const stub = http.createServer((req, res) => {
    if (req.url === '/api/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'hwpx-cowork', version: '0.4.0' })); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const unknown = /이 서버는 새 연결\(--v2\)을 모릅니다/;
  const onOld = await quiet(['--dir', path.join(tmp, 'agent-old'), '--url', `http://127.0.0.1:${stub.address().port}/mcp`, '--no-claude', '--no-registry', '--v2']);
  assert.ok(onOld.lines.some((l) => unknown.test(l)), onOld.lines.join('\n'));
  const onOldV1 = await quiet(['--dir', path.join(tmp, 'agent-old1'), '--url', `http://127.0.0.1:${stub.address().port}/mcp`, '--no-claude', '--no-registry', '--v1']);
  assert.ok(!onOldV1.lines.some((l) => unknown.test(l)), '예전 연결(--v1)로 준비할 때는 알리지 않는다');
  const onOldDefault = await quiet(['--dir', path.join(tmp, 'agent-old2'), '--url', `http://127.0.0.1:${stub.address().port}/mcp`, '--no-claude', '--no-registry']);
  assert.ok(onOldDefault.lines.some((l) => unknown.test(l) && /--v1/.test(l)), `기본(새 연결)으로 옛 서버에 준비하면 알리고 --v1 을 안내한다: ${onOldDefault.lines.join('\n')}`);
  const onNew = await quiet(['--dir', path.join(tmp, 'agent-new'), '--url', `${srv.base}/mcp`, '--no-claude', '--no-registry', '--v2']);
  assert.ok(!onNew.lines.some((l) => unknown.test(l)), onNew.lines.join('\n'));
});

test('자동 반영 문서: edit 의 done 이 완료하면서 개체 → 본문 제안을 바로 반영하고 영수증에 그 상태를 싣는다', { timeout: 60000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const source = await floatingDoc({ pages: [{ title: '동작 목록', pageNumber: '1', table: { cols: [8000, 20000, 19800], header: true, rows: [['이름', '값', '설명'], ['A', '1', '첫째 줄'], ['B', '2', '둘째 줄']] } }] });
  const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()), '자동반영.hwpx');
  const D = `/api/docs/${doc.id}`;
  await api(`${D}/settings`, { method: 'PATCH', body: { aiApply: 'auto', editMode: 'realtime' } });
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표로 정리해줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);
  json(await v2.call('task'));
  const out = json(await v2.call('edit', { doc_id: doc.id, request_id: req.rid, ops: [{ op: 'objects_to_body' }], done: '글상자를 표와 제목 문단으로 옮겼습니다.' }));
  assert.equal(out.completed, true);
  assert.equal(out.structure.status, 'applied', JSON.stringify(out));
  assert.deepEqual((await api(`${D}/tables`)).map((x) => [x.key, x.rows, x.cols]), [['s0/p1#t0', 3, 3]]);
  // 반영된 뒤의 본문 보기: 제목 문단과 표(줄마다 한 줄)
  const text = textOf(await v2.call('read', { doc_id: doc.id }));
  assert.match(text, /\[s0\/p0\] 〔.+〕 동작 목록\n\[s0\/p1\]\n ▦ s0\/p1#t0 표 3×3\n  r0 \| 이름 \| 값 \| 설명 \|\n  r1 \| A \| 1 \| 첫째 줄 \|/);
  // 표 칸을 주소(표 열쇠·줄·칸)로 고친다 — 요청 없이 낸 제안도 자동 반영 문서에서는 바로 들어간다
  const cell = json(await v2.call('edit', { doc_id: doc.id, ops: [{ op: 'replace', at: { table: 's0/p1#t0', row: 1, col: 2 }, find: '첫째', with: '첫 번째' }] }));
  assert.equal(cell.saved[0].status, 'applied', JSON.stringify(cell));
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'tables', id: 's0/p1#t0' })), /r1 \| A \| 1 \| 첫 번째 줄 \|/);
});

// 2026-11-16 밤 하위 에이전트 실험(docs/MCP_REDESIGN_2026-11-16.md §10)에서 드러나 고친 것 — 실험 문서는 연습 보고서(가상 자료, 본문 8,600자쯤)
test('실험에서 고친 것: 쪽 구성 op 의 reason · runs 만 준 문단 · 서식 보기의 범위 · 짧은 문서는 요청 내용에 전문 · 지침의 도구 이름 읽는 법', async () => {
  // 쪽 구성 op 에 다른 op 처럼 reason 을 붙여도 꼴 오류가 아니다(빼고 받는다)
  const parsed = parseOps([{ op: 'paper', section: 1, margins: { left: 25 }, reason: '여백' }, { op: 'page_number', section: 1, position: 'BOTTOM_CENTER', reason: '쪽 번호' }]);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.ok.every((x) => !('reason' in x.op)));
  // 도구 설명의 op 목록에 모든 op 가 한 줄씩 있다(꼴만 보려고 read guide:ops 를 부르지 않게)
  for (const name of ['alternatives', 'fill', 'toc', 'figure', 'paper', 'page_number']) assert.match(OPS_BRIEF, new RegExp(`op:'${name}'`), name);   // chart 는 숨긴 op(2026-11-18)
  assert.match(OPS_BRIEF, /occurrence 번째\(1부터/); assert.match(OPS_BRIEF, /runs:\[\{text, char/); assert.match(OPS_BRIEF, /문단째 지우기는 delete_paragraphs/);   // 2026-11-17 §10.4 나-1: '문단을 지우는 op 는 없다' → 새 op 안내

  const srv = await startServer({ ai: 'off' });
  const open = [];
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx'));
    const req = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '오타를 고쳐줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
    const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);
    // 문서 전체 대상 + 짧은 문서: 끊지 않고 전문(마지막 문단까지), 이어 읽기 안내(more) 없음
    const brief = json(await v2.call('task', { doc_id: doc.id, request_id: req.rid }));
    assert.equal(brief.more, undefined, brief.more);
    assert.match(brief.context, /\[s1\/p73\]/);
    // runs 만 준 문단: 글은 조각을 이은 것 — 저장된다
    const receipt = json(await v2.call('edit', { doc_id: doc.id, request_id: req.rid, expected_attempt: 1, ops: [{ op: 'insert', after: 's1/p66', paragraphs: [{ runs: [{ text: '(요약)', char: { bold: true } }, { text: ' 본문에 있는 수치만 썼음.' }] }] }] }));
    assert.equal(receipt.saved.length, 1, JSON.stringify(receipt)); assert.equal(receipt.failed, undefined);
    const saved = (await api(`/api/docs/${doc.id}/proposals`)).find((p) => p.pid === receipt.saved[0].pid);
    assert.equal(saved.text, '(요약) 본문에 있는 수치만 썼음.');
    // 서식 보기: 범위 주소('s1/p3..p5')를 그 안의 본문 문단으로 푼다 — 안내 글은 새 연결의 이름으로
    const fmt = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: 's1/p3..p5' }));
    assert.deepEqual(fmt.paragraphs.map((p) => p.ref), ['s1/p3', 's1/p4', 's1/p5']);
    assert.doesNotMatch(fmt.header.note, /get_formatting/); assert.match(fmt.header.note, /read\(view='format'/);
    assert.match(errorOf(await v2.call('read', { doc_id: doc.id, view: 'format', at: 's1/p900..p905' })), /NO_PARAGRAPH/);
    // 작성 지침: 예전 도구 이름을 새 op 로 읽는 법이 앞에 온다
    const guide = json(await v2.call('read', { doc_id: doc.id, view: 'guide' }));
    assert.match(guide.names, /propose_insert.*op:'insert'/); assert.ok(guide.guide);
    // 차트 폭 오류는 본문 폭을 알려 준다
    const chart = json(await v2.call('edit', { doc_id: doc.id, request_id: req.rid, expected_attempt: 1, ops: [{ op: 'chart', after: 's1/p35', chart: { type: 'bar' }, source_table: { table: 's1/p35#t0', header_row: 0, category_col: 0, value_cols: [5], data_rows: [1, 2, 3, 4, 5] }, width_mm: 290 }] }));
    assert.match(chart.failed[0].error, /본문 폭 \d+(\.\d)?mm 이하/);
    // 빈 문단에 글 넣기 + 같은 문단 스타일(논문 실험 2건이 낸 꼴): 따로 제안하면 스타일 제안이 반영에서 실패한다(FORMAT_PARAGRAPH_RANGE) → replace 하나로 합쳐 낸다
    const blank = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'server', 'templates', 'blank.hwpx'));
    const req2 = (await api(`/api/docs/${blank.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '제목을 넣어줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
    json(await v2.call('task', { doc_id: blank.id, request_id: req2.rid }));
    const titled = json(await v2.call('edit', { doc_id: blank.id, request_id: req2.rid, expected_attempt: 1, done: '제목을 넣었습니다',
      ops: [{ op: 'replace', at: 's0/p0', find: '', with: '논문 제목' }, { op: 'format', at: 's0/p0', style: '&본문제목' }, { op: 'insert', after: 's0/p0', text: '본문 첫 문단' }] }));
    assert.equal(titled.saved.length, 2, JSON.stringify(titled)); assert.match(titled.notes[0].note, /replace 에 합쳤습니다/); assert.equal(titled.completed, true);
    const resolved = await api(`/api/docs/${blank.id}/requests/${req2.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
    assert.equal(resolved.counts.failed, 0, JSON.stringify(resolved.results)); assert.equal(resolved.counts.applied, 2);
    const titleFmt = json(await v2.call('read', { doc_id: blank.id, view: 'format', at: 's0/p0' }));
    assert.equal(titleFmt.paragraphs[0].text, '논문 제목');
    assert.equal(titleFmt.header.styles.find((x) => x.id === titleFmt.paragraphs[0].styleId)?.name, '&본문제목');
    // 누름틀을 이름만으로 채우기: 이름이 같은 칸이 둘이면 제안도 둘 — 영수증이 op 번호와 맞고 done 까지 처리된다
    // (고치기 전: 저장 단계가 한 항목을 둘로 나눠 영수증을 만들다 예외 — 제안은 저장됐는데 오류 응답이 가고 요청이 완료되지 않았다)
    const form = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'tests', 'fixtures', 'field_fill_seed.hwpx'));
    const req3 = (await api(`/api/docs/${form.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '누름틀을 채워줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
    json(await v2.call('task', { doc_id: form.id, request_id: req3.rid }));
    const filled = json(await v2.call('edit', { doc_id: form.id, request_id: req3.rid, expected_attempt: 1, done: '누름틀을 채웠습니다',
      ops: [{ op: 'fill', fields: [{ name: '신청인', value: '홍길동' }, { name: '날짜', value: '2026. 11. 16.' }] }] }));
    // 2026-11-17(작업 F — §10.4 나-10): 같은 op 의 제안 셋 이상은 영수증 한 줄 { op, pids, count }
    assert.equal(filled.saved.length, 1, JSON.stringify(filled)); assert.equal(filled.saved[0].op, 0); assert.equal(filled.saved[0].count, 3); assert.equal(filled.failed, undefined); assert.equal(filled.completed, true);
    assert.equal((await api(`/api/docs/${form.id}/requests/${req3.rid}`)).status, 'done');
    // replace 의 style 인자로도 같다(글과 스타일을 한 제안으로)
    assert.equal(parseOps([{ op: 'replace', at: 's0/p0', find: '', with: '제목', style: '&본문제목' }]).errors.length, 0);
  } finally { for (const c of open) await c.close(); await srv.stop(); }
});
