//! [hwpx-cowork] 고정 폭, 독립 행으로 이루어진 단일 본문 표는 이미 확정한
//! 쪽의 행 주소·셀별 줄 컷에서 같은 표 조판기를 재개할 수 있다. 원본 행 번호는
//! 보존하고 측정·쪽 나눔에만 인접 행을 빌린다. 표 전체에 걸친 제약은 기존 경로가 맡는다.
use super::typeset_tail::TypesetTailState;
use super::DocumentCore;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::table::{Table, TablePageBreak};
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredTable};
use crate::renderer::pagination::{PageContent, PageItem};
use crate::renderer::render_normalization::RenderNormalizationOverlay;
use crate::renderer::render_tree::{RenderNode, RenderNodeType};
use crate::renderer::typeset::TypesetEngine;
use std::ops::Range;
use std::sync::Arc;

// 한/글의 독립 행 하한과 전 표 비례 확장/병합 높이 배분을 혼동하지 않는다.
pub(super) fn independent_rows(table: &Table) -> bool {
    if table.row_count < 2
        || !table.has_direct_cell_widths()
        || table.layout_page_break() != TablePageBreak::RowBreak
        || table.repeat_header
        || table.caption.is_some()
        || !table.zones.is_empty()
        || table.cell_spacing != 0
        || table.common.vertical_offset != 0
        || table.outer_margin_top != 0
        || table.outer_margin_bottom != 0
    {
        return false;
    }
    // [hwpx-cowork] 세로 병합의 높이도 가로 폭과 같이 원래 격자의 합으로 증명한다.
    let mut rows = vec![0u32; usize::from(table.row_count)];
    for c in &table.cells {
        if c.height == 0
            || c.is_header
            || c.text_direction != 0
            || c.paragraphs.iter().any(|p| {
                p.line_segs.iter().any(|s| {
                    s.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
                })
            })
        {
            return false;
        }
        if c.row_span == 1 {
            let h = &mut rows[usize::from(c.row)];
            if *h != 0 && *h != c.height {
                return false;
            }
            *h = c.height;
        }
    }
    !rows.contains(&0)
        && rows.iter().map(|h| u64::from(*h)).sum::<u64>() == u64::from(table.common.height)
        && table.cells.iter().filter(|c| c.row_span > 1).all(|c| {
            let r = usize::from(c.row);
            rows[r..r + usize::from(c.row_span)]
                .iter()
                .map(|h| u64::from(*h))
                .sum::<u64>()
                == u64::from(c.height)
        })
}

#[derive(Clone, Debug, PartialEq)]
struct RowStart {
    row: usize,
    cut: Vec<usize>,
    height: Option<f64>,
    continuation: bool,
}

// [hwpx-cowork] '쪽 500'만으로는 두 쪽에 걸친 한 행의 입력 위치를 복원할 수 없다.
#[derive(Clone)]
pub(crate) struct RowTail {
    pub(super) section: usize,
    control: usize,
    page: usize,
    start: RowStart,
    preceding_page: bool,
    // 겹쳐 편집한 경우 이 경계까지 지난 뒤에만 이전 조판의 뒤쪽을 다시 쓸 수 있다.
    join_after: usize,
    focus_end: usize, // [hwpx-cowork] 편집한 행이 여러 쪽인 경우의 마지막 기존 조각 다음 쪽
}

// [hwpx-cowork] 독립 행을 추가한 선형 히스토리만 그 행을 지우는 역연산을 사용한다.
// src 문서 전체를 보관하는 일반 saveSnapshot의 절대 복원 계약은 그대로 둔다.
#[derive(Clone)]
pub(crate) struct InsertRowUndo {
    section: usize,
    control: usize,
    instance: u32,
    original_rows: u16,
    cols: u16,
    inserted: u16,
    row_sizes: Vec<i16>,
    raw_ctrl_data: Vec<u8>,
    properties: crate::model::document::DocProperties,
}

// [hwpx-cowork] Undo 직전의 실제 셀 내용·속성을 보관한다. Redo도 같은 격자 편집과
// 쪽 갱신을 통과하므로 재실행을 위해 원본 문서 전체를 재개방할 필요가 없다.
#[derive(Clone)]
pub(crate) struct InsertRowRedo {
    address: InsertRowUndo,
    cells: Vec<crate::model::table::Cell>,
}

impl InsertRowRedo {
    pub(super) fn apply(self, core: &mut DocumentCore) {
        let a = self.address;
        let table = core
            .get_table_mut(a.section, 0, a.control)
            .expect("validated row owner");
        let from = usize::from(a.inserted) * usize::from(a.cols);
        for (dest, src) in table.cells[from..from + self.cells.len()]
            .iter_mut()
            .zip(self.cells)
        {
            *dest = src;
        }
        table.row_sizes = a.row_sizes;
        table.raw_ctrl_data = a.raw_ctrl_data;
        core.document.doc_properties = a.properties;
    }
}

fn fragment(page: &PageContent, control: usize) -> Option<(&PageItem, usize)> {
    let [column] = page.column_contents.as_slice() else {
        return None;
    };
    let [item] = column.items.as_slice() else {
        return None;
    };
    match item {
        PageItem::PartialTable {
            para_index: 0,
            control_index,
            end_row,
            row_cursor_is_nested: false,
            ..
        } if *control_index == control => Some((item, *end_row)),
        _ => None,
    }
}

