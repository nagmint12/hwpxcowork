//! 글자처럼 그림이 줄 구성에 제공하는 HWPUNIT 상자 크기.
//!
//! 용지·쪽 상대 비율로 확대된 인쇄 잉크와 줄 상자의 기준선 정렬 크기를 구분한다.
//! 저장 줄과 재조판이 소비하는 동일한 크기를 실제 그림 배치에도 전달한다.

use crate::model::image::Picture;

pub(crate) fn inline_picture_size_hu(picture: &Picture) -> (i32, i32) {
    crate::renderer::stored_picture_metrics::stored_picture_size_hu(picture)
}

/// 글줄이 예약하는 그림 상자는 잉크와 바깥 여백을 함께 포함한다.
/// 독립 한컴 재저장본도 위·아래 여백을 포함한 높이로 LineSeg를 발행한다.
/// 실제 잉크 배치는 기존 원점에서 같은 여백 안쪽을 소비한다.
pub(crate) fn inline_picture_occupied_size_hu(picture: &Picture) -> (i32, i32) {
    let (width, height) = inline_picture_size_hu(picture);
    let margin = &picture.common.margin;
    (
        width
            .saturating_add(i32::from(margin.left))
            .saturating_add(i32::from(margin.right)),
        // [hwpx-cowork] 한/글 저장 LineSeg: 위·아래 캡션도 그림 줄의 점유 높이.
        // 공통 상자에서 한 번만 계상해 프레임·scalar·빈 문단이 같은 높이를 쓴다.
        height.saturating_add(super::line_breaking::picture_flow_extra_height_hu(picture)),
    )
}

/// HWP 5.0 표 44의 세로 정렬점. 줄 구성과 실제 그림 원점이 같은 값을 사용한다.
pub(crate) fn inline_picture_ascent_ratio(vertical_alignment: u8) -> f64 {
    match vertical_alignment {
        1 => 0.0,
        2 => 0.5,
        3 => 1.0,
        _ => 0.85,
    }
}

/// 저장 줄이 없는 혼합 주석 문단도 기존 줄 소속·탭 배치를 유지하며 그림 상자를 공유한다.
pub(super) fn refresh_picture_rows_with_storage<S: crate::storage::Storage>(
    composed: &mut super::ComposedParagraph,
    para: &crate::model::paragraph::Paragraph,
    styles: &crate::renderer::style_resolver::ResolvedStyleSet,
    storage: &S,
) -> Result<(), S::Error> {
    use crate::model::control::Control;
    use crate::renderer::{hwpunit_to_px, px_to_hwpunit, DEFAULT_DPI};
    if !para.line_segs.is_empty() {
        return Ok(());
    }
    let Some(style) = styles.para_styles.get(para.para_shape_id as usize) else {
        return Ok(());
    };
    // shortcut: 비기본 세로 정렬은 저장 줄과 주석 기준선의 별도 계약을 검증한 뒤 연결한다.
    // [hwpx-cowork] 글자처럼 취급한 도형(사각형·글상자·묶음 등)도 그림과 같이 줄 상자를 차지한다.
    // 한/글 2022 재저장 줄: 글상자 안 표 칸 문단의 글자처럼 묶음·사각형·글상자(6000) → 줄 vertsize 6000·
    // baseline 5100, 뒤 문단 6880(조판 회귀 A textboxCell inline 생성본). 저장 줄이 전혀 없어 문서 열기
    // 재조판(본문·본문 표 칸)을 거치지 않는 문단(글상자 안 표 칸 등)에서 도형을 빼면 줄이 글자 높이로 남고,
    // 배치(`inline_shape_top`)가 그 기준선에 상자를 맞춰 줄 위로 57px 올라갔다. 높이는 재조판 줄
    // (`inline_control_size_hwp_with_storage`)과 같은 점유 상자(높이 + 바깥 여백)를 쓴다.
    let shape_without_caption = |shape: &crate::model::shape::ShapeObject| {
        shape.common().treat_as_char
            && super::shape_caption_for_layout(shape).is_none()
    };
    if style.vertical_alignment != 0
        || !para.controls.iter().all(|control| match control {
            Control::Picture(picture) => picture.common.treat_as_char && picture.caption.is_none(),
            Control::Shape(shape) => shape_without_caption(shape),
            Control::Footnote(_) | Control::Endnote(_) => true,
            other => super::control_is_width_neutral_marker(other),
        })
    {
        return Ok(());
    }
    let dpi = styles.resolved_dpi.unwrap_or(DEFAULT_DPI);
    let count = composed.lines.len();
    for index in 0..count {
        let end = composed
            .lines
            .get(index + 1)
            .map_or(para.text.chars().count(), |line| line.char_start);
        let line = &mut composed.lines[index];
        let pictures: Vec<_> = storage.collect(
            composed
                .tac_controls
                .iter()
                .filter(|(position, _, _)| {
                    *position >= line.char_start
                        && (*position < end || (*position == end && index + 1 == count))
                })
                .filter_map(|(_, _, control)| match para.controls.get(*control)? {
                    Control::Picture(picture) => {
                        let margin = &picture.common.margin;
                        Some((
                            inline_picture_size_hu(picture)
                                .1
                                .saturating_add(i32::from(margin.top))
                                .saturating_add(i32::from(margin.bottom)),
                            picture.common.affect_line_spacing,
                        ))
                    }
                    shape @ Control::Shape(s) => Some((
                        super::line_breaking::inline_control_size_hwp_with_storage(
                            shape,
                            &crate::storage::Unbounded,
                        )
                        .ok()
                        .flatten()?
                        .1,
                        s.common().affect_line_spacing,
                    )),
                    _ => None,
                }),
        )?;
        if pictures.is_empty() {
            continue;
        }
        let font = crate::renderer::composed_line_max_font_size(line, para, styles);
        if !font.is_finite() || font <= 0.0 {
            continue;
        }
        let text_height = px_to_hwpunit(font, dpi);
        let mut ascent = (f64::from(text_height) * 0.85).round() as i32;
        let mut descent = text_height - ascent;
        let mut spacing_height = text_height;
        for (height, affect_line_spacing) in pictures {
            let baseline = (f64::from(height)
                * inline_picture_ascent_ratio(style.vertical_alignment))
            .round() as i32;
            ascent = ascent.max(baseline);
            descent = descent.max(height - baseline);
            if affect_line_spacing {
                spacing_height = spacing_height.max(height);
            }
        }
        if matches!(
            style.line_spacing_type,
            crate::model::style::LineSpacingType::Fixed
                | crate::model::style::LineSpacingType::Minimum
        ) {
            spacing_height = ascent + descent;
        }
        let metrics = super::frame_metrics_for_line(
            hwpunit_to_px(spacing_height, dpi),
            font,
            style.line_spacing_type,
            style.line_spacing,
            dpi,
        );
        line.line_height = ascent + descent;
        line.baseline_distance = ascent;
        line.line_spacing = metrics.line_spacing;
    }
    Ok(())
}
