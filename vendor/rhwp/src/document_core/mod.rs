//! 문서 핵심 도메인 모델
//!
//! HWP 문서의 도메인 상태와 로직을 캡슐화한다.
//! WASM/PyO3/MCP 등 어떤 어댑터에서도 독립적으로 사용할 수 있다.

pub(crate) mod helpers;
pub(crate) use helpers::*;

/// 문단 서식 JSON(`--props` 등)이 바꿀 속성을 하나라도 담는지 (#8439). 어댑터가 아무 키도
/// 읽지 못한 입력을 성공으로 처리하지 않도록 미리 확인할 때 쓴다.
pub fn para_format_props_have_effect(props_json: &str) -> bool {
    helpers::para_format_props_have_effect(props_json)
}

/// 글자 서식 JSON 이 바꿀 속성을 하나라도 담는지 (#8439).
pub fn char_format_props_have_effect(props_json: &str) -> bool {
    helpers::char_format_props_have_effect(props_json)
}

#[cfg(feature = "pdf-import")]
mod pdf_import_session;
#[cfg(feature = "pdf-import")]
pub use pdf_import_session::PdfImportSession;

pub mod builders;
mod canvas_metric_requests;
mod canvas_metrics;
mod native_pua_fonts;
pub use native_pua_fonts::NativePuaFontRequest;
mod font_environment;
// [hwpx-cowork] 문서 열기의 읽기 전용 미리보기와 최종 조판 작업.
mod progressive_open;
pub(crate) mod master_edit; // [hwpx-cowork] 실제 바탕쪽·표 셀·글상자 원본 주소
mod interactive_layout; // [hwpx-cowork] 편집 원본과 마지막 발행된 쪽의 수명을 구분한다.
pub(crate) mod range_format;
// [hwpx-cowork] 2026-11-20 뒤쪽 미루기 — 편집한 쪽 근처까지만 바로 조판하고 나머지는 쉬는 동안.
mod typeset_tail;
mod table_window; // [hwpx-cowork] 표 중간 칸의 쪽 우선 조판
mod flow_window; // [hwpx-cowork] 독립된 본문 흐름 구간의 구조 편집
pub use typeset_tail::TypesetTailState;
mod note_pages; // [hwpx-cowork] 쪽마다 새로 각주 번호
mod host_font_environment;
mod loaded_frame_restore;
mod table_reflow_owners;
mod tac_host_rows;
pub use canvas_metric_requests::{CanvasMetricBatch, CanvasMetricReply, CanvasMetricRequest};
pub use host_font_environment::{
    DeclaredFontFallbackRequest, ObservedFontFallback, ObservedFontSource,
};
mod commands;
pub use commands::paragraph_block::{
    FillTemplateRequest, FillTemplateResult, ImportParagraphBlockLimits,
    ImportParagraphBlockPreview, ImportParagraphBlockRequest, ImportParagraphBlockResult,
    ImportResourceCounts, ParagraphBlockBudget, ParagraphBlockCopy, ParagraphBlockLimits,
    ParagraphBlockMapping, ParagraphBlockPathStep, ParagraphBlockValidationError,
    RepeatParagraphBlockRequest, RepeatParagraphBlockResult, RepeatTableRowsRequest,
    RepeatTableRowsResult, TemplateBinding, TemplateFillPreview, TemplateFillRequest,
    TemplateFillTarget, TemplateOperation, TemplateOperationResult, TemplateScope,
    TEMPLATE_REQUEST_MAX_BYTES,
};
pub use commands::{ComposeHost, TableColumnWidths, TableCreationOptions};
pub mod converters;
pub(crate) mod html_table_import;
mod html_table_width;
/// 한글 클립보드 문서모델(hwpjson) → HWPX 변환
pub mod hwpjson;
pub mod hyperlink;
pub mod inline_control;
pub mod native_interaction;
pub mod queries;
pub mod table_calc;
pub mod text_security;
pub mod validation;

use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::event::DocumentEvent;
use crate::model::header_footer::HeaderFooterApply;
use crate::model::paragraph::Paragraph;
use crate::model::table::TableTransposeData;
use crate::paint::PageLayerTree;
use crate::renderer::composer::ComposedParagraph;
use crate::renderer::height_measurer::{MeasuredSection, MeasuredTable};
use crate::renderer::layout::LayoutEngine;
use crate::renderer::pagination::PaginationResult;
use crate::renderer::render_normalization::{RenderNormalizationOverlay, RenderPath};
use crate::renderer::render_tree::PageRenderTree;
use crate::renderer::style_resolver::ResolvedStyleSet;
use crate::renderer::typeset::ResumableTablePaginationJob;
use crate::renderer::DEFAULT_DPI;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// 기본 폰트 fallback 경로
pub const DEFAULT_FALLBACK_FONT: &str = "/usr/share/fonts/truetype/nanum/NanumGothic.ttf";
pub(crate) const TABLE_CAPTION_CELL_SENTINEL: usize = 65_534;

/// Studio/WASM의 `applyTo` 숫자를 core 열거형으로 변환한다.
///
/// 공개 API의 기존 호환 규칙대로 1=짝수, 2=홀수, 나머지는 양쪽이다.
pub(crate) fn header_footer_apply_from_u8(value: u8) -> HeaderFooterApply {
    match value {
        1 => HeaderFooterApply::Even,
        2 => HeaderFooterApply::Odd,
        _ => HeaderFooterApply::Both,
    }
}

/// core 열거형을 Studio/WASM의 `applyTo` 숫자로 변환한다.
pub(crate) fn header_footer_apply_to_u8(value: HeaderFooterApply) -> u8 {
    match value {
        HeaderFooterApply::Both => 0,
        HeaderFooterApply::Even => 1,
        HeaderFooterApply::Odd => 2,
    }
}