// [hwpx-cowork] 병합 칸의 점유 높이와 물리 프레임도 논리 행/원본 칸 주소를 갖는다.
// 줄 컷은 칸마다 소비한 유닛 수이므로 행·칸의 주소 이동에 포함하지 않는다.
fn shift_fragment(item: &mut PageItem, row_offset: isize, cell_offset: isize) -> Option<()> {
    let PageItem::PartialTable {
        start_row,
        end_row,
        straddle_row_relief,
        straddle_page_bands,
        fragment_block_frames,
        ..
    } = item
    else {
        return None;
    };
    *start_row = start_row.checked_add_signed(row_offset)?;
    *end_row = end_row.checked_add_signed(row_offset)?;
    for (row, _) in straddle_row_relief {
        *row = row.checked_add_signed(row_offset)?;
    }
    for cell in straddle_page_bands {
        cell.cell_index = cell.cell_index.checked_add_signed(cell_offset)?;
    }
    for (start, end) in fragment_block_frames {
        *start = start.checked_add_signed(row_offset)?;
        *end = end.checked_add_signed(row_offset)?;
    }
    Some(())
}

fn plain_start(page: &PageContent, control: usize) -> Option<RowStart> {
    let (
        PageItem::PartialTable {
            start_cut_is_block: false,
            straddle_page_bands,
            straddle_row_relief,
            fragment_block_frames,
            ..
        },
        _,
    ) = fragment(page, control)?
    else {
        return None;
    };
    (straddle_page_bands.is_empty()
        && straddle_row_relief.is_empty()
        && fragment_block_frames.is_empty())
    .then(|| start_at(page, control))
    .flatten()
}

fn start_at(page: &PageContent, control: usize) -> Option<RowStart> {
    let (
        PageItem::PartialTable {
            start_row,
            start_cut,
            start_row_height_override,
            is_continuation,
            ..
        },
        _,
    ) = fragment(page, control)?
    else {
        return None;
    };
    Some(RowStart {
        row: *start_row,
        cut: start_cut.clone(),
        height: *start_row_height_override,
        continuation: *is_continuation,
    })
}

// [hwpx-cowork] 원본 Table 복제는 모든 칸을 복사한다. 실제로 소비할 행만
// 원래 셀 폭·안 여백·높이로 투영한다. 원본이나 저장되는 HWPX는 건드리지 않는다.
fn project_table(table: &Table, range: Range<usize>) -> Option<Table> {
    let first = table
        .cells
        .partition_point(|c| usize::from(c.row) < range.start);
    let end = table
        .cells
        .partition_point(|c| usize::from(c.row) < range.end);
    let mut cells = table.cells[first..end].to_vec();
    let mut heights = vec![0u32; range.len()];
    for c in &mut cells {
        c.row = c.row.checked_sub(range.start as u16)?;
        if usize::from(c.row) + usize::from(c.row_span) > range.len() {
            return None;
        }
        if c.row_span == 1 {
            heights[usize::from(c.row)] = c.height;
        }
    }
    if heights.contains(&0) {
        return None;
    }
    let mut common = table.common.clone();
    common.height = heights.into_iter().try_fold(0u32, u32::checked_add)?;
    let mut table = Table {
        attr: table.attr,
        row_count: range.len() as u16,
        col_count: table.col_count,
        cell_spacing: table.cell_spacing,
        padding: table.padding.clone(),
        row_sizes: table
            .row_sizes
            .get(range.clone())
            .unwrap_or_default()
            .to_vec(),
        border_fill_id: table.border_fill_id,
        cells,
        page_break: table.page_break,
        common,
        outer_margin_left: table.outer_margin_left,
        outer_margin_right: table.outer_margin_right,
        raw_table_record_attr: table.raw_table_record_attr,
        ..Table::default()
    };
    table.rebuild_grid();
    table.has_direct_cell_widths().then_some(table)
}

struct Band {
    pages: Vec<PageContent>,
    next: Option<RowStart>,
    base: usize,
    first_cell: usize, // [hwpx-cowork] 병합 행은 논리 열 수와 저장 칸 수가 다르다.
    measured: MeasuredTable,
    host: Paragraph,
    overlay: Arc<RenderNormalizationOverlay>,
}

// [hwpx-cowork] 현재 쪽을 그릴 때도 쪽 나눔에 사용한 바로 그 원본 행·측정·
// 정규화 증거를 이용한다. 그리는 동안만 상대 행 번호를 쓰고 모든 편집 주소는 복원한다.
pub(crate) struct RowPaint {
    pages: Range<usize>,
    section: usize,
    control: usize,
    revision: u64,
    first_row: usize,
    total_rows: u16,
    first_cell: usize,
    pub(super) host: Paragraph,
    pub(super) measured: MeasuredTable,
    pub(super) overlay: Arc<RenderNormalizationOverlay>,
}

impl RowPaint {
    pub(super) fn restore_source_rows(&self, node: &mut RenderNode) {
        let offset = self.first_cell;
        match &mut node.node_type {
            RenderNodeType::Table(table) => table.row_count = self.total_rows,
            RenderNodeType::TableCell(cell) => {
                cell.row += self.first_row as u16;
                if let Some(index) = &mut cell.model_cell_index {
                    *index += offset as u32;
                }
            }
            RenderNodeType::TextRun(run) => {
                if let Some(entry) = run
                    .cell_context
                    .as_mut()
                    .and_then(|ctx| ctx.path.first_mut())
                {
                    entry.cell_index += offset;
                }
            }
            // 독립 행 인증은 칸의 개체를 제외한다. 테두리·배경 노드가 소유 칸을
            // 명시할 때에도 텍스트와 같은 원본 주소를 돌려준다.
            RenderNodeType::Line(line) => {
                if let Some(i) = &mut line.cell_index {
                    *i += offset;
                }
            }
            RenderNodeType::Rectangle(rect) => {
                if let Some(i) = &mut rect.cell_index {
                    *i += offset;
                }
            }
            RenderNodeType::Image(image) => {
                if let Some(index) = &mut image.cell_index {
                    *index += offset;
                }
                if let Some(entry) = image.cell_context.as_mut().and_then(|c| c.path.first_mut()) {
                    entry.cell_index += offset;
                }
            }
            _ => {}
        }
        for child in &mut node.children {
            self.restore_source_rows(child);
        }
    }
}

