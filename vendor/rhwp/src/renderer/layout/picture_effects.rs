//! [hwpx-cowork] 그림 효과(그림자·네온) 그리기 — 세 그리기 경로(SVG·Canvas·CanvasKit)가 같은 결정을 쓰도록
//! 레이아웃 단계에서 **일반 사각형 노드**로 내린다(2026-11-12, h2022 개체 영역).
//!
//! 한/글 2022(12.0.0.3146) 실측 — `artifacts/h2022-object/effect_probe.py`·`effect_analyze.py`,
//! 떠 있는 그림(18000×12000HU, 단색 파랑)에 `hp:effects` 를 바꿔 넣고 CreatePageImage(144dpi)로 잰 값:
//!
//! - 그림자(`hp:shadow style="OUTSIDE"`): 그림 틀과 같은 사각형을 `direction`(도, 0 = 오른쪽, 90 = 아래, 시계 방향)
//!   쪽으로 `distance`(HWPUNIT)만큼 옮겨 그림 **뒤**에 칠한다. 불투명도 = 1 − `alpha`(alpha 는 투명도 0..1:
//!   0.5 → 회색 128, 0.2 → 51, 0.8 → 205, 0 → 색 그대로). 색 = `hp:effectsColor/hp:rgb`.
//!   `scale` 은 `alignStyle` 자리(TOP_LEFT 면 왼쪽 위)를 고정점으로 키운다(1.2 → 오른쪽 3700·아래 2500HU 더 나감).
//!   `radius`(HWPUNIT)는 흐림: 가장자리 명암 단면이 가우스 σ ≈ radius/2 에 맞는다(r600: 1·3·6·10·15·20px 에서 132·141·160·196·230·255).
//! - 네온(`hp:glow`): 그림 틀을 radius/2 + 175HU 넓힌 사각형을 σ = radius/4 로 흐려 그림 뒤에 칠한다(불투명도 1 − alpha).
//!   전체 단면 맞춤: r1000·alpha0.5 → 0.25 지점 14px·σ 5.1px, r500·alpha0 → 0.5 지점 8.7px·σ 2.5px(144dpi). 반지름 두 가지뿐이라 경험식.
//! - 효과가 그림 틀의 왼쪽·위로 나가면 한/글은 **그림을 그만큼 오른쪽·아래로 옮겨** 그린다(개체 자리 = 효과까지 넣은 상자의
//!   왼쪽 위): 그림자 135° 1000 → 14px(707HU), 네온 1000 → 20px(1000HU), 네온 500 → 10px. 흐림 폭은 옮김에 들지 않는다.
//! - 옅은 테두리(`hp:softEdge`)·반사(`hp:reflection`)·안쪽 그림자(style="INSIDE")는 아직 그리지 않는다(원장 ledger_object.md).
//!
//! 흐림은 백엔드마다 필터가 달라(SVG feGaussianBlur·Canvas filter·CanvasKit MaskFilter) 결과가 갈리므로, 여기서
//! σ 를 따라 겹친 띠 사각형(BLUR_BANDS 장)의 누적 불투명도가 가우스 단면 Φ 를 따르게 만든다 — 모든 경로가 이미 같은
//! 방식으로 그리는 '채운 사각형 + 불투명도' 만 쓴다.

use super::LayoutEngine;
use crate::model::image::{EffectColor, Picture, PictureShadow};
use crate::renderer::hwpunit_to_px;
use crate::renderer::render_tree::{
    BoundingBox, PageLayoutContext, RectangleNode, RenderNode, RenderNodeType,
};
use crate::renderer::ShapeStyle;

/// 흐림을 흉내 내는 띠 수(±2.5σ 를 0.5σ 간격).
const BLUR_BANDS: usize = 10;
const BLUR_SPAN: f64 = 2.5;

/// 한 효과 층 — 틀 기준 사각형(px), 색, 불투명도, 가우스 σ(px).
#[derive(Debug, Clone)]
pub(crate) struct EffectLayer {
    pub kind: &'static str,
    pub rect: BoundingBox,
    pub color: u32,
    pub opacity: f64,
    pub sigma: f64,
}

/// 그림 효과를 그릴 결정(공통 계산) — 그림을 옮길 양(왼쪽·위 넘침)과 그림 뒤에 칠할 층.
#[derive(Debug, Clone, Default)]
pub(crate) struct PictureEffectPlan {
    pub shift_x: f64,
    pub shift_y: f64,
    pub layers: Vec<EffectLayer>,
}

fn num(v: &Option<String>, default: f64) -> f64 {
    v.as_deref()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|x| x.is_finite())
        .unwrap_or(default)
}

