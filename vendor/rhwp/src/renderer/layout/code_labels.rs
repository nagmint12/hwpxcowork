//! [hwpx-cowork] 조판 부호 보기 — 부호 표지를 제자리(글자 사이)에 끼워 그린다(한/글 2022 실측, 2026-10-30).
//!
//! 한/글은 조판 부호 보기를 켜면 부호마다 `[이름]` 표지를 부호가 있는 자리에 제 폭으로 그리고, 그 뒤 내용을 표지 폭만큼
//! 오른쪽으로 민다. 표지는 **화면에만** 있다 — 줄 나눔은 보기를 켜든 끄든 같고(부호가 백 개여도 줄을 나누지 않고 오른쪽
//! 여백·쪽 밖으로 넘친다), 저장 lineseg 도 같다. 그래서 줄을 다 배치한 뒤(조판이 끝난 뒤) 이 줄 노드만 고친다:
//!   1) 틈 부호(감추기·선·자리차지 표 …)는 그 틈 뒤 글자(또는 글자처럼 취급한 개체) 앞에, 칸을 차지하는 것(글자처럼
//!      취급한 표·그림·수식, 각주, 자동 번호)의 표지는 그 개체 뒤에 놓는다 — `가나[표] [표]다라`.
//!   2) 글 조각이 부호 자리를 가운데 품으면 그 자리에서 둘로 나눈다(글자 경계값은 그대로 옮겨 싣는다).
//!   3) 표지보다 뒤(논리 차례)인 노드를 표지 폭만큼 민다. 캐럿·적중 판정은 이 노드들을 읽으므로 함께 옮겨 간다.
//!   4) 문단 끝 표시(↵)는 표지 뒤로 — 끝 글 조각 뒤에 표지가 오면 빈 끝 조각을 새로 둔다.
//!
//! 표지 모양(실측): 주황(#FF8000), 부호가 든 run 의 글자 모양(크기·글꼴·장평·굵게·기울임)을 쓰되 자간·글자색은 쓰지 않는다.
//! 폭: 한글 음절 1em, `[ ] ( )`·공백 같은 ASCII 0.5em (× 글자 크기 × 장평).

use super::super::render_tree::*;
use super::super::style_resolver::ResolvedStyleSet;
use super::text_measurement::resolved_to_text_style;
use super::{CellContext, LayoutEngine};
use crate::model::code_gaps::{GapCodeItem, SlotLabel};
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::style::UnderlineType;
use crate::renderer::PathCommand;

/// 한/글 조판 부호 표지 색 #FF8000 (ColorRef = 0x00BBGGRR)
pub(crate) const CODE_LABEL_COLOR: u32 = 0x0000_80FF;

/// 표지 글자 경계값 — 한글 음절 등 ASCII 밖 글자 1em, ASCII 0.5em
pub(crate) fn code_label_positions(text: &str, em: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(text.chars().count() + 1);
    let mut x = 0.0;
    out.push(x);
    for ch in text.chars() {
        x += if ch.is_ascii() { em * 0.5 } else { em };
        out.push(x);
    }
    out
}

/// 표지 글자 모양 — 부호가 든 run 의 글자 모양에서 크기·글꼴·장평·굵게·기울임만
pub(crate) fn code_label_style(styles: &ResolvedStyleSet, char_shape_id: u32) -> crate::renderer::TextStyle {
    let mut s = resolved_to_text_style(styles, char_shape_id, 0);
    s.color = CODE_LABEL_COLOR;
    s.letter_spacing = 0.0;
    s.underline = UnderlineType::None;
    s.strikethrough = false;
    s.outline_type = 0;
    s.shadow_type = 0;
    s.emboss = false;
    s.engrave = false;
    s.superscript = false;
    s.subscript = false;
    s.emphasis_dot = 0;
    s.shade_color = 0xFFFF_FFFF;
    s.kerning = false;
    s.tab_stops.clear();
    s.tab_leaders.clear();
    s.inline_tabs.clear();
    s.extra_word_spacing = 0.0;
    s.extra_char_spacing = 0.0;
    s.extra_dash_advance = 0.0;
    s
}

