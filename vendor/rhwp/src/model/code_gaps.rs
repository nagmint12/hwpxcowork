//! [hwpx-cowork] 조판 부호 틈 — 글자 사이 틈에 든 폭 없는 조판 부호와 그 차례(한/글 2022 실측, 2026-10-30).
//!
//! 한/글에서 감추기·선·자리차지 표·머리말·책갈피·메모 시작/끝 같은 부호는 글자 흐름의 한 자리다. 조판 부호 보기를 켜면
//! 부호마다 `[이름]` 표지가 제자리에 그려지고 캐럿이 부호 앞뒤에 선다(오른쪽 화살표 한 번 = 부호 하나).
//! 보기를 끄면 숨은 부호(선·감추기·머리말/꼬리말·자리차지 표/그림·도형·새 번호·책갈피·쪽 번호 위치)는 폭이 없고
//! 캐럿은 부호 뒤에만 서며, 메모·누름틀처럼 늘 보이는 부호는 보기를 꺼도 앞뒤에 선다.
//!
//! rhwp 의 캐럿 자리(논리 자리)는 글자와 글자처럼 취급한 개체·각주를 한 칸씩 센다 — 폭 없는 부호는 칸이 없다.
//! 그래서 부호는 "논리 자리 L 바로 앞 틈"에 들고, 같은 틈의 부호들은 스트림 차례로 선다. 캐럿이 그 틈 안 어디에
//! 서는지(앞에 부호 몇 개)는 편집기 캐럿 상태(`codeGap`)가 들고 다닌다.
//!
//! 틈 안 차례: 그 틈에서 끝나는(글이 붙은) 필드 끝 표지가 먼저, 그다음 컨트롤 차례(= 스트림 차례). 글 없는 필드는
//! 시작 바로 뒤에 끝. (`control_text_positions`·`control_utf16_positions` 가 쓰는 규약 — 필드 끝은 자기 글자 바로
//! 앞 틈의 앞머리 — 과 같다.)

use super::control::{AutoNumberType, Control, FieldType};
use super::header_footer::HeaderFooterApply;
use super::paragraph::Paragraph;
use super::shape::ShapeObject;

/// 틈 부호가 가리키는 것
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapCodeItem {
    /// `controls[i]` (필드면 그 시작 표지)
    Control(usize),
    /// `controls[i]` 필드의 끝 표지
    FieldEnd(usize),
}

impl GapCodeItem {
    pub fn control_idx(&self) -> usize {
        match *self {
            GapCodeItem::Control(i) | GapCodeItem::FieldEnd(i) => i,
        }
    }
}

/// 글자 사이 틈의 폭 없는 조판 부호 하나
#[derive(Debug, Clone)]
pub struct GapCode {
    /// 부호 뒤 글자 번호(`text` 기준 — 문단 끝이면 글자 수)
    pub text_pos: usize,
    /// 부호가 든 틈 바로 뒤 논리 자리(캐럿 자리) — 같은 값의 부호들이 한 틈이다
    pub logical: usize,
    pub item: GapCodeItem,
    /// 조판 부호 보기를 끄면 숨는 부호(캐럿이 앞에 서지 않고, 지우기가 건너뛴다)
    pub hidden: bool,
    /// 화면 표지 — `[감추기]`
    pub label: String,
    /// 지우기 창 이름 — `감추기` (`[감추기] 를 지울까요?`)
    pub name: String,
    /// 편집기 갈래 — pageHiding·newNum·object·memo·field·header·footer …
    pub kind: &'static str,
}

/// 글자처럼 취급한 개체·각주·자동 번호 뒤에 붙는 표지(개체·번호를 그린 다음 `[표]`·`[쪽 번호]`)
#[derive(Debug, Clone)]
pub struct SlotLabel {
    pub control_idx: usize,
    /// 그 개체(자동 번호면 자리표 글자)의 논리 자리
    pub logical: usize,
    /// 자동 번호면 자리표 글자 번호
    pub placeholder_char: Option<usize>,
    pub label: String,
}

