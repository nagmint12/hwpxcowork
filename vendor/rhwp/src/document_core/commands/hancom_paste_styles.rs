//! [hwpx-cowork] 웹 → 한/글 붙여넣기에서 글꼴·크기·문단 모양이 바뀌던 문제(2026-11-03).
//!
//! 한/글의 붙여넣기는 받는 문서에 **같은 이름의 스타일**이 있으면 받는 문서의 스타일을 따른다
//! ('대상 스타일 사용'). 이때 run·문단의 각 속성을 **복사한 쪽 스타일 정의와 비교해 같은 속성만**
//! 받는 쪽 스타일 값으로 바꾸고, 다른 속성(직접 지정)은 남긴다(한/글 2022 도움말 '붙이기 옵션 단추',
//! '블록을 복사할 때의 스타일'). 글꼴은 이름으로, 크기·줄 간격 등은 값으로 견준다(실측). 실문서C
//! 의 차례는 바탕글(KoPub바탕체 Light 11pt, 줄 간격 180%) 문단이라 2022 새 문서에 붙이면 함초롬바탕 10pt·160% 로,
//! 차례 제목(&간지목차, KoPub돋움체 Bold 14pt)은 2018 표준서식 새 문서의 &간지목차(KoPub돋움체 Medium 9pt)로 바뀌었다.
//!
//! 그래서 한/글로 보내는 조각(문서모델 보드·같은 PC Hwp Native 변환 입력)에서만 문단 스타일의 정의를 '그 스타일
//! 문단의 run·문단이 쓰지 않는 값'으로 바꿔 둔다 — 겹치면 모든 속성이 직접 지정으로 비교돼 원본 글꼴·크기·문단 모양이
//! 그대로 남고, 문단은 여전히 받는 문서의 같은 이름 스타일에 붙는다(한/글 '원본 서식 유지'와 같은 모양).
//! 받는 쪽에 그 스타일이 없으면 조각의 정의가 새로 추가되므로 값은 가깝게 고른다:
//! - 바탕글·본문·개요 n 등 한/글 기본 스타일 — 거의 모든 문서에 있어 늘 겹친다. 한/글 새 문서 값(함초롬바탕·10pt·160%)부터.
//! - 사용자 스타일(&간지목차 등) — 원래 값 바로 옆(크기 0.01pt, 여백 1 HWPUNIT, 줄 간격 1%), 글꼴은 이름 앞부분이 가장
//!   많이 같은 문서 글꼴(같은 가족의 다른 굵기). 새로 추가된 정의의 글꼴 이름은 원본과 다르다(글꼴은 이름으로 견주므로 피할 수 없다).
//! 웹 → 웹 조각(`exportClipboardHwpx`)에는 쓰지 않는다 — 엔진 붙여넣기는 run 서식을 값으로 옮긴다.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{DrawingObjAttr, ShapeObject};
use crate::model::style::{Alignment, Font, LineSpacingType};

/// 한/글 새 문서의 기본 문단 스타일(한/글 2022 새 문서·2018 표준서식에서 확인). 이름 또는 영문 이름이
/// 같으면 한/글은 같은 스타일로 본다(도움말 '스타일 이름은 영문 이름이 우선함').
const BUILTIN_STYLES: [(&str, &str); 22] = [
    ("바탕글", "Normal"),
    ("본문", "Body"),
    ("개요 1", "Outline 1"),
    ("개요 2", "Outline 2"),
    ("개요 3", "Outline 3"),
    ("개요 4", "Outline 4"),
    ("개요 5", "Outline 5"),
    ("개요 6", "Outline 6"),
    ("개요 7", "Outline 7"),
    ("개요 8", "Outline 8"),
    ("개요 9", "Outline 9"),
    ("개요 10", "Outline 10"),
    ("머리말", "Header"),
    ("각주", "Footnote"),
    ("미주", "Endnote"),
    ("메모", "Memo"),
    ("차례 제목", "TOC Heading"),
    ("차례 1", "TOC 1"),
    ("차례 2", "TOC 2"),
    ("차례 3", "TOC 3"),
    ("캡션", "Caption"),
    ("쪽 번호", "Page Number"),
];

