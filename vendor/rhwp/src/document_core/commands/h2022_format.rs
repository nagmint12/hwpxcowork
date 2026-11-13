//! [hwpx-cowork] 한/글 2022 서식·쪽 기능 (2026-11-11, h2022-format).
//!
//! - 단 정의 읽기·쓰기: 캐럿 문단에 **실제로 적용되는** 단 정의(구역 가운데 다단 설정 나누기로 시작한
//!   다단 포함)를 고친다. 한/글 2022 COM 실측(ColDef ApplyTo=2 '현재 다단'): 둘째 다단에서 바꾸면 그 다단의
//!   `hp:colPr` 만 바뀌고 구역 첫 단 정의는 그대로다. 구분선(`hp:colLine` 종류·굵기·색)·단 방향·단별 너비도 같다.
//! - 다단 설정 나누기(BreakColDef): 한/글 실측 — 문단 가운데는 문단을 가르고 뒤 문단 머리에 단 정의를 넣는다,
//!   문단 끝은 다음 문단 머리, 문단 처음은 그 문단 머리. 새 단 정의는 **캐럿 자리의 단 정의를 그대로 잇는다**
//!   (2단·구분선 구역 가운데에서 나눠도 새 `hp:colPr` 가 colCount=2·colLine 그대로). '새 다단으로'(ApplyTo=9)도
//!   같은 자리에서 나눈 뒤 새 다단에 값을 준다.
//! - 쪽 번호 매기기의 시작 번호(PageNumPos NewNumber): 한/글 실측 — 시작 번호 7 이면 구역 첫 문단의 쪽 번호
//!   위치 바로 뒤에 `hp:newNum numType="PAGE" num="7"` 이 들어가고, 이미 있으면 그 값만 바뀐다(7 → 1 이면 num=1
//!   이 남는다). 새 번호가 없을 때 시작 번호 1(기본값)은 아무것도 넣지 않는다(첫 구역·둘째 구역 모두).
//!
//! 근거 파일: `artifacts/h2022-format/com/result*.json`(한/글 2022 COM, `probe.py`).
use crate::document_core::helpers::{
    clipboard_color_to_css, css_color_to_bgr, json_ok_with, logical_paragraph_length, logical_to_text_offset,
};
use crate::document_core::inline_control::{active_shape, insert_slot, Slot};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{AutoNumberType, Control, NewNumber};
use crate::model::page::{ColumnDef, ColumnDirection, ColumnType};
use crate::model::paragraph::{CharShapeRef, ColumnBreakType, Paragraph};
use crate::renderer::composer::{reflow_line_segs, ParagraphBox};
use crate::renderer::page_layout::PageLayoutInfo;
use crate::serializer::body_text::control_stream_slots;

fn invalid(message: impl Into<String>) -> HwpError {
    HwpError::RenderError(message.into())
}

/// `para_idx` 문단에 적용되는 단 정의의 자리(문단, 컨트롤 차례). 조판의 `find_column_def_for_paragraph` 와 같은 규칙.
fn column_def_owner(paragraphs: &[Paragraph], para_idx: usize) -> Option<(usize, usize)> {
    let mut owner = None;
    for (pi, para) in paragraphs.iter().enumerate().take(para_idx.saturating_add(1)) {
        for (ci, ctrl) in para.controls.iter().enumerate() {
            if matches!(ctrl, Control::ColumnDef(_)) {
                owner = Some((pi, ci));
            }
        }
    }
    owner
}

/// 단 정의가 다스리는 문단 범위 [start, end) — 다음 단 정의 문단 앞까지.
fn zone_range(paragraphs: &[Paragraph], owner_para: usize) -> (usize, usize) {
    let end = paragraphs
        .iter()
        .enumerate()
        .skip(owner_para + 1)
        .find(|(_, p)| p.controls.iter().any(|c| matches!(c, Control::ColumnDef(_))))
        .map(|(i, _)| i)
        .unwrap_or(paragraphs.len());
    (owner_para, end)
}

fn column_type_code(t: ColumnType) -> u8 {
    match t {
        ColumnType::Normal => 0,
        ColumnType::Distribute => 1,
        ColumnType::Parallel => 2,
    }
}

fn direction_code(d: ColumnDirection) -> u8 {
    match d {
        ColumnDirection::LeftToRight => 0,
        ColumnDirection::RightToLeft => 1,
        ColumnDirection::Mirror => 2,
    }
}

/// 단 정의 JSON(편집기 다단 설정 창이 쓰는 꼴). `bodyWidth` 는 구역 본문 폭(HWPUNIT)이다.
fn column_def_json(cd: &ColumnDef, body_width_hu: i64, owner: Option<(usize, usize)>, initial: bool) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "exists": owner.is_some(),
        "ownerPara": owner.map(|o| o.0),
        "sectionInitial": initial,
        "columnCount": cd.column_count.max(1),
        "columnType": column_type_code(cd.column_type),
        "direction": direction_code(cd.direction),
        "sameWidth": cd.same_width,
        "spacing": cd.spacing,
        "widths": cd.widths.iter().map(|w| (*w as u16) as u32).collect::<Vec<_>>(),
        "gaps": cd.gaps.iter().map(|g| (*g as u16) as u32).collect::<Vec<_>>(),
        "proportional": cd.proportional_widths,
        "separatorType": cd.separator_type,
        "separatorWidth": cd.separator_width,
        "separatorColor": clipboard_color_to_css(cd.separator_color),
        "bodyWidth": body_width_hu,
    })
}

