//! [hwpx-cowork] 한/글 2022 개체 기능 (2026-11-11) — 개체 순서·개체 보호·글 앞/뒤·개체 모양 복사/붙이기.
//!
//! 한/글 2022 COM 실측(`artifacts/h2022-object/com_probe.py`, 한/글 12.0.0.3146, 숨은 인스턴스 → HWPX 저장):
//!
//! - **개체 순서**(ShapeObjBringToFront·BringForward·SendToBack·SendBack): 문서 전체(모든 구역·표 칸 안 개체까지)의
//!   개체(도형·묶음·그림·표·수식·차트 …)가 하나의 순서를 이룬다. 명령 한 번이면 그 순서대로 **zOrder 를 0 부터 빈틈없이
//!   다시 매긴다**(이미 맨 앞인 개체에 '맨 앞으로'를 해도 다시 매긴다 — 9·20 이 7·8 로). 맨 앞 = 끝, 맨 뒤 = 처음,
//!   앞으로·뒤로 = 바로 위·아래 개체와 자리 바꿈(겹치지 않아도 바꾼다). 묶음 안 개체(groupLevel>0)는 셈에 들지 않는다.
//!   실측 문서: tests/fixtures/shapes_hangul.hwpx(도형 9) + 그림·표, REAL-police.hwpx(78개, 7구역, 칸 안 개체 포함).
//!   남은 차이: 한/글이 COM 으로 새로 넣은 그림·표(zOrder 18·19)는 다시 열었을 때 zOrder 0 인 도형보다 아래로 셈했다
//!   (원인 미확인 — ledger_object.md). 여기서는 저장된 zOrder 차례(같으면 문서 차례)를 따른다.
//! - **글 앞으로/글 뒤로**(ShapeObjBringInFrontOfText·CtrlSendBehindText): textWrap 만 바꾸고 zOrder 는 그대로.
//!   글자처럼 취급한 개체와 이미 그 배치인 개체에는 한/글이 실패(False)를 돌려준다.
//! - **개체 보호하기**(ShapeObjLock): lock="1" 을 쓰고 선택을 푼다. **모든 보호 개체 해제하기**(ShapeObjUnlockAll): 문서의 모든
//!   lock 을 0 으로(선택은 그대로). 도형·그림·표 모두 된다.
//! - **개체 모양 복사/붙이기**(ShapeObjectCopy/Paste, 파라미터셋 ShapeObjectCopyPaste: Line·Fill·Size·Shadow·PicEffect):
//!   선 = 색·굵기·종류·끝 모양(그림에 붙이면 화살표는 없앤다 — 그림 선에는 화살표가 없다), 채우기 = 채우기 통째(채우기 없는
//!   그림에서 복사하면 대상 채우기는 그대로), 크기 = 너비·높이(선·그림에도), 그림자 = 종류·색·오프셋(도형끼리).
//!   붙이기 플래그로 고른 것만 바꾼다.

use std::cell::RefCell;

use crate::document_core::helpers::{get_textbox_from_shape, json_escape, json_ok_with};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{CommonObjAttr, ShapeObject, TextWrap};

/// 개체 주소 — 구역·본문 문단·(칸/글상자 경로)·문단 안 컨트롤 차례.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObjAddr {
    pub sec: usize,
    pub ppi: usize,
    /// (controlIndex, cellIndex, cellParaIndex) — 마지막 항목의 cellParaIndex 가 개체가 든 칸 문단
    pub path: Vec<(usize, usize, usize)>,
    pub ci: usize,
}

impl ObjAddr {
    fn path_json(&self) -> String {
        let items: Vec<String> = self
            .path
            .iter()
            .map(|(c, k, p)| {
                format!(
                    "{{\"controlIndex\":{},\"cellIndex\":{},\"cellParaIndex\":{}}}",
                    c, k, p
                )
            })
            .collect();
        format!("[{}]", items.join(","))
    }
    fn json(&self) -> String {
        format!(
            "\"sec\":{},\"ppi\":{},\"ci\":{},\"path\":{}",
            self.sec,
            self.ppi,
            self.ci,
            self.path_json()
        )
    }
}

/// 개체(순서·보호 대상) 컨트롤의 공통 속성.
fn object_common(ctrl: &Control) -> Option<&CommonObjAttr> {
    match ctrl {
        Control::Shape(s) => Some(s.common()),
        Control::Picture(p) => Some(&p.common),
        Control::Table(t) => Some(&t.common),
        Control::Equation(e) => Some(&e.common),
        Control::Form(f) => Some(&f.common),
        _ => None,
    }
}

fn object_common_mut(ctrl: &mut Control) -> Option<&mut CommonObjAttr> {
    match ctrl {
        Control::Shape(s) => Some(s.common_mut()),
        Control::Picture(p) => Some(&mut p.common),
        Control::Table(t) => Some(&mut t.common),
        Control::Equation(e) => Some(&mut e.common),
        Control::Form(f) => Some(&mut f.common),
        _ => None,
    }
}

fn object_kind(ctrl: &Control) -> &'static str {
    match ctrl {
        Control::Shape(s) => match s.as_ref() {
            ShapeObject::Line(_) => "line",
            ShapeObject::Rectangle(_) => "rect",
            ShapeObject::Ellipse(_) => "ellipse",
            ShapeObject::Arc(_) => "arc",
            ShapeObject::Polygon(_) => "polygon",
            ShapeObject::Curve(_) => "curve",
            ShapeObject::Group(_) => "group",
            ShapeObject::Picture(_) => "picture",
            ShapeObject::Chart(_) => "chart",
            ShapeObject::Ole(_) => "ole",
        },
        Control::Picture(_) => "picture",
        Control::Table(_) => "table",
        Control::Equation(_) => "equation",
        Control::Form(_) => "form",
        _ => "",
    }
}

