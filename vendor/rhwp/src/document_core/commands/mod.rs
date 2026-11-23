// [#6840] 발췌 산출물에서 참조 없는 BinData 를 버린다 — 쪽을 잘라도 파일이 줄지 않던 문제.
pub(crate) mod bin_data_prune;
mod border_paint_bands;
pub(crate) mod border_paint_edit;
mod border_paint_structure;
// 한/글 글머리표·그림 글머리표 사용자 정의 모양.
mod bullet_create;
mod clipboard;
// [hwpx-cowork] 조판 부호(자동 번호·새 번호 등) 찾기·지우기·고치기
mod code_controls;
// [hwpx-cowork] Share the exact body/cell paragraph target parser with metric preparation.
pub(crate) use code_controls::CodeTarget;
mod clone_identity;
// 덧말·글자 겹침 넣기와 고치기.
mod compose_controls;
pub use compose_controls::ComposeHost;
// [#5769] 삭제의 참 역연산 — 조각 저장소. DeleteFragment 타입이 DocumentCore
// 필드로 쓰이므로 pub(crate).
pub(crate) mod delete_fragment;
mod document;
pub(crate) use document::HwpExportSnapshot;
mod source_line_ladder;
// [jb] 외부 문서(다른 서식표)를 커서에 끼워 넣기 — 한글 클립보드 문서모델 붙여넣기용
mod cell_format_origin;
mod footnote_ops;
mod foreign_paste;
pub(super) mod formatting; // [hwpx-cowork] 단일 문단과 범위 서식이 같은 줄 재계산 조건을 쓴다.
// [hwpx-cowork] 한/글 2022 편집·입력(날짜/시간 코드)
mod h2022_edit;
mod formatting_runs;
// [hwpx-cowork] 한/글로 보내는 복사 조각의 기본 스타일 정의 — 붙일 때 글꼴·크기가 받는 문서 스타일로 바뀌지 않게
pub(crate) mod hancom_paste_styles;
mod header_footer_ops;
mod html_import;
mod numbering_char_shape;
mod object_ops;
pub(crate) mod paragraph_block;
mod paragraph_format_path;
pub use object_ops::{TableColumnWidths, TableCreationOptions};
pub(crate) mod picture_transform_journal;
// [#3565] 대형 문서 결함을 이분법으로 좁히기 위한 쪽 범위 추출.
pub mod page_extract;
// [hwpx-cowork] 구역을 넘는 편집의 구역 합치기·나누기(docs/SECTIONS.md)
pub(crate) mod section_structure;
mod table_formula;
// [hwpx-cowork] 한/글 2022 표 기능(계산식 다시 계산 고리·자릿점·문자열↔표)
mod h2022_table;
// [hwpx-cowork] 한/글 2022 개체 기능(순서·보호·글 앞/뒤·개체 모양 복사)
pub(crate) mod h2022_object;
// [hwpx-cowork] 한/글 2022 서식·쪽(현재 다단·다단 설정 나누기·쪽 번호 시작 번호·번호 수준)
mod h2022_format;
// 구역 나누기·합치기 — 한/글 [쪽-구역 나누기]와 구역 경계 지우기.
mod section_ops;
mod table_ops;
mod table_paste; // [hwpx-cowork] 한/글의 셀 블록 복사와 셀 붙이기
mod text_editing;
pub(crate) use text_editing::PageBreakUndo; // [hwpx-cowork] 쪽 나누기 전용 선형 실행 취소
// [hwpx-cowork] 글상자 높이 자동 늘림(한/글 protect=0 규칙) — 조판 준비 때 한 번
mod textbox_autogrow;
// [hwpx-cowork] 묶음 조판 높이 = 자식 범위(한/글 실측)
mod group_extent;
// [hwpx-cowork] 차례 만들기·새로 고침·제목 차례 표시(한/글 '도구 > 차례/색인')
pub(crate) mod toc;
// [#5769] Stage 4 — 구역 raw 저널. SectionRawCapture 타입이 DocumentCore 필드로
// 쓰이므로 pub(crate).
pub(crate) mod section_raw_journal;
