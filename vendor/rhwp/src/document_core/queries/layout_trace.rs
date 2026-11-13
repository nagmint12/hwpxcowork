//! [hwpx-cowork] 조판 추적(layout trace) — 한/글과 어디서 어긋나는지 문단 단위로 짚기 위한 읽기 전용 덤프.
//!
//! 엔진이 **실제로 쓴 값**을 그대로 내놓는다: 문단마다 줄(LINE_SEG — 저장값인지 우리가 합성했는지), 개체(글자처럼 취급·
//! 배치·기준·여백·캡션), 쪽마다 조판 항목(`dump_page_items_json`). `scripts/layout-trace.mjs` 가 이것을 한/글이 다시
//! 저장한 HWPX 의 linesegarray(한/글의 vertpos·horzpos) 와 견주어 처음 갈라지는 문단과 그 자리의 값을 보여 준다.
//! 문서·조판 상태를 바꾸지 않는다.

use crate::document_core::DocumentCore;
use crate::model::control::Control;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::shape::{Caption, CommonObjAttr};

fn seg_json(seg: &LineSeg) -> serde_json::Value {
    serde_json::json!({
        "textStart": seg.text_start,
        "vpos": seg.vertical_pos,
        "lh": seg.line_height,
        "th": seg.text_height,
        "bl": seg.baseline_distance,
        "ls": seg.line_spacing,
        "x": seg.column_start,
        "w": seg.segment_width,
        "tag": seg.tag,
        "synthetic": seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0,
    })
}

fn caption_json(caption: Option<&Caption>) -> serde_json::Value {
    let Some(c) = caption else {
        return serde_json::Value::Null;
    };
    serde_json::json!({
        "side": format!("{:?}", c.direction),
        "gap": c.spacing,
        "width": c.width,
        "maxWidth": c.max_width,
        "lines": c.paragraphs.iter().flat_map(|p| p.line_segs.iter().map(seg_json)).collect::<Vec<_>>(),
        "text": c.paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n"),
    })
}

fn object_json(
    kind: &str,
    idx: usize,
    c: &CommonObjAttr,
    caption: Option<&Caption>,
) -> serde_json::Value {
    serde_json::json!({
        "idx": idx,
        "kind": kind,
        "tac": c.treat_as_char,
        "wrap": format!("{:?}", c.text_wrap),
        "vertRelTo": format!("{:?}", c.vert_rel_to),
        "vertAlign": format!("{:?}", c.vert_align),
        "horzRelTo": format!("{:?}", c.horz_rel_to),
        "horzAlign": format!("{:?}", c.horz_align),
        "vertOffset": c.vertical_offset,
        "horzOffset": c.horizontal_offset,
        "width": c.width,
        "height": c.height,
        "margin": [c.margin.left, c.margin.right, c.margin.top, c.margin.bottom],
        "flowWithText": c.flow_with_text,
        "allowOverlap": c.allow_overlap,
        "affectLSpacing": c.affect_line_spacing,
        "caption": caption_json(caption),
    })
}

fn paragraph_json(pi: usize, para: &Paragraph) -> serde_json::Value {
    let mut objects = Vec::new();
    for (ci, ctrl) in para.controls.iter().enumerate() {
        match ctrl {
            Control::Picture(p) => objects.push(object_json("picture", ci, &p.common, p.caption.as_ref())),
            Control::Table(t) => objects.push(object_json("table", ci, &t.common, t.caption.as_ref())),
            Control::Shape(s) => objects.push(object_json("shape", ci, s.common(), None)),
            Control::Equation(e) => objects.push(object_json("equation", ci, &e.common, None)),
            _ => {}
        }
    }
    let text: String = para.text.chars().filter(|c| !c.is_control()).take(40).collect();
    serde_json::json!({
        "pi": pi,
        "text": text,
        "chars": para.text.chars().count(),
        "paraShape": para.para_shape_id,
        "lines": para.line_segs.iter().map(seg_json).collect::<Vec<_>>(),
        "objects": objects,
    })
}

impl DocumentCore {
    /// 구역별 문단 줄·개체 + 쪽별 조판 항목. 쪽 번호는 0부터(전체 문서 기준).
    pub fn layout_trace_json(&self) -> serde_json::Value {
        use crate::renderer::hwpunit_to_px;
        let sections: Vec<serde_json::Value> = self
            .document
            .sections
            .iter()
            .enumerate()
            .map(|(si, sec)| {
                let pd = &sec.section_def.page_def;
                let body_top = pd.margin_top as i32 + pd.margin_header as i32;
                let body_height = pd.height as i32
                    - body_top
                    - pd.margin_bottom as i32
                    - pd.margin_footer as i32;
                serde_json::json!({
                    "index": si,
                    "page": {
                        "width": pd.width, "height": pd.height, "landscape": pd.landscape,
                        "left": pd.margin_left, "right": pd.margin_right, "top": pd.margin_top,
                        "bottom": pd.margin_bottom, "header": pd.margin_header, "footer": pd.margin_footer,
                    },
                    "bodyTopHU": body_top,
                    "bodyHeightHU": body_height,
                    "bodyTopPx": hwpunit_to_px(body_top, self.dpi),
                    "paragraphs": sec.paragraphs.iter().enumerate().map(|(pi, p)| paragraph_json(pi, p)).collect::<Vec<_>>(),
                })
            })
            .collect();
        // [hwpx-cowork] Dump the resolved frame consumed by both pagination and
        // paint. Source LINESEG values alone cannot show a later origin override.
        // Coordinates are column-relative px; sort keys for reproducible traces.
        let mut float_frames = Vec::new();
        let mut footnote_frames = Vec::new();
        let mut global_page = 0;
        for (section_index, result) in self.pagination.iter().enumerate() {
            for page in &result.pages {
                footnote_frames.push(serde_json::json!({
                    "page": global_page, "section": section_index,
                    "references": format!("{:?}", page.footnotes),
                }));
                for column in &page.column_contents {
                    let mut entries: Vec<_> = column.paragraph_float_placements.iter().collect();
                    entries.sort_by_key(|(key, _)| **key);
                    for (&(para_index, control_index), placement) in entries {
                        float_frames.push(serde_json::json!({
                            "page": global_page,
                            "section": section_index,
                            "column": column.column_index,
                            "para": para_index,
                            "control": control_index,
                            "flow": format!("{:?}", placement.flow),
                            "anchorY": placement.anchor_y,
                            "storedHostOrigin": placement.stored_host_origin,
                            "storedSuccessorLineOrigin": placement.stored_successor_line_origin,
                            "tableLeft": placement.table_left,
                            "tableTop": placement.table_top,
                            "occupiedBottom": placement.occupied_bottom,
                        }));
                    }
                }
                global_page += 1;
            }
        }
        serde_json::json!({
            "dpi": self.dpi,
            "pageCount": self.pagination.iter().map(|p| p.pages.len()).sum::<usize>(),
            "sections": sections,
            "pages": self.dump_page_items_json(None),
            "paragraphFloatFrames": float_frames,
            "footnoteFrames": footnote_frames,
        })
    }
}
