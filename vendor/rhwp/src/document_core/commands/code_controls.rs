//! [hwpx-cowork] 조판 부호 — 캐럿 옆 부호 찾기·지우기, 새 번호로 시작 넣기/고치기.
//!
//! 한/글에서 자동 번호(표·그림 번호 등)·새 번호로 시작·쪽 번호 위치·감추기·책갈피 같은 조판 부호는 글자 흐름의 한 자리다.
//! 표·그림 같은 개체도 부호 하나다. Backspace·Delete 가 부호에 닿으면 한/글처럼 '[그림] 을 지울까요?' 로 묻고 지운다
//! (묻기는 편집기 몫 — 조판 부호 보기가 켜져 있으면 묻지 않는다).
//! rhwp 는 글자 지우기(`delete_text_at`)가 컨트롤을 건드리지 않아 부호를 지울 길이 없었다(자동 번호 자리표만 지워져
//! 번호가 한 칸 옮겨 갔다). 자리 계산·빼기는 [`Paragraph::code_slots`]·[`Paragraph::remove_code_control`].
//!
//! 대상 문단은 JSON 으로 받는다: `{"sec":구역,"para":본문 문단, "cellPath":[{controlIndex,cellIndex,cellParaIndex}…]}` —
//! cellPath 가 있으면 para 는 그 표·그림·글상자를 품은 본문 문단이고 경로 끝 문단이 대상이다(표 캡션은 cellIndex 65534).

use crate::document_core::helpers::{json_str, json_u32, json_usize};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{AutoNumberType, Control, NewNumber};
use crate::model::event::DocumentEvent;
use crate::model::paragraph::{CodeSlot, Paragraph};

/// 조판 부호 편집 대상 문단
pub(crate) struct CodeTarget {
    pub sec: usize,
    pub para: usize,
    pub path: Vec<(usize, usize, usize)>,
}

impl CodeTarget {
    pub(crate) fn from_json(json: &str) -> Result<Self, HwpError> {
        let sec = json_usize(json, "sec")?;
        let para = json_usize(json, "para")?;
        let path = match json_array(json, "cellPath") {
            Some(arr) => DocumentCore::parse_cell_path(&arr)?,
            None => Vec::new(),
        };
        Ok(Self { sec, para, path })
    }
}

/// `"key": [ … ]` 의 배열 글(대괄호 포함). 없으면 None
fn json_array(json: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\"", key);
    let at = json.find(&pat)? + pat.len();
    let rest = &json[at..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    if !rest.starts_with('[') {
        return None;
    }
    let mut depth = 0i32;
    for (i, ch) in rest.char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// [hwpx-cowork] 자동 번호가 보이는 글(번호 형식 + 앞뒤 장식 문자) — 캡션 그리기·복사 글이 같은 값을 쓴다
pub(crate) fn auto_number_text(an: &crate::model::control::AutoNumber) -> String {
    use crate::renderer::{format_number, NumberFormat};
    let mut s = String::new();
    if an.prefix_char != '\0' {
        s.push(an.prefix_char);
    }
    s.push_str(&format_number(an.assigned_number, NumberFormat::from_hwp_format(an.format)));
    if an.suffix_char != '\0' {
        s.push(an.suffix_char);
    }
    s
}

/// [hwpx-cowork] 문단 글에서 자동 번호 자리표(공백 한 칸)를 보이는 번호로 바꾼 글 — 복사한 글(바깥에 붙일 글자)이 '[표 1]' 이 되게
/// (종전에는 자리표 그대로 '[표  ]')
pub(crate) fn text_with_auto_numbers(para: &Paragraph) -> String {
    let slots: Vec<(usize, String)> = para
        .code_slots()
        .into_iter()
        .filter(|s| s.placeholder)
        .filter_map(|s| match para.controls.get(s.control_idx) {
            Some(Control::AutoNumber(an)) => Some((s.char_pos, auto_number_text(an))),
            _ => None,
        })
        .collect();
    if slots.is_empty() {
        return para.text.clone();
    }
    let mut out = String::with_capacity(para.text.len() + 8);
    for (i, ch) in para.text.chars().enumerate() {
        match slots.iter().find(|(p, _)| *p == i) {
            Some((_, n)) => out.push_str(n),
            None => out.push(ch),
        }
    }
    out
}

/// [hwpx-cowork] 원문 문단의 글자 범위 [start, end) 를 보이는 글로(자동 번호 자리표 → 번호). 자른 사본은 메모 필드 경계가 바뀌어
/// 자리표를 찾지 못하므로 복사 글은 원문에서 센다
pub(crate) fn text_range_with_auto_numbers(para: &Paragraph, start: usize, end: usize) -> String {
    let slots: Vec<(usize, String)> = para
        .code_slots()
        .into_iter()
        .filter(|s| s.placeholder)
        .filter_map(|s| match para.controls.get(s.control_idx) {
            Some(Control::AutoNumber(an)) => Some((s.char_pos, auto_number_text(an))),
            _ => None,
        })
        .collect();
    let mut out = String::new();
    for (i, ch) in para.text.chars().enumerate().skip(start).take(end.saturating_sub(start)) {
        match slots.iter().find(|(p, _)| *p == i) {
            Some((_, n)) => out.push_str(n),
            None => out.push(ch),
        }
    }
    out
}

fn num_type_name(t: AutoNumberType) -> &'static str {
    match t {
        AutoNumberType::Page => "PAGE",
        AutoNumberType::Footnote => "FOOTNOTE",
        AutoNumberType::Endnote => "ENDNOTE",
        AutoNumberType::Picture => "PICTURE",
        AutoNumberType::Table => "TABLE",
        AutoNumberType::Equation => "EQUATION",
        AutoNumberType::TotalPage => "TOTAL_PAGE",
    }
}

