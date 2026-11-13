// AI 요청 창 정리(2026-10-28) 시험(브라우저 없이):
//  - web/util.js 연결된 작업 환경 이름(agentEnvName·personalEnvName·serverEnvName·workEnv·routeOptions) — 보낼 곳·보내기 단추·경로 칩·연결 알약
//  - web/ui.js handlerName·routeChip·reqState — 참여자 화면에 '서버 AI'·공용 서버 AI 이름이 드러나지 않는다
//  - 서식 칸 없이 지시만으로 서식 제안: server/format-schema.js formatHinted, server/aimock.js formatFromInstruction·mockRun, server/ai.js 프롬프트
// 웹 모듈은 브라우저용이라 '/vendor/vue.esm-browser.prod.js' 를 node_modules 의 vue 로 잇고 location·localStorage 만 흉내 낸다(tests/util.test.mjs 와 같은 방식).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const VUE = pathToFileURL(`${root}/node_modules/vue/dist/vue.esm-browser.prod.js`).href;
const SPEC = '/vendor/vue.esm-browser.prod.js';
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({ resolve: (s, c, next) => (s === SPEC ? { url: VUE, format: 'module', shortCircuit: true } : next(s, c)) });
} else {
  mod.register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === ${JSON.stringify(SPEC)} ? { url: ${JSON.stringify(VUE)}, format: 'module', shortCircuit: true } : n(s, c); }`)}`);
}
globalThis.location ??= { hash: '#/', protocol: 'http:', host: 'localhost' };

const web = (name) => import(pathToFileURL(`${root}/web/${name}`).href);
const { agentEnvName, personalEnvName, serverEnvName, workEnv, routeOptions, NO_AI_TIP, SUB_AI_TIP, CONNECT_HELP } = await web('util.js');
const { formatHinted } = await import('../server/format-schema.js');
const { formatFromInstruction, mockRun } = await import('../server/aimock.js');
const { SYSTEM, KIND_GUIDE_TEXT } = await import('../server/ai.js').then((m) => ({ SYSTEM: m.SYSTEM, KIND_GUIDE_TEXT: m.taskText({ kind: 'instruct', label: '지시', target: { ref: 's0/p0' }, context: [] }) }));

test('agentEnvName: 채널 세션 agent·client → 작업 환경 이름(Codex·API·Claude Code·ChatGPT), 모르는 이름은 그대로', () => {
  assert.equal(agentEnvName('Claude Code', 'claude-code/2.1.0'), 'Claude Code');
  assert.equal(agentEnvName('ChatGPT (Codex)', 'hwpx-codex-worker'), 'Codex');
  assert.equal(agentEnvName('내 ChatGPT', 'hwpx-codex-worker'), 'ChatGPT', 'agent 이름이 먼저 — ChatGPT');
  assert.equal(agentEnvName('AI', 'hwpx-codex-worker'), 'Codex', "agent 가 'AI' 뿐이면 client 로");
  assert.equal(agentEnvName('OpenAI API (BAZE)', 'hwpx-api-worker'), 'API');
  assert.equal(agentEnvName('Claude API (게이트웨이)', 'hwpx-api-worker'), 'API');
  assert.equal(agentEnvName('ChatGPT'), 'ChatGPT');
  assert.equal(agentEnvName('Gemini API'), 'Gemini API');
  assert.equal(agentEnvName('PyAgent'), 'PyAgent');
  assert.equal(agentEnvName('AI'), '');
  assert.equal(agentEnvName(''), '');
  assert.equal(agentEnvName(null), '');
});

test('personalEnvName·serverEnvName: 내 AI 키(baze = API), 공용 서버 AI·모의 AI 는 이름을 숨김(AI)', () => {
  assert.equal(personalEnvName({ active: true, gateway: 'baze', provider: 'openai' }), 'API');
  assert.equal(personalEnvName({ active: true, gateway: 'direct', provider: 'anthropic' }), 'Claude API');
  assert.equal(personalEnvName({ active: true, gateway: 'direct', provider: 'x' }), '내 AI 키');
  assert.equal(personalEnvName({ active: false, gateway: 'baze' }), '', '꺼진 키(모의·꺼짐 서버)는 없음');
  assert.equal(personalEnvName(null), '');
  assert.equal(serverEnvName('BAZE gpt-5 · 개인 키'), 'API');
  assert.equal(serverEnvName('API gpt-5 · 개인 키'), 'API');
  assert.equal(serverEnvName('gpt-5 · 개인 키'), '내 AI 키');
  for (const h of ['모의 AI', 'OpenAI API', 'Claude', null, '']) assert.equal(serverEnvName(h), 'AI', `공용: ${h}`);
});

