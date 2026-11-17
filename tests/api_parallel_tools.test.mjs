// 기본 native API 어댑터 계약을 검증한다.
// API(OpenAI 방식) API 실행기: 한 응답에 도구 여럿(parallel_tool_calls) — 받은 차례대로 실행하고 결과를 모두 한 번에 돌려준다.
// 같은 자리에 넣은 문단·표는 '모두 반영' 뒤에도 부른 차례 그대로, 틀린 호출 하나는 그 호출만 오류. API 는 가짜 fetch, 문서·서버는 임시 복사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { fixture } from './helpers/server.mjs';

const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const result = { proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '절을 썼습니다.', instructionSummary: '절 쓰기' };
const fn = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });

test('한 응답의 도구 여럿: 차례대로 실행·결과를 한 번에 돌려주고(2번 왕복), 같은 자리 넣기는 반영 뒤에도 부른 차례, 틀린 호출만 오류', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-parallel-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;

  const CALLS = [
    fn('c1', 'propose_insert', { after_ref: 's0/p0', text: '가) 첫째로 넣은 문단' }),
    fn('c2', 'propose_insert', { after_ref: 's0/p0', text: '나) 둘째로 넣은 문단' }),
    fn('c3', 'propose_table', { after_ref: 's0/p0', rows: [['구분', '값'], ['가', '1']], caption: '시험 표' }),
    fn('c4', 'propose_changes', { proposals: [{ ref: 's0/p2', find: '문서에 없는 글', replace: '바꿀 글' }] }),
    fn('c5', 'add_memo', { ref: 's0/p1', find: '둘째 문단', text: '근거를 확인해 주세요' }),
  ];
  const bodies = [];
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (bodies.length === 1) return json({ status: 'completed', output: CALLS, usage: { input_tokens: 100, output_tokens: 20 } });
    return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 120, output_tokens: 5 } });
  } });
  service.personalAi.save(user, { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', key: 'fake-api-key-parallel' });

  const done = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p0' }, instruction: '이 문단 뒤에 절을 써 줘' }, user);
  assert.equal(done.request.status, 'done', done.request.error || '');
  assert.equal(bodies.length, 2, '도구 다섯 개를 한 번 왕복으로');
  assert.equal(bodies[0].parallel_tool_calls, true, '한 응답에 도구 여럿을 허용한다');

  // 두 번째 요청: 다섯 호출의 결과가 부른 차례대로, 틀린 호출(c4)만 오류
  const outs = bodies[1].input.filter((i) => i.type === 'function_call_output');
  assert.deepEqual(outs.map((o) => o.call_id), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.match(outs[3].output, /찾지 못|없|오류|error/i, `c4 는 오류: ${outs[3].output.slice(0, 200)}`);
  for (const o of [outs[0], outs[1], outs[2], outs[4]]) assert.doesNotMatch(o.output, /"error"|TOOL_FAILED/, o.output.slice(0, 200));

  const props = (await service.listProposals(docId)).filter((p) => p.rid === done.request.rid).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(props.map((p) => p.type), ['insert', 'insert', 'table'], '넣기 둘·표 하나(틀린 바꾸기는 없음)');
  assert.equal(done.comments.length, 1, '메모는 그대로');

  // 모두 반영: 같은 자리(s0/p0 뒤)에 넣은 것이 부른 차례 그대로 — 가) → 나) → 표
  await service.resolveRequest(docId, done.request.rid, { apply: 'rest' }, user);
  const doc = await store.doc(docId);
  const texts = doc.paragraphs({ view: 'final' }).map((p) => p.text);
  const a = texts.indexOf('가) 첫째로 넣은 문단'); const b = texts.indexOf('나) 둘째로 넣은 문단');
  assert.ok(a > 0 && b === a + 1, `넣은 문단 차례: ${JSON.stringify(texts.slice(0, 8))}`);
  const tableAt = doc.tables().find((x) => /시험 표/.test(x.caption?.text || ''));
  assert.ok(tableAt, '표가 들어갔다');
  const tablePara = doc.paragraphs({ view: 'final' }).findIndex((p) => p.ref === tableAt.ref);
  assert.ok(tablePara > b, `표는 나) 뒤: 표 문단 ${tablePara}, 나) ${b}`);
});

test('도구 없이 보내는 요청에는 parallel_tool_calls 를 싣지 않는다', async (t) => {
  const { AiProposer } = await import('../server/ai.js');
  const bodies = [];
  const ai = new AiProposer({ ai: { provider: 'openai', gateway: 'baze', model: 'fake-approved-model', enabled: true } }, { key: 'fake-api-key', fetch: async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...result, summary: '문서 변경이 필요하지 않습니다.', noChangesReason: '대상 문장의 뜻과 표현이 요청 기준을 충족하므로 수정이 필요하지 않습니다.' }) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  await ai.run({ kind: 'instruct', instruction: '다듬어 줘', target: { ref: 's0/p0', start: 0, end: 2, text: '시험' }, context: [{ ref: 's0/p0', where: '본문', text: '시험', isTarget: true }], tables: [], attachments: [], options: {}, docTitle: '시험' });
  assert.equal(bodies.length, 1);
  assert.equal('parallel_tool_calls' in bodies[0], false);
});
