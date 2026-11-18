// AI 작업 진행 기록 — AI 가 요청을 처리하며 부른 도구를 '지금 무슨 일을 하는지' 한 줄씩 남겨 편집기에 실시간으로 보여 준다.
// (2026-11-10) 편집기에는 '처리 중' 칩만 보여, 3~4분 걸리는 전체 검토 동안 무엇을 하는지 알 수 없었다.
// 서버가 아는 것은 MCP 도구 호출뿐이다: 문서 읽기·검색·서식 확인·제안 저장·의견·완료. 모델이 생각하는 시간과
// 에이전트가 제 PC 안에서 하는 일(파이썬 실행·지침 파일 읽기)은 보이지 않는다 — 화면은 앞 단계 뒤로 흐른 시간으로만 보여 준다.
// 줄 글에는 문서 글·지시·검색어·파일 이름을 넣지 않는다(문서를 보는 사람 모두에게 가므로) — 도구 이름에서 나온 낱말과 개수·범위만.
// 메모리에만 둔다(서버를 다시 띄우면 사라진다 — 요청의 제안·의견·이력은 문서에 그대로 남는다).

const count = (list) => (Array.isArray(list) ? list.length : 0);
const okCount = (value) => { const list = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : null; return list ? list.filter((x) => x?.ok !== false).length : null; };

