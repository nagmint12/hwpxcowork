import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { isLeanRequest } from './lean.js';
import { createMcpServer, agentFromRequest } from './mcp.js';
import { mcpSurface, v2Toolset } from './mcp2.js';
import { userByToken, tokenFromRequest } from './config.js';
import { localPeer, pipeHeader } from './desktop-pipe.js';

export function desktopService({ session, cfg, service, version, trackOperation, isDraining }) {
  const streams = new Set();
  const rooms = new Set();
  function authorize(req) {
    const trusted = req.headers.host === 'localhost' && req.headers[pipeHeader] === session.key;
    delete req.headers[pipeHeader];
    if (trusted) req.socket[localPeer] = true;
    return trusted;
  }
  function upgrade(req, socket, head) {
    const token = tokenFromRequest(req);
    const user = userByToken(cfg, token);
    if (!user || req.headers.upgrade !== 'hwpx-stdio') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const { name, role } = user;
    const wire = new StdioServerTransport(socket, socket);
    // HTTP chooses the default tool surface from initialize.clientInfo. Wait for
    // the same first frame before attaching this already-started stdio stream.
    let server;
    wire.onmessage = first => {
      if (!isInitializeRequest(first)) { socket.destroy(); return; }
      socket.setTimeout(0);
      server = createMcpServer({ service, user, version, agentSession: randomUUID(), agentName: agentFromRequest(req),
        surface: mcpSurface(req, { config: cfg, clientName: first.params?.clientInfo?.name }), toolset: v2Toolset(req), lean: isLeanRequest(req),
        trackOperation: fn => {
          const current = userByToken(cfg, token);
          if (!current || current.name !== name || current.role !== role) throw Error('개인 연결을 다시 인증해 주세요.');
          if (isDraining()) throw Error('앱이 저장을 마치고 있습니다.');
          return trackOperation(fn);
        },
      });
      const attached = {
        async start() { wire.onmessage = this.onmessage; wire.onclose = this.onclose; wire.onerror = this.onerror; this.onmessage(first); },
        send: message => wire.send(message), close: () => wire.close(),
      };
      void server.connect(attached).catch(() => socket.destroy());
    };
    streams.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    socket.once('close', () => { streams.delete(socket); void (server ? server.close() : wire.close()).catch(() => {}); });
    socket.once('end', () => socket.end());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: hwpx-stdio\r\n\r\n');
    if (head.length) socket.unshift(head);
    void wire.start().catch(() => socket.destroy());
  }
  // The editor only receives room events. Feed its EventSource from the same
  // authenticated Hub room as a browser WebSocket, including presence and AI events.
  function events(req, res) {
    const user = userByToken(cfg, req.query.token);
    const docId = req.query.doc;
    let meta;
    try { meta = service.store.readMeta(docId); } catch { /* invalid or missing */ }
    if (!user || !meta || !service.canRead(user, meta)) return res.sendStatus(403);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    const room = new EventEmitter();
    room.readyState = 1;
    room.send = (data, callback) => res.write('data: ' + data + '\n\n', callback);
    room.terminate = () => res.end();
    rooms.add(room);
    res.once('close', () => { room.readyState = 3; rooms.delete(room); room.emit('close'); });
    service.hub.attach(room, { docId, user });
  }
  return { authorize, upgrade, events, close() {
    for (const socket of streams) socket.destroy();
    for (const room of rooms) room.terminate();
  } };
}
