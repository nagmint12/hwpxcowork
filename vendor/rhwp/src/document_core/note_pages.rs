//! [hwpx-cowork] 쪽마다 새로(footNotePr numbering ON_PAGE) 각주 번호 — 쪽 나눔이 끝난 뒤 각주가 놓인 쪽으로 다시 매긴다.
//!
//! 번호 글자 폭이 바뀌면 줄·쪽 나눔이 바뀔 수 있으므로, 바뀐 구역을 다시 조판·쪽 나눔하고 번호가 더 바뀌지 않을
//! 때까지(최대 `MAX_SETTLE_PASSES` 번) 되풀이한다. 한/글이 저장한 쪽 번호가 맞는 문서는 첫 셈에서 바뀌는 것이 없어
//! 더 드는 비용이 없다. 셈 규칙은 `parser::assign_note_numbers_paged`.
use super::DocumentCore;
use crate::model::control::{AutoNumberType, Control};
use crate::model::footnote::FootnoteNumbering;
use crate::model::paragraph::Paragraph;
use crate::renderer::pagination::{FootnoteSource, PageItem, PaginationResult};
use std::collections::HashMap;

const MAX_SETTLE_PASSES: usize = 4;

// [hwpx-cowork] 0.9의 중첩 표 출처는 경로 전체로 식별한다. 다른 중첩 칸의 번호를 섞지 않는다.
type NotePath = Vec<(usize, usize, usize)>;
type NoteKey = (u8, usize, usize, NotePath);

fn source_key(source: &FootnoteSource) -> NoteKey {
    match source {
        FootnoteSource::Body { para_index, control_index } => (0, *para_index, *control_index, Vec::new()),
        FootnoteSource::TableCell { para_index, table_control_index, cell_index, cell_para_index, cell_control_index } =>
            (1, *para_index, *table_control_index, vec![(*cell_index, *cell_para_index, *cell_control_index)]),
        FootnoteSource::NestedTableCell { para_index, table_control_index, cell_path } =>
            (1, *para_index, *table_control_index, cell_path.iter().map(|step| (step.cell_index, step.cell_para_index, step.control_index)).collect()),
        FootnoteSource::ShapeTextBox { para_index, shape_control_index, tb_para_index, tb_control_index } =>
            (2, *para_index, *shape_control_index, vec![(0, *tb_para_index, *tb_control_index)]),
    }
}

/// 각주 사건이 든 자리 — 쪽 나눔이 아는 깊이(본문·본문 표 칸·본문 글상자)까지. 더 깊으면 본문 문단 쪽으로.
#[derive(Clone, Copy)]
enum Site {
    Body,
    Cell { para: usize, table: usize, cell: usize, row: usize },
    Nested { para: usize, table: usize, cell: usize },
    TextBox { para: usize, shape: usize },
    Deep { para: usize },
}

/// 한 구역의 쪽 나눔에서 찾은 자리 → 구역 안 쪽 번호.
struct PageIndex {
    /// 각주의 첫 조각(번호를 그리는 조각)이 놓인 쪽
    notes: HashMap<NoteKey, usize>,
    /// 본문 문단 → (쪽, 시작 줄, 끝 줄) — 통째면 0..MAX
    paras: HashMap<usize, Vec<(usize, usize, usize)>>,
    /// 표 (문단, 컨트롤) → (쪽, 시작 행, 끝 행)
    tables: HashMap<(usize, usize), Vec<(usize, usize, usize)>>,
}

impl PageIndex {
    fn new(result: &PaginationResult) -> Self {
        let mut index = PageIndex { notes: HashMap::new(), paras: HashMap::new(), tables: HashMap::new() };
        for (page_idx, page) in result.pages.iter().enumerate() {
            for note in &page.footnotes {
                // 앞 쪽에서 이어지는 꼬리 조각은 그 쪽 셈에 들지 않는다
                if note.fragment.is_some_and(|fragment| fragment.start_line > 0) {
                    continue;
                }
                index.notes.entry(source_key(&note.source)).or_insert(page_idx);
            }
            for column in &page.column_contents {
                for item in &column.items {
                    match *item {
                        PageItem::FullParagraph { para_index } => {
                            index.paras.entry(para_index).or_default().push((page_idx, 0, usize::MAX))
                        }
                        PageItem::PartialParagraph { para_index, start_line, end_line } => {
                            index.paras.entry(para_index).or_default().push((page_idx, start_line, end_line))
                        }
                        PageItem::Table { para_index, control_index } | PageItem::Shape { para_index, control_index } => {
                            index.paras.entry(para_index).or_default().push((page_idx, 0, usize::MAX));
                            index.tables.entry((para_index, control_index)).or_default().push((page_idx, 0, usize::MAX));
                        }
                        PageItem::PartialTable { para_index, control_index, start_row, end_row, .. } => {
                            index.paras.entry(para_index).or_default().push((page_idx, 0, usize::MAX));
                            index.tables.entry((para_index, control_index)).or_default().push((page_idx, start_row, end_row));
                        }
                        PageItem::EndnoteSeparator { .. } => {}
                    }
                }
            }
        }
        index
    }

    fn para_page(&self, para: usize, line: usize) -> Option<usize> {
        let spans = self.paras.get(&para)?;
        spans.iter().find(|(_, start, end)| (*start..*end).contains(&line)).or(spans.first()).map(|span| span.0)
    }

