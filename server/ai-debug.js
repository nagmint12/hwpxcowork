// AI 수신 원문은 해석 전에 별도 파일로 보존한다. 공유 메모/HTTP 공개 폴더와 분리하며 자동 절단·회전하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Transform } from 'node:stream';

const scope = new AsyncLocalStorage();
const part = value => { const v = String(value ?? 'unassigned').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100); return !v || /^\.+$/.test(v) ? 'unassigned' : v; };
const implementation = Object.fromEntries(['ai.js', 'format-schema.js', 'api-tool-loop.js', 'mcp.js', 'service.js', 'crs.js',
  'document-edit.js', 'edit-workspace-service.js', 'edit-workflow-runner.js', 'tool-profiles.js', '../engine/doc.js'].map(file => {
  try { return [file, crypto.createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]; } catch { return [file, 'unavailable']; }
}));
export const aiDebugDirectory = () => path.resolve(process.env.HWPX_COWORK_DEBUG_DIR || 'logs/ai-debug');
export const currentAiDebug = () => scope.getStore();

export function debugError(error, seen = new Set()) {
  if (error == null || typeof error !== 'object') return error;
  if (seen.has(error)) return '[circular]';
  seen.add(error);
  return Object.fromEntries([...new Set([...Object.getOwnPropertyNames(error), 'name', 'message', 'code', 'stack', 'issues', 'cause'])]
    .filter(key => error[key] !== undefined).map(key => [key, jsonValue(error[key], seen)]));
}
function jsonValue(value, seen = new Set()) {
  if (value instanceof Error) return debugError(value, seen);
  if (typeof value === 'bigint') return String(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const out = Array.isArray(value) ? value.map(v => jsonValue(v, seen)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v, seen)]));
  seen.delete(value);
  return out;
}
const encode = value => Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value)
  : Buffer.from(typeof value === 'string' ? value : JSON.stringify(jsonValue(value)) ?? 'null', 'utf8');
const writeFailure = (cause, directory) => cause?.code === 'AI_DEBUG_WRITE_FAILED' ? cause
  : Object.assign(new Error('AI 원문 진단 기록을 저장하지 못해 처리를 중단했습니다. 저장 폴더·권한·디스크 공간을 확인하세요.', { cause }), { code: 'AI_DEBUG_WRITE_FAILED', debugDirectory: directory });

