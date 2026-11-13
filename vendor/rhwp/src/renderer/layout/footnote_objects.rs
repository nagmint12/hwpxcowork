//! [hwpx-cowork] 각주 안 개체(표·그림·도형·수식) 배치 — 한/글 2022 실측 규칙.
//!
//! 종전 `layout_footnote_area` 는 각주 문단의 글 줄만 그리고 개체 컨트롤은 건너뛰어,
//! 각주 안 표·그림·글상자·묶음이 쪽에서 통째로 사라지고 각주 영역 높이에도 들지 않았다
//! (조판 회귀 2026-11-03 notes 축 A·B footNote object-presence 2,200여 회).
//!
//! 한/글 2022 재저장 줄 정보(`regression-20261103/oracle/*.hwpx` 의 각주 lineseg)와
//! 쪽 그림으로 확인한 규칙(각주 영역 = 각주 글 폭 상자):
//! - 가로: 기준(종이·쪽·단·문단)과 상관없이 각주 글 상자 안에서 정렬한다. 왼쪽·안쪽 =
//!   왼쪽 + 오프셋(왼쪽 밖으로는 나가지 않음), 오른쪽·바깥쪽 = 오른쪽 끝, 가운데 = 가운데.
//!   바깥 왼쪽 여백만큼 안으로 들어간다.
//! - 세로: 문단 기준은 문단 위 + 오프셋(음수는 0) + 바깥 위 여백. 쪽·종이 기준의 위·안쪽
//!   정렬은 각주 맨 위(구분선 아래)에 놓이고 각주 첫 문단부터 그 아래로 밀린다. 쪽·종이
//!   기준의 가운데·아래·바깥쪽 정렬은 한/글 쪽 그림에 나타나지 않는다(그리지 않음).
//! - 자리차지(위아래)는 개체 띠(바깥 여백 포함)와 겹치는 글 줄을 띠 아래로 민다 —
//!   오프셋 2000 이면 앵커 줄은 위에 남고 다음 문단이 띠 아래로 간다. 어울림·자리차지 없는
//!   흐름(SQUARE·TIGHT·THROUGH)은 글이 놓일 수 있는 쪽 폭이 없을 때(왼쪽 정렬 + 왼쪽만)만
//!   위아래처럼 민다. 글 뒤·글 앞은 밀지 않는다.
//! - 각주 영역 높이 = max(마지막 글 줄 바닥, 개체 바닥 + 바깥 아래 여백).
//! - 글자처럼 취급한 개체는 줄 높이에 이미 들어 있으므로(줄 조판) 그 줄 자리에 그린다.

use super::super::page_layout::LayoutRect;
use super::super::render_tree::*;
use super::super::style_resolver::ResolvedStyleSet;
use super::super::hwpunit_to_px;
use super::LayoutEngine;
use crate::model::bin_data::BinDataContent;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{CommonObjAttr, HorzAlign, TextFlow, TextWrap, VertAlign, VertRelTo};
use crate::model::style::Alignment;

/// 각주 안 떠 있는 개체 하나의 자리(px, 각주 좌표계 그대로).
#[derive(Clone, Debug)]
pub(crate) struct NoteFloat {
    pub ctrl_idx: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 글 줄을 밀어내는 띠 [위, 아래) — 바깥 여백 포함.
    pub band: Option<(f64, f64)>,
    /// 각주 높이에 드는 바닥(개체 아래 + 바깥 아래 여백).
    pub bottom: f64,
    /// [hwpx-cowork] 2026-11-04 쪽 경계에서 잘린 표 — 표 전체를 `origin_y` 에 그리고 보이는 띠만 남긴다.
    pub cut: Option<NoteTableCut>,
}

