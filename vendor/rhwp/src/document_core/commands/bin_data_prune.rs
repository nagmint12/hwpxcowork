//! [#6840] 참조 없는 `BinData` 정리 — 발췌·부분 제출에서 파일이 줄지 않던 문제.
//!
//! `extract-pages` 는 본문·서식은 제대로 걷어내는데 `BinData`(그림) 스트림은 한 개도
//! 버리지 않았다. 그림이 많은 문서는 쪽을 한 장만 남겨도 파일이 거의 그대로다.
//!
//! ```text
//!   104쪽 6.5MB 문서에서 77쪽 한 장만 남긴 실측
//!                      파일        BinData            그 외
//!     원본           6,521,856   204개 6,177,814     209,205
//!     --from 77 --to 77  5,225,984   204개 5,078,167      24,184
//!                        ↑ 본문은 88% 줄었는데 파일은 20%       ↑ 스트림 0개 삭제
//! ```
//!
//! 이 모듈은 산출 문서가 실제로 참조하는 항목만 남기고 나머지를 버린다.
//!
//! ## 왜 재번호매김이 필요한가
//!
//! `ImageAttr.bin_data_id` 는 **1 기준 순번(위치)** 이라 `bin_data_content` 의 인덱스다
//! (`renderer::layout::utils::find_bin_data_index`). 항목을 지우면 뒤의 참조가 통째로
//! 한 칸씩 밀려 **그림이 조용히 뒤바뀐다.** 그래서 지우기와 동시에 모든 참조를 옮긴다.
//!
//! `BinDataContent.id`(= `BinData.storage_id`, 저장 시 `BIN%04X` 스트림 이름)는 순번과
//! 다른 값이다. 이 모듈은 storage id 를 **건드리지 않는다** — 이름이 바뀌면 스트림과
//! 레코드가 어긋나고, 구멍이 있는 문서에서 기존 id 와 충돌한다.
//!
//! ## 참조처
//!
//! 참조 수집과 재번호 매김은 공통 소유 문서 순회로 본문·바탕쪽을 찾는다.
//!
//! | 참조처 | 어디에 |
//! | --- | --- |
//! | `Picture.image_attr.bin_data_id` | `Control::Picture` · `ShapeObject::Picture` |
//! | `DrawingObjAttr.fill.image.bin_data_id` | 모든 도형의 채우기 |
//! | `BorderFill.fill.image.bin_data_id` | **DocInfo** — 문단 밖이라 항상 참조로 센다 |
//! | `Bullet::image_reference()` | **DocInfo** 그림 글머리표 — 같은 이유로 항상 참조로 센다 |
//! | `OleShape.bin_data_id` | OLE 개체 (`u32`) |
//!
//! `BorderFill` 은 문단이 아니라 DocInfo 에 있고 `border_fill_id` 로 참조되므로, 어떤
//! 문단이 남았는지와 무관하게 **살아 있는 참조로 본다.** 그쪽까지 걷어내려면 문단·셀·
//! 글자 모양의 `border_fill_id` 를 전수로 다시 세야 하는데, 이 명령의 목적(발췌 크기
//! 줄이기)에 비해 위험이 크다.
//!
//! ## ⚠ 내장 글꼴은 **순번이 아니라 storage id** 로 참조한다
//!
//! `Font::resolved_bin_data_id` 와 `SubstFont::resolved_bin_data_id` 는 `BinDataContent.id`
//! 다 — `load_bounded_embedded_font_bytes` 가 `content.id == font_id` 로 찾는다
//! (`queries::rendering`). 그림의 1 기준 순번과 **다른 축**이므로
//!
//! - 그 storage id 를 가진 항목은 참조가 없어도 남긴다
//! - 그 참조값은 **옮기지 않는다** (storage id 는 이 정리에서 불변이다)
//!
//! 이 축을 빠뜨리면 발췌본에서 내장 글꼴이 통째로 사라진다.

use std::collections::BTreeSet;

