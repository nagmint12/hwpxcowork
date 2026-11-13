// ChatGPT Work MCP Events: 인증된 사용자별 웹훅 구독 + 디스크 outbox.
// 알림에는 문서/요청 ID만 담는다. 실제 작업은 기존 MCP 도구가 권한·선점을 검사한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { writeFileAtomic } from './store.js';
import { callbackUrl, webhookFetch as secureWebhookFetch } from './webhook-http.js';

export const EVENT_NAME = 'ai_request.created';
export const TUTORIAL_EVENT_NAME = 'tutorial.ai_request.created';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const err = (code, message, data) => Object.assign(new Error(message), { code, data });
const ownerOf = user => hash(JSON.stringify([user.name, user.token]));
const iso = ms => new Date(ms).toISOString();
const timingSafe = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const RETRIES_MS = [1000, 5000, 30000, 120000, 600000];
const DAY = 86400000;
const jobTime = job => Math.max(job.lastAttemptAt || 0, job.finishedAt || 0, Date.parse(job.event.timestamp) || 0);
export const EVENT_DEFINITION = {
  name: EVENT_NAME,
  description: '내가 HWPX 웹에서 대기열로 보낸 새 AI 요청 또는 다시 요청한 작업. 자동 처리는 이 이벤트를 구독한다. 도착하면 get_request → start_request → 첨부는 get_attachment_file → Work 자체 도구로 처리 → 결과 파일은 save_result_file 또는 제안/의견 → complete_request. 본문 반영은 사람이 결정한다. 본인 요청만 전달된다.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { document_id: { type: 'string', description: '이 문서의 내 요청만 감시. 생략하면 모든 문서의 내 요청.' } }, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { document_id: { type: 'string' }, request_id: { type: 'integer' }, attempt: { type: 'integer' }, kind: { type: 'string' }, url: { type: 'string' } }, required: ['document_id', 'request_id', 'attempt', 'kind', 'url'], additionalProperties: false },
};
export const TUTORIAL_EVENT_DEFINITION = {
  ...EVENT_DEFINITION, name: TUTORIAL_EVENT_NAME,
  description: '관리자 공유 ChatGPT가 처리할 사용자들의 튜토리얼 AI 요청. 일반 문서·준비된 예시·튜토리얼 6은 제외한다. get_request → start_request → 제안/의견 → complete_request 순서로 처리하고 본문 반영은 사람이 결정한다.',
};

