//! [hwpx-cowork] 선택 서식은 원본 범위에 한 명령으로 적용한다. 문단마다 전체 구역을
//! 다시 나누지 않는다. 편집 위치는 구역·문단·글자 오프셋이며 쪽 번호는 미리보기용이다.
use super::{
    helpers::{parse_char_shape_mods, parse_para_shape_mods},
    DocumentCore,
};
use crate::error::HwpError;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::CharShapeRef;
use crate::renderer::composer::{
    compose_paragraph_with_horizontal_shaping, paragraph_flow_end, recalculate_section_vpos,
    reflow_line_segs, ParagraphBox,
};
use std::collections::{BTreeSet, HashMap};

type Pos = (usize, usize, usize);
type Address = (usize, usize);

enum Previous {
    Character {
        start: usize,
        end: usize,
        runs: Vec<CharShapeRef>,
    },
    Paragraph(u16),
}

enum Format {
    Character(crate::model::style::CharShapeMods),
    Paragraph(crate::model::style::ParaShapeMods, Option<String>),
}

// [hwpx-cowork] 미방문 문단은 범위와 서식만으로 표현한다. 이력 핸들과 미완 작업은 같은
// 원본 값을 소유하므로 Studio에서 이력을 비워도 이미 요청한 서식은 끝까지 적용된다.
struct RangeChange {
    start: Pos,
    end: Pos,
    format: Format,
    reflow: bool,
    applied: bool,
    original: HashMap<Address, Previous>,
}

#[derive(Clone)]
pub(crate) struct BodyFormat(Option<std::sync::Arc<std::sync::Mutex<RangeChange>>>);

impl BodyFormat {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_none()
    }
}

// [hwpx-cowork] 기존 원장의 문단별 이벤트를 명령을 내린 순서와 주소로 직렬화한다.
pub(super) type RangeEvents =
    std::sync::Arc<std::sync::Mutex<std::collections::BTreeMap<(usize, usize), DocumentEvent>>>;

pub(super) struct RangePass {
    history: BodyFormat,
    forward: bool,
    // [hwpx-cowork] 모양표가 스냅샷 복원으로 교체될 수 있어 ID 매핑은 실행 단위로 보관한다.
    char_ids: HashMap<u32, u32>,
    para_ids: HashMap<u16, u16>,
    events: RangeEvents,
    visited: std::collections::HashSet<Address>,
    // 문단 구조가 바뀌면 새 좌표를 이 명령을 내렸던 순간의 좌표로 역변환한다.
    edits: Vec<(usize, usize, bool)>,
}