/// [hwpx-cowork] 2026-11-04 각주 안 잘린 표를 그리는 자리(px).
///
/// 한/글 2022(회귀 B·W footNote straddle, 시험지 `scratch/fn-table/probe1`): 앞 조각은 표 위 ~ 자른 자리,
/// 뒤 조각은 다음 쪽 각주 맨 위(구분선 아래 + 바깥 위 여백)에서 나머지를 잇는다. 세로 오프셋은 앞 조각에만,
/// 바깥 아래 여백은 두 조각 모두. 제목 줄 반복이 켜져 있으면 뒤 조각 맨 위에 제목 줄을 다시 그린다.
#[derive(Clone, Debug)]
pub(crate) struct NoteTableCut {
    /// 표 원점(행 0 위)
    pub origin_y: f64,
    /// 보이는 띠 [위, 아래)
    pub clip_top: f64,
    pub clip_bottom: f64,
    /// 뒤 조각 맨 위에 다시 그리는 제목 줄 높이(0 이면 없음). 제목 줄은 `NoteFloat.y` 에 그린다.
    pub header_h: f64,
}

/// [hwpx-cowork] 2026-11-04 노드(와 자식)를 세로 띠 [top, bottom) 로 자른다(이미 잘림이 있으면 겹친 곳만).
fn clip_node_vertically(node: &mut RenderNode, top: f64, bottom: f64) {
    let clip = BoundingBox::new(-100_000.0, top, 200_000.0, (bottom - top).max(0.0));
    node.clip = Some(match node.clip {
        Some(c) => {
            let (x0, y0) = (c.x.max(clip.x), c.y.max(clip.y));
            let x1 = (c.x + c.width).min(clip.x + clip.width);
            let y1 = (c.y + c.height).min(clip.y + clip.height);
            BoundingBox::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
        }
        None => clip,
    });
}

/// 개체 컨트롤의 공통 속성과 바깥 여백(좌, 우, 위, 아래 HU).
fn float_common(ctrl: &Control) -> Option<(&CommonObjAttr, [i32; 4])> {
    match ctrl {
        Control::Table(t) => Some((
            &t.common,
            [
                t.outer_margin_left as i32,
                t.outer_margin_right as i32,
                t.outer_margin_top as i32,
                t.outer_margin_bottom as i32,
            ],
        )),
        Control::Picture(p) => {
            let m = &p.common.margin;
            Some((&p.common, [m.left as i32, m.right as i32, m.top as i32, m.bottom as i32]))
        }
        Control::Shape(s) => {
            let c = s.as_ref().common();
            let m = &c.margin;
            Some((c, [m.left as i32, m.right as i32, m.top as i32, m.bottom as i32]))
        }
        Control::Equation(e) => {
            let m = &e.common.margin;
            Some((&e.common, [m.left as i32, m.right as i32, m.top as i32, m.bottom as i32]))
        }
        _ => None,
    }
}

/// 쪽·종이 기준 위/안쪽 정렬 — 각주 맨 위에 놓이는 개체.
fn anchors_note_top(c: &CommonObjAttr) -> bool {
    !matches!(c.vert_rel_to, VertRelTo::Para)
        && matches!(c.vert_align, VertAlign::Top | VertAlign::Inside)
}

/// 쪽·종이 기준 가운데·아래·바깥쪽 — 한/글 각주에서 보이지 않는 개체.
fn hidden_in_note(c: &CommonObjAttr) -> bool {
    !matches!(c.vert_rel_to, VertRelTo::Para)
        && !matches!(c.vert_align, VertAlign::Top | VertAlign::Inside)
}