export function createMcpEvents({ config, service, hub, oauth, now = () => Date.now(), webhookFetch = secureWebhookFetch, autoStart = true, log = message => console.error(message) }) {
  const file = path.join(config.dataDir, 'mcp-events.json');
  let state; let timer; let kickTimer; let worker; let closed = false;
  const locks = new Map(); const verified = new Map(); const inFlight = new Set();
  function enabled() {
    try { return config.events?.enabled !== false && new URL(config.publicUrl).protocol === 'https:'; } catch { return false; }
  }
  function data() {
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('MCP event storage unavailable'); state = { version: 1, subscriptions: {}, outbox: {} }; }
      if (state.version !== 1 || !object(state.subscriptions) || !object(state.outbox)) throw new Error('Invalid MCP event storage');
    }
    return state;
  }
  function save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(data()));
    fs.chmodSync(file, 0o600);
  }
  function userFor(owner) { return config.users.find(user => user.token && ownerOf(user) === owner); }
  function validSubscription(sub) {
    return !!(sub && enabled() && sub.active && sub.expiresAt > now() && userFor(sub.owner) && (sub.name !== TUTORIAL_EVENT_NAME || service.tutorialChatGPTUser?.(userFor(sub.owner))) && sub.issuer === config.publicUrl.replace(/\/$/, '') && (!sub.grantId || oauth?.isEventGrantActive(sub.grantId)));
  }
  // 만료·해제된 구독은 활성 한도를 차지하지 않는다. 진단 기록은 30일 보존하되
  // 아직 전달 가능한 요청의 완료 기록은 중복 발송을 막기 위해 유지한다.
  function maintainState() {
    let dirty = false; const inactive = new Set();
    for (const sub of Object.values(data().subscriptions)) {
      if (!validSubscription(sub)) {
        inactive.add(sub.id);
        if (sub.inactiveAt == null) { sub.inactiveAt = Math.min(now(), sub.stoppedAt || sub.expiresAt || now()); dirty = true; }
        if (sub.inactiveAt < now() - 30 * DAY && !locks.has(sub.id)) { delete data().subscriptions[sub.id]; dirty = true; }
      } else if (sub.inactiveAt != null) { delete sub.inactiveAt; dirty = true; }
      if (sub.oldSecret && sub.rotationUntil <= now()) { delete sub.oldSecret; delete sub.rotationUntil; dirty = true; }
    }
    for (const [id, job] of Object.entries(data().outbox)) {
      if (inactive.has(job.subscriptionId) && job.status === 'pending') { job.status = 'cancelled'; job.finishedAt = now(); dirty = true; }
      if (job.status === 'pending' || (job.finishedAt || Date.parse(job.event.timestamp)) >= now() - 30 * DAY) continue;
      const sub = data().subscriptions[job.subscriptionId];
      if (validSubscription(sub) && stillAvailable(job.event, sub)) continue;
      delete data().outbox[id]; dirty = true;
    }
    if (dirty) save();
  }
  function assertCapacity(input) {
    if (validSubscription(data().subscriptions[input.id])) return;
    const active = Object.values(data().subscriptions).filter(validSubscription);
    if (active.length >= 2000 || active.filter(sub => sub.owner === input.owner).length >= 64) throw err(-32602, 'Subscription limit reached');
  }
  function validate(principal, params, { unsubscribe = false } = {}) {
    if (!enabled()) throw err(-32026, 'MCP Events requires a public HTTPS URL', { feature: 'events' });
    if (!principal?.user?.token) throw err(-32024, 'Authenticated account required');
    if (!object(params) || ![EVENT_NAME, TUTORIAL_EVENT_NAME].includes(params.name)) throw err(-32023, 'Unknown event', { kind: 'event' });
    if (params.name === TUTORIAL_EVENT_NAME && !service.tutorialChatGPTUser?.(principal.user) && !unsubscribe) throw err(-32024, 'Shared tutorial event requires a configured administrator');
    const args = params.arguments ?? {};
    if (!object(args) || Object.keys(args).some(key => key !== 'document_id') || (args.document_id != null && (typeof args.document_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.document_id)))) throw err(-32602, 'Invalid event arguments');
    const filters = args.document_id ? { document_id: args.document_id } : {};
    if (filters.document_id && !unsubscribe) {
      try { service.docAccess(filters.document_id, principal.user); } catch { throw err(-32024, 'Document access denied'); }
    }
    const delivery = params.delivery;
    if (!object(delivery) || delivery.mode !== 'webhook') throw err(-32602, 'Only webhook delivery is supported');
    let url;
    try { url = callbackUrl(delivery.url).href; } catch { throw err(-32602, 'A public HTTPS callback URL is required'); }
    if (!unsubscribe) {
      const secret = delivery.secret;
      if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/_-]+={0,2}$/.test(secret)) throw err(-32602, 'Invalid webhook signing secret');
      const bytes = Buffer.from(secret.slice(6), 'base64');
      if (bytes.length < 24 || bytes.length > 64) throw err(-32602, 'Webhook signing key must contain 24–64 bytes');
      if (params.cursor != null) throw err(-32602, 'This event does not support replay; cursor must be null');
      if (params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)) throw err(-32602, 'ttlMs must be a positive integer or null');
    }
    const owner = ownerOf(principal.user);
    const id = `sub_${hash(JSON.stringify([owner, url, params.name, filters])).slice(0, 40)}`;
    return { owner, id, filters, url, secret: delivery.secret, name: params.name };
  }
  async function signedPost(sub, payload, eventId) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 256 * 1024) throw Object.assign(new Error('Payload too large'), { reason: 'payload_too_large' });
    const at = new Date(now()); const signer = new Webhook(sub.secret);
    let signature = signer.sign(eventId, at, body);
    if (sub.oldSecret && sub.rotationUntil > now()) signature += ` ${new Webhook(sub.oldSecret).sign(eventId, at, body)}`;
    return webhookFetch(sub.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(at.getTime() / 1000)), 'webhook-signature': signature, 'X-MCP-Subscription-Id': sub.id }, body });
  }
  async function verify(sub) {
    const cacheKey = hash(JSON.stringify([sub.owner, sub.url, sub.secret]));
    if (verified.get(cacheKey) > now()) return;
    const challenge = crypto.randomBytes(32).toString('base64url');
    try {
      const response = await signedPost(sub, { type: 'verification', challenge }, `msg_verification_${crypto.randomUUID()}`);
      let reply; try { reply = JSON.parse(response.body); } catch {}
      if (!response.ok || typeof reply?.challenge !== 'string' || !timingSafe(reply.challenge, challenge)) throw err(-32015, 'Callback verification failed', { reason: 'challenge_failed' });
      verified.set(cacheKey, now() + 5 * 60000);
      if (verified.size > 2000) for (const [key, expires] of verified) if (expires <= now()) verified.delete(key);
    } catch (e) {
      if (e.code === -32015) throw e;
      throw err(-32015, 'Callback verification failed', { reason: e.reason === 'unsafe_destination' ? 'unsafe_destination' : /timeout|abort/i.test(e.name + e.message) ? 'timeout' : 'connection_failed' });
    }
  }
  function lock(id, fn) {
    const before = locks.get(id) || Promise.resolve();
    const task = before.catch(() => {}).then(fn); locks.set(id, task);
    task.finally(() => { if (locks.get(id) === task) locks.delete(id); }).catch(() => {});
    return task;
  }
  async function subscribe(principal, params) {
    const input = validate(principal, params);
    return lock(input.id, async () => {
      maintainState();
      const current = data().subscriptions[input.id];
      assertCapacity(input);
      const ttl = params.ttlMs == null ? DAY : Math.max(60000, Math.min(params.ttlMs, DAY));
      const sub = { ...input, active: true, issuer: config.publicUrl.replace(/\/$/, ''), grantId: principal.grantId || null, createdAt: validSubscription(current) ? current.createdAt : now(), expiresAt: Math.min(now() + ttl, principal.grantExpiresAt || Infinity) };
      if (current?.secret && current.secret !== sub.secret) { sub.oldSecret = current.secret; sub.rotationUntil = now() + 5 * 60000; }
      else if (current?.rotationUntil > now()) { sub.oldSecret = current.oldSecret; sub.rotationUntil = current.rotationUntil; }
      await verify(sub);
      // 연결 해제/사용자 토큰 변경과 비동기 callback 검증이 경합해도 구독을 새로 살리지 않는다.
      if (!userFor(sub.owner) || (sub.grantId && !oauth?.isEventGrantActive(sub.grantId))) throw err(-32024, 'Account connection was revoked');
      // 서로 다른 callback의 동시 검증이 활성 한도를 넘지 않도록 저장 직전 다시 센다.
      assertCapacity(input);
      data().subscriptions[sub.id] = sub; save(); kick();
      return { id: sub.id, refreshBefore: iso(sub.expiresAt), cursor: null, truncated: false };
    });
  }
  async function unsubscribe(principal, params) {
    const input = validate(principal, params, { unsubscribe: true });
    return lock(input.id, async () => {
      const sub = data().subscriptions[input.id];
      if (sub && sub.owner === input.owner) { sub.active = false; sub.stoppedAt = now(); for (const job of Object.values(data().outbox)) if (job.subscriptionId === sub.id && job.status === 'pending') job.status = 'cancelled'; save(); }
      return {};
    });
  }
  function occurrences() {
    const list = [];
    const metas = new Map([...service.store.list(), ...(service.store.listSessions?.() || [])].map(m => [m.id, m]));
    for (const meta of metas.values()) for (const request of meta.requests || []) {
      if (request.status !== 'pending' || request.route !== 'queue' || request.example) continue;
      const attempt = service._attempt(request);
      const retried = [...(request.log || [])].reverse().find(item => item.action === 'retry');
      const at = Date.parse(retried?.at || request.at);
      if (!Number.isFinite(at)) continue;
      const eventId = `evt_${hash(JSON.stringify([meta.id, request.rid, attempt])).slice(0, 40)}`;
      list.push({ meta, request, ownerName: request.by, at, event: { eventId, name: EVENT_NAME, timestamp: iso(at), data: { document_id: meta.id, request_id: request.rid, attempt, kind: request.kind, url: `${config.publicUrl.replace(/\/$/, '')}/#/doc/${encodeURIComponent(meta.id)}` }, cursor: null } });
    }
    return list;
  }
  function matches(sub, meta, r) {
    const user = userFor(sub.owner);
    if (sub.name === TUTORIAL_EVENT_NAME) return meta.tutorial === true && meta.tutorialSession === true && service._tutorialChatGPTTakes?.(user, { ...r, tutorialSession: true });
    return !meta.tutorialSession && r.by === user?.name;
  }
  function stillAvailable(event, sub) {
    try {
      const meta = service.store.readMeta(event.data.document_id);
      const r = meta.requests.find(item => item.rid === event.data.request_id);
      return r && !r.example && matches(sub, meta, r) && Date.parse(event.timestamp) >= sub.createdAt && r.status === 'pending' && r.route === 'queue' && service._attempt(r) === event.data.attempt;
    } catch { return false; }
  }
  function enqueue() {
    maintainState();
    let dirty = false; const subs = Object.values(data().subscriptions);
    if (!subs.some(validSubscription)) return;
    for (const item of occurrences()) for (const sub of subs) {
      if (!validSubscription(sub) || !matches(sub, item.meta, item.request) || item.at < sub.createdAt || (sub.filters.document_id && sub.filters.document_id !== item.event.data.document_id)) continue;
      const id = `${sub.id}:${item.event.eventId}`;
      if (data().outbox[id]) continue;
      data().outbox[id] = { id, subscriptionId: sub.id, event: { ...item.event, name: sub.name || EVENT_NAME }, status: 'pending', tries: 0, nextAt: now() }; dirty = true;
    }
    if (dirty) save();
  }
  async function deliver(job) {
    const sub = data().subscriptions[job.subscriptionId];
    if (!sub || !validSubscription(sub) || !stillAvailable(job.event, sub)) { job.status = 'cancelled'; job.finishedAt = now(); save(); return; }
    job.tries++; job.lastAttemptAt = now(); save();
    let response; let reason;
    try { response = await signedPost(sub, job.event, job.event.eventId); } catch (e) { reason = e.reason || 'connection_failed'; }
    // unsubscribe 중이거나 OAuth를 해제했으면 남은 응답으로 다시 활성화하지 않는다.
    if (!validSubscription(sub) || job.status !== 'pending') return;
    if (response?.ok) { job.status = 'delivered'; job.finishedAt = now(); job.httpStatus = response.status; delete job.reason; }
    else {
      job.httpStatus = response?.status || null; job.reason = reason || `http_${response?.status}`;
      const transient = !response || [408, 425, 429].includes(response.status) || response.status >= 500;
      if (response?.status === 410) sub.active = false;
      if (!transient || job.tries >= RETRIES_MS.length + 1 || reason === 'unsafe_destination') { job.status = 'failed'; job.finishedAt = now(); }
      else job.nextAt = now() + RETRIES_MS[job.tries - 1];
    }
    save();
    hub?.broadcast?.(job.event.data.document_id, { type: 'request', action: 'event-delivery', rid: job.event.data.request_id });
  }
  async function drain() {
    if (closed || !enabled()) return;
    enqueue();
    // 서로 다른 사용자/채팅 알림을 하나의 느린 callback이 막지 않게 제한된 동시 전송.
    const jobs = Object.values(data().outbox).filter(job => job.status === 'pending' && job.nextAt <= now()).slice(0, 16);
    await Promise.all(jobs.map(async job => {
      if (inFlight.has(job.id)) return;
      inFlight.add(job.id); try { await deliver(job); } finally { inFlight.delete(job.id); }
    }));
  }
  function kick() {
    if (closed || kickTimer) return;
    kickTimer = setTimeout(() => { kickTimer = null; void flush().catch(() => log('[mcp-events] 전송 상태를 확인하지 못했습니다. 데이터 저장소를 확인하세요.')); }, 0);
    kickTimer.unref?.();
  }
  async function flush() {
    if (worker) return worker;
    worker = drain();
    try { await worker; } finally { worker = null; }
  }
  const unlisten = hub?.onEvent?.((_docId, message) => { if (message.type === 'request' && ['add', 'requeued'].includes(message.action)) kick(); });
  if (autoStart) { timer = setInterval(kick, 1000); timer.unref?.(); kick(); }
  return {
    enabled,
    list(user) { if (!enabled()) throw err(-32026, 'MCP Events is disabled', { feature: 'events' }); return { events: [EVENT_DEFINITION, ...(service.tutorialChatGPTUser?.(user) ? [TUTORIAL_EVENT_DEFINITION] : [])] }; },
    hasTutorialSubscriber() { return Object.values(data().subscriptions).some(sub => sub.name === TUTORIAL_EVENT_NAME && !sub.filters.document_id && validSubscription(sub)); },
    tutorialRequestStatus(docId, rid, attempt) {
      const subs = Object.values(data().subscriptions).filter(sub => sub.name === TUTORIAL_EVENT_NAME && validSubscription(sub) && (!sub.filters.document_id || sub.filters.document_id === docId));
      const jobs = Object.values(data().outbox).filter(job => subs.some(sub => sub.id === job.subscriptionId) && job.event.data.document_id === docId && job.event.data.request_id === rid && job.event.data.attempt === attempt);
      const delivered = jobs.find(job => job.status === 'delivered');
      return { method: 'mcp-events', state: !subs.length ? 'needs_subscription' : delivered ? 'delivered' : jobs.length && jobs.every(job => job.status === 'failed') ? 'failed' : 'sending', ...(delivered ? { deliveredAt: iso(delivered.finishedAt) } : {}) };
    },
    subscribe, unsubscribe, flush,
    status(user) {
      const subs = Object.values(data().subscriptions).filter(sub => sub.owner === ownerOf(user));
      return { enabled: enabled(), event: EVENT_NAME, protocolVersion: '2026-07-28', activeSubscriptions: subs.filter(validSubscription).length,
        subscriptions: subs.map(sub => {
          const jobs = Object.values(data().outbox).filter(job => job.subscriptionId === sub.id);
          const last = jobs.reduce((latest, job) => !latest || jobTime(job) >= jobTime(latest) ? job : latest, null);
          return { id: sub.id, name: sub.name || EVENT_NAME, active: validSubscription(sub), documentId: sub.filters.document_id || null, refreshBefore: iso(sub.expiresAt),
            deliveries: jobs.reduce((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {}),
            lastDelivery: last ? { status: last.status, httpStatus: last.httpStatus || null, reason: last.reason || null, at: iso(jobTime(last)) } : null };
        }) };
    },
    async close() { closed = true; clearInterval(timer); clearTimeout(kickTimer); unlisten?.(); await worker?.catch(() => {}); },
  };
}