/// JSON 값을 단 정의에 얹는다. 빠진 키는 그대로 둔다.
fn apply_column_props(cd: &mut ColumnDef, props: &serde_json::Value) -> Result<(), HwpError> {
    let num = |key: &str| props.get(key).and_then(|v| v.as_i64());
    if let Some(n) = num("columnCount") {
        if !(1..=255).contains(&n) {
            return Err(invalid("단 개수는 1~255 이어야 합니다"));
        }
        cd.column_count = n as u16;
    }
    if let Some(t) = num("columnType") {
        cd.column_type = match t {
            1 => ColumnType::Distribute,
            2 => ColumnType::Parallel,
            _ => ColumnType::Normal,
        };
    }
    if let Some(d) = num("direction") {
        cd.direction = match d {
            1 => ColumnDirection::RightToLeft,
            2 => ColumnDirection::Mirror,
            _ => ColumnDirection::LeftToRight,
        };
    }
    if let Some(s) = num("spacing") {
        cd.spacing = s.clamp(0, i16::MAX as i64) as i16;
    }
    if let Some(b) = props.get("sameWidth").and_then(|v| v.as_bool()) {
        cd.same_width = b;
    }
    let list = |key: &str| -> Option<Vec<i16>> {
        props.get(key).and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .map(|x| x.as_i64().unwrap_or(0).clamp(0, u16::MAX as i64) as u16 as i16)
                .collect()
        })
    };
    let count = cd.column_count.max(1) as usize;
    if cd.same_width || count <= 1 {
        cd.widths.clear();
        cd.gaps.clear();
    } else if let Some(widths) = list("widths") {
        if widths.len() != count {
            return Err(invalid("단별 너비 개수가 단 개수와 다릅니다"));
        }
        let mut gaps = list("gaps").unwrap_or_default();
        gaps.resize(count, 0);
        // 마지막 단 뒤 간격은 없다(한/글 ColDef WidthGap 은 Count*2-1 개)
        gaps[count - 1] = 0;
        cd.widths = widths;
        cd.gaps = gaps;
        cd.proportional_widths = true;
    } else if cd.widths.len() != count {
        // 단 수가 바뀌었는데 너비가 없으면 같은 너비로 돌린다
        cd.widths.clear();
        cd.gaps.clear();
        cd.same_width = true;
    }
    if let Some(t) = num("separatorType") {
        cd.separator_type = t.clamp(0, 255) as u8;
    }
    if let Some(w) = num("separatorWidth") {
        cd.separator_width = w.clamp(0, 255) as u8;
    }
    if let Some(c) = props.get("separatorColor").and_then(|v| v.as_str()) {
        if let Some(bgr) = css_color_to_bgr(c) {
            cd.separator_color = bgr;
        }
    }
    // HWP 저장은 raw_attr 가 있으면 그 값을 쓴다 — 비워서 바꾼 필드로 다시 만들게 한다(#7523 과 같은 이유).
    cd.raw_attr = 0;
    Ok(())
}

impl DocumentCore {
    fn h2022_body_width_hu(&self, section_idx: usize) -> i64 {
        let section = &self.document.sections[section_idx];
        let layout = PageLayoutInfo::from_page_def(
            &section.section_def.page_def,
            &ColumnDef { column_count: 1, ..ColumnDef::default() },
            self.dpi,
        );
        (layout.body_area.width * 7200.0 / self.dpi).round() as i64
    }

