//! [hwpx-cowork] 한/글 2022 표 기능(2026-11-11, h2022 표 영역).
//!
//! - 계산식 다시 계산 고리: 한/글 12.30·2022 는 표의 아무 셀이나 고치면 그 표의 계산식 필드를 모두 다시
//!   계산한다(`table_formula.rs` 머리 주석 — 한/글 12.30 실측). 엔진은 `recalculate_table_formulas` 를
//!   갖고 있었지만 셀 글 편집이 부르지 않아 결과가 옛 값으로 남았다. 셀 글 넣기·지우기 직후 여기서 부른다.
//! - 자릿점 넣기/빼기(`TableInsertComma`/`TableDeleteComma`, 메뉴 '1,000 단위 구분 쉼표'): 한/글 2022 COM 실측
//!   (2026-11-11, `artifacts/h2022-table/com/probe_table.py` thousands·thousands_formula) — 셀 블록 칸의 모든 숫자
//!   덩어리에서 정수 부분을 세 자리마다 쉼표로 나눈다. 글 사이 숫자('abc 12,345 def'·'1,234,567원'), 앞자리 0
//!   ('0012345'→'0,012,345'), 음수의 정수 부분도 나누고 소수 부분('1,234.5678')은 그대로 둔다. 빼기는 숫자 사이
//!   쉼표를 지운다('12,345'→'12345'). 계산식 칸은 보이는 결과 글만 바꾸고 식·결과 형식·마지막 결과는 두었다.

use super::super::DocumentCore;
use crate::document_core::table_calc::split_formula_command;
use crate::error::HwpError;
use crate::model::control::{Control, FieldType};
use crate::model::table::Table;

/// 표에 계산식(FORMULA) 필드가 하나라도 있는가 — 없는 표의 편집은 다시 계산하지 않는다(빠른 길).
pub(crate) fn table_has_formula_fields(table: &Table) -> bool {
    table.cells.iter().any(|cell| {
        cell.paragraphs.iter().any(|para| {
            para.controls.iter().any(
                |c| matches!(c, Control::Field(field) if field.field_type == FieldType::Formula),
            )
        })
    })
}

/// 문단 글에서 숫자 덩어리(숫자, 숫자 사이 쉼표)를 찾아 자릿점을 넣거나 뺀 교체 목록을 만든다.
/// 반환: (시작 글자 자리, 지울 글자 수, 새 글) — 앞에서부터 늘어놓는다(바꿀 때는 뒤에서부터).
pub(crate) fn thousands_edits(text: &str, insert: bool) -> Vec<(usize, usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let mut edits = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1; // 마지막 숫자 다음
        let mut j = i + 1;
        while j < chars.len() {
            if chars[j].is_ascii_digit() {
                j += 1;
                end = j;
            } else if chars[j] == ',' && j + 1 < chars.len() && chars[j + 1].is_ascii_digit() {
                j += 1;
            } else {
                break;
            }
        }
        i = end;
        // 소수 부분(숫자 . 숫자의 뒤쪽)은 나누지 않는다.
        if start >= 2 && chars[start - 1] == '.' && chars[start - 2].is_ascii_digit() {
            continue;
        }
        let token: String = chars[start..end].iter().collect();
        let digits: String = token.chars().filter(|c| *c != ',').collect();
        let replaced = if insert {
            let n = digits.len();
            let mut out = String::with_capacity(n + n / 3);
            for (k, c) in digits.chars().enumerate() {
                if k > 0 && (n - k) % 3 == 0 {
                    out.push(',');
                }
                out.push(c);
            }
            out
        } else {
            digits
        };
        if replaced != token {
            edits.push((start, end - start, replaced));
        }
    }
    edits
}

