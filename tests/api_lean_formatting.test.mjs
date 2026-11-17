// 필요한 만큼만(2026-11-04·11-05): 도구가 있는 API 실행은 서식이 필요한 요청(선택 서식·지시의 서식 낱말)이 아니면 문단 서식 번호·값을 싣지 않고
// 스타일 이름만, 필요한 문단은 get_formatting(refs)로. 도구 없는 실행(Gemini CLI·서버 AI 단독)은 그대로 다 싣는다. 반복 횟수는 자르지 않는다.
// API 는 가짜 fetch, 문서·서버는 임시 복사본. 유료 호출 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiProposer, needsFormatting, leanFormattingInput, taskText, LEAN_FORMATTING_NOTE } from '../server/ai.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { fixture } from './helpers/server.mjs';

const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const result = { noChangesReason: '요청 범위의 문장을 확인했으며 추가 변경이 필요하지 않습니다.', proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '문서를 검토했으며 변경하지 않았습니다.', instructionSummary: '오탈자 수정' };
const finalOut = () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
const userText = body => body.input.find(m => m.role === 'user').content.map(c => c.text || '').join('\n');
const INPUT = {
  kind: 'instruct', label: '지시', instruction: '오탈자를 고쳐 줘', options: {}, docTitle: '시험', tables: [], attachments: [],
  target: { scope: 'document', ref: 's0/p0', refs: ['s0/p0', 's0/p1', 's0/p2'], text: '' },
  context: [
    { ref: 's0/p0', where: '본문', text: '제목', isTarget: true, styleId: '1', paraPrId: '3', runs: [{ start: 0, end: 2, charPrId: '7' }] },
    { ref: 's0/p1', where: '본문', text: '본문 하나', isTarget: true, styleId: '0', paraPrId: '0', runs: [{ start: 0, end: 5, charPrId: '0' }] },
    { ref: 's0/p2', where: '본문', text: '본문 둘', isTarget: true, styleId: '0', paraPrId: '0', runs: [{ start: 0, end: 4, charPrId: '0' }], emptyCharPrId: '0' },
  ],
  formattingHeader: { styles: [{ id: '0', name: '바탕글' }, { id: '1', name: '제목 1' }], paraPr: [{ id: '0' }, { id: '3' }], charPr: [{ id: '0' }, { id: '7', bold: true }] },
};

test('needsFormatting: 선택 서식·서식 낱말이면 필요, 오탈자·수치 대조·절 쓰기는 아님', () => {
  assert.equal(needsFormatting(INPUT), false);
  for (const instruction of ['둘째 문단을 굵게 해줘', '다른 표와 서식을 맞춰줘', '글자 크기 11pt', '줄 간격을 넓혀', '스타일을 개요 2로']) assert.equal(needsFormatting({ instruction }), true, instruction);
  assert.equal(needsFormatting({ instruction: '다듬어 줘', options: { format: { bold: true } } }), true);
  for (const instruction of ['표와 본문 수치가 다른 곳을 고쳐줘', '시사점 절을 써 줘']) assert.equal(needsFormatting({ instruction }), false, instruction);
});

test('leanFormattingInput·taskText: 서식 번호·정의 없이 스타일 이름만(바뀌는 곳에만)·안내 한 줄, 서식이 필요한 요청은 그대로', () => {
  const lean = leanFormattingInput(INPUT);
  assert.equal(lean.formattingLean, true); assert.equal(lean.formattingHeader, null);
  assert.deepEqual(lean.context.map(c => [c.styleId, c.style, 'runs' in c, 'paraPrId' in c, 'emptyCharPrId' in c]), [['1', '제목 1', false, false, false], ['0', '바탕글', false, false, false], ['0', '바탕글', false, false, false]]);
  const t = taskText(lean);
  assert.ok(t.includes(LEAN_FORMATTING_NOTE));
  assert.ok(!t.includes('현재 서식') && !t.includes('문서 서식 정의'));
  assert.ok(t.includes('*[s0/p0] 〔제목 1〕 제목') && t.includes('*[s0/p1] 〔바탕글〕 본문 하나') && t.includes('*[s0/p2] 본문 둘'), t);
  assert.match(t, /대상: 문서 전체 — 아래 \* 문단/);
  // get_request 가 이미 서식을 뺀 요청(formattingHeader.lean)도 같은 꼴
  const fromQueue = taskText({ ...INPUT, context: lean.context.map(({ styleId, ...c }) => c), formattingHeader: { lean: true, note: LEAN_FORMATTING_NOTE } });
  assert.ok(fromQueue.includes('〔제목 1〕') && fromQueue.includes(LEAN_FORMATTING_NOTE) && !fromQueue.includes('문서 서식 정의'), fromQueue);
  const full = taskText(INPUT);
  for (const word of ['현재 서식', '문서 서식 정의', 'charPrId', 'paraPrId', 'emptyCharPrId']) assert.ok(full.includes(word), word);
  assert.ok(!full.includes(LEAN_FORMATTING_NOTE) && !full.includes('〔'));
});

