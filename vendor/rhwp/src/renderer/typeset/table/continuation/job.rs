//! 표 도메인 조정. 기존 평가·상태 쓰기 순서를 보존한다.

use crate::renderer::typeset::{
    column_def_design_spacing_px, controls, footnote_between_notes_margin_px,
    footnote_separator_overhead_px, hwpunit_to_px, is_synthetic_line_seg, para_has_visible_text,
    paragraph, state, table, BlockTableContinuationSource, ColumnDef, ComposedParagraph, Control,
    FootnoteShape, MeasuredTable, PageDef, PageLayoutInfo, PaginationResult, Paragraph,
    ResolvedStyleSet, ResumablePaginationStep, ResumableTablePaginationJob, TypesetEngine,
    TypesetState,
};

impl TypesetEngine {
    // [hwpx-cowork] 재개형 표 쪽 나눔이 받는 문서 형상인가 — 측정 없이 알 수 있는 조건만(아래 `begin_resumable_table_pagination`
    // 의 첫 두 검사 그대로). `begin_deferred_pagination` 이 구역 측정(큰 표는 수십~백 ms) 뒤에야 이 검사에서 거절돼 Fallback 으로
    // 떨어지고, 이어지는 전체 쪽 나눔이 같은 측정을 다시 했다(2026-11-18 — 문단이 여럿인 보통 문서는 늘 거절). 측정 전에 묻는다.
    pub(crate) fn resumable_table_pagination_shape_supported(
        paragraphs: &[Paragraph],
        column_def: &ColumnDef,
        paragraph_index: usize,
        control_index: usize,
    ) -> bool {
        if paragraphs.len() != 1 || paragraph_index != 0 || column_def.column_count.max(1) != 1 {
            return false;
        }
        let Some(para) = paragraphs.get(paragraph_index) else {
            return false;
        };
        let table = match para.controls.get(control_index) {
            Some(Control::Table(table)) => table,
            _ => return false,
        };
        !(table.common.treat_as_char
            || !matches!(
                table.layout_page_break(),
                crate::model::table::TablePageBreak::RowBreak
            )
            || table.row_count <= 1
            || para_has_visible_text(para)
            || para.controls.iter().enumerate().any(|(index, control)| {
                index != control_index
                    && !matches!(
                        control,
                        Control::SectionDef(_) | Control::ColumnDef(_) | Control::Bookmark(_)
                    )
            })
            || para
                .controls
                .iter()
                .enumerate()
                .skip(control_index + 1)
                .any(|(_, control)| !matches!(control, Control::Bookmark(_))))
    }