fn text_wrap_name(w: TextWrap) -> &'static str {
    match w {
        TextWrap::Square => "Square",
        TextWrap::Tight => "Tight",
        TextWrap::Through => "Through",
        TextWrap::TopAndBottom => "TopAndBottom",
        TextWrap::BehindText => "BehindText",
        TextWrap::InFrontOfText => "InFrontOfText",
    }
}

/// 문단 목록 안의 개체를 문서 차례로 모은다(표 칸·글상자 안까지).
fn collect_objects(
    paras: &[Paragraph],
    sec: usize,
    top: Option<usize>,
    path: &[(usize, usize, usize)],
    out: &mut Vec<(ObjAddr, i32)>,
) {
    for (pi, para) in paras.iter().enumerate() {
        let (ppi, base): (usize, Vec<(usize, usize, usize)>) = match top {
            None => (pi, Vec::new()),
            Some(t) => {
                let mut p = path.to_vec();
                if let Some(last) = p.last_mut() {
                    last.2 = pi;
                }
                (t, p)
            }
        };
        for (ci, ctrl) in para.controls.iter().enumerate() {
            if let Some(c) = object_common(ctrl) {
                out.push((
                    ObjAddr {
                        sec,
                        ppi,
                        path: base.clone(),
                        ci,
                    },
                    c.z_order,
                ));
            }
            match ctrl {
                Control::Table(t) => {
                    for (cell_idx, cell) in t.cells.iter().enumerate() {
                        let mut np = base.clone();
                        np.push((ci, cell_idx, 0));
                        collect_objects(&cell.paragraphs, sec, Some(ppi), &np, out);
                    }
                }
                Control::Shape(s) => {
                    if let Some(tb) = get_textbox_from_shape(s) {
                        let mut np = base.clone();
                        np.push((ci, 0, 0));
                        collect_objects(&tb.paragraphs, sec, Some(ppi), &np, out);
                    }
                }
                // 머리말·꼬리말 안 개체도 한/글은 같은 줄에 센다(REAL-police: 78개 중 2개). 경로는 셀 0 하나로 지난다.
                Control::Header(_) | Control::Footer(_) => {
                    if let Some(ps) = ctrl.header_footer_paragraphs() {
                        let mut np = base.clone();
                        np.push((ci, 0, 0));
                        collect_objects(ps, sec, Some(ppi), &np, out);
                    }
                }
                _ => {}
            }
        }
    }
}

/// 개체 모양 복사 보관함(한/글처럼 문서를 넘어 붙일 수 있다 — WASM 은 한 줄기).
#[derive(Debug, Clone, Default)]
struct FormatClip {
    kind: String,
    /// (색, 굵기, 속성 비트, 외곽선 종류, 투명도)
    line: Option<(u32, i32, u32, u8, u8)>,
    fill: Option<crate::model::style::Fill>,
    size: Option<(u32, u32)>,
    /// (종류, 색, x, y, 투명도)
    shadow: Option<(u32, u32, i32, i32, u8)>,
    /// 그림 효과: (밝기, 명암, 효과, 투명도, hp:effects)
    pic_effect: Option<(
        i8,
        i8,
        crate::model::image::ImageEffect,
        u8,
        crate::model::image::PictureEffects,
    )>,
}

thread_local! {
    static FORMAT_CLIP: RefCell<Option<FormatClip>> = const { RefCell::new(None) };
}

/// 그림 선에 없는 화살표 비트(시작·끝 모양·크기, bits 10-29)를 지운다.
const ARROW_BITS: u32 = 0x3FFF_FC00;

impl DocumentCore {
    /// 문서의 모든 개체(문서 차례).
    pub(crate) fn h2022_all_objects(&self) -> Vec<(ObjAddr, i32)> {
        let mut out = Vec::new();
        for (si, section) in self.document.sections.iter().enumerate() {
            collect_objects(&section.paragraphs, si, None, &[], &mut out);
        }
        out
    }

    fn h2022_object_paragraph(&self, a: &ObjAddr) -> Option<&Paragraph> {
        if a.path.is_empty() {
            self.document.sections.get(a.sec)?.paragraphs.get(a.ppi)
        } else {
            self.resolve_paragraph_by_path(a.sec, a.ppi, &a.path).ok()
        }
    }

    fn h2022_object_paragraph_mut(&mut self, a: &ObjAddr) -> Option<&mut Paragraph> {
        if a.path.is_empty() {
            self.document.sections.get_mut(a.sec)?.paragraphs.get_mut(a.ppi)
        } else {
            self.get_cell_paragraph_mut_by_path(a.sec, a.ppi, &a.path).ok()
        }
    }

    fn h2022_object_ctrl(&self, a: &ObjAddr) -> Option<&Control> {
        self.h2022_object_paragraph(a)?.controls.get(a.ci)
    }

    fn h2022_object_ctrl_mut(&mut self, a: &ObjAddr) -> Option<&mut Control> {
        let ci = a.ci;
        self.h2022_object_paragraph_mut(a)?.controls.get_mut(ci)
    }

    pub(crate) fn h2022_addr(
        sec: usize,
        ppi: usize,
        path_json: &str,
        ci: usize,
    ) -> Result<ObjAddr, HwpError> {
        let path = if path_json.trim().is_empty() {
            Vec::new()
        } else {
            Self::parse_cell_path(path_json)?
        };
        Ok(ObjAddr { sec, ppi, path, ci })
    }

    /// 손댄 구역의 원본 스트림을 버리고 다시 조판한다.
    fn h2022_touch_sections(&mut self, mut secs: Vec<usize>) {
        secs.sort_unstable();
        secs.dedup();
        for si in secs {
            if let Some(section) = self.document.sections.get_mut(si) {
                section.raw_stream = None;
            }
            self.recompose_section(si);
        }
        self.paginate_if_needed();
    }

