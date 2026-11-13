//! [hwpx-cowork] 한/글 2022 표 기능 바인딩(2026-11-11, h2022 표 영역) — 자릿점 넣기/빼기, 셀 계산식 조회.
//! 엔진 본체는 `document_core/commands/h2022_table.rs`.
use super::HwpDocument;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl HwpDocument {
    /// 셀들(`cells_json` = 셀 번호 배열) 안 숫자에 1,000 단위 자릿점을 넣거나(`insert`) 뺀다
    /// (한/글 표 > 1,000 단위 구분 쉼표 > 자릿점 넣기/빼기). 결과: `{"ok":true,"changedCells":[..]}`.
    #[wasm_bindgen(js_name = applyTableThousandsSeparator)]
    pub fn apply_table_thousands_separator(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cells_json: &str,
        insert: bool,
    ) -> Result<String, JsValue> {
        let cells: Vec<usize> = serde_json::from_str(cells_json)
            .map_err(|e| JsValue::from_str(&format!("셀 번호 목록 JSON 오류: {e}")))?;
        self.core
            .apply_table_thousands_separator(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                &cells,
                insert,
            )
            .map_err(|e| e.into())
    }

    /// `setTableCellFormula` 에 `keepText` 를 더한 것 — 참이면 계산식이 없던 칸의 글을 지우지 않고
    /// 결과 필드를 문단 맨 앞에 넣는다(한/글 2022 블록 계산: 글 'x' 가 든 결과 칸 → '3x').
    #[wasm_bindgen(js_name = setTableCellFormulaEx)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_table_cell_formula_ex(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        formula: &str,
        result_format: &str,
        keep_text: bool,
    ) -> Result<String, JsValue> {
        self.core
            .set_table_cell_formula_ex(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                cell_idx as usize,
                formula,
                result_format,
                keep_text,
            )
            .map_err(|e| e.into())
    }

    /// 표 뒤집기(한/글 TableSwap Type 0 상하·1 좌우·2 X↔Y·3 반시계 90°·4 180°·5 시계 90°).
    #[wasm_bindgen(js_name = swapTable)]
    pub fn swap_table(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        kind: u8,
    ) -> Result<String, JsValue> {
        self.core
            .swap_table_native(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                kind,
            )
            .map_err(|e| e.into())
    }

    /// 셀의 첫 계산식 필드 `{"formula","resultFormat","lastResult"}` — 없으면 `{}`.
    #[wasm_bindgen(js_name = getTableCellFormula)]
    pub fn get_table_cell_formula(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
    ) -> Result<String, JsValue> {
        self.core
            .get_table_cell_formula(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                cell_idx as usize,
            )
            .map_err(|e| e.into())
    }
}
