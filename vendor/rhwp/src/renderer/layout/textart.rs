//! [hwpx-cowork] 글맵시(`hp:textart`) 기본 그리기 — 글을 상자에 맞춰 늘려 그린다(2026-11-12, h2022 개체 영역).
//!
//! 한/글 2022(12.0.0.3146) 실측 — `artifacts/h2022-object/textart_probe.py`(TextArtCreate, 모양 번호 0..54 → `textShape` 이름 55종,
//! CreatePageImage 144dpi): 직사각형(`RECTANGLE`, 42번) 꼴은 글('글맵시 ABC', 함초롬돋움)이 상자 높이를 꽉 채우고(잉크 위·아래 = 상자 위·아래)
//! 가로도 상자 폭에 맞춰 늘어난다. 글자 색 = 채우기(`winBrush faceColor`), 외곽선 = `lineShape`(NONE 이면 없음).
//! 상자 자체(채우기·선)는 그리지 않는다.
//!
//! 여기서는 세 그리기 경로가 같은 결정을 쓰도록 일반 글자 노드(`TextRun`)만 만든다 — 줄마다 글자 크기 = 줄 높이 ÷ 글꼴의
//! 잉크 높이 비율(근사 0.88), 장평 = 상자 폭 ÷ 그 크기의 자연 폭. 한/글은 글자 윤곽의 잉크 상자를 상자에 맞추는데(윤곽 단위),
//! 여기는 글꼴 단위 근사라 글자 모양마다 위·아래가 몇 px 다를 수 있다(원장 ledger_object.md).
//! 직사각형이 아닌 모양(물결·아치·원 등 54종)은 아직 모양대로 휘지 않고 같은 직사각형 꼴로 그린다 — 빈칸보다 글이 보이게.

use crate::model::shape::{RectangleShape, TextArtInfo};
use crate::renderer::render_tree::{BoundingBox, PageLayoutContext, RenderNode, RenderNodeType, TextRunNode};
use crate::renderer::TextStyle;

/// 글꼴 크기 대비 잉크 높이(한글·라틴 대문자) — 함초롬돋움 '글맵시 ABC' 실측 잉크 = 상자 높이에 맞춘 근사
const INK_RATIO: f64 = 0.88;
/// 글꼴 크기 대비 잉크 위끝 → 기준선 거리
const ASCENT_INK: f64 = 0.80;

/// 한 줄의 글자 노드 결정(공통 계산) — (글, 글꼴, 크기 px, 장평 %, 기준선 y, 왼쪽 x, 폭)
pub(crate) struct TextArtLine {
    pub text: String,
    pub font_size: f64,
    pub ratio: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub baseline: f64,
}

pub(crate) fn textart_font(info: &TextArtInfo) -> String {
    info.attr("fontName").unwrap_or("함초롬돋움").to_string()
}

pub(crate) fn plan_textart_lines(info: &TextArtInfo, x: f64, y: f64, w: f64, h: f64) -> Vec<TextArtLine> {
    let lines: Vec<&str> = info.text.split(['\n', '\r']).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() || w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    let spacing = info
        .attr("lineSpacing")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(120.0)
        .clamp(50.0, 500.0)
        / 100.0;
    // 줄 높이: n 줄이 상자를 채운다 — 줄과 줄 사이 = 줄 높이 × (줄 간격 − 1)
    let n = lines.len() as f64;
    let line_h = h / (n + (n - 1.0) * (spacing - 1.0).max(0.0));
    let font_size = line_h / INK_RATIO;
    let family = textart_font(info);
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let style = TextStyle {
            font_family: family.clone(),
            font_size,
            ratio: 1.0,
            ..TextStyle::default()
        };
        let natural = super::text_measurement::estimate_text_width(line, &style).max(1.0);
        let ratio = (w / natural).clamp(0.05, 20.0);
        let top = y + i as f64 * line_h * spacing.max(1.0);
        out.push(TextArtLine {
            text: (*line).to_string(),
            font_size,
            ratio,
            x,
            y: top,
            width: w,
            height: line_h,
            baseline: font_size * ASCENT_INK - (font_size - line_h) / 2.0,
        });
    }
    out
}

/// 글맵시 글자 노드를 부모(상자 노드)에 넣는다 — 색 = 채우기 색, 외곽선은 아직 그리지 않는다.
pub(crate) fn append_textart_text(
    tree: &mut PageLayoutContext,
    parent: &mut RenderNode,
    rect: &RectangleShape,
    (x, y, w, h): (f64, f64, f64, f64),
    section_index: usize,
    para_index: usize,
) {
    let Some(info) = rect.textart.as_deref() else { return };
    let color = rect
        .drawing
        .fill
        .solid
        .as_ref()
        .map(|s| s.background_color)
        .unwrap_or(0x00FF_0000);
    for line in plan_textart_lines(info, x, y, w, h) {
        let style = TextStyle {
            font_family: textart_font(info),
            font_size: line.font_size,
            ratio: line.ratio,
            color,
            ..TextStyle::default()
        };
        let node = RenderNode::new(
            tree.next_id(),
            RenderNodeType::TextRun(TextRunNode {
                text: line.text,
                style,
                char_shape_id: None,
                para_shape_id: None,
                section_index: Some(section_index),
                para_index: Some(para_index),
                char_start: None,
                cell_context: None,
                is_para_end: false,
                is_line_break_end: false,
                rotation: 0.0,
                is_vertical: false,
                char_overlap: None,
                border_fill_id: 0,
                baseline: line.baseline,
                field_marker: Default::default(),
                layout_positions: None,
                display_text: None,
            }),
            BoundingBox::new(line.x, line.y, line.width, line.height),
        );
        parent.children.push(node);
    }
}
