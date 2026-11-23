//! [hwpx-cowork] 편집은 원본 IR에 즉시 기록한다. 최종 쪽 계산은 기존 typesetter의
//! 중단 가능한 작업을 사용한다. 새 입력은 미완성 조판만 폐기하며 원본은 교체하지 않는다.
use super::progressive_open::ProgressiveOpenJob;
use super::typeset_tail::TypesetTailState;
use super::DocumentCore;
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredSection};

// [hwpx-cowork] 한 구역의 문단과 표 측정도 입력 사이에 멈춘다. 원본은 소유하지 않는다.
pub(super) struct InteractiveMeasurement {
    pub(super) section: usize,
    pub(super) width: f64,
    pub(super) measurer: HeightMeasurer,
    pub(super) result: MeasuredSection,
}

#[derive(Default)]
pub(crate) struct InteractiveLayout {
    pub(super) pending: bool,
    // [hwpx-cowork] 마지막 정규 조판의 단 정의. 서식이 전체 문단에서 단 부호를 다시 찾지 않는다.
    pub(super) initial_columns: Vec<crate::model::page::ColumnDef>,
    pub(super) advancing: bool,
    pub(super) revision: u64,
    pub(super) published: u64,
    pub(super) section: Option<(ProgressiveOpenJob, MeasuredSection)>,
    pub(super) format_cursor: Option<(usize, usize)>,
    // [hwpx-cowork] 아직 원문에 펼치지 않은 선택 범위. 실행 순서는 Undo/Redo까지 포함한다.
    pub(super) ranges: Vec<super::range_format::RangePass>,
    pub(crate) range_visits: u64,
    // [hwpx-cowork] 원문 주소가 바뀌면 앞 세대의 쪽이 잘못된 문단을 가리킬 수 있다.
    pub(super) unpublished_structure: bool,
    pub(super) range_numbering_dirty: bool, // [hwpx-cowork] 문단 머리 번호는 전역 원문 반영 후 확정
    pub(super) formatted_rows: std::collections::HashSet<(usize, usize)>,
    pub(super) projected_pages: std::collections::HashSet<u32>,
    pub(super) measuring: Option<InteractiveMeasurement>,
    pub(super) measured: Option<(usize, MeasuredSection)>,
    pub(super) stored_rows:
        Option<crate::renderer::render_normalization::stored_word_tail::StoredBodyRowsJob>,
    pub(super) ready_rows: Option<(usize, Option<Vec<crate::model::paragraph::Paragraph>>)>,
}

impl DocumentCore {
    pub(crate) fn body_range_source_pending(&self) -> bool {
        !self.interactive_layout.ranges.is_empty()
    }

    pub(crate) fn interactive_layout_pending(&self) -> bool {
        self.interactive_layout.pending
    }

    // [hwpx-cowork] 동기 내보내기의 저장 줄 정보도 편집기의 비동기 내보내기와 같다.
    pub(crate) fn finish_interactive_layout_for_export(&mut self) {
        if self.interactive_layout.pending {
            self.flush_typeset_tail();
        }
    }

    pub(crate) fn request_interactive_layout(&mut self) {
        // [hwpx-cowork] 기존 동기 API·초기 열기·명시 배치의 계약은 유지한다.
        if !self.typeset_tail_deferral
            || self.batch_mode
            || self.progressive_open_job.is_some()
            || self.pagination.is_empty()
            || self.interactive_layout.advancing
        {
            self.paginate_if_needed();
            return;
        }
        // [hwpx-cowork] 서로 다른 종류의 편집도 같은 문서 세대에 속한다. 종전 표·본문의
        // 미발행 뒤쪽은 이 작업이 완주할 구역에 합친다. 이전 결과가 나중에 덮어쓸 수 없다.
        let old_sections = [
            self.typeset_tail_job
                .take()
                .map(|job| job.config.section_index),
            self.row_text.take().map(|(_, row)| row.section),
            self.row_tail.take().map(|row| row.section),
        ];
        for section in old_sections.into_iter().flatten() {
            self.mark_section_pagination_dirty(section);
        }
        if !self.interactive_layout.pending {
            self.interactive_layout.revision = self.interactive_layout.revision.wrapping_add(1);
            self.interactive_layout.pending = true;
        }
        self.invalidate_page_tree_cache();
    }

    pub(super) fn invalidate_interactive_layout(&mut self, section: usize) {
        if self.interactive_layout.pending && !self.interactive_layout.advancing {
            self.interactive_layout.revision = self.interactive_layout.revision.wrapping_add(1);
            self.interactive_layout.projected_pages.clear();
            // [hwpx-cowork] 오래된 원본에서 유도한 줄 투영은 새 편집 세대에 발행하지 않는다.
            if self
                .interactive_layout
                .stored_rows
                .as_ref()
                .is_some_and(|job| section <= job.section)
            {
                self.interactive_layout.stored_rows = None;
            }
            if self
                .interactive_layout
                .ready_rows
                .as_ref()
                .is_some_and(|(idx, _)| section <= *idx)
            {
                self.interactive_layout.ready_rows = None;
            }
            if self
                .interactive_layout
                .measuring
                .as_ref()
                .is_some_and(|job| section <= job.section)
            {
                self.interactive_layout.measuring = None;
            }
            if self
                .interactive_layout
                .measured
                .as_ref()
                .is_some_and(|(idx, _)| section <= *idx)
            {
                self.interactive_layout.measured = None;
            }
            if self
                .interactive_layout
                .section
                .as_ref()
                .is_some_and(|(work, _)| section <= work.section_index)
            {
                self.interactive_layout.section = None;
            }
        }
    }