export function createAiDebug({ directory = aiDebugDirectory(), context = {}, state } = {}) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomUUID()}`;
  const folder = path.join(path.resolve(directory), part(context.docId), `r${part(context.requestId)}-a${part(context.attempt)}`, runId);
  let sequence = 0;
  const trace = {
    directory: folder, runId, context,
    run: fn => scope.run(trace, fn),
    record(kind, payload, details = {}) {
      try {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const n = ++sequence, file = `${String(n).padStart(6, '0')}-${part(kind)}.${Buffer.isBuffer(payload) || payload instanceof Uint8Array ? 'bin' : typeof payload === 'string' ? 'txt' : 'json'}`;
        const bytes = encode(payload);
        // wx + 실행 UUID: 같은 요청의 재시도·여러 프로세스가 이전 실패 증거를 덮어쓰지 않는다.
        const fd = fs.openSync(path.join(folder, file), 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        let snapshot;
        try { snapshot = state?.(); } catch (e) { snapshot = { unavailable: debugError(e) }; }
        const event = { at: new Date().toISOString(), runId, sequence: n, kind, context, file, bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...(n === 1 ? { implementation, node: process.version } : {}),
          ...details, ...(snapshot === undefined ? {} : { state: snapshot }) };
        const journal = fs.openSync(path.join(folder, 'events.jsonl'), 'a', 0o600);
        try { fs.writeFileSync(journal, JSON.stringify(jsonValue(event)) + '\n'); fs.fsyncSync(journal); } finally { fs.closeSync(journal); }
        return { runId, directory: folder, file, bytes: bytes.length, sha256: event.sha256 };
      } catch (cause) {
        throw writeFailure(cause, folder);
      }
    },
  };
  return trace;
}

export function debugRecord(kind, payload, details) { return scope.getStore()?.record(kind, payload, details); }

export async function withAiDebug(options, fn) {
  if (scope.getStore()) return fn();
  const trace = createAiDebug(options);
  return trace.run(async () => {
    trace.record('run.start', { node: process.version, platform: process.platform, implementation });
    try {
      const value = await fn();
      trace.record('run.end', value, { outcome: value?.failed ? 'failed' : value?.cancelled ? 'cancelled' : 'returned' });
      return value;
    } catch (error) {
      if (error.code !== 'AI_DEBUG_WRITE_FAILED') trace.record('run.error', debugError(error), { outcome: 'error' });
      error.debugRunId = trace.runId; error.debugDirectory = trace.directory;
      throw error;
    }
  });
}

// 해석 전 HTTP 본문을 바이트 단위로 저장한다. JSON 해석 실패·HTTP 오류 본문도 남긴다.
export async function debugHttpResponse(response, details = {}) {
  const trace = currentAiDebug();
  if (!trace) return;
  const chunks = [], wire = debugStream('http.response.wire', details);
  try {
    for await (const chunk of response.clone().body || []) { wire.write(chunk); chunks.push(Buffer.from(chunk)); }
  } catch (error) {
    wire.close({ complete: false, error: debugError(error) });
    trace.record('http.response', Buffer.concat(chunks), { ...details, status: response.status, complete: false, error: debugError(error) });
    throw error;
  }
  wire.close({ complete: true });
  trace.record('http.response', Buffer.concat(chunks), { ...details, status: response.status, complete: true,
    contentType: response.headers.get('content-type'), providerRequestId: response.headers.get('request-id') || response.headers.get('x-request-id') });
}

export function debugServiceState(service, args = {}) {
  const docId = args.doc_id ?? args.docId;
  if (!docId || !service?._meta) return null;
  const meta = service._meta(docId), rid = args.request_id ?? args.requestId;
  const r = meta.requests?.find(item => item.rid === rid);
  const cached = service.store?.cache?.get(docId);
  const refs = [...new Set([args.ref, args.after_ref, args.afterRef, ...(args.refs || []), ...(args.proposals || []).map(p => p.ref),
    r?.target?.ref, ...(r?.target?.refs || [])].filter(ref => typeof ref === 'string'))];
  const paragraphs = refs.map(ref => { try { return { ref, text: cached?.doc ? cached.doc.text(ref, 'final') : undefined, cached: !!cached?.doc }; }
    catch (error) { return { ref, error: debugError(error) }; } });
  return { source: 'persisted-meta-and-current-document-cache', docId, version: meta.version, request: r ? { rid, status: r.status, attempt: service._attempt?.(r), target: r.target,
    error: r.error, proposals: r.proposals, comments: r.comments, claim: r.claim ? { agent: r.claim.agent, server: r.claim.server, expires: r.claim.expires } : null } : null,
    cachedVersion: cached?.version, transactionPending: !!service.store?.queues?.has(docId), paragraphs };
}

// SDK schema 검사보다 앞에서 기록한다. 잘못된 인자·없는 도구·채널 알림도 같은 원문/응답 쌍으로 남는다.
export async function connectDebugTransport(server, transport, { directory, context = {}, service } = {}) {
  const traces = new Map();
  const send = transport.send.bind(transport);
  transport.send = async (message, ...rest) => {
    const trace = traces.get(message.id) || currentAiDebug() || createAiDebug({ directory, context: { ...context, method: message.method } });
    trace?.record('mcp.out', message, { outcome: message.error || message.result?.isError ? 'rejected' : 'returned' });
    if (message.id != null) traces.delete(message.id);
    return send(message, ...rest);
  };
  const wrapReceive = receive => (message, ...rest) => {
    const args = message.params?.arguments || {};
    const trace = createAiDebug({ directory, context: { ...context, parentRunId: currentAiDebug()?.runId, rpcId: message.id, method: message.method, tool: message.params?.name,
      docId: args.doc_id ?? context.docId, requestId: args.request_id ?? context.requestId, attempt: args.expected_attempt ?? context.attempt },
      state: () => debugServiceState(service, args.doc_id ? args : context) });
    try {
      trace.record('mcp.in', message);
      if (message.id != null) traces.set(message.id, trace);
      return trace.run(() => receive.call(transport, message, ...rest));
    } catch (error) {
      traces.delete(message.id);
      // 진단 실패 상태로 도구를 실행하지 않는다. 원문을 받았다고 가장하지 않는다.
      if (message.id != null) return send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      throw error;
    }
  };
  // connect/start 중 이미 버퍼에 도착한 stdio 호출도 SDK 검증 전에 잡는다.
  decorateCallback(transport, 'onmessage', wrapReceive);
  decorateCallback(transport, 'onerror', handler => error => {
      const trace = currentAiDebug() || createAiDebug({ directory, context: { ...context, wireRunId: transport.aiDebugWireRunId } });
      trace.record('mcp.transport.error', debugError(error)); return handler(error);
  });
  await server.connect(transport);
  return transport;
}

function decorateCallback(transport, name, wrap) {
  // HTTP SDK는 속성 setter로 내부 WebStandard transport에 넘긴다. 이 setter를 가리면 요청이 도착하지 않는다.
  let owner = transport, descriptor;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, name))) owner = Object.getPrototypeOf(owner);
  let stored = transport[name];
  Object.defineProperty(transport, name, { configurable: true,
    get: () => descriptor?.get ? descriptor.get.call(transport) : stored,
    set: handler => {
      const wrapped = typeof handler === 'function' ? wrap(handler) : handler;
      if (descriptor?.set) descriptor.set.call(transport, wrapped); else stored = wrapped;
    },
  });
}

// CLI 출력은 메모리 보호 한도와 독립적으로 즉시 파일에 쓴다. 실패/취소 전까지 받은 바이트도 보존한다.
export function debugStream(kind, details = {}) {
  const trace = currentAiDebug();
  if (!trace) return { write() {}, close() {} };
  const name = `${part(kind)}-${crypto.randomUUID()}.bin`;
  let fd;
  try {
    fs.mkdirSync(trace.directory, { recursive: true, mode: 0o700 });
    fd = fs.openSync(path.join(trace.directory, name), 'wx', 0o600);
    trace.record('stream.start', { file: name, kind, ...details });
  } catch (cause) { if (fd !== undefined) fs.closeSync(fd); throw writeFailure(cause, trace.directory); }
  const hash = crypto.createHash('sha256'); let bytes = 0, closed = false;
  return {
    write(chunk) {
      if (closed) return;
      const buffer = Buffer.from(chunk);
      try { fs.writeFileSync(fd, buffer); hash.update(buffer); bytes += buffer.length; }
      catch (cause) { throw writeFailure(cause, trace.directory); }
    },
    close(extra = {}) {
      if (closed) return;
      closed = true;
      try { try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      catch (cause) { throw writeFailure(cause, trace.directory); }
      trace.record('stream.end', { file: name, kind, bytes, sha256: hash.digest('hex'), ...details, ...extra });
    },
  };
}

export function createDebugStdioTransport(Transport, { directory, context = {}, stdin = process.stdin, stdout = process.stdout } = {}) {
  const trace = createAiDebug({ directory, context: { ...context, route: context.route || 'stdio-wire' } });
  const sink = trace.run(() => debugStream('stdio.stdin'));
  const wire = new Transform({ transform(chunk, encoding, callback) {
    try { sink.write(chunk); callback(null, chunk); } catch (error) { callback(error); }
  } });
  // pipe가 SDK의 start보다 먼저 읽어도 Transform이 버퍼링하므로 initialize를 잃지 않는다.
  stdin.pipe(wire);
  const transport = new Transport(wire, stdout), close = transport.close.bind(transport);
  transport.aiDebugWireRunId = trace.runId;
  transport.close = async () => { try { await close(); } finally { stdin.unpipe(wire); wire.destroy(); sink.close(); } };
  return transport;
}
