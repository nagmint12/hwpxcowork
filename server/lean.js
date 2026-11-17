// 얇은 흐름(lean) — 모델이 직접 읽는 MCP 연결의 응답·도구 정의를 줄이는 순수 함수(docs/MCP_LEAN_FLOW_2026-11-10.md).
// 2026-11-09 실제 채널 대화 기록: 낱말 하나 고치는 요청에 모델 4~8회(get_request → start_request → 쓰기 → complete_request),
// 그 네 응답이 7,400자인데 요청의 실제 내용(지시·대상·앞뒤 문단)은 300자 안팎이었다. 모델은 부를 때마다 대화 전체를 다시 읽으므로
// 줄일 것은 (1) 왕복 수 (2) 요청마다 대화에 쌓이는 글이다. 도구는 그대로 다 주고(AI 가 고른다) 응답만 줄인다.
//   · leanRequest: get_request 전체 자료 → 모델용 요약(지시·대상·문맥 줄·짧은 할 일). 실행기 계약(get_request 기본 꼴)은 바꾸지 않는다
//   · leanReceipt: 쓰기·완료 도구 응답에서 방금 보낸 값의 되풀이·이력·작성자를 뺀 영수증
//   · leanToolSchema: 도구 입력 스키마의 'null 허용' 가지를 접는다(모델은 생략하면 된다 — 서버 zod 는 null 도 그대로 받는다)
// 서버(mcp.js — 연결이 lean 일 때)와 API 실행기(api-mcp-tools.js — 모델에 넘기는 쪽)가 같은 함수를 쓴다.
import { automaticNumberReadNote } from './editor-instructions.js';

/** 이 MCP 연결이 lean 인가: 머리글 X-Hwpx-Lean: 1(브리지 --lean) 또는 주소 ?lean=1 */
export function isLeanRequest(req) {
  const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
  if (on(req?.headers?.['x-hwpx-lean'])) return true;
  try { return on(new URL(req.url, 'http://x').searchParams.get('lean')); } catch { return false; }
}

/** 주소에 lean=1 이 있는가(브리지 --url) */
export function leanFromUrl(url) {
  try { return /^(1|true|yes|on)$/i.test(new URL(url).searchParams.get('lean') || ''); } catch { return false; }
}

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
/** 빈 값(null·''·[]·{})인 속성을 뺀다(한 단계) */
export const dropEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => !empty(v)));

// 그림·표·파일을 다루는 지시로 보이는가 — 맞으면 문서 그림 목록과 파일 절차 한 줄을 싣는다(틀려도 도구는 그대로 있고 list_figures 로 볼 수 있다).
// '표'는 낱말로 쓰일 때만(표를·표 3·[표 …) — 표현·표준·발표·목표 같은 낱말은 아니다
const FIGURE_HINT = /그림|시각화|그래프|차트|도식|다이어그램|흐름도|개념도|이미지|사진|figure|chart|image|diagram|(?:^|[^가-힣])표(?=$|[^가-힣]|[를로에의가는은도와과만]|부터|까지|처럼|마다)/i;
export const figureHinted = (instruction) => FIGURE_HINT.test(String(instruction ?? ''));

const escapeContext = (s) => String(s).replace(/<(\/?)(document_context)/gi, '＜$1$2');

/** 문맥 줄: '*[ref] (어디) 〔스타일〕 글' — * = 대상, 〔 〕 는 스타일이 바뀌는 줄에만(다음 〔 〕 까지 같다) */
export function contextLines(items = []) {
  let last = null;
  return items.map((c) => {
    const style = c.style && c.style !== last ? ` 〔${c.style}〕` : '';
    if (c.style) last = c.style;
    return `${c.isTarget ? '*' : ' '}[${c.ref}]${c.where && c.where !== '본문' ? ` (${c.where})` : ''}${style} ${c.text ?? ''}${automaticNumberReadNote(c)}`;
  }).join('\n');
}