use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::shape::ShapeObject;

/// 정리 결과 요약.
///
/// 버린 바이트는 세지 않는다 — `BinDataBytes::len()` 은 `Lazy` 항목을 압축 해제하므로
/// 버리려고 훑는 것만으로 원본 전체를 메모리에 펴게 된다.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BinDataPruneReport {
    /// 정리 전 항목 수
    pub before: usize,
    /// 정리 후 항목 수
    pub after: usize,
}

impl BinDataPruneReport {
    /// 버린 항목 수.
    pub fn removed(&self) -> usize {
        self.before.saturating_sub(self.after)
    }
}

/// 문서 안의 모든 `u16` `bin_data_id` 참조를 방문한다.
///
/// 순회가 찾은 참조에 `f`의 변경을 반영한다.
fn visit_bin_data_refs(doc: &mut Document, f: &mut dyn FnMut(&mut u16)) {
    use crate::model::identity::walk::{walk, Node};

    fn remap_ole(value: &mut u32, f: &mut dyn FnMut(&mut u16)) {
        if let Ok(mut id) = u16::try_from(*value) {
            f(&mut id);
            *value = u32::from(id);
        }
    }
    let mut visit = |node: &mut Node<'_>| {
        match node {
            Node::Control(Control::Picture(pic)) => f(&mut pic.image_attr.bin_data_id),
            Node::Shape(shape) => {
                match shape {
                    ShapeObject::Picture(pic) => f(&mut pic.image_attr.bin_data_id),
                    ShapeObject::Ole(ole) => {
                        if ole.chart_id_ref.is_none() {
                            remap_ole(&mut ole.bin_data_id, f);
                        }
                        if let Some(fallback) = &mut ole.chart_switch_fallback {
                            remap_ole(&mut fallback.bin_data_id, f);
                        }
                    }
                    _ => {}
                }
                if let Some(image) = shape
                    .drawing_mut()
                    .and_then(|drawing| drawing.fill.image.as_mut())
                {
                    f(&mut image.bin_data_id);
                }
            }
            _ => {}
        }
        Ok(())
    };
    for section in &mut doc.sections {
        walk(&mut section.paragraphs, &mut visit).expect("infallible BinData remap");
        for master_page in &mut section.section_def.master_pages {
            walk(&mut master_page.paragraphs, &mut visit).expect("infallible BinData remap");
        }
    }
    // DocInfo 의 테두리/배경 이미지 채우기는 문단과 무관하게 살아 있는 참조다.
    for border_fill in &mut doc.doc_info.border_fills {
        if let Some(image) = border_fill.fill.image.as_mut() {
            f(&mut image.bin_data_id);
        }
    }
    // 그림 글머리표도 DocInfo 의 1 기준 순번 참조다. 읽는 자리(`image_reference`)와 같은
    // 필드에 되돌려 쓴다 — 순번은 줄기만 하므로 `u8` 자리를 넘지 않는다.
    for bullet in &mut doc.doc_info.bullets {
        let Some(mut id) = bullet.image_reference() else {
            continue;
        };
        f(&mut id);
        if bullet.raw_para_head.is_none() {
            bullet.image_data[3] = u8::try_from(id).unwrap_or(bullet.image_data[3]);
        } else {
            bullet.image_bullet = i32::from(id);
        }
    }
}

