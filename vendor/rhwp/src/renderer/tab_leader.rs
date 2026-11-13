//! 점 자체의 glyph 원점과 리더가 채우는 폭을 분리한다.
//!
//! 독립 한양/Poppy 9·13·18pt, 세 접두 길이·세 자리 수 표본의 Print는
//! 1/4em 셀 수를 먼저 정하고 남는 폭을 그 셀에 배분한다. 원 glyph의
//! 가운뎃점 중심은 원점에서 0.192em이다. 글줄·탭 정지의 위치는 바꾸지 않는다.

pub(crate) const MAX_DOT_CENTERS: usize = 4096;

pub(crate) struct DotLeaderGeometry {
    pub centers: Vec<f64>,
    pub radius: f64,
}

pub(crate) fn dot_geometry(font_size: f64, start: f64, end: f64) -> Option<DotLeaderGeometry> {
    if !font_size.is_finite() || font_size <= 0.0 || !start.is_finite() || !end.is_finite() {
        return None;
    }
    let width = (end - start).max(0.0);
    let count = (width / (font_size * 0.25)).floor();
    if !count.is_finite() || count > MAX_DOT_CENTERS as f64 {
        return None;
    }
    let count = count as usize;
    let step = if count == 0 {
        0.0
    } else {
        width / count as f64
    };
    Some(DotLeaderGeometry {
        centers: (0..count)
            .map(|index| start + index as f64 * step + font_size * 0.192)
            .collect(),
        radius: font_size * super::render_tree::MIDDLE_DOT_RADIUS_EM,
    })
}

/// [hwpx-cowork] 2026-11-10 점선 리더를 글자로 그릴 때의 run(점 글자열·원점·칸 위치·그리기 스타일).
/// 점 위치(셀 수·배분·중심)는 위 `dot_geometry` 그대로이고, 각 점은 HFT 전진 칸 가운데가 그 중심에
/// 오도록 놓는다. 글꼴·글자·칸 맞춤·기준선은 `TextStyle::tab_leader_glyph`(본문 글자와 같은 HFT 대체
/// 결정)를 따른다. 없으면 None — 호출자는 종전 원 근사를 쓴다.
pub(crate) struct LeaderGlyphRun {
    pub text: String,
    /// run x 기준 첫 점 글자 원점(칸 가운데 맞춤 이동 포함)
    pub origin: f64,
    /// 기준선 이동(px, 아래가 +)
    pub dy: f64,
    /// 첫 점 원점 기준 각 점 원점 + 끝(글자 수 + 1)
    pub positions: Vec<f64>,
    pub style: super::TextStyle,
}

pub(crate) fn glyph_run(
    style: &super::TextStyle,
    font_size: f64,
    start: f64,
    end: f64,
) -> Option<LeaderGlyphRun> {
    let glyph = style.tab_leader_glyph?;
    if !(glyph.cell.is_finite() && glyph.cell > 0.0 && glyph.paint_size.is_finite() && glyph.paint_size > 0.0) {
        return None;
    }
    let dots = dot_geometry(font_size, start, end)?;
    let first = dots.centers.first()? - glyph.cell / 2.0;
    let mut positions: Vec<f64> = dots
        .centers
        .iter()
        .map(|center| center - glyph.cell / 2.0 - first)
        .collect();
    positions.push(positions.last().copied().unwrap_or(0.0) + glyph.cell);
    let mut dot = style.clone();
    dot.font_family = glyph.family.to_string();
    dot.paint_font_geometry = Some((glyph.paint_size, style.ratio));
    dot.paint_ink_bounds = None;
    dot.metric_font_family = None;
    dot.font_metric_trusted = true;
    dot.kerning = false;
    dot.tab_leaders.clear();
    dot.tab_leader_glyph = None;
    dot.inline_tabs.clear();
    dot.underline = crate::model::style::UnderlineType::None;
    dot.strikethrough = false;
    dot.emphasis_dot = 0;
    dot.shadow_type = 0;
    dot.shade_color = crate::model::color::NONE;
    // 호출자의 기준선은 이미 첨자 보정이 끝난 값이다.
    dot.superscript = false;
    dot.subscript = false;
    dot.ascii_punct_latin = None;
    dot.hft_fullwidth_dot = false;
    dot.hft_hangul_face = false;
    Some(LeaderGlyphRun {
        text: std::iter::repeat(glyph.character).take(dots.centers.len()).collect(),
        origin: first + glyph.dx,
        dy: glyph.dy,
        positions,
        style: dot,
    })
}