fn parse_num_type(s: &str) -> Option<AutoNumberType> {
    Some(match s {
        "PAGE" => AutoNumberType::Page,
        "FOOTNOTE" => AutoNumberType::Footnote,
        "ENDNOTE" => AutoNumberType::Endnote,
        "PICTURE" | "FIGURE" => AutoNumberType::Picture,
        "TABLE" => AutoNumberType::Table,
        "EQUATION" => AutoNumberType::Equation,
        _ => return None,
    })
}

/// 부호 하나의 JSON(찾기 결과·목록 공용)
fn code_json(para: &Paragraph, slot: &CodeSlot) -> String {
    let (kind, num_type, number) = match para.controls.get(slot.control_idx) {
        Some(Control::AutoNumber(a)) => ("autoNum", Some(a.number_type), Some(a.assigned_number)),
        Some(Control::NewNumber(n)) => ("newNum", Some(n.number_type), Some(n.number)),
        Some(Control::PageNumberPos(_)) => ("pageNum", None, None),
        Some(Control::PageHide(_)) => ("pageHiding", None, None),
        Some(Control::Bookmark(_)) => ("bookmark", None, None),
        Some(Control::IndexMark(_)) => ("indexMark", None, None),
        Some(Control::PageNumCtrl(_)) => ("pageNumCtrl", None, None),
        _ => ("other", None, None),
    };
    let mut out = format!(
        "\"codeIndex\":{},\"kind\":\"{}\",\"charPos\":{},\"placeholder\":{}",
        slot.control_idx, kind, slot.char_pos, slot.placeholder
    );
    if let Some(t) = num_type {
        out.push_str(&format!(",\"numType\":\"{}\"", num_type_name(t)));
    }
    if let Some(n) = number {
        out.push_str(&format!(",\"number\":{}", n));
    }
    if let Some(Control::Bookmark(b)) = para.controls.get(slot.control_idx) {
        out.push_str(&format!(
            ",\"name\":\"{}\"",
            crate::document_core::helpers::json_escape(&b.name)
        ));
    }
    if let Some(label) = para.controls.get(slot.control_idx).and_then(hangul_label) {
        out.push_str(&format!(",\"label\":\"{}\"", label));
    }
    out
}

/// 한/글이 부르는 부호 이름(지우기 창 '[그림] 을 지울까요?' 의 이름) — HWPCtrl 실측 이름표(`control_identity`)를 쓴다.
/// 이름표에 없는 부호(찾아보기 표식 등)는 None(편집기가 제 이름을 쓴다)
fn hangul_label(ctrl: &Control) -> Option<&'static str> {
    let (_, _, name) = crate::document_core::queries::hwpctrl_sets::control_identity(ctrl);
    (!name.is_empty()).then_some(name)
}

/// 개체(표·그림·도형·수식) 갈래 이름 — 편집기가 고를 지우기 API
fn object_type(ctrl: &Control) -> Option<&'static str> {
    Some(match ctrl {
        Control::Table(_) => "table",
        Control::Picture(_) => "picture",
        Control::Equation(_) => "equation",
        Control::Shape(_) => "shape",
        _ => return None,
    })
}

/// 캐럿(논리 자리 `off` — 글자 + 글자처럼 취급한 개체·각주를 한 칸씩 센 자리) 옆 개체.
/// 글자처럼 취급한 개체는 캐럿 앞 칸(Backspace)·뒤 칸(Delete). 자리를 차지하는(글자처럼 취급하지 않은) 개체의 부호는
/// 글자 흐름에서 폭이 없어 캐럿 자리 틈에 있는데, 한/글은 숨은 부호 뒤에 캐럿을 둔다 — Backspace 만 그 부호를 지운다
/// (표 아래 빈 줄에서 Backspace = '[표] 를 지울까요?', Delete 는 다음 문단 합치기).
fn object_at(para: &Paragraph, off: usize, backward: bool) -> Option<(usize, bool, usize)> {
    let positions = para.logical_control_positions();
    let mut floating = None;
    for (ci, ctrl) in para.controls.iter().enumerate() {
        if object_type(ctrl).is_none() {
            continue;
        }
        let Some(&at) = positions.get(ci) else { continue };
        if ctrl.is_treat_as_char_object() {
            if (backward && off > 0 && at + 1 == off) || (!backward && at == off) {
                return Some((ci, true, at));
            }
        } else if backward && at == off {
            floating = Some((ci, false, at)); // 같은 틈에 여럿이면 캐럿에 가장 가까운 것(마지막)
        }
    }
    floating
}

impl DocumentCore {
    fn code_target_para(&self, t: &CodeTarget) -> Result<&Paragraph, HwpError> {
        if t.path.is_empty() {
            self.document
                .sections
                .get(t.sec)
                .and_then(|s| s.paragraphs.get(t.para))
                .ok_or_else(|| HwpError::RenderError(format!("문단 {}/{} 없음", t.sec, t.para)))
        } else {
            self.resolve_paragraph_by_path(t.sec, t.para, &t.path)
        }
    }

    fn code_target_para_mut(&mut self, t: &CodeTarget) -> Result<&mut Paragraph, HwpError> {
        if t.path.is_empty() {
            self.document
                .sections
                .get_mut(t.sec)
                .and_then(|s| s.paragraphs.get_mut(t.para))
                .ok_or_else(|| HwpError::RenderError(format!("문단 {}/{} 없음", t.sec, t.para)))
        } else {
            self.get_cell_paragraph_mut_by_path(t.sec, t.para, &t.path)
        }
    }

    /// 자동 번호를 다시 매긴다 — HWPX 는 열 때와 같이 캡션 번호(그림·표·수식)만 한/글 셈으로,
    /// 그 밖의 형식은 종전 rhwp 셈(쪽·각주 번호 포함)으로.
    pub(crate) fn renumber_auto_numbers(&mut self) {
        if self.source_format == crate::parser::FileFormat::Hwpx {
            crate::parser::assign_caption_auto_numbers(&mut self.document);
        } else {
            crate::parser::assign_auto_numbers(&mut self.document);
        }
    }