impl LayoutEngine {
    /// 각주 문단 하나의 떠 있는 개체 자리. `note_top_pass` 가 참이면 각주 맨 위에 놓이는
    /// 개체(쪽·종이 기준 위)만, 거짓이면 문단 기준 개체만 돌려준다.
    pub(crate) fn footnote_paragraph_floats(
        &self,
        para: &Paragraph,
        area: &LayoutRect,
        para_top: f64,
        note_top: f64,
        styles: &ResolvedStyleSet,
        note_top_pass: bool,
    ) -> Vec<NoteFloat> {
        let mut out = Vec::new();
        let ps = styles.para_styles.get(para.para_shape_id as usize);
        for (ci, ctrl) in para.controls.iter().enumerate() {
            let Some((c, m)) = float_common(ctrl) else {
                continue;
            };
            if c.treat_as_char || hidden_in_note(c) || anchors_note_top(c) != note_top_pass {
                continue;
            }
            let px = |hu: i32| hwpunit_to_px(hu, self.dpi);
            let (ml, mr, mt, mb) = (px(m[0]), px(m[1]), px(m[2]), px(m[3]));
            let w = px(c.width as i32);
            // 글상자 글이 상자보다 길면 한/글은 넘친 글까지 각주 높이에 넣는다
            // (본문·셀에서도 넘친 글 바닥이 개체 상자 바닥 — 회귀 사례 wrap-TIGHT-RIGHT_ONLY).
            let mut h = px(c.height as i32).max(self.note_textbox_content_height(ctrl, styles));
            // [hwpx-cowork] 2026-11-04 표는 그리는 행 높이 합까지 — 한/글 재저장본은 쪽 끝에서 나뉜 각주 표의
            // `sz` 높이에 첫 조각 높이를 적는다(회귀 B footNote straddle: 칸 15000×2 인데 sz 7138).
            if let Control::Table(t) = ctrl {
                h = h.max(self.note_table_row_bounds(t, styles).last().copied().unwrap_or(0.0));
            }
            let h_off = px(c.horizontal_offset as i32);
            let v_off = px(c.vertical_offset as i32).max(0.0);
            // 문단 기준 가로는 문단 여백 안쪽 상자, 그 밖은 각주 글 상자.
            let (bx, bw) = if matches!(c.horz_rel_to, crate::model::shape::HorzRelTo::Para) {
                let l = ps.map(|s| s.margin_left).unwrap_or(0.0);
                let r = ps.map(|s| s.margin_right).unwrap_or(0.0);
                (area.x + l, (area.width - l - r).max(0.0))
            } else {
                (area.x, area.width)
            };
            let x = match crate::renderer::float_placement::effective_horz_align(c.horz_align) {
                HorzAlign::Left | HorzAlign::Inside => (bx + ml + h_off).max(bx),
                HorzAlign::Center => bx + (bw - w) / 2.0 + h_off,
                HorzAlign::Right | HorzAlign::Outside => bx + bw - w - mr - h_off,
            };
            // [hwpx-cowork] 2026-11-04 그림·도형의 위·아래 캡션도 각주 안 개체 자리에 들어간다 — 한/글 2022 실측(개체
            // 변수 검정 그림 `footNote: caption BOTTOM`: 각주 영역이 캡션 줄 + 간격만큼 커져 그림이 1830HU 위로).
            let caption = match ctrl {
                Control::Picture(p) => p.caption.clone(),
                Control::Shape(s) => crate::renderer::composer::shape_caption_for_layout(s),
                _ => None,
            };
            let caption_extent = caption.as_ref().map_or(0.0, |cap| {
                let ch = crate::renderer::composer::caption_height_px(&caption, self.dpi);
                if ch > 0.0 { ch + px(cap.spacing as i32) } else { 0.0 }
            });
            let (cap_top, cap_bottom) = match caption.as_ref().map(|c| c.direction) {
                Some(crate::model::shape::CaptionDirection::Top) => (caption_extent, 0.0),
                Some(crate::model::shape::CaptionDirection::Bottom) => (0.0, caption_extent),
                _ => (0.0, 0.0),
            };
            let top = if note_top_pass { note_top } else { para_top };
            let y = top + v_off + mt + cap_top;
            let pushes = match c.text_wrap {
                TextWrap::TopAndBottom => true,
                TextWrap::BehindText | TextWrap::InFrontOfText => false,
                TextWrap::Square | TextWrap::Tight | TextWrap::Through => {
                    let left = (x - ml - area.x).max(0.0);
                    let right = (area.x + area.width - (x + w + mr)).max(0.0);
                    let room = match c.text_flow {
                        TextFlow::BothSides => left.max(right),
                        TextFlow::LeftOnly => left,
                        TextFlow::RightOnly => right,
                        TextFlow::LargestOnly => left.max(right),
                    };
                    room < 1.0
                }
            };
            out.push(NoteFloat {
                ctrl_idx: ci,
                x,
                y,
                w,
                h,
                band: pushes.then_some((y - mt - cap_top, y + h + cap_bottom + mb)),
                bottom: y + h + cap_bottom + mb,
                cut: None,
            });
        }
        out
    }