    /// 개체 정보 — 종류·보호·순서·배치(편집기의 메뉴 켜기/끄기·보호 칸이 쓴다).
    pub(crate) fn h2022_object_info_native(&self, a: &ObjAddr) -> Result<String, HwpError> {
        let ctrl = self
            .h2022_object_ctrl(a)
            .ok_or_else(|| HwpError::RenderError("개체를 찾을 수 없습니다".to_string()))?;
        let c = object_common(ctrl)
            .ok_or_else(|| HwpError::RenderError("개체가 아닌 컨트롤입니다".to_string()))?;
        let all = self.h2022_all_objects();
        let mut order: Vec<usize> = (0..all.len()).collect();
        order.sort_by_key(|&i| (all[i].1, i));
        let rank = order.iter().position(|&i| all[i].0 == *a).unwrap_or(0);
        Ok(json_ok_with(&format!(
            "\"kind\":\"{}\",\"locked\":{},\"zOrder\":{},\"rank\":{},\"count\":{},\"textWrap\":\"{}\",\"treatAsChar\":{},\"width\":{},\"height\":{}",
            object_kind(ctrl),
            c.locked,
            c.z_order,
            rank,
            all.len(),
            text_wrap_name(c.text_wrap),
            c.treat_as_char,
            c.width,
            c.height
        )))
    }

    /// 개체가 보호(lock)됐는가 — 클릭 적중에서 빼는 데 쓴다(문서 전체를 훑지 않는 가벼운 조회).
    pub(crate) fn h2022_object_locked_native(&self, a: &ObjAddr) -> bool {
        self.h2022_object_ctrl(a)
            .and_then(object_common)
            .map(|c| c.locked)
            .unwrap_or(false)
    }

    /// 개체 순서 바꾸기(한/글 실측 규칙 — 머리 주석). operation: front | back | forward | backward.
    /// 응답 moves = zOrder 가 바뀐 모든 개체의 {sec,ppi,ci,path,before,after}(되돌리기가 그대로 대입한다).
    pub(crate) fn h2022_change_z_order_native(
        &mut self,
        target: &ObjAddr,
        operation: &str,
    ) -> Result<String, HwpError> {
        let all = self.h2022_all_objects();
        let mut order: Vec<usize> = (0..all.len()).collect();
        order.sort_by_key(|&i| (all[i].1, i));
        let pos = order
            .iter()
            .position(|&i| all[i].0 == *target)
            .ok_or_else(|| HwpError::RenderError("대상 개체를 찾을 수 없습니다".to_string()))?;
        let last = order.len() - 1;
        match operation {
            "front" => {
                let t = order.remove(pos);
                order.push(t);
            }
            "back" => {
                let t = order.remove(pos);
                order.insert(0, t);
            }
            "forward" => {
                if pos < last {
                    order.swap(pos, pos + 1);
                }
            }
            "backward" => {
                if pos > 0 {
                    order.swap(pos, pos - 1);
                }
            }
            _ => {
                return Err(HwpError::RenderError(format!(
                    "알 수 없는 operation: {}",
                    operation
                )))
            }
        }
        // 빈틈없이 다시 매긴다 — 바뀐 것만 moves 로.
        let mut moves: Vec<(ObjAddr, i32, i32)> = Vec::new();
        for (rank, &i) in order.iter().enumerate() {
            let after = rank as i32;
            if all[i].1 != after {
                moves.push((all[i].0.clone(), all[i].1, after));
            }
        }
        let mut secs = Vec::new();
        for (addr, _, after) in &moves {
            if let Some(c) = self.h2022_object_ctrl_mut(addr).and_then(object_common_mut) {
                c.z_order = *after;
                secs.push(addr.sec);
            }
        }
        let new_z = order.iter().position(|&i| all[i].0 == *target).unwrap_or(0) as i32;
        if !moves.is_empty() {
            self.h2022_touch_sections(secs);
        }
        let moves_json: Vec<String> = moves
            .iter()
            .map(|(a, b, af)| format!("{{{},\"before\":{},\"after\":{}}}", a.json(), b, af))
            .collect();
        Ok(json_ok_with(&format!(
            "\"zOrder\":{},\"moves\":[{}]",
            new_z,
            moves_json.join(",")
        )))
    }