    /// 캐럿 문단에 적용되는 단 정의를 읽는다.
    pub fn get_column_def_at_native(&self, section_idx: usize, para_idx: usize) -> Result<String, HwpError> {
        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| invalid("구역 범위 초과"))?;
        let owner = column_def_owner(&section.paragraphs, para_idx);
        let first = column_def_owner(&section.paragraphs, 0)
            .or_else(|| column_def_owner(&section.paragraphs, usize::MAX));
        let cd = owner
            .and_then(|(pi, ci)| match &section.paragraphs[pi].controls[ci] {
                Control::ColumnDef(cd) => Some(cd.clone()),
                _ => None,
            })
            .unwrap_or(ColumnDef { column_count: 1, same_width: true, ..ColumnDef::default() });
        let initial = owner.is_none() || owner.map(|o| o.0) == first.map(|o| o.0);
        Ok(column_def_json(&cd, self.h2022_body_width_hu(section_idx), owner, initial).to_string())
    }

    /// 캐럿 문단에 적용되는 단 정의('현재 다단')를 고친다. 단 정의가 없는 구역은 구역 첫 단 정의를 만든다.
    pub fn set_column_def_at_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let props: serde_json::Value =
            serde_json::from_str(props_json).map_err(|e| invalid(format!("단 정의 JSON 오류: {e}")))?;
        if section_idx >= self.document.sections.len() {
            return Err(invalid("구역 범위 초과"));
        }
        if para_idx >= self.document.sections[section_idx].paragraphs.len() {
            return Err(invalid("문단 범위 초과"));
        }
        let mut owner = column_def_owner(&self.document.sections[section_idx].paragraphs, para_idx);
        if owner.is_none() {
            // 단 정의가 없는 구역 — 종전 API 로 구역 첫 단 정의를 만든 뒤 고친다.
            self.set_column_def_native(section_idx, 1, 0, true, 0)?;
            owner = column_def_owner(&self.document.sections[section_idx].paragraphs, para_idx);
        }
        let (pi, ci) = owner.ok_or_else(|| invalid("단 정의를 만들지 못했습니다"))?;
        let before = match &self.document.sections[section_idx].paragraphs[pi].controls[ci] {
            Control::ColumnDef(cd) => cd.clone(),
            _ => return Err(invalid("단 정의 자리가 아닙니다")),
        };
        let mut next = before.clone();
        apply_column_props(&mut next, &props)?;
        if let Control::ColumnDef(cd) = &mut self.document.sections[section_idx].paragraphs[pi].controls[ci] {
            *cd = next.clone();
        }
        self.h2022_after_column_change(section_idx, pi, &before, &next);
        Ok(json_ok_with(&format!("\"ownerPara\":{}", pi)))
    }

    /// 다단 설정 나누기(BreakColDef). 새 다단의 단 정의는 캐럿 자리의 것을 잇고 `props_json`(있으면)을 얹는다.
    /// 돌려주는 `para`·`charOffset` 은 새 다단 첫 문단의 캐럿 자리다.
    pub fn insert_column_def_break_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        props_json: &str,
    ) -> Result<String, HwpError> {
        let props: serde_json::Value = if props_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(props_json).map_err(|e| invalid(format!("단 정의 JSON 오류: {e}")))?
        };
        let section = self
            .document
            .sections
            .get(section_idx)
            .ok_or_else(|| invalid("구역 범위 초과"))?;
        let para = section.paragraphs.get(para_idx).ok_or_else(|| invalid("문단 범위 초과"))?;
        let length = logical_paragraph_length(para);
        let offset = char_offset.min(length);
        let last = para_idx + 1 == section.paragraphs.len();
        let mut inherited = column_def_owner(&section.paragraphs, para_idx)
            .and_then(|(pi, ci)| match &section.paragraphs[pi].controls[ci] {
                Control::ColumnDef(cd) => Some(cd.clone()),
                _ => None,
            })
            .unwrap_or(ColumnDef { column_count: 1, same_width: true, ..ColumnDef::default() });
        // 한/글 실측: 문단 끝 → 다음 문단, 문단 처음 → 그 문단, 가운데 → 갈라 뒤 문단.
        // 구역 첫 문단의 처음과 마지막 문단의 끝은 갈라서 빈 문단을 만든다(단 정의를 둘 문단이 따로 있어야 한다).
        let target = if offset == length && length > 0 && !last {
            para_idx + 1
        } else if offset == 0 && para_idx > 0 {
            para_idx
        } else {
            self.split_paragraph_native(section_idx, para_idx, offset, None)?;
            para_idx + 1
        };
        let paragraphs = &self.document.sections[section_idx].paragraphs;
        // 이미 단·구역 정의로 시작하는 문단이면 그 단 정의를 고친다(겹쳐 넣지 않는다).
        if let Some(ci) = paragraphs[target]
            .controls
            .iter()
            .position(|c| matches!(c, Control::ColumnDef(_)))
        {
            if let Some(Control::ColumnDef(cd)) = paragraphs[target].controls.get(ci) {
                inherited = cd.clone();
            }
            let before = inherited.clone();
            apply_column_props(&mut inherited, &props)?;
            if let Control::ColumnDef(cd) = &mut self.document.sections[section_idx].paragraphs[target].controls[ci] {
                *cd = inherited.clone();
            }
            self.h2022_after_column_change(section_idx, target, &before, &inherited);
            return Ok(json_ok_with(&format!("\"para\":{},\"charOffset\":0,\"inserted\":false", target)));
        }
        let before = inherited.clone();
        apply_column_props(&mut inherited, &props)?;
        let para = &mut self.document.sections[section_idx].paragraphs[target];
        let slot = Slot {
            control: Control::ColumnDef(inherited.clone()),
            data: None,
            shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: active_shape(para, 0),
            }],
            tags: vec![],
        };
        insert_slot(para, 0, 0, slot)?;
        para.column_type = ColumnBreakType::MultiColumn;
        para.invalidate_layout_inputs();
        // 새 다단 정의가 앞 다단과 다르면 줄을 다시 접는다. 같으면 앞 다단 폭을 쓰므로 그대로.
        self.h2022_after_column_change(section_idx, target, &before, &inherited);
        Ok(json_ok_with(&format!("\"para\":{},\"charOffset\":0,\"inserted\":true", target)))
    }

    /// 단 정의를 바꾼 뒤: 그 다단의 첫 단 폭이 바뀌었으면 그 다단 문단만 다시 접고, 구역을 다시 조판한다.
    fn h2022_after_column_change(&mut self, section_idx: usize, owner_para: usize, before: &ColumnDef, after: &ColumnDef) {
        let dpi = self.dpi;
        let page_def = self.document.sections[section_idx].section_def.page_def.clone();
        let first_width = |cd: &ColumnDef| {
            let layout = PageLayoutInfo::from_page_def(&page_def, cd, dpi);
            layout.column_areas.first().map(|a| a.width).unwrap_or(layout.body_area.width)
        };
        let (old_w, new_w) = (first_width(before), first_width(after));
        let (start, end) = zone_range(&self.document.sections[section_idx].paragraphs, owner_para);
        if (old_w - new_w).abs() > 0.01 {
            let styles = self.resolve_render_styles();
            let section = &mut self.document.sections[section_idx];
            for para in section.paragraphs[start..end].iter_mut() {
                let paragraph_box =
                    ParagraphBox::body_for_style(new_w, styles.para_styles.get(para.para_shape_id as usize), dpi);
                para.line_segs.clear();
                reflow_line_segs(para, paragraph_box, &styles, dpi);
            }
        }
        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_section(section_idx);
    }

    /// 쪽 번호 매기기의 시작 번호를 읽는다: 구역 첫 문단의 쪽 새 번호(없으면 null).
    pub fn get_page_numbering_native(&self, section_idx: usize) -> Result<String, HwpError> {
        let pos: serde_json::Value = serde_json::from_str(&self.get_page_number_position_native(section_idx)?)
            .map_err(|e| invalid(e.to_string()))?;
        let section = &self.document.sections[section_idx];
        let start = section.paragraphs.first().and_then(|p| {
            p.controls.iter().find_map(|c| match c {
                Control::NewNumber(n) if n.number_type == AutoNumberType::Page => Some(n.number),
                _ => None,
            })
        });
        let mut out = pos;
        out["startNumber"] = serde_json::json!(start);
        Ok(out.to_string())
    }

    /// 쪽 번호 매기기(PageNumPos) — 위치·모양·줄표에 시작 번호를 함께 정한다.
    /// `start_number` 0 은 '시작 번호를 건드리지 않음'이다.
    pub fn set_page_numbering_native(
        &mut self,
        section_idx: usize,
        position: u8,
        format: u8,
        dash: bool,
        start_number: u16,
    ) -> Result<String, HwpError> {
        let result = self.set_page_number_position_native(section_idx, position, format, dash)?;
        if start_number == 0 {
            return Ok(result);
        }
        let parsed: serde_json::Value = serde_json::from_str(&result).map_err(|e| invalid(e.to_string()))?;
        let pnp_ci = parsed.get("controlIdx").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let first = &mut self.document.sections[section_idx].paragraphs[0];
        let existing = first.controls.iter().position(|c| {
            matches!(c, Control::NewNumber(n) if n.number_type == AutoNumberType::Page)
        });
        let mut changed = false;
        if let Some(ci) = existing {
            if let Control::NewNumber(n) = &mut first.controls[ci] {
                if n.number != start_number {
                    n.number = start_number;
                    changed = true;
                }
            }
        } else if start_number != 1 {
            // 한/글처럼 쪽 번호 위치 바로 뒤에 넣는다.
            let raw = control_stream_slots(first)
                .get(pnp_ci)
                .copied()
                .flatten()
                .map(|(raw, _)| raw + 8)
                .ok_or_else(|| invalid("쪽 번호 위치 슬롯이 없습니다"))?;
            let slot = Slot {
                control: Control::NewNumber(NewNumber { number_type: AutoNumberType::Page, number: start_number }),
                data: None,
                shapes: vec![CharShapeRef { start_pos: 0, char_shape_id: active_shape(first, raw) }],
                tags: vec![],
            };
            insert_slot(first, raw, pnp_ci + 1, slot)?;
            self.shift_active_field_for_control_insert(section_idx, 0, pnp_ci + 1);
            changed = true;
        }
        if changed {
            self.document.sections[section_idx].raw_stream = None;
            self.reflow_paragraph(section_idx, 0);
            self.recompose_section(section_idx);
            for next in section_idx + 1..self.document.sections.len() {
                self.mark_section_dirty(next);
            }
            self.paginate_if_needed();
            self.invalidate_page_tree_cache();
        }
        Ok(result)
    }

    /// 번호·개요 문단의 수준을 한 단계 바꾼다(ParaNumberBulletLevelUp/Down, 한/글 실측: 번호 문단 0→1→2,
    /// 0 에서 위로는 그대로). 글머리표 문단은 한/글 2022 COM 에서 `ParaNumberBulletLevelDown` 이 실패(false)해
    /// 바꾸지 않는다. 돌려주는 `level` 은 바뀐 뒤 수준, `changed` 는 바뀌었는지.
    pub fn change_para_number_level_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        delta: i32,
    ) -> Result<String, HwpError> {
        use crate::model::style::HeadType;
        let para = self
            .document
            .sections
            .get(section_idx)
            .and_then(|s| s.paragraphs.get(para_idx))
            .ok_or_else(|| invalid("문단 범위 초과"))?;
        let shape = self
            .document
            .doc_info
            .para_shapes
            .get(para.para_shape_id as usize)
            .ok_or_else(|| invalid("문단 모양이 없습니다"))?;
        if !matches!(shape.head_type, HeadType::Number | HeadType::Outline) {
            return Ok("{\"ok\":true,\"changed\":false,\"reason\":\"notNumbered\"}".to_string());
        }
        let level = shape.para_level as i32;
        let next = (level + delta).clamp(0, 6);
        if next == level {
            return Ok(format!("{{\"ok\":true,\"changed\":false,\"level\":{}}}", level));
        }
        let json = format!("{{\"paraLevel\":{}}}", next);
        self.apply_para_format_native(section_idx, para_idx, &json)?;
        Ok(format!("{{\"ok\":true,\"changed\":true,\"level\":{}}}", next))
    }
}