const KIND_GUIDE = {
  review: () => '문제점·개선점은 add_memo(의견)로, 꼭 고칠 표현만 propose_changes 로 남긴다.',
  suggest: (n) => (n > 1
    ? `propose_alternatives(ref=target.ref, find=대상 글, options ${n}개)로 서로 다른 안을 낸다.`
    : '대상 글을 대신할 추천 문장 하나를 propose_changes(ref=target.ref, find=대상 글)로 낸다(선택지를 여럿 만들지 않는다).'),
  polish: () => '기준에 맞게 고칠 곳만 propose_changes 로 남긴다(문단을 통째로 다시 쓰지 않는다). 수치·사실 확인이 필요하면 add_memo.',
  instruct: () => '지시에 맞는 도구로 결과를 저장한다: 글 propose_changes · 서식 propose_format · 문단 propose_insert(paragraphs) · 표 propose_table/propose_table_edit · 편집 가능한 차트 propose_chart · 그림 propose_figure · 개체 삭제 propose_delete(본문 ref) · 차례 propose_toc_update(지금이면 apply_now) · 쪽 구성 propose_page_layout · 누름틀 propose_fill_fields(list_fields) · 의견 add_memo.',
  fill_table: () => 'propose_changes: ref = 표 칸 문단 ref(tables[].cells[].refs), find = 칸의 지금 글(빈 칸은 ""), replace = 첨부 근거 값.',
  make_table: () => 'propose_table(after_ref=target.ref, rows, header_rows, caption=제목만) — 첨부(read_attachment) 수치로.',
  insert: () => 'propose_insert(after_ref=target.ref, text 또는 paragraphs).',
};

/** 할 일 안내(짧게): 종류별 한 줄 + 이 요청에 해당하는 것만 덧붙인다. 도구별 자세한 규칙은 그 도구 설명에 있다 */
function leanHowTo(full, { formattingLean, figureHinted }) {
  if (full.status === 'done' || full.status === 'cancelled') return `이 요청은 이미 ${full.status === 'done' ? '완료' : '취소'}되었다 — 더 손대지 않는다.`;
  const mine = !!full.claim?.mine && !full.claim.expired;
  const parts = [];
  if (!mine) parts.push('먼저 start_request 로 맡는다(CLAIMED·NOT_OWNER 오류면 그만둔다).');
  if (full.followUp) parts.push('이 요청은 메모에 사람이 단 답장이다 — followUp.memoText(앞 작업 메모, 자료)의 맥락을 이어 instruction 대로 실제 제안을 만든다.');
  parts.push((KIND_GUIDE[full.kind] || KIND_GUIDE.instruct)(Number(full.options?.count) || 1));
  parts.push(formattingLean
    ? '서식 번호는 싣지 않았다(〔 〕 = 문단 스타일). 글만 바꾸면 그 자리 서식이 유지된다 — 서식을 바꾸거나 다른 문단과 맞출 때만 get_formatting(refs).'
    : '지금 서식은 formatting.paragraphs 의 번호와 formatting.header(그 번호의 값), 다른 서식은 get_formatting(refs).');
  if (full.writingGuide) parts.push('표준서식 문서 — 새 문단·표·서식을 만들 때만 get_writing_guide 를 먼저 읽는다.');
  if (full.attachments?.length || figureHinted) parts.push('첨부는 read_attachment 로 읽는다. 원본 파일을 고치면 get_attachment_file(Work)·download_attachment_file(내 PC)로 받고 결과는 save_result_file·upload_result_file 로 저장한 aid 를 쓴다. 문서 속 그림 고치기: list_figures → export_figure → 처리 → propose_figure(attachment_id, replace_ref).');
  parts.push(`쓰기 도구에는 request_id=${full.rid}·expected_attempt=${full.attempt ?? 1} 을 붙인다. 마지막 쓰기 호출에 complete="공유용 요약 1~2문장"을 주면 완료까지 한 번에 된다(따로 끝내려면 complete_request).`);
  return parts.join(' ');
}

/**
 * get_request 전체 자료(service.mcpGetRequest) → 모델용 요약.
 * 뺀 것: contextItems(문맥 줄과 같은 글), 빈 값, 이력·해결 통계, 늘 같은 안내 글. 서식이 필요한 요청이면 서식 번호·값은 formatting 에 남긴다.
 */