test('workEnv·routeOptions: 상황별 보낼 곳 — 연결된 것만, 서버 AI 항목 없음, 없으면 대기열', () => {
  const labels = (env) => routeOptions(env).map((o) => `${o.value}:${o.label}`);
  const ch = (agent, client = '') => ({ online: true, sessions: [{ agent: 'old', channel: true }, { agent, client, channel: true }] });
  // 1) 아무것도 없음
  let e = workEnv({});
  assert.deepEqual([e.agent, e.personal, e.server, e.connected, e.auto, e.autoRoute], ['', '', '', '', '대기열', 'queue']);
  assert.deepEqual(labels(e), ['auto:자동 · 대기열', 'queue:대기열']);
  // 2) 공용 서버 AI 만 켜짐(배포 전 — 이름 숨김): 자동은 서버로 가지만 따로 고르는 항목·이름 없음
  e = workEnv({ serverAi: true });
  assert.deepEqual([e.server, e.serverOn, e.connected, e.auto, e.autoRoute], ['AI', true, '', 'AI', 'server']);
  assert.deepEqual(labels(e), ['auto:자동', 'queue:대기열']);
  assert.ok(!labels(e).join().includes('서버'));
  // 3) 내 AI 키(BAZE) — API
  e = workEnv({ personalAi: { active: true, gateway: 'baze', provider: 'openai' }, serverAi: true });
  assert.deepEqual([e.personal, e.server, e.connected, e.auto, e.autoRoute], ['API', 'API', 'API', 'API', 'server']);
  // 내 AI 키는 사용료가 따로 드는 길 — 이름표에 늘 '(내 키)'(2026-11-13 운영 결정: 구독 AI 가 기본, 키는 선택)
  assert.deepEqual(labels(e), ['auto:자동 · API', 'server:API (내 키)', 'queue:대기열']);
  // 4) Claude Code 채널(가장 최근 세션) + 내 키
  e = workEnv({ agentMe: ch('Claude Code', 'claude-code/2.1'), personalAi: { active: true, gateway: 'baze' } });
  assert.deepEqual([e.agent, e.connected, e.auto, e.autoRoute], ['Claude Code', 'Claude Code', 'Claude Code', 'agent']);
  assert.deepEqual(labels(e), ['auto:자동 · Claude Code', 'agent:Claude Code', 'server:API (내 키)', 'queue:대기열']);
  // 이름을 모르는 키는 '내 AI 키' 그대로(겹쳐 쓰지 않음)
  assert.deepEqual(labels(workEnv({ personalAi: { active: true, gateway: 'direct', provider: 'x' } })), ['auto:자동 · 내 AI 키', 'server:내 AI 키', 'queue:대기열']);
  // Claude Code 실행기(채널 없이 claude -p — scripts/ai-worker.mjs --provider claude-code)도 'Claude Code'
  assert.equal(agentEnvName('Claude Code (실행기)', 'hwpx-claude-code-worker'), 'Claude Code');
  // 5) Codex 실행기
  e = workEnv({ agentMe: ch('ChatGPT (Codex)', 'hwpx-codex-worker') });
  assert.deepEqual(labels(e), ['auto:자동 · Codex', 'agent:Codex', 'queue:대기열']);
  // 6) API 실행기 + API 키 — 같은 이름은 구분
  e = workEnv({ agentMe: ch('OpenAI API (BAZE)', 'hwpx-api-worker'), personalAi: { active: true, gateway: 'baze' } });
  assert.deepEqual(labels(e), ['auto:자동 · API', 'agent:API (실행기)', 'server:API (내 키)', 'queue:대기열']);
  // 7) 채널이 끊김(online false) — 세션이 남아 있어도 채널 환경 없음 / 이름 모름 → '연결된 AI'(docs/UI_TERMS.md — '에이전트'는 보이는 글에 쓰지 않음)
  assert.equal(workEnv({ agentMe: { online: false, sessions: [{ agent: 'Claude Code', channel: true }] } }).agent, '');
  assert.equal(workEnv({ agentMe: { online: true, sessions: [] } }).agent, '연결된 AI');
  assert.equal(workEnv({ agentMe: { online: true, sessions: [] }, agentName: 'Claude Code' }).agent, 'Claude Code');
  // 일반 MCP(채널 아님) 세션은 이름 근거가 아니다
  assert.equal(workEnv({ agentMe: { online: true, sessions: [{ agent: 'Claude Code', channel: true }, { agent: 'ChatGPT', channel: false }] } }).agent, 'Claude Code');
});

