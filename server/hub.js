// WebSocket 허브: 문서별 방(room) 에 알림을 뿌리고 접속자(presence)를 알린다.
// 개인 에이전트(docs/V3_SPEC.md §2.1): agents(AgentRegistry, routes/agents.js 가 넣는다)가 있으면
//   presence 메시지에 agents: [{ user, agent }](채널 에이전트가 붙은 사람 — 문서와 상관없이 전체)를 싣고,
//   에이전트가 붙고 끊길 때는 broadcastAll 로 모든 방에 { type:'agent', action:'online'|'offline', user, agent } 를 보낸다.
import { WebSocketServer } from 'ws';

export class Hub {
  constructor({ onConnectionError = () => {} } = {}) {
    this.onConnectionError = onConnectionError;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss.on('error', error => { try { this.onConnectionError(error); } catch {} });
    this.rooms = new Map(); // docId -> Set<ws>
    this.agents = null;     // AgentRegistry(server/agents.js) 또는 null
    this.observers = new Set();
  }

  onEvent(listener) { this.observers.add(listener); return () => this.observers.delete(listener); }

  attach(ws, { docId, user }) {
    // A protocol/transport error belongs to this connection, not the server.
    ws.on('error', error => { try { this.onConnectionError(error); } catch {} ws.terminate(); });
    ws.docId = docId; ws.user = user;
    if (!this.rooms.has(docId)) this.rooms.set(docId, new Set());
    this.rooms.get(docId).add(ws);
    ws.on('close', () => {
      const room = this.rooms.get(docId);
      if (room) { room.delete(ws); if (!room.size) this.rooms.delete(docId); }
      this.presence(docId);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'cursor') this.broadcast(docId, { type: 'cursor', user: user.name, ref: msg.ref }, ws);
      } catch { /* ignore */ }
    });
    this.send(ws, JSON.stringify({ type: 'hello', user: user.name, docId }));
    this.presence(docId);
  }

  presence(docId) {
    const users = [...(this.rooms.get(docId) || [])].map((w) => w.user.name);
    this.broadcast(docId, { type: 'presence', users: [...new Set(users)], agents: this.agentList() });
  }

  /** 접속 알림용 에이전트 목록 [{ user, agent }](채널 세션만). 등록부가 없으면 [] */
  agentList() {
    try { return this.agents?.presenceList?.() || []; } catch { return []; }
  }

  send(ws, data) {
    if (ws.readyState !== 1) return;
    try { ws.send(data, error => { if (error) ws.terminate(); }); } catch { ws.terminate(); }
  }

  broadcast(docId, msg, except) {
    for (const listener of this.observers) { try { listener(docId, msg); } catch { /* 문서 저장/웹 전송과 분리한다. */ } }
    const s = JSON.stringify({ at: new Date().toISOString(), ...msg });
    for (const ws of this.rooms.get(docId) || []) if (ws !== except) this.send(ws, s);
  }

  /** 모든 문서 방에 보낸다(에이전트 접속 알림처럼 문서와 상관없는 알림) */
  broadcastAll(msg) {
    const s = JSON.stringify({ at: new Date().toISOString(), ...msg });
    for (const room of this.rooms.values()) for (const ws of room) this.send(ws, s);
  }
}