// ─── 형광펜(markpen) — 한/글 2022 MarkPenShape 실측(artifacts/h2022-format/com/result_mp.json, 2026-11-12) ───
// - 고른 범위를 그 색으로 칠한다: 문단마다 `<hp:markpenBegin color="#RRGGBB"/>…<hp:markpenEnd/>`(hp:t 안).
// - 덧칠은 글자마다 나중 색이 이긴다(노랑 [1,5) 위 초록 [3,6) → 노랑 [1,3)·초록 [3,6)). 같은 색을 다시 칠해도 하나.
// - 색 없음(Color 0xFFFFFFFF·-1)·MarkPenDelete(블록) = 고른 범위만 지운다(앞뒤로 갈라진다). 블록 없는 MarkPenDelete 는 아무것도 안 한다.
// - 문단을 넘는 블록은 문단마다 따로 표지를 단다. 변경 추적 중에도 추적 표시 없이 바로 칠한다(한/글 실측).

fn markpen_stream_pos(para: &Paragraph, idx: usize) -> u32 {
    let n = para.text.chars().count();
    if n > 0 && para.char_offsets.len() == n {
        if idx < n {
            para.char_offsets[idx]
        } else {
            let last = para.text.chars().last().map(|c| c.len_utf16() as u32).unwrap_or(1);
            para.char_offsets[n - 1] + last
        }
    } else {
        para.text.chars().take(idx).map(|c| c.len_utf16() as u32).sum()
    }
}

