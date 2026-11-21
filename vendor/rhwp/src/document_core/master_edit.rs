//! [hwpx-cowork] 바탕쪽은 본문처럼 같은 원본 문단에 여러 쪽이 연결된다.
//! 셀과 글상자의 문단도 실제 소유 경로를 사용하고 undo에서는 그 경로 하나만 바꾼다.
use crate::model::{control::Control, header_footer::MasterPage, paragraph::Paragraph};

#[derive(Clone)]
pub(crate) enum Child {
    Cell {
        control: usize,
        cell: usize,
        paragraph: usize,
    },
    TextBox {
        control: usize,
        paragraph: usize,
    },
}

#[derive(Clone)]
pub(crate) struct MasterPath {
    root: usize,
    children: Vec<Child>,
}

pub(crate) struct Entry<'a> {
    pub(crate) path: MasterPath,
    pub(crate) paragraph: &'a Paragraph,
    pub(crate) width: i32,
}

pub(crate) fn entries(master: &MasterPage, fallback_width: i32) -> Vec<Entry<'_>> {
    fn visit<'a>(
        paragraph: &'a Paragraph,
        path: &mut MasterPath,
        width: i32,
        out: &mut Vec<Entry<'a>>,
    ) {
        out.push(Entry {
            path: path.clone(),
            paragraph,
            width,
        });
        for (control, child) in paragraph.controls.iter().enumerate() {
            match child {
                Control::Table(table) => {
                    for (cell, source) in table.cells.iter().enumerate() {
                        let padding = source.effective_padding(&table.padding);
                        let width = (i64::from(source.width)
                            - i64::from(padding.left)
                            - i64::from(padding.right))
                        .clamp(0, i64::from(i32::MAX)) as i32;
                        for (index, nested) in source.paragraphs.iter().enumerate() {
                            path.children.push(Child::Cell {
                                control,
                                cell,
                                paragraph: index,
                            });
                            visit(nested, path, width, out);
                            path.children.pop();
                        }
                    }
                }
                Control::Shape(shape) => {
                    if let Some(textbox) = shape.drawing().and_then(|d| d.text_box.as_ref()) {
                        let width = if textbox.max_width > 0 {
                            i64::from(textbox.max_width)
                        } else {
                            i64::from(shape.common().width)
                                - i64::from(textbox.margin_left)
                                - i64::from(textbox.margin_right)
                        };
                        for (index, nested) in textbox.paragraphs.iter().enumerate() {
                            path.children.push(Child::TextBox {
                                control,
                                paragraph: index,
                            });
                            visit(
                                nested,
                                path,
                                width.clamp(0, i64::from(i32::MAX)) as i32,
                                out,
                            );
                            path.children.pop();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut result = Vec::new();
    let width = if master.text_width > 0 {
        i32::try_from(master.text_width).unwrap_or(i32::MAX)
    } else {
        fallback_width
    };
    for (root, paragraph) in master.paragraphs.iter().enumerate() {
        visit(
            paragraph,
            &mut MasterPath {
                root,
                children: Vec::new(),
            },
            width,
            &mut result,
        );
    }
    result
}

impl MasterPath {
    pub(crate) fn in_textbox(&self) -> bool {
        matches!(self.children.last(), Some(Child::TextBox { .. }))
    }

    pub(crate) fn resolve_mut<'a>(&self, master: &'a mut MasterPage) -> Option<&'a mut Paragraph> {
        let mut p = master.paragraphs.get_mut(self.root)?;
        for child in &self.children {
            p = match *child {
                Child::Cell {
                    control,
                    cell,
                    paragraph,
                } => {
                    let Control::Table(table) = p.controls.get_mut(control)? else {
                        return None;
                    };
                    table.cells.get_mut(cell)?.paragraphs.get_mut(paragraph)?
                }
                Child::TextBox { control, paragraph } => {
                    let Control::Shape(shape) = p.controls.get_mut(control)? else {
                        return None;
                    };
                    shape
                        .drawing_mut()?
                        .text_box
                        .as_mut()?
                        .paragraphs
                        .get_mut(paragraph)?
                }
            };
        }
        Some(p)
    }
}