    /// [hwpx-cowork] 각주·미주를 넣거나 빼거나 모양을 바꾼 뒤 — HWPX 는 열 때와 같은 한/글 셈(문서 차례·구역 이어서)으로
    /// 다시 매긴다. 편집 경로의 셈(구역마다 1부터)은 앞 구역에 이어지는 번호를 놓친다.
    pub(crate) fn renumber_notes_hwpx(&mut self) {
        if self.source_format != crate::parser::FileFormat::Hwpx {
            return;
        }
        let changed = crate::parser::assign_note_numbers(&mut self.document);
        // 다른 구역의 본문 표시 번호·미주 목록은 조합·쪽 나눔에 구워져 있다 — 바뀐 구역과 (미주 목록을 싣는) 마지막 구역을 다시.
        let last = changed.len().saturating_sub(1);
        if changed.iter().any(|c| *c) {
            for (idx, c) in changed.iter().enumerate() {
                if *c || idx == last {
                    self.mark_section_dirty(idx);
                    self.recompose_section(idx);
                }
            }
        }
    }

    /// 부호를 넣거나 뺀 문단을 다시 조판한다. `renumber` 면 캡션 번호(그림·표·수식)를 문서 차례로 다시 매긴다
    /// (HWPX 를 열 때와 같은 규칙 — 한/글은 번호를 열 때마다 다시 매긴다).
    fn after_code_edit(&mut self, t: &CodeTarget, renumber: bool) {
        if renumber {
            crate::parser::assign_caption_auto_numbers(&mut self.document);
        }
        self.document.sections[t.sec].raw_stream = None;
        if t.path.is_empty() {
            let stored_end_for_reset = crate::renderer::composer::paragraph_flow_end(
                &self.document.sections[t.sec].paragraphs[t.para],
            );
            self.reflow_paragraph(t.sec, t.para);
            let doc_hwp3_layout = self.document.layout_profile().hwp3_layout();
            crate::renderer::composer::recalculate_section_vpos(
                &mut self.document.sections[t.sec].paragraphs,
                t.para,
                None,
                stored_end_for_reset,
                &self.styles,
                self.dpi,
                doc_hwp3_layout,
            );
            self.recompose_section(t.sec);
            self.event_log.push(DocumentEvent::TextDeleted {
                section: t.sec,
                para: t.para,
                offset: 0,
                count: 0,
            });
        } else {
            let (outer_ctrl, outer_cell, _) = t.path[0];
            let cell_para = t.path[t.path.len() - 1].2;
            self.reflow_cell_paragraph_by_path(t.sec, t.para, &t.path, cell_para);
            self.mark_cell_control_dirty(t.sec, t.para, outer_ctrl);
            self.mark_section_dirty(t.sec);
            if renumber {
                // 다른 캡션의 번호 글자 폭이 바뀔 수 있다
                self.recompose_section(t.sec);
            }
            self.event_log.push(DocumentEvent::CellTextChanged {
                section: t.sec,
                para: t.para,
                ctrl: outer_ctrl,
                cell: outer_cell,
            });
        }
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
    }

    /// 캐럿(`charOffset`) 옆의 조판 부호 — `direction` 이 `backward`(Backspace)면 캐럿 앞 글자가 자동 번호 자리표이거나
    /// 캐럿 자리 틈에 있는 부호(가장 가까운 것 = 마지막), `forward`(Delete)면 캐럿 뒤 글자가 자리표이거나 캐럿 자리 틈의
    /// 첫 부호. Backspace 를 문단 맨 앞에서 누르면 부호보다 문단 합치기가 먼저다(부호는 합친 문단으로 옮겨 간다).
    /// 부호가 없으면 개체(표·그림·도형·수식 — [`object_at`]): `kind:"object"`, `objectType`, `inline`.
    /// `charOffset` 는 캐럿의 논리 자리(글자처럼 취급한 개체·각주도 한 칸). `label` 은 한/글이 부르는 이름.
    /// → `{"found":false}` | `{"found":true,"codeIndex","kind","charPos","placeholder","numType"?,"number"?,"name"?,"label"?}`
    pub fn code_control_at_native(&self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let logical = json_usize(json, "charOffset")?;
        let backward = json_str(json, "direction").as_deref() != Some("forward");
        let para = self.code_target_para(&t)?;
        // 캐럿 자리는 논리 자리(글자처럼 취급한 개체도 한 칸)다 — 부호 자리(글자 번호)와 견줄 때는 글자 번호로
        let off = if para.controls.iter().any(Control::is_logical_inline) {
            crate::document_core::helpers::logical_to_text_offset(para, logical).0
        } else {
            logical
        };
        let slots = para.code_slots();
        let hit = if backward {
            slots
                .iter()
                .find(|s| s.placeholder && off > 0 && s.char_pos + 1 == off)
                .or_else(|| {
                    if off == 0 {
                        None
                    } else {
                        slots.iter().filter(|s| !s.placeholder && s.char_pos == off).last()
                    }
                })
        } else {
            slots
                .iter()
                .find(|s| s.placeholder && s.char_pos == off)
                .or_else(|| slots.iter().find(|s| !s.placeholder && s.char_pos == off))
        };
        if let Some(s) = hit {
            return Ok(format!("{{\"found\":true,{}}}", code_json(para, s)));
        }
        // [hwpx-cowork] 메모 부호 — 붙은 글이 없는 메모(글을 지우고 남은 메모)는 캐럿 자리 틈에 있다(Backspace·Delete 모두).
        // 붙은 글이 있는 메모는 조판 부호 보기가 켜져 있을 때만 — 끝 표지 바로 뒤 Backspace, 시작 표지 바로 앞 Delete
        // (보기가 꺼져 있으면 글자 지우기 그대로 — 메모가 붙은 글을 모두 지우면 메모도 빠진다: delete_text_with_codes)
        // 문단 맨 앞 Backspace 는 다른 부호처럼 문단 합치기가 먼저다(메모는 합친 문단으로 옮겨 간다)
        let memos = if backward && off == 0 { Vec::new() } else { para.memo_slots() };
        let memo_hit = memos
            .iter()
            .find(|&&(_, s, e)| s == e && s == off)
            .or_else(|| {
                if !self.show_control_codes {
                    None
                } else if backward {
                    memos.iter().find(|&&(_, s, e)| s < e && e == off)
                } else {
                    memos.iter().find(|&&(_, s, e)| s < e && s == off)
                }
            });
        if let Some(&(ci, s, e)) = memo_hit {
            return Ok(format!(
                "{{\"found\":true,\"codeIndex\":{},\"kind\":\"memo\",\"charPos\":{},\"memoEnd\":{},\"placeholder\":false,\"label\":\"메모\",\"memoCount\":{}}}",
                ci,
                s,
                e,
                memos.iter().filter(|m| m.1 == m.2 && m.1 == off).count().max(1)
            ));
        }
        // [hwpx-cowork] 개체 부호(표·그림·도형·수식) — 한/글처럼 글자 지우기가 아니라 '[그림] 을 지울까요?' 로 지운다
        Ok(match object_at(para, logical, backward) {
            Some((ci, inline, at)) => {
                let ctrl = &para.controls[ci];
                format!(
                    "{{\"found\":true,\"codeIndex\":{},\"kind\":\"object\",\"objectType\":\"{}\",\"inline\":{},\"charPos\":{},\"placeholder\":false,\"label\":\"{}\"}}",
                    ci,
                    object_type(ctrl).unwrap_or("shape"),
                    inline,
                    at,
                    hangul_label(ctrl).unwrap_or("개체")
                )
            }
            None => "{\"found\":false}".to_string(),
        })
    }