fn header_footer_label(head: &str, apply: HeaderFooterApply) -> String {
    // 실측: [머리말(양쪽)] (붙여 씀) · [꼬리말(짝수 쪽)] · [꼬리말(홀수 쪽)]
    match apply {
        HeaderFooterApply::Both => format!("{}(양쪽)", head),
        HeaderFooterApply::Even => format!("{}(짝수 쪽)", head),
        HeaderFooterApply::Odd => format!("{}(홀수 쪽)", head),
    }
}

fn number_type_word(t: AutoNumberType) -> &'static str {
    match t {
        AutoNumberType::Page | AutoNumberType::TotalPage => "쪽",
        AutoNumberType::Footnote => "각주",
        AutoNumberType::Endnote => "미주",
        AutoNumberType::Picture => "그림",
        AutoNumberType::Table => "표",
        AutoNumberType::Equation => "수식",
    }
}

/// 개체(표·그림·도형·수식) 이름 — 한/글 실측 `[선]`·`[사각형]`·`[표]`·`[그림]`·`[수식]`
pub fn object_code_name(ctrl: &Control) -> Option<&'static str> {
    Some(match ctrl {
        Control::Table(_) => "표",
        Control::Picture(_) => "그림",
        Control::Equation(_) => "수식",
        Control::Shape(s) => match **s {
            ShapeObject::Line(_) => "선",
            ShapeObject::Group(_) => "그리기",
            ShapeObject::Picture(_) => "그림",
            _ => s.shape_name(),
        },
        _ => return None,
    })
}

/// 필드 표지 — (시작 표지 이름, 끝 표지 이름, 지우기 창 이름, 갈래). 표지를 그리지 않는 필드(하이퍼링크)는 None
fn field_code_names(t: FieldType) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    Some(match t {
        FieldType::Memo => ("메모 시작", "메모 끝", "메모", "memo"),
        FieldType::ClickHere => ("누름틀 시작", "누름틀 끝", "누름틀", "clickHere"),
        FieldType::Date | FieldType::DocDate | FieldType::Summary | FieldType::UserInfo | FieldType::Path => {
            ("문서 정보 시작", "문서 정보 끝", "문서 정보", "field")
        }
        FieldType::Hyperlink => return None,
        _ => ("필드 시작", "필드 끝", "필드", "field"),
    })
}

/// 컨트롤 하나의 틈 부호 정보 — (표지 이름, 지우기 창 이름, 숨은 부호, 갈래). 틈 부호가 아니면 None
fn control_gap_info(ctrl: &Control) -> Option<(String, String, bool, &'static str)> {
    let s = |v: &str| v.to_string();
    Some(match ctrl {
        Control::Table(_) | Control::Picture(_) | Control::Equation(_) | Control::Shape(_) => {
            if ctrl.is_treat_as_char_object() {
                return None; // 글자처럼 취급한 개체는 칸을 차지한다(뒤 표지 — SlotLabel)
            }
            let n = object_code_name(ctrl)?;
            (s(n), s(n), true, "object")
        }
        Control::Header(h) => {
            let n = header_footer_label("머리말", h.apply_to);
            (n.clone(), n, true, "header")
        }
        Control::Footer(f) => {
            let n = header_footer_label("꼬리말", f.apply_to);
            (n.clone(), n, true, "footer")
        }
        Control::PageHide(_) => (s("감추기"), s("감추기"), true, "pageHiding"),
        Control::PageNumberPos(_) => (s("쪽 번호 위치"), s("쪽 번호 위치"), true, "pageNum"),
        // 실측: 보기 표지는 [새 쪽 번호], 지우기 창은 [새 번호]
        Control::NewNumber(n) => (format!("새 {} 번호", number_type_word(n.number_type)), s("새 번호"), true, "newNum"),
        Control::Bookmark(_) => (s("책갈피"), s("책갈피"), true, "bookmark"),
        Control::IndexMark(_) => (s("찾아보기 표식"), s("찾아보기 표식"), true, "indexMark"),
        Control::PageNumCtrl(_) => (s("홀/짝수 조정"), s("홀/짝수 조정"), true, "pageNumCtrl"),
        Control::HiddenComment(_) => (s("숨은 설명"), s("숨은 설명"), true, "hiddenComment"),
        _ => return None,
    })
}

