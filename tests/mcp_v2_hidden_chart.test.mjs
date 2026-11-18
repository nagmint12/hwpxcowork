// 한/글 차트 개체(chart op)는 숨긴 op 다(2026-11-18 사용자 결정 — server/mcp2/ops.js HIDDEN_OPS, docs/MCP_REDESIGN_2026-11-16.md §14). 모델을 부르지 않는다.
//  · 차트·그래프 등 시각화의 기본은 AI 가 직접 그린 그림(figure — svg·그림 파일)이다. 도구 설명·op 목록·Codex 첫 입력·모델 지침·에이전트 본보기에 chart op 가 없다
//  · 안내는 두 길뿐: AI 가 물을 때(read view='guide' id='chart', id='ops' 끝 한 줄)와 지시가 한/글 차트 개체를 명시했을 때(요청 내용 todo)
//  · chart op 를 내면 전처럼 받는다(한/글 차트 제안). 예전 연결은 도구(propose_chart)는 그대로이고 글만 '명시 요청 때만'
//   node --test tests/mcp_v2_hidden_chart.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, root } from './helpers/server.mjs';
import { parseOps, opsGuide, OPS_BRIEF, OP_NAMES, VISIBLE_OP_NAMES, HIDDEN_OPS, nativeChartAsked, NATIVE_CHART_TODO } from '../server/mcp2/ops.js';
import { EDITOR_INSTRUCTIONS, EDITOR_INSTRUCTIONS_V2, EDITOR_INSTRUCTIONS_API_V2 } from '../server/editor-instructions.js';
import { codexCodeModeHintV2 } from '../server/codex-ai.js';

const textOf = (result) => (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (result) => { assert.ok(!result.isError, textOf(result)); return JSON.parse(textOf(result)); };

async function connect(srv, who, { query = '', headers = {} } = {}) {
  const client = new Client({ name: 'v2-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}`, ...headers } } });
  await client.connect(transport);
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }), close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); } };
}

// chart op 를 만드는 꼴(op:'chart')이나 그 이름(한/글 차트)이 글에 있는가 — delete_objects 의 kinds 'chart'(있는 차트 지우기)는 만드는 길이 아니다
const mentionsChartOp = (s) => /op:\s*'chart'|op:"chart"|chart op|한\/글 차트|편집 가능한 차트|propose_chart/.test(s);

