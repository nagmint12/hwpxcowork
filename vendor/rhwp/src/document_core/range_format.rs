//! [hwpx-cowork] 선택 서식은 원본 범위에 한 명령으로 적용한다. 문단마다 전체 구역을
//! 다시 나누지 않는다. 편집 위치는 구역·문단·글자 오프셋이며 쪽 번호는 미리보기용이다.
use super::{
    helpers::{parse_char_shape_mods, parse_para_shape_mods},
    DocumentCore,
};
use crate::error::HwpError;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::CharShapeRun;
use crate::renderer::composer::{
    compose_paragraph_with_horizontal_shaping, paragraph_flow_end, recalculate_section_vpos,
    reflow_line_segs, ParagraphBox,
};
use crate::renderer::style_resolver::ResolvedStyleSet;
use std::collections::{BTreeSet, HashMap};

type Pos = (usize, usize, usize);
enum Previous {
    Character {
        start: usize,
        end: usize,
        runs: Vec<CharShapeRun>,
    },
    Paragraph(u16),
}
pub(crate) struct BodyFormat {
    entries: Vec<(usize, usize, Previous)>,
    reflow: bool,
}
impl BodyFormat {
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn invalid() -> HwpError {
    HwpError::RenderError("본문 서식 범위가 현재 문서와 다릅니다.".into())
}

impl DocumentCore {
    pub(crate) fn apply_body_range_format(
        &mut self,
        start: Pos,
        end: Pos,
        properties: &str,
        focus_page: u32,
    ) -> Result<BodyFormat, HwpError> {
        let props: serde_json::Value = serde_json::from_str(properties).map_err(|_| invalid())?;
        let map = props
            .as_object()
            .filter(|v| v.len() == 1)
            .ok_or_else(invalid)?;
        let reflow = map
            .get("fontSize")
            .is_some_and(|v| v.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64));
        let character = reflow
            || ["strikethrough", "underline"]
                .iter()
                .any(|key| map.get(*key).is_some_and(|v| v.is_boolean()));
        if !(character
            || map
                .get("alignment")
                .and_then(|v| v.as_str())
                .is_some_and(|v| {
                    matches!(
                        v,
                        "left"
                            | "center"
                            | "right"
                            | "justify"
                            | "distribute"
                            | "split"
                            | "division"
                    )
                }))
        {
            return Err(invalid());
        }
        if start > end
            || [start, end].iter().any(|&(s, p, o)| {
                self.document
                    .sections
                    .get(s)
                    .and_then(|s| s.paragraphs.get(p))
                    .is_none_or(|p| o > p.text.chars().count())
            })
        {
            return Err(invalid());
        }
        let cm = parse_char_shape_mods(properties);
        let pm = parse_para_shape_mods(properties);
        let mut char_ids = HashMap::new();
        let mut para_ids = HashMap::new();
        let mut entries = Vec::new();
        for s in start.0..=end.0 {
            let n = self.document.sections[s].paragraphs.len();
            let first = if s == start.0 { start.1 } else { 0 };
            let stop = if s == end.0 { end.1 + 1 } else { n };
            for p in first..stop {
                let para = &self.document.sections[s].paragraphs[p];
                if character {
                    let from = if (s, p) == (start.0, start.1) {
                        start.2
                    } else {
                        0
                    };
                    let to = if (s, p) == (end.0, end.1) {
                        end.2
                    } else {
                        para.text.chars().count()
                    };
                    if from >= to {
                        continue;
                    }
                    let runs = para.char_shape_runs(from, to);
                    for run in &runs {
                        char_ids.entry(run.char_shape_id).or_insert_with(|| {
                            self.document
                                .find_or_create_char_shape(run.char_shape_id, &cm)
                        });
                    }
                    let para = &mut self.document.sections[s].paragraphs[p];
                    para.try_map_char_shape_range(from, to, |id| {
                        char_ids.get(&id).copied().ok_or_else(invalid)
                    })?;
                    para.interactive_format_dirty = true;
                    para.interactive_format_reflow |= reflow;
                    self.event_log.push(DocumentEvent::CharFormatChanged {
                        section: s,
                        para: p,
                        start: from,
                        end: to,
                    });
                    entries.push((
                        s,
                        p,
                        Previous::Character {
                            start: from,
                            end: to,
                            runs,
                        },
                    ));
                } else {
                    let old = para.para_shape_id;
                    let new = *para_ids
                        .entry(old)
                        .or_insert_with(|| self.document.find_or_create_para_shape(old, &pm));
                    self.document.sections[s].paragraphs[p].para_shape_id = new;
                    self.composed[s][p].para_style_id = new;
                    entries.push((s, p, Previous::Paragraph(old)));
                    self.event_log.push(DocumentEvent::ParaFormatChanged {
                        section: s,
                        para: p,
                    });
                }
            }
            self.document.sections[s].raw_stream = None;
            self.mark_section_dirty(s);
        }
        if !entries.is_empty() {
            self.finish_body_range(character, focus_page);
        }
        Ok(BodyFormat { entries, reflow })
    }