    pub(super) fn step_interactive_layout(&mut self, budget_ms: f64) -> TypesetTailState {
        let started = super::typeset_tail::now_ms();
        self.interactive_layout.advancing = true;
        if self.interactive_layout.format_cursor.is_some()
            && !self.step_format_rows(started, budget_ms)
        {
            self.interactive_layout.advancing = false;
            return TypesetTailState::Pending;
        }
        if let Some(mut work) = self.interactive_layout.measuring.take() {
            let idx = work.section;
            let source = &self.document.sections[idx];
            let normalized = self
                .render_normalization
                .sections
                .get(idx)
                .and_then(Option::as_ref)
                .filter(|s| s.source_revision == self.render_normalization.section_revisions[idx]);
            let paragraphs = normalized.map_or(&source.paragraphs, |s| &s.paragraphs);
            let composed = normalized.map_or(&self.composed[idx], |s| &s.composed);
            let _tabs = self
                .styles
                .section_tab_scope(source.section_def.default_tab_spacing, self.dpi);
            let _split = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
            while work.result.fallback_paragraphs.len() < paragraphs.len() {
                let start = work.result.fallback_paragraphs.len();
                let end = (start + 4).min(paragraphs.len());
                let result = work.measurer.measure_section_range(
                    paragraphs,
                    composed,
                    &self.styles,
                    &self.measured_sections[idx],
                    self.dirty_paragraphs[idx].as_deref(),
                    Some(work.width),
                    start..end,
                    &mut work.result,
                    &crate::storage::Unbounded,
                );
                result.unwrap_or_else(|never| match never {});
                if super::typeset_tail::now_ms() - started >= budget_ms {
                    break;
                }
            }
            if work.result.fallback_paragraphs.len() == paragraphs.len() {
                self.interactive_layout.measured = Some((idx, work.result));
            } else {
                self.interactive_layout.measuring = Some(work);
            }
            self.interactive_layout.advancing = false;
            return TypesetTailState::Pending;
        }
        if let Some(mut work) = self.interactive_layout.stored_rows.take() {
            let idx = work.section;
            let source = &self.document.sections[idx];
            loop {
                match work.advance(
                    &source.paragraphs,
                    &self.styles,
                    &source.section_def.page_def,
                    self.dpi,
                    &self.stored_rows_memo,
                ) {
                    std::task::Poll::Ready(rows) => {
                        self.interactive_layout.ready_rows = Some((idx, rows));
                        break;
                    }
                    std::task::Poll::Pending
                        if super::typeset_tail::now_ms() - started >= budget_ms =>
                    {
                        self.interactive_layout.stored_rows = Some(work);
                        break;
                    }
                    std::task::Poll::Pending => {}
                }
            }
            self.interactive_layout.advancing = false;
            return TypesetTailState::Pending;
        }
        if let Some((mut pending, measured)) = self.interactive_layout.section.take() {
            let idx = pending.section_index;
            let _split = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
            let _tabs = self.styles.section_tab_scope(
                self.document.sections[idx].section_def.default_tab_spacing,
                self.dpi,
            );
            let done = loop {
                let mut input = self.progressive_open_input(idx, &pending.config);
                input.measured_tables = &measured.tables;
                if pending
                    .typesetter
                    .step_section(&mut pending.job, &input, 8, 1)
                {
                    break true;
                }
                if let Some(store) = pending.checkpoints.as_mut() {
                    store.checkpoints.record_open_step(&pending.job);
                }
                if super::typeset_tail::now_ms() - started >= budget_ms {
                    break false;
                }
            };
            if !done {
                self.interactive_layout.section = Some((pending, measured));
                self.interactive_layout.advancing = false;
                return TypesetTailState::Pending;
            }
            let mut input = self.progressive_open_input(idx, &pending.config);
            input.measured_tables = &measured.tables;
            let result = pending.typesetter.finish_section(pending.job, &input);
            self.typeset_checkpoints[idx] = pending.checkpoints;
            self.progressive_open_completed = Some((idx, result, measured));
            self.dirty_sections[idx] = true;
        }
        self.paginate();
        self.interactive_layout.advancing = false;
        if self.interactive_layout.section.is_some()
            || self.interactive_layout.measuring.is_some()
            || self.interactive_layout.stored_rows.is_some()
        {
            TypesetTailState::Pending
        } else {
            self.interactive_layout.pending = false;
            self.interactive_layout.published = self.interactive_layout.revision;
            self.interactive_layout.formatted_rows.clear();
            self.interactive_layout.projected_pages.clear();
            TypesetTailState::Complete
        }
    }
}