/// 노드와 자손을 x 로 dx 만큼 옮긴다(직선·경로는 제 좌표도)
pub(crate) fn translate_subtree_x(node: &mut RenderNode, dx: f64) {
    if dx == 0.0 {
        return;
    }
    node.bbox.x += dx;
    match &mut node.node_type {
        RenderNodeType::Line(line) => {
            line.x1 += dx;
            line.x2 += dx;
        }
        RenderNodeType::Path(path) => {
            for cmd in path.commands.iter_mut() {
                match cmd {
                    PathCommand::MoveTo(x, _) | PathCommand::LineTo(x, _) => *x += dx,
                    PathCommand::CurveTo(x1, _, x2, _, x, _) => {
                        *x1 += dx;
                        *x2 += dx;
                        *x += dx;
                    }
                    PathCommand::ArcTo(_, _, _, _, _, x, _) => *x += dx,
                    PathCommand::ClosePath => {}
                }
            }
        }
        _ => {}
    }
    for child in node.children.iter_mut() {
        translate_subtree_x(child, dx);
    }
}

/// 끼울 표지 하나
struct PendingLabel {
    /// 논리 차례 — (2 × 논리 자리, 틈 안 차례) 는 틈 부호, (2 × 논리 자리 + 1, 0) 은 칸 뒤 표지
    key: (usize, usize),
    /// 밀기 전 자리
    anchor_x: f64,
    text: String,
    style: crate::renderer::TextStyle,
    positions: Vec<f64>,
    marker: FieldMarkerType,
}

/// 글 조각 하나의 (자식 번호, 글자 시작, 글자 수)
fn text_run_span(node: &RenderNode) -> Option<(usize, usize)> {
    match &node.node_type {
        RenderNodeType::TextRun(tr) if tr.field_marker == FieldMarkerType::None => {
            tr.char_start.map(|s| (s, tr.text.chars().count()))
        }
        _ => None,
    }
}