test("ui.js handlerName·routeChip·reqState: 경로 칩·처리자에 '서버 AI'·공용 서버 AI 이름이 없다", async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { handlerName, routeChip, reqState } = await web('ui.js');
  const d = { me: '홍길동', isMe: (n) => n === '홍길동' || String(n).startsWith('홍길동(') };
  // 서버 경로: 공용·모의 → 'AI', 내 키 → API
  assert.deepEqual(routeChip(d, { route: 'server', by: '홍길동', handledBy: '모의 AI' }), { label: 'AI', cls: 'server' });
  assert.deepEqual(routeChip(d, { route: 'server', by: '홍길동', handledBy: 'BAZE gpt-5 · 개인 키' }), { label: 'API', cls: 'server' });
  const working = { route: 'server', status: 'working', handledBy: 'OpenAI API', claim: { server: true } };
  assert.equal(handlerName(working), 'AI');
  assert.equal(reqState(working).who, 'AI');
  assert.ok(!JSON.stringify(reqState(working)).includes('OpenAI'));
  // 에이전트 경로: 받은 환경 이름(남의 요청은 '누구의 …')
  assert.deepEqual(routeChip(d, { route: 'agent', by: '홍길동', delivery: { agent: 'ChatGPT (Codex)' } }), { label: 'Codex', cls: 'agent' });
  assert.deepEqual(routeChip(d, { route: 'agent', by: '김검토', delivery: { agent: 'Claude Code' } }), { label: '김검토의 Claude Code', cls: 'agent' });
  assert.deepEqual(routeChip(d, { route: 'agent', by: '홍길동' }), { label: '연결된 AI', cls: 'agent' });
  assert.deepEqual(routeChip(d, { route: 'queue', by: '홍길동' }), { label: '대기열', cls: 'queue' });
  assert.match(reqState({ status: 'pending', route: 'agent', delivery: { agent: 'OpenAI API (BAZE)' } }).title, /^API에 전달/);
  assert.equal(reqState({ status: 'done', route: 'queue', handledBy: 'ChatGPT (Codex)' }).title, 'Codex 처리');
  assert.equal(reqState({ status: 'done', route: 'queue', handledBy: '홍길동' }).title, '홍길동 처리', '사람이 처리한 것은 그대로');
  assert.equal(reqState({ status: 'done', route: 'server', handledBy: '모의 AI' }).title, 'AI 처리');
});

