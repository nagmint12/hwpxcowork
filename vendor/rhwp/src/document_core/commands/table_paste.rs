//! [hwpx-cowork] 한/글 '셀 붙이기': 표 조각의 셀과 일반 문단 붙여넣기를 구분한다.
use super::super::DocumentCore;
use crate::error::HwpError;
use crate::model::{
    control::Control, document::Document, event::DocumentEvent, paragraph::Paragraph, Padding,
    table::Table,
};
use std::collections::BTreeMap;

fn error(message: impl Into<String>) -> HwpError {
    HwpError::RenderError(message.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Rect {
    top: u16,
    left: u16,
    bottom: u16,
    right: u16,
}

impl Rect {
    fn intersects(self, other: Self) -> bool {
        self.top < other.bottom && other.top < self.bottom
            && self.left < other.right && other.left < self.right
    }

    fn contains(self, other: Self) -> bool {
        self.top <= other.top && self.left <= other.left
            && self.bottom >= other.bottom && self.right >= other.right
    }

    fn of(cell: &crate::model::table::Cell) -> Self {
        Self {
            top: cell.row, left: cell.col,
            bottom: cell.row.saturating_add(cell.row_span),
            right: cell.col.saturating_add(cell.col_span),
        }
    }
}

// A mixed range must keep its surrounding paragraphs, controls and order.
fn standalone_table(document: &Document) -> Option<(usize, usize)> {
    let [section] = document.sections.as_slice() else { return None };
    let mut result = None;
    for (pi, para) in section.paragraphs.iter().enumerate() {
        if para.text.chars().any(|c| c != '\u{2}' && !c.is_whitespace())
            || (pi != 0 && para.has_section_break()) || !para.range_tags.is_empty()
        {
            return None;
        }
        for (ci, control) in para.controls.iter().enumerate() {
            match control {
                Control::SectionDef(_) | Control::ColumnDef(_) => {}
                Control::Table(table) if result.is_none() && table.row_count > 0
                    && table.col_count > 0 && !table.cells.is_empty() => result = Some((pi, ci)),
                _ => return None,
            }
        }
    }
    result
}

impl DocumentCore {
    /// [hwpx-cowork] A cell block travels in the existing portable clipboard as
    /// a real table. Widen the bounds around any intersected merged cell.
    pub fn copy_cell_block_native(
        &mut self, sec: usize, para: usize, path: &[(usize, usize, usize)],
        start_row: u16, start_col: u16, end_row: u16, end_col: u16,
    ) -> Result<String, HwpError> {
        let source = self.resolve_table_by_path(sec, para, path)?;
        if start_row > end_row || start_col > end_col
            || end_row >= source.row_count || end_col >= source.col_count
        {
            return Err(error("복사할 셀 범위가 올바르지 않습니다"));
        }
        let mut bounds = Rect {
            top: start_row, left: start_col, bottom: end_row + 1, right: end_col + 1,
        };
        loop {
            let before = bounds;
            for cell in &source.cells {
                let rect = Rect::of(cell);
                if bounds.intersects(rect) {
                    bounds.top = bounds.top.min(rect.top);
                    bounds.left = bounds.left.min(rect.left);
                    bounds.bottom = bounds.bottom.max(rect.bottom);
                    bounds.right = bounds.right.max(rect.right);
                }
            }
            if before.contains(bounds) { break; }
        }
        if bounds.bottom > source.row_count || bounds.right > source.col_count {
            return Err(error("병합 셀의 범위가 표를 벗어납니다"));
        }
        let mut table = source.clone();
        table.cells.retain(|cell| bounds.contains(Rect::of(cell)));
        for cell in &mut table.cells {
            cell.row -= bounds.top;
            cell.col -= bounds.left;
        }
        table.zones.retain_mut(|zone| {
            let top = zone.start_row.max(bounds.top);
            let left = zone.start_col.max(bounds.left);
            let bottom = zone.end_row.min(bounds.bottom - 1);
            let right = zone.end_col.min(bounds.right - 1);
            if top > bottom || left > right { return false; }
            zone.start_row = top - bounds.top;
            zone.start_col = left - bounds.left;
            zone.end_row = bottom - bounds.top;
            zone.end_col = right - bounds.left;
            true
        });
        table.row_count = bounds.bottom - bounds.top;
        table.col_count = bounds.right - bounds.left;
        table.caption = None;
        table.rebuild_grid();
        table.rebuild_row_sizes();
        table.update_ctrl_dimensions();
        let text = (0..table.row_count).map(|row| {
            (0..table.col_count).map(|col| {
                table.cell_at(row, col).filter(|c| c.row == row && c.col == col)
                    .map(|c| c.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default()
            }).collect::<Vec<_>>().join("\t")
        }).collect::<Vec<_>>().join("\n");
        let (owner, last) = path.split_at(path.len() - 1);
        self.copy_control_native(sec, para, owner, last[0].0)?;
        let clip = self.clipboard.as_mut().expect("copied control");
        clip.paragraphs[0].controls[0] = Control::Table(Box::new(table));
        clip.paragraphs[0].ctrl_data_records.clear();
        clip.plain_text = text;
        clip.section_idx = sec;
        Ok("{\"ok\":true}".to_owned())
    }

    pub fn export_cell_block_html_native(&self) -> Result<String, HwpError> {
        let clip = self.clipboard.as_ref().ok_or_else(|| error("클립보드가 비어 있습니다"))?;
        let Some(control @ Control::Table(_)) = clip.paragraphs.first().and_then(|p| p.controls.first())
        else { return Err(error("복사한 표가 없습니다")) };
        Ok(format!("<html><body><!--StartFragment-->{}<!--EndFragment--></body></html>",
            self.control_to_html(control, 0)))
    }

    fn cell_paste_source(
        &self, sec: usize, para: usize, path: &[(usize, usize, usize)], format: &str, bytes: &[u8],
    ) -> Result<Document, HwpError> {
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(error("복사 데이터가 너무 큽니다"));
        }
        if format == "document" {
            return crate::parser::parse_document(bytes).map_err(|e| error(e.to_string()));
        }
        let text = std::str::from_utf8(bytes).map_err(|e| error(e.to_string()))?;
        if format == "model" { return Self::clipboard_model_document(text); }
        if format != "html" { return Err(error("복사 형식이 올바르지 않습니다")); }
        let mut scratch = Self::new_empty();
        let width = self.resolve_innermost_cell_metrics(sec, para, path)
            .map_or(0, |(w, l, r)| (w - i32::from(l) - i32::from(r)).max(0) as u32);
        let paragraphs = scratch.parse_html_to_paragraphs(text, width);
        scratch.document.sections = vec![crate::model::document::Section {
            paragraphs, ..Default::default()
        }];
        Ok(scratch.document)
    }

    pub fn can_paste_cells_native(
        &self, sec: usize, para: usize, path: &[(usize, usize, usize)], format: &str, bytes: &[u8],
    ) -> bool {
        self.resolve_table_by_path(sec, para, path).ok()
            .zip(path.last()).is_some_and(|(table, step)| step.1 < table.cells.len())
            && self.cell_paste_source(sec, para, path, format, bytes).ok()
                .is_some_and(|doc| standalone_table(&doc).is_some())
    }

    pub fn paste_cells_native(
        &mut self, sec: usize, para: usize, path: &[(usize, usize, usize)], offset: usize,
        format: &str, bytes: &[u8], mode: &str, origin: Option<(u16, u16)>,
    ) -> Result<String, HwpError> {
        self.finish_range_source();
        let foreign = self.cell_paste_source(sec, para, path, format, bytes)?;
        let (pi, ci) = standalone_table(&foreign).ok_or_else(|| error("복사한 표가 없습니다"))?;
        if mode == "nested" {
            return self.paste_fragment_document(sec, para, path, offset, foreign);
        }
        let Control::Table(source) = &foreign.sections[0].paragraphs[pi].controls[ci] else { unreachable!() };
        if source.cells.iter().any(|c| c.row_span == 0 || c.col_span == 0
            || u32::from(c.row) + u32::from(c.row_span) > u32::from(source.row_count)
            || u32::from(c.col) + u32::from(c.col_span) > u32::from(source.col_count))
        {
            return Err(error("복사한 표의 셀 범위가 올바르지 않습니다"));
        }
        let mut target = self.resolve_table_by_path(sec, para, path)?.clone();
        let &(control, cell, _) = path.last().ok_or_else(|| error("붙일 셀이 없습니다"))?;
        let anchor = if let Some((row, col)) = origin {
            target.cell_at(row, col)
        } else { target.cells.get(cell) }.ok_or_else(|| error("붙일 셀이 없습니다"))?;
        let (mut row, mut col) = (anchor.row, anchor.col);
        let (row_end, col_end) = (Rect::of(anchor).bottom, Rect::of(anchor).right);
        // A single copied cell can overwrite one merged destination cell.
        let replace_one = matches!(mode, "overwrite" | "contents")
            && source.row_count == 1 && source.col_count == 1;
        if path.len() == 1 && mode != "contents" {
            self.ensure_table_cell_topology_supported(sec, para, control)?;
        }
        match mode {
            "above" | "below" => {
                let edge = if mode == "below" { row_end } else { row };
                for _ in 0..source.row_count {
                    insert_row(&mut target, edge)?;
                }
                row = edge;
            }
            "left" | "right" => {
                let edge = if mode == "right" { col_end } else { col };
                for _ in 0..source.col_count {
                    insert_col(&mut target, edge)?;
                }
                col = edge;
            }
            "overwrite" | "contents" => {}
            _ => return Err(error("셀 붙이기 방식이 올바르지 않습니다")),
        }
        let bounds = Rect {
            top: row, left: col,
            bottom: if replace_one { row_end } else {
                row.checked_add(source.row_count).ok_or_else(|| error("붙일 행 범위가 너무 큽니다"))?
            },
            right: if replace_one { col_end } else {
                col.checked_add(source.col_count).ok_or_else(|| error("붙일 열 범위가 너무 큽니다"))?
            },
        };
        while target.row_count < bounds.bottom {
            let edge = target.row_count;
            insert_row(&mut target, edge)?;
        }
        while target.col_count < bounds.right {
            let edge = target.col_count;
            insert_col(&mut target, edge)?;
        }
        if target.cells.iter().any(|c| bounds.intersects(Rect::of(c)) && !bounds.contains(Rect::of(c))) {
            return Err(error("붙일 범위가 병합 셀의 일부와 겹칩니다"));
        }
        let mut paragraphs = foreign.sections[0].paragraphs.clone();
        // Preflight identity/reference rewriting before importing resources.
        super::clone_identity::reidentify_clipboard(&self.document, &mut paragraphs)?;
        self.remap_clipboard_paragraphs(&foreign, &mut paragraphs);
        // Resource import strips section-scoped controls, so the table's
        // control index in the parsed HWPX is no longer its working index.
        let source = std::mem::take(&mut paragraphs[pi].controls).into_iter().find_map(|control| {
            if let Control::Table(table) = control { Some(table) } else { None }
        }).ok_or_else(|| error("붙일 표의 구조를 읽지 못했습니다"))?;

        if mode == "contents" {
            let mut content: BTreeMap<usize, Vec<Paragraph>> = BTreeMap::new();
            for cell in source.cells {
                if let Some(index) = target.cell_index_at(row + cell.row, col + cell.col) {
                    content.entry(index).or_default().extend(cell.paragraphs);
                }
            }
            for (index, cell) in target.cells.iter_mut().enumerate() {
                if bounds.contains(Rect::of(cell)) {
                    cell.paragraphs = content.remove(&index).filter(|p| !p.is_empty())
                        .unwrap_or_else(|| vec![Paragraph::new_empty()]);
                }
            }
        } else {
            let widths = target.get_column_widths();
            let heights = target.get_raw_row_heights();
            let replacements = source.cells.into_iter().map(|mut cell| {
                cell.row += row;
                cell.col += col;
                if replace_one {
                    cell.row_span = bounds.bottom - bounds.top;
                    cell.col_span = bounds.right - bounds.left;
                }
                let rect = Rect::of(&cell);
                if let Some(existing) = target.cell_at(cell.row, cell.col)
                    .filter(|existing| Rect::of(existing) == rect)
                {
                    (cell.width, cell.height) = (existing.width, existing.height);
                } else {
                    cell.width = widths[rect.left as usize..rect.right as usize]
                        .iter().copied().fold(0u32, u32::saturating_add);
                    cell.height = heights[rect.top as usize..rect.bottom as usize]
                        .iter().copied().fold(0u32, u32::saturating_add);
                }
                if !cell.apply_inner_margin {
                    let padding = |p: Padding| (p.left, p.right, p.top, p.bottom);
                    if padding(source.padding) != padding(target.padding) {
                        cell.padding = source.padding;
                        cell.apply_inner_margin = true;
                    }
                }
                if cell.paragraphs.is_empty() { cell.paragraphs.push(Paragraph::new_empty()); }
                cell
            }).collect::<Vec<_>>();
            target.cells.retain(|c| !bounds.contains(Rect::of(c)));
            target.cells.extend(replacements);
            target.cells.sort_by_key(|c| (c.row, c.col));
            target.rebuild_grid();
            target.rebuild_row_sizes();
            target.invalidate_layout_page_break();
        }
        let cell_index = target.cell_index_at(row, col).unwrap_or(cell);
        let changed: Vec<_> = target.cells.iter().enumerate()
            .filter(|(_, c)| bounds.contains(Rect::of(c)))
            .map(|(i, c)| (i, c.paragraphs.len())).collect();
        *self.resolve_table_mut_by_cell_path(sec, para, path)? = target;
        let mut cell_path = path.to_vec();
        let last = path.len() - 1;
        for (index, count) in changed {
            for p in 0..count {
                cell_path[last] = (control, index, p);
                self.reflow_cell_paragraph_by_path(sec, para, &cell_path, p);
            }
            self.recalculate_cell_paragraph_vpos_by_path(sec, para, &cell_path, 0, None);
        }
        self.document.sections[sec].raw_stream = None;
        self.mark_cell_control_dirty(sec, para, path[0].0);
        self.mark_section_dirty(sec);
        self.paginate_if_needed();
        self.event_log.push(DocumentEvent::ContentPasted { section: sec, para });
        Ok(serde_json::json!({
            "ok": true, "cellIndex": cell_index, "cellParaIdx": 0, "charOffset": 0,
        }).to_string())
    }
}

fn insert_row(table: &mut Table, edge: u16) -> Result<(), HwpError> {
    let append = edge == table.row_count;
    table.insert_row(edge - u16::from(append), append).map_err(error)
}

fn insert_col(table: &mut Table, edge: u16) -> Result<(), HwpError> {
    let append = edge == table.col_count;
    table.insert_column(edge - u16::from(append), append).map_err(error)
}
