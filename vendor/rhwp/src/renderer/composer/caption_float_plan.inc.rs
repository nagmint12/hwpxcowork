/// [hwpx-cowork] 캡션 안 떠 있는(글자처럼 취급 아님) 개체 하나의 배치.
#[derive(Debug, Clone, Copy)]
pub struct CaptionFloat {
    pub para_index: usize,
    pub control_index: usize,
    /// 캡션 위 기준 개체 앵커 문단의 위(px)
    pub anchor_y: f64,
}

/// [hwpx-cowork] 떠 있는 개체가 든 캡션의 흐름 계획(px, 캡션 위 기준).
#[derive(Debug, Clone)]
pub struct CaptionFloatPlan {
    /// 문단마다 첫 줄이 놓이는 위(개체에 밀린 뒤)
    pub para_text_top: Vec<f64>,
    pub floats: Vec<CaptionFloat>,
    /// 글 줄 끝과 모든 떠 있는 개체 바닥 중 큰 값
    pub height: f64,
}

/// [hwpx-cowork] 캡션 안 떠 있는 개체의 크기(px, 바깥 여백 제외).
pub fn caption_float_object_size(ctrl: &Control, dpi: f64) -> Option<(f64, f64)> {
    let common = caption_float_common(ctrl)?;
    let (w, h) = match ctrl {
        Control::Picture(pic) => super::layout::picture_display_size_hu(pic),
        _ => (common.width as i32, common.height as i32),
    };
    Some((hwpunit_to_px(w, dpi), hwpunit_to_px(h, dpi)))
}

/// 캡션 흐름에 참여하는 떠 있는 개체의 공통 속성(표·도형·그림만).
pub fn caption_float_common(ctrl: &Control) -> Option<&crate::model::shape::CommonObjAttr> {
    let common = match ctrl {
        Control::Table(t) => &t.common,
        Control::Shape(s) => s.common(),
        Control::Picture(p) => &p.common,
        Control::Equation(e) => &e.common,
        _ => return None,
    };
    (!common.treat_as_char).then_some(common)
}

/// 글자처럼 취급 표·도형·그림·수식 — 그 줄은 개체 높이 + 줄 간격으로 전진한다.
fn caption_has_tac_object(ctrl: &Control) -> bool {
    match ctrl {
        Control::Table(t) => t.common.treat_as_char,
        Control::Shape(s) => s.common().treat_as_char,
        Control::Picture(p) => p.common.treat_as_char,
        Control::Equation(e) => e.common.treat_as_char,
        _ => false,
    }
}

/// [hwpx-cowork] 캡션을 작은 단처럼 흘린다 — 한/글 2022 실측(조판 회귀 A 캡션, 표 아래 캡션 안
/// 55배치 × 8개체, 생성본·재저장본):
/// - 개체는 앵커 문단 위(세로 문단) 또는 캡션 위(세로 쪽·종이, 높이 0 틀)에 `RegionFloatFrame`
///   규칙으로 놓인다.
/// - 자리차지 개체(어울림·자리 비움·빈틈은 남는 쪽 폭이 없을 때)와 세로로 겹치는 줄은 개체 아래로
///   밀린다(문단 위 + 1980 줄이 개체 위 2000 보다 위면 그 줄은 그대로).
/// - 캡션 높이 = 마지막 줄 끝과 모든 떠 있는 개체(글 뒤·글 앞 포함, 여백 포함) 바닥 중 큰 값.
/// 떠 있는 개체가 없으면 `None`(종전 산식).
pub fn caption_float_plan(caption: &Caption, dpi: f64) -> Option<CaptionFloatPlan> {
    caption_float_plan_in_context(caption, None, dpi)
}

// [hwpx-cowork] Measurement and paint share the same caption float plan and styles.
pub(crate) fn caption_float_plan_in_context(
    caption: &Caption,
    styles: Option<&ResolvedStyleSet>,
    dpi: f64,
) -> Option<CaptionFloatPlan> {
    match caption_float_plan_with_storage(caption, styles, dpi, &crate::storage::Unbounded) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}