/// 내부 클립보드 데이터
pub(crate) struct ClipboardData {
    /// 복사된 문단들 (서식 정보 포함)
    pub(crate) paragraphs: Vec<Paragraph>,
    /// [hwpx-cowork] Whole-section source before edit-oriented structural
    /// stripping. Standalone portable export can keep its valid saved rows;
    /// internal insertion continues to use `paragraphs` and its reflow state.
    pub(crate) source_section_paragraphs: Option<Vec<Paragraph>>,
    /// [hwpx-cowork] HTML 표시용 자동 쪽 경계. 원본 문단의 강제 나누기와 구분한다.
    pub(crate) presentation_page_breaks: Vec<usize>,
    /// 플레인 텍스트
    pub(crate) plain_text: String,
    /// The copied control owns renderer text-reflow provenance that must be
    /// inherited by a pasted table clone.
    pub(crate) copied_table_text_reflowed: bool,
    /// [hwpx-cowork] 본문 구역 맨 처음부터 복사했는지 — 한글 문서모델에 원본 구역 정의를 실을지 정한다.
    pub(crate) section_start: bool,
    /// [hwpx-cowork] 복사한 구역 번호 — 구역 전체 복사 조각에 그 구역의 구역 정의·바탕쪽을 싣는다.
    pub(crate) section_idx: usize,
}

/// 표 셀 행/열 바꿈 전용 내부 버퍼
pub(crate) struct TableTransposeClipboard {
    pub(crate) data: TableTransposeData,
}

/// [#2424] deferred cell edit가 이후 pagination job에 넘기는 최소 target descriptor.
///
/// resumable engine이 붙기 전까지 실제 flush는 기존 동기 `paginate()`를 사용하며,
/// 성공한 pagination은 이 descriptor를 소비한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeferredPaginationDescriptor {
    pub(crate) revision: u64,
    pub(crate) section_index: usize,
    pub(crate) para_index: usize,
    pub(crate) control_index: usize,
    pub(crate) cell_index: usize,
    pub(crate) cell_para_index: usize,
    pub(crate) cell_flow_changed: bool,
    /// 기존 pagination에서 target table의 첫 fragment가 있던 global page.
    /// 실제 최초 changed fragment는 synchronous oracle 비교 뒤 더 좁힌다.
    pub(crate) target_first_page: Option<u32>,
    pub(crate) table_structure_fingerprint: u64,
}

/// [#2424] pending pagination job이 descriptor 좌표를 다시 조회한 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeferredPaginationTargetStatus {
    Current,
    Superseded,
    TargetMissing,
    StructureChanged,
}

/// [hwpx-cowork] 2026-11-20 구역 조판 체크포인트와 그것을 만든 입력의 표지. 표지가 지금과 다르면 쓰지 않는다.
pub(crate) struct TypesetCheckpointStore {
    pub(crate) checkpoints: crate::renderer::typeset::SectionCheckpoints,
    /// 그때의 원본 문단·구성 목록 주소. 알려진 문단 넣기·지우기만 갱신한다 — 다른 길(문서 교체·구역 재구성)로
    /// 목록이 바뀌면 주소가 달라져 다시 쓰지 않는다.
    pub(crate) paragraphs_ptr: usize,
    pub(crate) composed_ptr: usize,
    /// 측정 환경 표지(`layout_environment_stamp`)와 쪽 나눔 선택.
    pub(crate) environment: u64,
    pub(crate) layout_generation: u64,
    pub(crate) respect_vpos_reset: bool,
    pub(crate) normalized: bool,
}

/// [hwpx-cowork] 2026-11-20 앞쪽 재사용의 켜고 끄기·검증 모드·통계.
#[derive(Default)]
pub(crate) struct TypesetResumeControl {
    pub(crate) disabled: std::cell::Cell<bool>,
    pub(crate) verify: std::cell::Cell<bool>,
    pub(crate) resumed: std::cell::Cell<u64>,
    pub(crate) full: std::cell::Cell<u64>,
    pub(crate) skipped_paragraphs: std::cell::Cell<u64>,
    pub(crate) verify_checks: std::cell::Cell<u64>,
    pub(crate) verify_mismatches: std::cell::Cell<u64>,
    pub(crate) first_mismatch: std::cell::RefCell<Option<String>>,
    /// [hwpx-cowork] 2026-11-20 뒤쪽을 미룬 조판 수와 쉬는 동안 마무리한 수(`typeset_tail`).
    pub(crate) tail_parked: std::cell::Cell<u64>,
    pub(crate) flow_window_edits: std::cell::Cell<u64>, // [hwpx-cowork]
    pub(crate) table_windows: std::cell::Cell<u64>, // [hwpx-cowork] 실제 표 조각 발행 수·최근 작업량
    pub(crate) window_pages: std::cell::Cell<usize>,
    pub(crate) table_paints: std::cell::Cell<u64>, // [hwpx-cowork] 측정한 행 조각으로 실제 그린 쪽
    pub(crate) window_rows: std::cell::Cell<usize>,
    pub(crate) tail_completed: std::cell::Cell<u64>,
    /// 문단 내용으로 찾는 조판 기억을 버린 횟수(스타일·글꼴 측정 환경 변경). 체크포인트는 같은 세대에서만 쓴다.
    pub(crate) layout_generation: std::cell::Cell<u64>,
}