impl RangePass {
    fn original_address(&self, section: usize, mut p: usize) -> Option<Address> {
        for &(s, at, inserted) in self.edits.iter().rev() {
            if s != section || at > p {
                continue;
            }
            if inserted {
                if p == at {
                    return None;
                }
                p -= 1;
            } else {
                p += 1;
            }
        }
        Some((section, p))
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
        paragraph: Option<bool>,
    ) -> Result<BodyFormat, HwpError> {
        let props: serde_json::Value = serde_json::from_str(properties).map_err(|_| invalid())?;
        let map = props.as_object().ok_or_else(invalid)?;
        self.validate_format_bounds(start, end)?;
        // [hwpx-cowork] 기존 호출은 네 가지 서식을 이름으로 구분했다. 최신 Studio는
        // 글자/문단 종류를 전달하므로 복합 속성도 단일 문단과 같은 해석기를 사용한다.
        let paragraph = match paragraph {
            Some(kind) => kind,
            None if map.len() == 1
                && map
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
                    }) =>
            {
                true
            }
            None if map.len() == 1
                && (map.get("fontSize").is_some_and(|v| {
                    v.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64)
                }) || ["strikethrough", "underline"]
                    .iter()
                    .any(|key| map.get(*key).is_some_and(|v| v.is_boolean()))) =>
            {
                false
            }
            None => return Err(invalid()),
        };
        use super::commands::formatting::{
            char_shape_mods_affect_text_flow, para_shape_mods_affect_text_flow,
        };
        use super::helpers::{
            char_format_props_have_effect, json_has_border_keys, json_has_tab_keys,
            para_format_props_have_effect, parse_json_i16_array,
        };
        let (format, reflow) = if paragraph {
            if !para_format_props_have_effect(properties) {
                return Ok(BodyFormat(None));
            }
            let mut mods = parse_para_shape_mods(properties);
            if json_has_border_keys(properties) {
                mods.border_fill_id = Some(self.create_border_fill_from_json(properties));
            }
            if let Some(a) = parse_json_i16_array(properties, "borderSpacing", 4) {
                mods.border_spacing = Some([a[0], a[1], a[2], a[3]]);
            }
            let reflow = para_shape_mods_affect_text_flow(&mods);
            (
                Format::Paragraph(
                    mods,
                    json_has_tab_keys(properties).then(|| properties.to_owned()),
                ),
                reflow,
            )
        } else {
            if !char_format_props_have_effect(properties) {
                return Ok(BodyFormat(None));
            }
            let mut mods = parse_char_shape_mods(properties);
            if json_has_border_keys(properties) {
                mods.border_fill_id = Some(self.create_border_fill_from_json(properties));
            }
            let reflow = char_shape_mods_affect_text_flow(&mods);
            (Format::Character(mods), reflow)
        };
        if start == end && matches!(format, Format::Character(_)) {
            return Ok(BodyFormat(None));
        }
        let history = BodyFormat(Some(std::sync::Arc::new(std::sync::Mutex::new(
            RangeChange {
                start,
                end,
                format,
                reflow,
                applied: true,
                original: Default::default(),
            },
        ))));
        self.queue_range_pass(&history, true, start, focus_page);
        Ok(history)
    }

    fn validate_format_bounds(&self, start: Pos, end: Pos) -> Result<(), HwpError> {
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
        Ok(())
    }

    pub(crate) fn swap_body_range_format(
        &mut self,
        history: &mut BodyFormat,
        focus: u32,
    ) -> Result<(), HwpError> {
        let Some(shared) = &history.0 else {
            return Ok(());
        };
        let mut change = shared.lock().unwrap();
        let (start, end) = (change.start, change.end);
        self.validate_format_bounds(start, end)?;
        change.applied = !change.applied;
        let forward = change.applied;
        drop(change);
        self.queue_range_pass(history, forward, start, focus);
        Ok(())
    }

    fn queue_range_pass(&mut self, history: &BodyFormat, forward: bool, start: Pos, focus: u32) {
        // [hwpx-cowork] 명령 등록과 Undo/Redo는 같은 경로다. 전체 구역의 스타일·수식·번호를
        // 다시 풀지 않고, 실제로 읽히는 문단에서만 모양을 만들고 이전 값을 기록한다.
        self.invalidate_interactive_layout(start.0);
        let work = &mut self.interactive_layout;
        let events = RangeEvents::default();
        self.range_event_log
            .push((self.event_log.len(), events.clone()));
        work.ranges.push(RangePass {
            history: history.clone(),
            forward,
            char_ids: Default::default(),
            para_ids: Default::default(),
            events,
            visited: Default::default(),
            edits: Vec::new(),
        });
        let first = (start.0, start.1);
        work.format_cursor = Some(work.format_cursor.map_or(first, |v| v.min(first)));
        work.projected_pages.clear();
        self.request_interactive_layout();
        self.prepare_format_page(focus);
        if !self.interactive_layout.pending {
            // 명시적 동기·배치 API는 호출이 끝났을 때 원문 전체가 확정되어야 한다.
            self.step_format_rows(0.0, f64::INFINITY);
            self.paginate_if_needed();
        }
    }

    pub(crate) fn rebase_body_formats(&mut self, s: usize, p: usize, inserted: bool) {
        self.interactive_layout.unpublished_structure |= self.interactive_layout.pending;
        if !self.interactive_layout.ranges.is_empty() {
            for pass in &mut self.interactive_layout.ranges {
                pass.edits.push((s, p, inserted));
            }
            let cursor = &mut self.interactive_layout.format_cursor;
            *cursor = Some(cursor.map_or((s, p), |old| old.min((s, p))));
        }
    }

    // [hwpx-cowork] 읽기·쓰기·유휴 조판 모두 같은 명령 순서를 재생한다. 이미 방문한
    // 문단은 다음 키 때 다시 변환하지 않는다. 원문 서식의 적용과 줄 조합은 별개다.
    pub(crate) fn resolve_body_format_at(&mut self, s: usize, p: usize) {
        if self.interactive_layout.ranges.is_empty()
            || self
                .document
                .sections
                .get(s)
                .is_none_or(|section| p >= section.paragraphs.len())
        {
            return;
        }
        let mut changed = false;
        let mut old_spaces = None;
        let stored_layout = self.document.layout_profile().hwpx_stored_layout();
        for pass in &mut self.interactive_layout.ranges {
            let Some(key) = pass.original_address(s, p) else {
                continue;
            };
            let mut c = pass.history.0.as_ref().unwrap().lock().unwrap();
            if key < (c.start.0, c.start.1) || key > (c.end.0, c.end.1) || !pass.visited.insert(key)
            {
                continue;
            }
            self.interactive_layout.range_visits += 1;
            let c = &mut *c;
            let para = &self.document.sections[s].paragraphs[p];
            match &c.format {
                Format::Character(mods) => {
                    let from = if key == (c.start.0, c.start.1) {
                        c.start.2
                    } else {
                        0
                    };
                    let to = if key == (c.end.0, c.end.1) {
                        c.end.2
                    } else {
                        para.text.chars().count()
                    };
                    if from >= to {
                        continue;
                    }
                    if stored_layout && old_spaces.is_none() {
                        old_spaces = Some(
                            crate::renderer::style_resolver::SpaceStyleUsage::body_ids(para),
                        );
                    }
                    if pass.forward {
                        let runs = para.char_shape_refs_in_range(from, to);
                        for run in &runs {
                            let id = run.char_shape_id;
                            pass.char_ids.entry(id).or_insert_with(|| {
                                self.document.find_or_create_char_shape(id, mods)
                            });
                        }
                        let para = &mut self.document.sections[s].paragraphs[p];
                        para.try_map_char_shape_range(from, to, |id| {
                            Ok::<_, std::convert::Infallible>(pass.char_ids[&id])
                        })
                        .unwrap_or_else(|never| match never {});
                        c.original.entry(key).or_insert(Previous::Character {
                            start: from,
                            end: to,
                            runs,
                        });
                    } else if let Some(Previous::Character { start, end, runs }) =
                        c.original.get(&key)
                    {
                        self.document.sections[s].paragraphs[p]
                            .restore_char_shape_refs(*start, *end, runs);
                    } else {
                        continue;
                    }
                    let para = &mut self.document.sections[s].paragraphs[p];
                    para.interactive_format_dirty = true;
                    para.interactive_format_reflow |= c.reflow;
                    pass.events.lock().unwrap().insert(
                        key,
                        DocumentEvent::CharFormatChanged {
                            section: key.0,
                            para: key.1,
                            start: from,
                            end: to,
                        },
                    );
                }
                Format::Paragraph(mods, tabs) => {
                    let old = para.para_shape_id;
                    let id = if pass.forward {
                        c.original.entry(key).or_insert(Previous::Paragraph(old));
                        *pass.para_ids.entry(old).or_insert_with(|| {
                            let mut mods = mods.clone();
                            if let Some(json) = tabs {
                                let definitions = &self.document.doc_info.tab_defs;
                                let base = self
                                    .document
                                    .doc_info
                                    .para_shapes
                                    .get(old as usize)
                                    .map_or(0, |shape| shape.tab_def_id);
                                let tab = super::helpers::build_tab_def_from_json(
                                    json,
                                    base,
                                    definitions,
                                );
                                mods.tab_def_id = Some(self.document.find_or_create_tab_def(tab));
                            }
                            self.document.find_or_create_para_shape(old, &mods)
                        })
                    } else if let Some(Previous::Paragraph(id)) = c.original.get(&key) {
                        *id
                    } else {
                        continue;
                    };
                    let shapes = &self.document.doc_info.para_shapes;
                    let para = &mut self.document.sections[s].paragraphs[p];
                    if let (Some(before), Some(after)) =
                        (shapes.get(old as usize), shapes.get(id as usize))
                    {
                        crate::renderer::composer::restamp_indentation(
                            &mut para.line_segs,
                            before.indent,
                            after.indent,
                        );
                        if super::commands::formatting::marker_shape_changed(before, after) {
                            para.invalidate_layout_inputs();
                            self.interactive_layout.range_numbering_dirty = true;
                        }
                    }
                    para.para_shape_id = id;
                    self.composed[s][p].para_style_id = id;
                    if c.reflow || mods.spacing_before.is_some() || mods.spacing_after.is_some() {
                        para.interactive_format_dirty = true;
                        para.interactive_format_reflow |= c.reflow;
                        para.interactive_format_spacing |=
                            mods.spacing_before.is_some() || mods.spacing_after.is_some();
                    }
                    self.interactive_layout.formatted_rows.insert((s, p));
                    pass.events.lock().unwrap().insert(
                        key,
                        DocumentEvent::ParaFormatChanged {
                            section: key.0,
                            para: key.1,
                        },
                    );
                }
            }
            changed = true;
        }
        if changed {
            self.document.sections[s].raw_stream = None;
            self.dirty_sections[s] = true;
            self.only_text_edits_pending.set(false);
            let floor = self.typeset_unchanged_before.get(s).copied();
            self.note_typeset_change(s, floor, p);
            self.invalidate_render_normalization_section(s);
            self.mark_paragraph_dirty(s, p);
            let usage_changed = old_spaces.is_some_and(|old| {
                let new = crate::renderer::style_resolver::SpaceStyleUsage::body_ids(
                    &self.document.sections[s].paragraphs[p],
                );
                old != new
                    && std::sync::Arc::make_mut(&mut self.styles.space_usage)
                        .replace_body(&old, &new)
            });
            self.refresh_range_style_definitions(usage_changed);
        }
    }

    // [hwpx-cowork] 본문 크기·장식·정렬은 수식 세대와 목록 정의를 바꾸지 않는다. 모양
    // 정의표와 누적 공백 사용처만 같은 해소기에 전달한다. 원문/구역 전체 순회를 피한다.
    pub(crate) fn refresh_range_style_definitions(&mut self, usage_changed: bool) {
        if self.styles.char_styles.len() == self.document.doc_info.char_shapes.len()
            && self.styles.para_styles.len() == self.document.doc_info.para_shapes.len()
            && !usage_changed
        {
            return;
        }
        let mut styles = crate::renderer::style_resolver::resolve_styles_with_usage(
            &self.document,
            self.dpi,
            self.resolved_font_environment(),
            self.effective_layout_profile(),
            Some(&self.styles.space_usage),
        );
        styles.native_pua_fonts = self.native_pua_fonts.clone();
        styles.hangul2024_missing_glyphs = self.hangul2024_compat;
        styles.supplemental_metrics = self.styles.supplemental_metrics.clone();
        styles.kerning_measurement_context = self.styles.kerning_measurement_context.clone();
        styles.horizontal_shaping_context = self.styles.horizontal_shaping_context.clone();
        self.styles = styles;
    }

    // [hwpx-cowork] 삭제된 본문은 Undo 전까지 조판하지 않는다. 명시적으로 변경 원장을
    // 읽을 때만 보관된 원문의 길이에서 서식 이벤트를 완성한다.
    pub(crate) fn record_detached_range_events(&self) {
        for pass in &self.interactive_layout.ranges {
            let change = pass.history.0.as_ref().unwrap().lock().unwrap();
            let mut events = pass.events.lock().unwrap();
            for (s, section) in self.document.sections.iter().enumerate() {
                for (p, para) in section.paragraphs.iter().enumerate() {
                    let Some(key) = pass.original_address(s, p) else {
                        continue;
                    };
                    if key < (change.start.0, change.start.1)
                        || key > (change.end.0, change.end.1)
                        || pass.visited.contains(&key)
                    {
                        continue;
                    }
                    events.entry(key).or_insert_with(|| match &change.format {
                        Format::Paragraph(_, _) => DocumentEvent::ParaFormatChanged {
                            section: key.0,
                            para: key.1,
                        },
                        Format::Character(_) => DocumentEvent::CharFormatChanged {
                            section: key.0,
                            para: key.1,
                            start: if key == (change.start.0, change.start.1) {
                                change.start.2
                            } else {
                                0
                            },
                            end: if key == (change.end.0, change.end.1) {
                                change.end.2
                            } else {
                                para.char_offsets.len()
                            },
                        },
                    });
                    if matches!(events.get(&key), Some(DocumentEvent::CharFormatChanged {start, end, ..}) if start >= end)
                    {
                        events.remove(&key);
                    }
                }
            }
        }
    }

    pub(crate) fn resolve_body_format_span(&mut self, s: usize, first: usize, last: usize) {
        if self.interactive_layout.ranges.is_empty() {
            return;
        }
        let Some(section) = self.document.sections.get(s) else {
            return;
        };
        for p in first..last.saturating_add(1).min(section.paragraphs.len()) {
            self.resolve_body_format_at(s, p);
        }
    }

    // [hwpx-cowork] 원본 전체가 필요한 기존 명령(스냅샷·구역 재편집·내보내기)은
    // 미완 서식만 먼저 확정한다. 화면 뒤쪽의 조판은 여전히 별도로 진행할 수 있다.
    pub(crate) fn finish_range_source(&mut self) {
        if self.interactive_layout.ranges.is_empty() {
            return;
        }
        for s in 0..self.document.sections.len() {
            for p in 0..self.document.sections[s].paragraphs.len() {
                self.resolve_body_format_at(s, p);
            }
        }
        self.interactive_layout.ranges.clear();
    }

    /// [hwpx-cowork] 전체 선택이 커서를 끝으로 옮긴 뒤에도 실제로 요청한 쪽의 줄부터 계산한다.
    pub(crate) fn prepare_format_page(&mut self, page: u32) {
        if self.interactive_layout.format_cursor.is_none()
            && self.interactive_layout.formatted_rows.is_empty()
        {
            return;
        }
        // [hwpx-cowork] 쪽에 실린 문단만 먼저 원문에 적용한다. 선택 끝까지의 탐색은 없다.
        let mut owners = BTreeSet::new();
        if !self.interactive_layout.ranges.is_empty() {
            for index in [page, page.saturating_add(1)] {
                if self.interactive_layout.projected_pages.contains(&index) {
                    continue;
                }
                if let Ok((published, _, _)) = self.find_page(index) {
                    for item in published.column_contents.iter().flat_map(|c| &c.items) {
                        owners.insert((published.section_index, item.para_index()));
                    }
                }
            }
            for (s, p) in owners {
                self.resolve_body_format_at(s, p);
            }
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
            let mut widths = HashMap::new();
            for (s, p) in visible {
                let width = *widths.entry(s).or_insert_with(|| self.range_body_width(s));
                self.materialize_body_format(s, p, width);
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
        if let Some((s, local, first, last)) = self.independent_format_page_bounds(page_number) {
            self.project_format_window(page_number, s, local, first, last, None);
        }
    }

    pub(super) fn independent_format_page_bounds(
        &self,
        page_number: u32,
    ) -> Option<(usize, usize, usize, usize)> {
        use crate::model::paragraph::ColumnBreakType;
        use crate::renderer::pagination::PageItem;
        let Ok((page, _, _)) = self.find_page(page_number) else {
            return None;
        };
        if !page.footnotes.is_empty() || page.column_contents.len() != 1 {
            return None;
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
            return None;
        }
        let section_idx = page.section_index;
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
            return None;
        }
        let section = &self.document.sections[section_idx];
        if last >= section.paragraphs.len()
            || (first != 0 && section.paragraphs[first].column_type != ColumnBreakType::Page)
            || section
                .paragraphs
                .get(last + 1)
                .is_some_and(|p| p.column_type != ColumnBreakType::Page)
        {
            return None;
        }
        Some((section_idx, local, first, last))
    }

    // [hwpx-cowork] 쪽 범위가 독립임을 확인한 뒤에는 Enter로 새 문단·쪽이 생겨도 이전
    // 쪽 소유자 번호를 재사용하지 않는다. 원래 쪽을 대체하고 뒤쪽 표·문단 주소를 옮긴다.
    pub(super) fn project_format_window(
        &mut self,
        page_number: u32,
        section_idx: usize,
        local: usize,
        first: usize,
        last: usize,
        structural: Option<usize>,
    ) -> bool {
        use crate::renderer::height_measurer::HeightMeasurer;
        use crate::renderer::pagination::EndnoteDeferral;
        use crate::renderer::typeset::{SectionTypesetInput, TypesetEngine};
        let width = self.range_body_width(section_idx);
        for p in first..=last {
            if self.document.sections[section_idx].paragraphs[p].interactive_format_dirty {
                self.materialize_body_format(section_idx, p, width);
            }
        }
        let Ok((page, _, _)) = self.find_page(page_number) else {
            return false;
        };
        let width = page.layout.column_areas.first().map(|area| area.width);
        let section = &self.document.sections[section_idx];
        let paragraphs = &section.paragraphs[first..=last];
        let composed = &self.composed[section_idx][first..=last];
        // 구역 첫 쪽에서만 다른 종이/다단/머리말 상태를 만드는 경우는 확정된 일반 조판이 처리한다.
        let Some(col_def) = self
            .interactive_layout
            .initial_columns
            .get(section_idx)
            .cloned()
        else {
            return false;
        };
        if col_def.column_count > 1 {
            return false;
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
        if !engine.step_section(
            &mut job,
            &input,
            paragraphs.len() + 1,
            if structural.is_some() { 4 } else { 2 },
        ) {
            return false;
        }
        let result = engine.finish_section(job, &input);
        if result.pages.is_empty()
            || (structural.is_none() && result.pages.len() != 1)
            || !result.endnotes.is_empty()
        {
            return false;
        }
        let expected = page.layout.body_area;
        if result.pages.iter().any(|patch| {
            let actual = patch.layout.body_area;
            !patch.footnotes.is_empty()
                || patch.column_contents.len() != 1
                || (expected.x, expected.y, expected.width, expected.height)
                    != (actual.x, actual.y, actual.width, actual.height)
        }) {
            return false;
        }
        let first_number = page.page_number;
        let delta_pages = result.pages.len() - 1;
        let after = local + result.pages.len();
        let mut patches: Vec<_> = result
            .pages
            .into_iter()
            .enumerate()
            .map(|(i, patch)| {
                let mut patch = patch.into_shifted(first as i32);
                patch.page_index = (local + i) as u32;
                patch.page_number = first_number + i as u32;
                patch
            })
            .collect();
        let pages = &mut self.pagination[section_idx].pages;
        if structural.is_none() {
            let patch = patches.pop().unwrap();
            pages[local].column_contents = patch.column_contents;
            pages[local].ladder_band_tables = patch.ladder_band_tables;
            return true;
        }
        let inserted = structural.unwrap();
        let old_range = first..last + 1 - inserted;
        let paint = &mut self.measured_tables[section_idx];
        let begin = paint.partition_point(|t| t.para_index < old_range.start);
        let end = paint.partition_point(|t| t.para_index < old_range.end);
        for t in &mut paint[end..] {
            t.para_index += inserted;
        }
        paint.splice(
            begin..end,
            fresh.tables.into_iter().map(|mut t| {
                t.para_index += first;
                t
            }),
        );
        // 매 쪽의 머리말과 바탕쪽은 독립 조판에서 재생성하지 않는다. 기존 쪽의 값을 계승한다.
        for patch in &mut patches {
            patch.active_header = pages[local].active_header.clone();
            patch.active_footer = pages[local].active_footer.clone();
            patch.active_master_page = pages[local].active_master_page.clone();
            patch.extra_master_pages = pages[local].extra_master_pages.clone();
        }
        pages.splice(local..=local, patches);
        if inserted != 0 || delta_pages != 0 {
            let suffix = pages.split_off(after);
            pages.extend(suffix.into_iter().map(|page| {
                let mut page = page.into_shifted(inserted as i32);
                page.page_index += delta_pages as u32;
                page.page_number += delta_pages as u32;
                page
            }));
        }
        let layout = &mut self.pagination[section_idx];
        use super::flow_window::{splice_heights, splice_set};
        splice_set(
            &mut layout.hidden_empty_paras,
            result.hidden_empty_paras,
            &old_range,
            inserted,
        );
        splice_set(
            &mut layout.pre_emitted_host_paras,
            result.pre_emitted_host_paras,
            &old_range,
            inserted,
        );
        splice_heights(
            &mut layout.pre_emitted_host_heights,
            result.pre_emitted_host_heights,
            &old_range,
            inserted,
        );
        splice_heights(
            &mut layout.pre_emitted_host_content_heights,
            result.pre_emitted_host_content_heights,
            &old_range,
            inserted,
        );
        for later in &mut self.pagination[section_idx + 1..] {
            if delta_pages != 0 {
                for page in &mut later.pages {
                    page.page_number += delta_pages as u32;
                }
            }
        }
        self.interactive_layout.unpublished_structure = false;
        self.invalidate_page_tree_cache();
        true
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
        self.resolve_body_format_at(section, paragraph);
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
            self.materialize_body_format(section, paragraph, self.range_body_width(section));
        }
    }

    fn range_body_width(&self, s: usize) -> f64 {
        self.interactive_layout.initial_columns.get(s).map_or_else(
            || self.body_wrap_width(s),
            |column| {
                let page = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
                    &self.document.sections[s].section_def.page_def,
                    column,
                    self.dpi,
                );
                page.column_areas
                    .first()
                    .map_or(page.body_area.width, |c| c.width)
            },
        )
    }

    fn materialize_body_format(&mut self, s: usize, p: usize, width: f64) {
        let styles = &self.styles;
        let hwp3 = self.document.layout_profile().hwp3_layout();
        let para = &mut self.document.sections[s].paragraphs[p];
        self.interactive_layout.formatted_rows.insert((s, p));
        let reflow = para.interactive_format_reflow;
        para.interactive_format_dirty = false;
        para.interactive_format_reflow = false;
        let spacing = std::mem::take(&mut para.interactive_format_spacing);
        let old_end = paragraph_flow_end(para);
        if reflow {
            let box_ = ParagraphBox::body_for_style(
                width,
                styles.para_styles.get(para.para_shape_id as usize),
                self.dpi,
            );
            reflow_line_segs(para, box_, styles, self.dpi);
            if let Some(grid) = self.document.sections[s].section_def.cell_grid() {
                crate::renderer::cell_grid::fit_edited_paragraph(
                    &mut self.document.sections[s].paragraphs[p],
                    &self.document.doc_info.para_shapes,
                    grid,
                    width,
                    &self.styles,
                    self.dpi,
                );
            }
        }
        if reflow || spacing {
            recalculate_section_vpos(
                &mut self.document.sections[s].paragraphs,
                p,
                None,
                old_end,
                &self.styles,
                self.dpi,
                hwp3,
            );
        }
        let styles = &self.styles;
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
        while s < self.document.sections.len() {
            // [hwpx-cowork] 구역의 단 폭은 같은 조각 안에서 문단마다 찾지 않는다.
            let width = self.range_body_width(s);
            while p < self.document.sections[s].paragraphs.len() {
                self.resolve_body_format_at(s, p);
                if self.document.sections[s].paragraphs[p].interactive_format_dirty {
                    self.materialize_body_format(s, p, width);
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
        self.interactive_layout.ranges.clear();
        if std::mem::take(&mut self.interactive_layout.range_numbering_dirty) {
            crate::renderer::layout::assign_numbering_markers(
                &mut self.document.sections,
                &self.styles,
            );
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
