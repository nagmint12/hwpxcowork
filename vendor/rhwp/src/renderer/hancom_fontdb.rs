//! [hwpx-cowork] Hancom 2022 FontDB: conditional, language-specific selection.
//! Data comes from gen-hancom-fontdb.py, not inferred from engine screenshots.
//! A substitution edge is followed only when the requested glyph is absent.
use std::{cell::RefCell, collections::HashMap, sync::OnceLock};
use serde::Deserialize;
use super::{font_metrics_local::{LocalFontFace, LOCAL_FONT_FACES}, local_font_width::find_local_face};

#[derive(Deserialize)]
// [hwpx-cowork] 2026-11-07: project routing schema, not a FontDB section/row
// replica. Offline provenance/private/representative rows never enter WASM.
struct Database {
    #[serde(rename = "primaryRouting")]
    primary: FontDb,
    #[serde(rename = "secondaryRouting")]
    secondary: Option<FontDb>,
    #[serde(rename = "faceStyles")]
    styles: Vec<FaceStyle>,
}
#[derive(Deserialize)]
struct FontDb {
    #[serde(rename = "defaultChains")]
    defaults: Vec<DefaultRow>,
    #[serde(rename = "missingGlyphRoutes")]
    substitutions: Vec<Substitution>,
    #[serde(rename = "hftSlotNames")]
    hft: Vec<HftDefinition>,
}
#[derive(Deserialize)]
struct HftDefinition { #[serde(rename = "slot")] lang: usize, names: Vec<String> }
#[derive(Deserialize)]
struct DefaultRow {
    #[serde(rename = "slot")]
    lang: usize,
    // [hwpx-cowork] An explicit scalar policy must not reorder other symbols.
    #[serde(rename = "codepoint")]
    code: Option<u32>,
    #[serde(rename = "families")]
    faces: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Substitution { #[serde(rename = "slot")] lang: usize, source: String, #[serde(rename = "sourceKind")] kind: String, target: String, target_kind: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaceStyle { #[serde(rename = "metricIndex")] index: usize, #[serde(rename = "basename")] file: String, family: String,
    #[serde(rename = "paintName")] full: String, weight: u16, italic: bool, #[serde(rename = "width")] width_class: u16, zero_advance: Vec<u32> }

fn db() -> &'static Database {
    static DB: OnceLock<Database> = OnceLock::new();
    DB.get_or_init(|| serde_json::from_str(include_str!("hancom_fontdb_data.json"))
        .expect("generated Hancom FontDB must be valid"))
}

/// An explicit HFT language slot is distinct from a representative UI font.
/// Rep Fonts describes setting all seven slots together; it must not silently
/// rewrite a fontRef that the document already supplies for one language.
pub(crate) fn has_native_hft_binding(name: &str, lang: usize) -> bool {
    let matches = |source: &FontDb| source.hft.iter().any(|r| r.lang == lang
        && r.names.iter().any(|alias| alias == name));
    matches(&db().primary) || db().secondary.as_ref().is_some_and(matches)
}

fn style_of(face: &LocalFontFace) -> Option<&'static FaceStyle> {
    let index = LOCAL_FONT_FACES.iter().position(|f| std::ptr::eq(f, face))?;
    let style = db().styles.get(index)?;
    // A metrics regeneration must not silently attach a different font's style.
    (style.index == index && face.file.split('#').next()?.eq_ignore_ascii_case(&style.file)).then_some(style)
}

/// Full/PostScript aliases identify a file; CSS/GDI family names identify a
/// style family. Supply both in this order, before unrelated default fonts.
pub(crate) fn family_alias(name: &str) -> Option<&'static str> {
    Some(&style_of(find_local_face(name)?)?.family)
}

pub(crate) fn css_weight(name: &str) -> Option<u16> {
    Some(style_of(find_local_face(name)?)?.weight)
}