impl Paragraph {
    /// [hwpx-cowork] 틈 부호 목록 — (논리 자리, 틈 안 차례) 차례. 조판 부호 보기 표지·캐럿 틈·지우기가 같은 목록을 쓴다.
    pub fn gap_codes(&self) -> Vec<GapCode> {
        if self.controls.is_empty() {
            return Vec::new();
        }
        let positions = self.control_text_positions();
        let text_len = self.text.chars().count();
        // 글자처럼 취급한 개체·각주(논리 칸을 차지하는 것)의 (컨트롤 번호, 글자 번호)
        let inline: Vec<(usize, usize)> = self
            .controls
            .iter()
            .enumerate()
            .filter(|(_, c)| c.is_logical_inline())
            .map(|(i, _)| (i, positions.get(i).copied().unwrap_or(text_len).min(text_len)))
            .collect();
        let inline_before_ctrl = |ci: usize| inline.iter().filter(|(i, _)| *i < ci).count();
        let inline_before_text = |k: usize| inline.iter().filter(|(_, p)| *p < k).count();

        // (글자 번호, 단계, 컨트롤 번호, 버금, 부호) — 단계 0 = 틈 앞머리(글 붙은 필드 끝), 1 = 컨트롤 차례
        let mut rows: Vec<(usize, u8, usize, u8, GapCode)> = Vec::new();
        let field_range = |ci: usize| self.field_ranges.iter().find(|r| r.control_idx == ci);
        for r in &self.field_ranges {
            let Some(Control::Field(f)) = self.controls.get(r.control_idx) else { continue };
            let Some((_, end_name, name, kind)) = field_code_names(f.field_type) else { continue };
            if r.start_char_idx >= r.end_char_idx {
                continue; // 글 없는 필드 — 시작 바로 뒤에 끝(아래)
            }
            let k = r.end_char_idx.min(text_len);
            rows.push((
                k,
                0,
                r.control_idx,
                0,
                GapCode {
                    text_pos: k,
                    logical: k + inline_before_text(k),
                    item: GapCodeItem::FieldEnd(r.control_idx),
                    hidden: false,
                    label: format!("[{}]", end_name),
                    name: name.to_string(),
                    kind,
                },
            ));
        }
        for (ci, ctrl) in self.controls.iter().enumerate() {
            if let Control::Field(f) = ctrl {
                let Some((begin_name, end_name, name, kind)) = field_code_names(f.field_type) else { continue };
                let range = field_range(ci);
                let k = range
                    .map(|r| r.start_char_idx)
                    .unwrap_or_else(|| positions.get(ci).copied().unwrap_or(text_len))
                    .min(text_len);
                let logical = k + inline_before_ctrl(ci);
                rows.push((
                    k,
                    1,
                    ci,
                    0,
                    GapCode {
                        text_pos: k,
                        logical,
                        item: GapCodeItem::Control(ci),
                        hidden: false,
                        label: format!("[{}]", begin_name),
                        name: name.to_string(),
                        kind,
                    },
                ));
                if range.is_some_and(|r| r.start_char_idx >= r.end_char_idx) {
                    rows.push((
                        k,
                        1,
                        ci,
                        1,
                        GapCode {
                            text_pos: k,
                            logical,
                            item: GapCodeItem::FieldEnd(ci),
                            hidden: false,
                            label: format!("[{}]", end_name),
                            name: name.to_string(),
                            kind,
                        },
                    ));
                }
                continue;
            }
            let Some((label, name, hidden, kind)) = control_gap_info(ctrl) else { continue };
            let k = positions.get(ci).copied().unwrap_or(text_len).min(text_len);
            rows.push((
                k,
                1,
                ci,
                0,
                GapCode {
                    text_pos: k,
                    logical: k + inline_before_ctrl(ci),
                    item: GapCodeItem::Control(ci),
                    hidden,
                    label: format!("[{}]", label),
                    name,
                    kind,
                },
            ));
        }
        rows.sort_by_key(|r| (r.4.logical, r.1, r.2, r.3));
        rows.into_iter().map(|r| r.4).collect()
    }