impl DocumentCore {
    fn current_row_paint(&self, section_index: usize) -> Option<&RowPaint> {
        let paint = self.row_paint.as_ref()?;
        if section_index != paint.section
            || self.dirty_sections[section_index]
            || self.row_text.is_some()
            || self.render_normalization.section_revisions[section_index] != paint.revision
            || !self.certified_row_table(section_index, 0, paint.control)
        {
            return None;
        }
        Some(paint)
    }

    // [hwpx-cowork] 이 행이 양쪽 경계 밖에 없다는 것이 확인되면 캐럿 후보를
    // 찾으려고 확정된 앞쪽과 아직 갱신하지 않은 뒤쪽의 모든 쪽 항목을 읽을 필요도 없다.
    pub(super) fn focused_cell_pages(
        &self,
        section_index: usize,
        para: usize,
        control: usize,
        row: usize,
    ) -> Option<Range<usize>> {
        let paint = self.current_row_paint(section_index)?;
        if para != 0 || control != paint.control {
            return None;
        }
        let range = &paint.pages;
        let pages = &self.pagination[section_index].pages;
        let first = start_at(pages.get(range.start)?, control)?;
        let (_, end_row) = fragment(pages.get(range.end.checked_sub(1)?)?, control)?;
        if row < first.row || row >= end_row {
            return None;
        }
        if let Some(prev) = range.start.checked_sub(1) {
            if fragment(pages.get(prev)?, control)?.1 > row {
                return None;
            }
        }
        let after_row = if let Some(tail) = self
            .row_tail
            .as_ref()
            .filter(|table| table.page == range.end)
        {
            Some(tail.start.row)
        } else if let Some(page) = pages.get(range.end) {
            Some(start_at(page, control)?.row)
        } else {
            None
        };
        (!after_row.is_some_and(|next| row >= next)).then(|| range.clone())
    }

    pub(super) fn row_paint_page(&self, page: &PageContent) -> Option<(&RowPaint, PageContent)> {
        let paint = self.current_row_paint(page.section_index)?;
        if !paint.pages.contains(&(page.page_index as usize)) {
            return None;
        }
        fragment(page, paint.control)?;
        let mut local = page.clone();
        let item = &mut local.column_contents[0].items[0];
        shift_fragment(
            item,
            -(paint.first_row as isize),
            -(paint.first_cell as isize),
        )?;
        let PageItem::PartialTable {
            end_row,
            fragment_row_heights,
            ..
        } = item
        else {
            return None;
        };
        if let Some(heights) = fragment_row_heights {
            *heights = heights
                .get(paint.first_row..paint.first_row + paint.measured.row_heights.len())?
                .to_vec();
        }
        (*end_row <= paint.measured.row_heights.len()).then_some((paint, local))
    }

    pub(super) fn capture_insert_row_undo(
        &mut self,
        section_index: usize,
        para_index: usize,
        control_index: usize,
        after: u16,
    ) -> Option<InsertRowUndo> {
        self.row_structure_before(section_index, para_index, control_index, after)?;
        let section = &self.document.sections[section_index];
        if section.raw_stream.is_some()
            || !self.render_normalization.text_reflowed_tables.is_empty()
        {
            return None;
        }
        let Control::Table(table) = &section.paragraphs[para_index].controls[control_index] else {
            return None;
        };
        if !table.row_major_unmerged() {
            return None;
        } // [hwpx-cowork] 세로 span 구조 복원은 일반 이력을 사용한다.
        Some(InsertRowUndo {
            section: section_index,
            control: control_index,
            instance: table.common.instance_id,
            original_rows: table.row_count,
            cols: table.col_count,
            inserted: after.checked_add(1)?,
            row_sizes: table.row_sizes.clone(),
            raw_ctrl_data: table.raw_ctrl_data.clone(),
            properties: self.document.doc_properties.clone(),
        })
    }

    pub(super) fn capture_row_redo(&self, before: &InsertRowUndo) -> Option<InsertRowRedo> {
        let section = self.document.sections.get(before.section)?;
        let Control::Table(t) = section.paragraphs.first()?.controls.get(before.control)? else {
            return None;
        };
        if section.raw_stream.is_some()
            || t.common.instance_id != before.instance
            || t.col_count != before.cols
            || Some(t.row_count) != before.original_rows.checked_add(1)
            || !t.row_major_unmerged()
            || !self.render_normalization.text_reflowed_tables.is_empty()
        {
            return None;
        }
        let cols = usize::from(t.col_count);
        let from = usize::from(before.inserted) * cols;
        Some(InsertRowRedo {
            address: InsertRowUndo {
                row_sizes: t.row_sizes.clone(),
                raw_ctrl_data: t.raw_ctrl_data.clone(),
                properties: self.document.doc_properties.clone(),
                ..before.clone()
            },
            cells: t.cells.get(from..from + cols)?.to_vec(),
        })
    }