    pub(crate) fn swap_body_range_format(
        &mut self,
        history: &mut BodyFormat,
        focus: u32,
    ) -> Result<(), HwpError> {
        let Some((_, _, first_value)) = history.entries.first() else {
            return Ok(());
        };
        let character = matches!(first_value, Previous::Character { .. });
        // [hwpx-cowork] 잘못된 세대의 Undo가 원본 일부만 바꾸지 않도록 주소를 먼저 검증한다.
        for (s, p, v) in &history.entries {
            let para = self
                .document
                .sections
                .get(*s)
                .and_then(|s| s.paragraphs.get(*p))
                .ok_or_else(invalid)?;
            if let Previous::Character { end, .. } = v {
                if *end > para.text.chars().count() {
                    return Err(invalid());
                }
            }
        }
        let mut changed = BTreeSet::new();
        for (s, p, v) in &mut history.entries {
            let para = &mut self.document.sections[*s].paragraphs[*p];
            match v {
                Previous::Character { start, end, runs } => {
                    let next = para.char_shape_runs(*start, *end);
                    para.restore_char_shape_runs(*start, *end, runs);
                    *runs = next;
                    self.event_log.push(DocumentEvent::CharFormatChanged {
                        section: *s,
                        para: *p,
                        start: *start,
                        end: *end,
                    });
                    para.interactive_format_dirty = true;
                    para.interactive_format_reflow |= history.reflow;
                }
                Previous::Paragraph(id) => {
                    std::mem::swap(&mut para.para_shape_id, id);
                    self.composed[*s][*p].para_style_id = para.para_shape_id;
                    self.event_log.push(DocumentEvent::ParaFormatChanged {
                        section: *s,
                        para: *p,
                    });
                }
            }
            changed.insert(*s);
        }
        for s in changed {
            self.document.sections[s].raw_stream = None;
            self.mark_section_dirty(s);
        }
        self.finish_body_range(character, focus);
        Ok(())
    }

    fn finish_body_range(&mut self, character: bool, focus: u32) {
        self.rebuild_resolved_styles();
        if character {
            self.interactive_layout.format_cursor = Some((0, 0));
            self.interactive_layout.projected_pages.clear();
            self.prepare_format_page(focus);
        }
        if !self.typeset_tail_deferral {
            self.step_format_rows(0.0, f64::INFINITY);
        }
        self.request_interactive_layout();
        if !self.interactive_layout.pending {
            self.interactive_layout.formatted_rows.clear();
            self.interactive_layout.projected_pages.clear();
        }
    }

    /// [hwpx-cowork] 전체 선택이 커서를 끝으로 옮긴 뒤에도 실제로 요청한 쪽의 줄부터 계산한다.
    pub(crate) fn prepare_format_page(&mut self, page: u32) {
        if self.interactive_layout.format_cursor.is_none()
            && self.interactive_layout.formatted_rows.is_empty()
        {
            return;
        }
        let mut visible = BTreeSet::new();
        let mut affected = Vec::new();
        for index in [page, page.saturating_add(1)] {
            if self.interactive_layout.projected_pages.contains(&index) {
                continue;
            }
            let Ok((published, _, _)) = self.find_page(index) else {
                continue;
            };
            let section = published.section_index;
            let mut changed = false;
            for item in published
                .column_contents
                .iter()
                .flat_map(|column| &column.items)
            {
                let p = item.para_index();
                if self
                    .document
                    .sections
                    .get(section)
                    .and_then(|s| s.paragraphs.get(p))
                    .is_some_and(|para| para.interactive_format_dirty)
                {
                    visible.insert((section, p));
                    changed = true;
                } else if self
                    .interactive_layout
                    .formatted_rows
                    .contains(&(section, p))
                {
                    changed = true;
                }
            }
            if changed {
                affected.push(index);
            }
        }
        if affected.is_empty() {
            return;
        }
        if !visible.is_empty() {
            let styles = self.resolve_render_styles();
            let mut widths = HashMap::new();
            for (s, p) in visible {
                let width = *widths.entry(s).or_insert_with(|| self.body_wrap_width(s));
                self.materialize_body_format(s, p, width, &styles);
            }
        }
        // [hwpx-cowork] 유휴 시간에 줄만 먼저 조합한 쪽도 화면에 도착하면 표 원점을 갱신한다.
        for index in affected {
            self.refresh_independent_format_page(index);
            self.interactive_layout.projected_pages.insert(index);
        }
        self.invalidate_page_tree_cache();
    }