test('순수 함수: op 목록·지침에 chart op 가 없고, 물을 때의 안내와 명시 요청 판정이 있다', () => {
  assert.ok(HIDDEN_OPS.includes('chart'));   // 'restyle'(여러 문단 서식의 안쪽 이름 — tests/mcp_v2_restyle.test.mjs)도 숨긴 이름이다
  assert.ok(OP_NAMES.includes('chart') && !VISIBLE_OP_NAMES.includes('chart') && VISIBLE_OP_NAMES.includes('figure'));
  // 도구 설명의 op 목록: chart 줄이 없고 figure 줄이 차트·그래프를 맡는다(직접 그리는 법 + 미리보기)
  assert.ok(!mentionsChartOp(OPS_BRIEF), 'OPS_BRIEF 에 chart op');
  const figureLine = OPS_BRIEF.split('\n').find((l) => l.includes("op:'figure'"));
  assert.match(figureLine, /차트·그래프·도식 등 시각화는 직접 그린다/); assert.match(figureLine, /svg\(viewBox/); assert.match(figureLine, /attachment_id/); assert.match(figureLine, /preview_figure/);
  assert.doesNotMatch(OPS_BRIEF.split('\n').find((l) => l.includes("op:'insert'")), /chart/);
  // 모든 op 의 꼴(guide id='ops'): 목록에는 없고 끝에 한 줄(조건과 꼴을 볼 길)
  const guide = opsGuide();
  assert.doesNotMatch(guide, /\{op:'chart'/); assert.match(guide, /\{op:'figure'/);
  assert.match(guide.split('\n').at(-1), /목록에 없는 op: 한\/글 차트 개체.*명시해 요청했을 때만.*read view='guide' id='chart'/);
  assert.doesNotMatch(guide, /id='table_edit' \| 'chart'/);
  // guide id='chart': 쓰는 조건 → 꼴 → JSON Schema
  const chartGuide = opsGuide('chart');
  assert.match(chartGuide.split('\n')[0], /명시해 요청했을 때만.*figure 로 직접 그린다/);
  assert.match(chartGuide, /\{op:'chart', after, chart:/); assert.match(chartGuide, /JSON Schema:\n\{/); assert.match(chartGuide, /source_table/);
  // 내면 받는다(꼴 검사 그대로). 모르는 op 오류의 이름 목록에는 없다
  assert.deepEqual(parseOps([{ op: 'chart', after: 's0/p1', chart: { type: 'bar', categories: ['가'], series: [{ name: '값', values: [1] }] }, caption: '제목' }]).errors, []);
  const unknown = parseOps([{ op: 'nope' }]).errors[0].error;
  assert.match(unknown, /모르는 op "nope"/); assert.match(unknown, /· figure ·/); assert.doesNotMatch(unknown, /chart/);
  // chart op 꼴 오류는 전처럼 꼴(sig)을 알려 준다 — 거기에 쓰는 조건이 적혀 있다
  assert.match(parseOps([{ op: 'chart', after: 's0/p1', chart: { type: 'bar', y_label: '점' } }]).errors[0].error, /꼴: \{op:'chart'.*명시해 요청했을 때만/);

  // 지시가 한/글 차트 개체를 가리켜 말했는가: 그냥 차트·그래프·시각화는 아니다
  for (const s of ['한글 차트로 만들어줘', '한/글 차트 개체로 넣어줘', '한글의 차트 기능으로 작성해줘', '편집 가능한 차트로 만들어줘', '한글에서 수정할 수 있는 차트로', '차트 개체로 넣어줘', '네이티브 차트로',
    'hwp 차트로 그려줘', 'chart 기능을 사용해서 만들어줘', '한글 고유 차트로', '한글에서 다시 편집할 수 있게 그래프를 넣어줘', '그래프는 한글에서 직접 수정할 수 있어야 해', '수정 가능한 그래프로', '한글 자체 차트 기능으로']) assert.equal(nativeChartAsked(s), true, s);
  for (const s of ['표 전체의 action 및 기능 통계를 작성하여 차트를 제시해줘', '전체 문서의 frame action 기능별로 통계를 내어서 차트를 제작해줘', '시각화를 좀 개선해서 깔끔하게 색을 써서 작성해줘', '표3을 시각화하여 제시해줘',
    '한글 문서에 차트를 넣어줘', '그래프로 그려줘', '막대 차트로 비교해줘', '차트 제목을 한글로 바꿔줘', '한글로 차트 설명을 써줘', '차트 기능별 통계를 내줘', '', null, undefined]) assert.equal(nativeChartAsked(s), false, String(s));
  assert.match(NATIVE_CHART_TODO, /새로 만들라는 지시면 edit 의 chart op.*read\(view='guide', id='chart'\).*아니면 차트·그래프는 figure 로 직접 그린다/);

  // 모델 지침(새 연결): chart op 가 없고 시각화는 figure 로 직접 그린다. Codex 첫 입력의 op 꼴도 같다(OPS_BRIEF 그대로)
  for (const text of [EDITOR_INSTRUCTIONS_V2, EDITOR_INSTRUCTIONS_API_V2]) { assert.ok(!mentionsChartOp(text) && !/chart/.test(text)); assert.match(text, /차트·그래프·도식 등 시각화는 figure로 직접 그린 그림으로 냅니다/); }
  assert.ok(!mentionsChartOp(codexCodeModeHintV2({ docId: 'd', requestId: 1, attempt: 1 })));
  // 에이전트 본보기(새 연결): chart op 가 없다
  const agentGuide = fs.readFileSync(path.join(root, 'agent', 'CLAUDE.md'), 'utf8');
  assert.ok(!/`chart`/.test(agentGuide) && !mentionsChartOp(agentGuide)); assert.match(agentGuide, /시각화는 `figure` 로 \*\*직접 그린 그림\*\*으로 낸다/);
  // 예전 연결의 글: 차트 기본은 직접 그린 그림, propose_chart 는 명시 요청 때만(도구는 그대로)
  assert.match(EDITOR_INSTRUCTIONS, /시각화는 propose_figure\(svg로 직접 그리거나 chart 자료\)의 그림으로 만듭니다\. 한\/글에서 편집되는 차트 개체\(propose_chart\)는 사용자가 그것을 명시해 요청했을 때만/);
  assert.doesNotMatch(EDITOR_INSTRUCTIONS, /자동 대체하지/);
  assert.match(fs.readFileSync(path.join(root, 'agent', 'v1', 'CLAUDE.md'), 'utf8'), /`propose_chart` — 표가 있으면[^\n]*명시해 요청했을 때만 쓴다/);
});

test('임시 서버: 새 연결 도구 정의에 chart op 가 없고, 명시한 지시에만 꼴 안내가 오며, chart op 는 내면 저장된다', { timeout: 120000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx'));
  const ask = async (instruction) => (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction, target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;

  // 도구 정의(core·all): 어디에도 chart op 가 없다. op 이름은 글자(enum 없음 — 숨긴 이름을 드러내지도, 명시 요청 때의 chart 를 막지도 않는다), 미리보기는 svg 만
  const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);
  const all = await connect(srv, 'a', { headers: { 'X-Hwpx-Mcp': '2' } }); open.push(all);
  for (const c of [v2, all]) {
    const tools = (await c.client.listTools()).tools;
    assert.ok(!mentionsChartOp(JSON.stringify(tools.map((x) => [x.name, x.description, x.inputSchema]))), 'v2 도구 정의에 chart op');
    assert.ok(!tools.some((x) => x.name === 'propose_chart'));
    const edit = tools.find((x) => x.name === 'edit');
    assert.match(edit.description, /op:'figure'.*차트·그래프·도식 등 시각화는 직접 그린다/);
    const op = edit.inputSchema.properties.ops.items.properties.op;
    assert.equal(op.type, 'string'); assert.equal(op.enum, undefined);
    const preview = tools.find((x) => x.name === 'preview_figure');
    assert.deepEqual(Object.keys(preview.inputSchema.properties).sort(), ['after_ref', 'doc_id', 'replace_ref', 'svg', 'width_mm']);
    assert.ok(preview.inputSchema.required.includes('svg')); assert.match(preview.description, /edit 의 figure op 에 줄 svg/); assert.doesNotMatch(preview.description, /propose_figure/);
    assert.ok(!mentionsChartOp(c.client.getInstructions() || ''));
  }
  // 예전 연결(시험 받침 기본): 도구는 그대로(propose_chart 가 있다) — 설명만 '명시해 요청했을 때만', 미리보기는 chart 자료도 받는다
  const legacy = await connect(srv, 'a'); open.push(legacy);
  const legacyTools = (await legacy.client.listTools()).tools;
  assert.match(legacyTools.find((x) => x.name === 'propose_chart').description, /명시해 요청했을 때만 쓴다 — 그 밖의 차트·그래프는 propose_figure/);
  assert.ok('chart' in legacyTools.find((x) => x.name === 'preview_figure').inputSchema.properties);

  // 그냥 '차트' 지시: 요청 내용 어디에도 chart op 안내가 없다 → 직접 그린 그림(figure svg)으로 낸다
  const plain = await ask('표의 응답 분포를 차트로 제시해줘');
  const brief = json(await v2.call('task', { doc_id: doc.id, request_id: plain.rid }));
  assert.ok(!mentionsChartOp(brief.todo), brief.todo);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="#fff"/><rect x="120" y="120" width="120" height="220" fill="#1F4E79"/><rect x="340" y="200" width="120" height="140" fill="#7F7F7F"/><text x="180" y="100" font-size="32" text-anchor="middle">62</text><text x="400" y="180" font-size="32" text-anchor="middle">38</text></svg>';
  const shown = await v2.call('preview_figure', { doc_id: doc.id, svg, width_mm: 100, after_ref: 's1/p35' });
  assert.ok(!shown.isError, textOf(shown)); assert.ok(shown.content.some((c) => c.type === 'image')); assert.match(textOf(shown), /같은 svg 로 edit 의 \{op:'figure'\} 를 낸다/);
  const drawn = json(await v2.call('edit', { doc_id: doc.id, request_id: plain.rid, expected_attempt: 1, done: '응답 분포를 그림으로 제시했습니다.',
    ops: [{ op: 'figure', after: 's1/p35', svg, caption: '응답 분포', width_mm: 100 }] }));
  assert.equal(drawn.failed, undefined, JSON.stringify(drawn)); assert.equal(drawn.saved.length, 1); assert.equal(drawn.completed, true);
  const figure = (await api(`/api/docs/${doc.id}/proposals`)).find((p) => p.pid === drawn.saved[0].pid);
  assert.equal(figure.type, 'figure'); assert.equal(figure.figure.nativeChart, undefined); assert.equal(figure.figure.caption, '응답 분포');

  // 한/글 차트 개체를 명시한 지시: 할 일(todo)에 꼴을 볼 길이 한 줄 온다 → guide id='chart' → chart op 가 전처럼 저장된다
  const explicit = await ask('표의 응답 분포를 한글에서 편집 가능한 차트로 만들어줘');
  const brief2 = json(await v2.call('task', { doc_id: doc.id, request_id: explicit.rid }));
  assert.ok(brief2.todo.includes(NATIVE_CHART_TODO), brief2.todo);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'guide', id: 'chart' })), /명시해 요청했을 때만[\s\S]*\{op:'chart', after, chart:[\s\S]*JSON Schema/);
  assert.match(textOf(await v2.call('read', { doc_id: doc.id, view: 'guide', id: 'ops' })), /목록에 없는 op: 한\/글 차트 개체/);
  const native = json(await v2.call('edit', { doc_id: doc.id, request_id: explicit.rid, expected_attempt: 1, done: '편집 가능한 차트를 제안했습니다.',
    ops: [{ op: 'chart', after: 's1/p35', chart: { type: 'bar', title: '응답 분포', categories: ['그렇다', '아니다'], series: [{ name: '응답', values: [62, 38] }] }, caption: '응답 분포 차트' }] }));
  assert.equal(native.failed, undefined, JSON.stringify(native)); assert.equal(native.saved.length, 1); assert.equal(native.completed, true);
  const chart = (await api(`/api/docs/${doc.id}/proposals`)).find((p) => p.pid === native.saved[0].pid);
  assert.equal(chart.type, 'figure'); assert.equal(chart.figure.nativeChart.type, 'bar'); assert.deepEqual(chart.figure.nativeChart.series[0].values, [62, 38]);
});
