//! Versioned missing-glyph selection shared by measurement and cache admission.
//! The 2024 PNG line-fit probe for Batang U+2024 agrees with HCR Batang's
//! registered advance. Batang itself has no such glyph; the older Haansoft
//! fallback is narrower. Existing glyphs and the default (2022) policy retain
//! their current metrics. No document font/style is rewritten.

use crate::model::paragraph::Paragraph;
use super::{local_font_width::find_local_face, style_resolver::ResolvedStyleSet};

/// [hwpx-cowork] Retained for legacy callers without a scalar. New scalar
/// decisions use the language slot and cmap via hancom_fontdb::select_glyph.
pub(crate) fn fallback_families(family: &str) -> Vec<&'static str> {
    super::hancom_fontdb::fallback_candidates(family, 5)
}

pub(crate) fn default_fallback_em(family: &str, c: char) -> Option<f64> {
    fallback_families(family).iter().find_map(|name| {
        find_local_face(name).and_then(|face| face.advance_em(c))
    })
}

/// [hwpx-cowork] Exact additional faces needed by a byte-backed paint backend.
/// Unknown coverage is not evidence of absence; do not invent a substitution.
pub(crate) fn required_fallback_families(style: &super::TextStyle, text: &str) -> Vec<&'static str> {
    // [hwpx-cowork] An absent primary can still resolve to a document-supplied
    // SFNT substitute. Byte-backed paint must receive that same selected face.
    let face = find_local_face(&style.font_family);
    let mut result = Vec::new();
    for c in text.chars().filter(|c| !c.is_control() && !c.is_whitespace()) {
        // [hwpx-cowork] Supply the exact physical faces chosen by FontDB to
        // byte-backed backends; regular coverage alone cannot prove Bold coverage.
        if let Some(family) = paint_override(style, &c.to_string()) {
            if !result.contains(&family) { result.push(family); }
            continue;
        }
        let Some(face) = face else { continue; };
        if face.advance_em(c).is_some() { continue; }
        let fallback = if fallback_em(&style.font_family, c, style.hangul2024_missing_glyphs).is_some() {
            Some("HCR Batang")
        } else {
            fallback_families(&style.font_family).iter().copied().find(|name| {
                find_local_face(name).is_some_and(|f| f.advance_em(c).is_some())
            })
        };
        if let Some(family) = fallback {
            if !result.contains(&family) { result.push(family); }
        }
    }
    result
}

/// [hwpx-cowork] Bind a known absent scalar to the same physical face as measurement.
/// SVG rasterizers need an explicit face: some do not follow the supplied family
/// list for per-character fallback. Existing glyphs and unknown fonts stay intact.
pub(crate) fn paint_override(style: &super::TextStyle, cluster: &str) -> Option<&'static str> {
    let mut chars = cluster.chars();
    let c = chars.next()?;
    if chars.next().is_some() || style.metric_font_family.is_some() {
        return None;
    }
    if c.is_whitespace() || c.is_control() { return None; }
    // [hwpx-cowork] The version flag changes Batang's missing dot only; native
    // HFT style programs and the explicit related-design mapping stay intact.
    if style.font_metric_trusted && (!style.hangul2024_missing_glyphs
        || super::hft_ttf::uses_extracted_policy(&style.font_family)) {
        // [hwpx-cowork] 2026-11-06: a glyph the requested family owns keeps the
        // document's face name. Renaming every glyph to the physical full name
        // ('KoPubWorld돋움체 Light' → 'KoPubWorldDotum Light', '맑은 고딕' →
        // 'Malgun Gothic') bypassed the web font supply, which prepares the
        // document names, and the editor drew Noto Sans/Serif KR instead.
        return super::hancom_fontdb::select_glyph(&style.font_family, c, style.bold, style.italic,
            super::hancom_fontdb::glyph_lang(c))
            .filter(|s| !s.requested_family)
            .map(|s| s.paint_family);
    }
    let face = find_local_face(&style.font_family)?;
    if face.advance_em(c).is_some() { return None; }
    if fallback_em(&style.font_family, c, style.hangul2024_missing_glyphs).is_some() {
        return Some("HCR Batang");
    }
    fallback_families(&style.font_family).iter().copied().find(|name| {
        find_local_face(name).is_some_and(|f| f.advance_em(c).is_some())
    })
}

pub(crate) fn fallback_em(family: &str, c: char, enabled: bool) -> Option<f64> {
    if !enabled || c != '\u{2024}' {
        return None;
    }
    let face = find_local_face(family)?;
    if face.advance_em(c).is_some() || !std::ptr::eq(face, find_local_face("Batang")?) {
        return None;
    }
    find_local_face("HCR Batang")?.advance_em(c)
}