export function leanRequest(full) {
  if (!full || typeof full !== 'object' || full.none) return full;
  if (full.options?.workflow === 'content_format') return full;
  const items = Array.isArray(full.contextItems) ? full.contextItems : null;
  const formattingLean = !!full.formattingHeader?.lean;
  const target = full.target || {};
  const scope = target.scope === 'document';
  const refs = Array.isArray(target.refs) && target.refs.length > 1 ? target.refs : null;
  const instruction = `${full.instruction || ''} ${full.followUp?.instruction || ''}`;
  const figureHinted = scope || FIGURE_HINT.test(instruction) || /table|figure/.test(String(full.kind || ''));
  const text = full.targetText ?? target.text ?? '';
  const whole = !scope && !refs && items && text !== '' && items.find((c) => c.ref === target.ref)?.text === text;
  const figures = full.document?.figures || [];
  const formats = !formattingLean && items
    ? items.filter((c) => c.ref !== '…' && (c.styleId != null || c.paraPrId != null || c.runs)).map((c) => dropEmpty({ ref: c.ref, styleId: c.styleId, paraPrId: c.paraPrId, runs: c.runs, emptyCharPrId: c.emptyCharPrId }))
    : [];
  const existing = full.existingResults || {};
  const hasExisting = existing.proposals?.length || existing.comments?.length || existing.files?.length;
  const claim = full.claim ? dropEmpty({ mine: !!full.claim.mine, expires: full.claim.expires, expired: full.claim.expired || null, ...(full.claim.mine ? {} : { agent: full.claim.agent, by: full.claim.by }) }) : null;
  const options = dropEmpty({ ...(Number(full.options?.count) > 1 ? { count: full.options.count } : {}), format: full.options?.format });
  return {
    ...(full.claimed ? { claimed: true } : {}), ...(full.started ? { started: true } : {}),
    docId: full.docId, title: full.title, rid: full.rid, attempt: full.attempt ?? 1, kind: full.kind, label: full.label, ...(full.preset ? { preset: full.preset } : {}),
    status: full.status, ...(full.by ? { by: full.by } : {}),
    ...(full.instructionHidden ? { instructionHidden: true } : { instruction: full.instruction || '' }),
    ...(Object.keys(options).length ? { options } : {}),
    target: scope ? dropEmpty({ scope: 'document', from: target.from, to: target.to })
      : dropEmpty({ ref: target.ref, refs, start: whole ? null : target.start, end: whole ? null : target.end, text: whole ? null : text, whole: whole || null, tableKey: target.tableKey }),
    ...(full.followUp ? { followUp: full.followUp } : {}),
    context: items ? `<document_context>\n${escapeContext(contextLines(items))}\n</document_context>` : full.context,
    ...(formats.length ? { formatting: { paragraphs: formats, header: { ...full.formattingHeader, ...(typeof full.formattingHeader?.note === 'string' ? { note: full.formattingHeader.note.replace('contextItems', 'formatting.paragraphs') } : {}) } } } : {}),
    ...(full.tables?.length ? { tables: full.tables } : {}),
    ...(full.tableInventory ? { tableInventory: full.tableInventory } : {}),
    ...(full.attachments?.length ? { attachments: full.attachments } : {}),
    ...(full.resultAttachments?.length ? { resultAttachments: full.resultAttachments } : {}),
    ...(hasExisting ? { existingResults: dropEmpty(existing) } : {}),
    ...(figures.length ? (figureHinted ? { figures } : { figureCount: figures.length }) : {}),
    ...(full.skillGuide ? { skillGuide: full.skillGuide } : {}),
    ...(full.error ? { error: full.error } : {}),
    claim,
    howTo: leanHowTo(full, { formattingLean, figureHinted }),
    ...(full.truncated ? { truncated: full.truncated } : {}),
  };
}

/** list_requests 한 항목: 빈 값과 해결 통계를 뺀다 */
export function leanListItem(r) {
  if (!r || typeof r !== 'object') return r;
  const { outcome, resolvedAt, resolvedBy, summaryBy, instructionHidden, delivery, claim, target, ...rest } = r;
  return dropEmpty({ ...rest, ...(instructionHidden ? { instructionHidden: true } : {}), target: dropEmpty(target),
    claim: claim ? dropEmpty({ mine: !!claim.mine, expires: claim.expires, expired: claim.expired || null, agent: claim.agent }) : null });
}

