// 메모 글 만들기(순수 함수): 한글에서 열었을 때 보이는 작업 기록·제안·의견 메모의 글 형식(docs/V2_SPEC.md §2.2).
// 서버가 상태가 바뀔 때마다 이 함수들로 글을 다시 만들어 doc.setMemoText 로 덮어쓴다.

export const KINDS = [
  { id: 'review', label: 'AI 검토' },
  { id: 'suggest', label: '문장 제안' },
  { id: 'polish', label: '다듬기' },
  { id: 'instruct', label: '지시' },
  { id: 'fill_table', label: '표 채우기' },
  { id: 'make_table', label: '표 만들기' },
  { id: 'insert', label: '문단 추가' },
];

export const PRESETS = [
  { id: 'concise', label: '간결하게' },
  { id: 'formal', label: '공문서체로' },
  { id: 'spelling', label: '맞춤법·띄어쓰기' },
  { id: 'plain', label: '쉽게 풀어쓰기' },
  { id: 'factcheck', label: '수치·사실 확인' },
];

const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));
const PRESET_LABEL = Object.fromEntries(PRESETS.map((p) => [p.id, p.label]));

export function kindLabel(kind, preset) {
  const base = KIND_LABEL[kind] || kind || '요청';
  return kind === 'polish' && PRESET_LABEL[preset] ? `${base}(${PRESET_LABEL[preset]})` : base;
}
export function presetLabel(preset) { return PRESET_LABEL[preset] || null; }

/** 사람·AI 가 요약을 쓰기 전 기본 요약(지시 원문은 넣지 않는다). 처리 전 = 'AI 처리 대기' */
const AUTO_STATE = { pending: 'AI 처리 대기', working: 'AI 처리 중', cancelled: '취소됨', failed: 'AI 처리 실패', done: '처리 완료' };
export function autoSummary(label, status = 'pending') { return `${label} 요청 — ${AUTO_STATE[status] || AUTO_STATE.pending}`; }

// XML 1.0 에 쓸 수 없는 글자: C0 제어 문자(탭·줄바꿈·CR 은 됨)·U+FFFE·U+FFFF·짝 없는 대리 문자(u 플래그 — 짝이 맞는 것은 한 글자라 안 걸린다)
const XML_BAD = /[\u0000-\u0008\u000E-\u001F\u{FFFE}\u{FFFF}]|[\uD800-\uDFFF]/gu;

/**
 * 메모·문단 XML 에 넣을 글에서 XML 1.0 금지 글자를 뺀다. 엔진(escapeText)은 & < > 만 바꾸므로 그대로 쓰면
 * 한글 등 엄격한 읽기 프로그램이 문서를 열지 못한다. U+000B(워드에서 붙여 넣은 줄바꿈)·U+000C(쪽 나눔)는 줄바꿈으로, 나머지는 지운다.
 * 렌더러(render*·withThread·clip·changeExcerpt)는 모두 이것을 거친 글을 돌려준다.
 */
export function xmlSafe(s) {
  return String(s ?? '').replace(/[\u000B\u000C]/g, '\n').replace(XML_BAD, '');
}