    // [hwpx-cowork] 저장된 쪽 경계가 양쪽에 있는 한 쪽은 앞쪽 조판 상태에 의존하지 않는다.
    // 줄 높이뿐 아니라 그 줄 아래 표의 원점·감싸기·열 흐름도 기존 조판기로 함께 다시 만든다.
    fn refresh_independent_format_page(&mut self, page_number: u32) {
        use crate::model::paragraph::ColumnBreakType;
        use crate::renderer::height_measurer::HeightMeasurer;
        use crate::renderer::pagination::{EndnoteDeferral, PageItem};
        use crate::renderer::typeset::{SectionTypesetInput, TypesetEngine};
        let Ok((page, _, _)) = self.find_page(page_number) else {
            return;
        };
        if !page.footnotes.is_empty() || page.column_contents.len() != 1 {
            return;
        }
        let column = &page.column_contents[0];
        if column.items.is_empty()
            || column.items.iter().any(|item| {
                !matches!(
                    item,
                    PageItem::FullParagraph { .. }
                        | PageItem::PartialParagraph { .. }
                        | PageItem::Table { .. }
                        | PageItem::PartialTable { .. }
                        | PageItem::Shape { .. }
                )
            })
        {
            return;
        }
        let section_idx = page.section_index;
        let width = page.layout.column_areas.first().map(|area| area.width);
        let first = column.items.iter().map(PageItem::para_index).min().unwrap();
        let last = column.items.iter().map(PageItem::para_index).max().unwrap();
        // [hwpx-cowork] 글자처럼 취급한 그림의 앞·뒤 글은 한 쪽 안에서도 PartialParagraph다.
        // 이웃 쪽까지 실제로 이어진 문단·표만 제외한다. 큰 표는 여기서 재측정하지 않는다.
        let page_base: usize = self.pagination[..section_idx]
            .iter()
            .map(|r| r.pages.len())
            .sum();
        let local = page_number as usize - page_base;
        let pages = &self.pagination[section_idx].pages;
        let shares = |index: usize, owner: usize| {
            pages.get(index).is_some_and(|other| {
                other
                    .column_contents
                    .iter()
                    .any(|c| c.items.iter().any(|item| item.para_index() == owner))
            })
        };
        if local.checked_sub(1).is_some_and(|i| shares(i, first)) || shares(local + 1, last) {
            return;
        }
        let section = &self.document.sections[section_idx];
        if last >= section.paragraphs.len()
            || (first != 0 && section.paragraphs[first].column_type != ColumnBreakType::Page)
            || section
                .paragraphs
                .get(last + 1)
                .is_some_and(|p| p.column_type != ColumnBreakType::Page)
        {
            return;
        }
        let paragraphs = &section.paragraphs[first..=last];
        let composed = &self.composed[section_idx][first..=last];
        // 구역 첫 쪽에서만 다른 종이/다단/머리말 상태를 만드는 경우는 확정된 일반 조판이 처리한다.
        let col_def = Self::find_initial_column_def(&section.paragraphs);
        if col_def.column_count > 1 {
            return;
        }
        let _split = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
        let _tabs = self
            .styles
            .section_tab_scope(section.section_def.default_tab_spacing, self.dpi);
        let profile = self.effective_layout_profile();
        let measurer = HeightMeasurer::new(self.dpi)
            .with_hwp3_variant(profile.hwp3_layout())
            .with_stored_geometry_policy(profile.stored_geometry_policy())
            .with_native_hwp5(profile.hwp5_stored_pagination_layout())
            .with_hwpx_stored_layout(profile.hwpx_stored_layout())
            .with_hwp5_origin_hwpx(profile.hwp5_origin_hwpx())
            .with_session_edited(profile.session_edited())
            .with_render_normalization(self.render_normalization.overlay.clone())
            .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
            .with_measure_frame_memo(Some(self.measure_frame_memo.clone()));
        measurer.set_section_column_spacing_hu(i32::from(section.section_def.column_spacing));
        let fresh = measurer.measure_section(paragraphs, composed, &self.styles, width);
        let engine = TypesetEngine::new_with_render_normalization(
            self.dpi,
            self.render_normalization.overlay.clone(),
        )
        .with_section_column_spacing_hu(i32::from(section.section_def.column_spacing))
        .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
        .with_paragraph_format_memo(Some(self.paragraph_format_memo.clone()));
        let breaks = Default::default();
        let input = SectionTypesetInput {
            paragraphs,
            composed,
            styles: &self.styles,
            page_def: &section.section_def.page_def,
            column_def: &col_def,
            section_index: section_idx,
            measured_tables: &fresh.tables,
            hide_empty_line: section.section_def.hide_empty_line,
            profile,
            skip_spacing_before_prededuct: false,
            hwp3_origin_page_tolerance: super::queries::rendering::uses_hwp3_origin_page_tolerance(
                &self.document,
            ),
            footnote_shape: Some(&section.section_def.footnote_shape),
            endnote_shape: Some(&section.section_def.endnote_shape),
            force_break_before: &breaks,
            endnote_deferral: EndnoteDeferral::None,
        };
        let mut job = engine.begin_section(&input);
        if !engine.step_section(&mut job, &input, paragraphs.len() + 1, 2) {
            return;
        }
        let result = engine.finish_section(job, &input);
        if result.pages.len() != 1 || !result.endnotes.is_empty() {
            return;
        }
        let patch = result
            .pages
            .into_iter()
            .next()
            .unwrap()
            .into_shifted(first as i32);
        if !patch.footnotes.is_empty() || patch.column_contents.len() != 1 {
            return;
        }
        let expected = page.layout.body_area;
        let actual = patch.layout.body_area;
        if (expected.x, expected.y, expected.width, expected.height)
            != (actual.x, actual.y, actual.width, actual.height)
        {
            return;
        }
        let published = &mut self.pagination[section_idx].pages[local];
        published.column_contents = patch.column_contents;
        published.ladder_band_tables = patch.ladder_band_tables;
    }