    /// 새 번호 컨트롤(또는 쪽 나눔에서 못 찾은 각주)의 쪽 — 컨트롤이 든 줄·표 행의 쪽.
    fn site_page(&self, site: Site, paragraphs: &[Paragraph], para_idx: usize, ctrl_idx: usize) -> Option<usize> {
        match site {
            Site::Body => {
                let para = paragraphs.get(para_idx)?;
                self.para_page(para_idx, control_line(para, ctrl_idx))
            }
            Site::Cell { para, table, row, .. } => self
                .tables
                .get(&(para, table))
                .and_then(|spans| spans.iter().find(|(_, start, end)| (*start..*end).contains(&row)).or(spans.first()))
                .map(|span| span.0)
                .or_else(|| self.para_page(para, 0)),
            Site::Nested { para, .. } | Site::TextBox { para, .. } | Site::Deep { para } => self.para_page(para, 0),
        }
    }
}

/// 컨트롤이 든 줄(LineSeg 차례). 컨트롤은 자기 글자 칸 바로 앞 8 유닛 자리에 있다.
fn control_line(para: &Paragraph, ctrl_idx: usize) -> usize {
    let Some(char_idx) = para.control_text_positions().get(ctrl_idx).copied() else {
        return 0;
    };
    let unit = match para.char_offsets.get(char_idx) {
        Some(offset) => offset.saturating_sub(1),
        None => u32::MAX,
    };
    para.line_segs.iter().rposition(|line| line.text_start <= unit).unwrap_or(0)
}

/// `assign_note_numbers_paged` 의 `walk` 와 같은 차례로 각주 사건의 쪽을 모은다.
fn collect(paragraphs: &[Paragraph], site: Site, path: &[(usize, usize, usize)], index: &PageIndex, body: &[Paragraph], out: &mut Vec<Option<usize>>) {
    for (pi, para) in paragraphs.iter().enumerate() {
        for (ci, ctrl) in para.controls.iter().enumerate() {
            // 본문 문단 차례(쪽 나눔 항목의 para_index)
            let top = match site {
                Site::Body => pi,
                Site::Cell { para, .. } | Site::Nested { para, .. } | Site::TextBox { para, .. } | Site::Deep { para } => para,
            };
            let fallback = |index: &PageIndex| index.site_page(site, body, pi, ci);
            match ctrl {
                Control::Footnote(_) => {
                    let key = match site {
                        Site::Body => Some((0, pi, ci, Vec::new())),
                        Site::Cell { para, table, cell, .. } | Site::Nested { para, table, cell } => {
                            let mut note_path = path.to_vec();
                            note_path.push((cell, pi, ci));
                            Some((1, para, table, note_path))
                        },
                        Site::TextBox { para, shape } => Some((2, para, shape, vec![(0, pi, ci)])),
                        Site::Deep { .. } => None,
                    };
                    out.push(key.and_then(|key| index.notes.get(&key).copied()).or_else(|| fallback(index)));
                }
                Control::NewNumber(nn) if nn.number_type == AutoNumberType::Footnote => out.push(fallback(index)),
                Control::Table(table) => {
                    for (cell_idx, cell) in table.cells.iter().enumerate() {
                        let inner = match site {
                            Site::Body => Site::Cell { para: pi, table: ci, cell: cell_idx, row: cell.row as usize },
                            Site::Cell { para, table, .. } | Site::Nested { para, table, .. } => Site::Nested { para, table, cell: cell_idx },
                            _ => Site::Deep { para: top },
                        };
                        let mut inner_path = path.to_vec();
                        if let Site::Cell { cell, .. } | Site::Nested { cell, .. } = site {
                            inner_path.push((cell, pi, ci));
                        }
                        collect(&cell.paragraphs, inner, &inner_path, index, body, out);
                    }
                }
                Control::Shape(shape) => {
                    if let Some(text_box) = shape.drawing().and_then(|d| d.text_box.as_ref()) {
                        let inner = match site {
                            Site::Body => Site::TextBox { para: pi, shape: ci },
                            _ => Site::Deep { para: top },
                        };
                        collect(&text_box.paragraphs, inner, &[], index, body, out);
                    }
                }
                _ => {}
            }
        }
    }
}

impl DocumentCore {
    /// 구역마다 각주 사건(각주·각주 새 번호)의 구역 안 쪽 — 쪽마다 새로 구역만, 그 밖은 빈 목록.
    fn footnote_event_pages(&self) -> Vec<Vec<Option<usize>>> {
        self.document
            .sections
            .iter()
            .enumerate()
            .map(|(idx, section)| {
                let mut out = Vec::new();
                if section.section_def.footnote_shape.numbering == FootnoteNumbering::RestartPage {
                    if let Some(result) = self.pagination.get(idx) {
                        let index = PageIndex::new(result);
                        collect(&section.paragraphs, Site::Body, &[], &index, &section.paragraphs, &mut out);
                    }
                }
                out
            })
            .collect()
    }

    /// 쪽 나눔 뒤 쪽마다 새로 각주 번호를 쪽으로 다시 매기고, 바뀐 구역을 다시 조판·쪽 나눔한다.
    pub(crate) fn settle_page_footnote_numbers(&mut self) {
        if self.source_format != crate::parser::FileFormat::Hwpx || self.progressive_open_job.is_some() {
            return;
        }
        let on_page = |core: &Self| {
            core.document
                .sections
                .iter()
                .any(|section| section.section_def.footnote_shape.numbering == FootnoteNumbering::RestartPage)
        };
        if !on_page(self) || self.pagination.len() != self.document.sections.len() {
            return;
        }
        let no_breaks = vec![std::collections::HashSet::new(); self.document.sections.len()];
        for _ in 0..MAX_SETTLE_PASSES {
            let pages = self.footnote_event_pages();
            let changed = crate::parser::assign_note_numbers_paged(&mut self.document, Some(&pages));
            if !changed.iter().any(|c| *c) {
                return;
            }
            for (idx, c) in changed.iter().enumerate() {
                if *c {
                    self.recompose_section(idx);
                }
            }
            self.paginate_pass(&no_breaks);
        }
    }
}
