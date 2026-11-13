// MCP 도구 노출 범위(프로필) — 실행기 허용 목록의 단일 출처(docs/MCP_TOOLSET_PLAN_2026-11-03.md §4.7·§10.3).
// API 실행기(OpenAI·Claude·Gemini API — 개인 실행기·서버 개인 키·서버 공용 AI)와 Codex CLI 실행기가 같은 목록을 읽는다.
// 실행기는 문서·요청·시도를 고정(bind)하고, 사람이 정할 일(반영·수락·거절·되돌리기)은 맡지 않는다.

/** 배정된 문서 안 읽기(doc_id 고정) */
export const DOC_READ = Object.freeze(['read_document', 'search_document', 'get_formatting', 'get_writing_guide', 'get_page_layout', 'read_skill_resource',
  'list_memos', 'list_proposals', 'list_changes', 'list_attachments', 'read_attachment', 'list_figures', 'preview_figure', 'get_history', 'list_fields']);
/** 배정된 요청 읽기(request_id 고정) */
export const REQUEST_READ = Object.freeze(['get_request']);
/** 요청에 묶이는 결과 쓰기(request_id·expected_attempt 고정 — 쓰기 직전에 취소·재시도를 확인) */
export const REQUEST_WRITE = Object.freeze(['propose_change', 'propose_changes', 'propose_format', 'propose_alternatives', 'propose_insert', 'propose_table',
  'propose_table_edit', 'propose_delete', 'propose_toc_update', 'propose_page_layout', 'propose_chart', 'propose_figure', 'propose_fill_fields', 'add_memo', 'export_figure', 'export_skill_resource']);
/** 요청 맡기·완료·실패 — API 실행기는 실행기가 직접 부른다(모델에는 주지 않음) */
export const REQUEST_FLOW = Object.freeze(['start_request', 'complete_request', 'fail_request']);
/** 개인 브리지(--files-dir)의 내 PC 작업 폴더 파일 도구 */
export const LOCAL_FILES = Object.freeze(['download_attachment_file', 'upload_result_file']);
/** 오케스트레이션 작업 하나(Codex 작업자) — 그 밖의 *_orchestration_* 도구는 지휘·관리용 */
export const ORCHESTRATION_TASK = Object.freeze(['get_orchestration_run', 'get_orchestration_profile', 'plan_orchestration_run', 'submit_orchestration_task']);

/**
 * 실행기에 주지 않는 도구와 그 까닭. 새 MCP 도구는 프로필 또는 여기 중 한 곳에 넣는다(tests/api_tool_providers.test.mjs 가 빠진 도구를 잡는다)
 */
export const RUNNER_EXCLUDED = Object.freeze({
  create_document: '배정 문서 외 새 문서 생성 — Work 전역 사용자 명시 요청용',
  list_documents: '다른 문서', list_requests: '다른 요청', claim_next_request: '다른 요청 — 맡기는 실행기가 한다',
  update_memo: '남의 메모 고치기', delete_memo: '메모 지우기',
  apply_proposal: '사람이 반영', reject_proposal: '사람이 거절', undo_proposal: '사람이 되돌림', accept_change: '사람이 수락', reject_change: '사람이 거절',
  list_change_requests: '요청 밖 작업(변경 요청 검토)', get_change_request: '요청 밖 작업(변경 요청 검토)', comment_change_request: '요청 밖 작업(변경 요청 검토)', review_change_request: '요청 밖 작업(변경 요청 검토)',
  get_attachment_file: 'ChatGPT Work 전용 파일 참조', save_result_file: 'ChatGPT Work 전용 파일 참조',
  get_drive_context: '드라이브(AI 꺼짐)', propose_drive_upload: '드라이브(AI 꺼짐)', prepare_drive_file: '드라이브(AI 꺼짐)',
});

export const TOOL_PROFILES = Object.freeze({
  // API 실행기: 읽기·결과 쓰기. 요청 흐름은 실행기, 파일은 실행기가 원본 바이트로 저장(api-responses-agent).
  // propose_change 는 propose_changes(항목 하나)와 같은 일이라 뺀다 — API 는 라운드마다 도구 정의를 다시 보낸다(약 4천 자)
  api: Object.freeze([...DOC_READ, ...REQUEST_READ, ...REQUEST_WRITE.filter(name => name !== 'propose_change')]),
  // Codex CLI: 같은 도구 + 스스로 시작·완료·실패 + 내 PC 작업 폴더 파일
  codex: Object.freeze([...DOC_READ, ...REQUEST_READ, ...REQUEST_FLOW, ...REQUEST_WRITE, ...LOCAL_FILES]),
});

/** 시각화·그림을 맡긴 지시인지(그림 없이 끝나면 이유를 남긴다 — api-tool-loop) */
export const visualRequest = instruction => /시각화|그래프|차트|도식|다이어그램|흐름도|순서도|개념도|구조도|모식도|인포그래픽|그림.*(?:그려|생성|만들|작성|수정|바꿔|바꾸|변환|교체|옮겨)|(?:그려|생성|만들|작성|수정|교체).*그림|그림으로|visuali[sz]|plot|chart|diagram/i.test(instruction || '');

/** 쓰기(제안·메모·첨부 만들기)인지 — 같은 실행 안의 같은 호출은 한 번만 저장한다 */
export const isWriteTool = name => REQUEST_WRITE.includes(name) || name === 'upload_result_file';