pub(crate) fn css_stretch(name: &str) -> Option<&'static str> {
    match style_of(find_local_face(name)?)?.width_class {
        1 => Some("ultra-condensed"), 2 => Some("extra-condensed"), 3 => Some("condensed"),
        4 => Some("semi-condensed"), 6 => Some("semi-expanded"), 7 => Some("expanded"),
        8 => Some("extra-expanded"), 9 => Some("ultra-expanded"), _ => None,
    }
}

thread_local! {
    static STYLES: RefCell<HashMap<(String, bool, bool), Option<usize>>> = RefCell::new(HashMap::new());
    static CANDIDATES: RefCell<HashMap<(String, usize, Option<u32>), Vec<&'static str>>> = RefCell::new(HashMap::new());
}

fn face_style(family: &str, bold: bool, italic: bool) -> Option<&'static FaceStyle> {
    let key = (family.to_string(), bold, italic);
    let index = STYLES.with(|cache| {
        if let Some(hit) = cache.borrow().get(&key) { return *hit; }
        let selected = find_local_face(family).and_then(style_of).map(|base| {
            let weight = if bold { base.weight.max(700) } else { base.weight };
            let italic = italic || base.italic;
            // Exact named design wins over same-family siblings with equal
            // weight (e.g. OS/2 widthClass 3 condensed vs widthClass 5 regular).
            if base.weight == weight && base.italic == italic { return base.index; }
            db().styles.iter().filter(|s| s.family == base.family && s.italic == italic && s.width_class == base.width_class)
                .min_by_key(|s| (s.weight.abs_diff(weight), s.index))
                .unwrap_or(base).index
        });
        cache.borrow_mut().insert(key, selected);
        selected
    })?;
    db().styles.get(index)
}

fn matches_source(requested: &str, source: &str) -> bool {
    if requested == source { return true; }
    let Some(a) = find_local_face(requested) else { return false; };
    let Some(b) = find_local_face(source) else { return false; };
    std::ptr::eq(a, b) || style_of(a).zip(style_of(b)).is_some_and(|(a,b)| a.family == b.family)
}

/// Ordered edges, preserving duplicate rows. 2024 may fill an absent 2022 key;
/// it cannot replace a present key merely because a glyph is not covered.
pub(crate) fn fallback_candidates(family: &str, lang: usize) -> Vec<&'static str> {
    fallback_candidates_for_char(family, lang, None)
}

// [hwpx-cowork] 2026-11-06 user policy: U+2024 uses the scalar-specific
// primary.defaults row. This is an intentional display choice, not evidence
// that Hancom 2022 changed its Haansoft Batang selection. Other scalars keep
// their original defaults and genuine primary glyphs still win.
fn fallback_candidates_for_char(family: &str, lang: usize, c: Option<char>) -> Vec<&'static str> {
    let code = c.map(|c| c as u32);
    let key = (family.to_string(), lang, code);
    CANDIDATES.with(|cache| {
        if let Some(hit) = cache.borrow().get(&key) { return hit.clone(); }
        let mut output = Vec::new();
        let mut visited = Vec::new();
        fn visit(name: &str, kind: &str, lang: usize, out: &mut Vec<&'static str>, visited: &mut Vec<(String,String)>) {
            if visited.iter().any(|(n,k)| n == name && k == kind) { return; }
            visited.push((name.to_string(), kind.to_string()));
            if visited.len() > 128 { return; }
            let primary = &db().primary;
            let has_key = primary.substitutions.iter().any(|r| r.lang == lang && r.kind == kind && matches_source(name, &r.source));
            let source = if has_key { Some(primary) } else { db().secondary.as_ref() };
            if let Some(source) = source {
                for row in source.substitutions.iter().filter(|r| r.lang == lang && r.kind == kind && matches_source(name, &r.source)) {
                    if row.target_kind == "T" && !out.contains(&row.target.as_str()) { out.push(&row.target); }
                    visit(&row.target, &row.target_kind, lang, out, visited);
                }
            }
        }
        visit(family.split(',').next().unwrap_or(family).trim(), "T", lang, &mut output, &mut visited);
        let defaults_for = |source: &'static FontDb| source.defaults.iter()
            .find(|r| code.is_some() && r.lang == lang && r.code == code)
            .or_else(|| source.defaults.iter().find(|r| r.lang == lang && r.code.is_none()));
        let defaults = defaults_for(&db().primary)
            .or_else(|| defaults_for(db().secondary.as_ref()?));
        if let Some(defaults) = defaults {
            for name in &defaults.faces {
                if !output.contains(&name.as_str()) { output.push(name); }
            }
        }
        cache.borrow_mut().insert(key, output.clone());
        output
    })
}