/// A saved body partition made with the older missing-glyph advance cannot be
/// reused under the 2024 policy. Rebuild only the render projection; source
/// lines and serialized font declarations remain available for save/mode exit.
pub(crate) fn body_partition_needs_reflow(para: &Paragraph, styles: &ResolvedStyleSet) -> bool {
    if !styles.hangul2024_missing_glyphs || !para.controls.is_empty()
        || !para.text.contains('\u{2024}')
    {
        return false;
    }
    let mut carry = 0;
    for (index, c) in para.text.chars().enumerate() {
        let Some(cs) = styles.char_styles.get(para.char_shape_id_at(index).unwrap_or(0) as usize) else {
            continue;
        };
        let lang = super::composer::char_lang_slot(c, &mut carry, cs.ascii_punct_latin_slot);
        let family = cs.metric_face_for_lang(lang).unwrap_or_else(|| cs.font_family_for_lang(lang));
        if fallback_em(family, c, true).is_some() {
            return true;
        }
    }
    false
}

/// Refresh horizontal partitions without discarding a still-valid vertical
/// frame. A different glyph advance need not change line count or line boxes;
/// in that case downstream stored page origins remain valid. Returns true only
/// when the shared section reflow must repair the vertical suffix as well.
pub(crate) fn refresh_body_partition(
    para: &mut Paragraph,
    styles: &ResolvedStyleSet,
    column_width_px: f64,
    dpi: f64,
) -> bool {
    let mut fresh = para.clone();
    fresh.line_segs.clear();
    super::composer::reflow_line_segs_in_stored_section(
        &mut fresh,
        super::composer::ParagraphBox::body_for_style(
            column_width_px, styles.para_styles.get(para.para_shape_id as usize), dpi,
        ),
        styles,
        dpi,
    );
    let same_frame = !para.line_segs.is_empty()
        && para.line_segs.len() == fresh.line_segs.len()
        && para.line_segs.iter().zip(&fresh.line_segs).all(|(old, new)| {
            old.line_height == new.line_height && old.text_height == new.text_height
                && old.baseline_distance == new.baseline_distance && old.line_spacing == new.line_spacing
                && old.column_start == new.column_start && old.segment_width == new.segment_width
        });
    if same_frame {
        for (old, new) in para.line_segs.iter().zip(&mut fresh.line_segs) {
            new.vertical_pos = old.vertical_pos;
            new.tag = old.tag;
        }
        *para = fresh;
        false
    } else {
        para.line_segs.clear();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hangul2024_missing_glyph_policy_requires_an_absent_batang_dot() {
        let expected = find_local_face("HCR Batang").unwrap().advance_em('\u{2024}');
        assert!(expected.is_some());
        assert_eq!(fallback_em("바탕", '\u{2024}', true), expected);
        assert_eq!(fallback_em("Batang", '\u{2024}', false), None);
        for (font, c) in [("HCR Batang", '\u{2024}'), ("Haansoft Batang", '\u{2024}'),
            ("바탕", '.'), ("바탕", '\u{00b7}'), ("바탕체", '\u{2024}'),
            ("KoPubWorld돋움체", '\u{2024}'), ("unknown face", '\u{2024}')]
        {
            assert_eq!(fallback_em(font, c, true), None, "{font}: {c}");
        }
    }

    /// [hwpx-cowork] 2026-11-06 웹 편집기 KoPubWorld 회귀: 요청 글꼴이 가진 글자는
    /// 문서의 글꼴 이름 그대로 그린다(웹 글꼴 공급은 문서 이름으로 준비된다).
    /// 요청 글꼴에 없는 글자만 FontDB 가 고른 물리 글꼴 이름을 쓴다.
    #[test]
    fn paint_keeps_the_document_face_name_for_glyphs_it_owns() {
        let style = |family: &str, bold: bool| super::super::TextStyle {
            font_family: family.to_string(), font_metric_trusted: true, bold, ..Default::default()
        };
        for family in ["KoPubWorld돋움체 Light", "KoPubWorld돋움체 Medium", "KoPubWorld돋움체 Bold",
            "KoPubWorld바탕체 Light", "맑은 고딕", "한컴 고딕", "나눔스퀘어 Bold"]
        {
            for bold in [false, true] {
                for c in ["가", "A", "1"] {
                    assert_eq!(paint_override(&style(family, bold), c), None, "{family} bold={bold} {c}");
                }
            }
        }
        // 요청 글꼴에 없는 글자는 여전히 FontDB 대체 글꼴(물리 이름)로 그린다.
        // [hwpx-cowork] 2026-11-06 user-selected U+2024 default policy.
        assert_eq!(paint_override(&style("Arial", false), "\u{2024}"), Some("HCR Batang"));
        assert_eq!(paint_override(&style("한컴 고딕", true), "\u{2024}"), Some("HCR Dotum Bold"));
    }
}