/** 도구 → 줄 글. (인자, 결과 값(객체), 결과 글) → 글. 여기 없는 도구(get_request·list_requests·list_documents·변경 요청·멀티에이전트)는 기록하지 않는다 */
const LABELS = {
  start_request: () => '요청을 맡음',
  claim_next_request: () => '요청을 맡음',
  read_document: (a, v, text) => {
    const m = /^본문 문단 (\d+)개 중 (\d+)\.\.(\d+)/.exec(text || '');
    return m ? `문서 읽기 · 본문 ${m[2]}~${m[3]}번 문단(모두 ${m[1]}개)` : '문서 읽기';
  },
  search_document: (a, v) => (Array.isArray(v) ? `문서 검색 · ${v.length}곳` : '문서 검색'),
  get_formatting: (a) => (count(a?.refs) ? `서식 확인 · 문단 ${count(a.refs)}개` : '서식 확인'),
  get_writing_guide: () => '표준서식 작성 지침 확인',
  get_page_layout: () => '쪽 구성 확인',
  list_memos: () => '메모 확인',
  list_proposals: () => '제안 목록 확인',
  list_tables: (a, v) => `표 목록 확인${v?.total != null ? ` · 전체 ${v.total}개` : ''}`,
  get_edit_workspace: a => `작업 사본 읽기 · ${a?.part === 'format' ? '형식' : a?.part === 'mapping' ? '주소' : '내용'}`,
  get_edit_capabilities: () => '실험 편집 기능 확인',
  edit_workspace: a => `작업 사본 수정 · ${a?.stage === 'format' ? '형식' : '내용'}${a?.complete_stage ? ' 단계 완료' : ''}`,
  publish_edit_workspace: () => '내용·형식 묶음 제안 저장',
  list_changes: () => '변경 추적 확인',
  list_attachments: () => '첨부 목록 확인',
  read_attachment: () => '첨부 읽기',
  read_skill_resource: () => '스킬 자료 읽기',
  export_skill_resource: () => '스킬 파일 꺼내기',
  list_figures: (a, v) => (Array.isArray(v) ? `그림 목록 확인 · ${v.length}개` : '그림 목록 확인'),
  preview_figure: () => '그림 미리보기',
  export_figure: () => '문서 그림 꺼내기',
  get_history: () => '문서 이력 확인',
  get_attachment_file: () => '첨부 원본 받기',
  save_result_file: () => '결과 파일 저장',
  propose_change: () => '수정 제안 1건',
  propose_changes: (a, v) => {
    const all = count(a?.proposals); const ok = okCount(v);
    return ok != null && ok < all ? `수정 제안 ${ok}건(${all - ok}건은 다시 내야 함)` : `수정 제안 ${all}건`;
  },
  propose_format: () => '서식 제안',
  propose_alternatives: (a) => `여러 안 ${count(a?.options)}개`,
  propose_insert: (a) => `문단 추가 ${count(a?.paragraphs) || 1}개`,
  propose_table: () => '표 제안',
  propose_table_edit: () => '표 고치기 제안',
  propose_chart: () => '편집 가능한 차트 제안',
  propose_delete: (a) => `개체 지우기 제안${Array.isArray(a?.refs) && a.refs.length > 1 ? ` ${a.refs.length}곳` : ''}`,
  propose_toc_update: () => '차례 새로 고침',
  list_fields: (a, v) => (Array.isArray(v) ? `누름틀 확인 · ${v.length}칸` : '누름틀 확인'),
  propose_fill_fields: (a, v) => {
    const all = count(a?.fields); const ok = okCount(v);
    return ok != null && ok < all ? `누름틀 채우기 ${ok}칸(${all - ok}칸은 다시 내야 함)` : `누름틀 채우기 ${all}칸`;
  },
  propose_page_layout: () => '쪽 구성 제안',
  propose_figure: (a) => (a?.replace_ref ? '그림 교체 제안' : '그림 제안'),
  add_memo: (a) => (a?.reply_to ? '답글' : '의견 남김'),
  complete_request: () => '완료',
  fail_request: () => '실패로 기록',
  // 새 MCP 연결(server/mcp2.js — 도구 넷): 맡기·읽기·고치기·끝내기. 줄 글에는 보기 이름·범위 주소·op 종류와 수만 싣는다
  task: () => '요청을 맡음',
  read: (a) => {
    const view = READ_VIEWS[a?.view || 'text'] || '문서 읽기';
    const at = typeof a?.at === 'string' && /^[s\d/p.*]+$/.test(a.at) ? ` · ${a.at}` : '';
    return `${view}${at}${a?.cursor ? ' · 이어 읽기' : ''}`;
  },
  edit: (a, v) => {
    const tally = new Map();
    for (const op of Array.isArray(a?.ops) ? a.ops : []) {
      const k = op?.op === 'styles' && op.update?.length ? '스타일 수정'
        : op?.op === 'styles' && op.define?.length ? '스타일 생성' : EDIT_OPS[op?.op] || '고치기';
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    const what = [...tally].map(([k, c]) => (c > 1 ? `${k} ${c}` : k)).join(' · ') || '고치기';
    const failed = count(v?.failed);
    // 2026-11-17(§10.4 나-4): 저장 단계에서 실패하면 아무것도 저장하지 않는다(dry_run 이 아니면 '저장 안 됨')
    // 2026-11-17(Z03 — artifacts/mcp-round3-20261117/codex/REPORT-G4.md 문제 2): '조판 확인' 줄은 반영 전 쪽 수라, 영수증 pages(server/page-estimate.js)의
    // all_applied 가 now 와 다르면 '모두 반영하면 N쪽' 을 붙인다(숫자만). pages 가 없거나 skipped 면 그대로
    const pg = v?.pages;
    const after = pg && !pg.skipped && Number.isInteger(pg.now) && Number.isInteger(pg.all_applied) && pg.all_applied !== pg.now ? ` · 모두 반영하면 ${pg.all_applied}쪽` : '';
    return `${a?.dry_run ? '미리 해 보기 · ' : ''}${what}${failed ? (a?.dry_run ? `(${failed}건은 다시 내야 함)` : `(${failed}건 때문에 저장 안 됨 — 다시 내야 함)`) : ''}${after}`;
  },
  // 2026-11-17(작업 Q): 결과를 저장한 요청은 summary+error 여도 완료로 닫는다(server/mcp2/service.js agentFinish) — 완료면 activityItem 이 ' · 완료' 를 붙인다
  finish: (a, v) => (v?.completed === true ? (a?.error ? '못 한 것을 요약에 적음' : '요약 남김') : a?.error ? '실패로 기록' : '완료'),
};
const READ_VIEWS = { text: '문서 읽기', layout: '개체 배치 읽기', outline: '제목 얼개 확인', map: '문서 얼개 확인', tables: '표 확인', objects: '개체 확인', format: '서식 확인', memos: '메모 확인',
  proposals: '제안 목록 확인', changes: '변경 추적 확인', fields: '누름틀 확인', figures: '그림 목록 확인', attachments: '첨부 목록 확인', attachment: '첨부 읽기', page: '쪽 구성 확인', styles: '스타일 확인', guide: '작성 지침 확인', history: '문서 이력 확인', requests: '요청 목록 확인' };
const EDIT_OPS = { replace: '수정 제안', insert: '문단 추가', table: '표 제안', table_edit: '표 고치기', format: '서식 제안', delete_objects: '개체 지우기', delete_paragraphs: '문단 지우기', move_paragraphs: '문단 옮기기', alternatives: '여러 안', memo: '의견', fill: '누름틀 채우기', toc: '차례 새로 고침',
  chart: '차트 제안', figure: '그림 제안', objects_to_body: '개체 → 본문', paper: '쪽 구성', section: '쪽 구성', split_section: '쪽 구성', merge_section: '쪽 구성', header: '쪽 구성', footer: '쪽 구성', page_number: '쪽 구성', master_page: '쪽 구성',
  replace_all: '일괄 바꾸기', withdraw: '제안 거두기', styles: '스타일 들여오기', restyle: '서식 제안' };   // 2026-11-17 MCP_REDESIGN §10.4 나-6·나-4

/** 기록할 도구인가 */
export const isActivityTool = (tool) => Object.hasOwn(LABELS, tool);

/**
 * 도구 호출 하나 → 진행 기록 줄 { tool, label, ok } 또는 null(기록하지 않는 도구).
 * 실패는 오류 코드만 덧붙인다(오류 글에는 문서 글이 들어 있을 수 있다)
 */
export function activityItem(tool, args, { value = null, text = '', isError = false } = {}) {
  if (!isActivityTool(tool)) return null;
  let label;
  try { label = LABELS[tool](args || {}, value, text); } catch { label = tool; }
  if (isError) {
    const code = /^오류\(([A-Z_]+)\)/.exec(text || '')?.[1];
    return { tool, label: `${label} — 안 됨${code ? `(${code})` : ''}`, ok: false };
  }
  // 쓰기에 complete 를 함께 준 호출(lean): 저장 뒤 완료까지 했다
  const completed = value && typeof value === 'object' && value.completed === true;
  return { tool, label: completed ? `${label} · 완료` : label, ok: true };
}

/** 요청별 진행 기록(메모리). 요청 하나에 perRequest 줄, 모두 maxRequests 요청까지 — 넘치면 오래된 것부터 버린다 */
export class RequestActivity {
  constructor({ perRequest = 300, maxRequests = 300 } = {}) { this.perRequest = perRequest; this.maxRequests = maxRequests; this.map = new Map(); this.seq = 0; }
  key(docId, rid) { return `${docId}\u0000${Number(rid)}`; }
  add(docId, rid, item, at = new Date().toISOString()) {
    const k = this.key(docId, rid);
    let list = this.map.get(k);
    if (!list) { list = []; this.map.set(k, list); while (this.map.size > this.maxRequests) this.map.delete(this.map.keys().next().value); }
    else { this.map.delete(k); this.map.set(k, list); }   // 최근에 쓴 요청을 뒤로
    const row = { n: ++this.seq, at, ...item };
    list.push(row);
    if (list.length > this.perRequest) list.splice(0, list.length - this.perRequest);
    return row;
  }
  list(docId, rid) { return [...(this.map.get(this.key(docId, rid)) || [])]; }
  /** 요청을 다시 맡길 때(다시 요청) 앞 시도의 기록을 비운다 */
  clear(docId, rid) { this.map.delete(this.key(docId, rid)); }
}