/// 문단의 형광펜 범위 (시작, 끝, RGB) — 스트림(UTF-16) 자리, 끝은 제외.
fn markpen_ranges(para: &Paragraph) -> Vec<(u32, u32, u32)> {
    let mut out: Vec<(u32, u32, u32)> = para
        .effective_markpen_range_tags()
        .into_iter()
        .filter(|r| r.tag >> 24 == 2 && r.end > r.start)
        .map(|r| {
            let bgr = r.tag & 0x00ff_ffff;
            let rgb = ((bgr & 255) << 16) | (bgr & 0xff00) | ((bgr >> 16) & 255);
            (r.start, r.end, rgb)
        })
        .collect();
    out.sort_by_key(|r| (r.0, r.1));
    out
}

/// 문단의 [s, e) 를 rgb 로 칠하거나(None 이면 지운다) 바뀌었으면 true.
fn paint_markpen(para: &mut Paragraph, s: u32, e: u32, rgb: Option<u32>) -> bool {
    use crate::model::paragraph::{MarkpenMark, RangeTag};
    if e <= s {
        return false;
    }
    let before = markpen_ranges(para);
    let mut next: Vec<(u32, u32, u32)> = Vec::new();
    for &(a, b, c) in &before {
        if b <= s || a >= e {
            next.push((a, b, c));
            continue;
        }
        if a < s {
            next.push((a, s, c));
        }
        if b > e {
            next.push((e, b, c));
        }
    }
    if let Some(c) = rgb {
        next.push((s, e, c));
    }
    next.sort_by_key(|r| (r.0, r.1));
    // 맞닿은 같은 색은 하나로
    let mut merged: Vec<(u32, u32, u32)> = Vec::new();
    for r in next {
        match merged.last_mut() {
            Some(last) if last.1 == r.0 && last.2 == r.2 => last.1 = r.1,
            _ => merged.push(r),
        }
    }
    if merged == before {
        return false;
    }
    let mut marks = Vec::new();
    for &(a, b, c) in &merged {
        let (ia, ib) = (
            para.char_offsets.partition_point(|&o| o < a),
            para.char_offsets.partition_point(|&o| o < b),
        );
        marks.push(MarkpenMark { char_idx: ia, color: Some(format!("#{:06X}", c)), utf16_pos: Some(a) });
        marks.push(MarkpenMark { char_idx: ib, color: None, utf16_pos: Some(b) });
    }
    para.markpen_marks = marks;
    para.range_tags.retain(|r| r.tag >> 24 != 2);
    for &(a, b, c) in &merged {
        let bgr = ((c & 255) << 16) | (c & 0xff00) | ((c >> 16) & 255);
        para.range_tags.push(RangeTag { start: a, end: b, tag: 0x0200_0000 | bgr });
    }
    para.range_tags.sort_by_key(|r| (r.start, r.end));
    true
}