    /// [#2424] 단일 문단의 마지막 대형 RowBreak 표를 shadow flow state에서 시작한다.
    ///
    /// Stage D의 첫 fast path는 편집 지연 대상이 문서의 유일한 본문 표인 형상으로
    /// 의도적으로 제한한다. 지원 범위를 벗어나면 caller가 기존 full paginate로
    /// fallback할 수 있도록 `None`을 반환한다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn begin_resumable_table_pagination(
        &self,
        paragraphs: &[Paragraph],
        composed: &[ComposedParagraph],
        styles: &ResolvedStyleSet,
        page_def: &PageDef,
        column_def: &ColumnDef,
        section_index: usize,
        measured_tables: &[MeasuredTable],
        hide_empty_line: bool,
        profile: crate::model::provenance::LayoutCompatibilityProfile,
        skip_spacing_before_prededuct: bool,
        footnote_shape: Option<&FootnoteShape>,
        paragraph_index: usize,
        control_index: usize,
        fragment_budget: usize,
    ) -> Option<ResumableTablePaginationJob> {
        // [hwpx-cowork] 형상 검사는 측정 전에도 쓰는 한 곳(`resumable_table_pagination_shape_supported`)에 둔다.
        if !Self::resumable_table_pagination_shape_supported(
            paragraphs,
            column_def,
            paragraph_index,
            control_index,
        ) {
            return None;
        }
        let para = paragraphs.get(paragraph_index)?;
        let table = match para.controls.get(control_index)? {
            Control::Table(table) => table,
            _ => return None,
        };
        let measured_table = measured_tables.iter().find(|measured| {
            measured.para_index == paragraph_index && measured.control_index == control_index
        })?;
        if measured_table.row_heights.is_empty() {
            return None;
        }

        let layout = PageLayoutInfo::from_page_def(page_def, column_def, self.dpi);
        self.profile.set(profile);
        let default_footnote_shape = FootnoteShape::default();
        let footnote_shape = footnote_shape.unwrap_or(&default_footnote_shape);
        let mut state = TypesetState::new(
            layout,
            1,
            section_index,
            footnote_separator_overhead_px(footnote_shape, self.dpi),
            footnote_between_notes_margin_px(footnote_shape, self.dpi),
            column_def.column_type,
        );
        state.configure_footnote_placement(footnote_shape.placement);
        state.initialize_source(
            hide_empty_line,
            profile,
            para.line_segs
                .iter()
                .any(|line| !is_synthetic_line_seg(line)),
            skip_spacing_before_prededuct,
        );
        state.initialize_zone_spacing(column_def_design_spacing_px(column_def, self.dpi), false);
        state.ensure_page();

        let column_width = state
            .layout
            .column_areas
            .first()
            .map(|area| area.width)
            .unwrap_or(state.layout.body_area.width);
        let formatted_para = self.format_paragraph(
            para,
            composed.get(paragraph_index),
            styles,
            Some(column_width),
        );
        let formatted_table = self.format_table(
            para,
            paragraph_index,
            control_index,
            table,
            measured_tables,
            styles,
            composed.get(paragraph_index),
            None,
            true,
            Some(column_width),
        );
        let context = self.typeset_block_table_inner(
            &mut state,
            paragraph_index,
            control_index,
            para,
            table,
            &formatted_table,
            &formatted_para,
            Some(measured_table),
            styles,
            0.0,
            0.0,
            true,
            true,
            paragraphs,
            composed,
            true,
        )?;
        let mut job = ResumableTablePaginationJob {
            context,
            paragraph_index,
            control_index,
        };
        job.context.fragment_budget = fragment_budget.max(1);
        Some(job)
    }

    pub(crate) fn step_resumable_table_pagination(
        &self,
        job: &mut ResumableTablePaginationJob,
        paragraph: &Paragraph,
        paragraphs_all: &[Paragraph],
        table: &crate::model::table::Table,
        measured_table: &MeasuredTable,
        styles: &ResolvedStyleSet,
        fragment_budget: usize,
    ) -> ResumablePaginationStep {
        self.profile.set(job.context.flow_state.profile);
        job.context.fragment_budget = fragment_budget.max(1);
        let before = job.context.cursor.fragments_emitted;
        let source = BlockTableContinuationSource {
            para_index: job.paragraph_index,
            control_index: job.control_index,
            paragraph,
            paragraphs_all,
            // 재개 작업은 host 글이 없는 표만 받는다(`begin_resumable_table_pagination`).
            composed_all: &[],
            table,
            row_geometry_table: measured_table.row_geometry_table(table),
            measured_table,
            styles,
        };
        self.step_block_table_continuation(&mut job.context, source);
        ResumablePaginationStep {
            fragments_processed: job.context.cursor.fragments_emitted.saturating_sub(before),
            complete: job.context.is_complete(),
        }
    }

    pub(crate) fn finish_resumable_table_pagination(
        &self,
        job: ResumableTablePaginationJob,
        paragraphs: &[Paragraph],
        section_index: usize,
    ) -> Option<PaginationResult> {
        if !job.context.is_complete() {
            return None;
        }
        let mut state = job.context.into_flow_state();
        if !state.current_items.is_empty() {
            state.flush_column_always();
        }
        state.ensure_page();
        let (hf_entries, page_number_pos) =
            Self::collect_header_footer_controls(paragraphs, section_index);
        state.finalize_pages(&hf_entries, &page_number_pos, paragraphs);
        Some(state.into_result())
    }

    pub(crate) fn resumable_table_target(job: &ResumableTablePaginationJob) -> (usize, usize) {
        (job.paragraph_index, job.control_index)
    }
}