fn effect_color(c: &Option<EffectColor>) -> u32 {
    let Some(rgb) = c.as_ref().and_then(|c| c.rgb.as_ref()) else {
        return 0; // 검정
    };
    let ch = |v: &Option<String>| num(v, 0.0).clamp(0.0, 255.0).round() as u32;
    ch(&rgb.r) | (ch(&rgb.g) << 8) | (ch(&rgb.b) << 16)
}

/// alignStyle 의 고정점(틀 안 비율 x, y)
fn anchor(align: Option<&str>) -> (f64, f64) {
    match align.unwrap_or("TOP_LEFT") {
        "TOP" | "CENTER_TOP" => (0.5, 0.0),
        "TOP_RIGHT" => (1.0, 0.0),
        "LEFT" | "CENTER_LEFT" => (0.0, 0.5),
        "CENTER" => (0.5, 0.5),
        "RIGHT" | "CENTER_RIGHT" => (1.0, 0.5),
        "BOTTOM_LEFT" => (0.0, 1.0),
        "BOTTOM" | "CENTER_BOTTOM" => (0.5, 1.0),
        "BOTTOM_RIGHT" => (1.0, 1.0),
        _ => (0.0, 0.0),
    }
}

fn shadow_layer(s: &PictureShadow, frame: &BoundingBox, dpi: f64) -> Option<EffectLayer> {
    if s.style.as_deref().unwrap_or("OUTSIDE") != "OUTSIDE" {
        return None; // 안쪽 그림자 미구현
    }
    let opacity = (1.0 - num(&s.alpha, 0.0)).clamp(0.0, 1.0);
    if opacity <= 0.0 {
        return None;
    }
    let hu = |v: f64| hwpunit_to_px(v.round() as i32, dpi);
    let dist = hu(num(&s.distance, 0.0));
    let dir = num(&s.direction, 0.0).to_radians();
    let (sx, sy) = s
        .scale
        .as_ref()
        .map(|p| (num(&p.x, 1.0), num(&p.y, 1.0)))
        .unwrap_or((1.0, 1.0));
    let (ax, ay) = anchor(s.align_style.as_deref());
    let w = frame.width * sx;
    let h = frame.height * sy;
    let px = frame.x + frame.width * ax - w * ax + dist * dir.cos();
    let py = frame.y + frame.height * ay - h * ay + dist * dir.sin();
    Some(EffectLayer {
        kind: "shadow",
        rect: BoundingBox::new(px, py, w, h),
        color: effect_color(&s.color),
        opacity,
        sigma: hu(num(&s.radius, 0.0)) / 2.0,
    })
}

/// 공통 계산: 그림 틀(px) → 효과 결정. 회전·대칭한 그림은 효과 틀을 함께 돌리지 못해 그리지 않는다.
pub(crate) fn plan_picture_effects(picture: &Picture, frame: &BoundingBox, dpi: f64) -> PictureEffectPlan {
    let mut plan = PictureEffectPlan::default();
    let mut layers = Vec::new();
    if let Some(glow) = &picture.effects.glow {
        let opacity = (1.0 - num(&glow.alpha, 0.0)).clamp(0.0, 1.0);
        let r = hwpunit_to_px(num(&glow.radius, 0.0).round() as i32, dpi);
        if opacity > 0.0 && r > 0.0 {
            // 넓힘 D = r/2 + 175HU, σ = r/4 — 한/글 단면(r 500·1000HU 두 가지)에 맞춘 경험식(가운데 0.87r·0.70r, σ 0.25r)
            let d = r / 2.0 + hwpunit_to_px(175, dpi);
            layers.push(EffectLayer {
                kind: "glow",
                rect: BoundingBox::new(frame.x - d, frame.y - d, frame.width + 2.0 * d, frame.height + 2.0 * d),
                color: effect_color(&glow.color),
                opacity,
                sigma: r / 4.0,
            });
            plan.shift_x = plan.shift_x.max(r);
            plan.shift_y = plan.shift_y.max(r);
        }
    }
    if let Some(s) = &picture.effects.shadow {
        if let Some(l) = shadow_layer(s, frame, dpi) {
            plan.shift_x = plan.shift_x.max(frame.x - l.rect.x);
            plan.shift_y = plan.shift_y.max(frame.y - l.rect.y);
            // 한/글: 그림자는 네온보다 뒤(먼저 칠함) — 미실측, 효과 차례(shadow → glow)를 따른다
            layers.insert(0, l);
        }
    }
    plan.layers = layers;
    plan
}