    // [hwpx-cowork] 한 본문 문단 안의 개체를 고친 경우에는 원본·표식 문단과
    // 보이는 독립 쪽만 갱신하고, 뒤쪽의 감싸기와 쪽 나눔은 같은 조판 작업에 넘긴다.
    pub(crate) fn recompose_edited_object_owner(&mut self, section: usize, paragraph: usize) {
        if !self.typeset_tail_deferral || self.batch_mode || self.progressive_open_job.is_some() {
            self.recompose_section(section);
            self.paginate_if_needed();
            return;
        }
        self.recompose_paragraph(section, paragraph);
        self.request_interactive_layout();
        self.refresh_object_owner_pages(section, paragraph, true);
    }

    // [hwpx-cowork] 쪽의 inline 흐름에는 글자 범위까지 저장된다. 줄 수가 같은 타이핑도
    // 그림 뒤의 종전 끝 글자 번호를 재사용하면 마지막 글자가 화면에서 잘린다.
    pub(crate) fn refresh_object_owner_pages(
        &mut self,
        section: usize,
        paragraph: usize,
        next: bool,
    ) {
        let page = self.pagination.get(section).and_then(|layout| {
            layout.pages.iter().position(|page| {
                page.column_contents.iter().any(|column| {
                    column
                        .items
                        .iter()
                        .any(|item| item.para_index() == paragraph)
                })
            })
        });
        if let Some(local) = page {
            // [hwpx-cowork] 명시적 쪽나눔이 없어도 이 문단은 당시 단 너비·제외 영역을
            // 가진다. 현재 글과 개체로 다시 짜 오래된 문자열 범위가 새 글을 자르지 않게 한다.
            let source = &self.document.sections[section];
            let _tabs = self
                .styles
                .section_tab_scope(source.section_def.default_tab_spacing, self.dpi);
            let _split = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
            let tables = self
                .measured_tables
                .get(section)
                .map_or(&[][..], |tables| tables.as_slice());
            for col in &mut self.pagination[section].pages[local].column_contents {
                if let Some(plan) = col.inline_flow_plans.get_mut(&paragraph) {
                    if let Some(current) = crate::renderer::typeset::replay_inline_owner(
                        plan,
                        &source.paragraphs[paragraph],
                        paragraph,
                        &self.styles,
                        tables,
                        self.dpi,
                    ) {
                        for item in &current.floating_shapes {
                            col.paragraph_float_placements
                                .insert((paragraph, item.control), item.placement);
                        }
                        *plan = current;
                    }
                }
            }
            let base: usize = self.pagination[..section]
                .iter()
                .map(|r| r.pages.len())
                .sum();
            let current = (base + local) as u32;
            self.refresh_independent_format_page(current);
            if next {
                self.refresh_independent_format_page(current.saturating_add(1));
            }
        }
    }

