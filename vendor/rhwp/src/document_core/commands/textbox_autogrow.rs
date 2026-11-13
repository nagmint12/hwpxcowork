//! [hwpx-cowork] 글상자 높이 자동 늘림 — 한/글 2022 실측 규칙을 문서 조판 준비 때 한 번 적용한다.
//!
//! 한/글은 글이 넘치는 글상자(사각형 그리기 개체 + 글상자)를 크기 고정(`sz protect`)이 꺼져 있으면
//! **아래로 늘려** 그린다(2026-11-03 조판 회귀 M·A 묶음, `artifacts/layout-fix-20261103/scratch/draw/textbox_probe.py`):
//!
//! ```text
//!   높이 = max(지정 높이, 위 안 여백 + 마지막 줄 vpos + 그 줄 높이 + 아래 안 여백)
//! ```
//!
//! * 6000HU 글상자, 안 여백 283, 4줄(마지막 줄 vpos 5940, 높이 1100) → 7606HU. 안 여백 0 → 7040. 글 두 배 → 13546.
//! * `protect="1"` 이면 늘리지 않는다. 글이 짧아도 줄이지 않는다(지정 높이 유지). 세로 가운데 정렬도 같다.
//! * 한/글 재저장본은 `sz height` 를 지정 높이(6000) 그대로 두고 `curSz height="7606"`·`scaMatrix e5` 에
//!   늘어난 값을 적는다. 이 단계는 저장 줄(또는 저장 줄이 없으면 엔진 줄 나눔)로 높이를 **다시 계산해 설정**하므로
//!   재저장본에서도 두 번 늘지 않는다.
//!
//! 개체 높이(`common.height`)를 읽는 조판 경로가 수백 곳이라, 쪽 나눔 전에 IR 의 높이 값을 갱신한다.
//! 저장 때는 `CommonObjAttr::auto_grow_base_height` 로 지정 높이를 되살려 `hp:sz` 에 쓴다(한/글과 같게).

use crate::document_core::DocumentCore;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::shape::{RectangleShape, ShapeObject};
use crate::renderer::composer::{reflow_line_segs, ParagraphBox};
use crate::renderer::style_resolver::ResolvedStyleSet;
use crate::renderer::{hwpunit_to_px, px_to_hwpunit};

impl DocumentCore {
    /// [hwpx-cowork] 2026-11-04 글상자 안 문단의 저장 줄(lineseg)을 버린다 — 한/글 2022 는 HWPX 를 열 때
    /// 글상자(drawText) 안 저장 줄을 믿지 않고 다시 조판한다(변수 검정 글상자 b156~b161·b164·c186·c187·h201:
    /// 줄 1개만·6줄·vertpos 5000·줄 높이 4000·폭 40000 으로 바꿔도 한/글은 같은 2줄로 그리고 재저장 때 고쳐 적음).
    /// 엔진은 그 값을 그대로 써서 글이 잘리거나 늘어났다. 저장 줄 없는 글상자(생성 문서)와 같은 경로(그릴 때
    /// 조판)로 보낸다. 세로쓰기 글상자는 규칙을 재지 않았으므로 그대로 둔다.
    #[allow(dead_code)] // 아직 켜지 않음 — document.rs 의 주석(실문서A 표지 글상자) 참고
    pub(crate) fn drop_textbox_stored_linesegs(document: &mut Document) {
        for section in &mut document.sections {
            drop_tb_segs_in_paragraphs(&mut section.paragraphs, false);
            for master in &mut section.section_def.master_pages {
                drop_tb_segs_in_paragraphs(&mut master.paragraphs, false);
            }
        }
    }

    /// 문서의 모든 글상자(본문·표 칸·머리말·꼬리말·각주·미주·바탕쪽·글상자 안)에 자동 늘림을 적용한다.
    pub(crate) fn grow_overflowing_textboxes(document: &mut Document, styles: &ResolvedStyleSet, dpi: f64) {
        for section in &mut document.sections {
            let refs = RelRefs::of(&section.section_def.page_def);
            grow_in_paragraphs(&mut section.paragraphs, styles, dpi, refs);
            for master in &mut section.section_def.master_pages {
                grow_in_paragraphs(&mut master.paragraphs, styles, dpi, refs);
            }
        }
    }
}