/// 표준 정규 누적 분포 근사(Abramowitz–Stegun 7.1.26)
fn phi(z: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * z.abs() / std::f64::consts::SQRT_2);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-(z * z) / 2.0).exp();
    if z >= 0.0 {
        0.5 * (1.0 + y)
    } else {
        0.5 * (1.0 - y)
    }
}

/// 흐린 층 → 겹친 띠 사각형(바깥부터). 각 띠의 누적 불투명도 1−∏(1−a) 가 opacity·Φ(−d/σ) 를 따른다.
pub(crate) fn blur_bands(layer: &EffectLayer) -> Vec<(BoundingBox, f64)> {
    if layer.sigma <= 0.05 {
        return vec![(layer.rect, layer.opacity)];
    }
    let s = layer.sigma;
    let step = 2.0 * BLUR_SPAN / BLUR_BANDS as f64;
    let mut out = Vec::with_capacity(BLUR_BANDS + 1);
    let mut prev_cum = 0.0f64;
    for k in 0..=BLUR_BANDS {
        // 띠 k 는 가장자리에서 e_k = (BLUR_SPAN − k·step)σ 만큼 넓힌 사각형 — 그 안쪽 끝 띠의 가운데 값을 목표로
        let e = (BLUR_SPAN - k as f64 * step) * s;
        let mid = if k == BLUR_BANDS { -BLUR_SPAN * s } else { e - step * s / 2.0 };
        let cum = (layer.opacity * phi(-mid / s)).min(layer.opacity);
        let a = if prev_cum >= 1.0 { 0.0 } else { 1.0 - (1.0 - cum) / (1.0 - prev_cum) };
        prev_cum = cum;
        let r = &layer.rect;
        let w = r.width + 2.0 * e;
        let h = r.height + 2.0 * e;
        if a > 0.0005 && w > 0.0 && h > 0.0 {
            out.push((BoundingBox::new(r.x - e, r.y - e, w, h), a.clamp(0.0, 1.0)));
        }
    }
    out
}

impl LayoutEngine {
    /// 그림 노드를 넣기 직전에 효과 층(그림 뒤)을 넣고, 효과의 왼쪽·위 넘침만큼 그림 노드를 옮긴다.
    /// 돌려준 (dx, dy) 는 그림과 함께 옮겨야 할 테두리·캡션 쪽이 쓴다.
    pub(crate) fn push_picture_effect_nodes(
        &self,
        tree: &mut PageLayoutContext,
        parent: &mut RenderNode,
        picture: &Picture,
        image: &mut RenderNode,
    ) -> (f64, f64) {
        let has_effects = picture.effects.shadow.is_some() || picture.effects.glow.is_some();
        if !has_effects {
            return (0.0, 0.0);
        }
        let rotated = match &image.node_type {
            RenderNodeType::Image(node) => node.transform.has_transform(),
            _ => true,
        };
        if rotated {
            return (0.0, 0.0);
        }
        let mut frame = image.bbox;
        let plan = plan_picture_effects(picture, &frame, self.dpi);
        // 글자처럼 취급한 그림은 줄 흐름 안 자리를 옮기지 않는다(한/글 미실측)
        let (dx, dy) = if picture.common.treat_as_char { (0.0, 0.0) } else { (plan.shift_x, plan.shift_y) };
        frame.x += dx;
        frame.y += dy;
        image.bbox = frame;
        for layer in &plan.layers {
            let mut layer = layer.clone();
            layer.rect.x += dx;
            layer.rect.y += dy;
            for (rect, a) in blur_bands(&layer) {
                let style = ShapeStyle {
                    fill_color: Some(layer.color),
                    opacity: a,
                    ..ShapeStyle::default()
                };
                let node = RenderNode::new(
                    tree.next_id(),
                    RenderNodeType::Rectangle(RectangleNode::new(0.0, style, None)),
                    rect,
                );
                parent.children.push(node);
            }
        }
        (dx, dy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_bands_cumulative_follows_gaussian_edge() {
        let layer = EffectLayer {
            kind: "shadow",
            rect: BoundingBox::new(0.0, 0.0, 100.0, 100.0),
            color: 0,
            opacity: 0.5,
            sigma: 6.0,
        };
        let bands = blur_bands(&layer);
        let at = |d: f64| {
            // 오른쪽 가장자리 바깥 d px(세로 가운데)의 누적 불투명도
            let x = 100.0 + d;
            1.0 - bands
                .iter()
                .filter(|(r, _)| x >= r.x && x <= r.x + r.width)
                .fold(1.0, |acc, (_, a)| acc * (1.0 - a))
        };
        assert!((at(-20.0) - 0.5).abs() < 0.02);
        assert!((at(0.5) - 0.25).abs() < 0.08);
        assert!(at(20.0) < 0.01);
    }
}