/** 글을 n 코드포인트로 자르고 줄바꿈은 공백으로 */
export function clip(s, n = 30) {
  const chars = [...xmlSafe(s).replace(/\s*\r?\n\s*/g, ' ')];
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** 서버 지역 시간 'MM-dd HH:mm' 또는 'HH:mm' */
export function fmtTime(iso, withDate = true) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}` : hm;
}

/** '홍길동(Claude)' → 'Claude', '홍길동' → '홍길동' */
export function shortBy(by) {
  const m = /^(.+?)\((.+)\)$/.exec(String(by || ''));
  return m ? m[2] : String(by || '');
}

/**
 * 이력 한 줄: 최근 max 개, 날짜가 바뀔 때만 'MM-dd' 를 붙인다(firstDate 면 첫 항목에도).
 * 항목 글 = detail(없으면 action) + (누가). hideBy 의 action 은 (누가) 를 뺀다.
 */
export function renderHistory(log, { max = 10, firstDate = true, hideBy = [] } = {}) {
  const items = (log || []).filter((e) => e && e.at).slice(-max);
  let prevDay = null;
  const parts = items.map((e, i) => {
    const d = new Date(e.at);
    const k = dayKey(d);
    const withDate = (i === 0 && firstDate) || (prevDay !== null && prevDay !== k);
    prevDay = k;
    const who = hideBy.includes(e.action) ? '' : shortBy(e.by);
    return `${fmtTime(d, withDate)} ${e.detail || e.action}${who ? `(${who})` : ''}`;
  });
  return parts.join(' · ');
}

/**
 * 바뀐 자리가 보이게 자른 원문·제안 한 쌍(각 n 코드포인트 안팎). 둘 다 짧으면 그대로.
 * 공통 앞부분은 바뀐 곳 앞 ctx 글자만 남기고 '…' 로 줄인다(긴 문장의 끝말만 바뀐 경우에도 차이가 보이게).
 */
export function changeExcerpt(find, replace, n = 30, ctx = 8) {
  const one = (s) => xmlSafe(s).replace(/\s*\r?\n\s*/g, ' ');
  const A = [...one(find)]; const B = [...one(replace)];
  if (A.length <= n && B.length <= n) return [A.join(''), B.join('')];
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const from = Math.max(0, p - ctx);
  const cut = (X) => {
    const end = Math.min(X.length, Math.max(X.length - s + ctx, from + 1));
    let seg = X.slice(from, end); let post = end < X.length ? '…' : '';
    if (seg.length > n) { seg = seg.slice(0, n); post = '…'; }
    return (from > 0 ? '…' : '') + seg.join('') + post;
  };
  return [cut(A), cut(B)];
}

/** 차례 새로 고침 덧붙임: ' — 차례 스타일 · 한 줄로 입력' + 적용 뒤 결과(항목 수·스타일·한 줄로) */
function tocExtras(p) {
  const t = p.toc || {}; const r = p.tocResult || null;
  const opts = [t.styles ? `스타일 ${[t.styles.title, t.styles.level1, t.styles.level2].filter(Boolean).join('·')}` : '', t.oneLine ? '한 줄로 입력' : ''].filter(Boolean);
  const done = r ? [r.entries != null ? `항목 ${r.entries}개` : '', r.styled ? `스타일 ${r.styled}문단` : '', r.squeezed ? `한 줄로 ${r.squeezed}문단` : ''].filter(Boolean) : [];
  return `${opts.length ? ` — ${opts.join(' · ')}` : ''}${done.length ? ` (${done.join(', ')})` : ''}`;
}

/** 문서 메모용 서식 설명. false도 '끔'으로 남겨 굵게 해제 등의 제안을 구분한다. */
export function formatSummary(format) {
  if (!format || typeof format !== 'object') return '';
  const parts = [];
  for (const [key, label] of [['styleId', '스타일'], ['charPrId', '글자 모양'], ['paraPrId', '문단 모양']]) if (format[key] != null) parts.push(`${label} #${format[key]}`);
  const char = format.char || {};
  if (char.font) parts.push(`글꼴 ${char.font}`);
  if (char.sizePt != null) parts.push(`${char.sizePt}pt`);
  for (const [key, label] of [['bold', '굵게'], ['italic', '기울임'], ['underline', '밑줄']]) if (typeof char[key] === 'boolean') parts.push(`${label} ${char[key] ? '켬' : '끔'}`);
  if (char.color) parts.push(`글자 색 ${char.color}`);
  for (const [key, label] of [['strikeout', '취소선'], ['superscript', '위첨자'], ['subscript', '아래첨자']]) if (typeof char[key] === 'boolean') parts.push(`${label} ${char[key] ? '켬' : '끔'}`);
  if (char.ratioPct != null) parts.push(`장평 ${char.ratioPct}%`);
  if (char.spacingPct != null) parts.push(`자간 ${char.spacingPct}%`);
  if (char.shadeColor) parts.push(char.shadeColor === 'none' ? '음영 없음' : `음영 ${char.shadeColor}`);
  const paragraph = format.paragraph || {};
  const align = { LEFT: '왼쪽', RIGHT: '오른쪽', CENTER: '가운데', JUSTIFY: '양쪽', DISTRIBUTE: '배분', DISTRIBUTE_SPACE: '나눔' };
  if (paragraph.align) parts.push(`${align[paragraph.align] || paragraph.align} 정렬`);
  if (paragraph.lineSpacing) {
    const { type, value } = paragraph.lineSpacing;
    const unit = { PERCENT: '%', FIXED: 'pt 고정', BETWEEN_LINES: 'pt 여백', AT_LEAST: 'pt 최소' };
    parts.push(`줄 간격 ${value}${unit[type] || ''}`);
  }
  for (const [key, label] of [['spaceBeforePt', '문단 앞'], ['spaceAfterPt', '문단 뒤'], ['indentPt', '들여쓰기'], ['leftMarginPt', '왼쪽 여백'], ['rightMarginPt', '오른쪽 여백']]) if (paragraph[key] != null) parts.push(`${label} ${paragraph[key]}pt`);
  if (typeof paragraph.oneLine === 'boolean') parts.push(`한 줄로 입력 ${paragraph.oneLine ? '켬' : '끔'}`);
  if (typeof paragraph.pageBreakBefore === 'boolean') parts.push(`쪽 나눔 ${paragraph.pageBreakBefore ? '켬' : '끔'}`);
  return xmlSafe(parts.join(' · '));
}

function proposalFormatSummary(p) {
  const parts = [formatSummary(p.format)].filter(Boolean);
  if (p.runs?.length) parts.push(...p.runs.map(run => {
    const summary = formatSummary({ charPrId: run.charPrId, char: run.char });
    return summary ? `「${clip(run.text, 20)}」 ${summary}` : '';
  }).filter(Boolean));
  return parts.join(' / ');
}

// ───────── AI 작업(요청) 해결 상태 — docs/V3_SPEC.md §9.2 ─────────

/** 누군가 자기 수정본에 반영해 둔 제안인지(사람마다 기록 adoptedBy, 예전 모양 adopted — V3 §3.3) */
export function isAdopted(p) {
  const m = p?.adoptedBy;
  if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length) return true;
  return !!p?.adopted?.by;
}

/** 그 제안을 수정본에 반영해 둔 변경 요청 번호(묶인 것이 없으면 null — 변경 요청이 생기기 전에 반영해 둔 것) */
export function adoptedCid(p) {
  const all = [p?.adopted, ...Object.values(p?.adoptedBy && typeof p.adoptedBy === 'object' ? p.adoptedBy : {})].filter((x) => x && typeof x === 'object');
  return all.find((x) => x.cid != null)?.cid ?? null;
}

/**
 * 요청의 제안을 항목으로 나눈다(§9.2): 여러 안 묶음(같은 gid)과 묶음 제안(같은 bundle, 구성원 2개 이상 — docs/UI_TERMS.md §9)은 묶음 하나가 항목 하나,
 * 그 밖 제안은 하나씩(처음 나온 차례). 거둔 제안(withdrawn)은 뺀다.
 * 항목 = { gid, bundle?, list, state: 'accepted'|'declined'|'open', via?: 'applied'|'adopted', pick?: 반영된 안(묶음 제안이면 첫 반영 구성원),
 *          open: 남은 대기 제안 pid(pid 순), accepted?: 묶음 제안의 반영 구성원들 }
 *  - accepted: 기준에 적용됨(applied) 또는 대기 + 누군가 수정본에 반영해 둠(묶음은 한 안이 그러면)
 *  - open: 그 밖에 대기 중인 안이 있음(아무도 반영해 두지 않음)
 *  - declined: 나머지(거절·복구, 묶음은 모든 안이 거절·복구·대체)
 */