    /// 대상 문단의 지울 수 있는 조판 부호 목록 → `[{codeIndex,kind,charPos,placeholder,…}]`
    pub fn code_controls_native(&self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let para = self.code_target_para(&t)?;
        let items: Vec<String> = para
            .code_slots()
            .iter()
            .map(|s| format!("{{{}}}", code_json(para, s)))
            .collect();
        Ok(format!("[{}]", items.join(",")))
    }

    /// 조판 부호 `codeIndex`(컨트롤 번호 — cellPath 의 controlIndex 와 겹치지 않게 다른 이름) 를 뺀다 → `{"ok":true,"charOffset":뺀 자리}`(캐럿을 둘 글자 번호)
    pub fn delete_code_control_native(&mut self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let ci = json_usize(json, "codeIndex")?;
        let renumber;
        let slot = {
            let para = self.code_target_para_mut(&t)?;
            renumber = matches!(
                para.controls.get(ci),
                Some(Control::AutoNumber(_) | Control::NewNumber(_))
            );
            para.remove_code_control(ci).ok_or_else(|| {
                HwpError::RenderError(format!("지울 수 있는 조판 부호가 아닙니다(컨트롤 {})", ci))
            })?
        };
        self.after_code_edit(&t, renumber);
        Ok(crate::document_core::helpers::json_ok_with(&format!(
            "\"charOffset\":{}",
            slot.char_pos
        )))
    }

    /// 새 번호로 시작 — `codeIndex` 가 새 번호 부호면 그 종류·번호를 고치고, 없으면 `charOffset` 자리에 새로 넣는다.
    /// `numType`: PAGE·FOOTNOTE·ENDNOTE·PICTURE·TABLE·EQUATION, `number`: 1~65535. → `{"ok":true,"codeIndex":n}`
    pub fn set_new_number_native(&mut self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let number_type = parse_num_type(json_str(json, "numType").as_deref().unwrap_or("PAGE"))
            .ok_or_else(|| HwpError::InvalidField("번호 종류(numType)가 올바르지 않습니다".into()))?;
        let number = json_u32(json, "number").unwrap_or(1);
        if number == 0 || number > 65535 {
            return Err(HwpError::InvalidField("번호는 1~65535 입니다".into()));
        }
        let existing = json_usize(json, "codeIndex").ok();
        let control_idx = {
            let para = self.code_target_para_mut(&t)?;
            match existing {
                Some(ci) => match para.controls.get_mut(ci) {
                    Some(Control::NewNumber(n)) => {
                        n.number_type = number_type;
                        n.number = number as u16;
                        ci
                    }
                    _ => {
                        return Err(HwpError::RenderError(format!(
                            "컨트롤 {} 이(가) 새 번호가 아닙니다",
                            ci
                        )))
                    }
                },
                None => {
                    let char_offset = json_usize(json, "charOffset")?.min(para.text.chars().count());
                    // 그 자리 틈의 컨트롤들 뒤(컨트롤 차례 = 스트림 차례). 단 그 자리 글자가 자동 번호 자리표면 그 번호 앞
                    // (새 틈은 그 글자 앞에 생긴다)
                    let insert_idx = {
                        let positions = para.control_text_positions();
                        let ph: Vec<usize> = para
                            .code_slots()
                            .iter()
                            .filter(|s| s.placeholder && s.char_pos == char_offset)
                            .map(|s| s.control_idx)
                            .collect();
                        positions
                            .iter()
                            .enumerate()
                            .position(|(i, &p)| p > char_offset || ph.contains(&i))
                            .unwrap_or(para.controls.len())
                    };
                    para.align_ctrl_data_records();
                    para.controls.insert(
                        insert_idx,
                        Control::NewNumber(NewNumber { number_type, number: number as u16 }),
                    );
                    para.ctrl_data_records.insert(insert_idx, None);
                    para.shift_for_inline_control_insert(insert_idx, char_offset);
                    para.char_count += 8;
                    para.control_mask |= 1u32 << 0x0012;
                    para.has_para_text = true;
                    insert_idx
                }
            }
        };
        if existing.is_none() && t.path.is_empty() {
            self.shift_active_field_for_control_insert(t.sec, t.para, control_idx);
        }
        self.after_code_edit(&t, true);
        Ok(crate::document_core::helpers::json_ok_with(&format!(
            "\"codeIndex\":{}",
            control_idx
        )))
    }
}