fn grow_in_paragraphs(paragraphs: &mut [Paragraph], styles: &ResolvedStyleSet, dpi: f64, refs: RelRefs) {
    for para in paragraphs {
        for ctrl in &mut para.controls {
            match ctrl {
                Control::Shape(shape) => {
                    // 묶음 자식은 묶음 배율이 얽혀 규칙을 확인하지 않았으므로 건드리지 않는다.
                    if let ShapeObject::Rectangle(rect) = shape.as_mut() {
                        if let Some(tb) = rect.drawing.text_box.as_mut() {
                            grow_in_paragraphs(&mut tb.paragraphs, styles, dpi, refs);
                        }
                        // [hwpx-cowork] 캡션 안 글상자도 같은 규칙(조판 회귀 A 캡션: 한/글 7606).
                        if let Some(cap) = rect.drawing.caption.as_mut() {
                            grow_in_paragraphs(&mut cap.paragraphs, styles, dpi, refs);
                        }
                        grow_rectangle(rect, styles, dpi, refs);
                    }
                }
                Control::Table(table) => {
                    for cell in &mut table.cells {
                        grow_in_paragraphs(&mut cell.paragraphs, styles, dpi, refs);
                    }
                    // [hwpx-cowork] 표 캡션 안 글상자 — 캡션 높이·뒤 문단이 늘어난 높이를 따른다.
                    if let Some(cap) = table.caption.as_mut() {
                        grow_in_paragraphs(&mut cap.paragraphs, styles, dpi, refs);
                    }
                }
                Control::Picture(pic) => {
                    if let Some(cap) = pic.caption.as_mut() {
                        grow_in_paragraphs(&mut cap.paragraphs, styles, dpi, refs);
                    }
                }
                Control::Header(h) => grow_in_paragraphs(&mut h.paragraphs, styles, dpi, refs),
                Control::Footer(f) => grow_in_paragraphs(&mut f.paragraphs, styles, dpi, refs),
                Control::Footnote(n) => grow_in_paragraphs(&mut n.paragraphs, styles, dpi, refs),
                Control::Endnote(n) => grow_in_paragraphs(&mut n.paragraphs, styles, dpi, refs),
                _ => {}
            }
        }
    }
}

/// `inside_tb` = 이 문단들이 글상자 안 문단인가(그러면 저장 줄을 비운다).
fn drop_tb_segs_in_paragraphs(paragraphs: &mut [Paragraph], inside_tb: bool) {
    for para in paragraphs {
        if inside_tb {
            para.line_segs.clear();
        }
        for ctrl in &mut para.controls {
            match ctrl {
                Control::Shape(shape) => drop_tb_segs_in_shape(shape.as_mut()),
                Control::Table(table) => {
                    for cell in &mut table.cells {
                        drop_tb_segs_in_paragraphs(&mut cell.paragraphs, false);
                    }
                }
                Control::Header(h) => drop_tb_segs_in_paragraphs(&mut h.paragraphs, false),
                Control::Footer(f) => drop_tb_segs_in_paragraphs(&mut f.paragraphs, false),
                Control::Footnote(n) => drop_tb_segs_in_paragraphs(&mut n.paragraphs, false),
                Control::Endnote(n) => drop_tb_segs_in_paragraphs(&mut n.paragraphs, false),
                _ => {}
            }
        }
    }
}

fn drop_tb_segs_in_shape(shape: &mut ShapeObject) {
    if let ShapeObject::Group(g) = shape {
        for child in &mut g.children {
            drop_tb_segs_in_shape(child);
        }
        return;
    }
    if let Some(tb) = shape.drawing_mut().and_then(|d| d.text_box.as_mut()) {
        let vertical = tb.list_attr & 0x07 != 0 || tb.vertical_all;
        drop_tb_segs_in_paragraphs(&mut tb.paragraphs, !vertical);
    }
}

/// 상대 크기 기준 길이(HU): 종이·쪽(본문) 폭·높이. 단·문단 기준 폭은 본문 폭으로 근사.
#[derive(Clone, Copy)]
struct RelRefs {
    paper_w: f64,
    paper_h: f64,
    body_w: f64,
    body_h: f64,
}

impl RelRefs {
    fn of(pd: &crate::model::page::PageDef) -> Self {
        let paper_w = pd.width as f64;
        let paper_h = pd.height as f64;
        let body_w = paper_w - pd.margin_left as f64 - pd.margin_right as f64 - pd.margin_gutter as f64;
        let body_h = paper_h
            - pd.margin_top as f64
            - pd.margin_bottom as f64
            - pd.margin_header as f64
            - pd.margin_footer as f64;
        Self { paper_w, paper_h, body_w: body_w.max(0.0), body_h: body_h.max(0.0) }
    }
    fn width_hu(&self, c: crate::model::shape::SizeCriterion, v: u32) -> u32 {
        use crate::model::shape::SizeCriterion as C;
        match c {
            C::Absolute => v,
            C::Paper => (self.paper_w * v as f64 / 10000.0).round() as u32,
            C::Page | C::Column | C::Para => (self.body_w * v as f64 / 10000.0).round() as u32,
        }
    }
    fn height_hu(&self, c: crate::model::shape::SizeCriterion, v: u32) -> u32 {
        use crate::model::shape::SizeCriterion as C;
        match c {
            C::Paper => (self.paper_h * v as f64 / 10000.0).round() as u32,
            C::Page => (self.body_h * v as f64 / 10000.0).round() as u32,
            _ => v,
        }
    }
}