/// 비교 기준 글꼴 후보 — 한/글 새 문서 기본 글꼴부터.
const FONT_CANDIDATES: [&str; 6] = ["함초롬바탕", "함초롬돋움", "맑은 고딕", "바탕", "돋움", "굴림"];

fn is_builtin(local: &str, english: &str) -> bool {
    BUILTIN_STYLES.iter().any(|(ko, en)| local == *ko || (!english.is_empty() && english == *en))
}

/// 스타일별로 그 스타일 문단이 쓰는 글자 모양·문단 모양 번호.
#[derive(Default)]
struct Usage {
    char_shapes: BTreeSet<usize>,
    para_shapes: BTreeSet<usize>,
}

fn collect(paras: &[Paragraph], out: &mut BTreeMap<usize, Usage>) {
    for para in paras {
        let usage = out.entry(para.style_id as usize).or_default();
        usage.para_shapes.insert(para.para_shape_id as usize);
        for r in &para.char_shapes {
            usage.char_shapes.insert(r.char_shape_id as usize);
        }
        for control in &para.controls {
            collect_control(control, out);
        }
    }
}

fn collect_drawing(drawing: &DrawingObjAttr, out: &mut BTreeMap<usize, Usage>) {
    if let Some(text_box) = &drawing.text_box {
        collect(&text_box.paragraphs, out);
    }
    if let Some(caption) = &drawing.caption {
        collect(&caption.paragraphs, out);
    }
}

fn collect_shape(shape: &ShapeObject, out: &mut BTreeMap<usize, Usage>) {
    match shape {
        ShapeObject::Picture(pic) => {
            if let Some(caption) = &pic.caption {
                collect(&caption.paragraphs, out);
            }
        }
        ShapeObject::Group(group) => {
            for child in &group.children {
                collect_shape(child, out);
            }
            if let Some(caption) = &group.caption {
                collect(&caption.paragraphs, out);
            }
        }
        _ => {
            if let Some(drawing) = shape.drawing() {
                collect_drawing(drawing, out);
            }
        }
    }
}

fn collect_control(control: &Control, out: &mut BTreeMap<usize, Usage>) {
    match control {
        Control::Picture(pic) => {
            if let Some(caption) = &pic.caption {
                collect(&caption.paragraphs, out);
            }
        }
        Control::Shape(shape) => collect_shape(shape, out),
        Control::Table(table) => {
            for cell in &table.cells {
                collect(&cell.paragraphs, out);
            }
            if let Some(caption) = &table.caption {
                collect(&caption.paragraphs, out);
            }
        }
        Control::Header(h) => collect(&h.paragraphs, out),
        Control::Footer(h) => collect(&h.paragraphs, out),
        Control::Footnote(n) => collect(&n.paragraphs, out),
        Control::Endnote(n) => collect(&n.paragraphs, out),
        Control::HiddenComment(c) => collect(&c.paragraphs, out),
        Control::Field(field) => collect(&field.memo_paragraphs, out),
        Control::SectionDef(def) => {
            for master in &def.master_pages {
                collect(&master.paragraphs, out);
            }
        }
        _ => {}
    }
}

/// `preferred` 부터 `candidates` 순서로, `used` 에 없는 첫 값. 모두 쓰이면 `preferred` 에서 1씩 비켜 간다.
fn unused<T: Copy + Ord>(preferred: T, candidates: &[T], used: &BTreeSet<T>, step: impl Fn(T, i32) -> Option<T>) -> T {
    if !used.contains(&preferred) {
        return preferred;
    }
    if let Some(v) = candidates.iter().copied().find(|v| !used.contains(v)) {
        return v;
    }
    (1..1000).flat_map(|k| [step(preferred, k), step(preferred, -k)]).flatten().find(|v| !used.contains(v)).unwrap_or(preferred)
}

fn font_id(doc: &mut Document, lang: usize, name: &str) -> u16 {
    let faces = &mut doc.doc_info.font_faces[lang];
    if let Some(i) = faces.iter().position(|f| f.name == name) {
        return i as u16;
    }
    faces.push(Font { name: name.to_string(), alt_type: 1, ..Default::default() });
    (faces.len() - 1) as u16
}