// 제안 영수증에서 빼는 것: 방금 보낸 값의 되풀이(글·서식·표·차트 자료)와 이력·작성자
// (+ 되돌리기용 내부 기록 — …Snapshot·…Fingerprint·…Hash)
const PROPOSAL_DROP = new Set(['by', 'at', 'reason', 'changeIds', 'log', 'rid', 'find', 'replace', 'occurrence', 'memo', 'text', 'blank', 'format', 'runs', 'table', 'tableEdit', 'pageLayout', 'start', 'end', 'options', 'note']);
const INTERNAL_KEY = /(Snapshot|Fingerprint|Hash|Undo)$/;
function slimProposal(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (PROPOSAL_DROP.has(k) || INTERNAL_KEY.test(k) || empty(v)) continue;
    if (k === 'figure' && v && typeof v === 'object') { const { chart, caption, nativeChart, sourceTable, sourceHash, ...figure } = v; out.figure = { ...figure, ...(nativeChart ? { editableChart: true } : {}) }; continue; }
    if (k === 'toc' && v && typeof v === 'object') { const { fieldId, ...toc } = v; if (Object.keys(toc).length) out.toc = toc; continue; }
    out[k] = v;
  }
  // 편집 뒤 검증 V2(server/edit-verify.js VERIFY_NOTE — JSON 에 나오지 않는 기호 키라 기본 연결에는 없다): 문제가 있을 때만 경고 한 줄
  if (p[VERIFY_NOTE]) out.warning = p[VERIFY_NOTE];
  return out;
}
const VERIFY_NOTE = Symbol.for('hwpx-cowork.verifyNote');   // = edit-verify.js VERIFY_NOTE(엔진을 불러오지 않으려고 이름으로)
const slimItem =(x) => (x && typeof x === 'object' && 'ok' in x ? (x.ok && x.proposal ? { ok: true, ...slimProposal(x.proposal) } : x) : slimProposal(x));
function slimMemo(m) {
  if (!m || typeof m !== 'object' || !('id' in m)) return m;
  return dropEmpty({ id: m.id, ref: m.ref, link: m.link, replies: m.thread?.replies?.length || null });
}
const count = (x) => (Array.isArray(x) ? x.length : Number(x) || 0) || null;   // 0 건은 싣지 않는다
function slimRequest(v) {
  if (!v || typeof v !== 'object' || !('rid' in v) || !('status' in v)) return v;
  return dropEmpty({ rid: v.rid, status: v.status, summary: v.summary, error: v.error,
    proposals: count(v.proposals), comments: count(v.comments),
    noChangesReason: v.noChangesReason });
}

/** 쓰기 도구 가운데 complete(공유 요약)를 받아 완료까지 하는 것 */
export const COMPLETABLE_TOOLS = Object.freeze(['propose_change', 'propose_changes', 'propose_format', 'propose_alternatives', 'propose_insert', 'propose_table',
  'propose_table_edit', 'propose_delete', 'propose_toc_update', 'propose_page_layout', 'propose_chart', 'propose_figure', 'propose_fill_fields', 'add_memo']);
const RECEIPT_TOOLS = new Set([...COMPLETABLE_TOOLS, 'complete_request', 'fail_request']);
export const hasLeanReceipt = (name) => RECEIPT_TOOLS.has(name);

/** 묶음 결과에 실패한 항목이 있는가(있으면 complete 를 하지 않는다) */
export function allItemsOk(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : null;
  return !list || list.every((x) => x?.ok !== false);
}

/** 영수증 맨 위에 조판 경고 한 줄(V3 — server/layout-check.js takeLayoutNote)을 단다. 앞서 단 경고가 있으면 이어 붙인다. 없으면 그대로 */
export function withLayoutNote(slim, note) {
  if (!note || !slim || typeof slim !== 'object' || Array.isArray(slim)) return slim;
  return { ...slim, warning: slim.warning ? `${slim.warning} / ${note}` : note };
}