export function requestItems(proposals = []) {
  // 거둔 제안(withdrawn — 에이전트가 자기 대기 제안을 거둠)은 항목·셈에서 아예 뺀다. 거르는 자리는 여기 한 곳(web/util.js requestProgress 와 같다)
  const all = (proposals || []).filter((p) => p && p.status !== 'withdrawn');
  // 묶음 제안(p.bundle — 2026-11-17 docs/MCP_REDESIGN_2026-11-16.md §10.4 나-11, docs/UI_TERMS.md §9): 구성원 2개 이상이면 항목 하나. 1개만 남으면 보통 항목
  const bsize = new Map();
  for (const p of all) if (p.gid == null && p.bundle != null) bsize.set(String(p.bundle), (bsize.get(String(p.bundle)) || 0) + 1);
  const items = []; const groups = new Map();
  for (const p of all) {
    const key = p.gid != null ? `g${p.gid}` : p.bundle != null && bsize.get(String(p.bundle)) > 1 ? `b${p.bundle}` : null;
    if (key) {
      let g = groups.get(key);
      if (!g) { g = p.gid != null ? { gid: p.gid, list: [] } : { gid: null, bundle: String(p.bundle), list: [] }; groups.set(key, g); items.push(g); }
      g.list.push(p);
    } else items.push({ gid: null, list: [p] });
  }
  for (const it of items) {
    if (it.bundle != null) {
      // 묶음: 남은(대기 + 아무도 반영해 두지 않은) 구성원이 있으면 남음(일부 반영돼도), 없고 반영이 하나라도 있으면 반영, 그 밖은 거절
      const acc = it.list.filter((p) => p.status === 'applied' || (p.status === 'pending' && isAdopted(p)));
      it.open = it.list.filter((p) => p.status === 'pending' && !isAdopted(p)).map((p) => p.pid).sort((a, b) => a - b);
      if (it.open.length) it.state = 'open';
      else if (acc.length) { const ap = acc.find((p) => p.status === 'applied'); Object.assign(it, { state: 'accepted', via: ap ? 'applied' : 'adopted', pick: ap || acc[0], accepted: acc }); }
      else it.state = 'declined';
      continue;
    }
    const applied = it.list.find((p) => p.status === 'applied');
    const adopted = applied ? null : it.list.find((p) => p.status === 'pending' && isAdopted(p));
    if (applied || adopted) Object.assign(it, { state: 'accepted', via: applied ? 'applied' : 'adopted', pick: applied || adopted });
    else it.state = it.list.some((p) => p.status === 'pending') ? 'open' : 'declined';
    it.open = it.state === 'open' ? it.list.filter((p) => p.status === 'pending').map((p) => p.pid).sort((a, b) => a - b) : [];
  }
  return items;
}

/**
 * 묶음 제안의 머리 이름(web/util.js bundleLabel 과 같은 규칙): 넣기는 '새 문단 50 · 표 2 · 그림 1 넣기', 그 밖은 '바꿈 61곳' · '서식 12곳' ·
 * '개체 지우기 5문단' · '문단 지우기 8곳' · '제안 n건'(나머지 종류) — 여럿이면 ' · ' 로 잇는다
 */
export function bundleLabel(list = []) {
  const n = {};
  const add = (k) => { n[k] = (n[k] || 0) + 1; };
  for (const p of list || []) {
    if (!p) continue;
    const t = p.type || 'replace';
    if (t === 'insert') add('para');
    else if (t === 'table') add('table');
    else if (t === 'figure') add(p.figure?.nativeChart ? 'chart' : p.figure?.replace ? 'figswap' : 'figure');
    else if (t === 'replace') add('replace');
    else if (t === 'format') add('format');
    else if (t === 'delete') add('delete');
    else if (t === 'para_delete') add('paradel');   // 2026-11-17 같은 종류 묶음(server/mcp2/ops.js markBundles (d))
    else add('other');
  }
  const ins = [n.para ? `새 문단 ${n.para}` : '', n.table ? `표 ${n.table}` : '', n.figure ? `그림 ${n.figure}` : '', n.chart ? `차트 ${n.chart}` : ''].filter(Boolean);
  return [ins.length ? `${ins.join(' · ')} 넣기` : '', n.replace ? `바꿈 ${n.replace}곳` : '', n.format ? `서식 ${n.format}곳` : '', n.figswap ? `그림 교체 ${n.figswap}` : '',
    n.delete ? `개체 지우기 ${n.delete}문단` : '', n.paradel ? `문단 지우기 ${n.paradel}곳` : '', n.other ? `제안 ${n.other}건` : ''].filter(Boolean).join(' · ');
}

/**
 * 요청 해결 상태(§9.2) → { items, accepted, applied, adopted, declined, open, comments, resolved, openPids }.
 * applied·adopted = 반영의 나눔(기준 적용 / 수정본에만), openPids = 남은 항목의 대기 제안 pid(묶음이면 그 안들, pid 순),
 * resolved = 요청이 끝났고(완료·취소) 남은 항목이 없음(제안이 없는 완료도 해결)
 */
export function requestOutcome(req, proposals = []) {
  const items = requestItems(proposals);
  const acc = items.filter((x) => x.state === 'accepted');
  const open = items.filter((x) => x.state === 'open');
  return {
    items: items.length, accepted: acc.length,
    applied: acc.filter((x) => x.via === 'applied').length, adopted: acc.filter((x) => x.via === 'adopted').length,
    declined: items.filter((x) => x.state === 'declined').length, open: open.length, comments: (req?.comments || []).length,
    resolved: (req?.status === 'done' || req?.status === 'cancelled') && open.length === 0,
    openPids: open.flatMap((x) => x.open).sort((a, b) => a - b),
  };
}

/** 문서 순서 비교(ref → 구역·본문·중첩 번호) */
const refOrd = (ref) => {
  const m = /^s(\d+)\/p(\d+)((?:\/n\d+)*)/.exec(String(ref ?? ''));
  return m ? [Number(m[1]), Number(m[2]), ...(m[3] ? m[3].split('/n').slice(1).map(Number) : [])] : [Infinity];
};
export function compareRefs(a, b) {
  const x = refOrd(a); const y = refOrd(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] == null) return -1;
    if (y[i] == null) return 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 결과 줄(없으면 null, §9.3-3): 실패 `결과: 실패 — <오류>`; 제안·의견이 없으면 취소 `결과: 취소됨`·완료 `결과: 고칠 곳 없음`·대기·처리 중은 없음.
 * 그 밖에는 `반영 n건`(여러 안 묶음은 `안 3개 중 안 2 반영` 으로 따로) · 고르는 중인 묶음 `안 3개 — 고르는 중` · `남은 제안 n건` ·
 * (제안이 있는데 반영도 남음도 없으면) `반영한 제안 없음` · `의견 n건`. 거절 수·거절한 제안은 적지 않는다. 취소된 요청이면 끝에 ' (취소됨)'
 */