    pub(super) fn redo_insert_row(
        &mut self,
        saved: InsertRowRedo,
    ) -> Result<(), crate::error::HwpError> {
        let a = &saved.address;
        let t = self.get_table_mut(a.section, 0, a.control)?;
        if t.common.instance_id != a.instance
            || t.col_count != a.cols
            || t.row_count != a.original_rows
            || a.inserted == 0
            || a.inserted > t.row_count
            || !t.row_major_unmerged()
        {
            return Err(crate::error::HwpError::RenderError(
                "줄 추가 재실행의 표 상태가 달라졌습니다.".into(),
            ));
        }
        self.insert_table_row_with_state(
            a.section,
            0,
            a.control,
            a.inserted - 1,
            true,
            Some(saved),
        )?;
        Ok(())
    }

    pub(super) fn undo_insert_row(
        &mut self,
        saved: InsertRowUndo,
    ) -> Result<(), crate::error::HwpError> {
        let section_index = saved.section;
        let control_index = saved.control;
        let table = self.get_table_mut(section_index, 0, control_index)?;
        let count = table.row_count;
        if table.common.instance_id != saved.instance
            || table.col_count != saved.cols
            || !(count == saved.original_rows || count.checked_sub(1) == Some(saved.original_rows))
        {
            return Err(crate::error::HwpError::RenderError(
                "줄 추가 실행 취소의 원본 표와 행 수가 다릅니다.".into(),
            ));
        }
        if count != saved.original_rows {
            self.delete_table_row_native(section_index, 0, control_index, saved.inserted)?;
        }
        let table = self.get_table_mut(section_index, 0, control_index)?;
        table.row_sizes = saved.row_sizes;
        table.raw_ctrl_data = saved.raw_ctrl_data;
        self.document.doc_properties = saved.properties;
        Ok(())
    }

    // [hwpx-cowork] 행 삽입/삭제는 원본 셀 서수를 바꾼다. 조판은 주변 행에만
    // 적용하고 뒷부분의 이미 측정한 행과 쪽에는 바뀐 논리 주소만 반영한다.
    pub(super) fn row_structure_before(
        &mut self,
        section_index: usize,
        para_index: usize,
        control_index: usize,
        row: u16,
    ) -> Option<RowTail> {
        self.settle_row_text();
        let Control::Table(table) = self
            .document
            .sections
            .get(section_index)?
            .paragraphs
            .get(para_index)?
            .controls
            .get(control_index)?
        else {
            return None;
        };
        let cell = table.cell_index_at(row, 0)?;
        self.row_window_before(section_index, para_index, control_index, cell, None)
    }

    pub(super) fn apply_row_structure(&mut self, seed: RowTail, row: usize, insert: bool) -> bool {
        let section_index = seed.section;
        let control_index = seed.control;
        let Control::Table(table) =
            &self.document.sections[section_index].paragraphs[0].controls[control_index]
        else {
            return false;
        };
        if !table.row_major_unmerged() || !independent_rows(table) {
            return false;
        }
        let rows = usize::from(table.row_count);
        let cols = usize::from(table.col_count);
        let old_rows = if insert { rows - 1 } else { rows + 1 };
        if rows < 2
            || seed.start.row >= rows
            || (row == seed.start.row && !seed.start.cut.is_empty())
        {
            return false;
        }
        let find =
            |table: &MeasuredTable| table.para_index == 0 && table.control_index == control_index;
        let Some(prev) = self.measured_sections[section_index]
            .tables
            .iter_mut()
            .find(|table| find(table))
        else {
            return false;
        };
        let Some(paint) = self.measured_tables[section_index]
            .iter_mut()
            .find(|table| find(table))
        else {
            return false;
        };
        if [&*prev, &*paint].iter().any(|table| {
            table.row_heights.len() != old_rows
                || table.cumulative_heights.len() != old_rows + 1
                || (!table.cells.is_empty() && table.cells.len() != old_rows * cols)
        }) {
            return false;
        }
        for table in [prev, paint] {
            shift_metrics(table, row, cols, insert);
        }
        let shift = |r: usize| if insert { r + 1 } else { r - 1 };
        for page in &mut self.pagination[section_index].pages[seed.page..] {
            if let Some(col) = page.column_contents.first_mut() {
                if let [PageItem::PartialTable {
                    start_row, end_row, ..
                }] = col.items.as_mut_slice()
                {
                    if *start_row > row || (insert && *start_row == row) {
                        *start_row = shift(*start_row);
                    }
                    if *end_row > row {
                        *end_row = shift(*end_row);
                    }
                }
            }
        }
        self.invalidate_page_tree_cache_from(seed.page as u32);
        self.layout_engine.clear_layout_caches();
        if self.apply_row_window(seed) {
            return true;
        }
        // 투영이 끝 경계에 이르지 못했으면 원본 행을 전체 재측정한다.
        self.measured_sections[section_index]
            .tables
            .retain(|table| !find(table));
        false
    }

    // [hwpx-cowork] 여러 칸의 연속 입력에서도 마지막 descriptor가 이전 칸의
    // 미확정 변경을 덮어쓰지 않도록 다음 편집 전 직전 두 쪽만 마무리한다.
    pub(super) fn settle_row_text(&mut self) -> bool {
        let Some((rev, seed)) = self.row_text.take() else {
            return false;
        };
        self.deferred_pagination_descriptor
            .as_ref()
            .is_some_and(|d| d.revision == rev)
            && self.certified_row_table(seed.section, 0, seed.control)
            && self.apply_row_window(seed)
    }