// ─── [hwpx-cowork] 조판 부호 틈 — 캐럿 틈 자리·지우기 대상(한/글 2022 실측, 2026-10-30) ─────────────
//
// 캐럿 = (논리 자리 L, 틈 자리 j). 틈 자리 j 는 L 바로 앞 틈의 부호 가운데 캐럿 앞에 있는 개수(0..=n, 없으면 n — 틈 끝 = 다음 글자 바로 앞).
// 조판 부호 보기를 켜면 캐럿이 틈 안 모든 자리에 서고, 끄면 숨은 부호 앞에는 서지 않는다(n 이거나 뒤 부호가 늘 보이는 부호인 자리).

/// 틈 부호 하나의 JSON
fn gap_code_json(para: &Paragraph, g: &crate::model::code_gaps::GapCode) -> String {
    use crate::document_core::helpers::json_escape;
    use crate::model::code_gaps::GapCodeItem;
    let ci = g.item.control_idx();
    let mut out = format!(
        "{{\"codeIndex\":{},\"item\":\"{}\",\"kind\":\"{}\",\"label\":\"{}\",\"mark\":\"{}\",\"hidden\":{},\"charPos\":{}",
        ci,
        if matches!(g.item, GapCodeItem::FieldEnd(_)) { "fieldEnd" } else { "control" },
        g.kind,
        json_escape(&g.name),
        json_escape(&g.label),
        g.hidden,
        g.text_pos
    );
    if let Some(ctrl) = para.controls.get(ci) {
        if let Some(t) = object_type(ctrl) {
            out.push_str(&format!(",\"objectType\":\"{}\",\"inline\":false", t));
        }
        if let Control::Header(h) = ctrl {
            out.push_str(&format!(",\"isHeader\":true,\"applyTo\":{}", apply_code(h.apply_to)));
        }
        if let Control::Footer(f) = ctrl {
            out.push_str(&format!(",\"isHeader\":false,\"applyTo\":{}", apply_code(f.apply_to)));
        }
    }
    out.push('}');
    out
}

fn apply_code(a: crate::model::header_footer::HeaderFooterApply) -> u8 {
    use crate::model::header_footer::HeaderFooterApply;
    match a {
        HeaderFooterApply::Both => 0,
        HeaderFooterApply::Even => 1,
        HeaderFooterApply::Odd => 2,
    }
}

impl DocumentCore {
    fn code_view_on(&self, json: &str) -> bool {
        crate::document_core::helpers::json_bool(json, "codes").unwrap_or(self.show_control_codes)
    }

    /// 문단에 글머리표·번호·개요 머리가 있는가(한/글: 그런 문단 머리의 숨은 부호 뒤 Backspace 는 문단을 합치지 않고 부호를 묻는다)
    fn code_para_numbered(&self, para: &Paragraph) -> bool {
        self.styles
            .para_styles
            .get(para.para_shape_id as usize)
            .is_some_and(|ps| !matches!(ps.head_type, crate::model::style::HeadType::None))
    }

    /// [hwpx-cowork] 캐럿 자리 `charOffset`(논리) 바로 앞 틈의 부호들
    /// → `{"logical":L,"codes":[{codeIndex,item,kind,label,mark,hidden,charPos,objectType?}],"numbered":bool,"codesView":bool}`
    pub fn code_gap_native(&self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let logical = json_usize(json, "charOffset")?;
        let para = self.code_target_para(&t)?;
        let codes: Vec<String> = para.gap_codes_at(logical).iter().map(|g| gap_code_json(para, g)).collect();
        Ok(format!(
            "{{\"logical\":{},\"len\":{},\"codes\":[{}],\"numbered\":{},\"codesView\":{}}}",
            logical,
            crate::document_core::helpers::navigable_text_len(para),
            codes.join(","),
            self.code_para_numbered(para),
            self.code_view_on(json)
        ))
    }