fn usable_segs(para: &Paragraph) -> bool {
    !para.line_segs.is_empty()
        && !(para.line_segs.len() == 1 && para.line_segs[0].is_missing_lineseg_placeholder())
        && para.line_segs.iter().any(|s| s.line_height > 0)
}

fn grow_rectangle(rect: &mut RectangleShape, styles: &ResolvedStyleSet, dpi: f64, refs: RelRefs) {
    // 편집으로 글이 줄거나 크기 고정을 켜면 보관한 지정 높이로 되돌린다(늘림은 늘 지정 높이 기준).
    let Some(needed) = needed_textbox_height(rect, styles, dpi, refs) else {
        restore_base_height(rect);
        return;
    };
    let base = rect.common.auto_grow_base_height.unwrap_or(rect.common.height);
    // [hwpx-cowork] 2026-11-04 상대 높이(1/100 %)는 실제 길이로 견준다. 늘린 높이는 HU 라서
    // 렌더(`resolve_object_size`)는 `auto_grow_base_height` 가 있으면 높이를 절대값으로 읽는다
    // — 종전엔 늘린 3646HU 를 다시 % 로 읽어 30698 로 그렸다(textbox 검정 b214·b215).
    let base_actual = refs.height_hu(rect.common.height_criterion, base);
    if needed as u32 <= base_actual {
        restore_base_height(rect);
        return;
    }
    // [hwpx-cowork] 늘어난 높이를 조판 높이로. 지정 높이는 저장용으로 보관(두 번째 호출도 같은 결과).
    rect.common.auto_grow_base_height = Some(base);
    rect.common.height = needed as u32;
    rect.drawing.shape_attr.current_height = needed as u32;
}

fn restore_base_height(rect: &mut RectangleShape) {
    if let Some(base) = rect.common.auto_grow_base_height.take() {
        rect.common.height = base;
        rect.drawing.shape_attr.current_height = base;
    }
}