    // [hwpx-cowork] 글자의 가로 위치만 바뀌면 같은 칸의 편집을 합친다. 줄 높이나
    // 쪽 안에서 소비할 줄 수가 바뀌면 다음 그리기·적중 검사 전에 근접한 행 컷을
    // 발행한다. 그러지 않으면 다음 쪽 첫 행이 이전 쪽 꼬리말에 그려질 수 있다.
    pub(super) fn defer_row_text(&mut self, seed: Option<RowTail>, changed_cut: bool) {
        self.row_text = seed.map(|s| (self.deferred_pagination_revision, s));
        if changed_cut && self.row_text.is_some() && !self.settle_row_text() {
            self.paginate_if_needed();
        }
    }

    // [hwpx-cowork] 같은 칸의 입력·IME 교체·Enter는 아직 발행하지 않은 첫 컷에서
    // 최신 IR을 한 번만 측정한다. 다른 칸으로 이동할 때만 이전 칸의 변경을 확정한다.
    pub(super) fn row_text_before(
        &mut self,
        section: usize,
        para: usize,
        control: usize,
        cell: usize,
        cell_para: usize,
    ) -> Option<RowTail> {
        if let (Some((revision, seed)), Some(d)) =
            (&self.row_text, &self.deferred_pagination_descriptor)
        {
            if *revision == d.revision
                && (d.section_index, d.para_index, d.control_index, d.cell_index)
                    == (section, para, control, cell)
                && d.cell_para_index == cell_para
                && self.certified_row_table(section, para, control)
            {
                return Some(seed.clone());
            }
        }
        self.settle_row_text();
        self.row_window_before(section, para, control, cell, Some(cell_para))
    }

    pub(super) fn row_window_before(
        &self,
        section_index: usize,
        para_index: usize,
        control_index: usize,
        cell: usize,
        cell_para: Option<usize>,
    ) -> Option<RowTail> {
        if self.document.sections.len() != 1
            || para_index != 0
            || !self.certified_row_table(section_index, para_index, control_index)
        {
            return None;
        }
        let section = &self.document.sections[section_index];
        if section.paragraphs.len() != 1 {
            return None;
        }
        let Control::Table(table) = section.paragraphs[para_index].controls.get(control_index)?
        else {
            return None;
        };
        let row = usize::from(table.cells.get(cell)?.row);
        let pages = &self.pagination[section_index].pages;
        let known = self
            .row_tail
            .as_ref()
            .map_or(pages.len(), |job| job.page.min(pages.len()));
        let page = pages[..known]
            .partition_point(|p| fragment(p, control_index).is_some_and(|(_, end)| end <= row));
        if page >= known {
            return None;
        }
        let start = start_at(pages.get(page)?, control_index)?;
        if start.row > row {
            return None;
        }
        // 한 행의 셀 내용 자체가 여러 쪽에 걸치면 문단의 컷 위치도 필요하다.
        let row_end = row + usize::from(table.cells[cell].row_span);
        let focus_end = pages[..known]
            .partition_point(|p| start_at(p, control_index).is_some_and(|s| s.row < row_end));
        if focus_end == known
            && known < pages.len()
            && self
                .row_tail
                .as_ref()
                .is_some_and(|t| t.start.row < row_end)
        {
            return None;
        }
        // 앞 쪽이 같은 행을 소유하면 첫 조각부터, 행이 경계에서 짧아질 수
        // 있으면 바로 앞 한 쪽부터 재생한다. 기존 미확정 쪽에서는 이전 컷을 쓰지 않는다.
        let mut preceding_page = page > 0 && start.row == row && start.cut.is_empty();
        let mut page = if preceding_page { page - 1 } else { page };
        let mut focus = focus_end;
        // [hwpx-cowork] 긴 칸에서는 이미 소비한 문단의 줄 수와 실제 쪽 시작 컷을
        // 대조한다. 편집 문단보다 앞선 컷을 그대로 쓸 수 있으면 그 자리에서 재개한다.
        // 세로 병합의 컷은 블록 원장을 사용하므로 아래 단일 행 증명에 넣지 않는다.
        if let Some(paragraph) = cell_para.filter(|_| focus_end.saturating_sub(page) > 2) {
            let cell_model = &table.cells[cell];
            let first = table.cells.partition_point(|c| usize::from(c.row) < row);
            let row_cells =
                &table.cells[first..table.cells.partition_point(|c| usize::from(c.row) <= row)];
            let measured = self.measured_sections[section_index]
                .tables
                .iter()
                .find(|m| m.para_index == para_index && m.control_index == control_index)
                .and_then(|m| m.cells.get(cell));
            if let Some(m) = measured.filter(|m| {
                row_cells.iter().all(|c| c.row_span == 1)
                    && m.row == row
                    && m.col == usize::from(cell_model.col)
                    && m.para_line_counts.len() == cell_model.paragraphs.len()
                    && paragraph < m.para_line_counts.len()
            }) {
                let prefix: usize = m.para_line_counts[..paragraph].iter().sum();
                let origin = page;
                let upto = pages[page..focus_end].partition_point(|p| {
                    start_at(p, control_index).is_some_and(|s| {
                        s.row < row
                            || (s.row == row
                                && s.height.is_none()
                                && (s.cut.is_empty()
                                    || s.cut.get(cell - first).is_some_and(|&v| v <= prefix)))
                    })
                });
                if upto > 0 {
                    let target = origin + upto - 1;
                    page = target.saturating_sub(1).max(origin);
                    preceding_page = page < target || (page == origin && preceding_page);
                    focus = target;
                }
            }
        }
        if self.dirty_sections[section_index] {
            return None;
        }
        while plain_start(pages.get(page)?, control_index).is_none() {
            page = page.checked_sub(1)?;
            preceding_page = true;
        }
        Some(RowTail {
            section: section_index,
            control: control_index,
            page,
            start: start_at(pages.get(page)?, control_index)?,
            preceding_page,
            focus_end: focus,
            join_after: self
                .row_tail
                .as_ref()
                .map_or(0, |old| old.join_after.max(old.page))
                .max(focus_end),
        })
    }

