//! 완결된 표의 행 선언에서 흐름과 실제 그리드가 공유하는 폭을 구한다.

use super::table::Cell;
use super::Table;

impl Table {
    /// 선언 폭과 별개로 셀의 내용·안 여백이 소유하는 최소 물리 폭.
    ///
    /// 한컴 2020의 동일 입력 Print·저장 대조에서 내용 폭 하한은 1mm(283 HU)다.
    /// 글자 크기·바깥 여백·TAC·noAdjust와 무관하며 병합 셀에도 한 번 적용된다.
    /// 폭 0은 아직 풀리지 않은 열 제약이므로 기존 해결 경로에 남긴다.
    /// 원시 셀 폭과 직렬화·유효성 판정은 바꾸지 않는다.
    pub(crate) fn physical_cell_width_hu(&self, cell: &Cell) -> u32 {
        if cell.width == 0 {
            return 0;
        }
        const MIN_CONTENT_WIDTH_HU: i32 = 283;
        let padding = cell.effective_padding(&self.padding);
        let minimum = (i32::from(padding.left) + i32::from(padding.right) + MIN_CONTENT_WIDTH_HU)
            .max(0) as u32;
        cell.width.max(minimum)
    }

    /// 모든 행이 겹침·빈 열 없이 닫히고 같은 물리 폭을 소유할 때의 표 폭.
    ///
    /// 개체의 `sz`만 바꾼 독립 한컴 Print 대조군에서도 셀 그리드 폭은 유지된다.
    /// 반대로 행마다 구획·합이 다른 표는 열별 최대값을 더할 수 없으므로 기존
    /// 개체 폭 계약을 유지한다. 직렬화 모델과 원시 유효성 검사는 바꾸지 않는다.
    pub(crate) fn closed_cell_grid_width_hu(&self) -> Option<u32> {
        match self.closed_cell_grid_width_hu_with_storage(&crate::storage::Unbounded) {
            Ok(value) => value,
            Err(never) => match never {},
        }
    }
    pub(crate) fn closed_cell_grid_width_hu_with_storage<S: crate::storage::Storage>(
        &self,
        storage: &S,
    ) -> Result<Option<u32>, S::Error> {
        // [hwpx-cowork] 한/글 2022 재저장과 쪽 그림에서 HWPX의 떠 있는 표도 각 셀의
        // 물리 폭을 지킨다. 부모 셀 폭은 표시 범위를 정하며 열 경계를 바꾸지 않는다.
        if !(self.common.treat_as_char || self.common.hwpx_size_rule)
            || self.row_count == 0
            || self.col_count == 0
            || self.cell_spacing < 0
        {
            return Ok(None);
        }
        // [hwpx-cowork] 보통의 행·열 순서는 그대로 읽는다. 칸 저장 순서가 다른
        // 문서만 참조를 정렬하여 같은 물리 구획 검사를 거친다.
        if self.cells.is_sorted_by_key(|cell| (cell.row, cell.col)) {
            return Ok(self.grid_width_in_cell_order(self.cells.iter()));
        }
        let mut ordered = storage.collect(self.cells.iter())?;
        ordered.sort_unstable_by_key(|cell| (cell.row, cell.col));
        Ok(self.grid_width_in_cell_order(ordered.into_iter()))
    }

    fn grid_width_in_cell_order<'a>(&self, cells: impl Iterator<Item = &'a Cell>) -> Option<u32> {
        let mut cells = cells.peekable();
        let mut consensus = None;
        let spacing = i64::from(self.cell_spacing);
        for row in 0..self.row_count {
            let mut next_col = 0u16;
            // 왼쪽 바깥 간격 하나, 이어서 각 물리 셀의 폭과 오른쪽 간격 하나.
            let mut width = spacing;
            while let Some(cell) = cells.next_if(|cell| cell.row == row) {
                if cell.col != next_col
                    || cell.row_span != 1
                    || cell.col_span == 0
                    || cell.width == 0
                {
                    return None;
                }
                next_col = next_col.checked_add(cell.col_span)?;
                width += i64::from(self.physical_cell_width_hu(cell)) + spacing;
            }
            if next_col != self.col_count || width > i64::from(i32::MAX) {
                return None;
            }
            let width = width as u32;
            if consensus.is_some_and(|prior| prior != width) {
                return None;
            }
            consensus = Some(width);
        }
        if cells.next().is_some() {
            return None;
        }
        consensus
    }
}
