import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLabGateway, createLabInstructionStore } from './gateway.mjs';

// A separate loopback-only listener. It does not mount or modify the live server.
export async function startLabHttp(runtime, { profile = 'focused', port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 8787) throw new Error('Use an isolated port (0 is recommended; 8787 is forbidden).');
  const app = express(), sessions = new Map(), history = [];
  let initializing = 0;
  const store = runtime.instructionStore ||= createLabInstructionStore(runtime);
  app.disable('x-powered-by');
  let origin = '';
  app.use((req, res, next) => {
    if (req.headers.origin && req.headers.origin !== origin) return res.status(403).json({ error: 'ORIGIN' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ lab: true, production: false, model_api: false, profile }));
  app.use((req, res, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    req.user = runtime.config.users.find(u => u.token === token);
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
    next();
  });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const raw = express.raw({ type: () => true, limit: '50mb' });
  app.post('/lab/documents/import', raw, wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'HWPX_BYTES_REQUIRED' });
    res.json(await runtime.runExclusive(() => runtime.service.createDocument({
      fileName: '실험문서.hwpx', title: req.query.title || '실험 문서', bytes: req.body, user: req.user, location: { space: 'private' },
    })));
  }));
  app.use(express.json({ limit: '20mb' }));
  app.get('/lab/documents', wrap(async (req, res) => res.json(await runtime.runExclusive(() => runtime.service.listDocuments(req.user)))));
  app.get('/lab/documents/:id/file', wrap(async (req, res) => {
    const bytes = await runtime.runExclusive(() => { runtime.service.assertDocRead(req.params.id, req.user); return runtime.service.store.currentBytes(req.params.id); });
    res.type('application/octet-stream').attachment('mcp-lab-result.hwpx').send(bytes);
  }));
  app.post('/lab/documents/:id/requests', wrap(async (req, res) => {
    res.json(await runtime.runExclusive(() => {
      runtime.service.assertDocRead(req.params.id, req.user);
      return runtime.service.createRequest(req.params.id, { ...req.body, route: 'queue' }, req.user);
    }));
  }));
  // Trusted authenticated control surface, not a model-facing MCP tool.
  app.post('/lab/skills', wrap(async (req, res) => res.json(await runtime.runExclusive(() => store.registerClientSkill(req.user.name, req.body)))));
  app.post('/lab/guidance', wrap(async (req, res) => {
    res.json(await runtime.runExclusive(async () => {
      runtime.service.assertDocRead(req.body.doc_id, req.user);
      const meta = runtime.service.store.readMeta(req.body.doc_id);
      const request = meta.requests?.find(r => r.rid === req.body.request_id && r.by === req.user.name);
      if (!request) throw Object.assign(new Error('Only the request owner can select guidance.'), { code: 'NOT_OWNER', status: 403 });
      if (req.body.user_instruction !== request.instruction) throw Object.assign(new Error('Guidance must preserve the original request instruction.'), { code: 'INSTRUCTION_MISMATCH', status: 400 });
      return store.setTaskGuidance(req.user.name, req.body);
    }));
  }));
  app.get('/lab/metrics', (req, res) => res.json({ measurement: 'payload size; model tokens are unknown', sessions: history.filter(s => s.user === req.user.name).map(s => s.metrics.snapshot()) }));
  app.all('/mcp', wrap(async (req, res) => {
    const id = req.headers['mcp-session-id'];
    let entry = id ? sessions.get(id) : null;
    if (id && (!entry || entry.user !== req.user.name)) return res.status(404).json({ error: 'UNKNOWN_SESSION' });
    if (!entry) {
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) return res.status(400).json({ error: 'INITIALIZE_REQUIRED' });
      // This limit protects the test listener, not model task completeness.
      if (sessions.size + initializing >= 64) return res.status(429).json({ error: 'LAB_SESSION_CAPACITY' });
      initializing++;
      let gateway, sessionId;
      try {
        gateway = await createLabGateway({ runtime, user: req.user, profile, instructionStore: store });
        sessionId = crypto.randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true,
          onsessioninitialized: () => {
            sessions.set(sessionId, entry); history.push({ user: req.user.name, metrics: gateway.metrics });
            if (history.length > 128) history.shift();
          },
          onsessionclosed: () => { sessions.delete(sessionId); void gateway.close(); } });
        entry = { gateway, transport, user: req.user.name };
        await gateway.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        initializing--;
        if (!sessions.has(sessionId)) await gateway?.close();
      }
      return;
    }
    await entry.transport.handleRequest(req, res, req.body);
  }));
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: error.code || 'LAB_ERROR', message: error.message }));
  const http = await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
  origin = `http://127.0.0.1:${http.address().port}`;
  return { base: origin, sessions, async close() {
    await Promise.allSettled([...sessions.values()].map(s => s.gateway.close())); sessions.clear();
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  } };
}