    /// [hwpx-cowork] Backspace(backward)·Delete(forward) 가 지울 부호 — 한/글 2022 실측 규칙.
    /// 입력 `{sec,para,cellPath?,charOffset(논리),gap?(틈 자리, 없으면 틈 끝),direction,codes?(조판 부호 보기)}`.
    ///  · 보기 켬: 틈 안 바로 앞(뒤) 부호. 틈 머리(끝)이면 칸 — 글자처럼 취급한 개체·자동 번호 자리표.
    ///  · 보기 끔: 숨은 부호는 건너뛴다(늘 보이는 부호 — 메모·누름틀 — 만 대상). 단 글머리표 문단의 첫 자리(숨은 부호 뒤) Backspace 는
    ///    그 부호를 묻는다(표 아래 빈 줄 → [표] 를 지울까요?, 2026-10-30 재실측).
    ///  · 문단 첫 자리(틈 머리) Backspace·문단 끝(틈 끝) Delete 는 부호가 아니다(문단 합치기 — 부호는 따라간다).
    /// → `{"found":false}` | `{"found":true,"source":"gap"|"slot",codeIndex,item?,kind,label,objectType?,inline,charPos,
    ///    "caret":{"charOffset","gap"},"memoCount"?}` — caret 은 [지움] 뒤 캐럿 자리
    pub fn code_delete_target_native(&self, json: &str) -> Result<String, HwpError> {
        use crate::model::code_gaps::GapCodeItem;
        let t = CodeTarget::from_json(json)?;
        let logical = json_usize(json, "charOffset")?;
        let backward = json_str(json, "direction").as_deref() != Some("forward");
        let codes_on = self.code_view_on(json);
        let para = self.code_target_para(&t)?;
        let all = para.gap_codes();
        let gap: Vec<&crate::model::code_gaps::GapCode> = all.iter().filter(|g| g.logical == logical).collect();
        let n = gap.len();
        let explicit_gap = crate::document_core::helpers::json_i32(json, "gap").filter(|v| *v >= 0);
        let j = explicit_gap.map(|v| (v as usize).min(n)).unwrap_or(n);
        // 보기를 끈 채 틈 자리를 모르는 캐럿(누르기·Home/End·글 넣기 뒤 — 부호를 헤아려 온 자리가 아니다)에서는 글 붙은 메모·필드
        // 표지를 지우기 대상으로 보지 않는다 — 글자 넣기가 그 표지 안쪽에 들어가는 자리라서(종전 규칙: 붙은 글이 있는 메모는 글자 지우기).
        // 화살표로 표지 앞뒤에 선 캐럿(틈 자리를 아는 캐럿)은 한/글처럼 묻는다.
        let field_with_text = |g: &crate::model::code_gaps::GapCode| {
            matches!(g.kind, "memo" | "field" | "clickHere")
                && para
                    .field_ranges
                    .iter()
                    .any(|r| r.control_idx == g.item.control_idx() && r.start_char_idx < r.end_char_idx)
        };
        let visible_off = |g: &crate::model::code_gaps::GapCode| !g.hidden && (explicit_gap.is_some() || !field_with_text(g));
        let hit_idx: Option<usize> = if backward {
            if codes_on {
                j.checked_sub(1)
            } else {
                (0..j).rev().find(|&i| visible_off(gap[i])).or_else(|| {
                    // 글머리표 문단의 첫 자리: 숨은 부호 뒤에서도 그 부호를 묻는다(한/글 실측 — 문단을 합치지 않는다)
                    (logical == 0 && j > 0 && self.code_para_numbered(para)).then(|| j - 1)
                })
            }
        } else if codes_on {
            (j < n).then_some(j)
        } else {
            (j..n).find(|&i| visible_off(gap[i]))
        };
        if let Some(h) = hit_idx {
            let g = gap[h];
            // 지울 묶음: 메모는 시작·끝 표지째(글 없는 메모가 같은 자리에 여럿이면 모두 — 종전 규칙)
            let ci = g.item.control_idx();
            let empty_memo = |c: usize| {
                para.field_ranges.iter().any(|r| r.control_idx == c && r.start_char_idx == r.end_char_idx)
                    && gap.iter().any(|o| o.kind == "memo" && o.item.control_idx() == c)
            };
            let mut removed: Vec<usize> = vec![ci];
            let mut memo_count = 1usize;
            if g.kind == "memo" && empty_memo(ci) {
                for o in gap.iter() {
                    let oc = o.item.control_idx();
                    if o.kind == "memo" && oc != ci && empty_memo(oc) && !removed.contains(&oc) {
                        removed.push(oc);
                    }
                }
                memo_count = removed.len();
            }
            let before_caret = gap
                .iter()
                .enumerate()
                .filter(|(i, o)| *i < j && removed.contains(&o.item.control_idx()))
                .count();
            let caret_gap = j - before_caret;
            let mut out = format!(
                "{{\"found\":true,\"source\":\"gap\",\"gapIndex\":{},\"caret\":{{\"charOffset\":{},\"gap\":{}}}",
                h, logical, caret_gap
            );
            out.push(',');
            let body = gap_code_json(para, g);
            out.push_str(&body[1..body.len() - 1]);
            if g.kind == "memo" {
                out.push_str(&format!(
                    ",\"memoCount\":{},\"memoEnd\":{}",
                    memo_count,
                    matches!(g.item, GapCodeItem::FieldEnd(_))
                ));
            }
            if !out.contains("\"inline\"") {
                out.push_str(",\"inline\":false");
            }
            out.push('}');
            return Ok(out);
        }
        // 틈 안 부호가 아니면 칸 — 캐럿이 틈 머리(backward)·틈 끝(forward)일 때만
        if codes_on && ((backward && j > 0) || (!backward && j < n)) {
            return Ok("{\"found\":false}".to_string());
        }
        let off = if para.controls.iter().any(Control::is_logical_inline) {
            crate::document_core::helpers::logical_to_text_offset(para, logical).0
        } else {
            logical
        };
        // 자동 번호 자리표
        let slots = para.code_slots();
        let ph = if backward {
            slots.iter().find(|s| s.placeholder && off > 0 && s.char_pos + 1 == off)
        } else {
            slots.iter().find(|s| s.placeholder && s.char_pos == off)
        };
        let count_gap = |l: usize| all.iter().filter(|g| g.logical == l).count();
        if let Some(s) = ph {
            let caret = if backward {
                let l = logical.saturating_sub(1);
                format!("{{\"charOffset\":{},\"gap\":{}}}", l, count_gap(l))
            } else {
                format!("{{\"charOffset\":{},\"gap\":{}}}", logical, j)
            };
            return Ok(format!(
                "{{\"found\":true,\"source\":\"slot\",{},\"inline\":true,\"caret\":{}}}",
                code_json(para, s),
                caret
            ));
        }
        // 글자처럼 취급한 개체
        if let Some((ci, true, at)) = object_at(para, logical, backward) {
            let ctrl = &para.controls[ci];
            let caret = if backward {
                format!("{{\"charOffset\":{},\"gap\":{}}}", at, count_gap(at))
            } else {
                format!("{{\"charOffset\":{},\"gap\":{}}}", logical, j)
            };
            return Ok(format!(
                "{{\"found\":true,\"source\":\"slot\",\"codeIndex\":{},\"kind\":\"object\",\"objectType\":\"{}\",\"inline\":true,\"charPos\":{},\"placeholder\":false,\"label\":\"{}\",\"caret\":{}}}",
                ci,
                object_type(ctrl).unwrap_or("shape"),
                at,
                crate::model::code_gaps::object_code_name(ctrl).unwrap_or("개체"),
                caret
            ));
        }
        Ok("{\"found\":false}".to_string())
    }