test('ui.js requestBadge·sendKind(docs/UI_TERMS.md §1-3·§3): 상태 칩 하나, 종류·보낸 곳·맡은 이는 title · [요청] 칩은 지시·첨부 유무로 review/instruct', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { requestBadge, sendKind, requestKindText } = await web('ui.js');
  const d = { me: '홍길동', isMe: (n) => n === '홍길동' || String(n).startsWith('홍길동('), progress: (r) => r._g };
  const lab = (r) => requestBadge(d, r).label;
  assert.equal(lab({ status: 'pending', kind: 'review', label: 'AI 검토' }), '대기열');
  assert.equal(lab({ status: 'pending', kind: 'review', label: 'AI 검토', delivery: { agent: 'ChatGPT (Codex)' } }), '전달됨');
  assert.match(requestBadge(d, { status: 'pending', kind: 'review', label: 'AI 검토', delivery: { agent: 'ChatGPT (Codex)' } }).title, /^AI 검토 — Codex에 전달/);
  const w = requestBadge(d, { status: 'working', kind: 'instruct', label: '지시', claim: { agent: 'Claude Code', by: '김검토', expires: '2099-10-29T03:00:00Z' } });
  assert.equal(w.label, '처리 중'); assert.match(w.title, /^지시 — Claude Code\(김검토\) 처리 중 · .*까지 맡음$/); assert.equal(w.who, 'Claude Code');
  // 진행 단계(UI_TERMS §6): 처리 중 = run(보라), 맡은 시간이 지나면 late(응답 없음 — 칩 글은 그대로 '처리 중')
  assert.equal(w.phase, 'run'); assert.equal(w.cls, 'ph-run');
  const wl = requestBadge(d, { status: 'working', kind: 'instruct', label: '지시', claim: { agent: 'Claude Code', by: '김검토', expires: '2020-01-01T00:00:00Z' } });
  assert.equal(wl.label, '처리 중'); assert.equal(wl.phase, 'late'); assert.match(wl.title, /맡은 시간 지남 — 응답 없음$/);
  assert.ok(!requestBadge(d, { status: 'working', kind: 'review', claim: { agent: 'Claude Code', by: '홍길동' } }).title.includes('(홍길동)'), '내가 맡은 것은 이름을 붙이지 않음');
  assert.equal(lab({ status: 'done', kind: 'review', _g: { resolved: false, open: 2 } }), '확인 필요');
  assert.equal(lab({ status: 'done', kind: 'review', _g: { resolved: true, open: 0 } }), '완료');
  assert.equal(lab({ status: 'done', kind: 'review' }), '완료', 'progress 를 모르면 완료');
  assert.equal(lab({ status: 'failed', kind: 'review', error: '시간 초과' }), '실패');
  assert.equal(lab({ status: 'cancelled', kind: 'review' }), '취소됨');
  // 응답 대기: 방금 보낸 것은 wait, LATE_MS(2분) 넘게 맡는 이가 없으면 late('n분째 응답 없음'은 title)
  const ph = (r, dd = d) => requestBadge(dd, r).phase;
  const now = new Date().toISOString();
  assert.equal(ph({ status: 'pending', kind: 'review', at: now }), 'wait');
  const old = requestBadge(d, { status: 'pending', kind: 'review', at: new Date(Date.now() - 5 * 60000).toISOString(), delivery: { agent: 'Claude Code', at: new Date(Date.now() - 4 * 60000).toISOString() } });
  assert.equal(old.phase, 'late'); assert.equal(old.label, '전달됨'); assert.match(old.title, /4분째 응답 없음/);
  // 다시 요청하면 마지막 기록 시각부터 다시 센다
  assert.equal(ph({ status: 'pending', kind: 'review', at: '2020-01-01T00:00:00Z', log: [{ at: '2020-01-01T00:00:00Z' }, { at: now, action: 'retry' }] }), 'wait');
  // 남은 제안: 내가 정할 수 있으면 act(테두리 강조), 남의 요청이면 hold(강조 없음) — 칩 글은 둘 다 '확인 필요'
  assert.equal(ph({ status: 'done', kind: 'review', by: '홍길동', _g: { resolved: false, open: 2 } }, { ...d, canResolve: () => true }), 'act');
  assert.equal(ph({ status: 'done', kind: 'review', by: '김검토', _g: { resolved: false, open: 2 } }, { ...d, canResolve: () => false }), 'hold');
  assert.equal(ph({ status: 'done', kind: 'review', _g: { resolved: true, open: 0 } }), 'ok');
  assert.equal(ph({ status: 'failed', kind: 'review' }), 'fail');
  assert.equal(ph({ status: 'cancelled', kind: 'review' }), 'off');
  assert.ok(!JSON.stringify(requestBadge(d, { status: 'done', route: 'server', handledBy: 'OpenAI API', kind: 'review' })).includes('OpenAI'), '공용 서버 AI 이름은 드러내지 않음');
  assert.equal(requestKindText({ kind: 'polish', preset: 'concise' }), '다듬기 · 간결하게');
  // [요청] 칩: 비우면 검토(review), 지시나 첨부가 있으면 instruct. 다른 종류는 그대로
  assert.equal(sendKind({ kind: 'review', instruction: '', attachments: [] }), 'review');
  assert.equal(sendKind({ kind: 'instruct', instruction: '   ', attachments: [] }), 'review');
  assert.equal(sendKind({ kind: 'review', instruction: '수치를 첨부로 고쳐 줘', attachments: [] }), 'instruct');
  assert.equal(sendKind({ kind: 'review', instruction: '', attachments: ['a1'] }), 'instruct');
  for (const k of ['polish', 'suggest', 'fill_table', 'make_table', 'insert']) assert.equal(sendKind({ kind: k, instruction: 'x', attachments: [] }), k);
});

test('ui.js requestGlance(docs/UI_TERMS.md §6): 꼭지·탭 수 = 확인 필요 · 처리 중 · 응답 대기(0 인 것은 뺌, 내 차례부터)', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { requestGlance } = await web('ui.js');
  const d = { me: '홍길동', isMe: (n) => n === '홍길동', progress: (r) => r._g, canResolve: (r) => r.by === '홍길동' };
  const now = new Date().toISOString(); const old = new Date(Date.now() - 10 * 60000).toISOString();
  const list = [
    { rid: 1, status: 'pending', at: now }, { rid: 2, status: 'pending', at: old }, { rid: 3, status: 'working', claim: { agent: 'Claude Code' } },
    { rid: 4, status: 'done', by: '홍길동', _g: { resolved: false, open: 3 } }, { rid: 5, status: 'done', by: '김검토', _g: { resolved: false, open: 1 } },
    { rid: 6, status: 'done', by: '홍길동', _g: { resolved: true, open: 0 } }, { rid: 7, status: 'failed' },
  ];
  assert.deepEqual(requestGlance(d, list).map((g) => [g.ph, g.n]), [['act', 1], ['run', 1], ['late', 2]]);
  assert.deepEqual(requestGlance(d, [{ rid: 1, status: 'pending', at: now }]).map((g) => [g.ph, g.n]), [['wait', 1]]);
  assert.deepEqual(requestGlance(d, [list[5], list[6]]), []);
});