    /// [hwpx-cowork] 2026-11-04 표의 행 경계(px, 0 부터 누적, 길이 = 행 수 + 1) — `layout_table` 이 그리는 행 높이.
    pub(crate) fn note_table_row_bounds(
        &self,
        t: &crate::model::table::Table,
        styles: &ResolvedStyleSet,
    ) -> Vec<f64> {
        // [hwpx-cowork] 2026-11-04 `layout_table` 이 측정기 행 높이로 그리므로 같은 측정을 넘긴다(각주 안 표 뒤
        // 글이 대체 셈 높이(안 여백 축소)로 놓여 표와 겹쳤다).
        let mt = self.measure_table_for_layout(t, styles, 0);
        let rows = self.resolve_row_heights(
            t,
            t.col_count as usize,
            t.row_count as usize,
            Some(&mt),
            styles,
            false,
        );
        let cs = hwpunit_to_px(t.cell_spacing as i32, self.dpi);
        let mut bounds = vec![0.0];
        for (i, h) in rows.iter().enumerate() {
            let prev = *bounds.last().unwrap();
            bounds.push(prev + h + if i > 0 { cs } else { 0.0 });
        }
        bounds
    }

    /// [hwpx-cowork] 2026-11-04 각주 안 표를 위에서 `avail` px 안에 들게 자를 자리 — (앞 조각 높이, 뒤 조각이
    /// 시작하는 표 안 높이). 나눌 수 없으면 None(표는 통째로 다음 쪽 각주 맨 위 — 종전 규칙).
    ///
    /// 한/글 2022 시험지(`scratch/fn-table/probe1`, 각주 채움 25줄 뒤 2×2 표, 0쪽 남은 자리 103px):
    /// - 나누지 않음(NONE) → 통째로 다음 쪽.
    /// - 나눔(TABLE, 행 경계) → 행 경계에서만. 첫 행(200px)이 안 들어가면 통째로 다음 쪽, 4행(100px)이면 첫 행만 0쪽.
    /// - 셀 단위로 나눔(CELL) → 행 가운데서도. 칸 글이 다 들어가는 행은 남은 자리 끝에서 자르고(빈 띠는 어디서나,
    ///   0쪽 103px·1쪽 97px+200px), 글이 넘치면 줄 경계에서 자르며(앞 조각 = 위 안 여백 + 들어간 줄 + 아래 안
    ///   여백, 뒤 조각은 다음 줄부터), 한 줄도 안 들어가면 그 행 위 경계에서 자른다(4행: 103px 자리에 100px).
    pub(crate) fn note_table_cut(
        &self,
        t: &crate::model::table::Table,
        styles: &ResolvedStyleSet,
        avail: f64,
    ) -> Option<(f64, f64)> {
        use crate::model::table::TablePageBreak;
        if matches!(t.page_break, TablePageBreak::None) || t.common.treat_as_char {
            return None;
        }
        let bounds = self.note_table_row_bounds(t, styles);
        let total = *bounds.last()?;
        if avail <= 0.0 || avail >= total {
            return None;
        }
        let r = (0..bounds.len() - 1).rfind(|&r| bounds[r] <= avail)?;
        let row_top = bounds[r];
        let at_row_top = (r > 0).then_some((row_top, row_top));
        // 모델 이름 주의: HWPX "TABLE"(HWP 1) = `CellBreak` 가 행 경계에서만, HWPX "CELL"(HWP 2) = `RowBreak` 가
        // 행 가운데서도 나눈다(`parser/hwpx/section.rs`, vendor/README 회귀 수정 절 '표 pageBreak').
        if matches!(t.page_break, TablePageBreak::CellBreak) {
            return at_row_top;
        }
        // 칸 안에 개체(표·그림·도형·수식)가 있는 행은 줄 단위로 자르지 않고 그 행 위 경계에서 자른다 — 한/글 2022
        // 회귀 B·W footNote wrapper straddle(1×1 겉표 칸 안 표, CELL): 겉표를 자르지 않고 통째로 다음 쪽 각주(1:613-1005).
        let has_object = t.cells.iter().filter(|c| c.row as usize == r).any(|c| {
            c.paragraphs.iter().any(|p| {
                p.controls.iter().any(|ctrl| {
                    matches!(
                        ctrl,
                        Control::Table(_) | Control::Picture(_) | Control::Shape(_) | Control::Equation(_)
                    )
                })
            })
        });
        if has_object {
            return at_row_top;
        }
        let within = avail - row_top;
        let measured = crate::renderer::height_measurer::HeightMeasurer::new(self.dpi)
            .measure_table(t, 0, 0, styles);
        // 이 행에서 시작하는 칸 중 글(안 여백 포함)이 가장 긴 칸이 자르는 자리를 정한다.
        let reference = measured
            .cells
            .iter()
            .filter(|c| c.row == r && c.row_span == 1)
            .max_by(|a, b| {
                let need = |c: &crate::renderer::height_measurer::MeasuredCell| {
                    c.padding_top + c.total_content_height + c.padding_bottom
                };
                need(a).total_cmp(&need(b))
            });
        let Some(cell) = reference else {
            return at_row_top;
        };
        if cell.padding_top + cell.total_content_height + cell.padding_bottom <= within {
            return Some((avail, avail));
        }
        // 줄 경계: line_heights 는 마지막 줄 말고는 줄 간격을 포함한다. 앞 조각 끝 줄의 줄 간격은 저장 줄에서 뺀다.
        let model_cell = t
            .cells
            .iter()
            .find(|c| c.row as usize == cell.row && c.col as usize == cell.col);
        let spacings: Vec<f64> = model_cell
            .map(|c| {
                c.paragraphs
                    .iter()
                    .flat_map(|p| p.line_segs.iter())
                    .map(|l| hwpunit_to_px(l.line_spacing, self.dpi))
                    .collect()
            })
            .unwrap_or_default();
        let mut used = 0.0;
        let mut best: Option<(f64, f64)> = None;
        for (n, lh) in cell.line_heights.iter().enumerate() {
            let last = n + 1 == cell.line_heights.len();
            let trail = if last {
                0.0
            } else if spacings.len() == cell.line_heights.len() {
                spacings[n]
            } else {
                0.0
            };
            let head = cell.padding_top + used + lh - trail + cell.padding_bottom;
            if head > within + 0.01 {
                break;
            }
            used += lh;
            best = Some((row_top + head, row_top + used));
        }
        best.or(at_row_top)
    }