    /// [hwpx-cowork] 캐럿이 틈 자리 `gap` 에 설 때의 캐럿 사각형(본문 문단) — 그 자리 뒤 부호 표지의 왼쪽 끝.
    /// 틈 끝(gap ≥ 부호 수)이거나 표지를 못 찾으면 보통 캐럿 사각형.
    pub fn code_gap_caret_native(&self, sec: usize, para_idx: usize, logical: usize, gap: usize) -> Result<String, HwpError> {
        use crate::renderer::render_tree::{FieldMarkerType, RenderNode, RenderNodeType};
        let base = self.get_cursor_rect_native(sec, para_idx, logical)?;
        let n = self
            .document
            .sections
            .get(sec)
            .and_then(|s| s.paragraphs.get(para_idx))
            .map(|p| p.gap_codes_at(logical).len())
            .unwrap_or(0);
        if gap >= n || !self.show_control_codes {
            return Ok(base);
        }
        let page = crate::document_core::helpers::json_u32(&base, "pageIndex").unwrap_or(0);
        let tree = self.build_page_tree_cached(page)?;
        fn find(node: &RenderNode, sec: usize, para: usize, logical: usize, gap: usize) -> Option<f64> {
            if let RenderNodeType::TextRun(tr) = &node.node_type {
                if tr.section_index == Some(sec)
                    && tr.para_index == Some(para)
                    && tr.cell_context.is_none()
                    && tr.field_marker == FieldMarkerType::CodeLabel(logical, gap)
                {
                    return Some(node.bbox.x);
                }
            }
            node.children.iter().find_map(|c| find(c, sec, para, logical, gap))
        }
        match find(&tree.root, sec, para_idx, logical, gap) {
            Some(x) => {
                let y = crate::document_core::helpers::json_f64(&base, "y").unwrap_or(0.0);
                let h = crate::document_core::helpers::json_f64(&base, "height").unwrap_or(16.0);
                Ok(format!("{{\"pageIndex\":{},\"x\":{:.1},\"y\":{:.1},\"height\":{:.1}}}", page, x, y, h))
            }
            None => Ok(base),
        }
    }

    /// [hwpx-cowork] 조판 부호 보기에서 (x, y) 가 부호 표지 위면 그 표지 앞/뒤 캐럿 자리 → 적중 JSON(`codeGap` 포함). 아니면 None.
    pub(crate) fn code_label_hit(&self, page_num: u32, x: f64, y: f64) -> Option<String> {
        use crate::renderer::render_tree::{FieldMarkerType, RenderNode, RenderNodeType};
        if !self.show_control_codes {
            return None;
        }
        let tree = self.build_page_tree_cached(page_num).ok()?;
        // (구역, 문단, 표지, 상자, 칸 문맥)
        type Hit = (usize, usize, FieldMarkerType, f64, f64, f64, f64, Option<crate::renderer::layout::CellContext>);
        fn find(node: &RenderNode, x: f64, y: f64) -> Option<Hit> {
            if let RenderNodeType::TextRun(tr) = &node.node_type {
                if matches!(tr.field_marker, FieldMarkerType::CodeLabel(..) | FieldMarkerType::SlotLabel(_))
                    && x >= node.bbox.x
                    && x < node.bbox.x + node.bbox.width
                    && y >= node.bbox.y
                    && y < node.bbox.y + node.bbox.height
                {
                    return Some((
                        tr.section_index?,
                        tr.para_index?,
                        tr.field_marker,
                        node.bbox.x,
                        node.bbox.y,
                        node.bbox.width,
                        node.bbox.height,
                        tr.cell_context.clone(),
                    ));
                }
            }
            node.children.iter().find_map(|c| find(c, x, y))
        }
        let (sec, para, marker, bx, by, bw, bh, cell) = find(&tree.root, x, y)?;
        let right_half = x >= bx + bw / 2.0;
        let (logical, gap) = match marker {
            FieldMarkerType::CodeLabel(l, i) => (l, if right_half { i + 1 } else { i }),
            // 칸 뒤 표지(개체·번호 뒤)는 개체와 한 부호 — 누르면 그 개체 뒤(다음 틈 머리)
            FieldMarkerType::SlotLabel(l) => (l + 1, 0),
            _ => return None,
        };
        let cx = match marker {
            FieldMarkerType::CodeLabel(..) if !right_half => bx,
            _ => bx + bw,
        };
        // 칸·캡션 안 표지: 칸 경로를 함께 싣는다(hit_test_native 의 칸 적중과 같은 꼴)
        let cell_fields = match &cell {
            Some(ctx) => match ctx.path.first() {
                Some(outer) => {
                    let entries: Vec<String> = ctx
                        .path
                        .iter()
                        .map(|e| format!("{{\"controlIndex\":{},\"cellIndex\":{},\"cellParaIndex\":{}}}", e.control_index, e.cell_index, e.cell_para_index))
                        .collect();
                    format!(
                        ",\"parentParaIndex\":{},\"controlIndex\":{},\"cellIndex\":{},\"cellParaIndex\":{},\"cellPath\":[{}]",
                        ctx.parent_para_index,
                        outer.control_index,
                        outer.cell_index,
                        outer.cell_para_index,
                        entries.join(",")
                    )
                }
                None => return None,
            },
            None => String::new(),
        };
        Some(format!(
            "{{\"sectionIndex\":{},\"paragraphIndex\":{},\"charOffset\":{},\"codeGap\":{}{},\"cursorRect\":{{\"pageIndex\":{},\"x\":{:.1},\"y\":{:.1},\"height\":{:.1}}}}}",
            sec, para, logical, gap, cell_fields, page_num, cx, by, bh
        ))
    }
}

// ─── [hwpx-cowork] 틈 가운데 글 넣기 · 칸/캡션 틈 캐럿 (2026-10-30 한/글 실측) ─────────────

