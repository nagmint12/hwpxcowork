// 개인 에이전트 경로·선점 시험(docs/V3_SPEC.md §2.1·§2.2) — 서버는 받침(tests/helpers/server.mjs)으로 빈 포트에 띄운다.
//   0) 등록부(server/agents.js) 단독: 가장 최근 채널 세션에만 푸시, prefer, 끊긴 연결 건너뛰기, 같은 세션 다시 붙음, online/offline 알림
//   1) 서버(모의 AI): SSE 머리글 인증(?token= → 400)·hello·snapshot·머리글, 접속 알림(WS agent·presence.agents), /api/agent/status,
//      route auto + 채널 세션 → 'agent' + ai_request 정확히 1번(지시 원문 없음), 남의 요청은 안 옴, 가장 최근 세션에만,
//      MCP start_request(세션 A 됨 / 세션 B 409 CLAIMED / 남 403 NOT_OWNER / 관리자도 CLAIMED), lease 연장, complete 권한,
//      REQUEST_CLOSED(MCP·REST, 아무것도 안 생김), get_request <document_context>, 취소 → ai_request_cancelled,
//      다시 요청 → requeued + delivered + attempt 2, claim_next_request, 끊김 → offline, 에이전트 없음 + 모의 AI → server,
//      채널 아닌 세션, 같은 세션 다시 붙음, X-Hwpx-Agent-Session 검사, instructions·도구 목록
//   2) 서버(AI 끔, lease 1.5초, othersCanTake): lease 끝난 working 이 snapshot 에 옴, 이어받기, AI 꺼짐 + 에이전트 → agent,
//      남이 맡아 완료(맡은 세션만), 취소 알림, 대기열 다시 요청 → requeued, 동시 start_request 는 하나만
//   0b) 서비스 단독(임시 저장소·가짜 AI — 모의 AI 는 실행을 붙잡아 둘 수 없어서): 늦게 끝난 서버 AI 실행은 선점이 바뀐 요청
//      (취소 → 다시 요청 → 에이전트가 맡음 / 새 서버 실행 / lease 끝난 뒤 이어받음)을 건드리지 않음, 세션 id 'server' 는 특별하지 않음,
//      옛 요청의 REST 보기는 route·delivery·claim = null
// 진짜 config.json·data/ 는 쓰지 않는다(받침이 임시 config·data 를 만들고, 0b 는 OS 임시 폴더에 저장소를 만들고 지운다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, uploadDoc, watchWs, fixture } from './helpers/server.mjs';
import { AgentRegistry } from '../server/agents.js';
import { Store } from '../server/store.js';
import { Service } from '../server/service.js';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
const streams = [];

/** SSE 구독(fetch 본문 스트림을 직접 읽음) → { status, headers, data(오류 JSON), events, comments, closed, waitFor, waitClosed, close } */
async function openSse(base, token, params = {}, { headers = {} } = {}) {
  const u = new URL('/api/agent/events', base);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const ac = new AbortController();
  const h = { Accept: 'text/event-stream', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(u, { headers: h, signal: ac.signal });
  if (res.status !== 200 || !/^text\/event-stream/.test(res.headers.get('content-type') || '')) {
    let data = null; try { data = await res.json(); } catch { /* 본문 없음 */ }
    return { status: res.status, headers: res.headers, data };
  }
  const events = []; let comments = 0; let closed = false; const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  const parse = (block) => {
    let name = 'message'; const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith(':')) { comments++; continue; }
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let val = i < 0 ? '' : line.slice(i + 1); if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') name = val; else if (field === 'data') data.push(val);
    }
    if (!data.length) return;
    const raw = data.join('\n'); let d = raw; try { d = JSON.parse(raw); } catch { /* 글 그대로 */ }
    events.push({ event: name, data: d, raw, t: Date.now() });
  };
  (async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf))) { parse(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
        notify();
      }
    } catch { /* 끊음(abort) */ }
    closed = true; notify();
  })();
  const waitUntil = (check, ms, what) => new Promise((resolve, reject) => {
    const tryIt = () => { const v = check(); if (v === undefined || v === false) return false; done(); resolve(v); return true; };
    const t = setTimeout(() => { done(); reject(new Error(`${what} 를 기다리다 시간 초과(받은 이벤트: ${events.map((e) => e.event).join(',') || '없음'})`)); }, ms);
    const done = () => { clearTimeout(t); waiters.delete(tryIt); };
    if (!tryIt()) waiters.add(tryIt);
  });
  const s = {
    status: 200, headers: res.headers, events,
    get comments() { return comments; }, get closed() { return closed; },
    waitFor: (pred, ms = 5000, what = 'SSE 이벤트') => waitUntil(() => events.find(pred), ms, what),
    waitClosed: (ms = 5000) => waitUntil(() => (closed ? true : undefined), ms, 'SSE 닫힘'),
    of: (event, rid) => events.filter((e) => e.event === event && (rid == null || e.data?.rid === rid)),
    close: () => ac.abort(),
  };
  streams.push(s);
  return s;
}

