//! [hwpx-cowork] Newly composed plain text in MS_WORD compatibility mode.

use super::{compute_line_spacing_hwp, find_active_char_shape};
use crate::model::control::Control;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::style::{HeadType, LineSpacingType};
use crate::renderer::font_metrics_word::LOCAL_WORD_FONT_METRICS;
use crate::renderer::local_font_width::find_local_face;
use crate::renderer::style_resolver::{detect_lang_category, ResolvedCharStyle, ResolvedStyleSet};
use crate::renderer::HWPUNIT_PER_INCH;
use std::ops::Range;

#[derive(Default)]
pub(super) struct WordLineMetrics {
    pub height: i32,
    pub baseline: i32,
}

impl WordLineMetrics {
    fn include(
        &mut self,
        style: &ResolvedCharStyle,
        character: Option<char>,
        dpi: f64,
    ) -> Option<()> {
        let lang = character.map_or(0, detect_lang_category);
        if style.superscript || style.subscript || style.font_position_for_lang(lang) != 0 {
            return None;
        }
        let face = find_local_face(style.font_family_for_lang(lang))?;
        if character.is_some_and(|ch| !ch.is_whitespace() && face.advance(ch).is_none()) {
            return None;
        }
        let index = LOCAL_WORD_FONT_METRICS
            .binary_search_by_key(&face.file, |(file, _)| *file)
            .ok()?;
        let (_, (ascent, descent, gap, cjk)) = LOCAL_WORD_FONT_METRICS[index];
        let size = style.font_size_for_lang(lang) * HWPUNIT_PER_INCH / dpi;
        let scale = size / f64::from(face.upm);
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        // 한/글 2022 실측: 라틴 글꼴은 hhea 전진과 위쪽 외부 여백을 쓴다.
        // CJK 글꼴은 Windows 줄 높이에 30%를 위아래 같은 양으로 더한다.
        // 혼합 줄에서는 글꼴별 높이와 기준선의 최댓값을 각각 쓴다.
        let span = f64::from(ascent + descent);
        let (height, baseline) = if cjk {
            (span * 1.30, f64::from(ascent) + span * 0.15)
        } else {
            (span + f64::from(gap), f64::from(ascent + gap))
        };
        self.height = self.height.max((height * scale).round() as i32);
        self.baseline = self.baseline.max((baseline * scale).round() as i32);
        Some(())
    }

    pub(super) fn apply_to(
        &self,
        line: &mut LineSeg,
        spacing_type: LineSpacingType,
        spacing_value: f64,
        dpi: f64,
    ) {
        line.line_height = self.height;
        line.text_height = self.height;
        line.baseline_distance = self.baseline;
        line.line_spacing = compute_line_spacing_hwp(spacing_type, spacing_value, self.height, dpi);
    }
}

pub(super) fn for_row(
    paragraph: &Paragraph,
    styles: &ResolvedStyleSet,
    text: &[char],
    range: Range<usize>,
    includes_end: bool,
    dpi: f64,
) -> Option<WordLineMetrics> {
    if !styles.word_compat_target
        || paragraph.controls.iter().any(|control| {
            !matches!(control, Control::SectionDef(_) | Control::ColumnDef(_))
        })
        || styles.para_styles.get(paragraph.para_shape_id as usize)
            .is_some_and(|style| !matches!(style.head_type, HeadType::None))
    {
        return None;
    }
    let mut metrics = WordLineMetrics::default();
    for (offset, &character) in text.get(range.clone())?.iter().enumerate() {
        let style_id = paragraph.char_shape_id_at(range.start + offset)?;
        let style = styles.char_styles.get(style_id as usize)?;
        metrics.include(style, (!character.is_control()).then_some(character), dpi)?;
    }
    if includes_end || metrics.height == 0 {
        let utf16 = paragraph.char_count.saturating_sub(1);
        let style_id = find_active_char_shape(&paragraph.char_shapes, utf16);
        metrics.include(styles.char_styles.get(style_id as usize)?, None, dpi)?;
    }
    (metrics.height > 0).then_some(metrics)
}
