//! [hwpx-cowork] 명시적 쪽 나눔 또는 조판 상태가 일치하는 자연 경계에서 본문 흐름을 잇는다.
//! 뒤쪽의 줄 나눔이 달라지면 편집 쪽을 먼저 발행하고 유휴 조판 작업으로 마무리한다.
//! 입력 때 섹션을 나누거나 문서 모델을 복제하지 않는다. 같은 측정기와 조판기에
//! 빌린 문단 구간을 주고, 편집한 쪽의 측정·쪽 항목·커서가 함께 바뀌게 한다.
use super::queries::rendering::uses_hwp3_origin_page_tolerance;
use super::DocumentCore;
use crate::model::control::Control;
use crate::model::page::ColumnDef;
use crate::model::paragraph::{ColumnBreakType, LineSeg, Paragraph};
use crate::model::shape::{TextWrap, VertRelTo};
use crate::model::style::HeadType;
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredSection};
use crate::renderer::pagination::{EndnoteDeferral, PageContent, PageItem, PaginationResult};
use crate::renderer::typeset::{SectionTypesetInput, TypesetEngine};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub(crate) struct FlowSection {
    revision: u64,
    environment: u64,
    paragraphs_ptr: usize,
    composed_ptr: usize,
    column: ColumnDef,
    origin_tolerance: bool,
    row_table: Option<usize>, // [hwpx-cowork] 열 폭과 행이 독립인 단독 표의 컨트롤 번호.
    // 뒤쪽 쪽 목록 자체의 상태다. 다음 키가 실행 작업을 무효화해도 이 경계는 남는다.
    provisional_from: Option<usize>,
}

pub(crate) struct FlowWindow {
    section: usize,
    paragraphs: Range<usize>,
    pages: Range<usize>,
    natural_entry: bool,
    natural_exit: bool,
}

fn ordinary_page(page: &PageContent) -> bool {
    page.column_contents.len() == 1
        && page.footnotes.is_empty()
        && page.active_header.is_none()
        && page.active_footer.is_none()
        && page.active_master_page.is_none()
        && page.extra_master_pages.is_empty()
        && !page.page_number_restarted
        && page.page_hide.is_none()
        && page.page_number_pos.is_none()
        && page.ladder_band_tables.is_empty()
}

fn plain_result(result: &PaginationResult) -> bool {
    result.wrap_around_paras.is_empty()
        && result.endnotes.is_empty()
        && result.endnote_paragraphs.is_empty()
}

// [hwpx-cowork] 표와 함께 출력한 host·숨긴 빈 문단은 쪽 목록 밖에도 소유자 번호를 둔다.
fn splice_set(
    old: &mut HashSet<usize>,
    local: HashSet<usize>,
    range: &Range<usize>,
    inserted: usize,
) {
    if old.is_empty() && local.is_empty() {
        return;
    }
    *old = old
        .drain()
        .filter(|i| !range.contains(i))
        .map(|i| if i >= range.end { i + inserted } else { i })
        .chain(local.into_iter().map(|i| i + range.start))
        .collect();
}

fn splice_heights(
    old: &mut HashMap<usize, f64>,
    local: HashMap<usize, f64>,
    range: &Range<usize>,
    inserted: usize,
) {
    if old.is_empty() && local.is_empty() {
        return;
    }
    *old = old
        .drain()
        .filter(|(i, _)| !range.contains(i))
        .map(|(i, h)| (if i >= range.end { i + inserted } else { i }, h))
        .chain(local.into_iter().map(|(i, h)| (i + range.start, h)))
        .collect();
}

// 각 구역의 첫 문단과 온전한 문단/표를 나누는 명시적 쪽 경계만 재개점이다.
fn first_owner(page: &PageContent) -> Option<usize> {
    page.column_contents
        .first()?
        .items
        .first()
        .map(PageItem::para_index)
}

// [hwpx-cowork] 원본 저장 좌표·다단·개체 간섭이 없는 단에서는 같은 글줄·같은
// 소비 높이로 끝난 한 쪽이 다음 쪽의 같은 진입 상태를 보장한다.
fn same_text_page(new: &PageContent, old: &PageContent, offset: i32) -> bool {
    let (a, b) = (&new.column_contents[0], &old.column_contents[0]);
    a.used_height.to_bits() == b.used_height.to_bits()
        && a.start_height.to_bits() == b.start_height.to_bits()
        && a.items.len() == b.items.len()
        && !a.items.is_empty()
        && a.items.iter().zip(&b.items).all(|(x, y)| {
            matches!(
                x,
                PageItem::FullParagraph { .. }
                    | PageItem::PartialParagraph { .. }
                    | PageItem::Shape { .. }
            ) && x.matches_with_offset(y, offset)
        })
}

