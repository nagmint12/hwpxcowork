//! 떠 있는 수식의 선언 프레임과 표시 내용 상자를 분리한다.

use crate::model::{control::Equation, style::Alignment};
use crate::renderer::equation::{self, inline_box};
use crate::renderer::hwpunit_to_px;
use crate::renderer::page_layout::LayoutRect;
use crate::renderer::render_tree::{
    BoundingBox, EquationNode, PageLayoutContext, RenderNode, RenderNodeType,
};

use super::LayoutEngine;

impl LayoutEngine {
    /// 실제 개체의 기준 영역·정렬·부호 있는 오프셋을 공통 배치 계약으로 해소한다.
    /// 선언 프레임은 정렬에, 논리 내용 상자는 수식 표시와 기준선에 사용한다.
    /// 이미 줄에 등록된 인라인 수식의 소유는 호출자가 유지한다.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn layout_floating_equation(
        &self,
        tree: &mut PageLayoutContext,
        parent: &mut RenderNode,
        eq: &Equation,
        section_index: usize,
        para_index: usize,
        control_index: usize,
        col_area: &LayoutRect,
        body_area: &LayoutRect,
        paper_area: &LayoutRect,
        para_y: f64,
        alignment: Alignment,
    ) {
        let horizontal = inline_box::horizontal_metrics(eq);
        let eq_h = hwpunit_to_px(equation::flow_height_hwp(eq) as i32, self.dpi);
        let (frame_w, frame_h) = if eq.common.treat_as_char {
            // 별도 인라인 좌표가 없는 경로의 기존 문단 정렬을 유지한다.
            (
                hwpunit_to_px(horizontal.occupied_width_hwp(), self.dpi),
                eq_h,
            )
        } else {
            self.resolve_object_size(&eq.common, col_area, body_area, paper_area)
        };
        let (eq_x, eq_y) = self.compute_object_position(
            &eq.common, frame_w, frame_h, col_area, col_area, body_area, paper_area, para_y,
            alignment,
        );

        let font_size_px = hwpunit_to_px(eq.font_size as i32, self.dpi);
        let equation::PaintParts {
            layout_box,
            color_str,
            svg_content,
        } = equation::paint_parts(eq, self.dpi);
        parent.children.push(RenderNode::new(
            tree.next_id(),
            RenderNodeType::Equation(EquationNode {
                svg_content,
                layout_box,
                color_str,
                color: eq.color,
                script: eq.script.clone(),
                font_size: font_size_px,
                section_index: Some(section_index),
                para_index: Some(para_index),
                control_index: Some(control_index),
                cell_index: None,
                cell_para_index: None,
                note_ref: None,
            }),
            BoundingBox::new(
                horizontal.content_origin_x(eq_x, self.dpi),
                eq_y,
                hwpunit_to_px(horizontal.content_width_hwp, self.dpi),
                eq_h,
            ),
        ));
    }

    /// [hwpx-cowork] 2026-11-10 S1: 칸 안 문단 기준 자리차지 수식을 칸 흐름 개체로 그린다
    /// (`float_placement::cell_flow_object_common` — 칸 유닛 원장·미룬 띠와 같은 개체).
    /// 가로는 칸 그릇 규칙(`nested_cell_float_x`, 그림과 같은 값), 세로는 `top` + 바깥 위 여백,
    /// `with_offset` 이면 양수 세로 오프셋까지 더한다. 나뉜 칸에서 다음 조각 맨 위로 미룬 띠는
    /// 오프셋 없이 놓인다(한/글 2022 splitCell equation v-offset 2000·90000: 수식 상자가 base 와 같은
    /// 다음 쪽 맨 위, 다음 문단 31426).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn layout_cell_flow_equation(
        &self,
        tree: &mut PageLayoutContext,
        parent: &mut RenderNode,
        eq: &Equation,
        inner_area: &LayoutRect,
        top: f64,
        with_offset: bool,
        section_index: usize,
        para_index: Option<usize>,
        control_index: usize,
        cell_index: usize,
        cell_para_index: usize,
    ) {
        let horizontal = inline_box::horizontal_metrics(eq);
        let eq_w = hwpunit_to_px(horizontal.content_width_hwp, self.dpi);
        let eq_h = hwpunit_to_px(equation::flow_height_hwp(eq) as i32, self.dpi);
        let margin_left = hwpunit_to_px(i32::from(eq.common.margin.left), self.dpi);
        let eq_x = self
            .nested_cell_float_x(&eq.common, eq_w)
            .unwrap_or(inner_area.x + margin_left);
        let offset = if with_offset {
            hwpunit_to_px(
                crate::renderer::float_placement::topbottom_flow_vertical_offset_hu(&eq.common),
                self.dpi,
            )
        } else {
            0.0
        };
        let eq_y = top + hwpunit_to_px(i32::from(eq.common.margin.top), self.dpi) + offset;
        let font_size_px = hwpunit_to_px(eq.font_size as i32, self.dpi);
        let equation::PaintParts {
            layout_box,
            color_str,
            svg_content,
        } = equation::paint_parts(eq, self.dpi);
        parent.children.push(RenderNode::new(
            tree.next_id(),
            RenderNodeType::Equation(EquationNode {
                svg_content,
                layout_box,
                color_str,
                color: eq.color,
                script: eq.script.clone(),
                font_size: font_size_px,
                section_index: Some(section_index),
                para_index,
                control_index: Some(control_index),
                cell_index: Some(cell_index),
                cell_para_index: Some(cell_para_index),
                note_ref: None,
            }),
            BoundingBox::new(eq_x, eq_y, eq_w, eq_h),
        ));
    }
}