fn parse_markpen_color(color: &str) -> Result<Option<u32>, HwpError> {
    let c = color.trim();
    if c.is_empty() || c.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    let hex = c.strip_prefix('#').unwrap_or(c);
    if hex.len() != 6 {
        return Err(invalid(format!("형광펜 색은 #RRGGBB 여야 합니다: {c}")));
    }
    u32::from_str_radix(hex, 16)
        .map(Some)
        .map_err(|_| invalid(format!("형광펜 색은 #RRGGBB 여야 합니다: {c}")))
}

impl DocumentCore {
    /// 본문 범위(같은 구역, 논리 오프셋)에 형광펜을 칠한다. `color` 가 빈 문자열·"none" 이면 그 범위의 형광펜을 지운다.
    pub fn apply_markpen_native(
        &mut self,
        section_idx: usize,
        start_para: usize,
        start_offset: usize,
        end_para: usize,
        end_offset: usize,
        color: &str,
    ) -> Result<String, HwpError> {
        let rgb = parse_markpen_color(color)?;
        let section = self
            .document
            .sections
            .get_mut(section_idx)
            .ok_or_else(|| invalid("구역 범위 초과"))?;
        if start_para > end_para || end_para >= section.paragraphs.len() {
            return Err(invalid("문단 범위가 잘못되었습니다"));
        }
        let mut changed = 0usize;
        for pi in start_para..=end_para {
            let para = &mut section.paragraphs[pi];
            let len = logical_paragraph_length(para);
            let from = if pi == start_para { start_offset.min(len) } else { 0 };
            let to = if pi == end_para { end_offset.min(len) } else { len };
            if to <= from {
                continue;
            }
            let s = markpen_stream_pos(para, logical_to_text_offset(para, from).0);
            let e = markpen_stream_pos(para, logical_to_text_offset(para, to).0);
            if paint_markpen(para, s, e, rgb) {
                changed += 1;
            }
        }
        if changed > 0 {
            section.raw_stream = None;
            self.recompose_section(section_idx);
            self.paginate_if_needed();
            self.invalidate_page_tree_cache();
        }
        Ok(json_ok_with(&format!("\"changed\":{}", changed)))
    }

    /// 표 칸 문단 한 곳의 범위에 형광펜을 칠하거나 지운다.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_markpen_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        start_offset: usize,
        end_offset: usize,
        color: &str,
    ) -> Result<String, HwpError> {
        let rgb = parse_markpen_color(color)?;
        let para = self.get_cell_paragraph_mut(section_idx, parent_para_idx, control_idx, cell_idx, cell_para_idx)?;
        let len = logical_paragraph_length(para);
        let (from, to) = (start_offset.min(len), end_offset.min(len));
        let mut changed = false;
        if to > from {
            let s = markpen_stream_pos(para, logical_to_text_offset(para, from).0);
            let e = markpen_stream_pos(para, logical_to_text_offset(para, to).0);
            changed = paint_markpen(para, s, e, rgb);
        }
        if changed {
            self.document.sections[section_idx].raw_stream = None;
            self.recompose_section(section_idx);
            self.paginate_if_needed();
            self.invalidate_page_tree_cache();
        }
        Ok(json_ok_with(&format!("\"changed\":{}", u8::from(changed))))
    }
}

// ─── 형광펜 3차(2026-11-12): 머리말·꼬리말, 각주·미주, 표 칸(중첩 표·글상자 포함 — 경로) 문단 하나, 본문 범위 목록(형광펜 이동) ───

fn paint_logical(para: &mut Paragraph, from: usize, to: usize, rgb: Option<u32>) -> bool {
    let len = logical_paragraph_length(para);
    let (from, to) = (from.min(len), to.min(len));
    if to <= from {
        return false;
    }
    let s = markpen_stream_pos(para, logical_to_text_offset(para, from).0);
    let e = markpen_stream_pos(para, logical_to_text_offset(para, to).0);
    paint_markpen(para, s, e, rgb)
}