    fn measure_band(&mut self, seed: &RowTail) -> Option<Band> {
        let section_index = seed.section;
        let control_index = seed.control;
        let page = seed.page;
        let pages = &self.pagination[section_index].pages;
        let old_page = pages.get(page.min(pages.len().checked_sub(1)?))?;
        let old_start = start_at(old_page, control_index)?;
        let span = fragment(old_page, control_index)?
            .1
            .saturating_sub(old_start.row)
            .max(1);
        let Control::Table(table) =
            &self.document.sections[section_index].paragraphs[0].controls[control_index]
        else {
            return None;
        };
        let rows = usize::from(table.row_count);
        let previous = pages
            .get(page.saturating_sub(1))
            .and_then(|p| start_at(p, control_index));
        let mut base = previous
            .map_or(seed.start.row, |s| s.row)
            .min(seed.start.row.saturating_sub(span));
        let ahead = fragment(
            &pages[(page + 3)
                .max(seed.focus_end.saturating_add(1))
                .min(pages.len() - 1)],
            control_index,
        )?
        .1;
        let mut end = (ahead + 1)
            .max(
                seed.start
                    .row
                    .saturating_add(span.saturating_mul(3))
                    .saturating_add(2),
            )
            .min(rows);
        // [hwpx-cowork] 투영 경계가 세로 병합을 자르지 않게 한다. 실제 저장 칸을
        // 기준으로 양쪽을 확장하므로 새로 삽입·삭제한 뒤의 격자에도 동일하게 적용된다.
        loop {
            let mut first = base;
            let mut last = end;
            for col in 0..table.col_count {
                let left = table.cell_index_at(base as u16, col)?;
                let right = table.cell_index_at((end - 1) as u16, col)?;
                first = first.min(usize::from(table.cells[left].row));
                last = last.max(
                    usize::from(table.cells[right].row) + usize::from(table.cells[right].row_span),
                );
            }
            if (base, end) == (first, last) {
                break;
            }
            base = first;
            end = last;
        }
        let first_cell = table.cells.partition_point(|c| usize::from(c.row) < base);
        let projected = project_table(table, base..end)?;
        // 복제할 host에서 원본의 전체 칸 벡터를 제외한다. 교환 구간에는 조판 호출이 없다.
        let host = &mut self.document.sections[section_index].paragraphs[0];
        let original = std::mem::replace(
            &mut host.controls[control_index],
            Control::Table(Box::default()),
        );
        let mut local: Paragraph = host.clone();
        host.controls[control_index] = original;
        local.controls[control_index] = Control::Table(Box::new(projected));
        let Control::Table(table) = &local.controls[control_index] else {
            return None;
        };
        let section = &self.document.sections[section_index];
        let Control::Table(source) = &section.paragraphs[0].controls[control_index] else {
            return None;
        };
        let overlay = std::sync::Arc::new(
            self.render_normalization
                .overlay
                .for_row_band(source, table, base)?,
        );
        let def = &section.section_def;
        let column = Self::find_initial_column_def(&section.paragraphs);
        let profile = self.effective_layout_profile();
        let _tabs = self
            .styles
            .section_tab_scope(def.default_tab_spacing, self.dpi);
        let _split_cell = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
        let measurer = HeightMeasurer::new(self.dpi)
            .with_stored_geometry_policy(profile.stored_geometry_policy())
            .with_native_hwp5(profile.hwp5_stored_pagination_layout())
            .with_hwpx_stored_layout(profile.hwpx_stored_layout())
            .with_hwp5_origin_hwpx(profile.hwp5_origin_hwpx())
            .with_session_edited(profile.session_edited())
            .with_render_normalization(overlay.clone())
            .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
            .with_measure_frame_memo(Some(self.measure_frame_memo.clone()));
        measurer.set_section_column_spacing_hu(i32::from(def.column_spacing));
        // HWPX는 native HWP5 편집 전용 행 하한 배분을 사용하지 않는다(HeightMeasurer).
        if profile.session_edited() {
            return None;
        }
        let measured = measurer.measure_table(table, 0, control_index, &self.styles);
        let engine = TypesetEngine::new_with_render_normalization(self.dpi, overlay.clone())
            .with_section_column_spacing_hu(i32::from(def.column_spacing))
            .with_cell_compose_memo(Some(self.cell_compose_memo.clone()))
            .with_paragraph_format_memo(Some(self.paragraph_format_memo.clone()));
        let paragraphs = std::slice::from_ref(&local);
        let mut job = engine.begin_resumable_table_pagination(
            paragraphs,
            &self.composed[section_index],
            &self.styles,
            &def.page_def,
            &column,
            section_index,
            std::slice::from_ref(&measured),
            def.hide_empty_line,
            profile,
            false,
            Some(&def.footnote_shape),
            0,
            control_index,
            2,
        )?;
        if seed.start.continuation {
            engine.resume_table_band(
                &mut job,
                seed.start.row - base,
                &seed.start.cut,
                seed.start.height,
            );
        }
        let budget = (if seed.preceding_page { 3 } else { 2 })
            .max(seed.focus_end.saturating_sub(seed.page) + 1);
        let mut step = engine.step_resumable_table_pagination(
            &mut job,
            &local,
            paragraphs,
            table,
            &measured,
            &self.styles,
            budget,
        );
        // [hwpx-cowork] 마지막 쪽에서 세로 병합이 이어지면 기존 조판기의 원장을
        // 유지한 채 다음 쪽까지 마쳐서 독립적으로 재개 가능한 경계에 선다.
        let mut emitted_budget = budget;
        if !step.complete && TypesetEngine::table_band_cursor(&job).is_none() {
            step = engine.step_resumable_table_pagination(
                &mut job,
                &local,
                paragraphs,
                table,
                &measured,
                &self.styles,
                1,
            );
            emitted_budget += 1;
        }
        if step.complete && end != rows {
            return None;
        }
        let next = if step.complete {
            None
        } else {
            let (row, cut, height) = TypesetEngine::table_band_cursor(&job)?;
            Some(RowStart {
                row: base + row,
                cut,
                height,
                continuation: true,
            })
        };
        let mut pages = engine
            .publish_table_fragments(job, paragraphs, section_index)
            .pages;
        pages.retain(|p| p.column_contents.iter().any(|col| !col.items.is_empty()));
        if pages.is_empty() || pages.len() > emitted_budget {
            return None;
        }
        for page in &mut pages {
            fragment(page, control_index)?;
            let item = &mut page.column_contents[0].items[0];
            shift_fragment(item, base as isize, first_cell as isize)?;
            if let PageItem::PartialTable {
                fragment_row_heights: Some(heights),
                ..
            } = item
            {
                let previous = self.measured_sections[section_index]
                    .tables
                    .iter()
                    .find(|m| m.control_index == control_index && m.para_index == 0)?;
                let mut source_heights = previous.row_heights.clone();
                source_heights
                    .get_mut(base..base + heights.len())?
                    .copy_from_slice(heights);
                *heights = source_heights;
            }
        }
        Some(Band {
            pages,
            next,
            base,
            first_cell,
            measured,
            host: local,
            overlay,
        })
    }