    /// zOrder 절대 대입(되돌리기) — pairs: [{"sec"?,"ppi","ci","path"?,"z"}]. 하나라도 개체가 아니면 아무것도 바꾸지 않는다.
    pub(crate) fn h2022_apply_z_order_pairs_native(
        &mut self,
        default_sec: usize,
        pairs_json: &str,
    ) -> Result<String, HwpError> {
        let pairs: Vec<serde_json::Value> = serde_json::from_str(pairs_json)
            .map_err(|e| HwpError::RenderError(format!("pairs JSON 파싱 실패: {}", e)))?;
        let mut targets: Vec<(ObjAddr, i32)> = Vec::new();
        for pair in &pairs {
            let err = |what: &str| HwpError::RenderError(format!("pairs 항목 {} 누락", what));
            let sec = pair["sec"].as_u64().map(|v| v as usize).unwrap_or(default_sec);
            let ppi = pair["ppi"].as_u64().ok_or_else(|| err("ppi"))? as usize;
            let ci = pair["ci"].as_u64().ok_or_else(|| err("ci"))? as usize;
            let z = pair["z"].as_i64().ok_or_else(|| err("z"))? as i32;
            let path = match &pair["path"] {
                serde_json::Value::Array(items) => items
                    .iter()
                    .map(|e| {
                        (
                            e["controlIndex"].as_u64().unwrap_or(0) as usize,
                            e["cellIndex"].as_u64().unwrap_or(0) as usize,
                            e["cellParaIndex"].as_u64().unwrap_or(0) as usize,
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let addr = ObjAddr { sec, ppi, path, ci };
            match self.h2022_object_ctrl(&addr) {
                Some(ctrl) if object_common(ctrl).is_some() => {}
                _ => {
                    return Err(HwpError::RenderError(format!(
                        "지목 (sec={}, ppi={}, ci={}) 은 개체가 아니다 — 기록 이후 문서가 바뀌었다",
                        sec, ppi, ci
                    )))
                }
            }
            targets.push((addr, z));
        }
        let mut secs = Vec::new();
        for (addr, z) in &targets {
            if let Some(c) = self.h2022_object_ctrl_mut(addr).and_then(object_common_mut) {
                c.z_order = *z;
                secs.push(addr.sec);
            }
        }
        let applied = targets.len();
        if applied > 0 {
            self.h2022_touch_sections(secs);
        }
        Ok(json_ok_with(&format!("\"applied\":{}", applied)))
    }

    /// 개체 보호하기/풀기 — lock 속성(원본 비트 30 도 맞춘다: 기존 setControlLock 과 같은 자리).
    pub(crate) fn h2022_set_object_lock_native(
        &mut self,
        a: &ObjAddr,
        locked: bool,
    ) -> Result<String, HwpError> {
        let c = self
            .h2022_object_ctrl_mut(a)
            .and_then(object_common_mut)
            .ok_or_else(|| HwpError::RenderError("개체를 찾을 수 없습니다".to_string()))?;
        let before = c.locked;
        set_lock(c, locked);
        if let Some(Control::Picture(p)) = self.h2022_object_ctrl_mut(a) {
            p.lock = locked;
        }
        if before != locked {
            if let Some(section) = self.document.sections.get_mut(a.sec) {
                section.raw_stream = None;
            }
        }
        Ok(json_ok_with(&format!("\"before\":{},\"locked\":{}", before, locked)))
    }

    /// 모든 보호 개체 해제하기 — 풀린 개체 수(0 이면 한/글은 '보호된 개체가 없습니다.').
    pub(crate) fn h2022_unlock_all_objects_native(&mut self) -> Result<String, HwpError> {
        let all = self.h2022_all_objects();
        let mut count = 0usize;
        let mut secs = Vec::new();
        for (addr, _) in &all {
            let Some(ctrl) = self.h2022_object_ctrl_mut(addr) else {
                continue;
            };
            if let Control::Picture(p) = ctrl {
                p.lock = false;
            }
            if let Some(c) = object_common_mut(ctrl) {
                if c.locked {
                    set_lock(c, false);
                    count += 1;
                    secs.push(addr.sec);
                }
            }
        }
        secs.sort_unstable();
        secs.dedup();
        for si in secs {
            if let Some(section) = self.document.sections.get_mut(si) {
                section.raw_stream = None;
            }
        }
        Ok(json_ok_with(&format!("\"count\":{}", count)))
    }

    /// 글 앞으로 / 글 뒤로 — textWrap 만(zOrder 그대로). 글자처럼 취급한 개체·이미 그 배치면 changed=false(한/글은 실패).
    pub(crate) fn h2022_set_object_wrap_native(
        &mut self,
        a: &ObjAddr,
        wrap: &str,
    ) -> Result<String, HwpError> {
        let want = match wrap {
            "InFrontOfText" => TextWrap::InFrontOfText,
            "BehindText" => TextWrap::BehindText,
            _ => {
                return Err(HwpError::RenderError(format!(
                    "글 앞/뒤만 됩니다: {}",
                    wrap
                )))
            }
        };
        let c = self
            .h2022_object_ctrl_mut(a)
            .and_then(object_common_mut)
            .ok_or_else(|| HwpError::RenderError("개체를 찾을 수 없습니다".to_string()))?;
        let before = c.text_wrap;
        if c.treat_as_char || before == want {
            return Ok(json_ok_with(&format!(
                "\"changed\":false,\"before\":\"{}\"",
                text_wrap_name(before)
            )));
        }
        c.text_wrap = want;
        self.h2022_touch_sections(vec![a.sec]);
        Ok(json_ok_with(&format!(
            "\"changed\":true,\"before\":\"{}\"",
            text_wrap_name(before)
        )))
    }

    /// 그림 바꾸기(PictureChange) — 한/글 2022 COM 실측: 틀 크기(sz)·배치·효과·테두리는 그대로, 그림 자료만 바뀌고
    /// imgClip·imgDim 이 새 그림의 원래 크기(px × 75)로 바뀐다(자르기 풀림). 빠진 그림 자리 지정(assignPictureImage)과
    /// 같은 길에 imgDim 맞추기를 더했다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn h2022_change_picture_native(
        &mut self,
        a: &ObjAddr,
        image_data: &[u8],
        natural_width_px: u32,
        natural_height_px: u32,
        extension: &str,
    ) -> Result<String, HwpError> {
        let r = self.assign_picture_image_native(
            a.sec,
            a.ppi,
            &a.path,
            a.ci,
            image_data,
            natural_width_px,
            natural_height_px,
            extension,
        )?;
        if let Some(Control::Picture(p)) = self.h2022_object_ctrl_mut(a) {
            p.img_dim = (natural_width_px * 75, natural_height_px * 75);
        }
        Ok(r)
    }

    /// 개체 모양 복사 — 보관함에 넣고 무엇을 담았는지 돌려준다.
    pub(crate) fn h2022_copy_object_format_native(&mut self, a: &ObjAddr) -> Result<String, HwpError> {
        let ctrl = self
            .h2022_object_ctrl(a)
            .ok_or_else(|| HwpError::RenderError("개체를 찾을 수 없습니다".to_string()))?;
        let mut clip = FormatClip {
            kind: object_kind(ctrl).to_string(),
            ..Default::default()
        };
        if let Some(c) = object_common(ctrl) {
            clip.size = Some((c.width, c.height));
        }
        match ctrl {
            Control::Shape(s) => {
                if let Some(d) = s.drawing() {
                    let bl = &d.border_line;
                    clip.line = Some((bl.color, bl.width, bl.attr, bl.outline_style, 0));
                    clip.fill = Some(d.fill.clone());
                    clip.shadow = Some((
                        d.shadow_type,
                        d.shadow_color,
                        d.shadow_offset_x,
                        d.shadow_offset_y,
                        d.shadow_alpha,
                    ));
                }
            }
            Control::Picture(p) => {
                clip.line = Some((
                    p.border_color,
                    p.border_width,
                    p.border_attr.attr,
                    p.border_attr.outline_style,
                    p.border_opacity,
                ));
                clip.pic_effect = Some((
                    p.image_attr.brightness,
                    p.image_attr.contrast,
                    p.image_attr.effect,
                    p.image_attr.transparency,
                    p.effects.clone(),
                ));
            }
            _ => {}
        }
        let summary = format!(
            "\"kind\":\"{}\",\"line\":{},\"fill\":{},\"size\":{},\"shadow\":{},\"picEffect\":{}",
            json_escape(&clip.kind),
            clip.line.is_some(),
            clip.fill.is_some(),
            clip.size.is_some(),
            clip.shadow.is_some(),
            clip.pic_effect.is_some()
        );
        FORMAT_CLIP.with(|c| *c.borrow_mut() = Some(clip));
        Ok(json_ok_with(&summary))
    }

    /// 보관함에 개체 모양이 있는가.
    pub(crate) fn h2022_object_format_clip_native(&self) -> String {
        FORMAT_CLIP.with(|c| match c.borrow().as_ref() {
            Some(clip) => json_ok_with(&format!(
                "\"has\":true,\"kind\":\"{}\",\"line\":{},\"fill\":{},\"size\":{},\"shadow\":{},\"picEffect\":{}",
                json_escape(&clip.kind),
                clip.line.is_some(),
                clip.fill.is_some(),
                clip.size.is_some(),
                clip.shadow.is_some(),
                clip.pic_effect.is_some()
            )),
            None => json_ok_with("\"has\":false"),
        })
    }

    /// 개체 모양 붙이기 — flags: {"line","fill","size","shadow","picEffect"}(빠진 것은 false).
    pub(crate) fn h2022_paste_object_format_native(
        &mut self,
        a: &ObjAddr,
        flags_json: &str,
    ) -> Result<String, HwpError> {
        use crate::document_core::helpers::json_bool;
        let clip = FORMAT_CLIP
            .with(|c| c.borrow().clone())
            .ok_or_else(|| HwpError::RenderError("복사한 개체 모양이 없습니다".to_string()))?;
        let want = |k: &str| json_bool(flags_json, k) == Some(true);
        let mut applied: Vec<&str> = Vec::new();
        {
            let ctrl = self
                .h2022_object_ctrl_mut(a)
                .ok_or_else(|| HwpError::RenderError("개체를 찾을 수 없습니다".to_string()))?;
            match ctrl {
                Control::Shape(s) => {
                    let is_group = matches!(s.as_ref(), ShapeObject::Group(_));
                    if let Some(d) = s.drawing_mut().filter(|_| !is_group) {
                        if want("line") {
                            if let Some((color, width, attr, outline, _)) = clip.line {
                                d.border_line.color = color;
                                d.border_line.width = width;
                                d.border_line.attr = if clip.kind == "picture" {
                                    // 그림 선에는 화살표가 없다 — 대상 화살표는 그대로 둔다
                                    (attr & !ARROW_BITS) | (d.border_line.attr & ARROW_BITS)
                                } else {
                                    attr
                                };
                                d.border_line.outline_style = outline;
                                applied.push("line");
                            }
                        }
                        if want("fill") {
                            if let Some(fill) = clip.fill.clone() {
                                d.fill = fill;
                                applied.push("fill");
                            }
                        }
                        if want("shadow") {
                            if let Some((t, color, x, y, alpha)) = clip.shadow {
                                d.shadow_type = t;
                                d.shadow_color = color;
                                d.shadow_offset_x = x;
                                d.shadow_offset_y = y;
                                d.shadow_alpha = alpha;
                                applied.push("shadow");
                            }
                        }
                    }
                }
                Control::Picture(p) => {
                    if want("line") {
                        if let Some((color, width, attr, outline, alpha)) = clip.line {
                            p.border_color = color;
                            p.border_width = width;
                            p.border_attr.attr = attr & !ARROW_BITS;
                            p.border_attr.outline_style = outline;
                            p.border_opacity = alpha;
                            applied.push("line");
                        }
                    }
                    if want("picEffect") {
                        if let Some((b, ct, eff, tr, effects)) = clip.pic_effect.clone() {
                            p.image_attr.brightness = b;
                            p.image_attr.contrast = ct;
                            p.image_attr.effect = eff;
                            p.image_attr.transparency = tr;
                            p.effects = effects;
                            applied.push("picEffect");
                        }
                    }
                }
                _ => {}
            }
        }
        // 크기 — 도형·그림 속성 경로(꼭짓점·배율·캡션 폭을 함께 맞춘다)
        if want("size") {
            if let Some((w, h)) = clip.size {
                let kind = self.h2022_object_ctrl(a).map(object_kind).unwrap_or("");
                let props = format!("{{\"width\":{},\"height\":{}}}", w, h);
                let r = match (kind, a.path.is_empty()) {
                    ("picture", true) => self
                        .set_picture_properties_native(a.sec, a.ppi, a.ci, &props)
                        .map(|_| ()),
                    ("picture", false) => self
                        .set_cell_picture_properties_by_path_native(
                            a.sec,
                            a.ppi,
                            &ObjAddr::path_json(a),
                            a.ci,
                            &props,
                        )
                        .map(|_| ()),
                    ("table" | "equation" | "form" | "", _) => Ok(()),
                    (_, true) => self
                        .set_shape_properties_native(a.sec, a.ppi, a.ci, &props)
                        .map(|_| ()),
                    (_, false) => self
                        .set_cell_shape_properties_by_path_native(
                            a.sec,
                            a.ppi,
                            &ObjAddr::path_json(a),
                            a.ci,
                            &props,
                        )
                        .map(|_| ()),
                };
                if r.is_ok() && !matches!(kind, "table" | "equation" | "form" | "") {
                    applied.push("size");
                }
            }
        }
        if !applied.is_empty() {
            self.h2022_touch_sections(vec![a.sec]);
        }
        let list: Vec<String> = applied.iter().map(|s| format!("\"{}\"", s)).collect();
        Ok(json_ok_with(&format!("\"applied\":[{}]", list.join(","))))
    }
}

impl DocumentCore {
    /// 여러 개체 맞춤·간격 같게·크기 같게(한/글 ShapeObjAlign* — 2026-11-12).
    ///
    /// 근거: 한/글 도움말(Hwp.chm draw/array·drawing(select), 2018 — 2022 도구 상자 이름·명령과 같음):
    /// - **기준 개체 = 맨 마지막에 선택한 개체**(targets 의 마지막). 왼쪽/가운데/오른쪽 = 기준의 왼끝/가로 가운데/오른끝에,
    ///   위/중간/아래 = 기준의 위끝/세로 가운데/아래끝에 맞춘다(다른 축은 그대로).
    /// - 가로/세로 간격을 동일하게: 3개 이상, 기준 개체는 의미 없음. 가장 왼쪽(위쪽) 개체와 가장 오른쪽(아래쪽) 개체는 그대로,
    ///   나머지를 옮겨 이웃 간격을 같게.
    /// - 너비/높이/둘 다 같게(같은 크기로): 기준 개체의 너비·높이로.
    /// - 글자처럼 취급한 개체는 빼고, 같은 쪽 개체만. COM 으로 여러 개체를 고를 수 없어 한/글 결과 XML 로는 미실측.
    ///
    /// 자리는 그려진 상자(쪽 절대 좌표)로 셈하고, 개체 오프셋에 그 차이를 더한다. 정렬 기준(왼쪽·가운데·오른쪽 등)에 따라
    /// 오프셋의 방향이 다를 수 있어, 한 번 옮긴 뒤 다시 재서 비례로 바로잡는다.
    pub(crate) fn h2022_align_objects_native(
        &mut self,
        targets: &[ObjAddr],
        mode: &str,
    ) -> Result<String, HwpError> {
        // 본문 떠 있는 개체만(칸·글상자 안·글자처럼 취급 제외)
        struct Item {
            a: ObjAddr,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            page: Option<u32>,
            /// (기준, 정렬, 오프셋)
            hkey: (u8, u8, i32),
            vkey: (u8, u8, i32),
        }
        let mut items: Vec<Item> = Vec::new();
        let mut skipped = 0usize;
        for a in targets {
            let common = match self.h2022_object_ctrl(a).and_then(object_common) {
                Some(c) if a.path.is_empty() && !c.treat_as_char => c.clone(),
                _ => {
                    skipped += 1;
                    continue;
                }
            };
            let Some((x, y)) = self.rendered_object_origin_hu(a.sec, a.ppi, a.ci, &common) else {
                skipped += 1;
                continue;
            };
            let page = self
                .find_pages_for_paragraph(a.sec, a.ppi)
                .ok()
                .and_then(|p| p.into_iter().next());
            items.push(Item {
                a: a.clone(),
                x,
                y,
                w: common.width as i32,
                h: common.height as i32,
                page,
                hkey: (common.horz_rel_to as u8, common.horz_align as u8, common.horizontal_offset as i32),
                vkey: (common.vert_rel_to as u8, common.vert_align as u8, common.vertical_offset as i32),
            });
        }
        // 모두 같은 기준(종이·쪽·단·문단)에 왼쪽(위) 정렬이면 오프셋이 곧 자리다 — 그려진 상자(px)를 HWPUNIT 로 되돌릴 때의 1HU 반올림을 피해
        // 오프셋으로 셈한다. 기준이 섞이면 그려진 상자로 셈한다.
        let left = crate::model::shape::HorzAlign::Left as u8;
        let top = crate::model::shape::VertAlign::Top as u8;
        if items.iter().all(|i| i.hkey.0 == items[0].hkey.0 && i.hkey.1 == left) {
            for i in items.iter_mut() {
                i.x = i.hkey.2;
            }
        }
        if items.iter().all(|i| i.vkey.0 == items[0].vkey.0 && i.vkey.1 == top) {
            for i in items.iter_mut() {
                i.y = i.vkey.2;
            }
        }
        let spacing = matches!(mode, "hspace" | "vspace");
        if items.len() < if spacing { 3 } else { 2 } {
            return Ok(json_ok_with(&format!("\"moved\":0,\"skipped\":{}", skipped)));
        }
        if items.iter().any(|i| i.page != items[0].page) {
            return Err(HwpError::RenderError(
                "맞춤은 같은 쪽에 있는 개체끼리만 됩니다(한/글)".to_string(),
            ));
        }
        let r = items.len() - 1;
        let (rx, ry, rw, rh) = (items[r].x, items[r].y, items[r].w, items[r].h);
        let mut want: Vec<(usize, i32, i32)> = Vec::new(); // (항목, dx, dy)
        let mut sizes: Vec<(usize, Option<i32>, Option<i32>)> = Vec::new();
        match mode {
            "left" | "center" | "right" | "top" | "middle" | "bottom" => {
                for (i, it) in items.iter().enumerate().take(r) {
                    let (dx, dy) = match mode {
                        "left" => (rx - it.x, 0),
                        "center" => ((rx + rw / 2) - (it.x + it.w / 2), 0),
                        "right" => ((rx + rw) - (it.x + it.w), 0),
                        "top" => (0, ry - it.y),
                        "middle" => (0, (ry + rh / 2) - (it.y + it.h / 2)),
                        _ => (0, (ry + rh) - (it.y + it.h)),
                    };
                    want.push((i, dx, dy));
                }
            }
            "hspace" | "vspace" => {
                let horz = mode == "hspace";
                let mut order: Vec<usize> = (0..items.len()).collect();
                order.sort_by_key(|&i| if horz { items[i].x } else { items[i].y });
                let first = &items[order[0]];
                let last = &items[*order.last().unwrap()];
                let (start, end) = if horz {
                    (first.x + first.w, last.x)
                } else {
                    (first.y + first.h, last.y)
                };
                let inner: i32 = order[1..order.len() - 1]
                    .iter()
                    .map(|&i| if horz { items[i].w } else { items[i].h })
                    .sum();
                let gap = (end - start - inner) as f64 / (order.len() - 1) as f64;
                let mut cursor = start as f64 + gap;
                for &i in &order[1..order.len() - 1] {
                    let it = &items[i];
                    let target = cursor.round() as i32;
                    if horz {
                        want.push((i, target - it.x, 0));
                        cursor += it.w as f64 + gap;
                    } else {
                        want.push((i, 0, target - it.y));
                        cursor += it.h as f64 + gap;
                    }
                }
            }
            "width" | "height" | "size" => {
                for i in 0..r {
                    sizes.push((
                        i,
                        (mode != "height").then_some(rw),
                        (mode != "width").then_some(rh),
                    ));
                }
            }
            _ => {
                return Err(HwpError::RenderError(format!("알 수 없는 맞춤: {}", mode)));
            }
        }
        let mut moved = 0usize;
        for (i, w, h) in sizes {
            let a = items[i].a.clone();
            let kind = self.h2022_object_ctrl(&a).map(object_kind).unwrap_or("");
            let mut props = String::from("{");
            if let Some(w) = w {
                props.push_str(&format!("\"width\":{}", w));
            }
            if let Some(h) = h {
                if props.len() > 1 {
                    props.push(',');
                }
                props.push_str(&format!("\"height\":{}", h));
            }
            props.push('}');
            let r = match kind {
                "picture" => self.set_picture_properties_native(a.sec, a.ppi, a.ci, &props).map(|_| ()),
                "table" | "equation" | "form" | "" => continue,
                _ => self.set_shape_properties_native(a.sec, a.ppi, a.ci, &props).map(|_| ()),
            };
            if r.is_ok() {
                moved += 1;
            }
        }
        for (i, dx, dy) in want {
            if dx == 0 && dy == 0 {
                continue;
            }
            let a = items[i].a.clone();
            let before = {
                let c = self.h2022_object_ctrl(&a).and_then(object_common).cloned();
                c.and_then(|c| self.rendered_object_origin_hu(a.sec, a.ppi, a.ci, &c))
                    .unwrap_or((items[i].x, items[i].y))
            };
            let common0 = match self.h2022_object_ctrl(&a).and_then(object_common) {
                Some(c) => (c.horizontal_offset as i32, c.vertical_offset as i32),
                None => continue,
            };
            self.h2022_set_offset(&a, common0.0 + dx, common0.1 + dy);
            // 다시 재서 비례로 바로잡는다(가운데·오른쪽 정렬 기준의 오프셋 방향)
            let c = match self.h2022_object_ctrl(&a).and_then(object_common) {
                Some(c) => c.clone(),
                None => continue,
            };
            if let Some((nx, ny)) = self.rendered_object_origin_hu(a.sec, a.ppi, a.ci, &c) {
                let fix = |d: i32, got: i32, base: i32| -> i32 {
                    // 1~2HU 는 px 반올림 — 방향이 뒤집혔거나 크게 어긋날 때만 비례로 바로잡는다
                    if d == 0 || got == 0 || (got - d).abs() <= 2 + d.abs() / 100 {
                        base + d
                    } else {
                        base + ((d as f64) * (d as f64) / (got as f64)).round() as i32
                    }
                };
                let ox = fix(dx, nx - before.0, common0.0);
                let oy = fix(dy, ny - before.1, common0.1);
                if (ox, oy) != (common0.0 + dx, common0.1 + dy) {
                    self.h2022_set_offset(&a, ox, oy);
                }
            }
            moved += 1;
        }
        Ok(json_ok_with(&format!("\"moved\":{},\"skipped\":{}", moved, skipped)))
    }

    fn h2022_set_offset(&mut self, a: &ObjAddr, x: i32, y: i32) {
        if let Some(c) = self.h2022_object_ctrl_mut(a).and_then(object_common_mut) {
            c.horizontal_offset = x as u32;
            c.vertical_offset = y as u32;
        }
        self.h2022_touch_sections(vec![a.sec]);
    }
}

/// 효과 색 → "#RRGGBB"
fn effect_color_hex(c: &Option<crate::model::image::EffectColor>) -> String {
    let rgb = c.as_ref().and_then(|c| c.rgb.as_ref());
    let ch = |v: Option<&Option<String>>| {
        v.and_then(|v| v.as_deref())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0)
            .min(255)
    };
    format!(
        "#{:02X}{:02X}{:02X}",
        ch(rgb.map(|r| &r.r)),
        ch(rgb.map(|r| &r.g)),
        ch(rgb.map(|r| &r.b))
    )
}

fn effect_color_from_hex(hex: &str) -> crate::model::image::EffectColor {
    let h = hex.trim_start_matches('#');
    let v = |i: usize| {
        h.get(i..i + 2)
            .and_then(|s| u8::from_str_radix(s, 16).ok())
            .unwrap_or(0)
            .to_string()
    };
    crate::model::image::EffectColor {
        color_type: Some("RGB".to_string()),
        scheme_idx: Some("-1".to_string()),
        system_idx: Some("-1".to_string()),
        preset_idx: Some("-1".to_string()),
        rgb: Some(crate::model::image::EffectRgb {
            r: Some(v(0)),
            g: Some(v(2)),
            b: Some(v(4)),
        }),
    }
}

impl DocumentCore {
    /// 그림 효과 읽기 — {shadow, glow, softEdge, reflection}(없으면 null). 수치는 저장 값 그대로(HWPUNIT·도·투명도 0..1).
    pub(crate) fn h2022_picture_effects_native(&self, a: &ObjAddr) -> Result<String, HwpError> {
        let Some(Control::Picture(p)) = self.h2022_object_ctrl(a) else {
            return Err(HwpError::RenderError("그림이 아닙니다".to_string()));
        };
        let f = |v: &Option<String>| v.as_deref().unwrap_or("0").to_string();
        let e = &p.effects;
        let shadow = e.shadow.as_ref().map_or("null".to_string(), |s| {
            format!(
                "{{\"style\":\"{}\",\"alpha\":{},\"radius\":{},\"direction\":{},\"distance\":{},\"color\":\"{}\"}}",
                json_escape(s.style.as_deref().unwrap_or("OUTSIDE")),
                f(&s.alpha),
                f(&s.radius),
                f(&s.direction),
                f(&s.distance),
                effect_color_hex(&s.color)
            )
        });
        let glow = e.glow.as_ref().map_or("null".to_string(), |g| {
            format!(
                "{{\"alpha\":{},\"radius\":{},\"color\":\"{}\"}}",
                f(&g.alpha),
                f(&g.radius),
                effect_color_hex(&g.color)
            )
        });
        let soft = e
            .soft_edge
            .as_ref()
            .map_or("null".to_string(), |s| format!("{{\"radius\":{}}}", f(&s.radius)));
        let refl = e.reflection.as_ref().map_or("null".to_string(), |r| {
            let (a0, a1) = r.alpha.clone().unwrap_or((None, None));
            let (p0, p1) = r.pos.clone().unwrap_or((None, None));
            format!(
                "{{\"radius\":{},\"distance\":{},\"alphaStart\":{},\"alphaEnd\":{},\"posStart\":{},\"posEnd\":{}}}",
                f(&r.radius),
                f(&r.distance),
                f(&a0),
                f(&a1),
                f(&p0),
                f(&p1)
            )
        });
        Ok(json_ok_with(&format!(
            "\"shadow\":{},\"glow\":{},\"softEdge\":{},\"reflection\":{}",
            shadow, glow, soft, refl
        )))
    }

    /// 그림 효과 바꾸기 — 주어진 키만(null = 그 효과 없앰). 한/글 저장 꼴(문자열 수치, effectsColor RGB)로 쓴다.
    pub(crate) fn h2022_set_picture_effects_native(
        &mut self,
        a: &ObjAddr,
        json: &str,
    ) -> Result<String, HwpError> {
        let v: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| HwpError::RenderError(format!("effects JSON: {}", e)))?;
        let num = |o: &serde_json::Value, k: &str, d: f64| -> Option<String> {
            let x = o.get(k).and_then(|x| x.as_f64()).unwrap_or(d);
            Some(if x.fract() == 0.0 { format!("{}", x as i64) } else { format!("{}", x) })
        };
        let Some(Control::Picture(p)) = self.h2022_object_ctrl_mut(a) else {
            return Err(HwpError::RenderError("그림이 아닙니다".to_string()));
        };
        if let Some(s) = v.get("shadow") {
            p.effects.shadow = if s.is_null() {
                None
            } else {
                Some(crate::model::image::PictureShadow {
                    style: Some(s.get("style").and_then(|x| x.as_str()).unwrap_or("OUTSIDE").to_string()),
                    alpha: num(s, "alpha", 0.5),
                    radius: num(s, "radius", 0.0),
                    direction: num(s, "direction", 45.0),
                    distance: num(s, "distance", 1000.0),
                    align_style: Some("TOP_LEFT".to_string()),
                    rotation_style: Some("0".to_string()),
                    skew: Some(crate::model::image::EffectPoint { x: Some("0".into()), y: Some("0".into()) }),
                    scale: Some(crate::model::image::EffectPoint { x: Some("1".into()), y: Some("1".into()) }),
                    color: Some(effect_color_from_hex(s.get("color").and_then(|x| x.as_str()).unwrap_or("#000000"))),
                })
            };
        }
        if let Some(g) = v.get("glow") {
            p.effects.glow = if g.is_null() {
                None
            } else {
                Some(crate::model::image::PictureGlow {
                    alpha: num(g, "alpha", 0.5),
                    radius: num(g, "radius", 1000.0),
                    color: Some(effect_color_from_hex(g.get("color").and_then(|x| x.as_str()).unwrap_or("#FF0000"))),
                })
            };
        }
        if let Some(s) = v.get("softEdge") {
            p.effects.soft_edge = if s.is_null() {
                None
            } else {
                Some(crate::model::image::PictureSoftEdge { radius: num(s, "radius", 500.0) })
            };
        }
        if let Some(r) = v.get("reflection") {
            p.effects.reflection = if r.is_null() {
                None
            } else {
                Some(crate::model::image::PictureReflection {
                    align_style: Some("BOTTOM_LEFT".to_string()),
                    radius: num(r, "radius", 0.0),
                    direction: Some("90".to_string()),
                    distance: num(r, "distance", 0.0),
                    rotation_style: Some("0".to_string()),
                    fade_direction: Some("90".to_string()),
                    skew: Some(crate::model::image::EffectPoint { x: Some("0".into()), y: Some("0".into()) }),
                    scale: Some(crate::model::image::EffectPoint { x: Some("1".into()), y: Some("-1".into()) }),
                    alpha: Some((num(r, "alphaStart", 0.5), num(r, "alphaEnd", 1.0))),
                    pos: Some((num(r, "posStart", 0.0), num(r, "posEnd", 0.9))),
                })
            };
        }
        self.h2022_touch_sections(vec![a.sec]);
        Ok(json_ok_with("\"changed\":true"))
    }
}

fn set_lock(c: &mut CommonObjAttr, locked: bool) {
    c.locked = locked;
    if locked {
        c.attr |= 1 << 30;
    } else {
        c.attr &= !(1u32 << 30);
    }
}
