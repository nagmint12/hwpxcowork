// 개인 PC의 ChatGPT 로그인 또는 API 키로 내 검토 요청을 처리한다. 결과는 제안·의견으로 저장한다.
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { apiBaseFrom, createSseParser, eventsUrlFrom } from './bridge.js';
import { requestedFormat, requestedRuns } from './format-schema.js';
import { createApiToolContext } from './api-mcp-tools.js';
import { validateImage } from './image-integrity.js';
import { withAiDebug, debugRecord, debugError } from './ai-debug.js';
import { runEditWorkflow } from './edit-workflow-runner.js';

const DEFAULT_TIMING = { pollMs: 30000, backoffMs: 1000, maxBackoffMs: 30000, connectTimeoutMs: 15000, callTimeoutMs: 120000, deadMs: 50000 };
const DEFAULT_LOG = (line) => process.stderr.write(`[hwpx 개인 AI] ${line}\n`);
const stopError = () => Object.assign(new Error('작업 중단'), { code: 'ABORTED' });
const checkSignal = (signal) => { if (signal?.aborted) throw stopError(); };
const identity = (r) => `${r.docId}:${r.rid}`;
const textContent = (r) => (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const jsonContent = (r) => { try { return JSON.parse(textContent(r)); } catch { throw Object.assign(new Error('MCP 응답 형식 오류'), { code: 'BAD_RESPONSE' }); } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const richSignature = p => canonical([p.format || null, p.runs || null]);
const signature = (p) => p.type === 'insert' ? JSON.stringify(['insert', p.afterRef || p.ref, p.text, richSignature(p)])
  // 표 캡션은 빼고 비교한다: 서버가 '표 3.' 같은 번호를 떼고 저장해 AI 가 준 글과 다를 수 있다
  : p.type === 'table' ? JSON.stringify(['table', p.afterRef || p.ref, p.table?.rows, p.table?.headerRows ?? 1])
  : p.type === 'table_edit' ? JSON.stringify(['table_edit', p.tableKey, canonical(p.tableEdit?.ops || null)])
    : p.type === 'format' ? JSON.stringify(['format', p.ref, p.find, p.occurrence || 1, p.find ? null : [p.start ?? 0, p.end ?? 0], richSignature(p)])
      : JSON.stringify(['replace', p.ref, p.find, p.replace, p.occurrence || 1, richSignature(p)]);
const commentSignature = (p) => JSON.stringify([p.ref, String(p.text ?? p.body ?? '').trim()]);

function occurrence(request, ref, find) {
  if (!find || ref !== request.target.ref) return 1;
  const text = request.contextItems.find((p) => p.ref === ref)?.text || '';
  const from = [...text].slice(0, request.target.start || 0).join('').length;
  const at = text.indexOf(find, from);
  if (at < 0) return 1;
  let count = 1; let offset = 0;
  while (offset < at) { const i = text.indexOf(find, offset); if (i < 0 || i >= at) break; count++; offset = i + 1; }
  return count;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(stopError());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(stopError());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** 구조화된 get_request 응답을 AiProposer.run 입력으로 바꾼다(지시와 문서 자료를 분리). */
export function workerInput(request, attachments = [], previousResults = { proposals: [], comments: [] }) {
  if (!Array.isArray(request.contextItems)) throw Object.assign(new Error('개인 AI 자동 처리에는 최신 서버가 필요합니다'), { code: 'SERVER_UPDATE_REQUIRED' });
  const target = { ...request.target, text: request.targetText ?? request.target?.text ?? '' };
  return { kind: request.kind, preset: request.preset, label: request.label, instruction: request.instruction || '', target,
    context: request.contextItems, tables: request.tables || [], attachments, options: request.options || {},
    formattingHeader: request.formattingHeader, formattingCatalog: request.formattingCatalog,
    docTitle: request.title || '', previousResults, followUp: request.followUp, existingResults: request.existingResults, editWorkflow: request.editWorkflow };
}

/**
 * createApiWorker({ url, token, ai, agent, fetchImpl, timing, log })
 * ai.run(input,{signal}) 은 구조화된 제안 결과를 돌려준다. 테스트에서는 가짜 AI 를 넣는다.
 * SSE 는 알림 힌트이며 실제 권한·대상·순서는 claim_next_request(내 요청만)로 매번 확인한다.
 */
export function createApiWorker(options) { return new ApiWorker(options); }

class ApiWorker {
  constructor({ url = 'http://localhost:8787/mcp', token, ai, agent = '개인 API AI', clientName = 'hwpx-api-worker', tutorialOnly = false, fetchImpl = globalThis.fetch, timing = {}, log = DEFAULT_LOG } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('중앙 MCP 주소 형식이 올바르지 않습니다'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !/\/mcp\/?$/.test(parsed.pathname) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('중앙 MCP 주소는 인증정보가 없는 http(s)://서버/mcp 형식으로 적어 주세요');
    }
    if (!String(token || '').trim()) throw new Error('HWPX_COWORK_TOKEN 이 필요합니다');
    if (typeof ai?.run !== 'function' && typeof ai?.runMcp !== 'function') throw new Error('AI 실행기가 필요합니다');
    this.url = parsed; this.token = token; this.ai = ai; this.agent = agent; this.clientName = clientName; this.fetch = fetchImpl; this.log = log;
    this.tutorialOnly = tutorialOnly === true;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.session = crypto.randomBytes(18).toString('base64url');
    this.active = null; this.client = null; this.connecting = null; this.running = false; this.stopped = false;
    this.wakeRequested = false; this.drainTask = null; this.sseTask = null; this.waiters = new Set();
    this.shutdown = new AbortController();
    this.statsValue = { completed: 0, failed: 0, cancelled: 0, reconnects: 0, duplicated: 0 };
    // 웹의 연결별 모델·추론 강도(server/ai-run.js): 실행할 때 준 값(--model·--effort)을 기본으로 두고, 요청마다 웹 값으로 바꿔 끼운다
    this.runKind = ai.runKind || null; this.baseRun = ai.runSettings ? { ...ai.runSettings } : null; this.lastRun = null;
  }

  /** 웹에서 정한 이 연결의 모델·추론 강도(GET /api/me/ai-run)를 AI 에 적용한다 — 읽지 못하면 지금 값 그대로 */
  async applyRunSettings(signal) {
    if (!this.runKind || !this.baseRun || typeof this.ai.setRunSettings !== 'function') return;
    let web = {};
    try {
      const res = await this.fetch(`${apiBaseFrom(this.url)}/api/me/ai-run`, { headers: { Authorization: `Bearer ${this.token}` }, signal, redirect: 'error' });
      if (!res.ok) return;
      web = (await res.json())?.settings?.[this.runKind] || {};
    } catch { return; }
    const run = { model: web.model || this.baseRun.model || null, effort: web.effort || this.baseRun.effort || null };
    if (this.runKind === 'codex') run.modelSelection = web.modelSelection || this.baseRun.modelSelection || 'manual';
    try { this.ai.setRunSettings(run); } catch { return; }
    const sig = `${run.model || ''}|${run.effort || ''}|${run.modelSelection || ''}`;
    if (sig !== this.lastRun) { this.lastRun = sig; this.say(`모델 ${run.model || '기본'} · 추론 강도 ${run.effort || '기본'}${run.modelSelection === 'auto' ? ' · Codex 자동 선택' : ''}${web.model || web.effort || web.modelSelection ? '(웹 설정)' : ''}`); }
  }

  /** 이 계정으로 쓸 수 있는 모델 목록을 웹에 알린다(PUT /api/me/ai-run/catalog — 목록 조회만, 모델 호출 없음) */
  async reportModels() {
    if (!this.runKind || typeof this.ai.listModels !== 'function') return null;
    try {
      const models = await this.ai.listModels({ signal: this.shutdown.signal });
      const res = await this.fetch(`${apiBaseFrom(this.url)}/api/me/ai-run/catalog`, { method: 'PUT', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: this.runKind, models }), redirect: 'error', signal: this.shutdown.signal });
      if (res.ok) { this.say(`쓸 수 있는 모델 ${models.length}개를 웹에 알렸습니다(웹의 'AI 모델·추론 강도'에서 고릅니다).`); return models.length; }
    } catch { /* 목록은 없어도 처리에는 지장 없다 */ }
    return null;
  }

  say(line) { try { this.log(line); } catch { /* 로그 실패는 작업과 무관 */ } }
  /** 로그·실패 문구에 쓸 처리자 이름(Codex·Claude Code 실행기가 같은 MCP 경로를 쓴다 — 2026-11-13) */
  who() { const a = String(this.agent || ''); return /claude/i.test(a) ? 'Claude Code' : /codex/i.test(a) ? 'Codex' : (a || 'AI'); }
  headers() { return { Authorization: `Bearer ${this.token}`, 'X-Hwpx-Agent-Session': this.session }; }
  stats() { return { ...this.statsValue, active: this.active ? { docId: this.active.request.docId, rid: this.active.request.rid } : null }; }

  start() {
    if (this.stopped) throw new Error('종료한 AI 실행기는 다시 시작할 수 없습니다');
    if (this.running) return this;
    this.running = true;
    this.poll = setInterval(() => this.wake(), this.timing.pollMs);
    this.sseTask = this.listen();
    this.wake();
    void this.reportModels();
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true; this.running = false; clearInterval(this.poll);
    this.shutdown.abort();
    this.sseController?.abort(); this.active?.controller.abort();
    this.sseReader?.cancel().catch(() => {});
    for (const wake of [...this.waiters]) wake();
    await this.client?.close().catch(() => {});
    await Promise.allSettled([this.drainTask, this.sseTask]);
  }

  async pause(ms) {
    if (this.stopped) return;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms); this.waiters.add(done);
    });
  }

  async connected() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = new URL(this.url); url.searchParams.set('agent', this.agent);
      const client = new Client({ name: this.clientName, version: '0.4.1' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(url, { fetch: this.fetch, requestInit: { headers: this.headers(), redirect: 'error' } });
      try {
        await client.connect(transport, { timeout: this.timing.connectTimeoutMs, signal: this.shutdown.signal });
        if (this.stopped) { await client.close(); throw stopError(); }
        this.client = client; return client;
      } catch (e) { await client.close().catch(() => {}); throw e; }
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  /** keepErrors: 도구 오류 결과(isError)를 던지지 않고 그대로 돌려준다 — API 모델이 오류 글을 보고 고치게(멈출 오류는 api-mcp-tools 가 가린다) */
  async call(name, args, signal, { keepErrors = false } = {}) {
    debugRecord('worker.mcp.call', { name, arguments: args });
    signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    checkSignal(signal);
    const client = await this.connected(); checkSignal(signal);
    let result;
    try { result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timing.callTimeoutMs, signal }); }
    catch (e) {
      debugRecord('worker.mcp.error', debugError(e), { tool: name });
      if (this.client === client) { this.client = null; await client.close().catch(() => {}); }
      throw e;
    }
    debugRecord('worker.mcp.result', result, { tool: name });
    if (result.isError && !keepErrors) {
      const code = /오류\(([A-Z_]+)\)/.exec(textContent(result))?.[1] || 'TOOL_FAILED';
      throw Object.assign(new Error('중앙 서버가 작업을 받지 못했습니다'), { code });
    }
    return result;
  }
  async callJson(name, args, signal) { return jsonContent(await this.call(name, args, signal)); }

  wake() {
    if (this.stopped || !this.running) return;
    this.wakeRequested = true;
    if (this.drainTask) return;
    this.drainTask = this.drain().catch(() => this.say('중앙 서버 연결을 확인한 뒤 다시 시도합니다.')).finally(() => {
      this.drainTask = null;
      if (this.wakeRequested && !this.stopped) this.wake();
    });
  }

  async drain() {
    do {
      this.wakeRequested = false;
      while (!this.stopped) {
        const req = await this.callJson('claim_next_request', { ...(this.tutorialOnly ? { tutorial_only: true } : {}), workflows: ['content_format'] });
        if (req.none) break;
        await this.process(req);
      }
    } while (this.wakeRequested && !this.stopped);
  }

  async listen() {
    let attempts = 0;
    while (!this.stopped) {
      const controller = new AbortController(); this.sseController = controller;
      const url = eventsUrlFrom(this.url, { channel: '1', session: this.session, agent: this.agent, client: this.clientName });
      let watchdog; const arm = (ms) => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), ms); };
      const connectedAt = Date.now();
      try {
        arm(this.timing.connectTimeoutMs);
        const res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal, redirect: 'error' });
        if (!res.ok || !/text\/event-stream/i.test(res.headers.get('content-type') || '')) throw new Error('SSE 연결 실패');
        arm(this.timing.deadMs);
        const parser = createSseParser(({ event, data }) => {
          let value; try { value = JSON.parse(data); } catch { return; }
          if (event === 'snapshot' || event === 'ai_request') this.wake();
          if (event === 'ai_request_cancelled' && this.active && identity(value) === identity(this.active.request)
            && Number(value.attempt || 1) === Number(this.active.request.attempt || 1)) this.active.controller.abort();
        });
        const reader = res.body.getReader(); this.sseReader = reader; const decoder = new TextDecoder();
        try {
          while (!this.stopped) {
            const { value, done } = await abortable(reader.read(), controller.signal); if (done) break;
            arm(this.timing.deadMs); parser(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.cancel().catch(() => {});
          try { reader.releaseLock(); } catch { /* fetch 가 pending read 를 정리한 뒤 lock 이 풀린다 */ }
          if (this.sseReader === reader) this.sseReader = null;
        }
      } catch { if (!this.stopped) this.say('요청 알림 연결을 다시 시도합니다.'); }
      finally { clearTimeout(watchdog); controller.abort(); }
      if (!this.stopped) {
        this.statsValue.reconnects++;
        if (Date.now() - connectedAt > 60000) attempts = 0;
        await this.pause(Math.min(this.timing.maxBackoffMs, this.timing.backoffMs * 2 ** Math.min(attempts++, 10)));
      }
    }
  }

  async attachments(request, signal) {
    const out = [];
    for (const a of request.attachments || []) {
      checkSignal(signal);
      if (a.deleted) throw Object.assign(new Error('첨부 파일이 삭제되었습니다'), { code: 'ATTACHMENT_DELETED' });
      const response = await this.call('read_attachment', { doc_id: request.docId, attachment_id: a.aid, max_chars: 200000 }, signal);
      const img = response.content?.find((c) => c.type === 'image');
      const item = { aid: a.aid, name: a.name, kind: a.kind, text: null };
      if (img) { item.base64 = img.data; item.mime = img.mimeType; }
      else {
        const text = textContent(response);
        const match = /^<attachment\b[^>]*>\n([\s\S]*)\n<\/attachment>$/.exec(text);
        if (match) {
          if (/\btruncated="true"/.test(text)) throw Object.assign(new Error('첨부 전문을 읽으려면 MCP 도구를 지원하는 AI가 필요합니다'), { code: 'ATTACHMENT_UNREADABLE' });
          item.text = match[1];
        }
        else if (a.kind === 'pdf') {
          const res = await this.fetch(`${apiBaseFrom(this.url)}/api/docs/${encodeURIComponent(request.docId)}/attachments/${encodeURIComponent(a.aid)}`, {
            headers: { Authorization: `Bearer ${this.token}` }, signal, redirect: 'error',
          });
          if (!res.ok || Number(res.headers.get('content-length')) > 32 * 1048576) throw Object.assign(new Error('PDF 첨부를 읽지 못했습니다'), { code: 'ATTACHMENT_UNREADABLE' });
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > 32 * 1048576) throw Object.assign(new Error('PDF 첨부 크기 초과'), { code: 'ATTACHMENT_UNREADABLE' });
          item.base64 = bytes.toString('base64'); item.mime = 'application/pdf';
        } else throw Object.assign(new Error('첨부 내용을 읽지 못했습니다'), { code: 'ATTACHMENT_UNREADABLE' });
      }
      out.push(item);
    }
    return out;
  }

  async previous(request, signal) {
    if (!request.proposals && !request.comments) return { proposals: [], comments: [] };
    const [proposals, memos] = await Promise.all([
      this.callJson('list_proposals', { doc_id: request.docId }, signal), this.callJson('list_memos', { doc_id: request.docId }, signal),
    ]);
    return { proposals: proposals.filter((p) => p.rid === request.rid),
      comments: memos.filter((m) => m.link?.type === 'comment' && m.link.rid === request.rid).map((m) => ({ ref: m.ref, text: m.body })) };
  }

  /** 새 MCP 연결의 요청 내용(GET /api/docs/:id/requests/:rid/brief — server/mcp2/service.js agentBrief). 옛 서버면 SERVER_UPDATE_REQUIRED */
  async brief(request, signal) {
    const res = await this.fetch(`${apiBaseFrom(this.url)}/api/docs/${encodeURIComponent(request.docId)}/requests/${request.rid}/brief`, { headers: this.headers(), signal, redirect: 'error' });
    if (res.status === 404) throw Object.assign(new Error('중앙 서버가 새 MCP 연결을 지원하지 않습니다'), { code: 'SERVER_UPDATE_REQUIRED' });
    if (!res.ok) throw Object.assign(new Error('요청 내용을 읽지 못했습니다'), { code: 'TOOL_FAILED' });
    const brief = await res.json();
    if (brief.doc_id !== request.docId || brief.request_id !== request.rid || Number(brief.attempt ?? 1) !== Number(request.attempt ?? 1)) throw Object.assign(stopError(), { code: 'ATTEMPT_CHANGED' });
    return brief;
  }

  assertAttempt(request, current) {
    if (Number(current.attempt ?? 1) !== Number(request.attempt ?? 1)) throw Object.assign(stopError(), { code: 'ATTEMPT_CHANGED' });
  }

  async current(request, signal) {
    const current = await this.callJson('get_request', { doc_id: request.docId, request_id: request.rid }, signal);
    this.assertAttempt(request, current);
    if (current.status !== 'working' || !current.claim?.mine || current.claim.expired || current.instructionHidden) throw stopError();
    return current;
  }

  async renew(request, signal) {
    if (typeof this.ai.runMcp === 'function') {
      const state = await this.callJson('get_request', { doc_id: request.docId, request_id: request.rid }, signal);
      this.assertAttempt(request, state);
      // Codex가 MCP로 완료한 직후 CLI가 종료되기까지의 짧은 구간에는 lease를 갱신하지 않는다.
      if (['done', 'failed'].includes(state.status)) return state;
    }
    await this.current(request, signal);
    const renewed = await this.callJson('start_request', { doc_id: request.docId, request_id: request.rid, expected_attempt: request.attempt ?? 1 }, signal);
    this.assertAttempt(request, renewed);
    return renewed;
  }

  async process(request) {
    return withAiDebug({ context: { route: 'worker', docId: request.docId, requestId: request.rid, attempt: request.attempt ?? 1, agent: this.agent, session: this.session } }, () => this.processRecorded(request));
  }

  async processRecorded(request) {
    debugRecord('worker.request', request);
    const controller = new AbortController(); const signal = controller.signal;
    const active = { request, controller }; this.active = active;
    const args = { doc_id: request.docId, request_id: request.rid, expected_attempt: request.attempt ?? 1 };
    let timer; let renewal; let nativeResult;
    const schedule = (claim) => {
      const remaining = Date.parse(claim?.expires || '') - Date.now();
      const delay = Number.isFinite(remaining) ? Math.max(10, Math.min(30000, remaining / 3)) : 30000;
      timer = setTimeout(() => {
        renewal = this.renew(request, signal).then((r) => { checkSignal(signal); if (!['done', 'failed'].includes(r.status)) schedule(r.claim); })
          .catch(() => controller.abort());
      }, delay);
    };
    schedule(request.claim);
    try {
      const current = await this.current(request, signal);
      await this.applyRunSettings(signal);
      if (current.options?.workflow === 'content_format') {
        nativeResult = await runEditWorkflow({ ai: this.ai, docId: request.docId, requestId: request.rid, attempt: request.attempt ?? 1,
          url: this.url.href, token: this.token, session: this.session, signal,
          getRequest: () => this.current(request, signal), call: (name, extra) => this.callJson(name, { ...args, ...extra }, signal),
          openTools: () => createApiToolContext({ profile: 'workspace', docId: request.docId, requestId: request.rid, attempt: request.attempt ?? 1,
            listTools: () => this.connected().then(client => client.listTools()), assertCurrent: () => this.current(request, signal),
            callTool: (name, bound, toolSignal) => this.call(name, bound, toolSignal, { keepErrors: true }),
            uploadFile: async ({ bytes, name }, toolSignal) => {
              if (/\.(png|jpe?g|gif|bmp)$/i.test(name)) validateImage(bytes);
              const url = new URL(`${apiBaseFrom(this.url)}/api/docs/${encodeURIComponent(request.docId)}/requests/${request.rid}/files`);
              url.searchParams.set('attempt', String(request.attempt ?? 1)); url.searchParams.set('agent', this.agent);
              const response = await this.fetch(url, { method: 'POST', body: bytes, headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, redirect: 'error', signal: toolSignal });
              if (!response.ok) throw Object.assign(new Error('실험 결과 파일 저장 실패'), { code: 'API_FILE_SAVE' });
              return response.json();
            } }) });
        this.reportUsage(nativeResult.usage); this.statsValue.completed++;
        this.say('내용·형식 두 단계를 각각 새 대화에서 처리하고 묶음 제안으로 저장했습니다.');
        return;
      }
      if (typeof this.ai.runMcp === 'function') {
        // 새 MCP 연결(--mcp 2 — server/mcp2.js): 짧은 요청 내용(brief)을 받아 모델의 첫 입력에 싣고, 모델은 작업 도구 넷(task·read·edit·finish)으로 처리한다
        const v2 = this.ai.mcpSurface === 'v2';
        this.say(v2 ? `${this.who()}가 작업 도구(task·read·edit·finish)로 필요한 범위만 읽고 결과를 직접 등록합니다.`
          : `${this.who()}가 MCP로 요청 전문·전체 문서와 서식을 읽고 결과를 직접 등록합니다.`);
        const brief = v2 ? await this.brief(request, signal) : null;
        const completed = nativeResult = await this.ai.runMcp({ type: 'request', docId: request.docId, requestId: request.rid, attempt: request.attempt ?? 1, ...(v2 ? { surface: 'v2' } : {}) },
          { url: this.url.href, token: this.token, session: this.session, signal, requestContext: current, ...(v2 ? { brief } : {}) });
        this.reportModelSelection(completed);
        this.reportUsage(completed?.usage, completed?.execution);
        const finished = await this.callJson('get_request', { doc_id: request.docId, request_id: request.rid }, signal);
        this.assertAttempt(request, finished);
        if (!['done', 'failed'].includes(finished.status)) throw Object.assign(new Error('MCP 완료 등록이 없습니다.'), { code: 'CODEX_MCP_INCOMPLETE' });
        await this.persistNativeUsage(request, finished, completed, signal);
        this.statsValue[finished.status === 'done' ? 'completed' : 'failed']++;
        this.say(finished.status === 'done' ? `${this.who()} MCP 작업을 완료했습니다. 결과는 편집기에서 확인할 수 있습니다.` : `${this.who()}가 수행하지 못한 사유를 MCP에 등록했습니다.`);
        return;
      }
      const previous = await this.previous(current, signal);
      const attachments = this.ai.supportsTools ? current.attachments || [] : await this.attachments(current, signal);
      const toolContext = this.ai.supportsTools ? await createApiToolContext({
        docId: request.docId, requestId: request.rid, attempt: request.attempt ?? 1,
        // 차트와 함께 제출한 별도 도식 그림을 최종 JSON 중복으로 버리지 않는다.
        existingFigures: previous.proposals.filter(p => p.type === 'figure' && !p.figure?.nativeChart && !['rejected', 'undone', 'superseded'].includes(p.status)).length,
        listTools: async () => { const tools = []; let cursor; do { const page = await (await this.connected()).listTools(cursor ? { cursor } : undefined); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor); return tools; },
        callTool: (name, args, toolSignal) => this.call(name, args, toolSignal, { keepErrors: true }),
        assertCurrent: toolSignal => this.current(request, toolSignal),
        uploadFile: async ({ bytes, name, sourceFileId }, toolSignal) => {
          if (/\.(png|jpe?g|gif|bmp)$/i.test(name)) validateImage(bytes);
          const url = new URL(`${apiBaseFrom(this.url)}/api/docs/${encodeURIComponent(request.docId)}/requests/${request.rid}/files`);
          url.searchParams.set('attempt', String(request.attempt ?? 1)); url.searchParams.set('agent', this.agent);
          const response = await this.fetch(url, { method: 'POST', body: bytes, headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, redirect: 'error', signal: toolSignal });
          if (!response.ok) throw Object.assign(new Error('API 결과 파일 저장 실패'), { code: 'API_FILE_SAVE' });
          return response.json();
        },
      }) : undefined;
      const result = await abortable(this.ai.run(workerInput(current, attachments, previous), { signal, toolContext }), signal);
      checkSignal(signal);
      await this.renew(request, signal); // 결과 저장 직전에도 선점·취소·재시도 번호를 다시 확인한다.
      await this.save(current, result, previous, signal);
      await this.current(request, signal);
      await this.callJson('complete_request', { ...args, summary: result.summary || '요청한 범위를 검토했습니다.', instruction_summary: result.instructionSummary || undefined,
        no_changes_reason: result.noChangesReason || undefined,
        ...(result.usage ? { usage: result.usage } : {}), ...(result.model ? { model: result.model } : {}), ...(result.execution ? { execution: result.execution } : {}) }, signal);
      this.reportUsage(result.usage, result.execution);
      this.statsValue.completed++; this.say('내 AI 작업 한 건을 완료했습니다. 결과는 편집기에서 확인할 수 있습니다.');
      // 시각화 요청인데 그림 제안이 없었음 — 이유는 의견 메모(add_memo)로 문서에 남았다
      if (result.figureMissing) this.say(`그림 제안 없이 완료했습니다. 이유: ${String(result.figureMissing).slice(0, 200)}`);
    } catch (e) {
      debugRecord('worker.error', debugError(e), { stage: 'execute-save-complete' });
      this.reportModelSelection(e);
      // 완료 응답 직후 프로세스가 끊겼더라도 서버에 등록된 성공을 실패로 바꾸지 않는다.
      if (typeof this.ai.runMcp === 'function' && !this.stopped) {
        try {
          const final = await this.callJson('get_request', { doc_id: request.docId, request_id: request.rid });
          this.assertAttempt(request, final);
          if (['done', 'failed'].includes(final.status)) { await this.persistNativeUsage(request, final, nativeResult || e); this.statsValue[final.status === 'done' ? 'completed' : 'failed']++; return; }
        } catch { /* 취소·재시도·연결 오류는 아래 공통 처리에서 확인한다. */ }
      }
      if (signal.aborted || this.stopped || ['ABORTED', 'ATTEMPT_CHANGED', 'REQUEST_CLOSED', 'CLAIMED', 'CLAIM_REQUIRED', 'NOT_OWNER'].includes(e?.code)) this.statsValue.cancelled++;
      else {
        this.statsValue.failed++;
        // provider 오류 본문에는 키·지시·첨부가 포함될 수 있으므로 서버나 로그에 그대로 보내지 않는다.
        if (e?.usage) this.reportUsage(e.usage, e.execution);
        const message = ['NO_RESULTS', 'API_RESULT_INCOMPLETE'].includes(e?.code) ? '실제로 저장한 결과가 없어 작업을 완료하지 않았습니다. 변경이 불필요한 검토라면 확인한 범위와 사유를 명시해야 합니다.'
          : e?.code === 'API_RESULT_FORMAT' ? 'AI의 최종 응답이 정해진 JSON 형식과 맞지 않습니다. 형식 재요청 후에도 확인하지 못했습니다. 저장된 부분 결과를 확인한 뒤 다시 요청해 주세요.'
          : e?.code === 'CODEX_MCP_INCOMPLETE' ? `${this.who()}가 서버에 작업 결과의 완료·실패를 등록하지 않았습니다. 저장된 부분 결과를 확인한 뒤 다시 요청해 주세요.`
          : e?.code?.startsWith('EDIT_') ? String(e.message).slice(0, 450)
          : e?.code?.startsWith('API_FILE_') ?'API에서 생성한 파일을 회수·저장하지 못했습니다. 게이트웨이의 파일 다운로드 지원을 확인해 주세요.'
          : e?.code === 'SERVER_UPDATE_REQUIRED' ? '개인 AI 자동 처리에는 최신 중앙 서버가 필요합니다.'
          : ['ATTACHMENT_UNREADABLE', 'ATTACHMENT_DELETED', 'UNSUPPORTED_ATTACHMENT'].includes(e?.code) ? '첨부 자료를 읽지 못했습니다. 텍스트를 추출할 수 있는 자료로 바꾼 뒤 다시 요청해 주세요.'
            : '개인 AI 처리에 실패했습니다. 개인 PC의 AI 로그인(Codex·Claude Code) 또는 API 키·모델·연결 상태를 확인한 뒤 다시 요청해 주세요.';
        try { await this.current(request, signal); await this.callJson('fail_request', { ...args, error: message,
          ...(e.usage ? { usage: e.usage, execution: e.execution || 'tool-agent' } : {}), ...(e.model ? { model: e.model } : {}) }, signal); }
        catch { this.say('실패 상태를 전송하지 못했습니다. 저장된 결과는 유지되며 선점 만료 뒤 다시 확인합니다.'); }
        this.say(message);
        if (['CODEX_NOT_FOUND', 'CODEX_UNSUPPORTED', 'CODEX_AUTH_REQUIRED', 'CODEX_API_AUTH', 'CODEX_FAILED', 'API_TOOLS_UNAVAILABLE', 'API_FILE_DOWNLOAD', 'API_FILE_UPLOAD'].includes(e?.code)) {
          this.say('개인 AI 실행기를 중지합니다. 로그인·사용 권한·모델·API 도구 설정을 점검하고 다시 켜 주세요. 남은 대기 요청은 유지됩니다.');
          // process() 안에서 drainTask를 기다리면 자기 자신을 기다리므로 종료를 시작만 한다.
          void this.stop();
        }
      }
    } finally {
      clearTimeout(timer); controller.abort(); await renewal?.catch(() => {});
      if (this.active === active) this.active = null;
    }
  }

  async persistNativeUsage(request, finished, result, signal) {
    if (!result?.usage && !result?.model && !result?.execution) return;
    const args = { doc_id: request.docId, request_id: request.rid, expected_attempt: request.attempt ?? 1,
      ...(result.usage ? { usage: result.usage } : {}), ...(result.model ? { model: result.model } : {}), execution: result.execution || 'tool-agent' };
    await this.callJson(finished.status === 'done' ? 'complete_request' : 'fail_request', {
      ...args, ...(finished.status === 'done' ? {} : { error: finished.error }),
    }, signal);
  }

  reportUsage(usage) {
    if (!usage) return;
    this.say(`AI 사용량: 입력 ${usage.input ?? '미확인'}, 캐시 ${usage.cacheRead || 0}, 출력 ${usage.output ?? '미확인'}${usage.modelCalls != null ? `, 확인된 모델 ${usage.modelCalls}회, 도구 ${usage.toolCalls || 0}회` : ''}${usage.modelCallsUnknown ? ' (native 내부 모델 호출 횟수 미확인)' : ''}`);
  }

  reportModelSelection(result) {
    if (result?.selection) this.say(`Codex ${result.selection.fallback ? '판단 실패로 기본 설정 사용' : '자동 선택'}: ${result.model} · 추론 강도 ${result.effort || '기본'}`);
  }

  async save(request, result, previous, signal) {
    const args = { doc_id: request.docId, request_id: request.rid, expected_attempt: request.attempt ?? 1 };
    await this.current(request, signal);
    const signatures = new Set(previous.proposals.map(signature));
    const comments = new Set(previous.comments.map(commentSignature));
    const proposals = [];
    const rich = (p, ref) => {
      const target = request.target;
      const selected = target.scope === 'document' || (target.refs?.length ? target.refs : [target.ref]).includes(ref);
      const format = requestedFormat(p.format, selected ? request.options?.format : null);
      const runs = requestedRuns(p.runs, selected ? request.options?.format : null);
      return { ...(format ? { format } : {}), ...(runs ? { runs } : {}) };
    };
    const add = (p) => { const sig = signature(p); if (signatures.has(sig)) this.statsValue.duplicated++; else { signatures.add(sig); proposals.push(p); } };
    for (const p of result.proposals || []) add({ type: 'replace', ref: p.ref, find: p.find, replace: p.replace, reason: p.reason, occurrence: occurrence(request, p.ref, p.find), ...rich(p, p.ref) });
    for (const p of result.formats || []) add({ type: 'format', ref: p.ref, find: p.find, format: p.format, reason: p.reason, occurrence: p.occurrence ?? occurrence(request, p.ref, p.find), ...rich(p, p.ref) });
    // 사용자가 개수를 고른 문장 제안만 그 수를 따른다. 다른 지시의 결과를 임의 개수로 자르지 않는다.
    const alternatives = request.kind === 'suggest' ? (result.alternatives || []).slice(0, Math.max(1, request.options?.count || 1)) : result.alternatives || [];
    if (alternatives.length) {
      const existingGroup = previous.proposals.some((p) => p.gid != null && p.ref === request.target.ref && p.find === request.targetText);
      if (existingGroup) this.statsValue.duplicated += alternatives.length;
      else if (alternatives.length === 1) add({ type: 'replace', ref: request.target.ref, find: request.targetText, replace: alternatives[0].text, reason: alternatives[0].reason, occurrence: occurrence(request, request.target.ref, request.targetText), ...rich(alternatives[0], request.target.ref) });
      else {
        const out = await this.callJson('propose_alternatives', { ...args, ref: request.target.ref, find: request.targetText, options: alternatives.map(p => ({ ...p, ...rich(p, request.target.ref) })), occurrence: occurrence(request, request.target.ref, request.targetText) }, signal);
        if (out.results?.some((p) => p.ok === false || p.error)) throw Object.assign(new Error('일부 비교안을 저장하지 못했습니다'), { code: 'RESULT_REJECTED' });
      }
    }
    if (request.options?.format) {
      for (const item of request.contextItems.filter(item => item.isTarget)) {
        const covered = proposals.some(p => p.ref === item.ref && (p.format || p.runs))
          || previous.proposals.some(p => p.ref === item.ref && (p.format || p.runs))
          || (alternatives.length && item.ref === request.target.ref)
          || (result.inserts || []).some(p => p.afterRef === item.ref);
        if (covered) continue;
        const refs = request.target.refs?.length ? request.target.refs : [request.target.ref];
        const start = request.target.scope !== 'document' && item.ref === refs[0] ? request.target.start ?? 0 : 0;
        const end = request.target.scope !== 'document' && item.ref === refs.at(-1) ? request.target.end ?? [...item.text].length : [...item.text].length;
        const find = [...item.text].slice(start, end).join('');
        add({ type: 'format', ref: item.ref, find, start, end, occurrence: occurrence(request, item.ref, find), format: request.options.format, reason: '요청에서 선택한 서식을 적용합니다.' });
      }
    }
    for (let i = 0; i < proposals.length; i += 50) {
      checkSignal(signal);
      const out = await this.callJson('propose_changes', { ...args, proposals: proposals.slice(i, i + 50) }, signal);
      if (out.some((p) => p.ok === false || p.error)) throw Object.assign(new Error('일부 제안을 저장하지 못했습니다'), { code: 'RESULT_REJECTED' });
    }
    for (const p of result.inserts || []) {
      const value = { type: 'insert', afterRef: p.afterRef, text: p.text, ...rich(p, p.afterRef) }; const sig = signature(value);
      if (signatures.has(sig)) { this.statsValue.duplicated++; continue; } signatures.add(sig);
      await this.callJson('propose_insert', { ...args, after_ref: p.afterRef, text: p.text, reason: p.reason, ...rich(p, p.afterRef) }, signal);
    }
    for (const p of result.tables || []) {
      const value = { type: 'table', afterRef: p.afterRef, table: { rows: p.rows, caption: p.caption, headerRows: p.headerRows } }; const sig = signature(value);
      if (signatures.has(sig)) { this.statsValue.duplicated++; continue; } signatures.add(sig);
      await this.callJson('propose_table', { ...args, after_ref: p.afterRef, rows: p.rows, caption: p.caption, header_rows: p.headerRows, reason: p.reason }, signal);
    }
    // 그림(SVG): 서버가 PNG 로 그려 그림 제안을 만든다. 이어받은 시도에 같은 자리·제목의 그림이 있으면 다시 만들지 않는다
    const figureKey = (where, caption) => JSON.stringify(['figure', where || '', String(caption || '').trim()]);
    const figures = new Set(previous.proposals.filter((p) => p.type === 'figure').map((p) => figureKey(p.figure?.replace ? p.ref : p.afterRef ?? p.ref, p.figure?.caption)));
    for (const p of result.figures || []) {
      const key = figureKey(p.replaceRef || p.afterRef, p.replaceRef ? '' : p.caption);
      if (figures.has(key)) { this.statsValue.duplicated++; continue; } figures.add(key);
      try {
        await this.callJson('propose_figure', { ...args, ...(p.replaceRef ? { replace_ref: p.replaceRef } : { after_ref: p.afterRef }), ...(p.caption ? { caption: p.caption } : {}),
          svg: p.svg, ...(Number(p.widthMm) > 0 ? { width_mm: Math.max(10, Math.min(300, Number(p.widthMm))) } : {}), reason: p.reason }, signal);
      } catch (e) {
        // SVG 를 못 그렸으면(BAD_SVG·SVG_TIMEOUT 등) 나머지 결과는 살리고 이유를 의견으로 남긴다. 선점·취소·연결 오류는 그대로 멈춘다
        if (signal.aborted || !/^(BAD_SVG|SVG_TIMEOUT|SVG_UNAVAILABLE|BAD_FIGURE|BAD_IMAGE|NO_AFTER|NOT_FOUND|NO_FIGURE)$/.test(e?.code || '')) throw e;
        const ref = request.target.ref;
        await this.callJson('add_memo', { ...args, ref, text: `그림 제안 없음: ${p.caption ? `「${p.caption}」 ` : ''}그림을 서버에서 그리지 못했습니다(${e.code}). 다시 요청해 주세요.` }, signal);
      }
    }
    for (const p of result.tocUpdates || []) {
      await this.callJson('propose_toc_update', { ...args, ...(p.tocRef ? { toc_ref: p.tocRef } : {}), apply_styles: !!p.applyStyles, one_line: !!p.oneLine, apply_now: !!p.applyNow, reason: p.reason }, signal);
    }
    for (const p of result.tableEdits || []) {
      const value = { type: 'table_edit', tableKey: p.table, tableEdit: { ops: p.ops } }; const sig = signature(value);
      if (signatures.has(sig)) { this.statsValue.duplicated++; continue; } signatures.add(sig);
      await this.callJson('propose_table_edit', { ...args, table: p.table, ops: p.ops, reason: p.reason }, signal);
    }
    for (const p of result.comments || []) {
      const sig = commentSignature(p); if (comments.has(sig)) { this.statsValue.duplicated++; continue; } comments.add(sig);
      await this.callJson('add_memo', { ...args, ref: p.ref, find: p.find || undefined, occurrence: occurrence(request, p.ref, p.find), text: p.text }, signal);
    }
  }
}