    /// [hwpx-cowork] 조판 작업보다 입력이 먼저 도착해도 그 문단의 줄과 서식은 최신이다.
    pub(crate) fn prepare_body_format_at(&mut self, section: usize, paragraph: usize) {
        if self
            .document
            .sections
            .get(section)
            .and_then(|s| s.paragraphs.get(paragraph))
            .is_some_and(|p| p.interactive_format_dirty)
        {
            if let Some(local) = self.pagination.get(section).and_then(|r| {
                r.pages.iter().position(|page| {
                    page.column_contents.iter().any(|column| {
                        column
                            .items
                            .iter()
                            .any(|item| item.para_index() == paragraph)
                    })
                })
            }) {
                let base: usize = self.pagination[..section]
                    .iter()
                    .map(|r| r.pages.len())
                    .sum();
                self.prepare_format_page((base + local) as u32);
                return;
            }
            let styles = self.resolve_render_styles();
            self.materialize_body_format(
                section,
                paragraph,
                self.body_wrap_width(section),
                &styles,
            );
        }
    }

    fn materialize_body_format(
        &mut self,
        s: usize,
        p: usize,
        width: f64,
        styles: &ResolvedStyleSet,
    ) {
        let hwp3 = self.document.layout_profile().hwp3_layout();
        let para = &mut self.document.sections[s].paragraphs[p];
        self.interactive_layout.formatted_rows.insert((s, p));
        let reflow = para.interactive_format_reflow;
        para.interactive_format_dirty = false;
        para.interactive_format_reflow = false;
        if reflow {
            let old_end = paragraph_flow_end(para);
            let box_ = ParagraphBox::body_for_style(
                width,
                styles.para_styles.get(para.para_shape_id as usize),
                self.dpi,
            );
            reflow_line_segs(para, box_, styles, self.dpi);
            self.fit_cell_grid(s, p, styles);
            recalculate_section_vpos(
                &mut self.document.sections[s].paragraphs,
                p,
                None,
                old_end,
                styles,
                self.dpi,
                hwp3,
            );
        }
        let _tabs = styles.section_tab_scope(
            self.document.sections[s].section_def.default_tab_spacing,
            self.dpi,
        );
        self.composed[s][p] = compose_paragraph_with_horizontal_shaping(
            &self.document.sections[s].paragraphs[p],
            styles,
        );
        self.mark_paragraph_dirty(s, p); // [hwpx-cowork] 새 줄 높이는 최종 쪽 측정에서도 다시 읽는다.
    }

    pub(super) fn step_format_rows(&mut self, started: f64, budget: f64) -> bool {
        let Some((mut s, mut p)) = self.interactive_layout.format_cursor else {
            return true;
        };
        let styles = self.resolve_render_styles();
        while s < self.document.sections.len() {
            // [hwpx-cowork] 구역의 단 폭은 같은 조각 안에서 문단마다 찾지 않는다.
            let width = self.body_wrap_width(s);
            while p < self.document.sections[s].paragraphs.len() {
                if self.document.sections[s].paragraphs[p].interactive_format_dirty {
                    self.materialize_body_format(s, p, width, &styles);
                }
                p += 1;
                if super::typeset_tail::now_ms() - started >= budget {
                    self.interactive_layout.format_cursor = Some((s, p));
                    return false;
                }
            }
            s += 1;
            p = 0;
        }
        // [hwpx-cowork] 중간 삽입·삭제 때문에 이미 지나온 인덱스 앞으로 이동한 문단만 회수한다.
        // 글자 하나를 입력할 때마다 처음부터 다시 검사하지 않는다.
        self.interactive_layout.format_cursor =
            self.document
                .sections
                .iter()
                .enumerate()
                .find_map(|(s, section)| {
                    section
                        .paragraphs
                        .iter()
                        .position(|p| p.interactive_format_dirty)
                        .map(|p| (s, p))
                });
        self.interactive_layout.format_cursor.is_none()
    }
}