impl DocumentCore {
    /// [hwpx-cowork] 캐럿 자리의 조판 부호 틈에 글 넣기 — 한/글처럼 캐럿 앞 부호 뒤·뒤 부호 앞에 들어간다([메모 시작] 뒤·[메모 끝] 앞이면
    /// 메모 안, 틈 끝(gap = 부호 수)이면 모든 부호 뒤 — 메모 끝 뒤·선 뒤). gap 이 없으면 기본 캐럿: 글 붙은 필드 끝이 없는 틈은 틈 끝,
    /// 있으면 보통 넣기(종전). 입력 `{sec,para,cellPath?,charOffset(논리),gap?,text}` → `{"ok":true,"charOffset","gapInsert":bool}`.
    /// 본문·칸·경로 칸 넣기 경로(필드·리플로우)를 그대로 쓴다.
    pub fn insert_text_at_code_gap_native(&mut self, json: &str) -> Result<String, HwpError> {
        let t = CodeTarget::from_json(json)?;
        let logical = json_usize(json, "charOffset")?;
        let gap = crate::document_core::helpers::json_i32(json, "gap").filter(|v| *v >= 0).map(|v| v as usize);
        let text = json_str(json, "text").unwrap_or_default();
        let (plan, text_offset, after_control) = {
            let para = self.code_target_para(&t)?;
            let (k, after) = crate::document_core::helpers::logical_to_text_offset(para, logical);
            (para.code_gap_insert(logical, gap), k, after)
        };
        let gap_insert = plan.is_some();
        crate::model::code_gaps::set_pending_gap_insert(plan);
        let r = if t.path.is_empty() {
            self.insert_text_at_caret_native(t.sec, t.para, text_offset, after_control, &text)
        } else if t.path.len() == 1 {
            let (ci, cell, cpi) = t.path[0];
            self.insert_text_in_cell_native(t.sec, t.para, ci, cell, cpi, text_offset, &text)
        } else {
            self.insert_text_in_cell_by_path(t.sec, t.para, &t.path, text_offset, &text)
        };
        crate::model::code_gaps::set_pending_gap_insert(None);
        r?;
        Ok(format!(
            "{{\"ok\":true,\"charOffset\":{},\"gapInsert\":{}}}",
            logical + text.chars().count(),
            gap_insert
        ))
    }

    /// [hwpx-cowork] 틈 자리 캐럿 사각형 — 본문·표 칸·캡션·글상자 공용. 입력 `{sec,para,cellPath?,charOffset,gap}`.
    /// 틈 자리 뒤 부호 표지의 왼쪽 끝(보기 켬), 그 밖에는 보통 캐럿 사각형. → `{pageIndex,x,y,height}`
    pub fn code_gap_caret_at_native(&self, json: &str) -> Result<String, HwpError> {
        use crate::renderer::render_tree::{FieldMarkerType, RenderNode, RenderNodeType};
        let t = CodeTarget::from_json(json)?;
        let logical = json_usize(json, "charOffset")?;
        let gap = json_usize(json, "gap").unwrap_or(usize::MAX);
        if t.path.is_empty() {
            return self.code_gap_caret_native(t.sec, t.para, logical, gap);
        }
        let path_json = Self::format_path_json(&t.path);
        let base = self.get_cursor_rect_by_path_native(t.sec, t.para, &path_json, logical)?;
        let n = self.code_target_para(&t)?.gap_codes_at(logical).len();
        if !self.show_control_codes || n == 0 {
            return Ok(base);
        }
        let page = crate::document_core::helpers::json_u32(&base, "pageIndex").unwrap_or(0);
        let y = crate::document_core::helpers::json_f64(&base, "y").unwrap_or(0.0);
        let h = crate::document_core::helpers::json_f64(&base, "height").unwrap_or(16.0);
        let tree = self.build_page_tree_cached(page)?;
        let path = t.path.clone();
        let same_cell = |tr: &crate::renderer::render_tree::TextRunNode| {
            tr.cell_context.as_ref().is_some_and(|ctx| {
                ctx.parent_para_index == t.para
                    && ctx.path.len() == path.len()
                    && ctx.path.iter().zip(path.iter()).all(|(e, &(ci, cell, cpi))| {
                        e.control_index == ci && e.cell_index == cell && e.cell_para_index == cpi
                    })
            })
        };
        // 틈 자리 gap(<n) = 그 자리 뒤 표지 왼쪽, 틈 끝 = 틈 표지·앞 칸 뒤 표지의 오른쪽(보통 캐럿보다 오른쪽이면)
        fn walk<'a>(node: &'a RenderNode, out: &mut Vec<(&'a crate::renderer::render_tree::TextRunNode, f64, f64, f64, f64)>) {
            if let RenderNodeType::TextRun(tr) = &node.node_type {
                if matches!(tr.field_marker, FieldMarkerType::CodeLabel(..) | FieldMarkerType::SlotLabel(_)) {
                    out.push((tr, node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height));
                }
            }
            for c in &node.children {
                walk(c, out);
            }
        }
        let mut labels = Vec::new();
        walk(&tree.root, &mut labels);
        let mid = y + h / 2.0;
        let mine: Vec<_> = labels.into_iter().filter(|(tr, _, ly, _, lh)| same_cell(tr) && mid >= *ly && mid <= ly + lh).collect();
        let x = if gap < n {
            mine.iter().find(|(tr, ..)| tr.field_marker == FieldMarkerType::CodeLabel(logical, gap)).map(|l| l.1)
        } else {
            mine.iter()
                .filter(|(tr, ..)| match tr.field_marker {
                    FieldMarkerType::CodeLabel(l, _) => l == logical,
                    FieldMarkerType::SlotLabel(l) => l + 1 == logical,
                    _ => false,
                })
                .map(|l| l.1 + l.3)
                .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))))
                .filter(|r| *r > crate::document_core::helpers::json_f64(&base, "x").unwrap_or(0.0) + 0.5)
        };
        Ok(match x {
            Some(x) => format!("{{\"pageIndex\":{},\"x\":{:.1},\"y\":{:.1},\"height\":{:.1}}}", page, x, y, h),
            None => base,
        })
    }
}