    /// [hwpx-cowork] 논리 자리 `logical` 바로 앞 틈의 부호들(스트림 차례)
    pub fn gap_codes_at(&self, logical: usize) -> Vec<GapCode> {
        self.gap_codes().into_iter().filter(|g| g.logical == logical).collect()
    }

    /// [hwpx-cowork] 칸을 차지하는 것 뒤에 붙는 표지 — 글자처럼 취급한 표·그림·도형·수식, 각주·미주, 자동 번호(쪽 번호 등)
    pub fn slot_labels(&self) -> Vec<SlotLabel> {
        if self.controls.is_empty() {
            return Vec::new();
        }
        let positions = self.logical_control_positions();
        let mut out = Vec::new();
        let slots = self.code_slots();
        for (ci, ctrl) in self.controls.iter().enumerate() {
            let label = match ctrl {
                Control::Footnote(_) => "각주".to_string(),
                Control::Endnote(_) => "미주".to_string(),
                Control::AutoNumber(a) => match a.number_type {
                    AutoNumberType::Page => "쪽 번호".to_string(),
                    AutoNumberType::TotalPage => "전체 쪽수".to_string(),
                    t => format!("{} 번호", number_type_word(t)),
                },
                c if c.is_treat_as_char_object() => match object_code_name(c) {
                    Some(n) => n.to_string(),
                    None => continue,
                },
                _ => continue,
            };
            if let Control::AutoNumber(_) = ctrl {
                // 자동 번호는 자리표 글자 한 칸(글자 번호 → 논리 자리)
                let Some(slot) = slots.iter().find(|s| s.control_idx == ci && s.placeholder) else { continue };
                let p = slot.char_pos;
                let logical = p + self
                    .controls
                    .iter()
                    .enumerate()
                    .filter(|(i, c)| c.is_logical_inline() && self.control_text_positions().get(*i).is_some_and(|&q| q <= p))
                    .count();
                out.push(SlotLabel { control_idx: ci, logical, placeholder_char: Some(p), label: format!("[{}]", label) });
                continue;
            }
            let Some(&logical) = positions.get(ci) else { continue };
            out.push(SlotLabel { control_idx: ci, logical, placeholder_char: None, label: format!("[{}]", label) });
        }
        out
    }

    /// [hwpx-cowork] 부호의 스트림 자리(UTF-16) — 표지 글자 모양을 고를 때 쓴다(부호가 든 run 의 글자 모양)
    pub fn gap_code_stream_pos(&self, code: &GapCode) -> u32 {
        match code.item {
            GapCodeItem::Control(ci) => self.control_utf16_positions().get(ci).copied().unwrap_or(0),
            GapCodeItem::FieldEnd(_) => {
                // 글 붙은 필드 끝은 자기 글자 바로 앞 틈의 앞머리 — 앞 글자 끝
                let chars: Vec<char> = self.text.chars().collect();
                match code.text_pos.checked_sub(1) {
                    Some(prev) => self
                        .char_offsets
                        .get(prev)
                        .map(|o| *o + chars.get(prev).map_or(1, |c| c.len_utf16() as u32))
                        .unwrap_or(0),
                    None => 0,
                }
            }
        }
    }

    /// [hwpx-cowork] 스트림 자리 `pos` 의 글자 모양 번호
    pub fn char_shape_at_stream(&self, pos: u32) -> u32 {
        self.char_shapes
            .iter()
            .filter(|cs| cs.start_pos <= pos)
            .last()
            .or(self.char_shapes.first())
            .map(|cs| cs.char_shape_id)
            .unwrap_or(0)
    }
}