/// 비교 기준 글꼴 — 기본 스타일은 한/글 새 문서 글꼴부터, 사용자 스타일은 원래 글꼴과 이름 앞부분이 가장 많이 같은
/// 문서 글꼴(같은 글꼴 가족의 다른 굵기 등)부터. 받는 쪽에 그 스타일이 없어 새로 추가될 때 정의가 원본과 가깝게 한다.
fn compare_font(doc: &Document, lang: usize, current: &str, used: &BTreeSet<String>, builtin: bool) -> Option<String> {
    let shared = |name: &str| current.chars().zip(name.chars()).take_while(|(a, b)| a == b).count();
    let mut family: Vec<&str> = doc.doc_info.font_faces[lang].iter().map(|f| f.name.as_str()).filter(|n| !used.contains(*n)).collect();
    family.sort_by_key(|n| (std::cmp::Reverse(shared(n)), *n));
    let defaults = FONT_CANDIDATES.iter().copied().filter(|n| !used.contains(*n));
    let pick = if builtin { defaults.chain(family).next() } else { family.into_iter().chain(defaults).next() };
    pick.map(str::to_string)
}

/// 한/글로 보내는 조각에서 문단 스타일의 글자·문단 모양 정의를 그 스타일 글이 쓰지 않는 비교 기준 값으로 바꾼다.
/// 문단·run 은 건드리지 않으므로 보이는 모양과 문단의 스타일 이름은 그대로다.
/// 기본 스타일은 한/글 새 문서 값(함초롬바탕·10pt·160%)부터, 사용자 스타일은 원래 값에 가장 가까운 값(크기 0.01pt,
/// 여백 1 HWPUNIT 차이 등)부터 고른다 — 받는 쪽에 없어 새로 추가되는 정의가 원본과 거의 같게.
pub(crate) fn adapt_styles_for_hancom_paste(doc: &mut Document) {
    if doc.doc_info.font_faces.len() < 7 {
        return;
    }
    let mut usage: BTreeMap<usize, Usage> = BTreeMap::new();
    for section in &doc.sections {
        collect(&section.paragraphs, &mut usage);
        for master in &section.section_def.master_pages {
            collect(&master.paragraphs, &mut usage);
        }
    }
    for (style_idx, used) in usage {
        let Some(style) = doc.doc_info.styles.get(style_idx) else { continue };
        if style.style_type != 0 {
            continue;
        }
        let builtin = is_builtin(&style.local_name, &style.english_name);
        // 기본 스타일은 한/글 기본값부터, 사용자 스타일은 원래 값 바로 옆 값부터
        let prefer = |defaults: &'static [i32]| -> &'static [i32] { if builtin { defaults } else { &[] } };
        let (base_cs, base_ps) = (style.char_shape_id as usize, style.para_shape_id as usize);
        let runs: Vec<_> = used.char_shapes.iter().filter_map(|&i| doc.doc_info.char_shapes.get(i).cloned()).collect();
        let paras: Vec<_> = used.para_shapes.iter().filter_map(|&i| doc.doc_info.para_shapes.get(i).cloned()).collect();

        if let Some(mut cs) = doc.doc_info.char_shapes.get(base_cs).cloned() {
            cs.raw_data = None;
            for lang in 0..7 {
                let name_of = |doc: &Document, id: u16| doc.doc_info.font_faces[lang].get(id as usize).map(|f| f.name.clone());
                let used_names: BTreeSet<String> = runs.iter().filter_map(|r| name_of(doc, r.font_ids[lang])).collect();
                if let Some(current) = name_of(doc, cs.font_ids[lang]).filter(|n| used_names.contains(n)) {
                    if let Some(name) = compare_font(doc, lang, &current, &used_names, builtin) {
                        cs.font_ids[lang] = font_id(doc, lang, &name);
                    }
                }
                let set = |f: &dyn Fn(&crate::model::style::CharShape) -> i32| runs.iter().map(f).collect::<BTreeSet<i32>>();
                let ratios = set(&|r| i32::from(r.ratios[lang]));
                cs.ratios[lang] = unused(i32::from(cs.ratios[lang]), prefer(&[100, 95, 105, 90, 110]), &ratios, |v, k| u8::try_from(v + k).ok().filter(|v| (50..=200).contains(v)).map(i32::from)) as u8;
                let spacings = set(&|r| i32::from(r.spacings[lang]));
                cs.spacings[lang] = unused(i32::from(cs.spacings[lang]), prefer(&[0, -5, 5, -10, 10]), &spacings, |v, k| i8::try_from(v + k).ok().filter(|v| (-50..=50).contains(v)).map(i32::from)) as i8;
                let sizes = set(&|r| i32::from(r.relative_sizes[lang]));
                cs.relative_sizes[lang] = unused(i32::from(cs.relative_sizes[lang]), prefer(&[100, 95, 105, 90, 110]), &sizes, |v, k| u8::try_from(v + k).ok().filter(|v| (10..=250).contains(v)).map(i32::from)) as u8;
                let offsets = set(&|r| i32::from(r.char_offsets[lang]));
                cs.char_offsets[lang] = unused(i32::from(cs.char_offsets[lang]), prefer(&[0, -5, 5, -10, 10]), &offsets, |v, k| i8::try_from(v + k).ok().filter(|v| (-100..=100).contains(v)).map(i32::from)) as i8;
            }
            let heights: BTreeSet<i32> = runs.iter().map(|r| r.base_size).collect();
            let step = if builtin { 10 } else { 1 };
            cs.base_size = unused(cs.base_size, prefer(&[1000, 900, 1100, 1200, 800, 1300]), &heights, |v, k| Some(v + k * step).filter(|v| *v > 0));
            let colors: BTreeSet<u32> = runs.iter().map(|r| r.text_color).collect();
            cs.text_color = unused(cs.text_color, &[], &colors, |v, k| u32::try_from(i64::from(v) + i64::from(k)).ok().filter(|v| *v <= 0x00FF_FFFF));
            doc.doc_info.char_shapes.push(cs);
            doc.doc_info.styles[style_idx].char_shape_id = (doc.doc_info.char_shapes.len() - 1) as u16;
        }

        if let Some(mut ps) = doc.doc_info.para_shapes.get(base_ps).cloned() {
            ps.raw_data = None;
            let set = |f: &dyn Fn(&crate::model::style::ParaShape) -> i32| paras.iter().map(f).collect::<BTreeSet<i32>>();
            let near = |v: i32, k: i32| Some(v + k);
            ps.margin_left = unused(ps.margin_left, prefer(&[0]), &set(&|p| p.margin_left), near);
            ps.margin_right = unused(ps.margin_right, prefer(&[0]), &set(&|p| p.margin_right), near);
            ps.indent = unused(ps.indent, prefer(&[0]), &set(&|p| p.indent), near);
            ps.spacing_before = unused(ps.spacing_before, prefer(&[0]), &set(&|p| p.spacing_before), near);
            ps.spacing_after = unused(ps.spacing_after, prefer(&[0]), &set(&|p| p.spacing_after), near);
            // 정렬: 그 스타일 문단이 쓰지 않는 정렬(가운데 정렬 제목이 받는 쪽 양쪽 정렬로 바뀌던 것, 2018 실측)
            let aligns: Vec<Alignment> = paras.iter().map(|p| p.alignment).collect();
            if aligns.contains(&ps.alignment) {
                let all = [Alignment::Justify, Alignment::Left, Alignment::Center, Alignment::Right, Alignment::Distribute, Alignment::Split];
                if let Some(a) = all.into_iter().find(|a| !aligns.contains(a)) {
                    ps.alignment = a;
                }
            }
            // 줄 간격은 종류가 같은 문단끼리만 견준다(종류가 다르면 이미 다른 속성이다).
            let kind = ps.line_spacing_type;
            let same_kind: BTreeSet<i32> = paras.iter().filter(|p| p.line_spacing_type == kind).map(|p| p.line_spacing).collect();
            let candidates: &[i32] = if builtin && kind == LineSpacingType::Percent { &[160, 150, 170, 130, 180, 200] } else { &[] };
            ps.line_spacing = unused(ps.line_spacing, candidates, &same_kind, |v, k| Some(v + k).filter(|v| *v > 0));
            doc.doc_info.para_shapes.push(ps);
            doc.doc_info.styles[style_idx].para_shape_id = (doc.doc_info.para_shapes.len() - 1) as u16;
        }
    }
}