impl DocumentCore {
    /// 형광펜 — 문단 하나(대상 JSON)의 [from, to) 논리 범위. to 가 문단 길이보다 크면 문단 끝까지.
    /// 대상: `{kind:"path", sec, parentPara, path:[{controlIndex,cellIndex,cellParaIndex}…]}`(표 칸·중첩 표·글상자),
    /// `{kind:"hf", sec, isHeader, applyTo, para}`(머리말·꼬리말), `{kind:"note", sec, para, control, notePara}`(각주·미주).
    pub fn apply_markpen_target_native(
        &mut self,
        target_json: &str,
        from: usize,
        to: usize,
        color: &str,
    ) -> Result<String, HwpError> {
        let rgb = parse_markpen_color(color)?;
        let t: serde_json::Value =
            serde_json::from_str(target_json).map_err(|e| invalid(format!("형광펜 대상 JSON 오류: {e}")))?;
        let n = |k: &str| t.get(k).and_then(|v| v.as_u64()).map(|v| v as usize);
        let sec = n("sec").ok_or_else(|| invalid("sec 가 없습니다"))?;
        let kind = t.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let changed = match kind {
            "path" => {
                let parent = n("parentPara").ok_or_else(|| invalid("parentPara 가 없습니다"))?;
                let path: Vec<(usize, usize, usize)> = t
                    .get("path")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| invalid("path 가 없습니다"))?
                    .iter()
                    .map(|e| {
                        let g = |k: &str| e.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        (g("controlIndex"), g("cellIndex"), g("cellParaIndex"))
                    })
                    .collect();
                let para = self.get_cell_paragraph_mut_by_path(sec, parent, &path)?;
                paint_logical(para, from, to, rgb)
            }
            "hf" => {
                let is_header = t.get("isHeader").and_then(|v| v.as_bool()).unwrap_or(true);
                let apply_to = n("applyTo").unwrap_or(0) as u8;
                let pi = n("para").unwrap_or(0);
                let para = self.get_hf_paragraph_mut(sec, is_header, apply_to, pi)?;
                paint_logical(para, from, to, rgb)
            }
            "note" => {
                let para_idx = n("para").ok_or_else(|| invalid("para 가 없습니다"))?;
                let ci = n("control").ok_or_else(|| invalid("control 이 없습니다"))?;
                let np = n("notePara").unwrap_or(0);
                let para = self.get_footnote_paragraph_mut(sec, para_idx, ci, np)?;
                paint_logical(para, from, to, rgb)
            }
            other => return Err(invalid(format!("모르는 형광펜 대상 {other}"))),
        };
        if changed {
            self.document.sections[sec].raw_stream = None;
            self.recompose_section(sec);
            self.paginate_if_needed();
            self.invalidate_page_tree_cache();
        }
        Ok(json_ok_with(&format!("\"changed\":{}", u8::from(changed))))
    }

    /// 본문 형광펜 범위 목록(문단 차례) — 형광펜 이동(MarkPenNext/Prev). `{ok, ranges:[{para, start, end, color}]}`, 논리 오프셋.
    pub fn get_markpen_ranges_native(&self, section_idx: usize) -> Result<String, HwpError> {
        use crate::document_core::helpers::text_to_logical_offset;
        let section = self.document.sections.get(section_idx).ok_or_else(|| invalid("구역 범위 초과"))?;
        let mut out = Vec::new();
        for (pi, para) in section.paragraphs.iter().enumerate() {
            for (s, e, rgb) in markpen_ranges(para) {
                let ti = |pos: u32| {
                    if para.char_offsets.is_empty() {
                        pos as usize
                    } else {
                        para.char_offsets.partition_point(|&o| o < pos)
                    }
                };
                out.push(serde_json::json!({
                    "para": pi,
                    "start": text_to_logical_offset(para, ti(s)),
                    "end": text_to_logical_offset(para, ti(e)),
                    "color": format!("#{:06X}", rgb),
                }));
            }
        }
        Ok(serde_json::json!({ "ok": true, "ranges": out }).to_string())
    }
}

// ─── 문단 번호 사용자 정의(한/글 '문단 번호 사용자 정의 모양' 창의 핵심 칸) ───
// 수준마다: 번호 서식 문자열(^1. (^2) 등 — HWPX hh:paraHead 내용), 번호 모양(numFormat 코드, 표 43), 시작 번호(paraHead@start),
// 번호 정렬(attr bit0-1 → align), 번호 너비 따름(bit2 useInstWidth), 자동 내어 쓰기(bit3 autoIndent),
// 너비 조정(widthAdjust), 본문과의 거리(textOffset + bit4 textOffsetType: 0 퍼센트·1 HWPUNIT).
// 새 정의로 만든다(다른 문단이 쓰는 기존 정의는 그대로 — 한/글이 기존 정의를 고치는지 새로 만드는지는 미실측).

fn numbering_level_json(n: &crate::model::style::Numbering, level: usize) -> serde_json::Value {
    let h = &n.heads[level];
    serde_json::json!({
        "format": n.level_formats[level],
        "numFormat": h.number_format,
        "start": n.level_start_numbers[level],
        "align": h.attr & 0x03,
        "useInstWidth": (h.attr >> 2) & 1 == 1,
        "autoIndent": (h.attr >> 3) & 1 == 1,
        "textOffsetType": (h.attr >> 4) & 1,
        "widthAdjust": h.width_adjust,
        "textOffset": h.text_distance,
        "charShapeId": h.char_shape_id,
    })
}

impl DocumentCore {
    /// 번호 정의(1부터) 의 수준별 값 — `{ok, id, startNumber, levels:[…10]}`.
    pub fn get_numbering_detail_native(&self, numbering_id: usize) -> Result<String, HwpError> {
        let n = numbering_id
            .checked_sub(1)
            .and_then(|i| self.document.doc_info.numberings.get(i))
            .ok_or_else(|| invalid(format!("번호 정의 {numbering_id} 없음")))?;
        let levels: Vec<_> = (0..crate::model::style::NUMBERING_LEVELS).map(|l| numbering_level_json(n, l)).collect();
        Ok(serde_json::json!({ "ok": true, "id": numbering_id, "startNumber": n.start_number, "levels": levels }).to_string())
    }