impl DocumentCore {
    fn independent_flow_paragraph(&self, p: &Paragraph, first: bool) -> bool {
        let generated = |p: &Paragraph| {
            p.line_segs
                .iter()
                .all(|seg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0)
        };
        let plain_style = |p: &Paragraph| {
            self.styles
                .para_styles
                .get(p.para_shape_id as usize)
                .is_some_and(|s| s.head_type == HeadType::None && !s.keep_with_next)
        };
        generated(p)
            && plain_style(p)
            && p.layout_field_values.is_empty()
            && (first || matches!(p.column_type, ColumnBreakType::None | ColumnBreakType::Page))
            && p.controls.iter().all(|control| match control {
                Control::SectionDef(_) => first,
                Control::ColumnDef(c) => first && c.column_count <= 1,
                // [hwpx-cowork] 글자처럼 배치한 고정 프레임은 해당 문단에서 줄 높이를 소비한다.
                // 실제 줄과 쪽의 진입 상태를 확인하는 자연 경계 검사는 그대로 적용한다.
                Control::Picture(pic) => {
                    pic.common.treat_as_char
                        && pic.caption.is_none()
                        && pic.common.width > 0
                        && pic.common.height > 0
                }
                Control::Shape(s) => {
                    matches!(
                        s.as_ref(),
                        crate::model::shape::ShapeObject::Chart(_)
                            | crate::model::shape::ShapeObject::Ole(_)
                    ) && s.common().treat_as_char
                        && s.common().width > 0
                        && s.common().height > 0
                        && s.caption().is_none()
                }
                // 글자처럼 취급 표는 행 높이가 바뀌면 저장 host 줄도 고친다. 그 경로는
                // 전체 조판의 sync_tac_host_rows에서 같은 근거로 처리한다.
                Control::Table(t) => {
                    !t.common.treat_as_char
                        && t.common.flow_with_text
                        && t.common.vert_rel_to == VertRelTo::Para
                        && t.common.text_wrap == TextWrap::TopAndBottom
                        && t.caption.is_none()
                        && t.cells.iter().all(|c| {
                            c.paragraphs.iter().all(|p| {
                                p.controls.is_empty()
                                    && p.layout_field_values.is_empty()
                                    && plain_style(p)
                            })
                        })
                }
                _ => false,
            })
    }

    pub(crate) fn classify_flow_section(
        &self,
        idx: usize,
        environment: u64,
    ) -> Option<FlowSection> {
        let section = &self.document.sections[idx];
        let result = &self.pagination[idx];
        if self.source_format != crate::parser::FileFormat::Hwpx
            || self.hangul2024_compat
            || super::queries::rendering::uses_hwp3_origin_flow_spacing_before(&self.document)
            || self
                .effective_layout_profile()
                .legacy_hwp3_stored_geometry()
            || section.section_def.cell_grid().is_some()
            || !section.section_def.master_pages.is_empty()
            || section.section_def.page_def.margin_gutter != 0
            || self.render_normalization.sections.get(idx)?.is_some()
            || !plain_result(result)
            || !result.pages.iter().all(ordinary_page)
            || !section
                .paragraphs
                .iter()
                .enumerate()
                .all(|(i, p)| self.independent_flow_paragraph(p, i == 0))
        {
            return None;
        }
        let column = Self::find_initial_column_def(&section.paragraphs);
        let row_table = match section.paragraphs.as_slice() {
            [p] if self.document.sections.len()==1 => p.controls.iter().enumerate().find_map(|(ci,c)|
                matches!(c,Control::Table(t) if TypesetEngine::resumable_table_pagination_shape_supported(
                    &section.paragraphs,&column,0,ci) && super::table_window::independent_rows(t)).then_some(ci)),
            _=>None,
        };
        (column.column_count <= 1).then(|| FlowSection {
            row_table,
            revision: self.render_normalization.section_revisions[idx],
            environment,
            column,
            paragraphs_ptr: section.paragraphs.as_ptr() as usize,
            composed_ptr: self.composed[idx].as_ptr() as usize,
            origin_tolerance: uses_hwp3_origin_page_tolerance(&self.document),
            provisional_from: None,
        })
    }

