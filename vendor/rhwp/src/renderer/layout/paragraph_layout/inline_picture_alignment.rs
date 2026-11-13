//! 한 줄 소유 그림·도형의 상자를 공통 글줄 기준선에 맞춘다.

use super::{tac_object_box_height_px, tac_object_outer_margins_px, tac_picture_outer_margins_px};
use crate::model::{control::Control, image::Picture, paragraph::Paragraph, shape::ShapeObject};
use crate::renderer::style_resolver::ResolvedStyleSet;
use crate::renderer::{hwpunit_to_px, layout::LayoutEngine};

impl LayoutEngine {
    pub(super) fn inline_picture_top(
        &self,
        para: Option<&Paragraph>,
        styles: &ResolvedStyleSet,
        line_offsets: &[(usize, f64, usize)],
        line_y: f64,
        baseline: f64,
        picture: &Picture,
    ) -> f64 {
        // 줄 구성에 제공한 상자로 정렬한다. Paper/Page 비율의 인쇄 크기로
        // 다시 계산하면 저장 줄의 기준선과 서로 다른 크기를 빼게 된다.
        let box_height = self.inline_picture_box_height(picture);
        self.inline_object_top(para, styles, line_offsets, line_y, baseline, box_height)
    }

    pub(super) fn inline_shape_top(
        &self,
        para: Option<&Paragraph>,
        styles: &ResolvedStyleSet,
        line_offsets: &[(usize, f64, usize)],
        line_y: f64,
        baseline: f64,
        shape: &ShapeObject,
    ) -> f64 {
        let grown_box = self.inline_shape_box_height(shape);
        let top = self.inline_object_top(para, styles, line_offsets, line_y, baseline, grown_box);
        // [hwpx-cowork] 글상자 자동 늘림(`auto_grow_base_height`)은 한/글이 **아래로** 늘린다. 줄이 지정
        // 높이로 구성됐으면(표 칸·캡션·미주 등 — 줄 기준선 위에 늘어난 상자가 들어가지 않음) 지정 상자로
        // 기준선에 앉히고 늘어난 몫은 아래로 둔다. 한/글 2022 실측(조판 회귀 A 생성본 글자처럼 글상자 6000→7606,
        // 칸·캡션·미주): 상자 위 = 줄 위(190·277·272 ↔ 줄 188.8·276.4·271.4). 0.9.0 은 늘어난 상자로 맞춰
        // 상자가 줄 위로 18px 올라갔다. 본문처럼 줄이 늘어난 높이로 구성됐으면 종전 그대로다.
        let common = shape.common();
        if let Some(base) = common.auto_grow_base_height {
            if base < common.height && top < line_y - 0.5 {
                let grown_px = hwpunit_to_px(shape.flow_height_hu(), self.dpi);
                let base_px = hwpunit_to_px(base as i32, self.dpi);
                let base_box = (grown_box - (grown_px - base_px)).max(0.0);
                return self.inline_object_top(
                    para,
                    styles,
                    line_offsets,
                    line_y,
                    baseline,
                    base_box,
                );
            }
        }
        top
    }

    fn inline_object_top(
        &self,
        para: Option<&Paragraph>,
        styles: &ResolvedStyleSet,
        line_offsets: &[(usize, f64, usize)],
        line_y: f64,
        baseline: f64,
        box_height: f64,
    ) -> f64 {
        // HWP 5.0 표 44의 줄 안 정렬점이다. 글꼴 기준인 상자의 어센트와
        // 실제 줄 기준선을 맞추며, 도형을 문단 top이나 상자 하단에 다시 붙이지 않는다.
        let alignment = para
            .and_then(|p| styles.para_styles.get(p.para_shape_id as usize))
            .map_or(0, |style| style.vertical_alignment);
        let ascent_ratio = crate::renderer::composer::inline_picture_ascent_ratio(alignment);
        let baseline = if baseline > 0.0 {
            baseline
        } else {
            // 기준선 없는 줄도 같은 줄에 소속한 개체 상자만 소비한다.
            let tallest = line_offsets
                .iter()
                .filter_map(|(_, _, control)| match para?.controls.get(*control)? {
                    Control::Picture(picture) => Some(self.inline_picture_box_height(picture)),
                    Control::Shape(shape) => Some(self.inline_shape_box_height(shape)),
                    _ => None,
                })
                .fold(box_height, f64::max);
            tallest * ascent_ratio
        };
        line_y + baseline - box_height * ascent_ratio
    }

    fn inline_shape_box_height(&self, shape: &ShapeObject) -> f64 {
        let (_, _, top, bottom) = tac_object_outer_margins_px(shape.common(), self.dpi);
        tac_object_box_height_px(
            hwpunit_to_px(shape.flow_height_hu(), self.dpi),
            &crate::renderer::composer::shape_caption_for_layout(shape),
            self.dpi,
        ) + top
            + bottom
    }

    fn inline_picture_box_height(&self, picture: &Picture) -> f64 {
        let (_, height_hu) = crate::renderer::composer::inline_picture_size_hu(picture);
        let (_, _, top, bottom) = tac_picture_outer_margins_px(picture, self.dpi);
        tac_object_box_height_px(
            hwpunit_to_px(height_hu, self.dpi),
            &picture.caption,
            self.dpi,
        ) + top
            + bottom
    }
}