test('서식 칸 없이 지시만으로 서식 제안: formatHinted·모의 AI formats·서버 AI 프롬프트', () => {
  for (const t of ['이 문장을 굵게 해 줘', '가운데 정렬', '글자 크기 12pt 로', '줄 간격 160%', '제목 스타일로 바꿔 줘', '밑줄']) assert.equal(formatHinted(t), true, t);
  for (const t of ['', null, '이 문장을 간결하게', '첨부한 엑셀 수치로 고쳐 줘']) assert.equal(formatHinted(t), false, String(t));
  assert.deepEqual(formatFromInstruction('굵게 하고 가운데 정렬해 줘'), { char: { bold: true }, paragraph: { align: 'CENTER' } });
  assert.deepEqual(formatFromInstruction('굵게 해제'), { char: { bold: false } });
  assert.deepEqual(formatFromInstruction('밑줄 긋고 14pt'), { char: { underline: true, sizePt: 14 } });
  assert.equal(formatFromInstruction('간결하게 다듬어 줘'), null);
  const ctx = [{ ref: 's0/p1', text: '조사 결과를 요약함.', isTarget: true }];
  // 글자 서식: 고른 글만 / 문단 서식: 문단 전체
  let r = mockRun({ kind: 'instruct', label: '지시', instruction: '굵게', target: { ref: 's0/p1', text: '조사 결과' }, context: ctx });
  assert.deepEqual(r.formats, [{ ref: 's0/p1', find: '조사 결과', format: { char: { bold: true } }, reason: '지시에 따라 서식을 바꿈' }]);
  assert.equal(r.proposals.length, 0); assert.match(r.summary, /서식 제안 1건/);
  r = mockRun({ kind: 'instruct', label: '지시', instruction: '가운데 정렬해 줘', target: { ref: 's0/p1', text: '조사 결과' }, context: ctx });
  assert.equal(r.formats[0].find, '조사 결과를 요약함.'); assert.deepEqual(r.formats[0].format, { paragraph: { align: 'CENTER' } });
  // 서식 요청이 없으면 예전 그대로(수정 제안·의견)
  r = mockRun({ kind: 'instruct', label: '지시', instruction: '다듬어 줘', target: { ref: 's0/p1', text: '조사 결과를 요약함.' }, context: ctx });
  assert.equal(r.formats, undefined); assert.equal(r.comments.length, 1);
  // 서버 AI 프롬프트: request.format 없이도 지시의 서식 요청을 서식 변경 지시로 다룬다
  assert.match(SYSTEM, /서식 칸이 따로 없어도 지시 글에 굵게/);
  assert.match(KIND_GUIDE_TEXT, /formats\(글은 그대로 두는 서식 변경\)/);
});

test('AI 연결 안내 차례(2026-11-13): 내 PC 의 구독 AI(Codex·Claude Code) 먼저, ChatGPT 앱·내 AI 키(사용료 별도)는 뒤', () => {
  const at = (text, word) => { const i = text.indexOf(word); assert.ok(i >= 0, `${word} 없음: ${text}`); return i; };
  assert.ok(at(SUB_AI_TIP, 'Codex') < at(SUB_AI_TIP, 'Claude Code'));
  assert.match(SUB_AI_TIP, /추가 비용 없이/);
  assert.match(SUB_AI_TIP, /실행기를 켜 두면/, 'CLI·IDE 대화를 여는 것과 자동 실행기를 구분');
  assert.ok(at(NO_AI_TIP, 'Codex') < at(NO_AI_TIP, 'ChatGPT 앱'), '구독 AI 가 ChatGPT 앱보다 먼저');
  assert.ok(at(NO_AI_TIP, 'ChatGPT 앱') < at(NO_AI_TIP, '내 AI 키'), '내 AI 키는 마지막');
  assert.ok(NO_AI_TIP.includes('내 AI 키(사용료 별도)'));
  assert.match(NO_AI_TIP, /대기열에 보관/);
  assert.equal(CONNECT_HELP, '/help.html#agents', '연결 방법은 설명서 ①절(내 PC의 AI)부터');
});
