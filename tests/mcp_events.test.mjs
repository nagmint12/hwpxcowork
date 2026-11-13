import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { createMcpEvents, EVENT_NAME } from '../server/mcp-events.js';
import { callbackUrl, isPublicAddress, publicLookup } from '../server/webhook-http.js';
import { Hub } from '../server/hub.js';
import { startServer, uploadDoc, fixture as hwpxFixture } from './helpers/server.mjs';

const secret = () => `whsec_${crypto.randomBytes(32).toString('base64')}`;
function setup({ transport, oauth } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-events-'));
  let time = Date.now(); const deliveries = [];
  const users = [{ name: 'A', token: 'token-A', role: 'editor' }, { name: 'B', token: 'token-B', role: 'editor' }];
  const config = { publicUrl: 'https://cowork.example', dataDir: dir, users };
  const docs = [{ id: 'doc1', requests: [] }, { id: 'doc2', requests: [] }];
  const service = { store: { list: () => docs, readMeta: id => { const doc = docs.find(d => d.id === id); if (!doc) throw new Error(); return doc; } }, _attempt: r => 1 + (r.log || []).filter(x => x.action === 'retry').length,
    docAccess: id => { if (!docs.some(d => d.id === id)) throw new Error(); return {}; } };
  const webhookFetch = async (url, options) => {
    const payload = JSON.parse(options.body); deliveries.push({ url, options, payload });
    if (transport) return transport(url, options, payload);
    return { ok: true, status: 200, body: JSON.stringify(payload.type === 'verification' ? { challenge: payload.challenge } : {}) };
  };
  let manager = createMcpEvents({ config, service, oauth, webhookFetch, now: () => time, autoStart: false });
  return { dir, config, users, docs, deliveries, service,
    get events() { return manager; }, tick(ms) { time += ms; },
    add({ user = 'A', doc = 'doc1', rid = 1, kind = 'review', route = 'queue', instruction = 'PRIVATE-INSTRUCTION' } = {}) {
      const r = { rid, by: user, at: new Date(time).toISOString(), status: 'pending', route, kind, instruction, log: [] }; docs.find(d => d.id === doc).requests.push(r); return r;
    },
    async reopen() { await manager.close(); manager = createMcpEvents({ config, service, oauth, webhookFetch, now: () => time, autoStart: false }); },
    async close() { await manager.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const params = (key, extra = {}) => ({ name: EVENT_NAME, arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: key }, ...extra });

test('웹훅 URL·IP 차단 및 DNS 재바인딩 방지 lookup', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', '64:ff9b::a00:1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://public.example', 'https://localhost/cb', 'https://user:pass@public.example/cb', 'https://public.example/cb#secret', 'https://127.1/cb', 'https://[::ffff:7f00:1]/cb']) assert.throws(() => callbackUrl(url), url);
  const run = addresses => new Promise(resolve => publicLookup('receiver.example', {}, (e, address) => resolve({ error: e, address }), (_hostname, _options, done) => done(null, addresses)));
  assert.equal((await run([{ address: '8.8.8.8', family: 4 }])).address, '8.8.8.8');
  assert.equal((await run([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).error.reason, 'unsafe_destination');
  assert.ok((await run([{ address: '10.0.0.1', family: 4 }])).error, '같은 호스트의 재연결 DNS가 사설 주소로 바뀌면 거절');
});

test('구독 callback challenge·HMAC 검증·멱등성·TTL·정확한 스키마', async () => {
  const s = setup(); const key = secret();
  try {
    const p = params(key); const principal = { user: s.users[0] };
    assert.deepEqual(s.events.list().events[0].delivery, ['webhook']);
    const first = await s.events.subscribe(principal, { ...p, ttlMs: 120000 });
    assert.equal(first.cursor, null); assert.equal(first.truncated, false);
    assert.equal(s.deliveries.length, 1);
    const verify = s.deliveries[0];
    assert.deepEqual(new Webhook(key).verify(verify.options.body, verify.options.headers), verify.payload);
    assert.equal(verify.payload.type, 'verification'); assert.equal(verify.options.headers['X-MCP-Subscription-Id'], first.id);
    assert.ok(Date.parse(first.refreshBefore) - Date.now() <= 120000);
    assert.equal((await s.events.subscribe(principal, p)).id, first.id);
    assert.equal(s.deliveries.length, 1, '동일 callback 검증은 제한된 기간 캐시');
    for (const bad of [{ ...p, name: 'wrong' }, { ...p, arguments: { mine: false } }, { ...p, delivery: { ...p.delivery, secret: 'whsec_abc' } }, { ...p, cursor: 'unsupported' }, { ...p, ttlMs: -1 }]) await assert.rejects(s.events.subscribe(principal, bad));
    assert.equal(s.events.status(s.users[0]).activeSubscriptions, 1);
    const status = JSON.stringify(s.events.status(s.users[0])); assert.ok(!status.includes(key)); assert.ok(!status.includes('receiver.example'));
  } finally { await s.close(); }
});

test('callback 검증 실패는 구독을 남기지 않고 분류된 오류만 반환', async () => {
  const s = setup({ transport: async () => ({ ok: true, status: 200, body: '{"challenge":"wrong"}' }) });
  try {
    await assert.rejects(s.events.subscribe({ user: s.users[0] }, params(secret())), e => e.code === -32015 && e.data.reason === 'challenge_failed');
    assert.equal(s.events.status(s.users[0]).activeSubscriptions, 0);
  } finally { await s.close(); }
});

test('새 요청→사용자/문서 필터→웹훅 전달, 중복·결과 피드백 루프 차단', async () => {
  const s = setup(); const key = secret();
  try {
    s.add({ rid: 99 }); s.tick(1);
    await s.events.subscribe({ user: s.users[0] }, params(key, { arguments: { document_id: 'doc1' } }));
    s.tick(1); s.add({ user: 'B' }); s.add({ doc: 'doc2' }); s.add({ rid: 2, route: 'server' }); const request = s.add({ rid: 3 });
    await s.events.flush();
    const delivered = s.deliveries.filter(x => !x.payload.type); assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.data.request_id, 3);
    assert.deepEqual(Object.keys(delivered[0].payload.data).sort(), ['attempt', 'document_id', 'kind', 'request_id', 'url']);
    assert.ok(!delivered[0].options.body.includes('PRIVATE-INSTRUCTION'));
    assert.equal(delivered[0].options.headers['webhook-id'], delivered[0].payload.eventId);
    new Webhook(key).verify(delivered[0].options.body, delivered[0].options.headers);
    await s.events.flush(); assert.equal(s.deliveries.filter(x => !x.payload.type).length, 1);
    request.status = 'done'; await s.events.flush(); assert.equal(s.deliveries.filter(x => !x.payload.type).length, 1);
    s.tick(1); request.status = 'pending'; request.log.push({ action: 'retry', at: new Date(Date.now() + 5).toISOString() });
    await s.events.flush(); const all = s.deliveries.filter(x => !x.payload.type); assert.equal(all.length, 2); assert.equal(all[1].payload.data.attempt, 2); assert.notEqual(all[0].payload.eventId, all[1].payload.eventId);
  } finally { await s.close(); }
});

test('outbox 재시작·5xx 재시도는 ID/본문 유지, 새 서명시간 사용', async () => {
  let rejectDelivery = true;
  const s = setup({ transport: async (_url, _options, p) => p.type ? { ok: true, status: 200, body: JSON.stringify({ challenge: p.challenge }) } : { ok: !rejectDelivery, status: rejectDelivery ? 503 : 200, body: '{}' } });
  try {
    await s.events.subscribe({ user: s.users[0] }, params(secret())); s.tick(1); s.add();
    await s.events.flush(); assert.equal(s.events.status(s.users[0]).subscriptions[0].deliveries.pending, 1);
    await s.reopen(); s.tick(1500); rejectDelivery = false; await s.events.flush();
    const messages = s.deliveries.filter(x => !x.payload.type); assert.equal(messages.length, 2);
    assert.equal(messages[0].options.body, messages[1].options.body);
    assert.equal(messages[0].options.headers['webhook-id'], messages[1].options.headers['webhook-id']);
    assert.notEqual(messages[0].options.headers['webhook-timestamp'], messages[1].options.headers['webhook-timestamp']);
    assert.equal(s.events.status(s.users[0]).subscriptions[0].deliveries.delivered, 1);
  } finally { await s.close(); }
});

test('410·413은 재시도하지 않음, 취소·만료·토큰 변경·OAuth 해제 후 전송 차단', async () => {
  for (const status of [410, 413]) {
    const s = setup({ transport: async (_url, _options, p) => p.type ? { ok: true, status: 200, body: JSON.stringify({ challenge: p.challenge }) } : { ok: false, status, body: '{}' } });
    try {
      await s.events.subscribe({ user: s.users[0] }, params(secret())); s.tick(1); s.add(); await s.events.flush(); s.tick(1000000); await s.events.flush();
      assert.equal(s.deliveries.filter(x => !x.payload.type).length, 1);
    } finally { await s.close(); }
  }
  let allowed = true; const s = setup({ oauth: { isEventGrantActive: () => allowed } }); const p = params(secret());
  try {
    const principal = { user: s.users[0], grantId: 'grant-A' };
    await s.events.subscribe(principal, { ...p, ttlMs: 60000 });
    assert.equal(s.events.status(s.users[1]).activeSubscriptions, 0);
    await s.events.unsubscribe({ user: s.users[1] }, p); assert.equal(s.events.status(s.users[0]).activeSubscriptions, 1);
    allowed = false; s.tick(1); s.add(); await s.events.flush(); assert.equal(s.deliveries.filter(x => !x.payload.type).length, 0);
    allowed = true; s.tick(60001); assert.equal(s.events.status(s.users[0]).activeSubscriptions, 0);
    await s.events.subscribe(principal, p); s.config.users[0].token = 'rotated'; await s.events.flush(); assert.equal(s.deliveries.filter(x => !x.payload.type).length, 0);
  } finally { await s.close(); }
});

test('구독 해제/갱신과 서명 키 회전, 재시작 후 해제 유지', async () => {
  const s = setup(); const oldKey = secret(); const newKey = secret();
  try {
    const principal = { user: s.users[0] }; const p = params(oldKey);
    const original = await s.events.subscribe(principal, p);
    const renewed = await s.events.subscribe(principal, params(newKey)); assert.equal(original.id, renewed.id);
    s.tick(1); s.add(); await s.events.flush();
    const delivery = s.deliveries.find(x => !x.payload.type); assert.equal(delivery.options.headers['webhook-signature'].split(' ').length, 2);
    new Webhook(oldKey).verify(delivery.options.body, delivery.options.headers); new Webhook(newKey).verify(delivery.options.body, delivery.options.headers);
    await s.events.unsubscribe(principal, p); await s.events.unsubscribe(principal, p);
    await s.reopen(); assert.equal(s.events.status(s.users[0]).activeSubscriptions, 0);
    s.tick(1); s.add({ rid: 2 }); await s.events.flush(); assert.equal(s.deliveries.filter(x => !x.payload.type).length, 1);
  } finally { await s.close(); }
});

test('Hub 요청 알림은 웹소켓 없이도 즉시 구독자에게 전달', () => {
  const hub = new Hub(); const messages = []; const stop = hub.onEvent((id, m) => messages.push({ id, m }));
  hub.broadcast('doc1', { type: 'request', action: 'add' }); assert.equal(messages.length, 1);
  stop(); hub.broadcast('doc1', { type: 'request', action: 'add' }); assert.equal(messages.length, 1); hub.wss.close();
});

test('만료 구독은 활성 한도에서 빠지고 동일 구독 갱신·해제는 멱등적', async () => {
  const s = setup(); const principal = { user: s.users[0] }; const key = secret();
  const input = i => params(key, { ttlMs: 60000, delivery: { mode: 'webhook', url: `https://receiver.example/callback/${i}`, secret: key } });
  try {
    const first = await s.events.subscribe(principal, input(0));
    for (let i = 1; i < 64; i++) await s.events.subscribe(principal, input(i));
    await assert.rejects(s.events.subscribe(principal, input(64)), /Subscription limit reached/);
    assert.equal((await s.events.subscribe(principal, input(0))).id, first.id);
    s.tick(60001); assert.equal(s.events.status(s.users[0]).activeSubscriptions, 0);
    await s.events.subscribe(principal, input(64));
    assert.equal(s.events.status(s.users[0]).activeSubscriptions, 1);
    await s.events.unsubscribe(principal, input(64)); await s.events.unsubscribe(principal, input(64));
    await s.events.subscribe(principal, input(65));
    assert.equal(s.events.status(s.users[0]).activeSubscriptions, 1);
    s.tick(31 * 86400000); await s.events.flush();
    assert.equal(s.events.status(s.users[0]).subscriptions.length, 0, '만료/해제 진단 기록도 보존 기간 뒤 정리');
  } finally { await s.close(); }
});

test('동시 callback 검증 후에도 활성 구독 한도를 초과하지 않는다', async () => {
  let release; let entered = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup({ transport: async (url, _options, p) => {
    if (/concurrent/.test(url)) { entered++; if (entered === 2) release(); await gate; }
    return { ok: true, status: 200, body: JSON.stringify({ challenge: p.challenge }) };
  } });
  const principal = { user: s.users[0] }; const key = secret();
  const input = name => params(key, { delivery: { mode: 'webhook', url: `https://receiver.example/${name}`, secret: key } });
  try {
    for (let i = 0; i < 63; i++) await s.events.subscribe(principal, input(i));
    const results = await Promise.allSettled([s.events.subscribe(principal, input('concurrent-1')), s.events.subscribe(principal, input('concurrent-2'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === -32602).length, 1);
    assert.equal(s.events.status(s.users[0]).activeSubscriptions, 64);
  } finally { release(); await s.close(); }
});

test('30일이 지난 수신 확인을 정리해도 아직 대기 중인 요청을 중복 발송하지 않는다', async () => {
  const s = setup(); const p = params(secret()); const principal = { user: s.users[0] };
  try {
    await s.events.subscribe(principal, p); s.tick(1); const request = s.add(); await s.events.flush();
    for (let i = 0; i < 33; i++) { s.tick(23 * 3600000); await s.events.subscribe(principal, p); await s.events.flush(); }
    assert.equal(s.deliveries.filter(x => !x.payload.type).length, 1);
    const status = s.events.status(s.users[0]);
    assert.equal(status.subscriptions[0].lastDelivery.status, 'delivered');
    assert.equal(status.subscriptions[0].lastDelivery.httpStatus, 200);
    request.status = 'done'; await s.events.flush();
    assert.deepEqual(s.events.status(s.users[0]).subscriptions[0].deliveries, {});
  } finally { await s.close(); }
});

function modern(srv, method, params = {}, { token = srv.tokens.a, headers = {}, version = '2026-07-28' } = {}) {
  return fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), 'X-OpenAI-Session': 'events-test-task', 'X-OpenAI-Subject': 'events-test-user', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: 'events-test' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
}

test('실제 HTTP MCP 2.0 발견·이벤트 스키마·헤더 검증 및 기존 업무 도구 재사용', { timeout: 30000 }, async () => {
  const srv = await startServer({ config: { publicUrl: 'https://cowork.example' } });
  try {
    const discovery = await (await modern(srv, 'server/discover')).json();
    assert.equal(discovery.result.resultType, 'complete'); assert.ok(discovery.result.capabilities.events); assert.ok(discovery.result.supportedVersions.includes('2025-11-25'));
    const definitions = await (await modern(srv, 'events/list')).json(); assert.equal(definitions.result.events[0].name, EVENT_NAME);
    assert.equal((await modern(srv, 'tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } })).status, 400);
    const unknown = await (await modern(srv, 'events/list', {}, { version: '1900-01-01' })).json(); assert.equal(unknown.error.code, -32022);
    assert.equal((await modern(srv, 'events/list', {}, { token: 'bad-token' })).status, 401);
    assert.equal((await modern(srv, 'events/list', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const listing = await (await modern(srv, 'tools/list')).json(); assert.ok(listing.result.tools.some(t => t.name === 'start_request'));
    const doc = await uploadDoc(srv.base, srv.tokens.a, hwpxFixture('tool_memo_tracked.hwpx'));
    const request = (await srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const invoke = async (name, args) => (await (await modern(srv, 'tools/call', { name, arguments: args })).json()).result;
    const target = { doc_id: doc.id, request_id: request.rid };
    assert.ok(!((await invoke('start_request', target)).isError));
    const paragraphs = await srv.api('a')(`/api/docs/${doc.id}/paragraphs`); const original = paragraphs.find(p => p.ref === 's0/p0').text;
    assert.ok(!(await invoke('propose_changes', { ...target, proposals: [{ ref: 's0/p0', find: original, replace: `${original} events` }] })).isError);
    assert.ok(!(await invoke('complete_request', { ...target, summary: 'MCP 2.0 처리 확인' })).isError);
    const invalid = await (await modern(srv, 'events/subscribe', params(secret(), { delivery: { mode: 'webhook', url: 'https://127.0.0.1/cb', secret: secret() } }))).json(); assert.equal(invalid.error.code, -32602);
    assert.equal((await srv.api('a')('/api/events/status')).activeSubscriptions, 0);
  } finally { await srv.stop(); }
});