export function requestResultLine(req, proposals = []) {
  if (req.status === 'failed') return `결과: 실패${req.error ? ` — ${clip(req.error, 60)}` : ''}`;
  const items = requestItems(proposals);
  const comments = (req.comments || []).length;
  const files = (req.resultAttachments || []).length;
  if (!items.length && !comments && !files) {
    if (req.status === 'cancelled') return '결과: 취소됨';
    if (req.status === 'done') return '결과: 고칠 곳 없음';
    return null;
  }
  const singles = items.filter((x) => x.gid == null); const groups = items.filter((x) => x.gid != null);
  const parts = [];
  const acc = singles.filter((x) => x.state === 'accepted').length;
  if (acc) parts.push(`반영 ${acc}건`);
  for (const g of groups) if (g.state === 'accepted') parts.push(`안 ${g.list.length}개 중 안 ${g.pick.option ?? '?'} 반영`);
  for (const g of groups) if (g.state === 'open') parts.push(`안 ${g.list.length}개 — 고르는 중`);
  const open = singles.filter((x) => x.state === 'open').length;
  if (open) parts.push(`남은 제안 ${open}건`);
  if (items.length && !items.some((x) => x.state === 'accepted' || x.state === 'open')) parts.push('반영한 제안 없음');
  if (comments) parts.push(`의견 ${comments}건`);
  if (files) parts.push(`결과 파일 ${files}개`);
  return `결과: ${parts.join(' · ')}${req.status === 'cancelled' ? ' (취소됨)' : ''}`;
}

/** 개체 지우기 제안이 지울(지운) 개체: '글상자 206개 · 사각형 51개'(종류 이름은 엔진 ownObjects — 제안할 때 센 것) */
export function deleteSummary(p) {
  const names = Array.isArray(p?.delete?.names) ? p.delete.names.filter((x) => x && x.name) : [];
  if (names.length) return names.map((x) => `${x.name} ${Number(x.n) || 1}개`).join(' · ');
  return `개체 ${Number(p?.delete?.count) || 0}개`;
}

/**
 * 문단 지우기·옮기기 제안(para_delete·para_move — 2026-11-17, server/paragraph-ops.js): '문단 6개 「2) 분석 질문」 부터 지우기',
 * '문단 6개 「4) 학기 유형별 재수강」 부터 옮기기 → 「…」 뒤'(제안할 때 적어 둔 글 — 반영 뒤에도 같다)
 */
export function paragraphsSummary(p) {
  const first = p?.paras?.first?.[0];
  const n = Number(p?.paras?.count) || 0;
  const what = `문단 ${n}개${first ? ` 「${clip(first, 30)}」${n > 1 ? ' 부터' : ''}` : ''}`;
  if (p?.type !== 'para_move') return `${what} 지우기`;
  const d = p.paras?.dest;
  return `${what} 옮기기 → ${d?.before ? `「${clip(d.beforeText || '', 24)}」 앞` : `「${clip(d?.text || '', 24)}」 뒤`}`;
}

/** 작업 기록 메모 반영 목록 줄 수(넘으면 이 줄 수만큼 적고 ' · … 외 n건' 한 줄을 더한다) */
export const ACCEPTED_LIST_MAX = 20;

/** 반영 항목 한 줄: 바꿈 ` · 「a」→「b」`, 여러 안 ` · 안 2: 「a」→「b」`, 문단 추가 ` · 문단 추가 「앞 30자」`, 표 ` · 표 r×c 「캡션」`, 그림 ` · 그림 「캡션」` + 수정본에만 반영이면 꼬리 */
function acceptedLine(it, crOf) {
  const p = it.pick;
  // 묶음 제안(docs/UI_TERMS.md §9)은 한 줄: ' · 새 문단 50 · 표 2 넣기: 문단 추가 「…」 외 52건'(일부만 반영했으면 '(53건 중 40건)')
  if (it.bundle != null) {
    const got = it.accepted?.length || 1; const all = it.list.length;
    const first = acceptedLine({ gid: null, list: [p], pick: p, via: it.via }, crOf).replace(/^ · /, '');
    return ` · ${bundleLabel(it.list)}${got < all ? `(${all}건 중 ${got}건)` : ''}: ${first}${got > 1 ? ` 외 ${got - 1}건` : ''}`;
  }
  let s;
  if (p.type === 'insert') s = p.blank ? ' · 빈 줄 추가' : ` · 문단 추가 「${clip(p.text, 30)}」`;
  else if (p.type === 'edit_batch') s = ` · 내용·형식 묶음(내용 ${p.batch?.contentOperations || 0}건 · 형식 ${p.batch?.formatOperations || 0}건)`;
  else if (p.type === 'format') s = ` · 「${clip(p.find || '빈 문단', 30)}」 서식 변경: ${formatSummary(p.format)}`;
  else if (p.type === 'table') {
    const rows = p.table?.rows || []; const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
    s = ` · 표 ${rows.length}×${cols}${p.table?.caption ? ` 「${clip(p.table.caption)}」` : ''}`;
  } else if (p.type === 'toc') {
    s = ` · 차례 새로 고침${tocExtras(p)}`;
  } else if (p.type === 'delete') {
    s = ` · 개체 지우기: ${deleteSummary(p)}`;
  } else if (p.type === 'para_delete' || p.type === 'para_move') {
    s = ` · ${paragraphsSummary(p)}`;
  } else if (p.type === 'table_edit') {
    s = ` · 표 고치기${p.tableEdit?.caption ? ` 「${clip(p.tableEdit.caption)}」` : ''}: ${clip((p.tableEdit?.labels || []).join(', '), 80)}`;
  } else if (p.type === 'page_layout') {
    s = ` · ${p.pageLayout?.title || '쪽 구성'}: ${(p.pageLayout?.labels || []).join(', ')}`;
  } else if (p.type === 'figure' && p.figure?.nativeChart) {
    s = ` · 편집 가능한 차트(${p.figure.nativeChart.type})${p.figure.caption ? ` 「${clip(p.figure.caption)}」` : ''}`;
  } else if (p.type === 'figure') {
    s = p.figure?.replace ? ` · 그림 교체${p.figure.replace.caption ? ` 「${clip(p.figure.replace.caption)}」` : ''}`
      : ` · 그림${p.figure?.caption ? ` 「${clip(p.figure.caption)}」` : ''}`;
  } else {
    const [a, b] = changeExcerpt(p.find, p.replace);
    s = ` · ${it.gid != null ? `안 ${p.option ?? '?'}: ` : ''}「${a}」→「${b}」`;
  }
  if (p.type !== 'format' && (p.format || p.runs?.length)) s += ` — 서식: ${clip(proposalFormatSummary(p), 120)}`;
  if (it.via === 'adopted') {   // 기준에는 아직 없음(누군가의 수정본에만 반영)
    const cid = crOf(p);
    s += cid != null ? ` — 변경 요청 #${cid}` : ' — 수정본';
  }
  return s;
}