// ─── [hwpx-cowork] 틈 가운데 글 넣기(한/글 실측: 캐럿 자리 그대로 — 부호 j-1 과 j 사이) ─────────────
//
// 글 넣기 경로(본문·칸·경로 칸, 필드·리플로우 처리)를 그대로 쓰려고, 넣기 직전에 "다음 넣기 한 번이 쓸 자리"를 걸어 둔다.
// `Paragraph::insert_text_at_caret` 이 하나를 꺼내 쓴다(WASM 은 한 줄기라 thread_local 로 충분하다).

/// 틈 가운데 넣기 자리
#[derive(Debug, Clone, Default)]
pub struct CodeGapInsert {
    /// 새 글자의 스트림 자리(UTF-16) — 틈 끝에서 캐럿 뒤 부호 수 × 8 앞
    pub utf16: u32,
    /// 이 틈에서 시작 표지가 캐럿 뒤인 필드(컨트롤 번호) — 새 글은 필드 밖(앞)이라 시작이 밀린다
    pub begins_after: Vec<usize>,
    /// 이 틈에서 끝 표지가 캐럿 앞인 필드 — 새 글은 필드 밖(뒤)이라 끝이 밀리지 않는다
    pub ends_before: Vec<usize>,
}

thread_local! {
    static PENDING_GAP_INSERT: std::cell::RefCell<Option<CodeGapInsert>> = const { std::cell::RefCell::new(None) };
}

pub fn set_pending_gap_insert(v: Option<CodeGapInsert>) {
    PENDING_GAP_INSERT.with(|c| *c.borrow_mut() = v);
}

pub(crate) fn take_pending_gap_insert() -> Option<CodeGapInsert> {
    PENDING_GAP_INSERT.with(|c| c.borrow_mut().take())
}

impl Paragraph {
    /// [hwpx-cowork] 논리 자리 `logical` 의 틈 자리 `j`(앞 부호 수)에 글을 넣을 때의 넣기 자리. 틈 끝이면 None(보통 넣기)
    /// `j` = None 이면 기본 캐럿(틈 자리를 모름): 틈에 글 붙은 필드의 끝 표지가 없을 때만 틈 끝(모든 부호 뒤)에 넣는다 —
    /// 끝 표지가 있으면 None(보통 넣기 — 메모 글 끝에 이어 치면 메모가 늘어나는 종전 규칙).
    pub fn code_gap_insert(&self, logical: usize, j: Option<usize>) -> Option<CodeGapInsert> {
        let gap = self.gap_codes_at(logical);
        let n = gap.len();
        if n == 0 {
            return None;
        }
        let j = match j {
            Some(j) => j.min(n),
            None if gap.iter().any(|g| matches!(g.item, GapCodeItem::FieldEnd(_))) => return None,
            None => n,
        };
        // 틈 끝 = 다음 칸(글자처럼 취급한 개체 또는 글자)의 스트림 자리, 문단 끝이면 문단 끝 표시 앞
        let positions = self.logical_control_positions();
        let next_inline = self
            .controls
            .iter()
            .enumerate()
            .find(|(i, c)| c.is_logical_inline() && positions.get(*i).copied() == Some(logical))
            .map(|(i, _)| i);
        let k = gap[0].text_pos;
        let gap_end = match next_inline {
            Some(ci) => *self.control_utf16_positions().get(ci)?,
            None => match self.char_offsets.get(k) {
                Some(&o) => o,
                None => self.char_count.saturating_sub(1),
            },
        };
        let after = (n - j) as u32;
        let utf16 = gap_end.checked_sub(after * super::control::CTRL_CHAR_CODE_UNITS)?;
        let mut out = CodeGapInsert { utf16, ..Default::default() };
        for (i, g) in gap.iter().enumerate() {
            match g.item {
                GapCodeItem::Control(ci) if i >= j && matches!(self.controls.get(ci), Some(Control::Field(_))) => {
                    out.begins_after.push(ci)
                }
                GapCodeItem::FieldEnd(ci) if i < j => out.ends_before.push(ci),
                _ => {}
            }
        }
        Some(out)
    }
}