/** MCP JSON-RPC 한 번(무상태 — initialize 없이) → { status, data, msg, raw } */
async function rpc(base, token, body, { session, agent = 'Claude Code' } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (session != null) h['X-Hwpx-Agent-Session'] = session;
  const r = await fetch(`${base}/mcp?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const raw = await r.text();
  let msg = null;
  try { const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:')); msg = JSON.parse(line ? line.slice(5) : raw); } catch { /* JSON 아님 */ }
  return { status: r.status, msg, raw };
}

/** MCP 도구 호출 → { status, isError, text, json } (오류는 던지지 않는다 — 오류 코드 확인용) */
async function mcp(base, token, name, args = {}, opts = {}) {
  const r = await rpc(base, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts);
  if (r.status !== 200 || !r.msg) return { status: r.status, isError: true, text: r.raw, json: r.msg };
  if (r.msg.error) return { status: r.status, isError: true, text: r.msg.error.message, json: null };
  const text = r.msg.result?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { status: r.status, isError: !!r.msg.result?.isError, text, json };
}

/** 조건이 참이 될 때까지(ms 안) 다시 본다 */
async function until(fn, ms = 5000, what = '조건') {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(50); }
  throw new Error(`${what} 를 기다리다 시간 초과`);
}

// ───────── 0. 등록부 단독 ─────────
function fakeRes() { return { chunks: [], destroyed: false, writableEnded: false, write(c) { this.chunks.push(c); return true; }, end() { this.writableEnded = true; } }; }
function registryUnit() {
  section('등록부(server/agents.js) 단독');
  const hub = { msgs: [], broadcastAll(m) { this.msgs.push(m); } };
  const reg = new AgentRegistry({ hub, leaseMs: 1000 });
  const r1 = fakeRes(); const r0 = fakeRes(); const r2 = fakeRes();
  const h1 = reg.connect({ name: '갑' }, { session: 's1', agent: 'Claude Code', client: 'c', channel: true }, r1);
  ok(reg.online('갑') && hub.msgs.length === 1 && hub.msgs[0].type === 'agent' && hub.msgs[0].action === 'online' && hub.msgs[0].user === '갑' && hub.msgs[0].agent === 'Claude Code', '채널 세션 연결 → online + broadcastAll({type:agent, action:online})');
  reg.connect('갑', { session: 's0', agent: '모니터', channel: false }, r0);
  ok(hub.msgs.length === 1 && reg.sessions('갑').length === 2 && reg.sessions('갑')[1].channel === false, '채널 아닌 세션: 알림 없음, sessions 에는 보임');
  ok(JSON.stringify(reg.presenceList()) === JSON.stringify([{ user: '갑', agent: 'Claude Code' }]), 'presenceList = 채널 세션만 [{ user, agent }]');
  const h2 = reg.connect('갑', { session: 's2', agent: 'Cursor', channel: true }, r2);
  ok(reg.push('갑', 'ai_request', { rid: 1 }) === 1 && r2.chunks.length === 1 && r1.chunks.length === 0 && r0.chunks.length === 0, 'push → 가장 최근 채널 세션(s2) 1개에만');
  ok(r2.chunks[0] === 'event: ai_request\ndata: {"rid":1}\n\n', `SSE 형식: ${JSON.stringify(r2.chunks[0])}`);
  ok(reg.deliver('갑', 'ai_request', { rid: 2 }, { prefer: 's1' })?.session === 's1' && r1.chunks.length === 1, 'deliver(prefer: s1) → s1 에 보내고 받은 세션을 돌려줌');
  r2.destroyed = true;
  ok(reg.push('갑', 'ai_request', { rid: 3 }) === 1 && r1.chunks.length === 2 && reg.sessions('갑').every((s) => s.session !== 's2'), '끊긴 최근 세션(s2)은 정리하고 다음 채널 세션(s1)에');
  ok(!hub.msgs.some((m) => m.action === 'offline'), '채널 세션이 남아 있으면 offline 알림 없음');
  ok(reg.list().length === 1 && reg.list()[0].agents.length === 2 && !('session' in reg.list()[0].agents[0]), 'list() → [{ user, agents: [{ agent, channel, since }] }](세션 id 없음)');
  reg.disconnect(h1); reg.disconnect(h1);
  ok(!reg.online('갑') && hub.msgs.filter((m) => m.action === 'offline').length === 1, '마지막 채널 세션 끊김 → offline 1번(두 번 불러도)');
  ok(reg.push('을', 'ai_request', {}) === 0 && reg.primary('을') === null, '세션 없는 사람 → push 0, primary null');
  const a = fakeRes(); const b = fakeRes();
  reg.connect('을', { session: 'dup', agent: 'X', channel: true }, a);
  reg.connect('을', { session: 'dup', agent: 'X', channel: true }, b);
  ok(a.writableEnded && !b.writableEnded && reg.sessions('을').length === 1 && !hub.msgs.some((m) => m.user === '을' && m.action === 'offline'), '같은 세션이 다시 붙으면 옛 연결을 닫고 하나만(offline 없음)');
  ok(reg.comment(reg._channels('을')[0], 'ping') && b.chunks.at(-1) === ': ping\n\n', "comment → ': ping'");
  const capped = new AgentRegistry({ hub, maxPerUser: 3 });
  const rs = [1, 2, 3, 4, 5].map(() => fakeRes());
  rs.forEach((r, i) => capped.connect('병', { session: `c${i}`, agent: 'X', channel: true }, r));
  ok(capped.sessions('병').map((s) => s.session).join() === 'c2,c3,c4' && rs[0].writableEnded && rs[1].writableEnded && !rs[4].writableEnded, '사람당 연결 수 상한(maxPerUser) → 가장 오래된 연결부터 닫음');
  void h2;
}

// ───────── 0b. 서비스 단독(임시 저장소·가짜 AI) ─────────
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

async function serviceUnit() {
  section('서비스 단독(임시 저장소·가짜 AI): 서버 AI 실행 표(run)·선점 표식·옛 요청 기본값');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-agents-svc-'));
  let reg = null;
  try {
    const store = new Store(tmp);
    const hub = { msgs: [], broadcast(id, m) { this.msgs.push(m); }, broadcastAll(m) { this.msgs.push(m); } };
    const gates = new Map();   // 실행 번호 → deferred(그 실행의 결과를 붙잡아 둔다)
    const ai = {
      enabled: true, mock: true, agentName: '가짜 AI', runs: 0,
      async run() {
        const n = ++this.runs;
        if (gates.has(n)) await gates.get(n).promise;
        return { proposals: [], alternatives: [], comments: [{ ref: 's0/p0', text: `서버 AI 의견 ${n}` }], inserts: [], tables: [], summary: `서버 AI 요약 ${n}`, instructionSummary: '' };
      },
    };
    const config = { agents: { leaseMinutes: 15, othersCanTake: false }, attachments: { maxBytes: 1e7, maxTextChars: 200000, maxPerDoc: 100 }, ai: { maxProposals: 10 } };
    const svc = new Service({ store, hub, config, ai });
    reg = new AgentRegistry({ hub });
    svc.agents = reg;
    const A = { name: '갑돌', role: 'editor' }; const B = { name: '을순', role: 'editor' };
    const id = store.create({ fileName: '서비스 시험.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: A.name }).id;
    const reqs = () => store.readMeta(id).requests;
    const metaReq = (rid) => reqs().find((r) => r.rid === rid);
    const waitReqs = (n) => until(() => reqs().length >= n, 5000, `요청 ${n}건 저장`);
    const commentMemos = async (rid) => (await svc.memos(id, A)).filter((m) => m.link?.type === 'comment' && m.link.rid === rid);
    const doneMsgs = (rid) => hub.msgs.filter((m) => m.type === 'request' && m.action === 'done' && m.rid === rid).length;

    // 1) 서버 AI 실행 중 취소 → 에이전트가 붙고 다시 요청(auto → agent) → 에이전트가 맡음 → 그 뒤 첫 실행이 끝남
    gates.set(1, deferred());
    const p1 = svc.createRequest(id, { kind: 'review', target: { ref: 's0/p0' } }, A);
    await waitReqs(1);
    const R1 = reqs()[0].rid; const c0 = metaReq(R1).claim;
    ok(metaReq(R1).status === 'working' && metaReq(R1).route === 'server' && c0?.server === true && c0.session === null && c0.by === null && c0.agent === '가짜 AI' && typeof c0.run === 'string' && c0.run.length >= 16,
      `서버 경로 → 서버 AI 선점 { server: true, session: null, run }(${c0?.agent})`);
    const v0 = await svc.getRequestView(id, R1, A);
    ok(v0.claim?.server === true && !('run' in v0.claim), 'REST 보기에는 실행 표(run)를 싣지 않음');
    await svc.cancelRequest(id, R1, A);
    reg.connect(A.name, { session: 'S1', agent: 'Claude Code', channel: true }, fakeRes());
    const rt1 = await svc.retryRequest(id, R1, A);
    ok(rt1.route === 'agent' && rt1.request.status === 'pending' && rt1.request.claim === null, '취소 → 다시 요청(auto, 에이전트 붙음) → agent·pending·선점 없음');
    await svc.startRequest(id, R1, A, 'Claude Code', { session: 'S1' });
    const done1 = doneMsgs(R1);
    gates.get(1).resolve();
    const out1 = await p1;
    const r1 = metaReq(R1);
    ok(out1.cancelled === true && out1.route === 'server', '늦게 끝난 첫 실행의 응답 = cancelled(결과를 쓰지 않음)');
    ok(r1.status === 'working' && r1.claim?.session === 'S1' && r1.handledBy === 'Claude Code' && r1.comments.length === 0 && !String(r1.summary).includes('서버 AI 요약'),
      `요청은 그대로 에이전트(S1)가 처리 중(${r1.status}, 의견 ${r1.comments.length}건)`);
    ok((await commentMemos(R1)).length === 0 && doneMsgs(R1) === done1, '서버 AI 의견 메모·done 방송 없음');
    const pa = await svc.propose(id, { ref: 's0/p0', find: '메모 대상', replace: '메모 대상(에이전트)', rid: R1 }, { ...A, agentSession: 'S1' }, 'Claude Code');
    const ca = await svc.completeRequest(id, R1, { summary: '에이전트가 처리함', session: 'S1' }, A, 'Claude Code');
    ok(pa.rid === R1 && ca.status === 'done' && ca.summary === '에이전트가 처리함', '에이전트는 이어서 제안·완료(REQUEST_CLOSED 아님)');

    // 2) 취소 → 다시 요청(server) = 새 실행 → 옛 실행이 늦게 끝나도 결과는 새 실행 것 하나만
    gates.set(2, deferred());
    const p2 = svc.createRequest(id, { kind: 'review', target: { ref: 's0/p1' }, route: 'server' }, A);
    await waitReqs(2);
    const R2 = reqs()[1].rid;
    await svc.cancelRequest(id, R2, A);
    const out3 = await svc.retryRequest(id, R2, A);   // 실행 3(붙잡지 않음)
    ok(out3.route === 'server' && out3.request.status === 'done' && out3.comments.length === 1, '취소 → 다시 요청(server) → 새 실행이 끝냄(done)');
    gates.get(2).resolve();
    const out2 = await p2;
    const r2 = metaReq(R2); const m2 = await commentMemos(R2);
    ok(out2.cancelled === true && r2.status === 'done' && r2.comments.length === 1 && m2.length === 1 && m2[0].text.includes('서버 AI 의견 3') && r2.summary === '서버 AI 요약 3',
      `늦게 끝난 옛 실행(2)은 버림 — 의견 ${r2.comments.length}건(실행 3 것), 요약 '${r2.summary}'`);
    ok(m2[0].author === `${A.name}(가짜 AI)` && doneMsgs(R2) === 1 && hub.msgs.filter((m) => m.type === 'request' && m.action === 'done' && m.rid === R2).every((m) => m.by === '가짜 AI'),
      `서버 AI 의견 작성자 ${m2[0].author}, done 방송 1번(by 가짜 AI)`);

    // 3) 서버 AI 선점의 lease 가 끝나면 snapshot 에 stale, 에이전트가 이어받으면 그 뒤 끝난 실행은 버림
    config.agents.leaseMinutes = 0.005;   // 300ms
    gates.set(4, deferred());
    const p4 = svc.createRequest(id, { kind: 'review', target: { ref: 's0/p2' }, route: 'server' }, A);
    await waitReqs(3);
    const R4 = reqs()[2].rid;
    const early = await svc.startRequest(id, R4, A, 'Claude Code', { session: 'S1' }).then(() => null, (e) => e);
    ok(early?.code === 'CLAIMED' && early.message.includes('서버 AI') && early.extra?.claim?.server === true, `lease 안: 에이전트 start → CLAIMED(서버 AI)`);
    await sleep(450);
    const st4 = svc.agentSnapshot(A).find((x) => x.rid === R4);
    ok(st4?.stale === true && st4.status === 'working', 'lease 끝난 서버 AI 선점 → snapshot 에 stale');
    const take = await svc.startRequest(id, R4, A, 'Claude Code', { session: 'S1' });
    ok(take.claim.session === 'S1' && !take.claim.server && take.log.at(-1).detail === '처리 이어받음', `lease 끝난 서버 AI 선점을 에이전트가 이어받음(${take.log.at(-1).detail})`);
    gates.get(4).resolve();
    const out4 = await p4;
    const r4 = metaReq(R4);
    ok(out4.cancelled === true && r4.status === 'working' && r4.claim.session === 'S1' && r4.comments.length === 0, '그 뒤 끝난 서버 AI 실행은 버림(처리 중·에이전트 선점 그대로)');
    config.agents.leaseMinutes = 15;

    // 4) 세션 id 'server' 는 특별하지 않다(othersCanTake 로 남이 그 세션으로 맡아도 보통 에이전트 선점)
    config.agents.othersCanTake = true;
    const resB = fakeRes();
    reg.connect(B.name, { session: 'server', agent: 'Claude Code', channel: true }, resB);
    const q5 = await svc.createRequest(id, { kind: 'review', target: { ref: 's0/p1' }, route: 'queue' }, A);
    const R5 = q5.request.rid;
    const stB = await svc.startRequest(id, R5, B, 'Claude Code', { session: 'server' });
    ok(stB.claim.session === 'server' && stB.claim.by === B.name && !stB.claim.server, `남(${B.name})이 세션 'server' 로 맡음 → 보통 에이전트 선점`);
    const eA = await svc.startRequest(id, R5, A, 'Claude Code', { session: 'A9' }).then(() => null, (e) => e);
    ok(eA?.code === 'CLAIMED' && !eA.message.includes('서버 AI') && eA.message.includes(B.name) && eA.extra?.claim?.server === false, `요청자의 다른 세션 → CLAIMED(서버 AI 라고 하지 않음: ${eA?.message?.slice(0, 50)})`);
    await svc.cancelRequest(id, R5, A);
    const gotB = resB.chunks.filter((c) => c.startsWith('event: ai_request_cancelled\n') && c.includes(`"rid":${R5}`));
    ok(gotB.length === 1, `취소 → 맡은 남(${B.name}, 세션 server)에게 ai_request_cancelled ${gotB.length}번`);
    config.agents.othersCanTake = false;

    // 5) 옛(v0.2) 요청: route·routeWanted·delivery·claim 키가 없어도 REST 보기에는 null
    const q6 = await svc.createRequest(id, { kind: 'review', target: { ref: 's0/p0' }, route: 'queue' }, A);
    const m6 = store.readMeta(id);
    for (const r of m6.requests) if (r.rid === q6.request.rid) { delete r.route; delete r.routeWanted; delete r.delivery; delete r.claim; }
    store.saveMeta(m6);
    const lv = (await svc.listRequests(id, {}, A)).find((r) => r.rid === q6.request.rid);
    const gv = await svc.getRequestView(id, q6.request.rid, A);
    ok([lv, gv].every((v) => v.route === null && v.routeWanted === null && v.delivery === null && v.claim === null), '옛 요청의 REST 보기(목록·하나): route·routeWanted·delivery·claim = null');
  } finally {
    try { reg?.closeAll(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  registryUnit();
  await serviceUnit();

  // ───────── 1. 서버(모의 AI) ─────────
  section('서버(모의 AI): SSE 인증·hello·snapshot·접속 알림');
  const srv = await startServer({ ai: 'mock' }); servers.push(srv);
  const base = srv.base; const T = srv.tokens; const A = srv.users.a.name; const B = srv.users.b.name; const ADM = srv.users.admin.name;
  const apiA = srv.api('a'); const apiB = srv.api('b');
  const d = await uploadDoc(base, T.a, fixture('tool_memo_tracked.hwpx'), '에이전트 시험.hwpx');
  const wB = watchWs(base, T.b, d.id); await wB.ready;
  const pres0 = await wB.waitFor((m) => m.type === 'presence');
  ok(Array.isArray(pres0.agents) && pres0.agents.length === 0, `presence 에 agents 배열(처음 ${JSON.stringify(pres0.agents)})`);

  const q1 = await openSse(base, null, { token: T.a, channel: 1 });
  ok(q1.status === 400 && q1.data?.error === 'TOKEN_IN_QUERY', '?token= → 400 TOKEN_IN_QUERY');
  const q2 = await openSse(base, T.a, { token: T.a, channel: 1 });
  ok(q2.status === 400 && q2.data?.error === 'TOKEN_IN_QUERY', '머리글이 있어도 ?token= 이 있으면 400');
  const q3 = await openSse(base, null, { channel: 1 });
  ok(q3.status === 401, '토큰 없음 → 401');
  const q4 = await openSse(base, T.a, { channel: 1, session: 'bad session!' });
  ok(q4.status === 400 && q4.data?.error === 'BAD_SESSION', 'session 형식이 틀리면 400 BAD_SESSION');

  const sA1 = await openSse(base, T.a, { session: 'sessA1', agent: 'Claude Code', client: 'api-agents-test', channel: 1 });
  ok(sA1.status === 200 && sA1.headers.get('content-type') === 'text/event-stream' && sA1.headers.get('cache-control') === 'no-cache, no-transform' && sA1.headers.get('x-accel-buffering') === 'no',
    `SSE 머리글: ${sA1.headers.get('content-type')} · ${sA1.headers.get('cache-control')} · X-Accel-Buffering ${sA1.headers.get('x-accel-buffering')}`);
  const hello = await sA1.waitFor((e) => e.event === 'hello');
  ok(hello.data.user === A && hello.data.session === 'sessA1' && hello.data.server === srv.config.version, `hello ${JSON.stringify(hello.data)}`);
  const snap = await sA1.waitFor((e) => e.event === 'snapshot');
  ok(sA1.events[0].event === 'hello' && sA1.events[1].event === 'snapshot' && Array.isArray(snap.data.requests) && snap.data.requests.length === 0, 'hello 다음 snapshot { requests: [] }(아직 요청 없음)');
  const onl = await wB.waitFor((m) => m.type === 'agent' && m.action === 'online' && m.user === A);
  ok(onl.agent === 'Claude Code', `WS(남의 방 구독자 B) ← { type:'agent', action:'online', user:${onl.user}, agent:${onl.agent} }`);
  const wA = watchWs(base, T.a, d.id); await wA.ready;
  const pres1 = await wB.waitFor((m) => m.type === 'presence' && m.users?.includes(A));
  ok(pres1.agents.some((x) => x.user === A && x.agent === 'Claude Code'), `presence.agents 에 ${A}(Claude Code)`);
  const stA = await apiA('/api/agent/status');
  ok(stA.me.online === true && stA.me.sessions.length === 1 && stA.me.sessions[0].session === 'sessA1' && stA.me.sessions[0].channel === true && stA.me.sessions[0].client === 'api-agents-test',
    `/api/agent/status(A): online, 세션 ${stA.me.sessions.map((s) => s.session)}`);
  ok(stA.users.some((u) => u.user === A && u.agents.some((x) => x.agent === 'Claude Code' && x.channel === true && x.since)) && !JSON.stringify(stA.users).includes('sessA1'), 'status.users: 사람별 에이전트(세션 id 는 싣지 않음)');
  ok((await apiB('/api/agent/status')).me.online === false, '/api/agent/status(B): online false');

  section('route auto + 채널 세션 → agent, ai_request 정확히 1번(지시 원문 없음)');
  const SECRET = '비밀지시-XYZ 표현을 매끄럽게';
  const t0 = Date.now();
  const r1 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: SECRET, target: { ref: 's0/p0' } } });
  const R1 = r1.request.rid;
  ok(r1.route === 'agent' && r1.queued === true && r1.request.status === 'pending' && r1.request.route === 'agent' && r1.request.routeWanted === 'auto', `요청 #${R1}: route ${r1.route}, ${r1.request.status}`);
  ok(r1.request.delivery?.session === 'sessA1' && r1.request.delivery.agent === 'Claude Code' && r1.request.claim === null, `delivery ${JSON.stringify(r1.request.delivery)}, claim null`);
  const ev1 = await sA1.waitFor((e) => e.event === 'ai_request' && e.data.rid === R1, 2000, `ai_request #${R1}`);
  ok(Date.now() - t0 < 2000, `ai_request 가 2초 안에 옴(${Date.now() - t0}ms)`);
  ok(ev1.data.docId === d.id && ev1.data.docTitle === d.title && ev1.data.kind === 'instruct' && ev1.data.label && ev1.data.attempt === 1 && ev1.data.at === r1.request.at,
    `ai_request ${JSON.stringify(ev1.data)}`);
  ok(Object.keys(ev1.data).sort().join() === 'at,attempt,docId,docTitle,kind,label,rid' && !ev1.raw.includes('비밀지시') && !ev1.raw.includes('instruction'), 'payload 는 정해진 키만 — 지시 원문 없음');
  const dl1 = await wB.waitFor((m) => m.type === 'request' && m.action === 'delivered' && m.rid === R1);
  ok(dl1.owner === A && dl1.agent === 'Claude Code', `WS request delivered(owner ${dl1.owner}, agent ${dl1.agent})`);

  // 남의 요청은 이 세션에 오지 않는다: B 는 에이전트가 없으니 auto → server(모의 AI), agent → queue
  const rb1 = await apiB(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } });
  ok(rb1.route === 'server' && rb1.request.status === 'done', `B 의 요청 #${rb1.request.rid}(auto, B 에이전트 없음) → server(모의 AI) done`);
  const rb2 = await apiB(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'agent' } });
  ok(rb2.route === 'queue' && rb2.request.status === 'pending' && /에이전트가 연결되어 있지 않아/.test(rb2.hint), `B 의 route 'agent'(에이전트 없음) → queue(${rb2.hint.split('.')[0]})`);
  await sleep(Math.max(0, 2000 - (Date.now() - t0)));
  ok(sA1.of('ai_request', R1).length === 1, `2초 동안 #${R1} ai_request 는 정확히 1번`);
  ok(!sA1.events.some((e) => e.event === 'ai_request' && [rb1.request.rid, rb2.request.rid].includes(e.data.rid)), '남(B)의 요청은 A 의 세션에 오지 않음');

  section('채널 세션 둘 → 가장 최근 세션에만, 하나 끊겨도 offline 아님');
  const sA2 = await openSse(base, T.a, { session: 'sessA2', agent: 'Claude Code', channel: 1 });
  const snap2 = await sA2.waitFor((e) => e.event === 'snapshot');
  ok(snap2.data.requests.some((x) => x.rid === R1 && x.status === 'pending' && x.attempt === 1) && !snap2.data.requests.some((x) => x.rid === rb2.request.rid), `새 세션 snapshot: 내 pending #${R1} 있음, 남의 요청 없음`);
  const r2 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' } } });
  const R2 = r2.request.rid;
  await sA2.waitFor((e) => e.event === 'ai_request' && e.data.rid === R2, 2000, `sessA2 의 ai_request #${R2}`);
  await sleep(300);
  ok(r2.request.delivery.session === 'sessA2' && sA1.of('ai_request', R2).length === 0, `#${R2} 는 가장 최근 세션(sessA2)에만`);
  const offBefore = wB.msgs.filter((m) => m.type === 'agent' && m.action === 'offline' && m.user === A).length;
  sA2.close();
  await until(async () => (await apiA('/api/agent/status')).me.sessions.length === 1, 5000, 'sessA2 정리');
  await sleep(200);
  ok(wB.msgs.filter((m) => m.type === 'agent' && m.action === 'offline' && m.user === A).length === offBefore && (await apiA('/api/agent/status')).me.online, 'sessA2 끊김 → sessA1 이 남아 offline 알림 없음');

  section('MCP start_request 선점: 세션 A 됨 / 세션 B 409 CLAIMED / 남 403 NOT_OWNER');
  const st1 = await mcp(base, T.a, 'start_request', { doc_id: d.id, request_id: R1 }, { session: 'sessA1' });
  ok(!st1.isError && st1.json.status === 'working' && st1.json.claim?.session === 'sessA1' && st1.json.claim.by === A && st1.json.claim.agent === 'Claude Code' && st1.json.handledBy === 'Claude Code',
    `start_request(sessA1) → working, claim ${JSON.stringify(st1.json?.claim)}`);
  const wk = await wB.waitFor((m) => m.type === 'request' && m.action === 'working' && m.rid === R1);
  ok(wk.owner === A, 'WS working(owner)');
  const st2 = await mcp(base, T.a, 'start_request', { doc_id: d.id, request_id: R1 }, { session: 'sessA2' });
  ok(st2.isError && /CLAIMED/.test(st2.text), `같은 사람 다른 세션(sessA2) → ${st2.text.slice(0, 60)}`);
  const st3 = await mcp(base, T.b, 'start_request', { doc_id: d.id, request_id: R1 }, { session: 'sessB1' });
  ok(st3.isError && /NOT_OWNER/.test(st3.text), `남(B) → ${st3.text.slice(0, 50)}`);
  const st4 = await mcp(base, T.admin, 'start_request', { doc_id: d.id, request_id: R1 }, { session: 'sessAdm' });
  ok(st4.isError && /CLAIMED/.test(st4.text), '관리자도 다른 세션이 맡은 동안은 CLAIMED');
  const st5 = await mcp(base, T.a, 'start_request', { doc_id: d.id, request_id: R1 }, { session: 'sessA1' });
  ok(!st5.isError && st5.json.claim.session === 'sessA1' && st5.json.claim.at === st1.json.claim.at && Date.parse(st5.json.claim.expires) >= Date.parse(st1.json.claim.expires), '같은 세션이 다시 start → lease 연장(시작 시각 그대로)');
  const workingMsgs = wB.msgs.filter((m) => m.type === 'request' && m.action === 'working' && m.rid === R1).length;
  ok(workingMsgs === 1, `연장은 working 을 다시 알리지 않음(${workingMsgs}번)`);

  const reqOf = async (rid, who = apiA, id = d.id) => (await who(`/api/docs/${id}/requests/${rid}`));
  const e1 = Date.parse((await reqOf(R1)).claim.expires);
  await sleep(40);
  const pc1 = await mcp(base, T.a, 'propose_change', { doc_id: d.id, ref: 's0/p0', find: '메모 대상', replace: '메모 대상(고침)', request_id: R1 }, { session: 'sessA1' });
  const e2 = Date.parse((await reqOf(R1)).claim.expires);
  ok(!pc1.isError && pc1.json.rid === R1 && e2 > e1, `맡은 세션의 request_id 도구 호출 → lease 연장(+${e2 - e1}ms)`);
  const pc2 = await mcp(base, T.a, 'propose_change', { doc_id: d.id, ref: 's0/p0', find: '메모 대상', replace: '메모 대상(다른 세션)', request_id: R1 }, { session: 'sessA2' });
  const afterPc2 = await reqOf(R1);
  ok(pc2.isError && /CLAIMED/.test(pc2.text) && afterPc2.claim.session === 'sessA1' && Date.parse(afterPc2.claim.expires) === e2, '다른 세션의 request_id 제안은 CLAIMED — 중복 결과를 남기지 않음');
  const memoOther = await mcp(base, T.a, 'add_memo', { doc_id: d.id, ref: 's0/p0', text: '다른 세션의 중복 의견', request_id: R1 }, { session: 'sessA2' });
  ok(memoOther.isError && /CLAIMED/.test(memoOther.text), '다른 세션의 request_id 의견도 CLAIMED');

  section('complete_request 권한 · REQUEST_CLOSED');
  const cB = await mcp(base, T.b, 'complete_request', { doc_id: d.id, request_id: R1, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '남이 완료' }, { session: 'sessB1' });
  ok(cB.isError && /NOT_OWNER/.test(cB.text), `맡지 않은 남(B) complete → ${cB.text.slice(0, 50)}`);
  const cOther = await mcp(base, T.a, 'complete_request', { doc_id: d.id, request_id: R1, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '다른 세션의 완료' }, { session: 'sessA2' });
  ok(cOther.isError && /CLAIMED/.test(cOther.text) && (await reqOf(R1)).status === 'working', '요청자라도 다른 세션이 맡고 있으면 complete → CLAIMED');
  const cA = await mcp(base, T.a, 'complete_request', { doc_id: d.id, request_id: R1, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '표현을 다듬는 제안 2건을 남김' }, { session: 'sessA1' });
  ok(!cA.isError && cA.json.status === 'done' && cA.json.summary === '표현을 다듬는 제안 2건을 남김', `요청자(맡은 세션) complete → done`);
  const completedVersion = (await apiA(`/api/docs/${d.id}`)).version;
  const completedLog = (await reqOf(R1)).log.length;
  const cAgain = await mcp(base, T.a, 'complete_request', { doc_id: d.id, request_id: R1, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '표현을 다듬는 제안 2건을 남김' }, { session: 'sessA1' });
  ok(!cAgain.isError && cAgain.json.status === 'done' && (await reqOf(R1)).log.length === completedLog && (await apiA(`/api/docs/${d.id}`)).version === completedVersion, '같은 complete 재시도는 완료 이력·메모·버전을 중복 저장하지 않음');
  const propsBefore = (await apiA(`/api/docs/${d.id}/proposals`)).length;
  const memosBefore = (await apiA(`/api/docs/${d.id}/memos`)).length;
  const verBefore = (await apiA(`/api/docs/${d.id}`)).version;
  const closedCalls = [
    ['propose_change', { doc_id: d.id, ref: 's0/p0', find: '메모 대상', replace: 'x', request_id: R1 }],
    ['propose_changes', { doc_id: d.id, proposals: [{ ref: 's0/p0', find: '메모 대상', replace: 'y' }], request_id: R1 }],
    ['propose_alternatives', { doc_id: d.id, ref: 's0/p0', find: '메모 대상', options: [{ text: '메모 자리' }], request_id: R1 }],
    ['propose_insert', { doc_id: d.id, after_ref: 's0/p0', text: '새 문단', request_id: R1 }],
    ['add_memo', { doc_id: d.id, ref: 's0/p0', text: '닫힌 요청에 의견', request_id: R1 }],
    ['start_request', { doc_id: d.id, request_id: R1 }],
  ];
  const closedRes = [];
  for (const [name, args] of closedCalls) closedRes.push([name, await mcp(base, T.a, name, args, { session: 'sessA1' })]);
  ok(closedRes.every(([, r]) => r.isError && /REQUEST_CLOSED/.test(r.text)), `완료된 요청에 request_id: ${closedRes.map(([n]) => n).join('·')} → 모두 REQUEST_CLOSED`);
  const rm = await apiA.res(`/api/docs/${d.id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: 'REST 의견', rid: R1 } });
  const rp = await apiA.res(`/api/docs/${d.id}/proposals`, { method: 'POST', body: { ref: 's0/p0', find: '메모 대상', replace: 'z', rid: R1 } });
  ok(rm.status === 409 && rm.data.error === 'REQUEST_CLOSED' && rp.status === 409 && rp.data.error === 'REQUEST_CLOSED', 'REST 메모·제안(rid) → 409 REQUEST_CLOSED');
  ok((await apiA(`/api/docs/${d.id}/proposals`)).length === propsBefore && (await apiA(`/api/docs/${d.id}/memos`)).length === memosBefore && (await apiA(`/api/docs/${d.id}`)).version === verBefore,
    `거절된 호출은 아무것도 남기지 않음(제안 ${propsBefore}·메모 ${memosBefore}·v${verBefore} 그대로)`);

  section('get_request: <document_context> · 경로·전달 정보');
  const g2 = await mcp(base, T.a, 'get_request', { doc_id: d.id, request_id: R2 }, { session: 'sessA1' });
  const ctxText = g2.json?.context || '';
  ok(!g2.isError && ctxText.startsWith('<document_context>\n') && ctxText.endsWith('\n</document_context>') && ctxText.includes('*[s0/p1]'), `context 를 <document_context> 로 감쌈(${ctxText.split('\n').length}줄, * 대상 포함)`);
  ok(g2.json.route === 'agent' && g2.json.delivery?.agent === 'Claude Code' && !('session' in (g2.json.delivery || {})) && g2.json.claim === null && g2.json.attempt === 1 && /start_request/.test(g2.json.howTo), `get_request: route ${g2.json.route}, delivery.agent, claim null, howTo 에 start_request`);
  const g1 = await mcp(base, T.a, 'get_request', { doc_id: d.id, request_id: R1 }, { session: 'sessA1' });
  ok(/완료/.test(g1.json.howTo) && g1.json.claim?.mine === true && g1.json.instruction === SECRET, '완료된 요청 howTo = 손대지 않음, claim.mine, 요청자는 지시 원문을 봄');
  const gB = await mcp(base, T.b, 'get_request', { doc_id: d.id, request_id: R1 }, { session: 'sessB1' });
  ok(gB.json.instruction === null && gB.json.claim?.mine === false, '남(B)의 get_request: 지시 숨김, claim.mine false');
  const lr = await mcp(base, T.a, 'list_requests', { doc_id: d.id, status: 'all' }, { session: 'sessA1' });
  const lr1 = lr.json.find((x) => x.rid === R1);
  ok(lr1.route === 'agent' && lr1.claim.mine === true && !JSON.stringify(lr.json).includes('sessA1'), 'list_requests: route·claim(mine) — 세션 id 는 싣지 않음');

  section('취소 → ai_request_cancelled, 다시 요청 → requeued + 다시 알림(attempt 2)');
  await apiA(`/api/docs/${d.id}/requests/${R2}/cancel`, { method: 'POST' });
  const cev = await sA1.waitFor((e) => e.event === 'ai_request_cancelled' && e.data.rid === R2, 3000, 'ai_request_cancelled');
  ok(cev.data.docId === d.id && cev.data.attempt === 1 && Object.keys(cev.data).sort().join() === 'attempt,docId,rid', `ai_request_cancelled ${JSON.stringify(cev.data)}`);
  const cm = await wB.waitFor((m) => m.type === 'request' && m.action === 'cancelled' && m.rid === R2);
  ok(cm.owner === A, 'WS cancelled(owner)');
  const rt = await apiA(`/api/docs/${d.id}/requests/${R2}/retry`, { method: 'POST' });
  ok(rt.queued === true && rt.route === 'agent' && rt.request.status === 'pending' && rt.request.delivery?.session === 'sessA1', `다시 요청 → route ${rt.route}(에이전트 연결됨), pending`);
  const rq = await wB.waitFor((m) => m.type === 'request' && m.action === 'requeued' && m.rid === R2);
  const rd = await wB.waitFor((m) => m.type === 'request' && m.action === 'delivered' && m.rid === R2 && m.at >= rq.at);
  ok(rq.owner === A && rq.route === 'agent' && rd.owner === A, "WS 'requeued'(옛 'update' 대신) + 'delivered'");
  ok(!wB.msgs.some((m) => m.type === 'request' && m.action === 'update' && m.rid === R2), "다시 요청에 'update' 방송은 없음");
  const ev2 = await sA1.waitFor((e) => e.event === 'ai_request' && e.data.rid === R2 && e.data.attempt === 2, 3000, 'attempt 2');
  ok(ev2.data.at === r2.request.at, `다시 알림 attempt ${ev2.data.attempt}(at 은 처음 요청 시각)`);

  section('claim_next_request');
  const r3 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p2' }, route: 'queue' } });
  const R3 = r3.request.rid;
  await sleep(300);
  ok(r3.route === 'queue' && r3.request.delivery === null && sA1.of('ai_request', R3).length === 0, `route 'queue' 는 에이전트가 붙어 있어도 대기열(#${R3}, 알림 없음)`);
  const cn1 = await mcp(base, T.a, 'claim_next_request', {}, { session: 'sessA1' });
  ok(!cn1.isError && cn1.json.claimed === true && cn1.json.rid === R2 && cn1.json.status === 'working' && cn1.json.claim?.mine === true && cn1.json.context.startsWith('<document_context>'),
    `claim_next → 가장 오래된 내 pending #${cn1.json?.rid}(working, claim.mine, 문맥 포함)`);
  ok(!/start_request/.test(cn1.json.howTo), 'claim_next 결과 howTo 는 start_request 를 다시 시키지 않음');
  const cn2 = await mcp(base, T.a, 'claim_next_request', { doc_id: d.id }, { session: 'sessA1' });
  ok(cn2.json?.rid === R3 && cn2.json.claimed, `다음 claim_next(doc_id) → #${cn2.json?.rid}`);
  const cn3 = await mcp(base, T.a, 'claim_next_request', {}, { session: 'sessA1' });
  ok(cn3.json?.none === true, 'pending 없음 → { none: true }');
  const stx = await mcp(base, T.a, 'start_request', { doc_id: d.id, request_id: R3 }, { session: 'sessA2' });
  ok(stx.isError && /CLAIMED/.test(stx.text), 'claim_next 로 맡은 요청을 다른 세션이 start → CLAIMED');
  const cnB = await mcp(base, T.b, 'claim_next_request', {}, { session: 'sessB1' });
  ok(cnB.json?.rid === rb2.request.rid && cnB.json.by === B, `B 의 claim_next 는 B 의 요청(#${cnB.json?.rid})만`);

  section("세션 id 'server' 는 서버 AI 표식이 아님(서버 AI 선점은 claim.server)");
  const sAdm = await openSse(base, T.admin, { session: 'server', agent: 'Claude Code', channel: 1 });
  await sAdm.waitFor((e) => e.event === 'snapshot');
  const r7 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' }, route: 'queue' } });
  const R7 = r7.request.rid;
  const sv1 = await mcp(base, T.admin, 'start_request', { doc_id: d.id, request_id: R7 }, { session: 'server' });
  ok(!sv1.isError && sv1.json.claim.session === 'server' && sv1.json.claim.by === ADM && !sv1.json.claim.server, `관리자가 머리글 세션 'server' 로 맡음 → 보통 에이전트 선점`);
  const sv2 = await mcp(base, T.a, 'start_request', { doc_id: d.id, request_id: R7 }, { session: 'sessA1' });
  ok(sv2.isError && /CLAIMED/.test(sv2.text) && !sv2.text.includes('서버 AI') && sv2.text.includes(ADM), `요청자의 세션 → CLAIMED(서버 AI 라고 하지 않음: ${sv2.text.slice(0, 70)})`);
  await apiA(`/api/docs/${d.id}/requests/${R7}/cancel`, { method: 'POST' });
  const cvAdm = await sAdm.waitFor((e) => e.event === 'ai_request_cancelled' && e.data.rid === R7, 3000, "관리자 세션('server') 취소 알림");
  ok(cvAdm.data.docId === d.id, "취소 → 맡은 관리자의 세션('server')에도 ai_request_cancelled");
  sAdm.close();

  section('끊김 → offline, 에이전트 없음 + 모의 AI → server');
  sA1.close();
  const off = await wB.waitFor((m) => m.type === 'agent' && m.action === 'offline' && m.user === A, 5000);
  ok(off.agent === 'Claude Code', `WS ← { type:'agent', action:'offline', user:${off.user} }`);
  ok((await apiA('/api/agent/status')).me.online === false, 'status: online false');
  const r4 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } });
  ok(r4.route === 'server' && r4.queued === false && r4.request.status === 'done' && r4.request.route === 'server', `에이전트 없음 + 모의 AI: auto → server(#${r4.request.rid} done, 옛 동작)`);
  const lr4 = (await mcp(base, T.a, 'list_requests', { doc_id: d.id, status: 'all' }, { session: 'sessA1' })).json.find((x) => x.rid === r4.request.rid);
  ok(r4.request.claim?.server === true && r4.request.claim.session === null && !('run' in r4.request.claim) && lr4?.claim?.server === true && lr4.claim.mine === false,
    `서버 AI 선점은 claim.server(세션 id 아님, 실행 표 run 은 안 보임) — REST·MCP 모두`);
  const r5 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'agent' } });
  ok(r5.route === 'queue' && r5.request.status === 'pending', "에이전트 없음 + route 'agent' → queue");

  section('채널 아닌 세션 · 같은 세션 다시 붙음 · MCP 세션 머리글 검사 · 안내');
  const onlineCount = () => wB.msgs.filter((m) => m.type === 'agent' && m.action === 'online' && m.user === A).length;
  const on0 = onlineCount();
  const sA3 = await openSse(base, T.a, { session: 'sessA3', agent: 'Monitor' });
  await sA3.waitFor((e) => e.event === 'snapshot');
  const st6 = await apiA('/api/agent/status');
  ok(st6.me.online === false && st6.me.sessions.some((s) => s.session === 'sessA3' && s.channel === false), '채널 아닌 세션: sessions 에는 보이지만 online 아님');
  const r6 = await apiA(`/api/docs/${d.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } });
  await sleep(200);
  ok(r6.route === 'server' && sA3.of('ai_request').length === 0 && onlineCount() === on0, '채널 아닌 세션은 경로·푸시·online 알림에 안 침');
  sA3.close();
  const dup1 = await openSse(base, T.a, { session: 'dup', agent: 'Claude Code', channel: 1 });
  await dup1.waitFor((e) => e.event === 'snapshot');
  const dup2 = await openSse(base, T.a, { session: 'dup', agent: 'Claude Code', channel: 1 });
  await dup2.waitFor((e) => e.event === 'snapshot');
  await dup1.waitClosed(3000);
  const st7 = await apiA('/api/agent/status');
  ok(dup1.closed && !dup2.closed && st7.me.online && st7.me.sessions.filter((s) => s.session === 'dup').length === 1, '같은 세션이 다시 붙으면 서버가 옛 연결을 닫음(세션 하나)');
  const offOf = () => wB.msgs.filter((m) => m.type === 'agent' && m.action === 'offline' && m.user === A);
  const offNow = offOf().length;
  ok(offNow === 1, `옛 연결을 닫을 때는 offline 을 알리지 않음(지금까지 ${offNow}번 = sA1 끊김 때뿐)`);
  dup2.close();
  const offDup = await until(() => (offOf().length > offNow ? offOf().at(-1) : null), 5000, '다시 붙은 세션의 offline');
  ok(offDup.agent === 'Claude Code' && !(await apiA('/api/agent/status')).me.online, '다시 붙은 세션이 끊기면 offline');

  const bad1 = await mcp(base, T.a, 'list_requests', {}, { session: 'bad session!' });
  const bad2 = await mcp(base, T.a, 'list_requests', {}, { session: 'x'.repeat(65) });
  const good = await mcp(base, T.a, 'list_requests', {}, { session: `${'a'.repeat(30)}_-${'Z9'.repeat(16)}` });
  ok(bad1.status === 400 && bad2.status === 400 && good.status === 200 && !good.isError, 'X-Hwpx-Agent-Session: 형식 틀림·65자 → 400, 영문·숫자·_- 64자 → 됨');
  const init = await rpc(base, T.a, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'api-agents-test', version: '1' } } });
  const ins = init.msg?.result?.instructions || '';
  ok(ins.length > 0 && ins.length <= 1500 && ins.includes('claim_next_request') && ins.includes('CLAIMED') && ins.includes('REQUEST_CLOSED') && ins.includes('<document_context>'), `instructions ${ins.length}자(claim_next_request·CLAIMED·REQUEST_CLOSED·<document_context>)`);
  const tl = await rpc(base, T.a, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (tl.msg?.result?.tools || []).map((t) => t.name);
  ok(names.includes('claim_next_request') && names.includes('start_request') && names.length >= 27, `도구 ${names.length}개(claim_next_request 포함)`);
  wA.close(); wB.close();
  await srv.stop();

  // ───────── 2. 서버(AI 끔, lease 1.5초, othersCanTake) ─────────
  section('서버(AI 끔, lease 1.5초): lease 끝난 working → snapshot, 이어받기');
  const srv2 = await startServer({ ai: 'off', config: { agents: { leaseMinutes: 0.025, othersCanTake: true } } }); servers.push(srv2);
  const b2 = srv2.base; const T2 = srv2.tokens; const A2 = srv2.users.a.name; const B2 = srv2.users.b.name;
  const a2 = srv2.api('a'); const bb2 = srv2.api('b');
  const d2 = await uploadDoc(b2, T2.a, fixture('tool_memo_tracked.hwpx'), '리스 시험.hwpx');
  const w2 = watchWs(b2, T2.b, d2.id); await w2.ready;
  const Q1 = (await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } }));
  const Q2 = (await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' } } }));
  ok(Q1.route === 'queue' && Q2.route === 'queue' && Q1.request.status === 'pending', 'AI 끔 + 에이전트 없음 → queue');
  const s1 = await mcp(b2, T2.a, 'start_request', { doc_id: d2.id, request_id: Q1.request.rid }, { session: 'L1' });
  const leaseMs = Date.parse(s1.json.claim.expires) - Date.parse(s1.json.claim.at);
  ok(!s1.isError && s1.json.claim.session === 'L1' && leaseMs === 1500, `start(L1) → lease ${leaseMs}ms(config.agents.leaseMinutes 0.025)`);
  const sl1 = await openSse(b2, T2.a, { session: 'L1', agent: 'Claude Code', channel: 1 });
  const sn1 = await sl1.waitFor((e) => e.event === 'snapshot');
  ok(sn1.data.requests.some((x) => x.rid === Q2.request.rid && x.status === 'pending') && !sn1.data.requests.some((x) => x.rid === Q1.request.rid), 'lease 안: snapshot 에 pending 만(맡은 working 은 없음)');
  sl1.close();
  await until(async () => !(await a2('/api/agent/status')).me.online, 5000, 'L1 끊김');
  await sleep(Math.max(0, Date.parse(s1.json.claim.expires) - Date.now() + 200));
  const sl2 = await openSse(b2, T2.a, { session: 'L2', agent: 'Claude Code', channel: 1 });
  const sn2 = await sl2.waitFor((e) => e.event === 'snapshot');
  const staleQ1 = sn2.data.requests.find((x) => x.rid === Q1.request.rid);
  ok(staleQ1 && staleQ1.status === 'working' && staleQ1.stale === true && sn2.data.requests.some((x) => x.rid === Q2.request.rid), `lease 끝난 뒤 snapshot: working #${Q1.request.rid}(stale) + pending #${Q2.request.rid}`);
  ok(sn2.data.requests.map((x) => x.rid).join() === [Q1.request.rid, Q2.request.rid].join(), 'snapshot 은 오래된 것부터');
  const s2 = await mcp(b2, T2.a, 'start_request', { doc_id: d2.id, request_id: Q1.request.rid }, { session: 'L2' });
  ok(!s2.isError && s2.json.claim.session === 'L2' && s2.json.log.at(-1).detail === '처리 이어받음', `lease 끝난 요청을 다른 세션(L2)이 이어받음(${s2.json.log.at(-1).detail})`);
  const s3 = await mcp(b2, T2.a, 'start_request', { doc_id: d2.id, request_id: Q1.request.rid }, { session: 'L1' });
  ok(s3.isError && /CLAIMED/.test(s3.text), '옛 세션(L1)이 다시 start → CLAIMED');

  section('AI 끔 + 에이전트 연결 → agent, othersCanTake: 남이 맡아 완료(맡은 세션만)');
  const Q3 = await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p2' } } });
  ok(Q3.route === 'agent' && Q3.request.delivery.session === 'L2', `AI 꺼져도 에이전트가 붙어 있으면 auto → agent(#${Q3.request.rid})`);
  await sl2.waitFor((e) => e.event === 'ai_request' && e.data.rid === Q3.request.rid, 2000, 'Q3 ai_request');
  const ob = await mcp(b2, T2.b, 'start_request', { doc_id: d2.id, request_id: Q3.request.rid }, { session: 'B1' });
  ok(!ob.isError && ob.json.claim.by === B2 && ob.json.claim.session === 'B1', 'othersCanTake: 남(B)도 맡을 수 있음');
  const obc1 = await mcp(b2, T2.b, 'complete_request', { doc_id: d2.id, request_id: Q3.request.rid, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: 'x' }, { session: 'B2' });
  ok(obc1.isError && /NOT_OWNER/.test(obc1.text), '같은 B 라도 맡지 않은 세션(B2) complete → NOT_OWNER');
  const obc2 = await mcp(b2, T2.b, 'complete_request', { doc_id: d2.id, request_id: Q3.request.rid, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '남이 맡아 처리함' }, { session: 'B1' });
  ok(!obc2.isError && obc2.json.status === 'done', '맡은 세션(B1) complete → done');
  const admDone = await mcp(b2, T2.admin, 'complete_request', { doc_id: d2.id, request_id: Q1.request.rid, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '관리자 완료' }, { session: 'ADM1' });
  ok(!admDone.isError && admDone.json.status === 'done', '관리자는 (맡지 않았어도) complete 할 수 있음');
  const Q5 = await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'queue' } });
  await mcp(b2, T2.a, 'start_request', { doc_id: d2.id, request_id: Q5.request.rid }, { session: 'L2' });
  const spoof = await mcp(b2, T2.b, 'complete_request', { doc_id: d2.id, request_id: Q5.request.rid, no_changes_reason: '흐름 시험 — 문서 결과 없이 완료', summary: '흉내' }, { session: 'L2' });
  ok(spoof.isError && /NOT_OWNER/.test(spoof.text), '남의 세션 id 를 흉내 내도(B 가 L2) complete 안 됨 — 사용자까지 맞아야');

  section('취소 알림 · 대기열 다시 요청 → requeued · 동시 start 는 하나만');
  await a2(`/api/docs/${d2.id}/requests/${Q2.request.rid}/cancel`, { method: 'POST' });
  const cev2 = await sl2.waitFor((e) => e.event === 'ai_request_cancelled' && e.data.rid === Q2.request.rid, 3000, 'Q2 취소 알림');
  ok(cev2.data.docId === d2.id && sl2.of('ai_request_cancelled').length === 1, `취소 → 에이전트(L2)에 ai_request_cancelled #${Q2.request.rid}(1번)`);
  const cp = await a2.res(`/api/docs/${d2.id}/proposals`, { method: 'POST', body: { ref: 's0/p1', find: '낱말을', replace: '단어를', rid: Q2.request.rid } });
  ok(cp.status === 409 && cp.data.error === 'REQUEST_CLOSED', '취소된 요청(rid) 제안 → 409 REQUEST_CLOSED');
  sl2.close();
  await w2.waitFor((m) => m.type === 'agent' && m.action === 'offline' && m.user === A2, 5000);
  const rq2 = await a2(`/api/docs/${d2.id}/requests/${Q2.request.rid}/retry`, { method: 'POST' });
  const rqm = await w2.waitFor((m) => m.type === 'request' && m.action === 'requeued' && m.rid === Q2.request.rid);
  ok(rq2.queued === true && rq2.route === 'queue' && rq2.request.status === 'pending' && rqm.owner === A2 && rqm.route === 'queue', "AI 끔 + 에이전트 없음: 다시 요청 → 대기열, WS 'requeued'(owner)");
  const qs = await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'server' } });
  // 정한 동작: 422 AI_OFF 로 거절하지 않는다 — §2.2 에 AI_OFF 가 없고, 쓸 수 없는 경로는 agent 처럼 queue 로 떨어지며 응답 route 가 실제 경로
  ok(qs.route === 'queue' && qs.queued === true && qs.request.status === 'pending' && qs.request.routeWanted === 'server' && qs.hint.startsWith('서버 AI 가 꺼져 있어'),
    "AI 끔 + route 'server' → queue(422 아님) + 안내 '서버 AI 가 꺼져 있어…'");
  const Q4 = await a2(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' } } });
  const race = await Promise.all(['R1', 'R2', 'R3'].map((s) => mcp(b2, T2.a, 'start_request', { doc_id: d2.id, request_id: Q4.request.rid }, { session: s })));
  const won = race.filter((r) => !r.isError); const lost = race.filter((r) => r.isError && /CLAIMED/.test(r.text));
  ok(won.length === 1 && lost.length === 2, `동시 start_request 3개 → 1개만 맡음(${won[0]?.json?.claim?.session}), 2개 CLAIMED`);
  const wkN = w2.msgs.filter((m) => m.type === 'request' && m.action === 'working' && m.rid === Q4.request.rid).length;
  ok(wkN === 1, `working 방송도 1번(${wkN})`);
  w2.close();
  await srv2.stop();

  console.log(`\nAPI AGENTS OK — ${passed}개 확인`);
  void ADM; void bb2;
} catch (e) {
  console.error('\nAPI AGENTS FAILED:', e.stack || e.message);
  for (const s of servers) if (s.output) console.error(`--- 서버 ${s.base} 출력(끝) ---\n${s.output().slice(-2500)}`);
  process.exitCode = 1;
} finally {
  for (const s of streams) { try { s.close(); } catch { /* ignore */ } }
  for (const s of servers) await s.stop().catch(() => {});
  process.exit(process.exitCode || 0);
}