#[derive(Clone, Copy)]
pub(crate) struct GlyphSelection {
    pub paint_family: &'static str,
    pub metric_face: &'static LocalFontFace,
    pub advance_em: f64,
    /// [hwpx-cowork] The glyph comes from the requested face's own GDI family
    /// (style linking only: Regular/Bold/Italic). Backends reproduce this choice
    /// from the document's family name plus bold/italic, so paint must keep that
    /// name. Only a different family (missing glyph) needs a physical face name.
    pub requested_family: bool,
}

fn face_advance(style: &FaceStyle, c: char) -> Option<f64> {
    LOCAL_FONT_FACES.get(style.index)?.advance_em(c)
        .or_else(|| style.zero_advance.binary_search(&(c as u32)).ok().map(|_| 0.0))
}

fn covered(family: &str, c: char, bold: bool, italic: bool) -> Option<GlyphSelection> {
    let paint = face_style(family, bold, italic)?;
    let paint_face = LOCAL_FONT_FACES.get(paint.index)?;
    let paint_advance = face_advance(paint, c)?;
    // Hancom's Bold property changes the outline, not the regular advance.
    // Preserve a genuine italic design when choosing that regular metric face.
    let metric = db().styles.iter().filter(|s| s.family == paint.family && s.italic == paint.italic && s.width_class == paint.width_class)
        .min_by_key(|s| (s.weight.abs_diff(400), s.index)).unwrap_or(paint);
    let metric_face = &LOCAL_FONT_FACES[metric.index];
    let metric_advance = face_advance(metric, c);
    Some(GlyphSelection { paint_family: &paint.full,
        metric_face: if metric_advance.is_some() { metric_face } else { paint_face },
        advance_em: metric_advance.unwrap_or(paint_advance), requested_family: false })
}

/// [hwpx-cowork] 2026-11-10 P1 성능: 문자열 키 해시용 FxHash 계열 해셔(결정적·암호용 아님).
/// 같은 프로세스 안 캐시 조회만 빠르게 한다 — 결과·순회 순서를 소비하는 곳에는 쓰지 않는다.
#[derive(Default, Clone, Copy)]
pub(crate) struct FastHasher(u64);
impl std::hash::Hasher for FastHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks {
            self.write_u64(u64::from_le_bytes(chunk.try_into().unwrap_or([0; 8])));
        }
        let rest = chunks.remainder();
        if !rest.is_empty() {
            let mut tail = [0u8; 8];
            tail[..rest.len()].copy_from_slice(rest);
            self.write_u64(u64::from_le_bytes(tail) ^ ((rest.len() as u64) << 59));
        }
    }
    fn write_u8(&mut self, n: u8) { self.write_u64(u64::from(n)); }
    fn write_u16(&mut self, n: u16) { self.write_u64(u64::from(n)); }
    fn write_u32(&mut self, n: u32) { self.write_u64(u64::from(n)); }
    fn write_u64(&mut self, n: u64) { self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95); }
    fn write_usize(&mut self, n: usize) { self.write_u64(n as u64); }
}
pub(crate) type FastBuild = std::hash::BuildHasherDefault<FastHasher>;