    /// 수준별 값으로 새 번호 정의를 만든다 — 돌려주는 `id` 를 문단 모양 numberingId 로 쓴다.
    /// json: `{startNumber?, levels:[{format, numFormat, start?, align?, useInstWidth?, autoIndent?, textOffsetType?, widthAdjust?, textOffset?, charShapeId?}, …]}`
    /// 빠진 수준은 '^n.' 숫자, 빠진 칸은 한/글 기본(왼쪽·번호 너비 따름·자동 내어 쓰기·본문과의 거리 50%).
    pub fn create_numbering_ex_native(&mut self, json: &str) -> Result<String, HwpError> {
        use crate::model::style::{Numbering, NumberingHead, NUMBERING_LEVELS};
        let v: serde_json::Value =
            serde_json::from_str(json).map_err(|e| invalid(format!("번호 정의 JSON 오류: {e}")))?;
        let levels = v.get("levels").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        if levels.len() > NUMBERING_LEVELS {
            return Err(invalid("수준은 10개까지입니다"));
        }
        let mut n = Numbering::default();
        n.start_number = v.get("startNumber").and_then(|x| x.as_u64()).unwrap_or(0).min(u16::MAX as u64) as u16;
        for level in 0..NUMBERING_LEVELS {
            let lv = levels.get(level).cloned().unwrap_or(serde_json::Value::Null);
            let num = |k: &str| lv.get(k).and_then(|x| x.as_i64());
            let flag = |k: &str, d: bool| lv.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
            let fmt = lv
                .get("format")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("^{}.", level + 1));
            if fmt.chars().count() > 100 {
                return Err(invalid("번호 서식이 너무 깁니다"));
            }
            let code = num("numFormat").unwrap_or(0);
            if !(0..=16).contains(&code) {
                return Err(invalid("번호 모양은 0~16 이어야 합니다"));
            }
            let mut attr = (num("align").unwrap_or(0).clamp(0, 2) as u32) & 0x03;
            if flag("useInstWidth", true) {
                attr |= 1 << 2;
            }
            if flag("autoIndent", true) {
                attr |= 1 << 3;
            }
            if num("textOffsetType").unwrap_or(0) == 1 {
                attr |= 1 << 4;
            }
            n.level_formats[level] = fmt;
            n.heads[level] = NumberingHead {
                attr,
                width_adjust: num("widthAdjust").unwrap_or(0).clamp(i16::MIN as i64, i16::MAX as i64) as i16,
                text_distance: num("textOffset").unwrap_or(50).clamp(i16::MIN as i64, i16::MAX as i64) as i16,
                char_shape_id: num("charShapeId").unwrap_or(u32::MAX as i64).clamp(0, u32::MAX as i64) as u32,
                number_format: code as u8,
            };
            n.level_start_numbers[level] = num("start").unwrap_or(1).clamp(0, u32::MAX as i64) as u32;
        }
        self.document.doc_info.numberings.push(n);
        // 새 번호 정의는 DocInfo 원본 스트림에 없어 HWP 저장이 모델에서 다시 쓰게 한다(createNumbering 과 같은 이유).
        self.document.doc_info.raw_stream_dirty = true;
        let id = self.document.doc_info.numberings.len();
        Ok(json_ok_with(&format!("\"id\":{}", id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markpen_paint_overrides_and_erases_like_hangul() {
        let mut para = Paragraph { text: "가나다라마바사1".to_string(), ..Paragraph::default() };
        para.char_offsets = (0..8).collect();
        assert!(paint_markpen(&mut para, 1, 5, Some(0xFFFF00)));
        assert!(paint_markpen(&mut para, 3, 6, Some(0x00FF00)));
        assert_eq!(markpen_ranges(&para), vec![(1, 3, 0xFFFF00), (3, 6, 0x00FF00)]);
        assert!(!paint_markpen(&mut para, 3, 6, Some(0x00FF00)), "같은 색 다시 = 그대로");
        assert!(paint_markpen(&mut para, 3, 4, None));
        assert_eq!(markpen_ranges(&para), vec![(1, 3, 0xFFFF00), (4, 6, 0x00FF00)]);
    }

    #[test]
    fn apply_props_sets_separator_and_widths() {
        let mut cd = ColumnDef { column_count: 1, same_width: true, ..ColumnDef::default() };
        let props = serde_json::json!({
            "columnCount": 3, "sameWidth": false,
            "widths": [10000, 8000, 12000], "gaps": [1000, 1768, 500],
            "separatorType": 2, "separatorWidth": 4, "separatorColor": "#ff0000"
        });
        apply_column_props(&mut cd, &props).unwrap();
        assert_eq!(cd.column_count, 3);
        assert_eq!(cd.widths, vec![10000, 8000, 12000]);
        assert_eq!(cd.gaps, vec![1000, 1768, 0]);
        assert_eq!(cd.separator_type, 2);
        assert_eq!(cd.separator_color, 0x0000ff);
    }

    #[test]
    fn apply_props_rejects_width_count_mismatch() {
        let mut cd = ColumnDef { column_count: 1, ..ColumnDef::default() };
        let props = serde_json::json!({ "columnCount": 2, "sameWidth": false, "widths": [1] });
        assert!(apply_column_props(&mut cd, &props).is_err());
    }
}