/// 표 뒤집기(한/글 TableSwap Type): 0 상하, 1 좌우, 2 X↔Y(행렬 바꿈), 3 반시계 90°, 4 180°, 5 시계 90°.
/// 한/글 2022 COM 실측(2026-11-12 probe2 swap, 2×3 표·병합 칸 포함): 칸 직사각형을 그대로 옮기고(병합 폭도 함께),
/// X↔Y·90° 는 칸의 폭과 높이를 맞바꾼다(2×3 → 3×2, 칸 폭 = 옛 높이 282, 높이 = 옛 폭). 테두리·여백은 칸에 붙은 채 옮겼다
/// (SwapMargin 기본 0 — 여백 뒤집기는 하지 않는다). 반환: 문단 수를 단 칸 목록(다시 흘리기용).
pub(crate) fn swap_table_cells(table: &mut Table, kind: u8) -> Result<Vec<(usize, usize)>, String> {
    if kind > 5 {
        return Err(format!("표 뒤집기 종류는 0~5 입니다: {kind}"));
    }
    let (rows, cols) = (table.row_count, table.col_count);
    if rows == 0 || cols == 0 {
        return Err("뒤집을 표가 비어 있습니다".to_string());
    }
    let transpose = matches!(kind, 2 | 3 | 5);
    let place = |r: u16, c: u16, rs: u16, cs: u16| -> (u16, u16) {
        match kind {
            0 => (rows - (r + rs), c),
            1 => (r, cols - (c + cs)),
            2 => (c, r),
            3 => (cols - (c + cs), r),
            4 => (rows - (r + rs), cols - (c + cs)),
            _ => (c, rows - (r + rs)),
        }
    };
    for cell in &table.cells {
        let (rs, cs) = (cell.row_span.max(1), cell.col_span.max(1));
        if cell.row + rs > rows || cell.col + cs > cols {
            return Err("병합 칸이 표 밖으로 나가 뒤집을 수 없습니다".to_string());
        }
    }
    for cell in &mut table.cells {
        let (rs, cs) = (cell.row_span.max(1), cell.col_span.max(1));
        let (nr, nc) = place(cell.row, cell.col, rs, cs);
        cell.row = nr;
        cell.col = nc;
        if transpose {
            std::mem::swap(&mut cell.row_span, &mut cell.col_span);
            std::mem::swap(&mut cell.width, &mut cell.height);
        }
    }
    for zone in &mut table.zones {
        let (rs, cs) = (zone.end_row - zone.start_row + 1, zone.end_col - zone.start_col + 1);
        let (nr, nc) = place(zone.start_row, zone.start_col, rs, cs);
        let (nrs, ncs) = if transpose { (cs, rs) } else { (rs, cs) };
        zone.start_row = nr;
        zone.start_col = nc;
        zone.end_row = nr + nrs - 1;
        zone.end_col = nc + ncs - 1;
    }
    if transpose {
        std::mem::swap(&mut table.row_count, &mut table.col_count);
    }
    table.cells.sort_by_key(|c| (c.row, c.col));
    table.rebuild_row_sizes();
    table.update_ctrl_dimensions();
    table.rebuild_grid();
    Ok(table
        .cells
        .iter()
        .enumerate()
        .map(|(i, c)| (i, c.paragraphs.len()))
        .collect())
}