type GlyphKey = (char, bool, bool, usize);
thread_local! {
    // [hwpx-cowork] 2026-11-10 P1 성능: `select_glyph` 는 정적 표(LOCAL_FONT_FACES·FontDB·HFT/TTF 자료)와
    // 그 위의 순수 기억(STYLES·CANDIDATES·FACE_CACHE)만 읽는 순수 함수다 — 같은 (글꼴 목록, 글자, 진하게,
    // 기울임, 언어) 는 언제나 같은 선택이다. 0.9.0 병합 엔진은 저장 줄 재현·자간 격자·렌더 정규화가 글자마다
    // 이 선택을 여러 번 묻는다(59쪽 `2025년_전체종합보고서` 점진 열기 Node WASM 실측: select_glyph 포함 ≈400ms/회,
    // 그중 `covered` 의 스타일 목록 선형 탐색 자기 시간 ≈235ms/회 — fork 0.8.7 은 ≈93ms). 답을 기억해 같은
    // 계산을 되풀이하지 않는다. 바깥 키는 글꼴 목록 문자열(빌린 &str 로 조회 — 할당 없음).
    static GLYPHS: RefCell<(usize, HashMap<String, HashMap<GlyphKey, Option<GlyphSelection>, FastBuild>, FastBuild>)> =
        RefCell::new((0, HashMap::default()));
}
/// 기억 항목 상한(넘으면 비우고 다시 채운다 — 결과는 같고 메모리만 묶는다).
const GLYPH_MEMO_LIMIT: usize = 1 << 18;

/// [hwpx-cowork] One choice for advance, SVG, Canvas and CanvasKit. Actual
/// coverage is evidence; font-name similarity alone cannot replace a glyph.
pub(crate) fn select_glyph(family: &str, c: char, bold: bool, italic: bool, lang: usize) -> Option<GlyphSelection> {
    let key = (c, bold, italic, lang);
    // 조회 borrow 는 계산 전에 끝난다 — 계산이 HFT→TTF 로 이 함수를 다시 불러도 겹치지 않는다.
    if let Some(hit) = GLYPHS.with(|memo| memo.borrow().1.get(family).and_then(|faces| faces.get(&key).copied())) {
        return hit;
    }
    let selected = select_glyph_uncached(family, c, bold, italic, lang);
    GLYPHS.with(|memo| {
        let mut memo = memo.borrow_mut();
        if memo.0 >= GLYPH_MEMO_LIMIT {
            memo.1.clear();
            memo.0 = 0;
        }
        memo.0 += 1;
        if let Some(faces) = memo.1.get_mut(family) {
            faces.insert(key, selected);
        } else {
            let mut faces = HashMap::default();
            faces.insert(key, selected);
            memo.1.insert(family.to_string(), faces);
        }
    });
    selected
}

fn select_glyph_uncached(family: &str, c: char, bold: bool, italic: bool, lang: usize) -> Option<GlyphSelection> {
    // [hwpx-cowork] Metric-only HFT keys never become paint families. The
    // mapped TTF recurses through ordinary coverage/style selection below.
    if let Some(choice) = super::hft_ttf::select_glyph(family,c,bold,italic) { return Some(choice); }
    let primary = family.split(',').next()?.trim().trim_matches(|c| c == '\'' || c == '"');
    let primary_available = find_local_face(primary).is_some();
    for (index, name) in family.split(',').map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"')).enumerate() {
        // A document substFont replaces an absent font program. It is not the
        // missing-glyph chain of an installed primary (2022/2024 calibration:
        // KoPubDotum Bold + ◦ uses Haansoft Batang, not declared HCR Dotum).
        // [hwpx-cowork] The second member of an internal extracted-HFT chain
        // is the established stand-in for undecoded ranges, not a document's
        // substFont overriding an installed primary's ordinary fallback.
        if index > 0 && primary_available && !super::hft_ttf::is_native(primary) { break; }
        if find_local_face(name).is_some_and(|f| f.advance_em(c).is_some() && style_of(f).is_none()) {
            // Stale style metadata cannot disprove existing coverage.
            return None;
        }
        if let Some(choice) = covered(name, c, bold, italic) {
            return Some(GlyphSelection { requested_family: index == 0, ..choice });
        }
    }
    for name in fallback_candidates_for_char(family, lang, Some(c)) {
        if let Some(choice) = covered(name, c, bold, italic) { return Some(choice); }
    }
    None
}