/// 노드가 가리키는 개체 컨트롤 번호(그림·수식·양식·각주 표지 …)
fn node_control_index(node: &RenderNode, para_index: usize) -> Option<usize> {
    match &node.node_type {
        RenderNodeType::Image(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Equation(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Group(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Rectangle(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Ellipse(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Path(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::Line(n) if n.para_index == Some(para_index) => n.control_index,
        RenderNodeType::FootnoteMarker(n) if n.para_index == para_index => Some(n.control_index),
        _ => None,
    }
}

/// 이 줄의 표지 끼우기 입력
pub(crate) struct CodeLabelLine<'a> {
    pub para: &'a Paragraph,
    pub styles: &'a ResolvedStyleSet,
    /// 줄 첫 글자 번호
    pub line_start: usize,
    /// 줄 끝 글자 번호(다음 줄 첫 글자 — 강제 줄 바꿈 글자 앞)
    pub line_end: usize,
    /// 줄 끝 자리(`line_end`) 의 틈도 이 줄 것인가 — 문단 마지막 줄·강제 줄 바꿈 줄
    pub owns_end: bool,
    /// 빈 누름틀 안내문 (필드 컨트롤 번호, x, 폭) — [누름틀 시작] 은 안내문 앞, [누름틀 끝] 은 뒤
    pub guides: &'a [(usize, f64, f64)],
    pub section_index: usize,
    pub para_index: usize,
    pub cell_ctx: &'a Option<CellContext>,
    pub y: f64,
    pub line_height: f64,
    pub baseline: f64,
}

impl LayoutEngine {
    /// [hwpx-cowork] 조판 부호 보기 표지를 줄에 끼운다(조판 부호 보기가 켜져 있을 때만 부른다). 끼운 표지 폭의 합을 돌려준다.
    pub(crate) fn insert_code_labels(
        &self,
        tree: &mut PageLayoutContext,
        col_node: &mut RenderNode,
        line_node: &mut RenderNode,
        ln: CodeLabelLine<'_>,
    ) -> f64 {
        let para = ln.para;
        let gaps = para.gap_codes();
        let slots: Vec<SlotLabel> = para.slot_labels();
        if gaps.is_empty() && slots.is_empty() {
            return 0.0;
        }
        let text_positions = para.control_text_positions();
        let text_len = para.text.chars().count();
        let inline: Vec<(usize, usize)> = para
            .controls
            .iter()
            .enumerate()
            .filter(|(_, c)| c.is_logical_inline())
            .map(|(i, _)| (i, text_positions.get(i).copied().unwrap_or(text_len).min(text_len)))
            .collect();
        let logical_positions = para.logical_control_positions();
        // 글자 s 의 논리 자리 — 그 글자 앞(같은 글자 번호 포함)의 칸 차지 개체 수만큼 밀린다
        let logical_of_char = |s: usize| s + inline.iter().filter(|(_, p)| *p <= s).count();
        let in_line = |k: usize| (k >= ln.line_start && k < ln.line_end) || (k == ln.line_end && ln.owns_end);

        // 이 줄 글 조각의 글자 경계값
        struct RunGeom {
            start: usize,
            count: usize,
            x: f64,
            positions: Vec<f64>,
        }
        let runs: Vec<RunGeom> = line_node
            .children
            .iter()
            .filter_map(|c| {
                let (start, count) = text_run_span(c)?;
                let RenderNodeType::TextRun(tr) = &c.node_type else { return None };
                if tr.section_index != Some(ln.section_index) {
                    return None;
                }
                Some(RunGeom { start, count, x: c.bbox.x, positions: tr.replay_positions_for(&tr.text).into_owned() })
            })
            .collect();
        // 글자 k 앞 x — 그 글자를 품은 조각 > 빈 조각 > 앞 조각 끝
        let char_x = |k: usize| -> Option<f64> {
            if let Some(r) = runs.iter().find(|r| r.start <= k && k < r.start + r.count) {
                return Some(r.x + r.positions.get(k - r.start).copied().unwrap_or(0.0));
            }
            if let Some(r) = runs.iter().find(|r| r.count == 0 && r.start == k) {
                return Some(r.x);
            }
            runs.iter()
                .filter(|r| r.start + r.count <= k && r.count > 0)
                .map(|r| r.x + r.positions.last().copied().unwrap_or(0.0))
                .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))))
        };
        // 글자 p 바로 뒤 x (p 를 품은 조각 안에서)
        let char_end_x = |p: usize| -> Option<f64> {
            runs.iter()
                .find(|r| r.start <= p && p < r.start + r.count)
                .map(|r| r.x + r.positions.get(p - r.start + 1).copied().unwrap_or(0.0))
        };
        // 칸 차지 개체 ci 의 상자(이 줄 노드 → 단 노드의 글자처럼 취급한 표 → 인라인 도형 자리)
        // 칸 차지 개체 ci 의 칸(바깥 여백 포함 — 다음 글자가 시작하는 자리까지) (왼쪽 x, 폭).
        // 이 줄 노드 → 단 노드의 글자처럼 취급한 표 → 인라인 도형 자리
        let margins = |ci: usize| -> (f64, f64) {
            use super::paragraph_layout::tac_object_outer_margins_px;
            match para.controls.get(ci) {
                Some(Control::Table(t)) => (
                    crate::renderer::hwpunit_to_px(t.outer_margin_left as i32, self.dpi),
                    crate::renderer::hwpunit_to_px(t.outer_margin_right as i32, self.dpi),
                ),
                Some(Control::Picture(p)) => {
                    let m = tac_object_outer_margins_px(&p.common, self.dpi);
                    (m.0, m.1)
                }
                Some(Control::Shape(s)) => {
                    let m = tac_object_outer_margins_px(s.common(), self.dpi);
                    (m.0, m.1)
                }
                Some(Control::Equation(e)) => {
                    // [hwpx-cowork] The equation's flow includes its outer
                    // margins. Its slot label belongs after that full frame,
                    // immediately before the following text (codes oracle).
                    let m = tac_object_outer_margins_px(&e.common, self.dpi);
                    (m.0, m.1)
                }
                _ => (0.0, 0.0),
            }
        };
        let object_box = |line_node: &RenderNode, col_node: &RenderNode, tree: &PageLayoutContext, ci: usize| -> Option<(f64, f64)> {
            let (ml, mr) = margins(ci);
            if let Some(n) = line_node.children.iter().find(|c| node_control_index(c, ln.para_index) == Some(ci)) {
                return Some((n.bbox.x - ml, n.bbox.width + ml + mr));
            }
            if ln.cell_ctx.is_none() {
                if let Some(n) = col_node.children.iter().rev().find(|c| {
                    matches!(&c.node_type, RenderNodeType::Table(t)
                        if t.para_index == Some(ln.para_index) && t.control_index == Some(ci) && t.section_index == Some(ln.section_index))
                }) {
                    return Some((n.bbox.x - ml, n.bbox.width + ml + mr));
                }
            }
            if let Some(Control::Shape(s)) = para.controls.get(ci) {
                if let Some((x, _)) = tree.get_inline_shape_position(ln.section_index, ln.para_index, ci, ln.cell_ctx.as_ref()) {
                    let w = crate::renderer::hwpunit_to_px(s.common().width as i32, self.dpi);
                    return Some((x - ml, w + ml + mr));
                }
            }
            None
        };
        let label = |text: &str, char_shape_id: u32, key: (usize, usize), anchor_x: f64, marker: FieldMarkerType| -> PendingLabel {
            let style = code_label_style(ln.styles, char_shape_id);
            let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
            let positions = code_label_positions(text, style.font_size * ratio);
            PendingLabel { key, anchor_x, text: text.to_string(), style, positions, marker }
        };

        let mut labels: Vec<PendingLabel> = Vec::new();
        // (1) 틈 부호 — 틈 뒤 칸(글자 또는 개체) 앞
        let mut gap_index = 0usize;
        let mut prev_logical = usize::MAX;
        // 빈 누름틀 안내문이 있는 틈: 그 필드 시작까지는 안내문 앞, 뒤는 안내문 뒤(= 틈 뒤 칸 x)
        for g in gaps.iter() {
            if g.logical != prev_logical {
                gap_index = 0;
                prev_logical = g.logical;
            } else {
                gap_index += 1;
            }
            if !in_line(g.text_pos) {
                continue;
            }
            let next_inline = inline
                .iter()
                .find(|(ci, _)| logical_positions.get(*ci).copied() == Some(g.logical))
                .map(|(ci, _)| *ci);
            let mut anchor = next_inline
                .and_then(|ci| object_box(line_node, col_node, tree, ci).map(|(x, _)| x))
                .or_else(|| char_x(g.text_pos))
                .unwrap_or(line_node.bbox.x);
            // 빈 누름틀 안내문: 같은 틈에서 그 필드 시작(포함)까지는 안내문 앞
            for &(field_ci, gx, _) in ln.guides {
                let begin_idx = gaps
                    .iter()
                    .filter(|o| o.logical == g.logical)
                    .position(|o| o.item == GapCodeItem::Control(field_ci));
                if let Some(bi) = begin_idx {
                    if gap_index <= bi {
                        anchor = gx;
                    }
                }
            }
            let cs = para.char_shape_at_stream(para.gap_code_stream_pos(g));
            labels.push(label(
                &g.label,
                cs,
                (2 * g.logical, gap_index),
                anchor,
                FieldMarkerType::CodeLabel(g.logical, gap_index),
            ));
        }
        // (2) 칸 뒤 표지 — 개체·각주·자동 번호 다음
        let utf16 = para.control_utf16_positions();
        for s in slots.iter() {
            let anchor = match s.placeholder_char {
                Some(p) => {
                    if !(p >= ln.line_start && p < ln.line_end) {
                        continue;
                    }
                    match char_end_x(p) {
                        Some(x) => x,
                        None => continue,
                    }
                }
                None => match object_box(line_node, col_node, tree, s.control_idx) {
                    Some((x, w)) => {
                        // 이 줄 것인지: 개체 자리가 이 줄 글자 범위
                        let tp = text_positions.get(s.control_idx).copied().unwrap_or(text_len);
                        if !in_line(tp) {
                            continue;
                        }
                        x + w
                    }
                    None => continue,
                },
            };
            let cs = para.char_shape_at_stream(utf16.get(s.control_idx).copied().unwrap_or(0));
            labels.push(label(&s.label, cs, (2 * s.logical + 1, 0), anchor, FieldMarkerType::SlotLabel(s.logical)));
        }
        if labels.is_empty() {
            return 0.0;
        }
        labels.sort_by_key(|l| l.key);

        // (3) 글 조각이 표지 자리를 가운데 품으면 나눈다
        let mut cuts: Vec<usize> = Vec::new();
        for g in gaps.iter().filter(|g| in_line(g.text_pos)) {
            cuts.push(g.text_pos);
        }
        for s in slots.iter() {
            if let Some(p) = s.placeholder_char {
                cuts.push(p + 1);
            }
        }
        cuts.sort_unstable();
        cuts.dedup();
        if !cuts.is_empty() {
            let old = std::mem::take(&mut line_node.children);
            for child in old {
                let Some((s, n)) = text_run_span(&child) else {
                    line_node.children.push(child);
                    continue;
                };
                let inner: Vec<usize> = cuts.iter().copied().filter(|&k| k > s && k < s + n).collect();
                let splittable = match &child.node_type {
                    RenderNodeType::TextRun(tr) => {
                        tr.char_overlap.is_none()
                            && tr.style.tab_leaders.is_empty()
                            && tr.display_text.as_ref().map_or(true, |d| d.chars().count() == n)
                            && tr.rotation == 0.0
                            && !tr.is_vertical
                    }
                    _ => false,
                };
                if inner.is_empty() || !splittable {
                    line_node.children.push(child);
                    continue;
                }
                let RenderNodeType::TextRun(tr) = &child.node_type else { unreachable!() };
                let pos = tr.replay_positions_for(&tr.text).into_owned();
                let chars: Vec<char> = tr.text.chars().collect();
                let disp: Option<Vec<char>> = tr.display_text.as_ref().map(|d| d.chars().collect());
                let mut bounds = vec![0usize];
                bounds.extend(inner.iter().map(|k| k - s));
                bounds.push(n);
                for w in bounds.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    let mut piece = child.clone();
                    piece.id = tree.next_id();
                    let pa = pos.get(a).copied().unwrap_or(0.0);
                    let pb = pos.get(b).copied().unwrap_or(pa);
                    piece.bbox.x = child.bbox.x + pa;
                    piece.bbox.width = (pb - pa).max(0.0);
                    if let RenderNodeType::TextRun(pt) = &mut piece.node_type {
                        pt.text = chars[a..b].iter().collect();
                        pt.display_text = disp.as_ref().map(|d| d[a..b].iter().collect());
                        pt.char_start = Some(s + a);
                        pt.layout_positions = Some(pos[a..=b].iter().map(|v| v - pa).collect());
                        pt.style.line_x_offset += pa;
                        if b != n {
                            pt.is_para_end = false;
                            pt.is_line_break_end = false;
                        }
                    }
                    line_node.children.push(piece);
                }
            }
        }

        // (4) 표지 자리 — 앞 표지 폭만큼 밀린 자리
        let mut placed: Vec<(f64, f64)> = Vec::with_capacity(labels.len());
        let mut acc = 0.0;
        for l in labels.iter() {
            let w = l.positions.last().copied().unwrap_or(0.0);
            placed.push((l.anchor_x + acc, w));
            acc += w;
        }
        let total = acc;
        let shift_for_key = |key: (usize, usize)| -> f64 {
            labels.iter().zip(placed.iter()).filter(|(l, _)| l.key < key).map(|(_, p)| p.1).sum()
        };
        let shift_for_x = |x: f64| -> f64 {
            labels.iter().zip(placed.iter()).filter(|(l, _)| l.anchor_x <= x + 0.01).map(|(_, p)| p.1).sum()
        };
        let inline_logical = |ci: usize| -> Option<usize> {
            para.controls.get(ci).filter(|c| c.is_logical_inline()).and(logical_positions.get(ci).copied())
        };

        // (5) 뒤 노드 밀기
        for child in line_node.children.iter_mut() {
            let key = match &child.node_type {
                RenderNodeType::TextRun(tr) if tr.field_marker == FieldMarkerType::None && tr.char_start.is_some() => {
                    Some((2 * logical_of_char(tr.char_start.unwrap_or(0)), usize::MAX))
                }
                _ => node_control_index(child, ln.para_index).and_then(inline_logical).map(|l| (2 * l, usize::MAX)),
            };
            let dx = match key {
                Some(k) => shift_for_key(k),
                None => shift_for_x(child.bbox.x),
            };
            translate_subtree_x(child, dx);
        }
        // 글자처럼 취급한 표(단 노드)·인라인 도형(뒤 패스가 그린다)
        for (ci, _) in inline.iter() {
            let Some(l) = logical_positions.get(*ci).copied() else { continue };
            let tp = text_positions.get(*ci).copied().unwrap_or(text_len);
            if !in_line(tp) {
                continue;
            }
            let dx = shift_for_key((2 * l, usize::MAX));
            if dx == 0.0 {
                continue;
            }
            match para.controls.get(*ci) {
                Some(Control::Table(_)) if ln.cell_ctx.is_none() => {
                    if let Some(n) = col_node.children.iter_mut().rev().find(|c| {
                        matches!(&c.node_type, RenderNodeType::Table(t)
                            if t.para_index == Some(ln.para_index) && t.control_index == Some(*ci) && t.section_index == Some(ln.section_index))
                    }) {
                        translate_subtree_x(n, dx);
                    }
                    if let Some((x, y)) = tree.get_inline_shape_position(ln.section_index, ln.para_index, *ci, None) {
                        tree.set_inline_shape_position(ln.section_index, ln.para_index, *ci, None, x + dx, y);
                    }
                }
                Some(Control::Shape(_)) => {
                    if let Some((x, y)) = tree.get_inline_shape_position(ln.section_index, ln.para_index, *ci, ln.cell_ctx.as_ref()) {
                        tree.set_inline_shape_position(ln.section_index, ln.para_index, *ci, ln.cell_ctx.as_ref(), x + dx, y);
                    }
                }
                _ => {}
            }
        }

        // (6) 문단 끝 표시(↵·↓)는 표지 뒤로
        let end_idx = line_node.children.iter().position(|c| {
            matches!(&c.node_type, RenderNodeType::TextRun(tr) if (tr.is_para_end || tr.is_line_break_end) && tr.field_marker == FieldMarkerType::None)
        });
        if let Some(ei) = end_idx {
            let end_x = line_node.children[ei].bbox.x + line_node.children[ei].bbox.width;
            let last_label_right = placed
                .iter()
                .filter(|(x, _)| *x + 0.01 >= end_x)
                .map(|(x, w)| x + w)
                .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))));
            if let Some(right) = last_label_right {
                let mut end = line_node.children[ei].clone();
                if let RenderNodeType::TextRun(tr) = &mut line_node.children[ei].node_type {
                    tr.is_para_end = false;
                    tr.is_line_break_end = false;
                }
                end.id = tree.next_id();
                end.bbox.x = right;
                end.bbox.width = 0.0;
                end.children.clear();
                if let RenderNodeType::TextRun(tr) = &mut end.node_type {
                    let start = tr.char_start.unwrap_or(0) + tr.text.chars().count();
                    tr.char_start = Some(start);
                    tr.text = String::new();
                    tr.display_text = None;
                    tr.layout_positions = None;
                    tr.char_overlap = None;
                    tr.border_fill_id = 0;
                    tr.style.tab_leaders.clear();
                }
                line_node.children.push(end);
            }
        }

        // (6b) 틈 끝 캐럿 자리(기본 캐럿 = 부호 뒤·다음 글자 앞): 글자 k 에서 시작하는 조각 앞에 폭 없는 자리 조각을 둔다 —
        // 캐럿 조회가 같은 자리에서 끝나는 앞 조각(표지 앞)을 먼저 집지 않게(빈 누름틀 앵커와 같은 방식)
        let mut anchor_ks: Vec<usize> = gaps.iter().filter(|g| in_line(g.text_pos)).map(|g| g.text_pos).collect();
        // 자동 번호(쪽 번호 등)는 번호 + 표지가 한 부호 — 그 뒤 캐럿은 표지 뒤
        anchor_ks.extend(slots.iter().filter_map(|s| s.placeholder_char).map(|p| p + 1).filter(|k| in_line(*k)));
        anchor_ks.sort_unstable();
        anchor_ks.dedup();
        for k in anchor_ks {
            let starts_here = line_node.children.iter().find(|c| {
                matches!(&c.node_type, RenderNodeType::TextRun(tr)
                    if tr.field_marker == FieldMarkerType::None && tr.char_start == Some(k) && !tr.text.is_empty())
            });
            let Some(src) = starts_here else { continue };
            let mut anchor = src.clone();
            anchor.id = tree.next_id();
            anchor.bbox.width = 0.0;
            anchor.children.clear();
            if let RenderNodeType::TextRun(tr) = &mut anchor.node_type {
                tr.text = String::new();
                tr.display_text = None;
                tr.layout_positions = None;
                tr.char_overlap = None;
                tr.border_fill_id = 0;
                tr.is_para_end = false;
                tr.is_line_break_end = false;
                tr.style.tab_leaders.clear();
            }
            line_node.children.push(anchor);
        }

        // (7) 표지 노드
        for (l, (x, w)) in labels.into_iter().zip(placed.into_iter()) {
            let node = RenderNode::new(
                tree.next_id(),
                RenderNodeType::TextRun(TextRunNode {
                    text: l.text,
                    style: l.style,
                    char_shape_id: None,
                    para_shape_id: None,
                    section_index: Some(ln.section_index),
                    para_index: Some(ln.para_index),
                    char_start: None,
                    cell_context: ln.cell_ctx.clone(),
                    is_para_end: false,
                    is_line_break_end: false,
                    rotation: 0.0,
                    is_vertical: false,
                    char_overlap: None,
                    border_fill_id: 0,
                    baseline: ln.baseline,
                    field_marker: l.marker,
                    layout_positions: Some(l.positions),
                    display_text: None,
                }),
                BoundingBox::new(x, ln.y, w, ln.line_height),
            )
            .with_editor_only();
            line_node.children.push(node);
        }
        total
    }
}

