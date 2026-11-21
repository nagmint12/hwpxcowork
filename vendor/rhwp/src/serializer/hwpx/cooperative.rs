//! [hwpx-cowork] 편집 중에는 불변 저장 사본에서 구역의 문단 또는 표의 행을 나누어 쓴다.
//! 쪽·문단 ID, 표 원장, 개체 참조는 같은 직렬화 컨텍스트에서 입력 순서대로 진행한다.
use super::{context::SerializeContext, header, section, table, writer::HwpxZipWriter};
use crate::model::{control::Control, document::Document};
use crate::serializer::SerializeError;
use crate::storage::Unbounded;
use quick_xml::Writer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Target {
    Table(usize),
    Body(usize),
}

#[derive(Debug)]
pub(super) enum ChunkHook {
    Capture(Target),
    Captured(Box<SerializeContext>, u32),
    Written(Target, Box<SerializeContext>, Vec<u8>),
}

// The ordinary section writer determines the exact state at the boundary,
// including preceding controls. Unwinding affects the placeholder context only.
pub(super) fn exchange(
    ctx: &mut SerializeContext,
    target: Target,
    cursor: u32,
) -> Result<Option<Vec<u8>>, SerializeError> {
    match ctx.chunk.as_ref() {
        Some(ChunkHook::Capture(owner) | ChunkHook::Written(owner, ..)) if *owner == target => (),
        _ => return Ok(None),
    }
    match ctx.chunk.take() {
        Some(ChunkHook::Capture(_)) => {
            let prefix = Box::new(std::mem::take(ctx));
            ctx.chunk = Some(ChunkHook::Captured(prefix, cursor));
            Err(SerializeError::XmlError(
                "cooperative section boundary".into(),
            ))
        }
        Some(ChunkHook::Written(_, after, bytes)) => {
            *ctx = *after;
            Ok(Some(bytes))
        }
        _ => unreachable!(),
    }
}

#[derive(Clone, Copy)]
enum Source {
    Table(usize),
    Body,
}

fn source(doc: &Document) -> Option<Source> {
    let section = doc.sections.first()?;
    let para = section.paragraphs.first()?;
    // A smaller unit already fits in a single ordinary writer call. Large
    // sections and row-major tables use the same writers in bounded batches.
    for (index, control) in para.controls.iter().enumerate() {
        if let Control::Table(t) = control {
            if t.cells.len() >= 128
                && t.cells.is_sorted_by_key(|c| (c.row, c.col))
                && t.cells
                    .chunk_by(|a, b| a.row == b.row)
                    .enumerate()
                    .all(|(i, row)| usize::from(row[0].row) == i)
                && t.cells
                    .last()
                    .is_some_and(|c| usize::from(c.row) + 1 == usize::from(t.row_count))
            {
                return Some(Source::Table(index));
            }
        }
    }
    (section.paragraphs.len() >= 128).then_some(Source::Body)
}

pub(crate) fn can_split(doc: &Document) -> bool {
    source(doc).is_some()
}

pub(crate) struct Save {
    doc: Document,
    source: Source,
    target: Target,
    ctx: Box<SerializeContext>,
    cursor: u32,
    next: usize,
    bytes: Vec<u8>,
    done: bool,
}

impl Save {
    pub(crate) fn new(doc: Document) -> Result<Option<Self>, SerializeError> {
        let Some(source) = source(&doc) else {
            return Ok(None);
        };
        let sec = &doc.sections[0];
        if !matches!(
            crate::serializer::column_sizes::for_export_with_storage(sec, &Unbounded),
            Ok(std::borrow::Cow::Borrowed(_))
        ) {
            return Ok(None);
        }
        let target = match source {
            Source::Table(index) => {
                let Control::Table(t) = &sec.paragraphs[0].controls[index] else {
                    unreachable!()
                };
                Target::Table(t.as_ref() as *const _ as usize)
            }
            Source::Body => Target::Body(sec as *const _ as usize),
        };
        let mut ctx = SerializeContext::try_collect_from_document(&doc, &Unbounded, None)?;
        header::write_header_with_storage(&doc, &ctx, &Unbounded, false)?;
        ctx.chunk = Some(ChunkHook::Capture(target));
        let prefix = section::write_section_with_storage(sec, &doc, 0, &mut ctx, &Unbounded);
        let Some(ChunkHook::Captured(ctx, cursor)) = ctx.chunk.take() else {
            prefix?; // a projected or replaced section takes the ordinary complete writer
            return Ok(None);
        };
        Ok(Some(Self {
            doc,
            source,
            target,
            ctx,
            cursor,
            next: usize::from(matches!(source, Source::Body)),
            bytes: Vec::new(),
            done: false,
        }))
    }

    pub(crate) fn step(&mut self, units: usize) -> Result<bool, SerializeError> {
        let sec = &self.doc.sections[0];
        match self.source {
            Source::Table(index) => {
                let Control::Table(t) = &sec.paragraphs[0].controls[index] else {
                    unreachable!()
                };
                let cells = &t.cells;
                let mut writer = Writer::new(&mut self.bytes);
                for _ in 0..units.max(1) {
                    let Some(first) = cells.get(self.next) else {
                        break;
                    };
                    let end =
                        self.next + cells[self.next..].partition_point(|c| c.row == first.row);
                    table::write_row(
                        &mut writer,
                        cells[self.next..end].iter(),
                        None,
                        &mut self.ctx,
                        &Unbounded,
                    )?;
                    self.next = end;
                }
                self.done = self.next == cells.len();
            }
            Source::Body => {
                let end = self
                    .next
                    .saturating_add(units.max(1))
                    .min(sec.paragraphs.len());
                let mut part = String::new();
                for p in &sec.paragraphs[self.next..end] {
                    section::write_body_paragraph(
                        &mut part,
                        p,
                        &mut self.cursor,
                        &mut self.ctx,
                        &Unbounded,
                    )?;
                }
                self.bytes.extend_from_slice(part.as_bytes());
                self.next = end;
                self.done = end == sec.paragraphs.len();
            }
        }
        Ok(self.done)
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, SerializeError> {
        if !self.done {
            return Err(SerializeError::XmlError(
                "저장 XML 작성이 끝나지 않았습니다.".into(),
            ));
        }
        let hook = ChunkHook::Written(self.target, self.ctx, self.bytes);
        let (out, report) = super::serialize_hwpx_into(
            &self.doc,
            HwpxZipWriter::uncompressed(),
            &Unbounded,
            None,
            false,
            Some(hook),
        )?;
        report.write_warnings_to_stderr();
        Ok(out.into_inner())
    }
}