/// 참조처에서 쓰이는 `bin_data_content` 위치(0 기준)를 모은다.
///
/// 내장 글꼴이 storage id 로 쓰는 항목과 `keep_storage` 에 든 storage id 의 항목도
/// 쓰이는 것으로 센다.
fn live_positions(doc: &Document, keep_storage: &BTreeSet<u16>) -> BTreeSet<usize> {
    use crate::model::identity::walk::{walk_ref, RefNode};

    let before = doc.bin_data_content.len();
    if before == 0 {
        return BTreeSet::new();
    }

    // 1. 살아 있는 1 기준 순번을 모은다. 범위 밖 값(HWPX 차트 sparse id 등)은
    //    인덱스 의미가 아니므로 건드리지 않고 그대로 둔다.
    let mut referenced: BTreeSet<usize> = BTreeSet::new();
    let mut record = |id: u16| {
        if id > 0 && usize::from(id) <= before {
            referenced.insert(usize::from(id) - 1);
        }
    };
    let mut visit = |node: RefNode<'_>| {
        match node {
            RefNode::Control(Control::Picture(pic)) => record(pic.image_attr.bin_data_id),
            RefNode::Shape(shape) => {
                match shape {
                    ShapeObject::Picture(pic) => record(pic.image_attr.bin_data_id),
                    ShapeObject::Ole(ole) => {
                        if ole.chart_id_ref.is_none() {
                            if let Ok(id) = u16::try_from(ole.bin_data_id) {
                                record(id);
                            }
                        }
                        if let Some(fallback) = &ole.chart_switch_fallback {
                            if let Ok(id) = u16::try_from(fallback.bin_data_id) {
                                record(id);
                            }
                        }
                    }
                    _ => {}
                }
                if let Some(image) = shape
                    .drawing()
                    .and_then(|drawing| drawing.fill.image.as_ref())
                {
                    record(image.bin_data_id);
                }
            }
            _ => {}
        }
        Ok(())
    };
    let storage = &crate::storage::Unbounded;
    for section in &doc.sections {
        walk_ref(&section.paragraphs, storage, &mut visit).expect("infallible BinData scan");
        for master_page in &section.section_def.master_pages {
            walk_ref(&master_page.paragraphs, storage, &mut visit)
                .expect("infallible BinData scan");
        }
    }
    for image in doc
        .doc_info
        .border_fills
        .iter()
        .filter_map(|fill| fill.fill.image.as_ref())
    {
        record(image.bin_data_id);
    }
    for id in doc
        .doc_info
        .bullets
        .iter()
        .filter_map(|bullet| bullet.image_reference())
    {
        record(id);
    }

    // 1b. 내장 글꼴이 쓰는 storage id 를 가진 항목도 남긴다 — 순번 축이 아니므로
    //     참조값은 건드리지 않고 보존 대상에만 더한다.
    let mut kept_storage: BTreeSet<u16> = doc
        .doc_info
        .font_faces
        .iter()
        .flatten()
        .flat_map(|font| {
            [
                font.is_embedded
                    .then_some(font.resolved_bin_data_id)
                    .flatten(),
                font.subst_font
                    .as_ref()
                    .and_then(|sf| sf.is_embedded.then_some(sf.resolved_bin_data_id).flatten()),
            ]
        })
        .flatten()
        .collect();
    kept_storage.extend(keep_storage);
    for (index, content) in doc.bin_data_content.iter().enumerate() {
        // [hwpx-cowork] OOXML chart parts use sparse storage IDs, independent
        // of picture indexes. The HWPX writer resolves their OLE references.
        if kept_storage.contains(&content.id) || content.extension == "ooxml_chart" {
            referenced.insert(index);
        }
    }
    referenced
}

/// 어디서도 참조하지 않는 `BinData` 의 storage id 를 모은다.
///
/// [#8941] 불러온 원본이 처음부터 참조 없이 지니고 있던 항목을 가려 두려고 쓴다 —
/// 편집으로 참조가 끊긴 항목과 달리 이것들은 저장할 때도 그대로 옮긴다.
pub(crate) fn unreferenced_bin_data_storage_ids(doc: &Document) -> BTreeSet<u16> {
    let live = live_positions(doc, &BTreeSet::new());
    doc.bin_data_content
        .iter()
        .enumerate()
        .filter(|(index, _)| !live.contains(index))
        .map(|(_, content)| content.id)
        .collect()
}