impl LayoutEngine {
    /// [hwpx-cowork] 글자처럼 취급한 표를 품은 문단(글 조각이 단 노드에 바로 들어간다) — 같은 y 의 조각을 한 줄로 묶어 표지를 끼운다
    pub(crate) fn insert_code_labels_inline_table_para(
        &self,
        tree: &mut PageLayoutContext,
        col_node: &mut RenderNode,
        first_child: usize,
        para: &Paragraph,
        styles: &ResolvedStyleSet,
        section_index: usize,
        para_index: usize,
    ) {
        if first_child > col_node.children.len() {
            return;
        }
        // 이 문단의 글 조각·각주 표지(표 노드는 단 노드에 남긴다)
        let mine = |c: &RenderNode| match &c.node_type {
            RenderNodeType::TextRun(tr) => tr.para_index == Some(para_index) && tr.section_index == Some(section_index) && tr.cell_context.is_none(),
            RenderNodeType::FootnoteMarker(m) => m.para_index == para_index,
            _ => false,
        };
        let mut taken: Vec<RenderNode> = Vec::new();
        let mut rest: Vec<RenderNode> = Vec::new();
        for c in col_node.children.drain(first_child..) {
            if mine(&c) {
                taken.push(c);
            } else {
                rest.push(c);
            }
        }
        col_node.children.extend(rest);
        if taken.is_empty() {
            return;
        }
        // y 로 줄 묶기
        let mut ys: Vec<f64> = Vec::new();
        for c in &taken {
            if !ys.iter().any(|y| (y - c.bbox.y).abs() < 0.5) {
                ys.push(c.bbox.y);
            }
        }
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let text_len = para.text.chars().count();
        let last_y = *ys.last().unwrap_or(&0.0);
        let mut out: Vec<RenderNode> = Vec::new();
        for (gi, y) in ys.iter().enumerate() {
            let mut line = RenderNode::new(tree.next_id(), RenderNodeType::Column(0), BoundingBox::new(0.0, *y, 0.0, 0.0));
            let mut i = 0;
            while i < taken.len() {
                if (taken[i].bbox.y - y).abs() < 0.5 {
                    line.children.push(taken.remove(i));
                } else {
                    i += 1;
                }
            }
            let spans: Vec<(usize, usize)> = line.children.iter().filter_map(text_run_span).collect();
            let line_start = if gi == 0 { 0 } else { spans.iter().map(|s| s.0).min().unwrap_or(0) };
            let line_end = if (*y - last_y).abs() < 0.5 { text_len } else { spans.iter().map(|s| s.0 + s.1).max().unwrap_or(line_start) };
            let (lh, base) = line
                .children
                .iter()
                .find_map(|c| match &c.node_type {
                    RenderNodeType::TextRun(tr) => Some((c.bbox.height, tr.baseline)),
                    _ => None,
                })
                .unwrap_or((16.0, 13.0));
            line.bbox.x = line.children.iter().map(|c| c.bbox.x).fold(f64::INFINITY, f64::min);
            let none_ctx: Option<CellContext> = None;
            self.insert_code_labels(
                tree,
                col_node,
                &mut line,
                CodeLabelLine {
                    para,
                    styles,
                    line_start,
                    line_end,
                    owns_end: (*y - last_y).abs() < 0.5,
                    guides: &[],
                    section_index,
                    para_index,
                    cell_ctx: &none_ctx,
                    y: *y,
                    line_height: lh,
                    baseline: base,
                },
            );
            out.extend(line.children);
        }
        col_node.children.extend(out);
    }
}

