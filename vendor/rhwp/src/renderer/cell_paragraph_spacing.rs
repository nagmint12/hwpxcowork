//! 셀 문단의 흐름 앞 간격과 저장 프레임의 물리 앞 띠를 구분한다.

use crate::model::paragraph::Paragraph;

/// 저장 첫 줄은 앞 간격을 이미 원점에 품는다. 흐름에서 다시 더하지 않아도
/// 그 띠가 차지하는 공간은 셀 높이와 첫 분할 유닛에 포함해야 한다.
pub(crate) struct CellParagraphBefore {
    pub flow_before: f64,
    pub stored_lead: f64,
}

impl CellParagraphBefore {
    pub fn occupied_before(&self) -> f64 {
        self.flow_before + self.stored_lead
    }

    /// A floating paragraph anchor precedes its saved text lead. The same lead
    /// is reserved by text layout; adding it to the floating frame counts it twice.
    pub fn stored_anchor_top(&self, first_text_top: f64) -> f64 {
        first_text_top - self.stored_lead
    }
}

pub(crate) fn paragraph_before(
    para: &Paragraph,
    para_index: usize,
    spacing_before: f64,
    dpi: f64,
) -> CellParagraphBefore {
    // [hwpx-cowork] 저장 줄 없는 host 문단이 문단 기준 자리차지 표(흐름 제한)를 품으면 한/글은 그
    // 문단의 앞 간격을 쓰지 않는다 — 표 원점 = 문단 위(앞 문단 끝) + 오프셋 + 바깥 위여백, host 글줄 =
    // 표 띠 바로 아래. 한/글 2022 재저장 줄 실측: regression-20261103 B-0441c155f855(칸, 앞 간격 830):
    // 표 위 19800 + 283, 글줄 50366 = 19800 + 283 + 30000 + 283; B-2036842fd2af(칸 첫 문단): 글줄
    // 30000 = 표 높이; regression-20261104 W-5b5b17bfc280 textPrev 뒤 문단 51780 = 앞 간격 없는
    // W-b3ef4de8a84d 와 같음. fork 0.8.7: 중첩 표 원점은 앞 간격 전 `para_y_before_compose`,
    // `sequential_nested_cell_layout` 은 자리차지 표 문단의 앞 간격 0. 0.9.0 저장 경로
    // `stored_block_cell_flow` 도 표 host 의 앞 간격을 0 으로 둔다 — 재조판 흐름·측정을 같은 값으로 맞춘다.
    let spacing_before = if no_stored_restricted_block_table_host(para) {
        0.0
    } else {
        spacing_before
    };
    let flow_before = super::cell_paragraph_spacing_before(para, para_index, spacing_before);
    let stored_lead = if para_index == 0 && !super::para_has_no_stored_line_segs(para) {
        super::cell_first_para_stored_lead(para, spacing_before, dpi)
    } else {
        0.0
    };
    CellParagraphBefore {
        flow_before,
        stored_lead,
    }
}

/// [hwpx-cowork] 저장 줄 없는 문단이 흐름 제한 문단 기준 자리차지 표를 품었는가(앞 간격 규칙용).
fn no_stored_restricted_block_table_host(para: &Paragraph) -> bool {
    use crate::model::control::Control;
    use crate::model::shape::{TextWrap, VertRelTo};
    super::para_has_no_stored_line_segs(para)
        && para.controls.iter().any(|control| {
            matches!(control, Control::Table(table)
                if !table.common.treat_as_char
                    && table.common.flow_with_text
                    && table.common.text_wrap == TextWrap::TopAndBottom
                    && table.common.vert_rel_to == VertRelTo::Para)
        })
}

/// 저장 줄이 없는 순수 텍스트 셀은 앞 간격을 흐름에서 소유한다.
/// 자체 배치 상자가 없는 메타데이터도 같은 텍스트 흐름에 속한다.
/// 그림/표 등 별도 배치 상자를 소유하는 호스트는 이 텍스트 경로에 합치지 않는다.
/// 수용·측정의 paragraph_before와 실제 첫 글줄이 동일한 값을 소비한다.
pub(crate) fn plain_text_before(
    para: &Paragraph,
    para_index: usize,
    spacing_before: f64,
    dpi: f64,
) -> Option<CellParagraphBefore> {
    (para
        .controls
        .iter()
        .all(super::composer::control_is_width_neutral_marker)
        && super::para_has_no_stored_line_segs(para))
    .then(|| paragraph_before(para, para_index, spacing_before, dpi))
}
