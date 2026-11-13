// Experimental source reuse only. Final rendering and writes still use the base MCP tools.
import crypto from 'node:crypto';
import { normSvg, SVG_MAX_CHARS } from '../../server/figure-svg.js';
import { normChart } from '../../server/chart.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const has = value => value !== undefined && value !== null && value !== '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const receipt = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorResult = error => ({ isError: true, content: [{ type: 'text', text: `오류(${error.code || 'FIGURE_ARTIFACT'}): ${error.message}` }] });
const common = {
  doc_id: { type: 'string', minLength: 1 },
  request_id: { type: 'integer', minimum: 1 },
  expected_attempt: { type: 'integer', minimum: 1 },
};
const target = {
  after_ref: { type: 'string', minLength: 1 },
  replace_ref: { type: 'string', minLength: 1 },
  width_mm: { type: 'number', minimum: 10, maximum: 300 },
};
const chartSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'categories', 'series'], properties: {
    type: { type: 'string', enum: ['bar', 'hbar', 'line', 'stacked_hbar'] },
    categories: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'string' } },
    series: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false,
      required: ['name', 'values'], properties: { name: { type: 'string' }, values: { type: 'array', maxItems: 60, items: { type: ['number', 'null'] } } } } },
    y_label: { type: 'string' }, unit: { type: 'string' }, y_min: { type: 'number' }, y_max: { type: 'number' },
    value_labels: { type: 'string', enum: ['all', 'last', 'none'] }, decimals: { type: 'integer', minimum: 0, maximum: 4 },
  },
};
const scopes = [{ if: { required: ['request_id'] }, then: { required: ['expected_attempt'] } },
  { if: { required: ['expected_attempt'] }, then: { required: ['request_id'] } }];

export const figurePreviewSchema = {
  type: 'object', additionalProperties: false, required: ['doc_id'],
  properties: { ...common, ...target, svg: { type: 'string', minLength: 1, maxLength: SVG_MAX_CHARS }, chart: chartSchema },
  allOf: [...scopes, { oneOf: [{ required: ['svg'] }, { required: ['chart'] }] },
    { oneOf: [{ required: ['after_ref'] }, { required: ['replace_ref'] }] }],
};
export const figureProposeSchema = {
  type: 'object', additionalProperties: false, required: ['doc_id', 'artifact_id'],
  properties: { ...common, ...target, artifact_id: { type: 'string', pattern: '^fig_[A-Za-z0-9_-]{24}$' },
    caption: { type: 'string', maxLength: 1000 }, reason: { type: 'string', maxLength: 4000 } },
  allOf: scopes,
};

/**
 * The cache belongs to one authenticated gateway session. Never share it between users.
 * The gateway must serialize its mutations across these handlers and callBase so the
 * fingerprint check and the base write cannot race another gateway mutation. The base
 * Service does not accept expected document hashes; this is not a cross-process lock.
 */