impl LayoutEngine {
    /// [hwpx-cowork] 표 쪽 항목으로 따로 놓인 글자처럼 취급한 표(표만 든 문단 등) — 조판 부호 보기면 표 바로 뒤(바깥 여백 다음)에
    /// `[표]` 표지를 둔다(한/글 `가나[표] [표]다라`). 표 줄의 기준선(표 높이의 85%)에 앉힌다.
    pub(crate) fn push_tac_table_slot_label(
        &self,
        tree: &mut PageLayoutContext,
        col_node: &mut RenderNode,
        para: &Paragraph,
        styles: &ResolvedStyleSet,
        section_index: usize,
        para_index: usize,
        control_index: usize,
    ) {
        let Some(Control::Table(t)) = para.controls.get(control_index) else { return };
        if !t.common.treat_as_char {
            return;
        }
        let Some(logical) = para.logical_control_positions().get(control_index).copied() else { return };
        let marker = FieldMarkerType::SlotLabel(logical);
        let already = |n: &RenderNode| {
            matches!(&n.node_type, RenderNodeType::TextRun(tr)
                if tr.field_marker == marker && tr.para_index == Some(para_index) && tr.section_index == Some(section_index) && tr.cell_context.is_none())
        };
        if col_node.children.iter().any(|c| already(c) || c.children.iter().any(already)) {
            return;
        }
        let Some(tb) = col_node.children.iter().rev().find(|c| {
            matches!(&c.node_type, RenderNodeType::Table(n)
                if n.para_index == Some(para_index) && n.control_index == Some(control_index) && n.section_index == Some(section_index))
        }).map(|c| c.bbox) else { return };
        let om_r = crate::renderer::hwpunit_to_px(t.outer_margin_right as i32, self.dpi);
        let cs = para.char_shape_at_stream(para.control_utf16_positions().get(control_index).copied().unwrap_or(0));
        let style = code_label_style(styles, cs);
        let ratio = if style.ratio > 0.0 { style.ratio } else { 1.0 };
        let positions = code_label_positions("[표]", style.font_size * ratio);
        let w = positions.last().copied().unwrap_or(0.0);
        let node = RenderNode::new(
            tree.next_id(),
            RenderNodeType::TextRun(TextRunNode {
                text: "[표]".to_string(),
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
                baseline: tb.height * 0.85,
                field_marker: marker,
                layout_positions: Some(positions),
                display_text: None,
            }),
            BoundingBox::new(tb.x + tb.width + om_r, tb.y, w, tb.height),
        )
        .with_editor_only();
        col_node.children.push(node);
    }
}