pub(crate) fn caption_float_plan_with_storage<S: crate::storage::Storage>(
    caption: &Caption,
    styles: Option<&ResolvedStyleSet>,
    dpi: f64,
    storage: &S,
) -> Result<Option<CaptionFloatPlan>, S::Error> {
    use crate::model::shape::{TextFlow, TextWrap};
    // 글자처럼 개체만 든 캡션도 이 흐름을 쓴다 — 종전 산식은 문단마다 마지막 줄 간격을 빼고
    // 저장(합성) vpos 최댓값을 써서, 개체 줄 뒤 줄 간격(880)이 빠졌다(한/글 19670 ↔ 18790).
    if !caption.paragraphs.iter().any(|p| {
        p.controls
            .iter()
            .any(|c| caption_float_common(c).is_some() || caption_has_tac_object(c))
    }) {
        return Ok(None);
    }
    let frame_w = hwpunit_to_px(caption.width.max(caption.max_width) as i32, dpi);
    // 저장 줄(재저장본)이 있으면 그 줄 높이·간격, 없으면 조합 줄.
    // 저장 줄의 vpos 는 한/글이 개체에 밀어 둔 자리라 아래 한계로 쓴다(글상자처럼 개체가 내용에
    // 맞춰 커진 높이를 이 계산은 모른다 — 재저장본 vpos 가 그 높이를 싣는다).
    let lines_of = |para: &Paragraph| -> Result<Vec<(Option<f64>, f64, f64)>, S::Error> {
        if !para.line_segs.is_empty() {
            storage.collect(para.line_segs.iter().map(|line| (
                Some(hwpunit_to_px(line.vertical_pos, dpi)),
                hwpunit_to_px(line.line_height, dpi),
                hwpunit_to_px(line.line_spacing, dpi),
            )))
        } else {
            let composed = try_compose_paragraph_scoped(
                para, styles.is_some_and(|s| s.supplemental_metrics.is_some()), styles, storage,
            )?;
            if composed.lines.is_empty() {
                let own_font_size = styles.and_then(|styles| {
                    let id = para.char_shape_id_at(0)
                        .or_else(|| para.char_shapes.first().map(|shape| shape.char_shape_id))?;
                    styles.char_styles.get(id as usize)
                }).map(|style| style.font_size).filter(|size| *size > 0.0);
                storage.collect(std::iter::once((
                    None, own_font_size.unwrap_or_else(|| hwpunit_to_px(400, dpi)), 0.0,
                )))
            } else {
                storage.collect(composed.lines.iter().map(|line| (
                    None, hwpunit_to_px(line.line_height, dpi), hwpunit_to_px(line.line_spacing, dpi),
                )))
            }
        }
    };
    // 글만 있는 문단 첫 줄의 줄 간격/줄 높이(글자처럼 개체 줄 간격 비례에 쓴다).
    let mut text_ratio = None;
    for para in &caption.paragraphs {
        if !para.controls.iter().any(|c| caption_has_tac_object(c) || caption_float_common(c).is_some()) {
            if let Some((_, height, spacing)) = lines_of(para)?.first().copied().filter(|(_, h, _)| *h > 0.0) {
                text_ratio = Some(spacing / height);
                break;
            }
        }
    }
    let mut obstacles: Vec<(f64, f64, bool)> = storage.vec(0)?;
    let mut plan = CaptionFloatPlan {
        para_text_top: storage.vec(caption.paragraphs.len())?,
        floats: storage.vec(0)?,
        height: 0.0,
    };
    let zero = super::page_layout::LayoutRect {
        x: 0.0,
        y: 0.0,
        width: frame_w,
        height: 0.0,
    };
    let mut y = 0.0f64;
    let mut text_bottom = 0.0f64;
    for (pi, para) in caption.paragraphs.iter().enumerate() {
        let anchor_y = y;
        let region = super::float_placement::RegionFloatFrame {
            horz: zero,
            page: zero,
            paper: zero,
            para_y: anchor_y,
            dpi,
        };
        for (ci, ctrl) in para.controls.iter().enumerate() {
            let (Some(common), Some((w, h))) =
                (caption_float_common(ctrl), caption_float_object_size(ctrl, dpi))
            else {
                continue;
            };
            storage.push(&mut plan.floats, CaptionFloat {
                para_index: pi,
                control_index: ci,
                anchor_y,
            })?;
            let m = &common.margin;
            let (ml, mr) = (
                hwpunit_to_px(i32::from(m.left), dpi),
                hwpunit_to_px(i32::from(m.right), dpi),
            );
            let (mt, mb) = (
                hwpunit_to_px(i32::from(m.top), dpi),
                hwpunit_to_px(i32::from(m.bottom), dpi),
            );
            let (ix, iy) = region.ink_origin(common, w, h);
            let (bx0, bx1) = (ix - ml, ix + w + mr);
            let (by0, by1) = (iy - mt, iy + h + mb);
            let within = frame_w <= 0.0 || (bx0 < frame_w && bx1 > 0.0);
            let left_room = bx0.max(0.0);
            let right_room = (frame_w - bx1).max(0.0);
            let pushes = within
                && match common.text_wrap {
                    TextWrap::TopAndBottom => true,
                    TextWrap::Square | TextWrap::Tight | TextWrap::Through => {
                        let room = match common.text_flow {
                            TextFlow::LeftOnly => left_room,
                            TextFlow::RightOnly => right_room,
                            TextFlow::BothSides | TextFlow::LargestOnly => {
                                left_room.max(right_room)
                            }
                        };
                        room < hwpunit_to_px(1000, dpi)
                    }
                    _ => false,
                };
            storage.push(&mut obstacles, (by0, by1, pushes))?;
        }
        let mut first_top = None;
        // [hwpx-cowork] 합성 줄(엔진 재조판)·조합 줄은 글자처럼 개체 줄을 개체 높이로 맞춘다 —
        // 합성 줄은 글상자 자동 늘림 전에 만들어져 늘어난 높이(7606)를 모르고, 줄 간격에 영향
        // (affectLSpacing) 개체는 한/글이 줄 간격도 줄 높이에 비례시킨다(글 1100/880 → 개체 6000/4800,
        // 한/글 실측 캡션 inline-line-spacing 23590). 한/글 저장 줄은 그대로 믿는다.
        let authoritative = !para.line_segs.is_empty()
            && !para.line_segs.iter().all(|seg| {
                seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0
                    || seg.is_missing_lineseg_placeholder()
            });
        let mut lines = lines_of(para)?;
        if !authoritative && lines.len() == 1 {
            let tac: Vec<(f64, bool)> = storage.collect(para
                .controls
                .iter()
                .filter(|c| caption_has_tac_object(c))
                .filter_map(|c| {
                    let common = match c {
                        Control::Table(t) => &t.common,
                        Control::Shape(s) => s.common(),
                        Control::Picture(p) => &p.common,
                        Control::Equation(e) => &e.common,
                        _ => return None,
                    };
                    Some((hwpunit_to_px(common.height as i32, dpi), common.affect_line_spacing))
                })
                )?;
            let tac_h = tac.iter().map(|(h, _)| *h).fold(0.0f64, f64::max);
            if tac_h > 0.0 {
                let (top, lh, ls) = lines[0];
                let new_lh = lh.max(tac_h);
                // 줄 간격 비율 = 글 줄의 간격/높이(이 줄의 글 높이가 줄보다 작으면 그것, 아니면 캡션의
                // 글만 있는 문단 줄).
                let own = para
                    .line_segs
                    .first()
                    .map(|s| (hwpunit_to_px(s.text_height, dpi), ls))
                    .filter(|(th, _)| *th > 0.0 && *th + 0.5 < lh)
                    .map(|(th, ls)| ls / th);
                let ratio = own.or(text_ratio);
                let new_ls = match ratio {
                    Some(r) if tac.iter().any(|(_, a)| *a) => r * new_lh,
                    _ => ls,
                };
                lines[0] = (top, new_lh, new_ls);
            }
        }
        for (stored_top, lh, ls) in lines {
            let mut top = stored_top.map_or(y, |t| y.max(t));
            // 밀린 자리에서 다른 개체와 다시 겹칠 수 있으므로 더 밀리지 않을 때까지.
            loop {
                let pushed = obstacles
                    .iter()
                    .filter(|(o0, o1, p)| *p && top < *o1 && top + lh > *o0)
                    .map(|(_, o1, _)| *o1)
                    .fold(top, f64::max);
                if pushed <= top {
                    break;
                }
                top = pushed;
            }
            first_top.get_or_insert(top);
            text_bottom = top + lh;
            y = top + lh + ls;
        }
        storage.push(&mut plan.para_text_top, first_top.unwrap_or(y))?;
    }
    plan.height = obstacles
        .iter()
        .map(|(_, o1, _)| *o1)
        .fold(text_bottom, f64::max)
        .max(0.0);
    Ok(Some(plan))
}