test('도구 없는 실행(toolContext 없음)은 서식을 그대로 싣고, 도구가 있으면 서식 낱말 없는 요청은 서식을 뺀다', async () => {
  const bodies = [];
  const ai = new AiProposer({ ai: { provider: 'openai', model: 'fake-model' } }, { key: 'fake-key', fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return finalOut(); } });
  await ai.run(INPUT);
  assert.match(userText(bodies[0]), /현재 서식/);
  await ai.run(INPUT, { toolContext: { tools: [] } });
  assert.ok(!userText(bodies[1]).includes('현재 서식') && userText(bodies[1]).includes(LEAN_FORMATTING_NOTE));
  await ai.run({ ...INPUT, instruction: '제목을 굵게 해줘' }, { toolContext: { tools: [] } });
  assert.match(userText(bodies[2]), /현재 서식/);
});

test('서버 개인 API: 서식 없이 보내고 모델이 get_formatting 으로 한 문단만 받음 · 굵게 요청은 다 싣는다 · 반복 횟수로 자르지 않는다(55 라운드)', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-native-lean-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const user = { name: '시험', role: 'admin' }, config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'fixture.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  let round = 0; const bodies = [];
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body); round++;
    if (round === 1) {
      assert.ok(userText(body).includes(LEAN_FORMATTING_NOTE) && !userText(body).includes('현재 서식') && !userText(body).includes('문서 서식 정의'), '서식 번호·정의 없음');
      assert.ok(body.tools.some(x => x.name === 'get_formatting'));
      return json({ status: 'completed', output: [{ type: 'function_call', call_id: 'fmt', name: 'get_formatting', arguments: JSON.stringify({ refs: ['s0/p1'] }) }] });
    }
    if (round === 2) {
      const out = body.input.find(i => i.type === 'function_call_output' && i.call_id === 'fmt');
      assert.ok(out && /charPrId/.test(out.output) && /s0\/p1/.test(out.output) && !/rawHeaderXml/.test(out.output), `그 문단의 서식만: ${out?.output?.slice(0, 200)}`);
    }
    if (round <= 56) assert.equal(body.input.filter(i => i.type === 'function_call_output').length, round - 1);
    if (round <= 54) return json({ status: 'completed', output: [{ type: 'function_call', call_id: `read_${round}`, name: 'read_document', arguments: JSON.stringify({ from: 0, to: 3 }) }] });
    if (round === 55) return json({ status: 'completed', output: [{ type: 'function_call', call_id: 'actual_write', name: 'propose_changes', arguments: JSON.stringify({ proposals: [{ ref: 's0/p1', find: '둘째 문단', replace: '두 번째 문단', reason: '요청한 표현 수정' }] }) }] });
    if (round === 56) { assert.ok(body.input.some(i => i.call_id === 'actual_write' && /pid/.test(i.output))); return finalOut(); }
    // 둘째 요청(굵게): 서식을 다 싣는다
    assert.match(userText(body), /현재 서식/); assert.match(userText(body), /문서 서식 정의/); assert.ok(!userText(body).includes(LEAN_FORMATTING_NOTE));
    return finalOut();
  } });
  service.personalAi.save(user, { provider: 'openai', model: 'fake-model', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '둘째 문단을 두 번째 문단으로 고쳐 줘' }, user);
  assert.equal(done.request.status, 'done', done.request.error || ''); assert.equal(round, 56);
  const saved = await service.listProposals(docId); assert.equal(saved.length, 1); assert.equal(saved[0].replace, '두 번째 문단');
  const bold = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '이 문단을 굵게 해줘' }, user);
  assert.equal(bold.request.status, 'done', bold.request.error || ''); assert.equal(round, 57);
});

test('get_formatting: header.xml 원문은 part=raw 로 물을 때만, 응답(JSON) 크기가 한도 안이 되게 나눠 주고 이어 붙이면 원문 그대로', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-raw-header-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), ai: {}, agents: { leaseMinutes: 10 }, limits: { mcpResponseChars: 5000 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'fixture.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: '시험' }).id;
  const xml = (await store.doc(docId)).header.xml;
  assert.ok(xml.length > 5000, `시험 문서 header 가 한도보다 커야 한다: ${xml.length}`);
  assert.ok(!('rawHeaderXml' in (await service.getFormatting(docId, { refs: ['s0/p1'] })).header), 'refs 응답에는 원문 없음');
  let from = 0, joined = '', pages = 0;
  while (from != null && pages < 100) {
    const page = await service.getFormatting(docId, { part: 'raw', from });
    assert.ok(JSON.stringify(page, null, 1).length <= 5000, `응답 ${JSON.stringify(page, null, 1).length}자`);
    joined += page.text; from = page.nextFrom; pages++;
  }
  assert.equal(joined, xml); assert.ok(pages > 1);
});