// 메모 이력 줄에 싣는 요청 생애 기록(§9.3-3) — 제안 하나하나의 기록(proposals·apply·reject·undo·proposal-reopen·adopt·edit·comments·summary)은 빼고
// 요청 log 에만 남긴다(웹 AI 작업 탭 '기록'). 옛 자료의 제안 다시 열기(action reopen, detail '#n 다시 열기')도 뺀다
const LIFECYCLE = new Set(['request', 'working', 'done', 'failed', 'cancel', 'retry', 'resolve', 'reopen']);
function lifecycleLog(log) {
  return (log || []).filter((e) => e && LIFECYCLE.has(e.action) && !(e.action === 'reopen' && /^(#\d+|안 \d+) 다시 열기/.test(String(e.detail ?? ''))))
    // 해결·다시 열림은 짧게(해결 기록의 '거절 n' 은 메모에 쓰지 않는다)
    .map((e) => (e.action === 'resolve' ? { ...e, detail: '해결' } : e.action === 'reopen' ? { ...e, detail: '다시 열림' } : e));
}

/**
 * 작업 기록 메모(요청마다 1개, V3 §9.3-3):
 *   [AI 작업 #2] 지시 · 요청 관리자 · 처리 Claude Code
 *   요약: …            지시: …(options.includeInstruction 일 때)            첨부: a.xlsx, b.csv
 *   결과: 반영 14건 · 의견 1건
 *    · 「…」→「…」            (반영 항목만, 문서 순서 — 20줄까지, 넘으면 ' · … 외 n건')
 *    · 「…」→「…」 — 변경 요청 #1   (수정본에만 반영 — 기준에는 아직 없음. 묶인 변경 요청이 없으면 ' — 수정본')
 *   ✓ 해결 · 관리자 10-23 01:16   (해결됐고 resolvedAt 이 있을 때)
 *   이력: 10-23 01:00 요청(관리자) · 01:03 완료(Claude Code) · 01:16 해결(관리자)   (요청 생애 기록 최근 6개)
 *   ── 답글 …            (스레드 블록 — 있으면, §3.6)
 * req: { rid, label, by, handledBy, summary, instruction, options, attachmentInfo|attachmentNames, status, error, comments, log, resolvedAt, resolvedBy }
 * proposals: 이 요청에 딸린 제안 객체들(pid 순)
 * opts.thread: 이 메모의 스레드 { replies, resolved }, opts.outcome: requestOutcome(없으면 셈), opts.crOf(p): 수정본에 반영해 둔 변경 요청 번호|null
 */
export function renderRequestMemo(req, proposals = [], { thread = null, outcome = null, crOf = adoptedCid } = {}) {
  const lines = [];
  lines.push(`[AI 작업 #${req.rid}] ${req.label || kindLabel(req.kind, req.preset)} · 요청 ${req.by}${req.handledBy ? ` · 처리 ${req.handledBy}` : ''}`);
  if (req.summary) lines.push(`요약: ${oneLine(req.summary)}`);
  if (req.options?.includeInstruction && req.instruction) lines.push(`지시: ${oneLine(req.instruction)}`);
  const names = attachmentNames(req);
  if (names.length) lines.push(`첨부: ${names.join(', ')}`);
  const result = requestResultLine(req, proposals);
  if (result) lines.push(result);
  // 반영 목록(실패한 요청이어도 — 앞서 반영한 것은 문서에 들어 있다)
  const acc = requestItems(proposals).filter((x) => x.state === 'accepted')
    .sort((a, b) => compareRefs(a.pick.ref, b.pick.ref) || a.pick.pid - b.pick.pid);
  for (const it of acc.slice(0, ACCEPTED_LIST_MAX)) lines.push(acceptedLine(it, crOf || adoptedCid));
  if (acc.length > ACCEPTED_LIST_MAX) lines.push(` · … 외 ${acc.length - ACCEPTED_LIST_MAX}건`);
  const o = outcome || requestOutcome(req, proposals);
  if (o.resolved && req.resolvedAt) lines.push(`✓ 해결 · ${[shortBy(req.resolvedBy), fmtTime(req.resolvedAt)].filter(Boolean).join(' ')}`);
  const hist = renderHistory(lifecycleLog(req.log), { max: 6, firstDate: true });
  if (hist) lines.push(`이력: ${hist}`);
  return appendThread(xmlSafe(lines.filter((l) => l && l.trim()).join('\n')), thread);
}

/** 요약 꼴 작업 기록 메모의 요약 글자 수 한도(V4 §4.4 — 줄바꿈은 그대로 둔다) */
export const SUMMARY_MEMO_MAX = 600;

/**
 * 작업 기록 메모를 새로 만들지 정한다. 기존 메모 갱신 뒤, 신규 생성 지점에서만 쓴다.
 * none 은 새 자동 메모를 만들지 않으며 기존 메모·답글·사람 메모·AI 확인 의견을 지우지 않는다.
 * summary 는 내용 없는 대기·실행·실패·취소 메모를 미루고, 완료나 부분 결과·공유 요약이 생겼을 때 만든다.
 * detail 은 요청 생애 전체를 기록하는 명시적 선택이므로 대기 때부터 기록한다.
 */
export function shouldCreateRequestMemo(req, proposals = [], mode = 'summary') {
  if (!req || req.memoDeleted || mode === 'none') return false;
  if (mode === 'detail') return true;
  if (req.status === 'done' || proposals.some(Boolean) || req.comments?.length || req.resultAttachments?.length) return true;
  const shared = req.summaryBy === 'user' || req.summaryBy === 'ai' ? req.summary : req.aiSummary;
  return !!xmlSafe(shared).trim();
}

/**
 * 요약 꼴 결과 줄(V4 §4.4, 없으면 null): `결과: 반영 14건 · 의견 1건 · ✓ 해결 10-23 01:16` — 해결 전이면 `· 남은 제안 2건`.
 * 반영한 것이 없으면 `반영한 제안 없음`(제안이 있을 때). 여러 안 묶음도 항목 하나로 센다(반영·남음). 거절 수는 적지 않는다.
 * 제안·의견이 없으면(또는 실패면) V3 §9.3 의 결과 줄 규칙(실패 — 오류 / 취소됨 / 고칠 곳 없음 / 대기·처리 중은 없음). 취소된 요청이면 끝에 ' (취소됨)'
 */
export function requestSummaryResultLine(req, proposals = [], outcome = null) {
  if (req.status === 'failed') return `결과: 실패${req.error ? ` — ${clip(req.error, 60)}` : ''}`;
  const o = outcome || requestOutcome(req, proposals);
  const comments = (req.comments || []).length;
  const files = (req.resultAttachments || []).length;
  if (!o.items && !comments && !files) {
    if (req.status === 'cancelled') return '결과: 취소됨';
    if (req.status === 'done') return '결과: 고칠 곳 없음';
    return null;
  }
  const parts = [];
  if (o.accepted) parts.push(`반영 ${o.accepted}건`);
  else if (o.items && !o.open) parts.push('반영한 제안 없음');
  if (comments) parts.push(`의견 ${comments}건`);
  if (files) parts.push(`결과 파일 ${files}개`);
  if (o.resolved && req.resolvedAt) parts.push(`✓ 해결 ${fmtTime(req.resolvedAt)}`);
  else if (o.open) parts.push(`남은 제안 ${o.open}건`);
  return `결과: ${parts.join(' · ')}${req.status === 'cancelled' ? ' (취소됨)' : ''}`;
}

/** 요약 글: 앞뒤 공백을 걷고 줄바꿈은 그대로(빈 줄은 하나로), SUMMARY_MEMO_MAX 코드포인트까지(넘으면 '…') */
function summaryBlock(s) {
  const t = xmlSafe(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const a = [...t];
  return a.length > SUMMARY_MEMO_MAX ? `${a.slice(0, SUMMARY_MEMO_MAX).join('').trimEnd()}…` : t;
}

/**
 * 요약 꼴 작업 기록 메모(V4 §4.4 aiMemo 'summary' — 기본):
 *   [AI 작업 #2] 홍길동 · 처리 Claude Code
 *   회의록의 회의일자를 2026. 10. 21.(수)로 바꾸고, … 확인이 필요하다는 메모를 남김.     ← 요약(r.summary, 줄바꿈 그대로, 600자까지)
 *   결과: 반영 14건 · 의견 1건 · ✓ 해결 10-23 01:16                                    ← requestSummaryResultLine
 *   ── 답글 …                                                                          ← 스레드 블록(있으면, V3 §3.6)
 * 반영 목록·이력 줄은 없다(자세한 내역은 서버 이력·웹 AI 작업 탭). 자세한 꼴(detail)은 renderRequestMemo(v0.3.1 §9.3-3 그대로)
 */
export function renderRequestSummaryMemo(req, proposals = [], { thread = null, outcome = null } = {}) {
  const lines = [`[AI 작업 #${req.rid}] ${req.by}${req.handledBy ? ` · 처리 ${req.handledBy}` : ''}`];
  const sum = summaryBlock(req.summary || '');
  if (sum) lines.push(sum);
  const result = requestSummaryResultLine(req, proposals, outcome);
  if (result) lines.push(result);
  return appendThread(xmlSafe(lines.filter((l) => l && l.trim()).join('\n')), thread);
}

/** 렌더러가 새로 만든 메모 글 + 스레드 블록(답글도 해결도 없으면 글 그대로). 새로 만든 글이라 옛 블록을 뗄 일이 없다 */
function appendThread(text, thread) {
  const block = thread ? renderThreadBlock(thread) : '';
  return block ? `${text}\n${block}` : text;
}

export function attachmentNames(req) {
  if (Array.isArray(req.attachmentInfo) && req.attachmentInfo.length) return req.attachmentInfo.map((a) => a.name).filter(Boolean);
  if (Array.isArray(req.attachmentNames)) return req.attachmentNames.filter(Boolean);
  return [];
}

function oneLine(s) { return xmlSafe(s || '').replace(/\s*\r?\n\s*/g, ' ').trim(); }

function statusLine(p) {
  if (p.status === 'applied') return `상태: 적용 ✓ ${p.appliedBy || ''} ${fmtTime(p.appliedAt)}`.trim();
  if (p.status === 'rejected') return `상태: 거절 ✗ ${p.rejectedBy || ''} ${fmtTime(p.rejectedAt)}`.trim();
  if (p.status === 'undone') return `상태: 복구 ↶ ${p.undoneBy || ''} ${fmtTime(p.undoneAt)}`.trim();
  if (p.status === 'superseded') return p.supersededByRequest ? `상태: 이전 제안 보관 — AI 작업 #${p.supersededByRequest}에서 재검토` : `상태: 대체됨 — 안 #${p.supersededBy} 적용`;
  return null;
}

/**
 * 제안 메모. request 는 연결된 요청(없으면 null) — 표 제안의 첨부 이름에 쓴다.
 * opts.thread: 이 메모의 스레드 { replies, resolved }(V3 §3.6) — 있으면 글 끝에 스레드 블록을 덧붙인다
 */
export function renderProposalMemo(p, request = null, { thread = null } = {}) {
  const tags = [];
  if (p.type === 'insert') tags.push('문단 추가');
  if (p.type === 'format') tags.push('서식 변경');
  if (p.type === 'edit_batch') tags.push('내용·형식 묶음');
  if (p.type === 'table') tags.push('표 삽입');
  if (p.type === 'table_edit') tags.push('표 고치기');
  if (p.type === 'delete') tags.push('개체 지우기');
  if (p.type === 'para_delete') tags.push('문단 지우기');
  if (p.type === 'para_move') tags.push('문단 옮기기');
  if (p.type === 'toc') tags.push('차례 새로 고침');
  if (p.type === 'page_layout') tags.push(p.pageLayout?.title || '쪽 구성');
  if (p.type === 'figure') tags.push(p.figure?.replace ? '그림 교체' : '그림 삽입');
  if (p.rid != null) tags.push(`AI 작업 #${p.rid}`);
  const lines = [`[제안 ${p.pid}${tags.length ? ' · ' + tags.join(' · ') : ''}] ${p.by}`];
  if (p.type === 'insert' && p.blank) {
    lines.push('이 문단 뒤에 빈 줄');
  } else if (p.type === 'insert') {
    lines.push('이 문단 뒤에 새 문단:');
    lines.push(`「${p.text || ''}」`);
  } else if (p.type === 'format') {
    lines.push(p.find ? `대상: 「${p.find}」` : '대상: 빈 문단');
    lines.push(`서식 변경: ${formatSummary(p.format)}`);
  } else if (p.type === 'table') {
    const rows = p.table?.rows || []; const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
    const names = request ? attachmentNames(request) : [];
    lines.push(`이 문단 뒤에 ${rows.length}×${cols} 표${names.length ? `(첨부 ${names.join(', ')})` : ''}${p.table?.caption ? `: 「${p.table.caption}」` : ''}`);
  } else if (p.type === 'toc') {
    lines.push(`이 차례를 새로 고침${tocExtras(p)}`);
  } else if (p.type === 'delete') {
    lines.push(`이 문단의 개체 지우기: ${deleteSummary(p)}(글은 그대로)`);
  } else if (p.type === 'para_delete' || p.type === 'para_move') {
    lines.push(`이 문단부터 ${paragraphsSummary(p)}`);
  } else if (p.type === 'table_edit') {
    lines.push(`이 표${p.tableEdit?.caption ? ` 「${p.tableEdit.caption}」` : ''} 고치기: ${(p.tableEdit?.labels || []).join(', ')}`);
  } else if (p.type === 'page_layout') {
    lines.push(`${p.pageLayout?.title || '쪽 구성'} 변경: ${(p.pageLayout?.labels || []).join(', ')}`);
  } else if (p.type === 'figure') {
    if (p.figure?.nativeChart) lines.push(`이 문단 뒤에 편집 가능한 한/글 차트(${p.figure.nativeChart.type})${p.figure.caption ? `: 「${p.figure.caption}」` : ''}`);
    else if (p.figure?.replace) lines.push(`이 문단의 그림${p.figure.replace.caption ? ` 「${p.figure.replace.caption}」` : ''}을 새 그림(${p.figure.name || p.figure.aid || '첨부'})으로 교체`);
    else lines.push(`이 문단 뒤에 그림(${p.figure?.name || p.figure?.aid || '첨부'})${p.figure?.caption ? `: 「${p.figure.caption}」` : ''}`);
  } else {
    lines.push(`「${p.find ?? ''}」`);
    lines.push(`→ 「${p.replace ?? ''}」`);
  }
  if (p.type !== 'format' && (p.format || p.runs?.length)) lines.push(`서식: ${proposalFormatSummary(p)}`);
  if (p.reason) lines.push(`이유: ${oneLine(p.reason)}`);
  if (p.note) lines.push(`메모: ${p.note}`);
  const st = statusLine(p);
  if (st) lines.push(st);
  const hist = renderHistory(p.log, { firstDate: false, hideBy: ['propose'] });
  if (hist) lines.push(`이력: ${hist}`);
  return appendThread(xmlSafe(lines.filter((l) => l && l.trim()).join('\n')), thread);
}

/** AI 의견 메모(review 등의 comments) */
export function renderCommentMemo({ rid, author, text }) {
  return xmlSafe(`[AI 의견 · 작업 #${rid}] ${author}\n${String(text || '').trim()}`);
}

/** AI 의견 메모에서 사람이 고칠 본문(머리줄 뺀 글). 머리줄이 없으면 글 전체 */
export function commentBody(text, rid) {
  const s = String(text || '');
  if (!isCommentMemoText(s, rid)) return s;
  const i = s.indexOf('\n');
  return i < 0 ? '' : s.slice(i + 1);
}

/** 고친 본문에 원래 머리줄을 다시 붙인다(새 글이 이미 머리줄로 시작하거나 원래 머리줄이 없으면 그대로) */
export function withCommentHeader(oldText, rid, body) {
  const s = String(oldText || '');
  if (!isCommentMemoText(s, rid) || isCommentMemoText(body, rid)) return body;
  const i = s.indexOf('\n');
  return `${i < 0 ? s : s.slice(0, i)}\n${body}`;
}

// ───────── 메모 스레드(답글·해결) — docs/V3_SPEC.md §3.6 ─────────

/** 스레드 블록 머리줄. 사람 메모의 '본문' = 글에서 이 줄 앞까지 */
export const THREAD_HEAD = '── 답글';

/** 메모 글의 본문(스레드 블록 '── 답글' 줄 앞까지, 끝 줄바꿈은 뺀다). 블록이 없으면 글 전체 */
export function memoBody(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === THREAD_HEAD);
  if (at < 0) return String(text ?? '');
  return lines.slice(0, at).join('\n').replace(/\n+$/, '');
}

/**
 * 스레드 블록(답글·해결 표시). 답글도 해결도 없으면 ''.
 *   ── 답글
 *   ↳ 김검토 10-22 14:03: 근거 확인했습니다
 *   ✓ 해결됨 · 관리자 10-22 14:10
 * thread: { replies: [{ by, at, text }], resolved: null | { by, at } }
 */
export function renderThreadBlock(thread) {
  const replies = Array.isArray(thread?.replies) ? thread.replies : [];
  const resolved = thread?.resolved || null;
  if (!replies.length && !resolved) return '';
  const lines = [THREAD_HEAD];
  const who = (x) => [x?.by || '?', fmtTime(x?.at)].filter(Boolean).join(' ');
  for (const r of replies) lines.push(`↳ ${who(r)}: ${oneLine(r.text)}`);
  if (resolved) lines.push(`✓ 해결됨 · ${who(resolved)}`);
  return xmlSafe(lines.join('\n'));
}

/** 본문 + 스레드 블록(블록이 없으면 본문 그대로). body 에 옛 블록이 섞여 있으면 떼고 붙인다. XML 금지 글자는 뺀다(xmlSafe) */
export function withThread(body, thread) {
  const b = memoBody(xmlSafe(body)); const block = renderThreadBlock(thread);
  if (!block) return b;
  return b ? `${b}\n${block}` : block;
}

// ───────── 변경 요청(CR) 메모 — §3.4·§3.7 ─────────

const CR_STATE = { draft: '수정 중', open: '검토 중' };
// '홍길동(Claude)' 같은 이름은 사람 이름(홍길동)으로 본다
const personOf = (name) => String(name ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();

/** 반영된 덩어리 수 → ['2문단 수정', '1문단 추가', '1문단 삭제', '표 칸 3곳 수정'] */
export function crCountParts({ changed = 0, inserted = 0, deleted = 0, cells = 0 } = {}) {
  const out = [];
  if (changed) out.push(`${changed}문단 수정`);
  if (inserted) out.push(`${inserted}문단 추가`);
  if (deleted) out.push(`${deleted}문단 삭제`);
  if (cells) out.push(`표 칸 ${cells}곳 수정`);
  return out;
}

/**
 * 반영 기록 메모(기준 문서에 남김, §3.4-6):
 *   [변경 요청 #3 반영] 홍길동 — 제목 · 2문단 수정 · 승인 김검토
 * 반영한 사람이 작성자가 아니면 끝에 '· 반영 관리자'.
 */
export function renderCrRecordMemo({ cid, author, title = '', counts = {}, approvers = [], mergedBy = null }) {
  const tail = [
    title ? oneLine(title) : '',
    ...crCountParts(counts),
    approvers.length ? `승인 ${approvers.join(', ')}` : '',
    mergedBy && personOf(mergedBy) !== personOf(author) ? `반영 ${mergedBy}` : '',
  ].filter(Boolean);
  const head = `[변경 요청 #${cid} 반영] ${author}`;
  return xmlSafe(tail.length ? `${head} — ${tail.join(' · ')}` : head);
}

/** 의견 스레드 한 줄 요약: '김검토: 수치 근거? (답 1)' (+ ' (해결)') */
export function crThreadSummary(t) {
  const cs = Array.isArray(t?.comments) ? t.comments : [];
  if (!cs.length) return '';
  const first = cs[0];
  return `${first.by || '?'}: ${clip(first.text, 30)}${cs.length > 1 ? ` (답 ${cs.length - 1})` : ''}${t.resolved ? ' (해결)' : ''}`;
}

/**
 * 한글로 저장(검토본·최종본 + 검토 메모, §3.7)의 덩어리 메모 하나:
 *   [변경 요청 #3 · 검토 중] 홍길동 — 분석 배경 구체화
 *   「원문…」
 *   → 「수정…」
 *   의견: 김검토: 수치 근거? (답 1) · 승인 1
 * 문단 추가는 '이 문단 뒤에 문단 추가: 「…」', 삭제는 '이 문단 지움 제안'.
 * cr: { cid, author, title, status }, hunk: { type, baseText, newText },
 * threads: 이 덩어리(첫 덩어리면 CR 전체 것도)의 스레드, notes: 덧붙일 의견 글(검토 본문 등), approvals·changesRequested: 수
 */
export function renderCrHunkMemo({ cr, hunk, threads = [], notes = [], approvals = 0, changesRequested = 0 }) {
  const lines = [`[변경 요청 #${cr.cid} · ${CR_STATE[cr.status] || '수정 중'}] ${cr.author}${cr.title ? ` — ${oneLine(cr.title)}` : ''}`];
  if (hunk.type === 'insert') lines.push(`이 문단 뒤에 문단 추가: 「${clip(hunk.newText, 40)}」`);
  else if (hunk.type === 'delete') lines.push('이 문단 지움 제안');
  else {
    const [a, b] = changeExcerpt(hunk.baseText, hunk.newText, 40);
    lines.push(`「${a}」`);
    lines.push(`→ 「${b}」`);
  }
  const parts = [...threads.map(crThreadSummary), ...notes.map((n) => oneLine(n))].filter(Boolean);
  if (approvals) parts.push(`승인 ${approvals}`);
  if (changesRequested) parts.push(`수정 요청 ${changesRequested}`);
  if (parts.length) lines.push(`의견: ${parts.join(' · ')}`);
  return xmlSafe(lines.join('\n'));
}

/** 변경 요청 메모인지(반영 기록·검토 메모). cid 를 주면 그 변경 요청의 것만 */
export function isCrMemoText(text, cid) {
  const m = /^\[변경 요청 #(\d+)[ \]·]/.exec(String(text || ''));
  return !!m && (cid == null || Number(m[1]) === Number(cid));
}

/** 메모 글이 이 요청/제안의 메모인지(메모 id 재사용·사람이 바꾼 경우를 거른다) */
export function isRequestMemoText(text, rid) { return String(text || '').startsWith(`[AI 작업 #${rid}]`); }
export function isProposalMemoText(text, pid) { return new RegExp(`^\\[제안 ${pid}(?:[\\] ·])`).test(String(text || '')); }
export function isCommentMemoText(text, rid) { return String(text || '').startsWith(`[AI 의견 · 작업 #${rid}]`); }