impl DocumentCore {
    /// 표 뒤집기(한/글 표 > 표 뒤집기). 결과: `{"ok":true,"rowCount":..,"colCount":..}`.
    pub fn swap_table_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        kind: u8,
    ) -> Result<String, HwpError> {
        let (reflow, rows, cols) = {
            let table = self.get_table_mut(section_idx, parent_para_idx, control_idx)?;
            let reflow = swap_table_cells(table, kind).map_err(HwpError::RenderError)?;
            (reflow, table.row_count, table.col_count)
        };
        self.reflow_table_cell_paragraphs(section_idx, parent_para_idx, control_idx, &reflow);
        if let Some(measured) = self.measured_sections.get_mut(section_idx) {
            measured
                .tables
                .retain(|t| t.para_index != parent_para_idx || t.control_index != control_idx);
        }
        self.document.sections[section_idx].raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        Ok(serde_json::json!({"ok": true, "rowCount": rows, "colCount": cols}).to_string())
    }

    fn h2022_table_ref(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> Result<&Table, HwpError> {
        match self
            .document
            .sections
            .get(section_idx)
            .and_then(|s| s.paragraphs.get(parent_para_idx))
            .and_then(|p| p.controls.get(control_idx))
        {
            Some(Control::Table(table)) => Ok(table),
            _ => Err(HwpError::RenderError("표 컨트롤이 아님".into())),
        }
    }

    /// 셀 글을 고친 뒤 그 표의 계산식을 다시 계산한다. `edit_result` 는 편집 함수의 결과 JSON 이고,
    /// 쪽 나눔을 미룬 편집(`paginate == false`)에서 다시 계산이 셀 흐름을 바꿨으면 그 JSON 의
    /// `cellFlowChanged` 를 참으로 바꿔 돌려준다(편집기가 쪽 나눔을 다시 하도록).
    pub(crate) fn h2022_recalc_formulas_after_cell_edit(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        paginate: bool,
        edit_result: String,
    ) -> String {
        let has_formula = self
            .h2022_table_ref(section_idx, parent_para_idx, control_idx)
            .is_ok_and(table_has_formula_fields);
        if !has_formula {
            return edit_result;
        }
        let Ok(recalc) = self.recalculate_table_formulas(
            section_idx,
            parent_para_idx,
            control_idx,
            Some(cell_idx),
            paginate,
        ) else {
            return edit_result;
        };
        if !paginate && recalc.contains("\"cellFlowChanged\":true") {
            return edit_result.replace("\"cellFlowChanged\":false", "\"cellFlowChanged\":true");
        }
        edit_result
    }

    /// 셀 경로(`[(control, cell, cellPara)…]`)로 고친 뒤 그 칸이 든 표의 계산식을 다시 계산한다.
    /// 깊이 1 은 평면 표, 2 이상은 중첩 표(`recalculate_table_formulas_by_path`). 실패해도 편집 결과는 그대로 돌려준다.
    pub(crate) fn h2022_recalc_formulas_after_path_edit(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
        paginate: bool,
        edit_result: String,
    ) -> String {
        match path {
            [] => edit_result,
            [(control_idx, cell_idx, _)] => self.h2022_recalc_formulas_after_cell_edit(
                section_idx,
                parent_para_idx,
                *control_idx,
                *cell_idx,
                paginate,
                edit_result,
            ),
            _ => {
                let _ = self.recalculate_table_formulas_by_path(section_idx, parent_para_idx, path, paginate);
                edit_result
            }
        }
    }

    /// 셀들 안 숫자에 1,000 단위 자릿점을 넣거나(`insert`) 뺀다(한/글 자릿점 넣기/빼기).
    /// 칸 문단마다 숫자 덩어리만 바꾸고 필드·개체 자리는 지킨다. 결과: `{"ok":true,"changedCells":[..]}`.
    pub fn apply_table_thousands_separator(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cells: &[usize],
        insert: bool,
    ) -> Result<String, HwpError> {
        let mut plan: Vec<(usize, usize, Vec<(usize, usize, String)>)> = Vec::new();
        {
            let table = self.h2022_table_ref(section_idx, parent_para_idx, control_idx)?;
            for &cell_idx in cells {
                let cell = table.cells.get(cell_idx).ok_or_else(|| {
                    HwpError::RenderError(format!("셀 인덱스 {cell_idx} 범위 초과"))
                })?;
                for (para_idx, para) in cell.paragraphs.iter().enumerate() {
                    let edits = thousands_edits(&para.text, insert);
                    if !edits.is_empty() {
                        plan.push((cell_idx, para_idx, edits));
                    }
                }
            }
        }
        let mut changed: Vec<usize> = Vec::new();
        for (cell_idx, para_idx, edits) in plan {
            for (start, count, text) in edits.into_iter().rev() {
                // 계산식 다시 계산 고리를 거치지 않는 길(한/글도 자릿점은 식을 다시 계산하지 않았다).
                self.replace_text_in_cell_field_impl(
                    section_idx,
                    parent_para_idx,
                    control_idx,
                    cell_idx,
                    para_idx,
                    start,
                    count,
                    &text,
                    false,
                    None,
                )?;
            }
            if !changed.contains(&cell_idx) {
                changed.push(cell_idx);
            }
        }
        if !changed.is_empty() {
            self.flush_deferred_pagination();
        }
        Ok(serde_json::json!({"ok": true, "changedCells": changed}).to_string())
    }

    /// 셀의 첫 계산식 필드. 없으면 `{}`, 있으면 `{"formula","resultFormat","lastResult"}`.
    pub fn get_table_cell_formula(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
    ) -> Result<String, HwpError> {
        let table = self.h2022_table_ref(section_idx, parent_para_idx, control_idx)?;
        let cell = table
            .cells
            .get(cell_idx)
            .ok_or_else(|| HwpError::RenderError(format!("셀 인덱스 {cell_idx} 범위 초과")))?;
        for para in &cell.paragraphs {
            for range in &para.field_ranges {
                let Some(Control::Field(field)) = para.controls.get(range.control_idx) else {
                    continue;
                };
                if field.field_type != FieldType::Formula {
                    continue;
                }
                if let Some((formula, fmt, last)) = split_formula_command(&field.command) {
                    return Ok(serde_json::json!({
                        "formula": formula,
                        "resultFormat": fmt,
                        "lastResult": last,
                    })
                    .to_string());
                }
            }
        }
        Ok("{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::thousands_edits;

    fn apply(text: &str, insert: bool) -> String {
        let mut chars: Vec<char> = text.chars().collect();
        for (start, count, new) in thousands_edits(text, insert).into_iter().rev() {
            chars.splice(start..start + count, new.chars());
        }
        chars.into_iter().collect()
    }

    /// 한/글 2022 COM 실측(2026-11-11 probe_table.py thousands): 넣기 결과와, 넣은 뒤 빼기 결과.
    #[test]
    fn thousands_match_hangul_2022() {
        let cases = [
            ("1234567", "1,234,567", "1234567"),
            ("1234.5678", "1,234.5678", "1234.5678"),
            ("abc 12345 def", "abc 12,345 def", "abc 12345 def"),
            ("-9876543.21", "-9,876,543.21", "-9876543.21"),
            ("1234567원", "1,234,567원", "1234567원"),
            ("12,345", "12,345", "12345"),
            ("0012345", "0,012,345", "0012345"),
            ("12345 67890", "12,345 67,890", "12345 67890"),
        ];
        for (src, inserted, deleted) in cases {
            assert_eq!(apply(src, true), inserted, "넣기 {src}");
            assert_eq!(apply(inserted, false), deleted, "빼기 {inserted}");
        }
    }
}