    // [hwpx-cowork] 표의 소유·환경·조판 세대가 확인된 상태에서만 이전 쪽 경계를 읽는다.
    pub(super) fn certified_row_table(&self, idx: usize, para: usize, ci: usize) -> bool {
        self.typeset_tail_deferral
            && !self.interactive_layout.pending // [hwpx-cowork] 범위 서식의 미완 구역을 표 로컬 결과로 확정하지 않는다.
            && !self.batch_mode
            && !self.typeset_resume.disabled.get()
            && !self.typeset_resume.verify.get()
            && self.typeset_tail_job.is_none()
            && self
                .flow_sections
                .get(idx)
                .and_then(Option::as_ref)
                .is_some_and(|s| {
                    para == 0
                        && s.row_table == Some(ci)
                        && s.environment == self.layout_environment_stamp()
                        && s.revision == self.render_normalization.section_revisions[idx]
                        && s.paragraphs_ptr
                            == self.document.sections[idx].paragraphs.as_ptr() as usize
                        && s.composed_ptr == self.composed[idx].as_ptr() as usize
                        && s.provisional_from.is_none()
                })
    }
    pub(super) fn accept_row_table_revision(&mut self, idx: usize) {
        if let Some(s) = self.flow_sections.get_mut(idx).and_then(Option::as_mut) {
            s.revision = self.render_normalization.section_revisions[idx];
            s.composed_ptr = self.composed[idx].as_ptr() as usize;
        }
    }

    pub(crate) fn flow_window_before(&self, idx: usize, para: usize) -> Option<FlowWindow> {
        if self.interactive_layout.pending { return None; } // [hwpx-cowork] 미완성 범위 서식의 측정은 근접 창의 이전 컷이 아니다.
        let stamp = self.flow_sections.get(idx)?.as_ref()?;
        // [hwpx-cowork] 구역 전체가 한 표인 경우 일반 문단 구간은 쪼갤 수 없다.
        if stamp.row_table.is_some() {
            return None;
        }
        // [hwpx-cowork] 이 구간의 보류 중인 글 입력도 이번 측정에 함께 반영한다.
        let text_pending =
            self.dirty_sections.get(idx) == Some(&true) && self.only_text_edits_pending.get();
        if !self.typeset_tail_deferral
            || self.row_tail.is_some() // [hwpx-cowork] 다른 종류의 입력은 미완료 표도 함께 확정한다.
            || self.batch_mode
            || self.typeset_resume.verify.get()
            || self.typeset_tail_job.as_ref().is_some_and(|job| {
                stamp.provisional_from.is_none() || job.config.section_index != idx
            })
            || self
                .dirty_sections
                .iter()
                .enumerate()
                .any(|(i, d)| *d && !(i == idx && text_pending))
            || (!text_pending && stamp.revision != self.render_normalization.section_revisions[idx])
            || stamp.environment != self.layout_environment_stamp()
            || stamp.paragraphs_ptr != self.document.sections[idx].paragraphs.as_ptr() as usize
            || stamp.composed_ptr != self.composed[idx].as_ptr() as usize
        {
            return None;
        }
        let section = &self.document.sections[idx];
        let pages = &self.pagination[idx].pages;
        // 물리 쪽 첫 소유자는 이 흐름에서 단조 증가한다. 여러 쪽을 차지한 문단이나
        // 표의 중간에서 시작하지 않도록 실제 원본 쪽 나눔도 함께 확인한다.
        let current = pages
            .partition_point(|page| first_owner(page).is_some_and(|owner| owner <= para))
            .checked_sub(1)?;
        if stamp.provisional_from.is_some_and(|join| current >= join) {
            return None;
        }
        let whole_start = |i: usize| {
            i == 0
                || i == pages.len()
                || first_owner(&pages[i]).is_some_and(|owner| {
                    pages[i - 1].column_contents[0]
                        .items
                        .iter()
                        .all(|item| item.para_index() < owner)
                })
        };
        let hard_start = |i: usize| -> bool {
            if i == 0 || i == pages.len() {
                return true;
            }
            first_owner(&pages[i]).is_some_and(|owner| {
                section
                    .paragraphs
                    .get(owner)
                    .is_some_and(|p| p.has_page_break())
                    && whole_start(i)
            })
        };
        // 자연 경계에서는 앞쪽 한 쪽은 변경 전후 조판이 같아야 하고, 뒤쪽 한 쪽은
        // 편집 쪽과 떨어져 있어야 한다. 분할 문단/표의 가운데서 입력을 자르지 않는다.
        let from = (current.saturating_sub(2)..=current)
            .rev()
            .find(|&i| hard_start(i))
            .or_else(|| {
                (current.saturating_sub(16)..current)
                    .rev()
                    .find(|&i| whole_start(i))
            })?;
        let until = (current + 1..=(current + 3).min(pages.len()))
            .find(|&i| hard_start(i))
            .or_else(|| {
                (current + 2..=(current + 16).min(pages.len())).find(|&i| whole_start(i))
            })?;
        let start = if from == 0 {
            0
        } else {
            first_owner(&pages[from])?
        };
        let end = if until == pages.len() {
            section.paragraphs.len()
        } else {
            first_owner(&pages[until])?
        };
        if text_pending {
            let dirty = self.dirty_paragraphs.get(idx)?.as_ref()?;
            if dirty.len() != section.paragraphs.len()
                || dirty[..start].contains(&true)
                || dirty[end..].contains(&true)
            {
                return None;
            }
        }
        (start <= para && para < end).then_some(FlowWindow {
            section: idx,
            paragraphs: start..end,
            pages: from..until,
            natural_entry: !hard_start(from),
            natural_exit: !hard_start(until),
        })
    }