/// 산출 문서가 참조하지 않는 `BinData` 를 버리고 남은 참조를 옮긴다.
///
/// 참조가 없거나 버릴 것이 없으면 문서를 건드리지 않는다.
pub(crate) fn prune_unreferenced_bin_data(doc: &mut Document) -> BinDataPruneReport {
    let before = doc.bin_data_content.len();
    let referenced = live_positions(doc, &BTreeSet::new());
    if referenced.len() == before {
        return BinDataPruneReport {
            before,
            after: before,
        };
    }
    BinDataPrunePlan(referenced).apply(doc)
}

pub(crate) struct BinDataPrunePlan(BTreeSet<usize>);

/// [hwpx-cowork] Fast-save preflight reads without cloning. The planned indexes
/// belong to this document and its export snapshot, including original orphans.
pub(crate) fn plan_bin_data_prune(
    doc: &Document,
    keep_storage: &BTreeSet<u16>,
) -> Option<BinDataPrunePlan> {
    if doc
        .bin_data_content
        .iter()
        .all(|item| keep_storage.contains(&item.id) || item.extension == "ooxml_chart")
    {
        return None;
    }
    let referenced = live_positions(doc, keep_storage);
    if referenced.len() == doc.bin_data_content.len() {
        return None;
    }
    // The save snapshot updates both catalogues. A missing payload, a linked
    // slot, or a chart followed by differently indexed media cannot prove
    // that both catalogues use the same positions.
    let (payloads, charts) = doc
        .bin_data_content
        .split_at_checked(doc.doc_info.bin_data_list.len())?;
    let mut storage_ids = BTreeSet::new();
    if !payloads
        .iter()
        .zip(&doc.doc_info.bin_data_list)
        .all(|(payload, entry)| {
            payload.id != 0
                && payload.id == entry.storage_id
                && payload.extension != "ooxml_chart"
                && storage_ids.insert(payload.id)
        })
        || charts.iter().any(|item| item.extension != "ooxml_chart")
    {
        return None;
    }
    Some(BinDataPrunePlan(referenced))
}

impl BinDataPrunePlan {
    pub(crate) fn apply(&self, doc: &mut Document) -> BinDataPruneReport {
        apply_prune(doc, &self.0)
    }
}

fn apply_prune(doc: &mut Document, referenced: &BTreeSet<usize>) -> BinDataPruneReport {
    let before = doc.bin_data_content.len();
    // 2. 옛 인덱스 → 새 인덱스. 남는 항목의 상대 순서는 유지한다.
    let mut new_index = vec![None; before];
    for (next, old) in referenced.iter().enumerate() {
        new_index[*old] = Some(next);
    }

    // 3. 참조를 옮긴다. 살아 있는 참조는 반드시 새 자리를 갖는다.
    visit_bin_data_refs(doc, &mut |id| {
        if *id == 0 || (*id as usize) > before {
            return;
        }
        if let Some(next) = new_index[*id as usize - 1] {
            *id = (next + 1) as u16;
        }
    });

    // 4. 두 목록을 같은 규칙으로 거른다 — 인덱스 정합이 깨지면 그림이 뒤바뀐다.
    let dropped_storage: BTreeSet<u16> = doc
        .bin_data_content
        .iter()
        .enumerate()
        .filter(|(i, _)| new_index[*i].is_none())
        .map(|(_, c)| c.id)
        .collect();

    let mut i = 0usize;
    doc.bin_data_content.retain(|_| {
        let keep = new_index[i].is_some();
        i += 1;
        keep
    });

    // `bin_data_list` 는 storage id 로 짝지어져 있다 — 남은 content 가 쓰지 않는
    // storage id 의 레코드만 버린다.
    let live_storage: BTreeSet<u16> = doc.bin_data_content.iter().map(|c| c.id).collect();
    doc.doc_info.bin_data_list.retain(|bd| {
        !dropped_storage.contains(&bd.storage_id) || live_storage.contains(&bd.storage_id)
    });

    BinDataPruneReport {
        before,
        after: doc.bin_data_content.len(),
    }
}