pub(crate) fn advance_em(family: &str, c: char, bold: bool, italic: bool, lang: usize) -> Option<f64> {
    Some(select_glyph(family, c, bold, italic, lang)?.advance_em)
}

pub(crate) fn glyph_lang(c: char) -> usize {
    if c.is_ascii() || c == '\u{00b7}' { 1 } else { super::style_resolver::detect_lang_category(c) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fontdb_2022_keeps_covered_glyphs_and_follows_symbol_edges_only_on_missing() {
        assert!(select_glyph("Tahoma", '\u{2024}', false, false, 5).unwrap().paint_family.contains("Tahoma"));
        let choice = select_glyph("한컴 고딕", '\u{2024}', true, false, 5).unwrap();
        assert_eq!(choice.paint_family, "HCR Dotum Bold");
        assert_eq!(choice.metric_face.advance_em('\u{2024}'), Some(0.288));
        assert!(select_glyph("한컴 고딕", '.', true, false, 1).unwrap().paint_family.contains("Hancom Gothic"));
        // [hwpx-cowork] User-selected U+2024 defaults override (not the 2022 oracle).
        assert_eq!(select_glyph("Arial", '\u{2024}', false, false, 5).unwrap().paint_family, "HCR Batang");
    }
    #[test]
    fn fontdb_2022_uses_font_advances_not_unicode_halfwidth_assumptions() {
        assert_eq!(advance_em("휴먼명조", '\u{00b7}', false, false, 1), Some(1.0));
        assert_eq!(advance_em("DotumChe", '\u{300c}', false, false, 5), Some(1.0));
        assert_eq!(advance_em("Tahoma", '\u{2024}', true, false, 5), advance_em("Tahoma", '\u{2024}', false, false, 5));
        let italic = select_glyph("Times New Roman", '\u{2024}', false, true, 5).unwrap();
        assert!(italic.paint_family.contains("Italic"));
        assert!(italic.metric_face.file.to_lowercase().contains("timesi"));
    }
    #[test]
    fn fontdb_style_rows_align_with_the_generated_metrics() {
        for face in &LOCAL_FONT_FACES { assert!(style_of(face).is_some(), "{}: run gen-hancom-fontdb.py after gen-font-metrics", face.file); }
    }
    #[test]
    fn fontdb_does_not_merge_a_semilight_gdi_family_into_the_regular_family() {
        assert_eq!(select_glyph("Malgun Gothic Semilight", '\u{2024}', false, false, 5).unwrap().paint_family, "HCR Batang");
        assert_eq!(select_glyph("Malgun Gothic", '\u{2024}', false, false, 5).unwrap().paint_family, "HCR Dotum");
    }
    #[test]
    fn fontdb_direct_font_advances_are_not_canvas_fit_targets() {
        let style = super::super::TextStyle { font_metric_trusted: true, ..Default::default() };
        assert_eq!(super::super::canvas_cluster_fit(&style, "a", 10.0, 20.0, None, false), None);
        assert_eq!(super::super::canvas_cluster_fit(&style, "a", 10.0, 20.0, None, true), None);
    }
    #[test]
    fn fontdb_name_resolution_preserves_tahoma_and_uses_language_defaults_when_absent() {
        use super::super::style_resolver::{resolve_font_substitution_decision, FontSubstitutionBoundary};
        for lang in 0..7 {
            assert!(resolve_font_substitution_decision("Tahoma", 1, lang).is_none());
        }
        let latin = resolve_font_substitution_decision("RegressionMissingFont", 1, 1).unwrap();
        assert_eq!(latin.0, "한컴바탕");
        assert_eq!(latin.1, FontSubstitutionBoundary::HancomFontDb);
        let hanja = resolve_font_substitution_decision("RegressionMissingFont", 1, 2).unwrap();
        assert_eq!(hanja.0, "함초롬바탕");
    }
    #[test]
    fn fontdb_exact_design_is_not_replaced_by_a_same_weight_noncondensed_sibling() {
        assert_eq!(select_glyph("SamsungOneUILatin 500C", '\u{2024}', false, false, 5).unwrap().paint_family, "SamsungOneUILatin 500C");
        assert_eq!(select_glyph("SamsungOneUILatin 700C", '\u{2024}', false, false, 5).unwrap().paint_family, "SamsungOneUILatin 700C");
    }
    #[test]
    fn fontdb_document_substitute_is_not_a_missing_glyph_fallback() {
        assert_eq!(select_glyph("KoPub돋움체 Bold,함초롬돋움", '\u{25e6}', false, false, 5).unwrap().paint_family, "Haansoft Batang");
        assert_eq!(advance_em("KoPub돋움체 Bold,함초롬돋움", '\u{25e6}', false, false, 5), Some(1.0));
        assert_eq!(select_glyph("RegressionMissingFont,함초롬돋움", '\u{2024}', false, false, 5).unwrap().paint_family, "HCR Dotum");
        assert!(has_native_hft_binding("한양신명조", 5));
        assert!(!has_native_hft_binding("가는한", 5));
    }
    #[test]
    fn fontdb_styled_face_keeps_its_family_before_unrelated_css_fallbacks() {
        assert_eq!(family_alias("Times New Roman Italic"), Some("Times New Roman"));
        let chain = super::super::render_font_family_chain("Times New Roman Italic");
        assert!(chain.find("'Times New Roman'").unwrap() < chain.find("'한컴바탕'").unwrap());
        assert_eq!(css_stretch("SamsungOneUILatin 500C"), Some("condensed"));
        assert_eq!(css_weight("SamsungOneUILatin 700C"), Some(700));
    }
    /// [hwpx-cowork] 2026-11-06: style family = Windows(GDI) name 1. The Mac name 1
    /// of KoPubWorld/Nanum fonts is the typographic family, which merged
    /// Light/Medium/Bold: Bold text on a Light face was drawn with the Bold file,
    /// and NanumSquare Bold was measured with another weight's advances.
    #[test]
    fn fontdb_style_family_is_the_gdi_family_not_the_typographic_family() {
        assert_eq!(family_alias("KoPubWorld돋움체 Light"), Some("KoPubWorldDotum Light"));
        assert_eq!(family_alias("KoPubWorld바탕체 Light"), Some("KoPubWorldBatang Light"));
        // A GDI family without a Bold member: the Bold property keeps the Light file.
        let light_bold = select_glyph("KoPubWorld돋움체 Light", '가', true, false, 0).unwrap();
        assert_eq!(light_bold.paint_family, "KoPubWorldDotum Light");
        assert!(light_bold.requested_family);
        // A heavier named design keeps its own advances.
        for (family, c) in [("나눔스퀘어 Bold", 'C'), ("나눔스퀘어 Bold", 'B'), ("KoPubWorld돋움체 Bold", '가')] {
            assert_eq!(advance_em(family, c, false, false, 1), find_local_face(family).unwrap().advance_em(c), "{family} {c}");
        }
        // Style linking inside one GDI family is unchanged (Hancom Gothic Regular/Bold).
        let gothic_bold = select_glyph("한컴 고딕", '가', true, false, 0).unwrap();
        assert!(gothic_bold.paint_family.contains("Bold") && gothic_bold.requested_family);
        assert!(!select_glyph("한컴 고딕", '\u{2024}', true, false, 5).unwrap().requested_family);
    }
}