    pub(super) fn apply_row_window(&mut self, seed: RowTail) -> bool {
        self.publish_row_window(seed, true)
    }

    fn publish_row_window(&mut self, seed: RowTail, focused: bool) -> bool {
        let Some(band) = self.measure_band(&seed) else {
            return false;
        };
        let section_index = seed.section;
        let control_index = seed.control;
        let rows =
            match &self.document.sections[section_index].paragraphs[0].controls[control_index] {
                Control::Table(table) => table.row_count,
                _ => return false,
            };
        let eligible =
            |table: &MeasuredTable| table.para_index == 0 && table.control_index == control_index;
        let Some(old) = self.measured_sections[section_index]
            .tables
            .iter_mut()
            .find(|m| eligible(m))
        else {
            return false;
        };
        let Some(paint) = self.measured_tables[section_index]
            .iter_mut()
            .find(|m| eligible(m))
        else {
            return false;
        };
        if !can_patch_metrics(old, &band) || !can_patch_metrics(paint, &band) {
            return false;
        }
        patch_metrics(old, &band);
        patch_metrics(paint, &band);
        let pages = &mut self.pagination[section_index].pages;
        let first_number = pages.first().map_or(1, |p| p.page_number);
        let next_page = seed.page + band.pages.len();
        self.typeset_resume.window_pages.set(band.pages.len());
        self.typeset_resume
            .window_rows
            .set(band.measured.row_heights.len());
        self.typeset_resume
            .table_windows
            .set(self.typeset_resume.table_windows.get() + 1);
        // 한 행이 한 쪽을 채우면 삽입 시 접합할 옛 쪽 번호도 하나 달라진다.
        let seam = band.next.as_ref().and_then(|cursor| {
            [
                Some(next_page),
                next_page.checked_sub(1),
                next_page.checked_add(1),
            ]
            .into_iter()
            .flatten()
            .filter(|&p| p > seed.page && p >= seed.join_after)
            .find(|&p| {
                pages
                    .get(p)
                    .and_then(|old| plain_start(old, control_index))
                    .as_ref()
                    == Some(cursor)
            })
        });
        let end = if band.next.is_none() {
            pages.len()
        } else {
            seam.unwrap_or(next_page.min(pages.len()))
        };
        pages.splice(
            seed.page..end,
            band.pages.into_iter().enumerate().map(|(i, mut p)| {
                p.page_index = (seed.page + i) as u32;
                p.page_number = first_number + p.page_index;
                p
            }),
        );
        if end != next_page {
            for (i, page) in pages.iter_mut().enumerate().skip(next_page) {
                page.page_index = i as u32;
                page.page_number = first_number + page.page_index;
            }
            self.invalidate_page_tree_cache_from(seed.page as u32);
        }
        self.row_tail = match band.next {
            Some(start) if seam.is_none() => Some(RowTail {
                section: section_index,
                control: control_index,
                page: next_page,
                start,
                preceding_page: false,
                focus_end: 0,
                join_after: seed.join_after,
            }),
            _ => None,
        };
        self.dirty_sections[section_index] = false;
        if let Some(bits) = &mut self.dirty_paragraphs[section_index] {
            bits.fill(false);
        }
        self.only_text_edits_pending.set(false);
        self.deferred_pagination_descriptor = None;
        self.row_text = None; // [hwpx-cowork] 같은 칸에서 이어 친 최신 상태까지 발행했다.
        self.pending_pagination_job = None;
        self.typeset_unchanged_before[section_index] = None;
        let rev = self.render_normalization.section_revisions[section_index];
        self.render_normalization.unprojected_revisions[section_index] = Some(rev);
        self.accept_row_table_revision(section_index);
        if focused {
            self.row_paint = Some(RowPaint {
                pages: seed.page..next_page,
                section: section_index,
                control: control_index,
                revision: rev,
                first_row: band.base,
                total_rows: rows,
                first_cell: band.first_cell,
                host: band.host,
                measured: band.measured,
                overlay: band.overlay,
            });
        }
        // 이 표에는 머리말·필드·바탕쪽이 없으므로 변하지 않은 앞뒤 쪽의
        // 그림 트리까지 버리지 않는다. 행 번호 자체가 이동한 경우는 위에서 별도로 처리했다.
        for page in seed.page..next_page {
            if let Some(slot) = self.page_tree_cache.borrow_mut().get_mut(page) {
                *slot = None;
            }
            if let Some(slot) = self.layer_tree_json_cache.borrow_mut().get_mut(page) {
                slot.clear();
            }
            if let Some(slot) = self.page_layer_tree_cache.borrow_mut().get_mut(page) {
                slot.clear();
            }
        }
        self.header_footer_preview_tree_cache.borrow_mut().take();
        self.typeset_resume
            .flow_window_edits
            .set(self.typeset_resume.flow_window_edits.get() + 1);
        true
    }

