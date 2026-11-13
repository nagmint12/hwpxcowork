// 개인 에이전트 등록·푸시(docs/V3_SPEC.md §2.1). 사람마다 자기 에이전트(Claude Code + 채널 브리지)가 SSE 로 붙어 있고,
// 서버는 그 사람이 맡긴 AI 작업을 '가장 최근에 붙은 채널 세션 하나'에만 알린다(알림에는 지시 원문을 싣지 않는다 —
// 에이전트가 get_request 로 읽는다).
//   const reg = new AgentRegistry({ hub, leaseMs });
//   const h = reg.connect(user, { session, agent, client, channel }, res);   // SSE 응답(res)을 잡아 둔다
//   reg.push('홍길동', 'ai_request', { … }) → 보낸 세션 수(0|1)
//   reg.disconnect(h)                                                       // 응답이 닫히면 경로(routes/agents.js)가 부른다
// 접속 알림: 채널 세션이 붙을 때마다 모든 문서 방에 { type:'agent', action:'online', user, agent },
//   그 사람의 채널 세션이 하나도 안 남으면 'offline'. 'presence' 메시지의 agents 는 presenceList()(Hub 가 부른다).
// 채널이 아닌 세션(channel 없음)은 목록에만 보이고 online·푸시에는 치지 않는다.

let seq = 0;
const nowIso = () => new Date().toISOString();

/** SSE 한 건: event 이름 + data JSON 한 줄(JSON.stringify 는 줄바꿈을 \n 으로 바꾸므로 data 줄이 나뉘지 않는다) */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}

export class AgentRegistry {
  constructor({ hub = null, leaseMs = 15 * 60000, maxPerUser = 16 } = {}) {
    this.hub = hub;
    this.leaseMs = leaseMs;        // 요청 선점 lease(서비스와 같은 값, 참고용)
    this.maxPerUser = maxPerUser;  // 한 사람이 동시에 붙일 수 있는 연결 수(넘으면 가장 오래된 연결을 닫는다)
    this.byUser = new Map();       // 사용자 이름 → Set<handle>
  }

  /**
   * SSE 연결 하나를 등록한다. 같은 사용자의 같은 세션이 이미 있으면(브리지 재연결) 옛 연결은 닫는다 — 알림이 두 번 가지 않게.
   * → handle { id, user, session, agent, client, channel, since, lastSeen, res, closed }
   */
  connect(user, { session, agent, client, channel } = {}, res) {
    const name = typeof user === 'string' ? user : user?.name;
    if (!name) throw new Error('AgentRegistry.connect: 사용자가 필요합니다');
    const at = nowIso();
    const h = {
      id: ++seq, user: name, session: String(session || `${name}|${agent || ''}`), agent: agent || 'AI', client: client || '',
      channel: !!channel, since: at, lastSeen: at, res, closed: false,
    };
    let set = this.byUser.get(name);
    if (!set) { set = new Set(); this.byUser.set(name, set); }
    let droppedChannel = false;
    for (const old of [...set]) if (old.session === h.session) { droppedChannel ||= old.channel; this._drop(old, { end: true }); }
    set = this.byUser.get(name);
    if (!set) { set = new Set(); this.byUser.set(name, set); }
    set.add(h);
    // 연결이 너무 많으면(재연결 고리 등) 가장 오래된 것부터 닫는다
    for (const old of [...set].sort((a, b) => a.id - b.id)) {
      if (set.size <= this.maxPerUser) break;
      if (old === h) continue;
      droppedChannel ||= old.channel; this._drop(old, { end: true });
    }
    if (h.channel) this._announce('online', h);
    else if (droppedChannel && !this.online(name)) this._announce('offline', h);
    return h;
  }

  /** 연결을 지운다(여러 번 불러도 된다). 그 사람의 채널 세션이 모두 끊기면 'offline' 을 알린다 */
  disconnect(h) {
    if (!h || h.closed) return;
    this._drop(h);
    if (h.channel && !this.online(h.user)) this._announce('offline', h);
  }

  /** 채널 세션이 하나라도 붙어 있으면 true */
  online(userName) {
    for (const h of this.byUser.get(userName) || []) if (h.channel && this._alive(h)) return true;
    return false;
  }

  /** 그 사람의 세션들(붙은 순) — 응답 객체는 빼고 */
  sessions(userName) {
    return this._handles(userName).sort((a, b) => a.id - b.id)
      .map((h) => ({ session: h.session, agent: h.agent, client: h.client, channel: h.channel, since: h.since, lastSeen: h.lastSeen }));
  }

