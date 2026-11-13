//! [hwpx-cowork] 묶음(그룹) 개체의 조판 높이 = 자식 범위 — 한/글 2022 실측 규칙.
//!
//! 한/글은 묶음이 차지하는 높이를 `hp:sz` 가 아니라 자식들이 실제로 덮는 범위로 잡는다
//! (조판 회귀 2026-11-03 묶음 시험지: sz 24000×16000 묶음 안 12000×6000 자식 하나 →
//! 다음 문단 9960 = 앞 3960 + 6000. 한/글 재저장본도 sz 16000·curSz 0 그대로인데 같은 자리).
//!
//! 자식 그리기는 자식 자신의 렌더 행렬(`render_tx`·`render_sx` …, 묶음 원점 기준)로 하므로 묶음
//! `common.height` 를 바꿔도 그림은 흔들리지 않는다 — 흐름(자리차지 높이)만 바뀐다. 한/글이 만든
//! 문서는 sz 가 자식 범위와 같아 바뀌지 않는다. 자식 범위가 sz 보다 **작을 때만** 줄이고, 지정
//! 높이는 `auto_grow_base_height` 에 보관해 저장(`hp:sz`)은 그대로 둔다.

use crate::document_core::DocumentCore;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{GroupShape, ShapeObject};

impl DocumentCore {
    /// 문서의 맨 위 묶음 개체(본문·표 칸·글상자 안·머리말·꼬리말·각주·미주·바탕쪽)의 조판 높이를 자식 범위로 맞춘다.
    pub(crate) fn fit_groups_to_children(document: &mut Document) {
        for section in &mut document.sections {
            fit_in_paragraphs(&mut section.paragraphs, 0);
            for master in &mut section.section_def.master_pages {
                fit_in_paragraphs(&mut master.paragraphs, 0);
            }
        }
    }
}

fn fit_in_paragraphs(paragraphs: &mut [Paragraph], depth: usize) {
    if depth > 6 {
        return;
    }
    for para in paragraphs {
        for ctrl in &mut para.controls {
            match ctrl {
                Control::Shape(shape) => match shape.as_mut() {
                    ShapeObject::Group(group) => fit_group(group),
                    ShapeObject::Rectangle(rect) => {
                        if let Some(tb) = rect.drawing.text_box.as_mut() {
                            fit_in_paragraphs(&mut tb.paragraphs, depth + 1);
                        }
                    }
                    _ => {}
                },
                Control::Table(table) => {
                    for cell in &mut table.cells {
                        fit_in_paragraphs(&mut cell.paragraphs, depth + 1);
                    }
                }
                Control::Header(h) => fit_in_paragraphs(&mut h.paragraphs, depth + 1),
                Control::Footer(f) => fit_in_paragraphs(&mut f.paragraphs, depth + 1),
                Control::Footnote(n) => fit_in_paragraphs(&mut n.paragraphs, depth + 1),
                Control::Endnote(n) => fit_in_paragraphs(&mut n.paragraphs, depth + 1),
                _ => {}
            }
        }
    }
}

/// 자식 렌더 행렬로 잰 세로 범위(위, 아래 HWPUNIT, 묶음 원점 기준). 묶음 자식은 그 자식들까지.
fn children_vertical_extent(children: &[ShapeObject], depth: usize) -> Option<(f64, f64)> {
    let mut out: Option<(f64, f64)> = None;
    for child in children {
        let ext = match child {
            ShapeObject::Group(g) if depth < 6 => children_vertical_extent(&g.children, depth + 1),
            _ => {
                let sa = child.shape_attr();
                let (w, h) = (sa.original_width as f64, sa.original_height as f64);
                if w <= 0.0 && h <= 0.0 {
                    None
                } else {
                    // y' = c·x + d·y + ty (render_c, render_sy, render_ty)
                    let ys = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)]
                        .map(|(x, y)| sa.render_c * x + sa.render_sy * y + sa.render_ty);
                    let (lo, hi) = ys.into_iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), y| {
                        (lo.min(y), hi.max(y))
                    });
                    lo.is_finite().then_some((lo, hi))
                }
            }
        };
        if let Some((lo, hi)) = ext {
            out = Some(match out {
                Some((a, b)) => (a.min(lo), b.max(hi)),
                None => (lo, hi),
            });
        }
    }
    out
}

fn fit_group(group: &mut GroupShape) {
    let common = &mut group.common;
    if common.treat_as_char || common.height == 0 || common.auto_grow_base_height.is_some() {
        return;
    }
    // [hwpx-cowork] 2026-11-04 자식이 둘 이상이면 한/글은 자식 범위를 묶음 sz 에 맞춰 늘이고
    // 줄여 그리므로(렌더 `fit_group_children_to_size`) 흐름도 sz 다. 자식 하나짜리 묶음만 맞추지
    // 않고 자식 범위로 자리를 잡는다(probe grp: 1자식 sz 16000·32000 모두 자식 크기, 2자식은 sz).
    if group.children.len() != 1 {
        return;
    }
    let Some((top, bottom)) = children_vertical_extent(&group.children, 0) else {
        return;
    };
    // 자식이 묶음 위끝에서 시작하는 보통 꼴만(행렬을 못 읽은 이상한 값은 건드리지 않는다).
    if top < -1.0 || top > 1.0 || bottom <= 0.0 {
        return;
    }
    let fitted = bottom.round() as u32;
    if fitted + 1 >= common.height {
        return;
    }
    common.auto_grow_base_height = Some(common.height);
    common.height = fitted;
}