    pub(crate) fn paginate_flow_edit(&mut self, window: Option<FlowWindow>, inserted: usize) {
        if !window.is_some_and(|w| self.apply_flow_window(w, inserted)) {
            self.paginate_if_needed();
        }
    }

    // [hwpx-cowork] 같은 쪽의 다음 글자를 치고 저장하거나 idle flush할 때에도
    // 이 구간에서 닫히는 변경은 구역 전체를 다시 조판하지 않는다.
    pub(crate) fn settle_flow_text(&mut self) -> bool {
        if !self.only_text_edits_pending.get() {
            return false;
        }
        let Some(idx) = self.dirty_sections.iter().position(|&dirty| dirty) else {
            return false;
        };
        let Some(para) = self
            .dirty_paragraphs
            .get(idx)
            .and_then(Option::as_ref)
            .and_then(|bits| bits.iter().position(|&dirty| dirty))
        else {
            return false;
        };
        self.flow_window_before(idx, para)
            .is_some_and(|w| self.apply_flow_window(w, 0))
    }

    fn apply_flow_window(&mut self, window: FlowWindow, inserted: usize) -> bool {
        let idx = window.section;
        let start = window.paragraphs.start;
        let range = start..window.paragraphs.end + inserted;
        let Some(stamp) = self.flow_sections[idx].as_ref() else {
            return false;
        };
        let section = &self.document.sections[idx];
        let paragraphs = &section.paragraphs[range.clone()];
        // [hwpx-cowork] 전체 조판과 같은 구역 탭 간격·분할 셀 문서 문맥에서 측정한다.
        let _tabs = self
            .styles
            .section_tab_scope(section.section_def.default_tab_spacing, self.dpi);
        let _split_cell_doc = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
        let composed = &self.composed[idx][range.clone()];
        if stamp.environment != self.layout_environment_stamp()
            || stamp.origin_tolerance != uses_hwp3_origin_page_tolerance(&self.document)
            || !paragraphs
                .iter()
                .enumerate()
                .all(|(i, p)| self.independent_flow_paragraph(p, start + i == 0))
        {
            return false;
        }

        // 측정 캐시의 원래 행 하한·셀 내용을 그대로 써서 최초 입력과 다음 입력이
        // 같은 기하를 본다. 구간 안에서만 문단 번호를 상대값으로 바꾼다.
        let measured = &self.measured_sections[idx];
        let mut prior = MeasuredSection {
            fallback_paragraphs: measured.fallback_paragraphs[range.clone()].to_vec(),
            tables: measured
                .tables
                .iter()
                .filter(|t| range.contains(&t.para_index))
                .cloned()
                .collect(),
        };
        for (i, p) in prior.fallback_paragraphs.iter_mut().enumerate() {
            p.para_index = i;
        }
        for t in &mut prior.tables {
            t.para_index -= start;
        }
        let profile = self.effective_layout_profile();
        let measurer = HeightMeasurer::new(self.dpi)
            .with_stored_geometry_policy(profile.stored_geometry_policy())
            .with_native_hwp5(profile.hwp5_stored_pagination_layout())
            .with_hwpx_stored_layout(profile.hwpx_stored_layout())
            .with_hwp5_origin_hwpx(profile.hwp5_origin_hwpx())
            .with_session_edited(profile.session_edited())
            .with_render_normalization(self.render_normalization.overlay.clone())
            .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
            .with_measure_frame_memo(Some(self.measure_frame_memo.clone()));
        measurer.set_section_column_spacing_hu(i32::from(section.section_def.column_spacing));
        let old = &self.pagination[idx].pages[window.pages.start];
        let width = old.layout.column_areas.first().map(|a| a.width);
        let bits = self.dirty_paragraphs[idx]
            .as_ref()
            .map(|v| &v[range.clone()]);
        let mut fresh = measurer.measure_section_selective(
            paragraphs,
            composed,
            &self.styles,
            &prior,
            bits,
            width,
        );
        let engine = TypesetEngine::new_with_render_normalization(
            self.dpi,
            self.render_normalization.overlay.clone(),
        )
        .with_section_column_spacing_hu(i32::from(section.section_def.column_spacing))
        .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
        .with_paragraph_format_memo(Some(self.paragraph_format_memo.clone()));
        let no_breaks = Default::default();
        let input = SectionTypesetInput {
            paragraphs,
            composed,
            styles: &self.styles,
            page_def: &section.section_def.page_def,
            column_def: &stamp.column,
            section_index: idx,
            measured_tables: &fresh.tables,
            hide_empty_line: section.section_def.hide_empty_line,
            profile,
            skip_spacing_before_prededuct: false,
            hwp3_origin_page_tolerance: stamp.origin_tolerance,
            footnote_shape: Some(&section.section_def.footnote_shape),
            endnote_shape: Some(&section.section_def.endnote_shape),
            force_break_before: &no_breaks,
            endnote_deferral: EndnoteDeferral::None,
        };
        let mut job = engine.begin_section(&input);
        engine.step_section(&mut job, &input, usize::MAX, usize::MAX);
        let local = engine.finish_section(job, &input);
        if !plain_result(&local) || !local.pages.iter().all(ordinary_page) {
            return false;
        }
        if local.pages.is_empty()
            || (window.natural_entry && !same_text_page(&local.pages[0], old, -(start as i32)))
        {
            return false;
        }
        let unsettled = stamp.provisional_from.is_some()
            || (window.natural_exit
                && !same_text_page(
                    local.pages.last().unwrap(),
                    &self.pagination[idx].pages[window.pages.end - 1],
                    inserted as i32 - start as i32,
                ));
        if unsettled && (idx + 1 != self.document.sections.len() || local.pages.len() < 2) {
            return false;
        }
        let page_delta = local.pages.len() as i64 - window.pages.len() as i64;
        // 다른 구역이 홀짝 머리말·바탕쪽 등을 쓰면 기존 구역 간 carry 경로가 정한다.
        if (unsettled || page_delta != 0)
            && (0..self.document.sections.len()).any(|i| {
                self.flow_sections.get(i).and_then(Option::as_ref).is_none()
                    || (i > idx
                        && (self.document.sections[i].section_def.page_num != 0
                            || self.document.sections[i].section_def.page_num_type != 0))
            })
        {
            return false;
        }
        let first_number = old.page_number;
        let count = local.pages.len();
        let first_page = window.pages.start;
        let section_pages = &mut self.pagination[idx];
        splice_set(
            &mut section_pages.hidden_empty_paras,
            local.hidden_empty_paras,
            &window.paragraphs,
            inserted,
        );
        splice_set(
            &mut section_pages.pre_emitted_host_paras,
            local.pre_emitted_host_paras,
            &window.paragraphs,
            inserted,
        );
        splice_heights(
            &mut section_pages.pre_emitted_host_heights,
            local.pre_emitted_host_heights,
            &window.paragraphs,
            inserted,
        );
        splice_heights(
            &mut section_pages.pre_emitted_host_content_heights,
            local.pre_emitted_host_content_heights,
            &window.paragraphs,
            inserted,
        );
        let pages = &mut section_pages.pages;
        let replacement = local.pages.into_iter().enumerate().map(|(i, page)| {
            let mut page = page.into_shifted(start as i32);
            page.page_index = (first_page + i) as u32;
            page.page_number = first_number + i as u32;
            page
        });
        pages.splice(window.pages, replacement);
        if inserted != 0 {
            let suffix = pages.split_off(first_page + count);
            pages.extend(suffix.into_iter().map(|p| p.into_shifted(inserted as i32)));
        }
        if page_delta != 0 {
            for (i, page) in pages.iter_mut().enumerate().skip(first_page + count) {
                page.page_index = i as u32;
                page.page_number = (i64::from(page.page_number) + page_delta) as u32;
            }
            for following in &mut self.pagination[idx + 1..] {
                for page in &mut following.pages {
                    page.page_number = (i64::from(page.page_number) + page_delta) as u32;
                }
            }
        }
        for p in &mut fresh.fallback_paragraphs {
            p.para_index += start;
        }
        for t in &mut fresh.tables {
            t.para_index += start;
        }
        let measured = &mut self.measured_sections[idx];
        measured
            .fallback_paragraphs
            .splice(range.clone(), fresh.fallback_paragraphs);
        let tables = &mut measured.tables;
        let begin = tables.partition_point(|t| t.para_index < start);
        let end = tables.partition_point(|t| t.para_index < range.end);
        let paint_tables = &mut self.measured_tables[idx];
        if inserted != 0 {
            // shift_for_insert는 측정 캐시를 이미 옮겼다. 그리기용 표 목록은 이 시점에 맞춘다.
            for t in paint_tables
                .iter_mut()
                .filter(|t| t.para_index >= window.paragraphs.end)
            {
                t.para_index += inserted;
            }
        }
        let paint_begin = paint_tables.partition_point(|t| t.para_index < start);
        let paint_end = paint_tables.partition_point(|t| t.para_index < range.end);
        paint_tables.splice(paint_begin..paint_end, fresh.tables.iter().cloned());
        tables.splice(begin..end, fresh.tables);
        self.para_column_map[idx].resize(section.paragraphs.len(), 0);
        self.dirty_sections[idx] = false;
        self.only_text_edits_pending.set(false);
        self.deferred_pagination_descriptor = None;
        self.pending_pagination_job = None;
        if let Some(bits) = &mut self.dirty_paragraphs[idx] {
            bits[range].fill(false);
        }
        if let Some(offset) = self.para_offset.get_mut(idx) {
            *offset = 0;
        }
        // 이전 사본의 접두부를 재사용할 수 없게 한다. 큰 사본 해제는 일반 조판이
        // 새 사본을 발행할 때 처리하여 이번 키 입력에서 누적 쪽 전체를 해제하지 않는다.
        self.typeset_unchanged_before[idx] = None;
        let revision = self.render_normalization.section_revisions[idx];
        let stamp = self.flow_sections[idx].as_mut().unwrap();
        stamp.revision = revision;
        stamp.provisional_from = unsettled.then_some(first_page + count - 1);
        stamp.paragraphs_ptr = section.paragraphs.as_ptr() as usize;
        stamp.composed_ptr = self.composed[idx].as_ptr() as usize;
        self.render_normalization.unprojected_revisions[idx] = Some(revision);
        if unsettled {
            use super::typeset_tail::{TypesetTailConfig, TypesetTailJob};
            let config = TypesetTailConfig {
                section_index: idx,
                column_def: stamp.column.clone(),
                skip_spacing_before_prededuct: false,
                hwp3_origin_page_tolerance: stamp.origin_tolerance,
                paragraphs_ptr: stamp.paragraphs_ptr,
                composed_ptr: stamp.composed_ptr,
                environment: stamp.environment,
                layout_generation: self.typeset_resume.layout_generation.get(),
                respect_vpos_reset: self.respect_vpos_reset,
                normalized: false,
                source_revision: revision,
            };
            self.typeset_tail_job = Some(TypesetTailJob {
                typesetter: engine,
                parked: None, // 구역 전체를 읽는 준비도 유휴 시간에 한다.
                config,
            });
            self.typeset_resume
                .tail_parked
                .set(self.typeset_resume.tail_parked.get() + 1);
        }
        self.typeset_resume
            .flow_window_edits
            .set(self.typeset_resume.flow_window_edits.get() + 1);
        self.invalidate_page_tree_cache();
        true
    }
}