  /** 붙어 있는 사람별 에이전트 → [{ user, agents: [{ agent, channel, since }] }](세션 id 는 싣지 않는다) */
  list() {
    const out = [];
    for (const name of [...this.byUser.keys()].sort()) {
      const hs = this._handles(name).sort((a, b) => a.id - b.id);
      if (hs.length) out.push({ user: name, agents: hs.map((h) => ({ agent: h.agent, channel: h.channel, since: h.since })) });
    }
    return out;
  }

  /** 'presence' 메시지용: 채널 에이전트가 붙은 사람 [{ user, agent }](같은 사람·같은 이름은 하나) */
  presenceList() {
    const out = []; const seen = new Set();
    for (const name of [...this.byUser.keys()].sort()) {
      for (const h of this._handles(name).sort((a, b) => a.id - b.id)) {
        if (!h.channel) continue;
        const k = `${name}\u0000${h.agent}`; if (seen.has(k)) continue;
        seen.add(k); out.push({ user: name, agent: h.agent });
      }
    }
    return out;
  }

  /** 지금 푸시를 받을 세션(가장 최근 채널 세션) 정보 또는 null */
  primary(userName) {
    const h = this._channels(userName)[0];
    return h ? { session: h.session, agent: h.agent, client: h.client, since: h.since } : null;
  }

  /** 보낸 세션 수(0|1): 가장 최근 채널 세션 1개에만 보낸다(opts.prefer = 먼저 고를 세션 id) */
  push(userName, event, data, opts) {
    return this.deliver(userName, event, data, opts) ? 1 : 0;
  }

  /** 지휘자가 배정한 작업은 지정한 채널에만 알린다(다른 AI 세션으로 대체 전송하지 않음). */
  sendSession(userName, session, event, data) {
    const handle = this._handles(userName).find(item => item.channel && item.session === session);
    return handle ? this.send(handle, event, data) : false;
  }

  /**
   * push 와 같고 받은 세션을 돌려준다 → { session, agent, client } | null.
   * 고른 세션에 쓰지 못하면(이미 끊김) 그 연결을 정리하고 다음 최근 세션에 보낸다.
   */
  deliver(userName, event, data, { prefer = null } = {}) {
    const list = this._channels(userName);
    if (prefer) list.sort((a, b) => (b.session === prefer) - (a.session === prefer));   // 안정 정렬: 같은 무리 안에서는 최근 순 그대로
    for (const h of list) if (this.send(h, event, data)) return { session: h.session, agent: h.agent, client: h.client };
    return null;
  }

  /** 한 연결에 SSE 이벤트 하나. 못 쓰면(끊긴 연결) 정리하고 false */
  send(h, event, data) { return this._write(h, sseFrame(event, data)); }

  /** 한 연결에 SSE 주석 줄(': ping') — 프록시·브라우저가 연결을 끊지 않게 */
  comment(h, text = 'ping') { return this._write(h, `: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`); }

  /** 모든 연결을 닫는다(서버 끝낼 때·시험) */
  closeAll() {
    for (const set of [...this.byUser.values()]) for (const h of [...set]) { this._drop(h, { end: true }); }
  }

  // ── 내부 ──

  _alive(h) { return !!h && !h.closed && !!h.res && !h.res.destroyed && !h.res.writableEnded; }

  /** 살아 있는 연결들(죽은 것은 이 김에 정리) */
  _handles(userName) {
    const out = [];
    for (const h of [...(this.byUser.get(userName) || [])]) { if (this._alive(h)) out.push(h); else this.disconnect(h); }
    return out;
  }

  /** 살아 있는 채널 연결, 최근에 붙은 것부터 */
  _channels(userName) { return this._handles(userName).filter((h) => h.channel).sort((a, b) => b.id - a.id); }

  _write(h, chunk) {
    if (!this._alive(h)) { this.disconnect(h); return false; }
    try {
      h.res.write(chunk);
      h.lastSeen = nowIso();
      return true;
    } catch {
      this.disconnect(h);
      return false;
    }
  }

  _drop(h, { end = false } = {}) {
    if (h.closed) return;
    h.closed = true;
    const set = this.byUser.get(h.user);
    if (set) { set.delete(h); if (!set.size) this.byUser.delete(h.user); }
    if (end) { try { if (!h.res.writableEnded) h.res.end(); } catch { /* 이미 닫힘 */ } }
  }

  _announce(action, h) {
    try { this.hub?.broadcastAll?.({ type: 'agent', action, user: h.user, agent: h.agent }); } catch (e) { console.error('[agents] 접속 알림 실패:', e.message); }
  }
}