pub(crate) struct PendingPaginationJob {
    pub(crate) descriptor: DeferredPaginationDescriptor,
    pub(crate) renderer_job: ResumableTablePaginationJob,
    pub(crate) measured: MeasuredSection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeferredPaginationJobState {
    None,
    Pending,
    Complete,
    Fallback,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeferredPaginationStepResult {
    pub state: DeferredPaginationJobState,
    pub revision: u64,
    pub fragments_processed: usize,
    pub page_count: u32,
}

pub(crate) struct RenderNormalizedSection {
    pub(crate) source_revision: u64,
    pub(crate) paragraphs: Arc<Vec<Paragraph>>,
    pub(crate) composed: Arc<Vec<ComposedParagraph>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct TableTextReflowKey(usize);

impl TableTextReflowKey {
    pub(crate) fn from_table(table: &crate::model::table::Table) -> Self {
        Self(table as *const crate::model::table::Table as usize)
    }
}

#[derive(Default)]
pub(crate) struct RenderNormalizationState {
    pub(crate) document_epoch: u64,
    pub(crate) section_revisions: Vec<u64>,
    pub(crate) sections: Vec<Option<RenderNormalizedSection>>,
    /// [hwpx-cowork] 2026-11-10 P1 성능: 정규화를 계산했으나 투영이 필요 없었던(`None`) 구역의 그때
    /// source revision. `sections[i] == None` 은 "아직 안 셈" 과 "셈했고 바꿀 것 없음" 을 가르지 못해
    /// 점진 열기 마무리 조판이 같은 입력의 정규화를 한 번 더 계산했다(59쪽 보고서 ≈270ms). 이 기록은
    /// 점진 열기 마무리 pass(`progressive_open_completed` 가 있는 pass — 같은 입력의 측정·조판 결과도
    /// 그대로 재사용하는 pass)에서만 읽는다. `sections` 를 비우는 곳에서 함께 비운다.
    pub(crate) unprojected_revisions: Vec<Option<u64>>,
    pub(crate) path_revisions: HashMap<RenderPath, u64>,
    /// Stable live Box identities whose stored frame was superseded by text
    /// reflow. Box pointees survive paragraph/control-vector moves; clones are
    /// admitted only by explicit split/clipboard inheritance.
    pub(crate) text_reflowed_tables: table_reflow_owners::TableReflowOwners,
    pub(crate) loaded_frames: Option<loaded_frame_restore::LoadedFrames>,
    pub(crate) overlay: Arc<RenderNormalizationOverlay>,
}

// [hwpx-cowork] 범용 ID는 전체 상태를, 편집기가 쪽 나누기를 위해 요청한 ID는
// 그 명령의 선형 Undo를 제공한다. 축출·해제·redo의 수명은 같다.
#[derive(Clone)]
pub(crate) enum UndoSnapshot {
    Full(Box<Document>, std::collections::HashSet<RenderPath>),
    PageBreak(Box<commands::PageBreakUndo>),
    InsertRow(Box<table_window::InsertRowUndo>), // [hwpx-cowork]
    RedoRow(Box<table_window::InsertRowRedo>),   // [hwpx-cowork] Undo 직전의 행 상태
}

/// HWP 문서 핵심 도메인 모델
///
/// 문서 데이터, 레이아웃 상태, 설정, 캐시를 포함한다.
/// WASM 바인딩 없이 순수 Rust 타입만 사용한다.
pub struct DocumentCore {
    /// [hwpx-cowork] 나뉜 칸 미룬 개체 띠 표의 문서 키(`renderer::layout::split_cell_doc_scope`).
    pub(crate) split_cell_doc_id: u64,
    /// IR 문서
    pub(crate) document: Document,
    /// 페이지 분할 결과
    pub(crate) pagination: Vec<PaginationResult>,
    /// 해소된 스타일 세트
    pub(crate) styles: ResolvedStyleSet,
    native_pua_fonts: std::sync::Arc<crate::renderer::native_pua_fonts::NativePuaFonts>,
    pub(crate) canvas_metrics: Option<canvas_metrics::CanvasMetricSession>,
    pub(crate) hft_outline_fonts: crate::renderer::hft_outline::HftOutlineFonts,
    pub(crate) metafile_fonts: crate::paint::metafile_fonts::MetafileFonts,
    pub(crate) font_environment: Option<crate::renderer::font_environment::FontEnvironment>,
    pub(crate) host_font_environment: Option<host_font_environment::HostFontEnvironment>,
    /// 구역별 구성된 문단 목록
    pub(crate) composed: Vec<Vec<ComposedParagraph>>,
    /// 본문 동적 필드의 쪽 소속/표시값이 수렴하지 않으면 출력을 명시적으로 거부한다.
    pub(crate) body_page_field_error: Option<String>,
    /// [#2308] source IR로부터 재생성되는 revision 기반 render normalization state.
    /// #2004 immutable compatibility projection과 #2195 sparse width overlay를 소유하며,
    /// **원본 `document`는 무손상**이고 deferred edit은 projection을 직접 mirror하지 않는다.
    pub(crate) render_normalization: RenderNormalizationState,
    /// DPI
    pub(crate) dpi: f64,
    /// 대체 폰트 경로
    pub(crate) fallback_font: String,
    /// 레이아웃 엔진 (자동 번호 카운터 포함)
    pub(crate) layout_engine: LayoutEngine,
    /// 내부 클립보드
    pub(crate) clipboard: Option<ClipboardData>,
    /// 표 셀 행/열 바꿈 복사 버퍼
    pub(crate) table_transpose_clipboard: Option<TableTransposeClipboard>,
    /// [Task #1161] 떠 있는 개체(treat_as_char=false) 반복 붙여넣기 cascade 카운터.
    /// 새 컨트롤 복사 시 0 으로 리셋, 붙여넣기마다 +1 하여 위치 오프셋 누적(한컴 정합).
    pub(crate) paste_cascade_count: u32,
    /// 문단부호(¶) 표시 여부
    pub(crate) show_paragraph_marks: bool,
    /// [#4709] SVG 출력에 배치 메트릭 face 주석(data-metric-font) 부착 여부 (옵트인)
    pub(crate) annotate_metric_font: bool,
    /// 조판부호 표시 여부 (개체 마커 [표]/[그림] 등, 문단부호 포함)
    pub(crate) show_control_codes: bool,
    /// 투명선 표시 여부
    pub(crate) show_transparent_borders: bool,
    /// 잘림 보기 (body/셀 클리핑 활성화 여부)
    pub(crate) clip_enabled: bool,
    /// 디버그 오버레이 표시 여부 (문단/표 경계 + pi/ci 라벨)
    pub(crate) debug_overlay: bool,
    /// LINE_SEG vpos-reset 강제 분리 적용 여부 (페이지네이션 옵션)
    pub(crate) respect_vpos_reset: bool,
    /// 한글 2024 계열 조판 에뮬레이션 opt-in (세션 설정, CLI `--compat 2024`).
    /// 문서 출처가 아니므로 provenance 가 아닌 여기서 들고,
    /// [`Self::effective_layout_profile`] 이 profile 에 합성한다.
    pub(crate) hangul2024_compat: bool,
    /// 구역별 표 측정 데이터 (페이지네이션 결과 보존)
    pub(crate) measured_tables: Vec<Vec<MeasuredTable>>,
    /// 구역별 dirty 플래그 (true = 재페이지네이션 필요)
    pub(crate) dirty_sections: Vec<bool>,
    /// 구역별 측정 캐시 (증분 측정용)
    pub(crate) measured_sections: Vec<MeasuredSection>,
    /// 구역별 문단 dirty 비트맵.
    /// None = 전체 dirty (초기 로드 또는 전체 재구성 시).
    /// Some(vec) = vec[para_idx] = true이면 해당 문단만 재측정.
    pub(crate) dirty_paragraphs: Vec<Option<Vec<bool>>>,
    /// 구역별 문단→단 인덱스 매핑 (페이지네이션에서 결정)
    /// para_column_map[section_idx][para_idx] = column_index
    pub(crate) para_column_map: Vec<Vec<u16>>,
    /// [#2424] 마지막 deferred cell edit revision. 새 edit가 기존 pagination job을 대체한다.
    pub(crate) deferred_pagination_revision: u64,
    /// [#2424] 아직 full pagination에 반영되지 않은 target descriptor.
    pub(crate) deferred_pagination_descriptor: Option<DeferredPaginationDescriptor>,
    /// [#2424] 공개 pagination과 분리된 shadow continuation job.
    pub(crate) pending_pagination_job: Option<PendingPaginationJob>,
    // [hwpx-cowork] 2026-11-20 구역 조판 체크포인트(앞쪽 재사용 — `renderer::typeset::section::checkpoints`).
    pub(crate) typeset_checkpoints: Vec<Option<TypesetCheckpointStore>>,
    pub(crate) flow_sections: Vec<Option<flow_window::FlowSection>>,
    pub(crate) row_tail: Option<table_window::RowTail>, // [hwpx-cowork]
    row_paint: Option<table_window::RowPaint>, // [hwpx-cowork] 지금 편집한 두 쪽의 측정 원본
    row_text: Option<(u64, table_window::RowTail)>,     // [hwpx-cowork] 지연 입력의 원본 쪽 진입 컷
    /// 구역마다 '이 번호 앞의 문단은 지난 구역 조판 뒤로 바뀌지 않았다'. `None` = 모름(처음부터 조판),
    /// `Some(usize::MAX)` = 알려진 변경 없음(구역이 다른 길로 dirty 가 됐으면 역시 처음부터).
    pub(crate) typeset_unchanged_before: Vec<Option<usize>>,
    pub(crate) typeset_resume: TypesetResumeControl,
    /// [hwpx-cowork] 2026-11-20 뒤쪽 미루기: 편집기가 켠다(기본 끔 — 서버·다른 사용처는 늘 끝까지 바로 조판).
    pub(crate) typeset_tail_deferral: bool,
    /// 멈춘 구역 조판(뒤쪽은 지난 조판의 잠정 쪽). 다음 쪽 나눔이 시작하면 버린다.
    pub(crate) typeset_tail_job: Option<typeset_tail::TypesetTailJob>,
    /// 끝낸 멈춘 작업의 결과 — 다음 쪽 나눔이 조판 대신 받아 후처리한다.
    pub(crate) typeset_tail_completed: Option<(usize, PaginationResult)>,
    // [hwpx-cowork] 칸 문단 줄 구성 기억(`renderer::composer::cell_compose_memo`) — 측정·조판·쪽 나무가 함께 쓴다.
    // 스타일 값·글꼴 측정 환경이 바뀔 때만 비운다(2026-11-19 — 그 전에는 글 편집을 마무리하는 쪽 나눔만 남겼다).
    pub(crate) cell_compose_memo:
        std::sync::Arc<crate::renderer::composer::cell_compose_memo::CellComposeMemo>,
    // [hwpx-cowork] 조판 중간 결과 기억(`renderer::layout_memo`) — 문단 내용 지문이 열쇠다.
    // 문단 구성(`typeset::paragraph::format_memo`)과 저장 줄 투영(`render_normalization::stored_word_tail`).
    // 구조 편집 뒤에도 남기고, 스타일 값·글꼴 측정 환경이 바뀔 때만 비운다
    // (`invalidate_layout_memos`·`layout_environment_stamp`·`ResolvedStyleSet::keeps_layout_of`).
    pub(crate) paragraph_format_memo: std::sync::Arc<crate::renderer::typeset::ParagraphFormatMemo>,
    pub(crate) stored_rows_memo:
        std::sync::Arc<crate::renderer::render_normalization::stored_word_tail::StoredRowsMemo>,
    // 측정의 문단 프레임 재구성(`height_measurer::MeasureFrameMemo`) — 구역을 통째로 다시 재는 쪽 나눔(서식·쪽 나누기)용.
    pub(crate) measure_frame_memo:
        std::sync::Arc<crate::renderer::height_measurer::MeasureFrameMemo>,
    // 보충 측정 요청 모으기의 문단별 기억(`canvas_metric_requests::MetricRequestMemo`) — 보충 측정값이 바뀌어도 남긴다.
    pub(crate) metric_request_memo: std::sync::Arc<canvas_metric_requests::MetricRequestMemo>,
    // [hwpx-cowork] 지난 쪽 나눔 뒤에 바뀐 것이 글 편집(본문 한 문단의 짧은 글·표 칸의 미룬 글)뿐인가.
    // 그 글 편집 경로만 켜고(`text_edit_trust_*`), 구역을 dirty 로 표시하거나 쪽 나무 캐시를 버리는 모든 경로가 끈다.
    // 2026-11-18 에는 켜진 채 시작하는 쪽 나눔만 칸 문단 줄 구성 기억을 남겼다. 2026-11-19 부터는 기억을 늘
    // 남기므로 이 표시는 쪽 나눔이 읽지 않는다(편집 경로의 기록으로만 남는다).
    pub(crate) only_text_edits_pending: std::cell::Cell<bool>,
    pub(crate) progressive_open_page_budget: Option<usize>,
    pub(crate) progressive_open_job: Option<progressive_open::ProgressiveOpenJob>,
    pub(crate) interactive_layout: interactive_layout::InteractiveLayout,
    /// [hwpx-cowork] 2026-11-10 P2: (구역 번호, 완주한 조판, 측정) — 여러 구역 문서의 점진 열기.
    pub(crate) progressive_open_completed: Option<(usize, PaginationResult, MeasuredSection)>,
    /// 페이지별 렌더 트리 캐시 (지연 구축, 부분 무효화)
    pub(crate) page_tree_cache: RefCell<Vec<Option<PageRenderTree>>>,
    /// [#6452] 구역 첫 페이지에 임시 투영한 머리말/꼬리말 편집 tree의 단일-entry 캐시.
    ///
    /// Studio는 한 번에 한 HF 정의만 편집하므로 마지막 `(page, section, header,
    /// apply_to)`만 보존한다. 일반 page cache와 분리해 pagination의 실제 active
    /// header/footer tree를 오염시키지 않는다.
    pub(crate) header_footer_preview_tree_cache:
        RefCell<Option<((u32, usize, bool, u8), PageRenderTree)>>,
    /// [Task #2222] 페이지 레이어 트리 JSON 캐시 — (출력옵션 지문, 직렬화 결과).
    /// 이미지 base64 인라인으로 페이지당 1MB 급이라 재직렬화(실측 15ms/회)가
    /// 렌더 자체와 맞먹는다. 편집 무효화는 page_tree_cache 와 동일 지점에서.
    pub(crate) layer_tree_json_cache: RefCell<Vec<Vec<(u16, String)>>>,
    /// [#4969 Q3-E5] 페이지 레이어 트리 캐시 — (출력옵션 지문, immutable tree).
    /// page render tree와 같은 세대에서 무효화하며, 페이지당 최근 변형 4개로 제한한다.
    /// Native의 공유 조회는 node·text·image payload를 깊게 복제하지 않는다.
    /// 기존 소유값 조회는 호출자가 독립적으로 수정할 수 있는 clone을 반환한다.
    pub(crate) page_layer_tree_cache: RefCell<Vec<Vec<(u16, Arc<PageLayerTree>)>>>,
    /// 그림 신원 키(`imageKey`)의 문서 단위 세대 번호 (Task #3315).
    ///
    /// `bin_data_id` 는 append-only 라 세션 중 id→바이트가 안정하지만, undo 스냅샷
    /// 복원은 문서를 통째로 갈아끼워 같은 id 가 다른 바이트를 가리키게 만들 수 있다.
    /// 그래서 그림을 새로 등록할 때와 스냅샷을 되돌릴 때 세대를 올린다.
    pub(crate) bin_data_epoch: u32,
    /// [#8941] 불러온 원본이 처음부터 참조 없이 지니고 있던 `BinData` 의 storage id.
    ///
    /// HWPX 저장은 편집으로 참조가 끊긴 그림만 버리고, 이 항목들은 원본 그대로 옮긴다.
    pub(crate) loaded_unreferenced_bin_data: std::collections::BTreeSet<u16>,
    /// Batch 모드 플래그 — true이면 paginate() 스킵
    pub(crate) batch_mode: bool,
    /// 셀 문단 서식으로 무효화된 vpos. RowBreak 조각별 첫 변경부터 한 번만 갱신한다.
    pub(crate) pending_cell_format_vpos: bool,
    /// 이벤트 로그 (Command 실행 시 누적)
    pub(crate) event_log: Vec<DocumentEvent>,
    /// 글상자 오버플로우 연결 캐시 (섹션별, 지연 계산)
    pub(crate) overflow_links_cache:
        RefCell<HashMap<usize, Vec<queries::doc_tree_nav::OverflowLink>>>,
    /// [hwpx-cowork] 전체 스냅샷과 쪽 나누기용 선형 역연산이 같은 메모리 예산을 쓴다.
    pub(crate) snapshot_store: Vec<(u32, UndoSnapshot)>,
    /// 다음 스냅샷 ID
    pub(crate) next_snapshot_id: u32,
    /// [#5769] Undo/Redo용 삭제 조각 저장소 (ID → DeleteFragment).
    /// 스냅샷과 달리 코어가 자동 축출하지 않는다 — TS 히스토리의 discard 계약 참조.
    pub(crate) fragment_store: Vec<(u32, commands::delete_fragment::DeleteFragment)>,
    /// 다음 삭제 조각 ID
    pub(crate) next_fragment_id: u32,
    /// [#5769] Stage 4 구역 raw 저널 (ID → SectionRawCapture).
    /// 조각 저장소와 ID 계열을 나눈다. 자동 축출 없음 — discardSectionRaw 계약.
    pub(crate) section_raw_store: Vec<(u32, commands::section_raw_journal::SectionRawCapture)>,
    /// 다음 구역 raw 캡처 ID
    pub(crate) next_section_raw_id: u32,
    pub(crate) border_paint_store: Vec<(u32, commands::border_paint_edit::BorderPaintUndo)>,
    pub(crate) next_border_paint_id: u32,
    /// 그림 크기 변경의 원본 변환 상태. 문서/이미지 전체는 복제하지 않는다.
    pub(crate) picture_transform_store: Vec<(
        u32,
        commands::picture_transform_journal::PictureTransformCapture,
    )>,
    pub(crate) next_picture_transform_id: u32,
    /// 머리말/꼬리말 감추기: (global_page_index, is_header) 조합
    pub(crate) hidden_header_footer: std::collections::HashSet<(u32, bool)>,
    /// 파일 이름 (머리말/꼬리말 필드 치환용)
    pub(crate) file_name: String,
    /// 현재 활성 필드 위치 (커서가 진입한 누름틀 — 안내문 렌더링 스킵용)
    /// (section_idx, para_idx, field_control_idx)
    pub(crate) active_field: Option<ActiveFieldInfo>,
    /// 구역별 문단 인덱스 오프셋 (삽입=+N, 삭제=-N, 페이지네이션 수렴 감지용)
    /// paginate() 후 리셋.
    pub(crate) para_offset: Vec<i32>,
    /// 원본 파일 형식 — 저장 시 형식 분기용
    pub(crate) source_format: crate::parser::FileFormat,
    /// HML 입력에서만 유지되는 버전·인코딩·손실 진단.
    pub(crate) hml_metadata: Option<crate::parser::HmlImportMetadata>,
    /// PDF 가져오기 당시의 원본 쪽 대응·미지원 진단. 편집 후 현재 페이지 번호와 구분한다.
    #[cfg(feature = "pdf-import")]
    pub(crate) pdf_metadata: Option<crate::parser::pdf::PdfImportMetadata>,
    /// HWPX 비표준 감지 등 문서 검증 경고.
    /// `from_bytes` 에서 자동 생성되며, 사용자 고지·선택적 reflow 에 사용 (#177).
    pub(crate) validation_report: validation::ValidationReport,
}

impl DocumentCore {
    /// 구역에서 지정한 머리말/꼬리말 정의의 원본 control 위치를 찾는다.
    ///
    /// 편집 command와 대표 페이지 renderer가 반드시 이 resolver를 공유해야 한다
    /// (#6453). 먼저 발견된 동일 종류·적용 범위 control이 canonical target이다.
    pub(crate) fn find_header_footer_control(
        &self,
        section_idx: usize,
        is_header: bool,
        apply_to: HeaderFooterApply,
    ) -> Option<(usize, usize)> {
        let section = self.document.sections.get(section_idx)?;
        for (para_index, para) in section.paragraphs.iter().enumerate() {
            for (control_index, control) in para.controls.iter().enumerate() {
                let matches = match control {
                    Control::Header(header) => is_header && header.apply_to == apply_to,
                    Control::Footer(footer) => !is_header && footer.apply_to == apply_to,
                    _ => false,
                };
                if matches {
                    return Some((para_index, control_index));
                }
            }
        }
        None
    }
}

/// `DocumentCore` 는 스레드 경계 너머로 소유될 수 있어야 한다 — native 소비자(MCP 서버,
/// 워커 풀)가 `Mutex<DocumentCore>` 를 다른 스레드로 보낸다. 내부 캐시 어딘가에 `Rc` 나
/// 다른 `!Send` 타입이 들어오면 이 단언이 컴파일 타임에 깨진다.
/// 내부 가변성(`Cell`/`RefCell`)은 `!Sync` 만 만들 뿐 `Send` 는 유지하므로 여기서 의도대로 통과한다.
#[cfg(not(target_arch = "wasm32"))]
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<DocumentCore>();
};

/// 활성 필드 위치 정보
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveFieldInfo {
    pub section_idx: usize,
    /// 본문 문단 번호. 셀 내부이면 최상위 표/글상자를 담은 본문 부모 문단이다.
    pub para_idx: usize,
    /// field_ranges의 control_idx (controls[] 내 Field 컨트롤 인덱스)
    pub control_idx: usize,
    /// 셀 내부 필드이면 (컨트롤, 셀, 셀 문단) 번호로 이루어진 전체 경로.
    /// 본문 부모 문단은 para_idx, 마지막 셀 문단은 경로의 마지막 요소가 구분한다.
    pub cell_path: Option<Vec<(usize, usize, usize)>>,
}

impl DocumentCore {
    /// 총 페이지 수를 반환한다.
    pub fn page_count(&self) -> u32 {
        self.pagination
            .iter()
            .map(|pr| pr.pages.len() as u32)
            .sum::<u32>()
            .max(1)
    }

    /// 문서 정보를 JSON 문자열로 반환한다.
    pub fn get_document_info(&self) -> String {
        use crate::renderer::style_resolver::lookup_font_name_in_environment;

        let mut fonts = std::collections::BTreeSet::new();
        if let Some(default) =
            crate::renderer::style_resolver::missing_latin_default(&self.document)
        {
            // 표시·측정에 쓰는 기본 face도 같은 브라우저 준비 경로로 공급한다.
            fonts.insert(default.to_string());
        }
        let mut font_substitutions = std::collections::BTreeSet::new();
        let environment = self.resolved_font_environment();
        for (lang_idx, lang_fonts) in self.document.doc_info.font_faces.iter().enumerate() {
            for (font_idx, _) in lang_fonts.iter().enumerate() {
                let decision = lookup_font_name_in_environment(
                    &self.document.doc_info,
                    lang_idx,
                    font_idx as u16,
                    environment,
                );
                // 실제 paint가 소비하는 glyph 공급자도 Studio가 준비해야 한다.
                // primary만 노출하면 측정한 대체 face를 브라우저가 로드하지 못한다.
                fonts.extend(decision.css_family_chain.iter().cloned());
                if let Some(resolved) = decision.normalized_face {
                    fonts.insert(resolved.clone());
                    if decision.environment_profile_id.is_none() {
                        if let Some(substitute) = decision.subst_font {
                            font_substitutions.insert((resolved, substitute));
                        }
                    }
                }
            }
        }
        for section in &self.document.sections {
            queries::content_fonts::collect(&section.paragraphs, &mut fonts);
            for master in &section.section_def.master_pages {
                queries::content_fonts::collect(&master.paragraphs, &mut fonts);
            }
        }
        let fonts_json: Vec<String> = fonts
            .iter()
            .map(|f| {
                // 폰트 이름의 특수문자를 JSON 이스케이프 처리
                let escaped: String = f
                    .chars()
                    .flat_map(|c| match c {
                        '"' => vec!['\\', '"'],
                        '\\' => vec!['\\', '\\'],
                        '\n' => vec!['\\', 'n'],
                        '\r' => vec!['\\', 'r'],
                        '\t' => vec!['\\', 't'],
                        c if c < '\x20' => vec![],
                        c => vec![c],
                    })
                    .collect();
                format!("\"{}\"", escaped)
            })
            .collect();

        let escaped_fallback: String = self
            .fallback_font
            .chars()
            .flat_map(|c| match c {
                '"' => vec!['\\', '"'],
                '\\' => vec!['\\', '\\'],
                c => vec![c],
            })
            .collect();
        let font_substitutions_json =
            serde_json::to_string(&font_substitutions).unwrap_or_else(|_| "[]".to_string());
        format!(
            "{{\"version\":\"{}.{}.{}.{}\",\"sectionCount\":{},\"pageCount\":{},\"encrypted\":{},\"hwp3Variant\":{},\"fallbackFont\":\"{}\",\"fontsUsed\":[{}],\"fontSubstitutions\":{}}}",
            self.document.header.version.major,
            self.document.header.version.minor,
            self.document.header.version.build,
            self.document.header.version.revision,
            self.document.sections.len(),
            self.page_count(),
            self.document.header.encrypted,
            self.document.layout_profile().hwp3_layout(),
            escaped_fallback,
            fonts_json.join(","),
            font_substitutions_json,
        )
    }

    /// 이벤트 로그를 JSON 배열로 직렬화한다.
    pub fn serialize_event_log(&self) -> String {
        crate::model::event::serialize_event_log(&self.event_log)
    }

    /// 세션 설정(호환 모드)을 합성한 유효 레이아웃 프로필.
    ///
    /// 조판·레이아웃에 profile 을 공급하는 지점은 `document.layout_profile()`
    /// 직접 호출 대신 이것을 쓴다. 출처 유도는 여전히
    /// `Document::layout_profile` 이 단일 소유한다.
    pub(crate) fn effective_layout_profile(
        &self,
    ) -> crate::model::provenance::LayoutCompatibilityProfile {
        self.document
            .layout_profile()
            .with_hangul2024_layout(self.hangul2024_compat)
    }

    /// [hwpx-cowork] 스타일·글꼴 측정 환경이 바뀜 — 문단 내용으로 찾는 조판 기억을 모두 버린다
    /// (칸 문단 줄 구성·문단 구성·저장 줄 투영). 글자·문단 모양 번호가 같아도 풀린 값이 달라질 수 있다.
    pub(crate) fn invalidate_layout_memos(&self) {
        self.invalidate_measured_layout_memos();
        self.metric_request_memo.invalidate();
    }

    /// [hwpx-cowork] 보충 측정값(화면 글꼴 실측)만 바뀜 — 그 값을 읽는 조판 기억을 버린다.
    /// 보충 측정 요청의 기억은 측정값을 읽지 않으므로 남긴다.
    pub(crate) fn invalidate_measured_layout_memos(&self) {
        // [hwpx-cowork] 2026-11-20 구역 조판 체크포인트도 이 세대가 같을 때만 쓴다.
        self.typeset_resume
            .layout_generation
            .set(self.typeset_resume.layout_generation.get().wrapping_add(1));
        self.cell_compose_memo.invalidate();
        self.paragraph_format_memo.invalidate();
        self.stored_rows_memo.invalidate();
        self.measure_frame_memo.invalidate();
    }

    /// [hwpx-cowork] 글꼴 측정 환경의 표지에서 보충 측정값을 뺀 것 — dpi·실제 글꼴 등록 세대·호환 정책.
    pub(crate) fn font_environment_stamp(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut environment = std::collections::hash_map::DefaultHasher::new();
        self.dpi.to_bits().hash(&mut environment);
        self.layout_engine
            .exact_font_source_registry_counts()
            .hash(&mut environment);
        self.layout_engine
            .horizontal_shaping_instance_request_counts()
            .hash(&mut environment);
        self.hangul2024_compat.hash(&mut environment);
        self.effective_layout_profile()
            .memo_stamp()
            .hash(&mut environment);
        environment.finish()
    }

    /// [hwpx-cowork] 조판 기억이 믿는 측정 환경의 표지 — dpi·글꼴 측정 문맥의 세대·보충 측정값·호환 정책.
    /// 달라지면 기억을 비운다(쪽 나눔 시작과 정규화 시작에서 견준다).
    pub(crate) fn layout_environment_stamp(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut environment = std::collections::hash_map::DefaultHasher::new();
        self.dpi.to_bits().hash(&mut environment);
        self.layout_engine
            .exact_font_source_registry_counts()
            .hash(&mut environment);
        self.layout_engine
            .horizontal_shaping_instance_request_counts()
            .hash(&mut environment);
        self.styles
            .supplemental_metrics
            .as_ref()
            .map(|snapshot| std::sync::Arc::as_ptr(snapshot) as usize)
            .hash(&mut environment);
        self.hangul2024_compat.hash(&mut environment);
        self.effective_layout_profile()
            .memo_stamp()
            .hash(&mut environment);
        environment.finish()
    }

    /// Rebuild the resolved-style aggregate with the document format's style
    /// normalization. Layout provenance remains in `Document::layout_profile`
    /// and is passed separately to cache-admission consumers.
    pub(crate) fn resolve_render_styles(&self) -> ResolvedStyleSet {
        let mut styles = crate::renderer::style_resolver::resolve_styles_with_environment(
            &self.document,
            self.dpi,
            self.resolved_font_environment(),
            self.effective_layout_profile(),
        );
        styles.hangul2024_missing_glyphs = self.hangul2024_compat;
        styles.native_pua_fonts = self.native_pua_fonts.clone();
        styles
    }

    pub(crate) fn rebuild_resolved_styles(&mut self) -> bool {
        let equation_frames_changed = crate::renderer::equation::declared_frame::set_generation(
            &mut self.document,
            self.hangul2024_compat,
        );
        // 정규화한 줄과 인라인 프레임은 현재 글꼴 메트릭·DPI에서 파생된다.
        // source revision이 같아도 스타일 재해소 뒤에는 이전 투영을 재사용하지 않는다.
        self.render_normalization.sections.fill_with(|| None);
        self.render_normalization.unprojected_revisions.clear();
        let styles = self.resolve_render_styles();
        let supplemental_metrics = self
            .canvas_metrics
            .as_ref()
            .and_then(canvas_metrics::CanvasMetricSession::active_snapshot);
        // [hwpx-cowork] 글자·문단 모양 번호가 같아도 풀린 값이 달라질 수 있다 — 그때는 문단 내용으로 찾는 조판 기억을
        // 모두 버린다. 기존 모양 번호의 값과 문서 전체 값이 그대로면 남긴다: 서식을 새로 적용하면 모양 표 끝에
        // 새 번호가 붙을 뿐이다(`ResolvedStyleSet::keeps_layout_of`). 진하게 한 번에 59쪽 보고서의 모든 문단과
        // 표의 모든 칸을 다시 줄 나눔하던 것을 바뀐 문단만 하게 한다.
        // 보충 측정값(화면 글꼴 실측)이 바뀐 경우도 여기서 버린다 — 쪽 나눔 시작의 환경 표지가 다시 걸러 내지만,
        // 칸 문단 기억은 쪽 나눔 밖(커서·쪽 나무)에서도 읽으므로 바뀐 자리에서 바로 비운다.
        let same_supplemental_metrics =
            match (&self.styles.supplemental_metrics, &supplemental_metrics) {
                (Some(old), Some(new)) => std::sync::Arc::ptr_eq(old, new),
                (None, None) => true,
                _ => false,
            };
        // 실제 글꼴 측정 문맥(kerning·shaping)을 쥔 문서는 새 스타일이 그 문맥 없이 시작하고 다음 쪽 나눔이 다시 건다
        // (`ensure_exact_font_measurement_contexts`). 그 사이의 계산은 문맥 없는 값이므로 기억을 남기지 않는다.
        let had_exact_font_contexts = self.styles.kerning_measurement_context.is_some()
            || self.styles.horizontal_shaping_context.is_some();
        if had_exact_font_contexts || !styles.keeps_layout_of(&self.styles) {
            self.invalidate_layout_memos();
        } else if !same_supplemental_metrics {
            self.invalidate_measured_layout_memos();
        }
        self.styles = styles;
        self.styles.supplemental_metrics = supplemental_metrics;
        // [#7436] 번호 문자열은 문단 모양·번호 정의에서 정해지므로 스타일과 함께 다시 계산한다.
        // 문서를 열 때의 재조판(저장 줄 없는 문단)도 번호 폭을 알고 줄을 나눈다.
        crate::renderer::layout::assign_numbering_markers(
            &mut self.document.sections,
            &self.styles,
        );
        equation_frames_changed
    }

    /// 한글 2024 계열 조판 에뮬레이션을 켜거나 끈다.
    /// 변경 시 페이지네이션 결과가 달라지므로 모든 섹션을 재페이지네이션한다.
    pub fn set_hangul2024_compat(&mut self, enabled: bool) {
        if self.hangul2024_compat != enabled {
            let previous_script_metrics = self.styles.script_metrics;
            self.hangul2024_compat = enabled;
            let equation_frames_changed = self.rebuild_resolved_styles();
            if equation_frames_changed || previous_script_metrics != self.styles.script_metrics {
                self.recompose_all_with_horizontal_shaping();
            }
            for d in self.dirty_sections.iter_mut() {
                *d = true;
            }
            // [hwpx-cowork] Compatibility changes can replace stored-coordinate
            // projections while source revisions stay unchanged. Re-measure the
            // projected paragraphs on both entry and exit from the mode.
            self.mark_all_sections_dirty();
            self.measured_tables.clear();
            self.measured_sections.clear();
            self.dirty_paragraphs.clear();
            self.invalidate_page_tree_cache();
            self.paginate();
        }
    }

    /// DPI를 설정하고 스타일을 재해소한 후 재페이지네이션한다.
    pub fn set_dpi(&mut self, dpi: f64) {
        self.dpi = dpi;
        self.rebuild_resolved_styles();
        self.paginate();
    }

    /// 빈 문서를 생성한다 (테스트/미리보기용).
    pub fn new_empty() -> Self {
        DocumentCore {
            document: Document::default(),
            pagination: Vec::new(),
            styles: ResolvedStyleSet::default(),
            native_pua_fonts: Default::default(),
            canvas_metrics: None,
            hft_outline_fonts: Default::default(),
            metafile_fonts: Default::default(),
            font_environment: None,
            host_font_environment: None,
            composed: Vec::new(),
            body_page_field_error: None,
            render_normalization: RenderNormalizationState::default(),
            dpi: DEFAULT_DPI,
            fallback_font: DEFAULT_FALLBACK_FONT.to_string(),
            layout_engine: LayoutEngine::new(DEFAULT_DPI),
            split_cell_doc_id: crate::renderer::layout::split_cell_new_doc_id(),
            clipboard: None,
            table_transpose_clipboard: None,
            paste_cascade_count: 0,
            show_paragraph_marks: false,
            annotate_metric_font: false,
            show_control_codes: false,
            show_transparent_borders: false,
            clip_enabled: true,
            debug_overlay: false,
            respect_vpos_reset: false,
            hangul2024_compat: false,
            measured_tables: Vec::new(),
            dirty_sections: Vec::new(),
            measured_sections: Vec::new(),
            dirty_paragraphs: Vec::new(),
            para_column_map: Vec::new(),
            deferred_pagination_revision: 0,
            deferred_pagination_descriptor: None,
            pending_pagination_job: None,
            typeset_checkpoints: Vec::new(),
            flow_sections: Vec::new(),
            row_tail: None,
            row_paint: None,
            row_text: None,
            typeset_unchanged_before: Vec::new(),
            typeset_resume: Default::default(),
            typeset_tail_deferral: false,
            typeset_tail_job: None,
            typeset_tail_completed: None,
            cell_compose_memo: Default::default(),
            paragraph_format_memo: Default::default(),
            stored_rows_memo: std::sync::Arc::new(
                crate::renderer::render_normalization::stored_word_tail::new_stored_rows_memo(),
            ),
            measure_frame_memo: Default::default(),
            metric_request_memo: Default::default(),
            only_text_edits_pending: std::cell::Cell::new(false),
            progressive_open_page_budget: None,
            progressive_open_job: None,
            interactive_layout: Default::default(), // [hwpx-cowork]
            progressive_open_completed: None,
            page_tree_cache: RefCell::new(Vec::new()),
            header_footer_preview_tree_cache: RefCell::new(None),
            layer_tree_json_cache: RefCell::new(Vec::new()),
            page_layer_tree_cache: RefCell::new(Vec::new()),
            bin_data_epoch: 0,
            loaded_unreferenced_bin_data: std::collections::BTreeSet::new(),
            batch_mode: false,
            pending_cell_format_vpos: false,
            event_log: Vec::new(),
            overflow_links_cache: RefCell::new(HashMap::new()),
            snapshot_store: Vec::new(),
            next_snapshot_id: 0,
            fragment_store: Vec::new(),
            next_fragment_id: 0,
            section_raw_store: Vec::new(),
            next_section_raw_id: 0,
            border_paint_store: Vec::new(),
            next_border_paint_id: 0,
            picture_transform_store: Vec::new(),
            next_picture_transform_id: 0,
            hidden_header_footer: std::collections::HashSet::new(),
            file_name: String::new(),
            active_field: None,
            para_offset: Vec::new(),
            source_format: crate::parser::FileFormat::Hwp,
            hml_metadata: None,
            #[cfg(feature = "pdf-import")]
            pdf_metadata: None,
            validation_report: validation::ValidationReport::new(),
        }
    }

    /// HML 열기 메타데이터. 다른 입력 포맷은 `None`이다.
    pub fn hml_metadata(&self) -> Option<&crate::parser::HmlImportMetadata> {
        self.hml_metadata.as_ref()
    }

    /// PDF를 가져온 시점의 진단. HWP/HWPX 저장본 재열기에서는 `None`이다.
    #[cfg(feature = "pdf-import")]
    pub fn pdf_metadata(&self) -> Option<&crate::parser::pdf::PdfImportMetadata> {
        self.pdf_metadata.as_ref()
    }

    /// 문서 검증 리포트에 대한 참조를 반환한다.
    ///
    /// `from_bytes` 시점에 HWPX 비표준 lineseg 감지가 수행되며, 경고가 있으면
    /// 사용자에게 고지되어야 한다. 자동 reflow 는 적용되지 않고 사용자가
    /// 명시적으로 `reflow_linesegs_on_demand()` 를 호출해야 보정된다.
    pub fn validation_report(&self) -> &validation::ValidationReport {
        &self.validation_report
    }
}

// [hwpx-cowork] 나뉜 칸 미룬 개체 띠 표의 문서별 분리.
#[cfg(test)]
mod split_cell_doc_scope_tests;