/// 늘림이 필요한 글상자면 필요 높이(HU), 대상이 아니면 `None`.
fn needed_textbox_height(rect: &RectangleShape, styles: &ResolvedStyleSet, dpi: f64, refs: RelRefs) -> Option<i32> {
    let common = &rect.common;
    if common.size_protect || common.height == 0 || common.width == 0 {
        return None;
    }
    let tb = rect.drawing.text_box.as_ref()?;
    // 세로쓰기 글상자는 늘림 축이 다르다 — 확인하지 않았으므로 제외.
    if tb.list_attr & 0x07 != 0 || tb.paragraphs.iter().all(|p| p.text.is_empty() && p.controls.is_empty()) {
        return None;
    }
    let margin_l = i32::from(tb.margin_left).max(0);
    let margin_r = i32::from(tb.margin_right).max(0);
    let margin_t = i32::from(tb.margin_top).max(0);
    let margin_b = i32::from(tb.margin_bottom).max(0);
    // [hwpx-cowork] 2026-11-04 상대 폭(1/100 %)은 실제 폭으로(종전: 5000 = 50% 를 5000HU 로 읽어 좁은 상자로 줄 나눔, b207~b210).
    let inner_w_hu = refs.width_hu(common.width_criterion, common.width) as i32 - margin_l - margin_r;
    if inner_w_hu <= 0 {
        return None;
    }
    let all_stored = tb.paragraphs.iter().all(usable_segs);
    let content_hu = if all_stored {
        // 저장 줄(한/글 재저장본 등): 글상자 안 vpos 는 첫 문단부터 이어진 값이다.
        // 연결 글상자 넘김(뒤 문단 vpos 가 앞 문단 끝보다 작아짐)이 보이면 손대지 않는다.
        // 쪽 기준 vpos 스트림(#5721)도 있으므로 첫 줄 vpos 를 원점으로 뺀다.
        let origin = tb.paragraphs[0].line_segs[0].vertical_pos;
        let mut end = origin;
        for (i, p) in tb.paragraphs.iter().enumerate() {
            let first = &p.line_segs[0];
            if i > 0 && first.vertical_pos < end {
                return None;
            }
            let last: &LineSeg = p.line_segs.last().unwrap();
            end = end.max(last.vertical_pos.saturating_add(last.line_height));
        }
        end - origin
    } else {
        // 저장 줄이 없으면(스크립트로 만든 HWPX) 렌더와 같은 상자로 줄을 나눠 높이를 잰다(IR 은 바꾸지 않음).
        let inner_w_px = hwpunit_to_px(inner_w_hu, dpi);
        let n = tb.paragraphs.len();
        let mut total = 0i32;
        for (i, p) in tb.paragraphs.iter().enumerate() {
            let style = styles.para_styles.get(p.para_shape_id as usize);
            let mut q = p.clone();
            if !usable_segs(&q) {
                q.line_segs.clear();
                reflow_line_segs(&mut q, ParagraphBox::content_for_style(inner_w_px, style, dpi), styles, dpi);
            }
            let (Some(first), Some(last)) = (q.line_segs.first(), q.line_segs.last()) else {
                continue;
            };
            total += last.vertical_pos - first.vertical_pos + last.line_height;
            if i + 1 < n {
                let after = style.map(|s| px_to_hwpunit(s.spacing_after, dpi)).unwrap_or(0);
                let next_before = tb
                    .paragraphs
                    .get(i + 1)
                    .and_then(|np| styles.para_styles.get(np.para_shape_id as usize))
                    .map(|s| px_to_hwpunit(s.spacing_before, dpi))
                    .unwrap_or(0);
                total += last.line_spacing.max(0) + after + next_before;
            }
        }
        total
    };
    Some(margin_t + content_hu + margin_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (문단, 개체) 위치와 글상자 사각형의 (조판 높이, 보관한 지정 높이).
    fn textbox(doc: &DocumentCore) -> (usize, usize, u32, Option<u32>) {
        for (pi, para) in doc.document().sections[0].paragraphs.iter().enumerate() {
            for (ci, ctrl) in para.controls.iter().enumerate() {
                if let Control::Shape(shape) = ctrl {
                    if let ShapeObject::Rectangle(rect) = shape.as_ref() {
                        if rect.drawing.text_box.is_some() {
                            return (pi, ci, rect.common.height, rect.common.auto_grow_base_height);
                        }
                    }
                }
            }
        }
        panic!("글상자 없음");
    }

    #[test]
    fn textbox_grows_on_edit_and_shrinks_back_to_declared_height() {
        // 6000HU 글상자(안 여백 283)에 넘치는 글 4줄 — 한/글 2022 는 7606HU 로 늘려 그린다.
        let mut doc =
            DocumentCore::from_bytes(include_bytes!("../../../samples/hwpx/textbox_autogrow_overflow.hwpx")).unwrap();
        let (pi, ci, h, base) = textbox(&doc);
        assert_eq!((h, base), (7606, Some(6000)), "열 때 늘림");

        // 글을 거의 다 지우면 지정 높이로 줄어든다.
        let len = doc.document().sections[0].paragraphs[pi].controls[ci]
            .clone();
        let text_len = match &len {
            Control::Shape(s) => match s.as_ref() {
                ShapeObject::Rectangle(r) => r.drawing.text_box.as_ref().unwrap().paragraphs[0].text.chars().count(),
                _ => unreachable!(),
            },
            _ => unreachable!(),
        };
        let removed: String = match &len {
            Control::Shape(s) => match s.as_ref() {
                ShapeObject::Rectangle(r) => r.drawing.text_box.as_ref().unwrap().paragraphs[0].text.chars().skip(3).collect(),
                _ => unreachable!(),
            },
            _ => unreachable!(),
        };
        doc.delete_text_in_cell_native(0, pi, ci, 0, 0, 3, text_len - 3).unwrap();
        let (_, _, h, base) = textbox(&doc);
        assert_eq!((h, base), (6000, None), "지운 뒤 지정 높이");

        // 되돌리기(편집기는 역명령으로 되살린다) — 같은 글을 다시 넣으면 다시 늘어난다.
        doc.insert_text_in_cell_native(0, pi, ci, 0, 0, 3, &removed).unwrap();
        let (_, _, h, base) = textbox(&doc);
        assert_eq!((h, base), (7606, Some(6000)), "다시 넣은 뒤 늘림");

        // 더 넣으면 줄 수만큼 더 늘고, 저장 sz 는 지정 높이 그대로다.
        doc.insert_text_in_cell_native(0, pi, ci, 0, 0, 0, &removed).unwrap();
        let (_, _, h, base) = textbox(&doc);
        assert!(h > 7606 && base == Some(6000), "더 넣으면 더 늘림: {h}");
    }
}