    pub(super) fn advance_row_tail(&mut self) -> TypesetTailState {
        let seed = self.row_tail.as_ref().unwrap().clone();
        let idx = seed.section;
        if self.certified_row_table(idx, 0, seed.control)
            && !self.dirty_sections[idx]
            && self.publish_row_window(seed, false)
        {
            return if self.row_tail.is_some() {
                TypesetTailState::Pending
            } else {
                TypesetTailState::Complete
            };
        }
        self.row_tail = None;
        self.mark_section_pagination_dirty(idx);
        self.paginate();
        TypesetTailState::Complete
    }
}

fn shift_metrics(table: &mut MeasuredTable, row: usize, cols: usize, insert: bool) {
    let neighbour = row.min(table.row_heights.len() - 1);
    let change = |v: &mut Vec<f64>| {
        if insert {
            v.insert(row, v[neighbour]);
        } else {
            v.remove(row);
        }
    };
    change(&mut table.row_heights);
    if let Some(v) = &mut table.row_frame_heights {
        change(v);
    }
    // 전체 재측정도 행 수가 달라지면 이전 행 수의 하한을 사용하지 않는다.
    table.baseline_row_heights = None;
    let rows = table.row_heights.len();
    if !table.cells.is_empty() {
        if insert {
            let copy = table.cells[neighbour * cols..(neighbour + 1) * cols].to_vec();
            table.cells.splice(row * cols..row * cols, copy);
        } else {
            table.cells.drain(row * cols..(row + 1) * cols);
        }
        for (i, c) in table.cells.iter_mut().enumerate().skip(row * cols) {
            c.row = i / cols;
        }
    }
    if !table.row_block_start.is_empty() {
        table.row_block_start = (0..rows).collect();
    }
    if !table.row_block_end.is_empty() {
        table.row_block_end = (1..=rows).collect();
    }
    let prev = *table.cumulative_heights.last().unwrap();
    table.cumulative_heights.resize(rows + 1, 0.0);
    for i in row..rows {
        table.cumulative_heights[i + 1] = table.cumulative_heights[i]
            + table.row_heights[i]
            + if i > 0 { table.cell_spacing } else { 0.0 };
    }
    table.total_height += table.cumulative_heights[rows] - prev;
}

fn can_patch_metrics(old: &MeasuredTable, band: &Band) -> bool {
    let fresh = &band.measured;
    let end = band.base + fresh.row_heights.len();
    old.row_heights.len() >= end
        && old.cumulative_heights.len() == old.row_heights.len() + 1
        && old.row_frame_heights.is_some() == fresh.row_frame_heights.is_some()
        && ((fresh.cells.is_empty() && old.cells.is_empty())
            || (!fresh.cells.is_empty()
                && old
                    .cells
                    .get(band.first_cell..band.first_cell + fresh.cells.len())
                    .is_some_and(|cells| {
                        cells
                            .iter()
                            .zip(&fresh.cells)
                            .all(|(a, b)| a.row == band.base + b.row && a.col == b.col)
                    })))
}

fn patch_metrics(old: &mut MeasuredTable, band: &Band) {
    let fresh = &band.measured;
    let range = band.base..band.base + fresh.row_heights.len();
    if old.row_heights[range.clone()] != fresh.row_heights {
        old.row_heights[range.clone()].copy_from_slice(&fresh.row_heights);
        let prev = *old.cumulative_heights.last().unwrap();
        for i in range.start..old.row_heights.len() {
            old.cumulative_heights[i + 1] = old.cumulative_heights[i]
                + old.row_heights[i]
                + if i > 0 { old.cell_spacing } else { 0.0 };
        }
        old.total_height += *old.cumulative_heights.last().unwrap() - prev;
    }
    if let (Some(all), Some(local)) = (&mut old.row_frame_heights, &fresh.row_frame_heights) {
        all[range.clone()].copy_from_slice(local);
    }
    if !fresh.cells.is_empty() {
        for (target, item) in old.cells[band.first_cell..band.first_cell + fresh.cells.len()]
            .iter_mut()
            .zip(&fresh.cells)
        {
            target.clone_from(item);
            target.row += range.start;
        }
    }
}