export function createFigureTools({ service, user, callBase, now = Date.now, ttlMs = 600000,
  maxEntries = 64, maxBytes = 16 * 1048576 } = {}) {
  if (!service || !user || typeof callBase !== 'function') throw new TypeError('service, user and callBase are required');
  if (![ttlMs, maxEntries, maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('cache limits must be positive integers');
  const entries = new Map(); let storedBytes = 0; let closed = false;
  const identity = () => digest(json({ name: user.name, token: user.token, role: user.role, session: user.agentSession }));
  const owner = identity();
  function remove(key) { const entry = entries.get(key); if (entry) storedBytes -= entry.bytes; entries.delete(key); }
  function purge() { for (const [key, entry] of entries) if (!entry.pending && entry.expires <= now()) remove(key); }
  function reserve(bytes) {
    purge();
    if (bytes > maxBytes) throw fail('ARTIFACT_TOO_LARGE', '미리보기 원문이 실험 캐시 한도를 넘습니다.');
    while (entries.size >= maxEntries || storedBytes + bytes > maxBytes) {
      const candidate = [...entries].find(([, entry]) => !entry.pending);
      if (!candidate) throw fail('ARTIFACT_CAPACITY', '진행 중인 그림 작업이 캐시를 사용하고 있습니다.');
      remove(candidate[0]);
    }
  }
  function assertArgs(args, schema) {
    if (closed) throw fail('ARTIFACT_CLOSED', '그림 실험 세션이 닫혔습니다.');
    if (identity() !== owner) throw fail('ARTIFACT_OWNER', '그림을 만든 인증 세션이 바뀌었습니다.');
    if (!object(args) || typeof args.doc_id !== 'string' || !args.doc_id) throw fail('BAD_ARGS', 'doc_id가 필요합니다.');
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw fail('BAD_ARGS', '이 도구에서 허용하지 않는 인수입니다.');
    if (has(args.request_id) !== has(args.expected_attempt)) throw fail('BAD_ARGS', 'request_id와 expected_attempt를 함께 주세요.');
    for (const key of ['request_id', 'expected_attempt']) if (has(args[key]) && (!Number.isSafeInteger(args[key]) || args[key] < 1)) throw fail('BAD_ARGS', `${key}는 양의 정수여야 합니다.`);
    for (const key of ['after_ref', 'replace_ref']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key])) throw fail('BAD_ARGS', `${key}는 문단 주소여야 합니다.`);
    if (args.width_mm !== undefined && (!Number.isFinite(args.width_mm) || args.width_mm < 10 || args.width_mm > 300)) throw fail('BAD_ARGS', 'width_mm는 10~300입니다.');
    service.assertDocRead(args.doc_id, user);
  }
  function requestScope(args, { allowClosed = false } = {}) {
    if (!has(args.request_id)) return {};
    const meta = service._meta(args.doc_id);
    const request = (meta.requests || []).find(r => Number(r.rid) === args.request_id);
    if (!request) throw fail('NO_REQUEST', '요청을 찾을 수 없습니다.');
    const attempt = typeof service._attempt === 'function' ? service._attempt(request) : Number(request.attempt) || 1;
    if (attempt !== args.expected_attempt) throw fail('ATTEMPT_CHANGED', '요청의 시도가 바뀌었습니다. 새 미리보기를 만드세요.');
    if (!allowClosed && !['pending', 'working'].includes(request.status)) throw fail('REQUEST_CLOSED', '완료·취소된 요청에는 새 그림을 제안할 수 없습니다.');
    return { request_id: args.request_id, expected_attempt: attempt };
  }
  function snapshot(docId) {
    const meta = service._meta(docId);
    return { version: meta.version, sha256: digest(service.store.currentBytes(docId)) };
  }
  function sameSnapshot(docId, expected) { return json(snapshot(docId)) === json(expected); }
  function targetOf(args) { return Object.fromEntries(Object.keys(target).filter(key => args[key] !== undefined).map(key => [key, args[key]])); }
  function normalizedSource(args) {
    if (has(args.svg) === has(args.chart)) throw fail('BAD_FIGURE', 'svg 또는 chart 하나만 주세요.');
    if (has(args.svg)) {
      if (typeof args.svg !== 'string') throw fail('BAD_SVG', 'svg는 문자열이어야 합니다.');
      return { svg: normSvg(args.svg) };
    }
    return { chart: Object.fromEntries(Object.entries(normChart(args.chart)).filter(([, value]) => value !== null)) };
  }
  async function preview(args) {
    assertArgs(args, figurePreviewSchema);
    if (has(args.after_ref) === has(args.replace_ref)) throw fail('BAD_FIGURE', '미리보기 시 after_ref 또는 replace_ref 하나를 정하세요.');
    const scope = requestScope(args), source = normalizedSource(args), placement = targetOf(args);
    const before = snapshot(args.doc_id);
    const output = await callBase('preview_figure', { doc_id: args.doc_id, ...source, ...placement });
    if (output.isError) return output;
    if (!sameSnapshot(args.doc_id, before)) throw fail('ARTIFACT_STALE', '미리보기 도중 문서가 바뀌었습니다. 다시 만드세요.');
    requestScope(args);
    const images = (output.content || []).filter(block => block.type === 'image');
    if (!images.length) throw fail('ARTIFACT_PREVIEW_MISSING', '기본 도구가 미리보기 이미지를 반환하지 않았습니다.');
    const bytes = Buffer.byteLength(json(source)); reserve(bytes);
    const artifactId = `fig_${crypto.randomBytes(18).toString('base64url')}`;
    const expires = now() + ttlMs;
    entries.set(artifactId, { owner, docId: args.doc_id, scope, source, placement, snapshot: before, expires, bytes });
    storedBytes += bytes;
    return { content: [{ type: 'text', text: JSON.stringify({ artifact_id: artifactId, kind: source.svg ? 'svg' : 'chart',
      expires_at: new Date(expires).toISOString(), doc_id: args.doc_id, ...placement,
      next: 'propose_rendered_figure에 artifact_id와 caption을 전달하세요. 원문은 다시 보내지 않습니다.' }) }, ...images] };
  }
  async function propose(args) {
    assertArgs(args, figureProposeSchema); purge();
    const entry = entries.get(args.artifact_id);
    if (!entry || entry.expires <= now()) throw fail('ARTIFACT_NOT_FOUND', '그림 미리보기가 없거나 만료·퇴출되었습니다. 다시 만드세요.');
    if (entry.owner !== owner || entry.docId !== args.doc_id || json(entry.scope) !== json({ ...(has(args.request_id) ? { request_id: args.request_id, expected_attempt: args.expected_attempt } : {}) }))
      throw fail('ARTIFACT_SCOPE', '그림 미리보기의 사용자·문서·요청·시도가 일치하지 않습니다.');
    requestScope(args, { allowClosed: !!entry.result });
    for (const [key, value] of Object.entries(targetOf(args))) if (entry.placement[key] !== value)
      throw fail('ARTIFACT_TARGET_CHANGED', '자리나 폭을 바꾸려면 새 미리보기를 만드세요.');
    for (const [key, max] of [['caption', 1000], ['reason', 4000]]) if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > max)) throw fail('BAD_ARGS', `${key}가 올바르지 않습니다.`);
    const options = { caption: args.caption ?? '', ...(args.reason !== undefined ? { reason: args.reason } : {}) };
    const useKey = json(options);
    if ((entry.result || entry.pending) && entry.useKey !== useKey) throw fail('ARTIFACT_ALREADY_USED', '이 그림 미리보기는 다른 제안에 사용되었습니다.');
    if (entry.result) return receipt({ ...entry.result, duplicate: true });
    if (entry.pending) return entry.pending.then(result => result.isError ? result : receipt({ ...entry.result, duplicate: true }));
    if (!sameSnapshot(args.doc_id, entry.snapshot)) throw fail('ARTIFACT_STALE', '미리보기 뒤 문서 내용이 바뀌었습니다. 다시 만드세요.');
    entry.useKey = useKey;
    entry.pending = (async () => {
      const output = await callBase('propose_figure', { doc_id: entry.docId, ...entry.scope, ...entry.placement, ...structuredClone(entry.source), ...options });
      if (output.isError) return output;
      let value = output.structuredContent;
      if (!value) for (const block of output.content || []) if (block.type === 'text') { try { value = JSON.parse(block.text); break; } catch { /* not a JSON block */ } }
      entry.result = { artifact_id: args.artifact_id, doc_id: entry.docId, ...entry.scope, accepted: true,
        ...(value?.pid !== undefined ? { proposal_id: value.pid } : {}), ...(value?.status ? { status: value.status } : {}),
        ...(value?.figure?.aid ? { attachment_id: value.figure.aid } : {}), duplicate: false };
      return receipt(entry.result);
    })();
    try { return await entry.pending; }
    finally { entry.pending = null; if (!entry.result) delete entry.useKey; }
  }
  const wrap = fn => async args => { try { return await fn(args); } catch (error) { return errorResult(error); } };
  return {
    tools: [
      { name: 'render_figure_preview', description: '그림 원문(svg 또는 chart)을 한 번 보내 미리보고 artifact_id를 받습니다. 삽입·교체 자리와 폭은 여기서 고정합니다. 문서·요청 시도가 바뀌거나 10분이 지나면 새 미리보기가 필요합니다.',
        inputSchema: figurePreviewSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, handler: wrap(preview) },
      { name: 'propose_rendered_figure', description: '미리보기 artifact_id로 같은 그림을 제안합니다. 원문을 다시 보내지 않습니다. caption과 reason만 새로 정할 수 있고 자리·폭·문서·요청은 미리보기와 같아야 합니다. 같은 인수 재시도는 같은 제안 영수증을 반환합니다.',
        inputSchema: figureProposeSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, handler: wrap(propose) },
    ],
    close() { closed = true; entries.clear(); storedBytes = 0; },
  };
}