/** 영수증(한 건 또는 results)에 제안 번호별 V2 경고(notes: Map pid → 글 — edit-verify.js intentNotesSince)를 단다. 경고가 없으면 그대로 */
export function withIntentNotes(slim, notes) {
  if (!notes?.size || !slim || typeof slim !== 'object') return slim;
  const fix = (x) => (x && notes.has(x.pid) && !x.warning ? { ...x, warning: notes.get(x.pid) } : x);
  return Array.isArray(slim.results) ? { ...fix(slim), results: slim.results.map(fix) } : fix(slim);
}

/**
 * 쓰기·완료 도구의 결과 값 → 영수증(언제나 객체).
 * 여러 건(propose_changes·propose_insert paragraphs)은 { results: [...] }, 실패 항목은 오류 글 그대로 둔다(모델이 보고 고친다)
 */
export function leanReceipt(name, value) {
  if (!RECEIPT_TOOLS.has(name) || value == null || typeof value !== 'object') return value;
  if (name === 'complete_request' || name === 'fail_request') return slimRequest(value);
  if (name === 'add_memo') return slimMemo(value);
  if (Array.isArray(value)) return { results: value.map(slimItem) };
  if (Array.isArray(value.results)) return { ...slimProposal({ ...value, results: null }), results: value.results.map(slimItem) };
  return slimProposal(value);
}

/** MCP 결과(글 블록 하나의 JSON)에 leanReceipt 를 씌운다 — API 실행기가 모델에 넘길 때. 오류·그림·JSON 이 아닌 결과는 그대로 */
export function leanToolResult(name, result) {
  if (!RECEIPT_TOOLS.has(name) || !result || result.isError || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') return result;
  let value; try { value = JSON.parse(result.content[0].text); } catch { return result; }
  if (value == null || typeof value !== 'object') return result;
  return { ...result, content: [{ type: 'text', text: JSON.stringify(leanReceipt(name, value)) }] };
}

/**
 * 도구 입력 스키마(JSON Schema)에서 'null 허용' 가지를 접고(anyOf [X, null] → X, type [T, 'null'] → T) 값 범위(최소·최대·길이)를 뺀다.
 * 선택 속성은 생략하면 되므로 모델에게 null 가지는 글자 수만 늘린다(서식 속성 하나마다 두 번 적힌다). 범위는 받는 쪽 zod 가 검사해 틀리면 오류 글로
 * 알려 준다(무늬 pattern·고를 값 enum·필수 required 는 남긴다). 서버 검사는 바뀌지 않는다.
 */
const SCHEMA_BOUNDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'maxItems']);
export function leanToolSchema(node) {
  if (Array.isArray(node)) return node.map(leanToolSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || SCHEMA_BOUNDS.has(key)) continue;
    // 빈 스키마({} = 무엇이든)는 true 로 적는다 — 같은 뜻이고, 빈 스키마에 type 을 지어 붙이는 클라이언트가 있다(새 연결 edit 의 ops 항목)
    if (key === 'additionalProperties' && value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) { out.additionalProperties = true; continue; }
    if (key === 'properties' && value && typeof value === 'object') { out.properties = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, leanToolSchema(item)])); continue; }
    out[key] = leanToolSchema(value);
  }
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const rest = out.type.filter((t) => t !== 'null');
    if (rest.length === 1) out.type = rest[0]; else if (rest.length) out.type = rest;
  }
  if (Array.isArray(out.anyOf) && out.anyOf.some((x) => x?.type === 'null')) {
    const rest = out.anyOf.filter((x) => x?.type !== 'null');
    if (rest.length === 1) { const { anyOf, ...siblings } = out; return { ...rest[0], ...siblings }; }
    if (rest.length) out.anyOf = rest;
  }
  return out;
}

/** complete 인자 설명(lean 연결의 쓰기 도구에 붙는다) */
export const COMPLETE_ARG_NOTE = '이 호출로 요청의 일이 모두 끝나면 공유용 요약(1~2문장, 지시 원문·개인정보 없이) — 저장한 뒤 요청을 완료한다(complete_request 를 따로 부르지 않는다). 남은 작업이 있으면 주지 않는다';