    /// [hwpx-cowork] 2026-11-04 각주 문단 개체 자리 + 쪽 경계에서 자른 표(`cut` = 조각의 표 자르기).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn footnote_paragraph_floats_cut(
        &self,
        para: &Paragraph,
        area: &LayoutRect,
        para_top: f64,
        note_top: f64,
        styles: &ResolvedStyleSet,
        cut: Option<crate::renderer::pagination::FootnoteFloatCut>,
    ) -> Vec<NoteFloat> {
        let mut out = self.footnote_paragraph_floats(para, area, para_top, note_top, styles, false);
        let Some(cut) = cut else {
            return out;
        };
        let px = |hu: i32| hwpunit_to_px(hu, self.dpi);
        for f in out.iter_mut().filter(|f| f.ctrl_idx == cut.control_index) {
            let Some(ctrl @ Control::Table(t)) = para.controls.get(f.ctrl_idx) else {
                continue;
            };
            let Some((_, m)) = float_common(ctrl) else {
                continue;
            };
            let (mt, mb) = (px(m[2]), px(m[3]));
            let full = f.h;
            let offset = px(cut.offset_hu).clamp(0.0, full);
            let pushes = f.band.is_some();
            if !cut.tail {
                f.h = offset;
                f.cut = Some(NoteTableCut {
                    origin_y: f.y,
                    clip_top: f.y,
                    clip_bottom: f.y + offset,
                    header_h: 0.0,
                });
            } else {
                // 뒤 조각: 각주 맨 위(문단 위) + 바깥 위 여백, 세로 오프셋 없음.
                let y = para_top + mt;
                let bounds = self.note_table_row_bounds(t, styles);
                let header_rows = t.leading_header_rows().len();
                let header_h = if t.repeat_header
                    && header_rows > 0
                    && header_rows < bounds.len()
                    && offset >= bounds[header_rows] - 0.01
                {
                    bounds[header_rows]
                } else {
                    0.0
                };
                f.y = y;
                f.h = header_h + full - offset;
                f.cut = Some(NoteTableCut {
                    origin_y: y + header_h - offset,
                    clip_top: y + header_h,
                    clip_bottom: y + f.h,
                    header_h,
                });
            }
            f.bottom = f.y + f.h + mb;
            f.band = pushes.then_some((f.y - mt, f.bottom));
        }
        out
    }

    /// 글상자 글 높이(안 여백 포함, px). 글상자가 없으면 0.
    fn note_textbox_content_height(&self, ctrl: &Control, styles: &ResolvedStyleSet) -> f64 {
        let Control::Shape(shape) = ctrl else {
            return 0.0;
        };
        let Some(tb) = shape.as_ref().drawing().and_then(|d| d.text_box.as_ref()) else {
            return 0.0;
        };
        if tb.paragraphs.is_empty() {
            return 0.0;
        }
        // 저장 줄이 없는 글상자 문단(생성본)은 글상자 안 폭으로 다시 조판해 잰다.
        let inner_w = (hwpunit_to_px(shape.as_ref().common().width as i32, self.dpi)
            - hwpunit_to_px(tb.margin_left as i32, self.dpi)
            - hwpunit_to_px(tb.margin_right as i32, self.dpi))
        .max(0.0);
        let composed_all: Vec<_> = tb
            .paragraphs
            .iter()
            .map(|p| {
                if p.line_segs.is_empty() && !p.text.is_empty() && inner_w > 0.0 {
                    let mut owned = p.clone();
                    crate::renderer::composer::reflow_line_segs(
                        &mut owned,
                        crate::renderer::composer::ParagraphBox::content_width_px(inner_w, self.dpi),
                        styles,
                        self.dpi,
                    );
                    crate::renderer::composer::compose_paragraph_in_context(&owned, styles)
                } else {
                    crate::renderer::composer::compose_paragraph_in_context(p, styles)
                }
            })
            .collect();
        let total_lines: usize = composed_all.iter().map(|c| c.lines.len().max(1)).sum();
        let mut h = 0.0;
        let mut idx = 0usize;
        for composed in &composed_all {
            if composed.lines.is_empty() {
                h += hwpunit_to_px(400, self.dpi);
                idx += 1;
                continue;
            }
            for line in &composed.lines {
                h += hwpunit_to_px(line.line_height, self.dpi);
                idx += 1;
                if idx < total_lines {
                    h += hwpunit_to_px(line.line_spacing, self.dpi);
                }
            }
        }
        h + hwpunit_to_px(tb.margin_top as i32, self.dpi)
            + hwpunit_to_px(tb.margin_bottom as i32, self.dpi)
    }

    /// 줄 [y, y+line_h) 가 띠와 겹치면 띠 아래로 민다(밀린 뒤 다른 띠와 다시 겹치면 거듭).
    pub(crate) fn push_below_note_bands(y: f64, line_h: f64, bands: &[(f64, f64)]) -> f64 {
        let mut y = y;
        for _ in 0..bands.len().max(1) * 2 {
            let mut moved = false;
            for &(top, bottom) in bands {
                if y < bottom - 0.01 && y + line_h.max(0.01) > top + 0.01 {
                    y = bottom;
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        y
    }

    /// 떠 있는 각주 개체를 그린다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn render_footnote_float(
        &self,
        tree: &mut PageLayoutContext,
        fn_node: &mut RenderNode,
        para: &Paragraph,
        float: &NoteFloat,
        area: &LayoutRect,
        styles: &ResolvedStyleSet,
        bin_data_content: &[BinDataContent],
        marker_section: usize,
        marker_para: usize,
    ) {
        let Some(ctrl) = para.controls.get(float.ctrl_idx) else {
            return;
        };
        // [hwpx-cowork] 2026-11-04 잘린 표: 표 전체를 원점에 그려 보이는 띠만 남기고, 뒤 조각이면 제목 줄을 맨 위에 다시 그린다.
        if let Some(cut) = &float.cut {
            let mut draw = |origin_y: f64, top: f64, bottom: f64| {
                let start = fn_node.children.len();
                self.render_footnote_object_at(
                    tree,
                    fn_node,
                    ctrl,
                    float.ctrl_idx,
                    float.x,
                    origin_y,
                    float.w,
                    float.h,
                    area,
                    styles,
                    bin_data_content,
                    marker_section,
                    marker_para,
                );
                for node in &mut fn_node.children[start..] {
                    clip_node_vertically(node, top, bottom);
                }
            };
            draw(cut.origin_y, cut.clip_top, cut.clip_bottom);
            if cut.header_h > 0.0 {
                draw(float.y, float.y, float.y + cut.header_h);
            }
            return;
        }
        self.render_footnote_object_at(
            tree,
            fn_node,
            ctrl,
            float.ctrl_idx,
            float.x,
            float.y,
            float.w,
            float.h,
            area,
            styles,
            bin_data_content,
            marker_section,
            marker_para,
        );
    }

    /// 글자처럼 취급한 도형은 줄 조판이 자리만 등록하므로 그 자리에 그린다.
    /// (글자처럼 그림·수식·표는 `layout_composed_paragraph_in_frame` 이 직접 그린다.)
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn render_footnote_inline_shapes(
        &self,
        tree: &mut PageLayoutContext,
        fn_node: &mut RenderNode,
        para: &Paragraph,
        area: &LayoutRect,
        styles: &ResolvedStyleSet,
        bin_data_content: &[BinDataContent],
        marker_section: usize,
        marker_para: usize,
        // 문단 첫 줄 위(px) — 줄 조판이 그리지 못한 글자처럼 개체(글 없는 빈 문단의 표 등)의 자리.
        line_top: f64,
    ) {
        let ps = styles.para_styles.get(para.para_shape_id as usize);
        let mut pen_x = area.x + ps.map(|s| s.margin_left).unwrap_or(0.0);
        for (ci, ctrl) in para.controls.iter().enumerate() {
            let Some((c, m)) = float_common(ctrl) else {
                continue;
            };
            if !c.treat_as_char {
                continue;
            }
            let w = hwpunit_to_px(c.width as i32, self.dpi);
            let h = hwpunit_to_px(c.height as i32, self.dpi);
            let ml = hwpunit_to_px(m[0], self.dpi);
            let mr = hwpunit_to_px(m[1], self.dpi);
            let mt = hwpunit_to_px(m[2], self.dpi);
            let registered = tree.get_inline_shape_position(marker_section, marker_para, ci, None);
            let (x, y) = match (registered, ctrl) {
                // 도형은 자리만 등록돼 있으므로 그 자리에 그린다.
                (Some(pos), Control::Shape(_)) => pos,
                // 그림·표·수식은 줄 조판이 이미 그렸다.
                (Some(_), _) => {
                    pen_x += ml + w + mr;
                    continue;
                }
                // 줄 조판이 그리지 않은 글자처럼 개체 — 줄 위 왼쪽부터 차례로 놓는다.
                (None, _) => (pen_x + ml, line_top + mt),
            };
            pen_x += ml + w + mr;
            self.render_footnote_object_at(
                tree,
                fn_node,
                ctrl,
                ci,
                x,
                y,
                w,
                h,
                area,
                styles,
                bin_data_content,
                marker_section,
                marker_para,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_footnote_object_at(
        &self,
        tree: &mut PageLayoutContext,
        fn_node: &mut RenderNode,
        ctrl: &Control,
        ci: usize,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        area: &LayoutRect,
        styles: &ResolvedStyleSet,
        bin_data_content: &[BinDataContent],
        marker_section: usize,
        marker_para: usize,
    ) {
        match ctrl {
            Control::Table(t) => {
                // 본문 표 경로로 그린다(칸 안 표·셀 그림까지). 원점은 위에서 정한 자리.
                // 1×1 겉표는 `layout_table` 이 벗기고 속 표를 그릇 기준으로 놓으므로 그릇도
                // 겉표 자리로 준다.
                let own_area = LayoutRect {
                    x,
                    y,
                    width: w,
                    height: area.height,
                };
                // 쪽·종이 기준 겉표는 벗길 때 쪽 원점으로 세로를 다시 셈하므로(본문 결재란용),
                // 각주에서 이미 정한 자리를 쓰도록 문단 기준 사본으로 그린다.
                let para_relative;
                let table: &crate::model::table::Table = if matches!(
                    t.common.vert_rel_to,
                    crate::model::shape::VertRelTo::Para
                ) {
                    t.as_ref()
                } else {
                    let mut copy = t.as_ref().clone();
                    copy.common.vert_rel_to = crate::model::shape::VertRelTo::Para;
                    copy.common.vert_align = VertAlign::Top;
                    copy.common.vertical_offset = 0;
                    para_relative = copy;
                    &para_relative
                };
                self.layout_table(
                    tree,
                    fn_node,
                    table,
                    marker_section,
                    styles,
                    0,
                    &own_area,
                    y,
                    bin_data_content,
                    None,
                    0,
                    Some((marker_para, ci)),
                    Alignment::Left,
                    None,
                    0.0,
                    0.0,
                    None,
                    None,
                    None,
                    None,
                    false,
                    false,
                    0.0,
                    Some((Some(x), y)),
                    super::table_layout::TableCharBorder::default(),
                );
            }
            Control::Picture(pic) => {
                // 자리를 이미 정했으므로 그 상자를 그릇으로 주고 오프셋·정렬은 지운다.
                let mut placed = pic.as_ref().clone();
                placed.common.horizontal_offset = 0;
                placed.common.vertical_offset = 0;
                placed.common.horz_align = HorzAlign::Left;
                placed.common.vert_align = VertAlign::Top;
                let container = LayoutRect {
                    x,
                    y,
                    width: w,
                    height: h,
                };
                self.layout_picture(
                    tree,
                    fn_node,
                    &placed,
                    &container,
                    bin_data_content,
                    Alignment::Left,
                    Some(marker_section),
                    Some(marker_para),
                    Some(ci),
                    None,
                    styles,
                );
            }
            Control::Shape(shape) => {
                let empty_map = std::collections::HashMap::new();
                self.layout_shape_object(
                    tree,
                    fn_node,
                    shape.as_ref(),
                    x,
                    y,
                    w,
                    h,
                    marker_section,
                    marker_para,
                    ci,
                    styles,
                    bin_data_content,
                    &empty_map,
                    &[],
                    None,
                    false,
                );
            }
            Control::Equation(eq) => {
                let tokens = crate::renderer::equation::tokenizer::tokenize(&eq.script);
                let ast = crate::renderer::equation::parser::EqParser::new(tokens).parse();
                let font_size_px = hwpunit_to_px(eq.font_size as i32, self.dpi);
                let layout_box =
                    crate::renderer::equation::layout::EqLayout::for_equation(eq, self.dpi)
                        .layout(&ast);
                let color_str = crate::renderer::equation::svg_render::eq_color_to_svg(eq.color);
                let svg_content = crate::renderer::equation::svg_render::render_equation_svg(
                    &layout_box,
                    &color_str,
                    font_size_px,
                );
                let eq_node = RenderNode::new(
                    tree.next_id(),
                    RenderNodeType::Equation(EquationNode {
                        svg_content,
                        layout_box,
                        color_str,
                        color: eq.color,
                        script: eq.script.clone(),
                        font_size: font_size_px,
                        section_index: Some(marker_section),
                        para_index: Some(marker_para),
                        control_index: Some(ci),
                        cell_index: None,
                        cell_para_index: None,
                        note_ref: None,
                    }),
                    BoundingBox::new(x, y, w, h),
                );
                fn_node.children.push(eq_node);
            }
            _ => {}
        }
    }
}
