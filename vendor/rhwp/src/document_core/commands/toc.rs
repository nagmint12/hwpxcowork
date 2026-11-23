//! [hwpx-cowork] 차례 만들기·새로 고침 — 한/글 '도구 > 차례/색인'.
//!
//! 한/글 2022 실측(2026-10-29, COM + 차례 만들기 대화상자 UI 자동화, 시험지 `scripts/toc-probe` 계열)으로 정한 꼴:
//! - 차례는 캐럿 문단 **뒤**에 문단들로 들어간다. 필드로 넣기는 캐럿 문단이 빈 문단이면 그 문단 자리에 들어간다(문자열로 넣기는 빈 문단도 남긴다).
//! - 첫 문단 = '차례 제목' 스타일(없으면 바탕글) — 필드로 넣기면 `TABLEOFCONTENTS` 필드 시작, 제목 차례를 만들면 글 `<제목 차례>`.
//!   이어서 목록마다 [머리 `<표 차례>`…(제목 차례는 첫 문단이 머리)] [항목들] [빈 문단]. 마지막 빈 문단에 필드 끝.
//!   문자열로 넣기는 필드가 없고, 제목 차례를 만들지 않으면 첫 문단이 바탕글 빈 문단, 마지막 빈 문단은 탭 없는 바탕글 문단 모양.
//! - 항목 = '차례 N' 스타일(N = 개요 수준+1, 스타일·차례 코드로 모은 항목은 1; 스타일이 없으면 바탕글) + 오른쪽 탭 + 쪽 번호.
//!   개요 문단은 번호까지(`1. 서론`), 캡션은 자동 번호를 번호로(`표 1 표 캡션`). 쪽 번호는 보이는 쪽 번호(새 번호로 시작 반영)이고
//!   차례를 넣은 **뒤**의 쪽으로 센다.
//! - 탭: 차례의 모든 문단이 같은 탭 정의를 쓴다 — 첫 문단 스타일 탭 정의의 왼쪽 끝 자동 탭 + (오른쪽 탭: 단 너비 자리 오른쪽 탭,
//!   채울 모양 ContentsLeader / 문단 오른쪽 끝 자동 탭: 오른쪽 끝 자동 탭만). 문단 모양 = 스타일 문단 모양 + 그 탭 정의.
//! - 하이퍼링크: 항목 전체를 `HYPERLINK` 필드로 감싸고 글자는 파란 밑줄 — 개요 문단으로 모은 제목과 표·그림·수식만(차례 코드·스타일로 모은 제목은 링크 없음). Command `?#<대상 id>;0;<1 개요·2 표·3 그림·4 수식>;0;` —
//!   대상 id 는 개요 문단의 `<hp:p id>` 또는 개체 id. 고유 id 가 없는 문단(0·2147483648·겹침)은 새 id 를 준다(한/글도 그렇게 한다).
//! - 차례 필드 Command: `TableOfContents:set:<길이>:ContentsMake:uint:<비트> ContentsStyles:wstring:<길이>:<스타일;…> ContentsLevel:int:<0부터>
//!   ContentsAutoTabRight:int:<0|1> ContentsLeader:int:<채움> ContentsHyperlink:bool:<0|1>  ` — 비트: 1 제목 차례·2 표·4 그림·8 수식·
//!   16 개요 문단·32 스타일·64 차례 코드(제목 차례를 끄면 16·32·64 도 0).
//! - 제목 차례 표시(`<hp:titleMark ignore="1"/>` = HWP5 `Mtit`)·차례 숨김(`ignore="0"` = `Mign`): 숨김 문단은 어느 방식으로도 모으지 않는다.
//! - 새로 고침(한/글 `UpdateAllContents`)은 필드의 Command 로 같은 차례를 다시 만든다 — 차례 안에서 고친 글은 사라진다.

use std::collections::{HashMap, HashSet};

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{Control, FieldType};
use crate::model::paragraph::{OrphanFieldEnd, Paragraph, TitleMark};
use crate::model::shape::ObjectNumberingType;
use crate::model::style::{CharShapeMods, HeadType, ParaShapeMods, TabDef, TabItem, UnderlineType};
use crate::renderer::pagination::PageItem;

/// 한/글 2022 가 차례 필드에 쓰는 `fieldid`(문서와 무관한 고정값 — 두 문서에서 같았다)
const TOC_FIELD_INSTANCE: u32 = 628_387_683;
/// 한/글 2022 가 차례 하이퍼링크에 쓰는 `fieldid`
const LINK_FIELD_INSTANCE: u32 = 627_600_491;
const GENERIC_PARA_ID: u32 = 0x8000_0000;

/// 차례 만들기 선택 사항 — 한/글 '차례 만들기' 대화상자와 같은 항목
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TocOptions {
    /// 차례 형식: 필드로 넣기(true) / 문자열로 넣기(false)
    pub field: bool,
    /// 제목 차례
    pub title: bool,
    /// 개요 문단으로 모으기
    pub outline: bool,
    /// 개요 수준(0 = 1 수준까지 … 기본 2 = 3 수준까지)
    pub level: u8,
    /// 스타일로 모으기
    pub use_styles: bool,
    /// 모을 스타일 이름
    pub styles: Vec<String>,
    /// 차례 코드(제목 차례 표시)로 모으기
    pub code: bool,
    /// 표 차례
    pub table: bool,
    /// 그림 차례
    pub picture: bool,
    /// 수식 차례
    pub equation: bool,
    /// 탭 모양: 문단 오른쪽 끝 자동 탭(true) / 오른쪽 탭(false)
    pub auto_tab: bool,
    /// 채울 모양(HWP 탭 채움 — 3 점선)
    pub leader: u8,
    /// 하이퍼링크 만들기
    pub hyperlink: bool,
}

impl Default for TocOptions {
    fn default() -> Self {
        Self {
            field: true,
            title: true,
            outline: true,
            level: 2,
            use_styles: false,
            styles: Vec::new(),
            code: false,
            table: true,
            picture: true,
            equation: true,
            auto_tab: false,
            leader: 3,
            hyperlink: true,
        }
    }
}

impl TocOptions {
    fn title_by_style(&self) -> bool {
        self.title && self.use_styles && !self.styles.is_empty()
    }

    /// ContentsMake 비트
    pub fn make_bits(&self) -> u32 {
        let mut m = 0;
        if self.title {
            m |= 1;
            if self.outline {
                m |= 16;
            }
            if self.use_styles {
                m |= 32;
            }
            if self.code {
                m |= 64;
            }
        }
        if self.table {
            m |= 2;
        }
        if self.picture {
            m |= 4;
        }
        if self.equation {
            m |= 8;
        }
        m
    }

    /// 차례 필드 Command(한/글 형식)
    pub fn command(&self) -> String {
        let styles: String = if self.title && self.use_styles {
            self.styles.iter().map(|s| format!("{};", s)).collect()
        } else {
            String::new()
        };
        let inner = format!(
            "ContentsMake:uint:{} ContentsStyles:wstring:{}:{} ContentsLevel:int:{} ContentsAutoTabRight:int:{} ContentsLeader:int:{} ContentsHyperlink:bool:{}  ",
            self.make_bits(),
            styles.encode_utf16().count(),
            styles,
            self.level,
            u8::from(self.auto_tab),
            self.leader,
            u8::from(self.hyperlink),
        );
        let set_len = inner.encode_utf16().count().saturating_sub(1);
        format!("TableOfContents:set:{}:{}", set_len, inner)
    }

    /// 차례 필드 Command → 선택 사항(필드로 넣기). 알아보지 못하면 None
    pub fn from_command(cmd: &str) -> Option<Self> {
        if !cmd.contains("TableOfContents") {
            return None;
        }
        let num = |key: &str| -> Option<u32> {
            let at = cmd.find(key)? + key.len();
            let digits: String = cmd[at..].chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        };
        let make = num("ContentsMake:uint:")?;
        let mut styles = Vec::new();
        if let Some(at) = cmd.find("ContentsStyles:wstring:") {
            let rest = &cmd[at + "ContentsStyles:wstring:".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let n: usize = digits.parse().unwrap_or(0);
            let body = &rest[digits.len()..];
            let body = body.strip_prefix(':').unwrap_or(body);
            // 길이는 UTF-16 단위
            let mut units = 0usize;
            let mut end = 0usize;
            for (i, ch) in body.char_indices() {
                if units >= n {
                    break;
                }
                units += ch.len_utf16();
                end = i + ch.len_utf8();
            }
            styles = body[..end]
                .split(';')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
        }
        Some(Self {
            field: true,
            title: make & 1 != 0,
            outline: make & 16 != 0,
            use_styles: make & 32 != 0,
            code: make & 64 != 0,
            table: make & 2 != 0,
            picture: make & 4 != 0,
            equation: make & 8 != 0,
            level: num("ContentsLevel:int:").unwrap_or(2).min(9) as u8,
            styles,
            auto_tab: num("ContentsAutoTabRight:int:").unwrap_or(0) != 0,
            leader: num("ContentsLeader:int:").unwrap_or(3).min(11) as u8,
            hyperlink: num("ContentsHyperlink:bool:").unwrap_or(1) != 0,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TocKind {
    Title,
    Table,
    Picture,
    Equation,
}

impl TocKind {
    fn link_code(self) -> u8 {
        match self {
            TocKind::Title => 1,
            TocKind::Table => 2,
            TocKind::Picture => 3,
            TocKind::Equation => 4,
        }
    }
    fn link_target(self) -> &'static str {
        match self {
            TocKind::Title => "HWPHYPERLINK_TARGET_OUTLINE",
            TocKind::Table => "HWPHYPERLINK_TARGET_TABLE",
            TocKind::Picture => "HWPHYPERLINK_TARGET_FIGURE",
            TocKind::Equation => "HWPHYPERLINK_TARGET_EQUATION",
        }
    }
    fn heading(self) -> &'static str {
        match self {
            TocKind::Title => "<제목 차례>",
            TocKind::Table => "<표 차례>",
            TocKind::Picture => "<그림 차례>",
            TocKind::Equation => "<수식 차례>",
        }
    }
}

/// 개체(표·그림·수식) 자리 — 본문 문단의 컨트롤, 표 칸 안이면 그 경로
#[derive(Debug, Clone, PartialEq)]
struct ObjRef {
    ctrl: usize,
    /// 표 칸 안 개체: (표 컨트롤, 칸, 칸 문단) 경로
    path: Vec<(usize, usize, usize)>,
}

#[derive(Debug, Clone)]
struct TocEntry {
    kind: TocKind,
    level: u8,
    text: String,
    sec: usize,
    para: usize,
    obj: Option<ObjRef>,
    page: u32,
    target: u32,
    /// 하이퍼링크를 달 항목인가 — 한/글은 개요 문단으로 모은 제목과 표·그림·수식만 링크한다(차례 코드·스타일로 모은 제목은 링크 없음 —
    /// 2026-10-29 한/글 UpdateAllContents 실측: 같은 문단이 개요이면서 제목 차례 표시면 코드 쪽이 이겨 수준 1·링크 없음)
    link: bool,
}

/// 차례 자리(구역, 첫 문단, 마지막 문단)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TocRegion {
    pub sec: usize,
    pub start: usize,
    pub end: usize,
}

/// 차례 문단이 쓸 스타일·모양 번호
struct TocShapes {
    head: (u8, u16, u32),
    /// 수준별(0부터) (스타일, 문단 모양, 글자 모양, 링크 글자 모양)
    levels: Vec<(u8, u16, u32, u32)>,
    blank: (u8, u16, u32),
    plain: (u8, u16, u32),
    tab_pos: u32,
}

fn xml_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// 차례 항목 글 — 줄바꿈·탭은 빈칸으로, 제어 문자는 뺀다. 빈칸은 그대로 둔다(한/글은 캡션 '표 1 ' 의 끝 빈칸도 싣는다 — 실측)
fn clean_text(s: &str) -> String {
    s.chars()
        .map(|ch| if ch == '\t' || ch == '\n' || ch == '\r' { ' ' } else { ch })
        .filter(|c| (*c as u32) >= 0x20 && *c != '\u{fffc}')
        .collect()
}

/// 문단이 가진 구역·단 정의(구역 나누기 문단이면 SectionDef, ColumnDef) 복사본 — 컨트롤 차례대로
fn section_defs_of(p: &Paragraph) -> Vec<Control> {
    p.controls.iter().filter(|c| matches!(c, Control::SectionDef(_) | Control::ColumnDef(_))).cloned().collect()
}

/// 문단을 구역 나누기 문단으로 — 구역·단 정의를 맨 앞 컨트롤로 넣고(8유닛 칸째) 나누기 종류를 구역으로(파서와 같은 꼴: 0x01 구역 + 0x02 단 정의)
fn mark_section_start(p: &mut Paragraph, defs: Vec<Control>) {
    use crate::model::paragraph::ColumnBreakType;
    let has_col = defs.iter().any(|c| matches!(c, Control::ColumnDef(_)));
    p.insert_leading_extended_controls(defs);
    p.raw_break_type |= 0x01 | if has_col { 0x02 } else { 0 };
    if matches!(p.column_type, ColumnBreakType::None | ColumnBreakType::MultiColumn) {
        p.column_type = ColumnBreakType::Section;
    }
}

pub(crate) fn para_instance_id(p: &Paragraph) -> u32 {
    crate::serializer::hwpx::context::stored_para_instance_id(p)
}

fn set_para_instance_id(p: &mut Paragraph, id: u32) {
    if p.raw_header_extra.len() < 10 {
        p.raw_header_extra.resize(10, 0);
    }
    p.raw_header_extra[6..10].copy_from_slice(&id.to_le_bytes());
}

fn caption_of(ctrl: &Control) -> Option<(&crate::model::shape::Caption, ObjectNumberingType, u32)> {
    match ctrl {
        Control::Table(t) => t.caption.as_ref().map(|c| (c, t.common.numbering_type, t.common.instance_id)),
        Control::Picture(p) => p.caption.as_ref().map(|c| (c, p.common.numbering_type, p.common.instance_id)),
        Control::Equation(e) => e.caption.as_ref().map(|c| (c, ObjectNumberingType::Equation, e.common.instance_id)),
        Control::Shape(s) => crate::document_core::helpers::get_caption_from_shape(s)
            .map(|c| (c, s.common().numbering_type, s.common().instance_id)),
        _ => None,
    }
}

fn caption_text(cap: &crate::model::shape::Caption) -> String {
    let parts: Vec<String> = cap
        .paragraphs
        .iter()
        .map(|p| clean_text(&super::code_controls::text_with_auto_numbers(p)))
        .filter(|s| !s.trim().is_empty())
        .collect();
    parts.join(" ")
}

impl DocumentCore {
    /// 차례 필드(TABLEOFCONTENTS)가 시작하는 본문 문단 → (컨트롤 번호, 필드 id, 선택 사항)
    fn toc_field_in(p: &Paragraph) -> Option<(usize, u32, Option<TocOptions>)> {
        p.controls.iter().enumerate().find_map(|(i, c)| match c {
            Control::Field(f) if f.field_type == FieldType::TableOfContents => {
                Some((i, f.field_id, TocOptions::from_command(&f.command)))
            }
            _ => None,
        })
    }

    /// 문서의 차례 필드 자리 목록
    pub(crate) fn toc_regions(&self) -> Vec<(TocRegion, u32, Option<TocOptions>)> {
        let mut out = Vec::new();
        for (s, sec) in self.document.sections.iter().enumerate() {
            let paras = &sec.paragraphs;
            let mut i = 0;
            while i < paras.len() {
                if let Some((_, fid, opts)) = Self::toc_field_in(&paras[i]) {
                    // 같은 문단 안에서 닫히면(field_ranges) 그 문단 하나
                    let closes_here = paras[i].field_ranges.iter().any(|r| {
                        matches!(paras[i].controls.get(r.control_idx), Some(Control::Field(f)) if f.field_id == fid)
                    });
                    let mut end = i;
                    if !closes_here {
                        if let Some(j) = (i + 1..paras.len()).find(|&j| {
                            paras[j].orphan_field_ends.iter().any(|o| o.begin_id_ref == fid || o.begin_id_ref == 0)
                        }) {
                            end = j;
                        }
                    }
                    out.push((TocRegion { sec: s, start: i, end }, fid, opts));
                    i = end + 1;
                    continue;
                }
                i += 1;
            }
        }
        out
    }

    /// 본문 필드 시작 id → 차례 필드인가(모든 구역)
    fn body_field_begins(&self) -> HashMap<u32, bool> {
        let mut out = HashMap::new();
        for s in &self.document.sections {
            for p in &s.paragraphs {
                for c in &p.controls {
                    if let Control::Field(f) = c {
                        out.insert(f.field_id, f.field_type == FieldType::TableOfContents);
                    }
                }
            }
        }
        out
    }

    /// 구역 sec 의 문단 a..=b 에 표지(필드 시작·다단락 필드 끝)가 있는 차례 필드 id — 선택 지우기·문단 합치기 **전에** 모아
    /// [`Self::settle_toc_markers`] 에 넘긴다. 필드 끝은 시작이 차례이거나 문서에 시작이 없는 것.
    pub(crate) fn toc_marker_ids(&self, sec: usize, a: usize, b: usize) -> Vec<u32> {
        let Some(s) = self.document.sections.get(sec) else { return Vec::new() };
        let mut out = Vec::new();
        let begins = self.body_field_begins();
        for p in s.paragraphs.iter().take(b.saturating_add(1)).skip(a) {
            for c in &p.controls {
                if let Control::Field(f) = c {
                    if f.field_type == FieldType::TableOfContents && !out.contains(&f.field_id) {
                        out.push(f.field_id);
                    }
                }
            }
            for o in &p.orphan_field_ends {
                if o.begin_id_ref != 0 && begins.get(&o.begin_id_ref).copied().unwrap_or(true) && !out.contains(&o.begin_id_ref) {
                    out.push(o.begin_id_ref);
                }
            }
        }
        out
    }

    /// 선택 지우기·문단 합치기 **뒤** 차례 필드 표지 정리(ids = [`Self::toc_marker_ids`]) — 지운 자리가 모인 문단 (sec, para) 만 고친다
    /// (선택 지우기의 되돌리기 조각이 이 문단 하나를 원래 문단들로 바꿔 끼우므로 되돌리기가 그대로 맞는다).
    ///  - 시작·끝이 모두 이 문단에 있고 사이에 글이 없으면(차례 줄을 다 지움) 둘 다 뺀다 — 차례가 없어진다
    ///  - 끝이 사라졌으면: 시작이 이 문단이면 시작을 빼고, 앞 문단이면 지운 자리(caret)에 끝을 둔다(차례가 거기까지 줄어든다)
    ///  - 시작이 사라졌으면 이 문단의 끝을 뺀다(다른 문단의 짝 없는 끝은 저장할 때 내지 않는다 — 한/글도 버린다)
    /// 고쳤으면 그 문단을 다시 조판하고 true.
    pub(crate) fn settle_toc_markers(&mut self, sec: usize, para: usize, caret: usize, ids: &[u32]) -> bool {
        if sec >= self.document.sections.len() || para >= self.document.sections[sec].paragraphs.len() {
            return false;
        }
        let mut changed = false;
        for &id in ids {
            let mut begins: Vec<(usize, usize, usize)> = Vec::new();
            let mut ends: Vec<(usize, usize, usize)> = Vec::new();
            let mut closed_in_para = false;
            let mut instance = TOC_FIELD_INSTANCE;
            for (si, s) in self.document.sections.iter().enumerate() {
                for (pi, p) in s.paragraphs.iter().enumerate() {
                    for (ci, c) in p.controls.iter().enumerate() {
                        if let Control::Field(f) = c {
                            if f.field_id == id {
                                if p.field_ranges.iter().any(|r| r.control_idx == ci) {
                                    closed_in_para = true;
                                } else {
                                    begins.push((si, pi, ci));
                                    instance = f.instance_id.unwrap_or(TOC_FIELD_INSTANCE);
                                }
                            }
                        }
                    }
                    for (k, o) in p.orphan_field_ends.iter().enumerate() {
                        if o.begin_id_ref == id {
                            ends.push((si, pi, k));
                        }
                    }
                }
            }
            if closed_in_para {
                continue;
            }
            let here = |x: &(usize, usize, usize)| x.0 == sec && x.1 == para;
            let p = &mut self.document.sections[sec].paragraphs[para];
            match (begins.is_empty(), ends.is_empty()) {
                (false, false) => {
                    if begins.len() == 1 && ends.len() == 1 && here(&begins[0]) && here(&ends[0]) {
                        let len = p.text.chars().count();
                        let bpos = p.control_text_positions().get(begins[0].2).copied().unwrap_or(0).min(len);
                        if p.orphan_field_ends[ends[0].2].char_idx.min(len) <= bpos {
                            p.remove_orphan_field_end(ends[0].2);
                            p.remove_unclosed_field_begin(begins[0].2);
                            changed = true;
                        }
                    }
                }
                (false, true) => {
                    let mut mine: Vec<usize> = begins.iter().filter(|b| here(b)).map(|b| b.2).collect();
                    if !mine.is_empty() {
                        mine.sort_unstable_by(|a, b| b.cmp(a));
                        for ci in mine {
                            p.remove_unclosed_field_begin(ci);
                        }
                        changed = true;
                    } else if begins.iter().any(|b| (b.0, b.1) < (sec, para)) {
                        p.add_orphan_field_end(
                            caret,
                            // [hwpx-cowork] A TOC closing marker is not a memo.
                            OrphanFieldEnd { char_idx: caret, begin_id_ref: id, field_id: instance, begin_ctrl_id: 0, memo_index: 0 },
                        );
                        changed = true;
                    }
                }
                (true, false) => {
                    let mut mine: Vec<usize> = ends.iter().filter(|e| here(e)).map(|e| e.2).collect();
                    mine.sort_unstable_by(|a, b| b.cmp(a));
                    for k in &mine {
                        p.remove_orphan_field_end(*k);
                    }
                    changed |= !mine.is_empty();
                }
                (true, true) => {}
            }
        }
        if changed {
            self.document.sections[sec].raw_stream = None;
            self.relayout_toc_section(sec, TocRegion { sec, start: para, end: para });
        }
        changed
    }

    /// (구역, 문단)이 든 차례
    pub(crate) fn toc_region_at(&self, sec: usize, para: usize) -> Option<(TocRegion, u32, Option<TocOptions>)> {
        self.toc_regions()
            .into_iter()
            .find(|(r, _, _)| r.sec == sec && r.start <= para && para <= r.end)
    }

    /// (구역, 문단) → 보이는 쪽 번호, (구역, 문단, 컨트롤) → 보이는 쪽 번호
    fn toc_page_maps(&self) -> (HashMap<(usize, usize), u32>, HashMap<(usize, usize, usize), u32>) {
        let mut paras = HashMap::new();
        let mut ctrls = HashMap::new();
        for (s, pr) in self.pagination.iter().enumerate() {
            for page in &pr.pages {
                let n = page.page_number.max(1);
                for col in &page.column_contents {
                    for item in &col.items {
                        match item {
                            PageItem::FullParagraph { para_index } | PageItem::PartialParagraph { para_index, .. } => {
                                paras.entry((s, *para_index)).or_insert(n);
                            }
                            PageItem::Table { para_index, control_index }
                            | PageItem::PartialTable { para_index, control_index, .. }
                            | PageItem::Shape { para_index, control_index } => {
                                paras.entry((s, *para_index)).or_insert(n);
                                ctrls.entry((s, *para_index, *control_index)).or_insert(n);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        (paras, ctrls)
    }

    /// 차례 항목 모으기(skip = 지금 차례 자리 — 그 안은 모으지 않는다). 쪽 번호는 지금 쪽 나눔으로
    fn collect_toc_entries(&self, opts: &TocOptions, skip: Option<TocRegion>) -> Vec<TocEntry> {
        let (page_of_para, page_of_ctrl) = self.toc_page_maps();
        let style_ids: HashSet<u8> = if opts.title_by_style() {
            self.document
                .doc_info
                .styles
                .iter()
                .enumerate()
                .filter(|(_, st)| opts.styles.iter().any(|n| *n == st.local_name))
                .map(|(i, _)| i as u8)
                .collect()
        } else {
            HashSet::new()
        };
        let mut titles = Vec::new();
        let mut tables = Vec::new();
        let mut pictures = Vec::new();
        let mut equations = Vec::new();
        for (s, sec) in self.document.sections.iter().enumerate() {
            for (p, para) in sec.paragraphs.iter().enumerate() {
                if skip.is_some_and(|r| r.sec == s && r.start <= p && p <= r.end) {
                    continue;
                }
                // 차례 필드 안의 다른 차례(한/글이 만든 둘째 차례 등)도 건너뛴다
                if Self::toc_field_in(para).is_some() {
                    continue;
                }
                let page = page_of_para.get(&(s, p)).copied().unwrap_or(1);
                if opts.title {
                    let mark = para.title_marks.iter().any(|m: &TitleMark| m.ignore);
                    let hidden = para.title_marks.iter().any(|m: &TitleMark| !m.ignore);
                    if !hidden {
                        let ps = self.document.doc_info.para_shapes.get(para.para_shape_id as usize);
                        let is_outline = ps.is_some_and(|ps| ps.head_type == HeadType::Outline);
                        let outline_level = ps.map(|ps| ps.para_level).unwrap_or(0);
                        let by_code = opts.code && mark;
                        let by_style = !style_ids.is_empty() && style_ids.contains(&para.style_id);
                        let by_outline = opts.outline && is_outline && outline_level <= opts.level;
                        if by_code || by_style || by_outline {
                            let body = clean_text(&para.text);
                            let head = match (&para.numbering_marker, ps.map(|ps| ps.head_type)) {
                                (crate::model::paragraph::NumberingMarker::Text(t, _), Some(HeadType::Outline | HeadType::Number)) => {
                                    clean_text(t)
                                }
                                _ => String::new(),
                            };
                            let text = match (head.is_empty(), body.trim().is_empty()) {
                                (true, _) => body,
                                (false, true) => head,
                                (false, false) => format!("{} {}", head, body),
                            };
                            if !text.trim().is_empty() {
                                let level = if by_code || by_style { 0 } else { outline_level };
                                let link = !(by_code || by_style);
                                titles.push(TocEntry { kind: TocKind::Title, level, text, sec: s, para: p, obj: None, page, target: 0, link });
                            }
                        }
                    }
                }
                // 캡션 있는 개체(본문 문단의 것 + 표 칸 안의 것)
                let mut stack: Vec<(&Paragraph, Vec<(usize, usize, usize)>)> = vec![(para, Vec::new())];
                while let Some((host, path)) = stack.pop() {
                    for (ci, ctrl) in host.controls.iter().enumerate() {
                        if let Some((cap, numbering, id)) = caption_of(ctrl) {
                            let kind = match (ctrl, numbering) {
                                (Control::Equation(_), _) => Some(TocKind::Equation),
                                (_, ObjectNumberingType::Table) => Some(TocKind::Table),
                                (_, ObjectNumberingType::Picture) => Some(TocKind::Picture),
                                (_, ObjectNumberingType::Equation) => Some(TocKind::Equation),
                                (_, ObjectNumberingType::None) => None,
                            };
                            let wanted = match kind {
                                Some(TocKind::Table) => opts.table,
                                Some(TocKind::Picture) => opts.picture,
                                Some(TocKind::Equation) => opts.equation,
                                _ => false,
                            };
                            let text = caption_text(cap);
                            if wanted && !text.trim().is_empty() {
                                let page = if path.is_empty() {
                                    page_of_ctrl.get(&(s, p, ci)).copied().unwrap_or(page)
                                } else {
                                    page_of_ctrl.get(&(s, p, path[0].0)).copied().unwrap_or(page)
                                };
                                let e = TocEntry {
                                    kind: kind.unwrap(),
                                    level: 0,
                                    text,
                                    sec: s,
                                    para: p,
                                    obj: Some(ObjRef { ctrl: ci, path: path.clone() }),
                                    page,
                                    target: id,
                                    link: true,
                                };
                                match e.kind {
                                    TocKind::Table => tables.push(e),
                                    TocKind::Picture => pictures.push(e),
                                    _ => equations.push(e),
                                }
                            }
                        }
                        if let Control::Table(t) = ctrl {
                            for (cell_i, cell) in t.cells.iter().enumerate() {
                                for (cp_i, cp) in cell.paragraphs.iter().enumerate() {
                                    let mut np = path.clone();
                                    np.push((ci, cell_i, cp_i));
                                    stack.push((cp, np));
                                }
                            }
                        }
                    }
                }
            }
        }
        // 표 칸 안 개체는 스택 차례라 문서 차례로 다시(구역·문단·경로)
        let key = |e: &TocEntry| -> (usize, usize, Vec<(usize, usize, usize)>, usize) {
            let o = e.obj.clone().unwrap_or(ObjRef { ctrl: 0, path: Vec::new() });
            let mut path = o.path.clone();
            if path.is_empty() {
                path.push((o.ctrl, 0, 0));
            }
            (e.sec, e.para, path, o.ctrl)
        };
        for list in [&mut tables, &mut pictures, &mut equations] {
            list.sort_by(|a, b| key(a).cmp(&key(b)));
        }
        let mut out = titles;
        out.extend(tables);
        out.extend(pictures);
        out.extend(equations);
        out
    }

    /// 하이퍼링크 대상 id 를 확정한다 — 고유 id 가 없는 문단·개체에는 새 id 를 준다(한/글도 차례를 만들 때 그렇게 한다)
    fn ensure_toc_targets(&mut self, entries: &mut [TocEntry]) {
        // 본문 문단 id 집계
        let mut count: HashMap<u32, usize> = HashMap::new();
        let mut max_id = 0u32;
        for sec in &self.document.sections {
            for p in &sec.paragraphs {
                let id = para_instance_id(p);
                *count.entry(id).or_insert(0) += 1;
                if id < GENERIC_PARA_ID {
                    max_id = max_id.max(id);
                }
            }
        }
        let mut next = max_id.max(100_000_000);
        let mut fresh = || {
            next += 1;
            if next >= GENERIC_PARA_ID {
                next = 1;
            }
            next
        };
        let mut used_obj: HashSet<u32> = HashSet::new();
        for e in entries.iter_mut().filter(|e| e.link) {
            match e.kind {
                TocKind::Title => {
                    let p = &mut self.document.sections[e.sec].paragraphs[e.para];
                    let id = para_instance_id(p);
                    let unique = id != 0 && id != GENERIC_PARA_ID && count.get(&id).copied().unwrap_or(0) <= 1;
                    if unique {
                        e.target = id;
                    } else {
                        let mut nid = fresh();
                        while count.contains_key(&nid) {
                            nid = fresh();
                        }
                        if let Some(c) = count.get_mut(&id) {
                            *c = c.saturating_sub(1);
                        }
                        count.insert(nid, 1);
                        set_para_instance_id(p, nid);
                        e.target = nid;
                    }
                }
                _ => {
                    // 개체 id 가 없거나(0) 다른 개체와 겹치면 가리킬 수 없으니 링크를 달지 않는다
                    if e.target == 0 || !used_obj.insert(e.target) {
                        e.link = false;
                    }
                }
            }
        }
    }

    /// 차례 문단 모양·글자 모양 준비
    fn toc_shapes(&mut self, opts: &TocOptions, sec: usize, max_level: u8) -> TocShapes {
        let style_by_name = |doc: &crate::model::document::Document, name: &str| -> Option<u8> {
            doc.doc_info.styles.iter().position(|s| s.local_name == name).map(|i| i as u8)
        };
        let base_style = |doc: &crate::model::document::Document, id: u8| -> (u16, u32) {
            doc.doc_info
                .styles
                .get(id as usize)
                .map(|s| (s.para_shape_id, s.char_shape_id as u32))
                .unwrap_or((0, 0))
        };
        let doc = &self.document;
        let head_style = style_by_name(doc, "차례 제목").unwrap_or(0);
        let (head_ps, head_cs) = base_style(doc, head_style);
        let (plain_ps, plain_cs) = base_style(doc, 0);
        // [hwpx-cowork] 2026-11-04 수준 L(0부터) 항목 = 'TOC L+1' 스타일(영문 이름 TOC n 또는 이름 차례 n),
        // 없으면 그보다 얕은 것 중 가장 깊은 TOC 스타일, 하나도 없으면 바탕글 — 한/글 2022 실측
        // (개요 1~10 + ContentsLevel 9 를 UpdateAllContents: 차례 1~3 문서는 개요 4~10 이 '차례 3',
        // 차례 4·5 를 더하면 개요 6~10 이 '차례 5', '차례 3' 이름만 바꾸면(영문 TOC 3 그대로) 그 스타일).
        // 종전에는 '차례 n' 이 없으면 바탕글이라 개요 4~10 항목 모양이 한/글과 달랐다.
        let toc_style = |doc: &crate::model::document::Document, n: u8| -> Option<u8> {
            let (local, eng) = (format!("차례 {}", n), format!("TOC {}", n));
            doc.doc_info
                .styles
                .iter()
                .position(|s| s.english_name == eng || s.local_name == local)
                .map(|i| i as u8)
        };
        let mut level_styles = Vec::new();
        for lv in 0..=max_level {
            let st = (1..=lv + 1).rev().find_map(|n| toc_style(doc, n)).unwrap_or(0);
            let (ps, cs) = base_style(doc, st);
            level_styles.push((st, ps, cs));
        }
        // 단 너비(HWPUNIT) — 쪽 너비 − 왼쪽·오른쪽 여백 − 제본 여백(한/글 실측: A4 30mm 여백 → 42520)
        let pd = &doc.sections.get(sec).map(|s| s.section_def.page_def.clone()).unwrap_or_default();
        let paper_w = if pd.landscape { pd.height } else { pd.width };
        let mut tab_pos = paper_w.saturating_sub(pd.margin_left).saturating_sub(pd.margin_right).saturating_sub(pd.margin_gutter);
        if let Some(w) = self
            .pagination
            .get(sec)
            .and_then(|pr| pr.pages.first())
            .map(|pg| pg.layout.column_width_hu())
            .filter(|w| *w > 0)
        {
            // 다단이면 단 너비
            if (w as i64 - tab_pos as i64).abs() > 600 {
                tab_pos = w as u32;
            }
        }
        if tab_pos == 0 {
            tab_pos = 42520;
        }
        // 탭 정의: 첫 문단(차례 제목) 스타일 탭 정의의 왼쪽 끝 자동 탭 + 오른쪽 탭/오른쪽 끝 자동 탭
        let head_td = doc
            .doc_info
            .para_shapes
            .get(head_ps as usize)
            .and_then(|ps| doc.doc_info.tab_defs.get(ps.tab_def_id as usize))
            .cloned()
            .unwrap_or_default();
        let auto_left = head_td.auto_tab_left;
        let td = TabDef {
            raw_data: None,
            attr: u32::from(auto_left) | (u32::from(opts.auto_tab) << 1),
            tabs: if opts.auto_tab {
                Vec::new()
            } else {
                // TabItem.position 은 HWPX `<hp:default>` 단위(HWPUNIT × 2) — 파서·저장기가 그렇게 다룬다(한/글 case 42520 = default 85040)
                vec![TabItem { position: tab_pos * 2, tab_type: 1, fill_type: opts.leader }]
            },
            auto_tab_left: auto_left,
            auto_tab_right: opts.auto_tab,
        };
        let td_id = self.document.find_or_create_tab_def(td);
        let tabbed = |doc: &mut crate::model::document::Document, ps: u16| -> u16 {
            doc.find_or_create_para_shape(ps, &ParaShapeMods { tab_def_id: Some(td_id), ..Default::default() })
        };
        let blue = 0x00FF_0000u32; // #0000FF (BGR)
        let link_mods = CharShapeMods {
            text_color: Some(blue),
            underline_type: Some(UnderlineType::Bottom),
            underline_color: Some(blue),
            ..Default::default()
        };
        let head = (head_style, tabbed(&mut self.document, head_ps), head_cs);
        let mut levels = Vec::new();
        for (st, ps, cs) in level_styles {
            let p = tabbed(&mut self.document, ps);
            let link = self.document.find_or_create_char_shape(cs, &link_mods);
            levels.push((st, p, cs, link));
        }
        let blank = (0u8, tabbed(&mut self.document, plain_ps), plain_cs);
        let plain = (0u8, plain_ps, plain_cs);
        TocShapes { head, levels, blank, plain, tab_pos }
    }

    /// 다음 필드 id
    fn next_field_id(&self) -> u32 {
        let mut max_id = 0;
        for s in &self.document.sections {
            for p in &s.paragraphs {
                crate::document_core::queries::field_query::collect_max_field_id(p, &mut max_id);
            }
        }
        max_id
    }

    /// 차례 문단들의 HWPX 조각. toc_field_id 가 Some 이면 필드로 넣기
    fn toc_xml(&self, opts: &TocOptions, entries: &[TocEntry], shapes: &TocShapes, toc_field_id: Option<u32>, mut next_link_id: u32) -> String {
        let mut x = String::from("<hs:sec>");
        let mut first_id = true;
        let mut p_open = |x: &mut String, st: u8, ps: u16| {
            let id = if first_id { "0" } else { "2147483648" };
            first_id = false;
            x.push_str(&format!(
                r#"<hp:p id="{}" paraPrIDRef="{}" styleIDRef="{}" pageBreak="0" columnBreak="0" merged="0">"#,
                id, ps, st
            ));
        };
        let field_begin = |id: u32, cmd: &str| -> String {
            format!(
                concat!(
                    r#"<hp:ctrl><hp:fieldBegin id="{id}" type="TABLEOFCONTENTS" name="" editable="1" dirty="0" fieldid="{inst}">"#,
                    r#"<hp:parameters cnt="2" name=""><hp:integerParam name="Prop">8</hp:integerParam>"#,
                    r#"<hp:stringParam name="Command" xml:space="preserve">{cmd}</hp:stringParam></hp:parameters>"#,
                    r#"</hp:fieldBegin></hp:ctrl>"#
                ),
                id = id,
                inst = TOC_FIELD_INSTANCE,
                cmd = xml_text(cmd),
            )
        };
        // 첫 문단
        let (hs, hp, hc) = shapes.head;
        let titles: Vec<&TocEntry> = entries.iter().filter(|e| e.kind == TocKind::Title).collect();
        if toc_field_id.is_some() || opts.title {
            p_open(&mut x, hs, hp);
        } else {
            let (ps_st, ps_ps, _) = shapes.plain;
            p_open(&mut x, ps_st, ps_ps);
        }
        x.push_str(&format!(r#"<hp:run charPrIDRef="{}">"#, if toc_field_id.is_some() || opts.title { hc } else { shapes.plain.2 }));
        if let Some(fid) = toc_field_id {
            x.push_str(&field_begin(fid, &opts.command()));
        }
        x.push_str(&format!("<hp:t>{}</hp:t></hp:run></hp:p>", if opts.title { xml_text(TocKind::Title.heading()) } else { String::new() }));
        let mut lists: Vec<(TocKind, Vec<&TocEntry>)> = Vec::new();
        if opts.title {
            lists.push((TocKind::Title, titles));
        }
        for (k, on) in [(TocKind::Table, opts.table), (TocKind::Picture, opts.picture), (TocKind::Equation, opts.equation)] {
            if on {
                lists.push((k, entries.iter().filter(|e| e.kind == k).collect()));
            }
        }
        let leader = if opts.auto_tab { 0 } else { opts.leader };
        let n_lists = lists.len();
        for (li, (kind, list)) in lists.into_iter().enumerate() {
            if kind != TocKind::Title {
                p_open(&mut x, hs, hp);
                x.push_str(&format!(r#"<hp:run charPrIDRef="{}"><hp:t>{}</hp:t></hp:run></hp:p>"#, hc, xml_text(kind.heading())));
            }
            for e in list {
                let lv = (e.level as usize).min(shapes.levels.len().saturating_sub(1));
                let (st, ps, cs, link_cs) = shapes.levels[lv];
                p_open(&mut x, st, ps);
                let page = e.page.to_string();
                // 탭 너비는 한/글이 열 때 다시 잰다 — 대강(글자 수 × 글자 크기)
                let est = (e.text.chars().count() as u32 + page.len() as u32) * 1000;
                let width = shapes.tab_pos.saturating_sub(est).max(1000);
                let body = format!(r#"{}<hp:tab width="{}" leader="{}" type="2"/>{}"#, xml_text(&e.text), width, leader, page);
                if opts.hyperlink && e.link {
                    let lid = next_link_id;
                    next_link_id += 1;
                    x.push_str(&format!(
                        concat!(
                            r#"<hp:run charPrIDRef="{cs}"><hp:ctrl><hp:fieldBegin id="{lid}" type="HYPERLINK" name="" editable="0" dirty="1" fieldid="{inst}">"#,
                            r#"<hp:parameters cnt="5" name=""><hp:integerParam name="Prop">0</hp:integerParam>"#,
                            r#"<hp:stringParam name="Command">?#{target};0;{code};0;</hp:stringParam>"#,
                            r#"<hp:stringParam name="Category">HWPHYPERLINK_TYPE_HWP</hp:stringParam>"#,
                            r#"<hp:stringParam name="TargetType">{tt}</hp:stringParam>"#,
                            r#"<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam></hp:parameters>"#,
                            r#"</hp:fieldBegin></hp:ctrl></hp:run>"#,
                            r#"<hp:run charPrIDRef="{link_cs}"><hp:t>{body}</hp:t></hp:run>"#,
                            r#"<hp:run charPrIDRef="{cs}"><hp:ctrl><hp:fieldEnd beginIDRef="{lid}" fieldid="{inst}"/></hp:ctrl><hp:t/></hp:run>"#,
                        ),
                        cs = cs,
                        lid = lid,
                        inst = LINK_FIELD_INSTANCE,
                        target = e.target,
                        code = e.kind.link_code(),
                        tt = e.kind.link_target(),
                        link_cs = link_cs,
                        body = body,
                    ));
                } else {
                    x.push_str(&format!(r#"<hp:run charPrIDRef="{}"><hp:t>{}</hp:t></hp:run>"#, cs, body));
                }
                x.push_str("</hp:p>");
            }
            let last = li + 1 == n_lists;
            let (bs, bp, bc) = if last && toc_field_id.is_none() { shapes.plain } else { shapes.blank };
            p_open(&mut x, bs, bp);
            x.push_str(&format!(r#"<hp:run charPrIDRef="{}">"#, bc));
            if last {
                if let Some(fid) = toc_field_id {
                    x.push_str(&format!(r#"<hp:ctrl><hp:fieldEnd beginIDRef="{}" fieldid="{}"/></hp:ctrl>"#, fid, TOC_FIELD_INSTANCE));
                }
            }
            x.push_str("<hp:t/></hp:run></hp:p>");
        }
        if n_lists == 0 {
            // 아무 목록도 없으면 빈 마지막 문단(필드 끝)
            let (bs, bp, bc) = if toc_field_id.is_some() { shapes.blank } else { shapes.plain };
            p_open(&mut x, bs, bp);
            x.push_str(&format!(r#"<hp:run charPrIDRef="{}">"#, bc));
            if let Some(fid) = toc_field_id {
                x.push_str(&format!(r#"<hp:ctrl><hp:fieldEnd beginIDRef="{}" fieldid="{}"/></hp:ctrl>"#, fid, TOC_FIELD_INSTANCE));
            }
            x.push_str("<hp:t/></hp:run></hp:p>");
        }
        x.push_str("</hs:sec>");
        x
    }

    /// 차례 문단 만들기(조각을 엔진 파서로 읽는다)
    fn build_toc_paragraphs(&mut self, opts: &TocOptions, entries: &mut [TocEntry], sec: usize, toc_field_id: Option<u32>) -> Result<Vec<Paragraph>, HwpError> {
        if opts.hyperlink {
            self.ensure_toc_targets(entries);
        }
        let max_level = entries.iter().filter(|e| e.kind == TocKind::Title).map(|e| e.level).max().unwrap_or(0).min(9);
        let shapes = self.toc_shapes(opts, sec, max_level);
        let next_link = toc_field_id.unwrap_or_else(|| self.next_field_id()) + 1;
        let next_link = next_link.max(self.next_field_id() + 1);
        let xml = self.toc_xml(opts, entries, &shapes, toc_field_id, next_link);
        let section = crate::parser::hwpx::section::parse_hwpx_section(&xml)
            .map_err(|e| HwpError::RenderError(format!("차례 조각 읽기 실패: {}", e)))?;
        Ok(section.paragraphs)
    }

    /// 구역 sec 의 [start, end] 문단을 paras 로 바꾼다(end < start 면 start 자리에 끼운다) → 새 자리.
    /// 바꾸는 첫 문단이 구역 나누기(새 구역에 만든 차례 — 구역·단 정의)면 그 정의를 새 첫 문단으로 옮긴다.
    fn splice_toc_paragraphs(&mut self, sec: usize, start: usize, end: Option<usize>, mut paras: Vec<Paragraph>) -> TocRegion {
        let n = paras.len();
        let section = &mut self.document.sections[sec];
        section.raw_stream = None;
        match end {
            Some(e) => {
                let defs = section_defs_of(&section.paragraphs[start]);
                // [hwpx-cowork] 한/글 차례 새로 고침처럼 첫 차례 문단의 쪽·단 나누기를 새 첫 문단에 남긴다 — 표준서식은
                // 차례가 새 쪽에서 시작하는데(차례제목 문단 pageBreak="1"), 새로 고치면 차례가 앞 쪽(표지)에 붙어 그려졌다
                let keep_break = defs.is_empty();
                let (page_break, column_break) =
                    (section.paragraphs[start].has_page_break(), section.paragraphs[start].has_column_break());
                if let Some(first) = paras.first_mut() {
                    if !defs.is_empty() && section_defs_of(first).is_empty() {
                        mark_section_start(first, defs);
                    }
                    if keep_break && page_break && !first.has_page_break() {
                        first.set_break(false);
                    }
                    if keep_break && column_break && !first.has_column_break() {
                        first.set_break(true);
                    }
                }
                section.paragraphs.splice(start..=e, paras);
            }
            None => {
                section.paragraphs.splice(start..start, paras);
            }
        }
        TocRegion { sec, start, end: start + n - 1 }
    }

    /// 바꾼 구역을 다시 조판·쪽 나눔
    fn relayout_toc_section(&mut self, sec: usize, region: TocRegion) {
        self.rebuild_resolved_styles();
        let count = self.document.sections[sec].paragraphs.len();
        for i in region.start..=region.end.min(count.saturating_sub(1)) {
            self.reflow_paragraph(sec, i);
        }
        let hwp3 = self.document.layout_profile().hwp3_layout();
        crate::renderer::composer::recalculate_section_vpos(
            &mut self.document.sections[sec].paragraphs,
            region.start,
            Some(region.start..region.end + 1),
            None,
            &self.styles,
            self.dpi,
            hwp3,
        );
        self.rebuild_section(sec);
    }

    /// 쪽 번호가 맞을 때까지(차례를 넣으면 뒤 쪽이 밀린다) 차례 문단을 다시 만든다 — 최대 3번
    fn settle_toc_pages(&mut self, opts: &TocOptions, mut region: TocRegion, toc_field_id: Option<u32>, mut used: Vec<u32>) -> Result<(TocRegion, usize), HwpError> {
        let mut count = 0;
        for _ in 0..3 {
            let mut entries = self.collect_toc_entries(opts, Some(region));
            count = entries.len();
            let pages: Vec<u32> = entries.iter().map(|e| e.page).collect();
            if pages == used {
                break;
            }
            let paras = self.build_toc_paragraphs(opts, &mut entries, region.sec, toc_field_id)?;
            region = self.splice_toc_paragraphs(region.sec, region.start, Some(region.end), paras);
            self.relayout_toc_section(region.sec, region);
            used = pages;
        }
        Ok((region, count))
    }

    /// 캐럿 문단(sec, para)에서 쓰는 구역·단 정의(그 문단부터 거슬러 처음 만나는 구역 나누기 문단의 것)를 새 구역용으로 —
    /// 쪽·그림·표·수식 번호는 앞 구역에 이어서(시작 번호 0 — 한/글 '새 구역' 차례 실측: 나뉜 구역 모두 `startNum page="0"`)
    fn section_defs_for_new_section(&self, sec: usize, para: usize) -> Vec<Control> {
        let s = &self.document.sections[sec];
        let mut defs = s.paragraphs[..=para].iter().rev().map(section_defs_of).find(|d| !d.is_empty()).unwrap_or_default();
        if !defs.iter().any(|c| matches!(c, Control::SectionDef(_))) {
            defs.insert(0, Control::SectionDef(Box::new(s.section_def.clone())));
        }
        for c in &mut defs {
            if let Control::SectionDef(sd) = c {
                sd.page_num = 0;
                sd.picture_num = 0;
                sd.table_num = 0;
                sd.equation_num = 0;
            }
        }
        defs
    }

    /// 차례 만들기 — 캐럿 문단(sec, para) 뒤(필드로 넣기 + 빈 문단이면 그 자리)에 넣는다 → (자리, 항목 수).
    /// new_section(한/글 '만들 위치: 현재 문서의 새 구역')이면 캐럿 문단 뒤에서 구역을 나눠 차례만 든 구역을 만들고
    /// 그 뒤 문단부터 다시 새 구역으로 한다(한/글 2022 실측: 구역 0 ~ 캐럿 문단 · 구역 1 차례 · 구역 2 나머지).
    pub(crate) fn make_toc(&mut self, sec: usize, para: usize, opts: &TocOptions, new_section: bool) -> Result<(TocRegion, usize), HwpError> {
        self.finish_range_source(); // [hwpx-cowork] 기존 문단을 복제·재배열하기 전 논리 범위 확정
        // [hwpx-cowork] 2026-11-20 차례의 쪽 번호는 모든 쪽이 정해진 뒤에 적는다(뒤쪽 미루기).
        self.flush_typeset_tail();
        if sec >= self.document.sections.len() || para >= self.document.sections[sec].paragraphs.len() {
            return Err(HwpError::RenderError("차례를 넣을 문단이 없습니다".into()));
        }
        let mut entries = self.collect_toc_entries(opts, None);
        let toc_field_id = if opts.field { Some(self.next_field_id() + 1) } else { None };
        let mut paras = self.build_toc_paragraphs(opts, &mut entries, sec, toc_field_id)?;
        let cur = &self.document.sections[sec].paragraphs[para];
        let empty = cur.text.is_empty() && cur.controls.is_empty();
        let region = if new_section {
            let defs = self.section_defs_for_new_section(sec, para);
            if let Some(first) = paras.first_mut() {
                mark_section_start(first, defs.clone());
            }
            let next = para + 1;
            if let Some(after) = self.document.sections[sec].paragraphs.get_mut(next) {
                if section_defs_of(after).is_empty() {
                    mark_section_start(after, defs);
                }
            }
            let region = self.splice_toc_paragraphs(sec, next, None, paras);
            if region.end + 1 < self.document.sections[sec].paragraphs.len() {
                self.reflow_paragraph(sec, region.end + 1);
            }
            region
        } else if opts.field && empty {
            self.splice_toc_paragraphs(sec, para, Some(para), paras)
        } else {
            self.splice_toc_paragraphs(sec, para + 1, None, paras)
        };
        self.relayout_toc_section(sec, region);
        let used = entries.iter().map(|e| e.page).collect();
        self.settle_toc_pages(opts, region, toc_field_id, used)
    }

    /// 차례 새로 고침 — 차례 필드의 선택 사항으로 다시 만든다(opts 가 있으면 그것으로 고친다 — 한/글 '고침')
    pub(crate) fn update_toc(&mut self, region: TocRegion, field_id: u32, opts: &TocOptions) -> Result<(TocRegion, usize), HwpError> {
        self.finish_range_source(); // [hwpx-cowork] 기존 문단을 복제·재배열하기 전 논리 범위 확정
        self.flush_typeset_tail(); // [hwpx-cowork] 2026-11-20 (make_toc 와 같다)
        let mut entries = self.collect_toc_entries(opts, Some(region));
        let mut paras = self.build_toc_paragraphs(opts, &mut entries, region.sec, Some(field_id))?;
        // 첫 문단에 차례 필드 말고 다른 컨트롤(그림 등)이 있으면 그 문단은 두고 필드 Command 만 고친다.
        // 구역·단 정의(새 구역에 만든 차례)는 새 첫 문단으로 옮긴다(splice_toc_paragraphs)
        let first = &self.document.sections[region.sec].paragraphs[region.start];
        let foreign = first
            .controls
            .iter()
            .any(|c| !matches!(c, Control::Field(_) | Control::SectionDef(_) | Control::ColumnDef(_)));
        let region = if foreign && !paras.is_empty() {
            let cmd = opts.command();
            if let Some(Control::Field(f)) = self.document.sections[region.sec].paragraphs[region.start]
                .controls
                .iter_mut()
                .find(|c| matches!(c, Control::Field(f) if f.field_type == FieldType::TableOfContents))
            {
                f.command = cmd.clone();
                f.raw_parameters_xml = Some(format!(
                    r#"<hp:parameters cnt="2" name=""><hp:integerParam name="Prop">8</hp:integerParam><hp:stringParam name="Command" xml:space="preserve">{}</hp:stringParam></hp:parameters>"#,
                    xml_text(&cmd)
                ));
            }
            paras.remove(0);
            if region.end > region.start {
                let r = self.splice_toc_paragraphs(region.sec, region.start + 1, Some(region.end), paras);
                TocRegion { sec: region.sec, start: region.start, end: r.end }
            } else {
                let r = self.splice_toc_paragraphs(region.sec, region.start + 1, None, paras);
                TocRegion { sec: region.sec, start: region.start, end: r.end }
            }
        } else {
            self.splice_toc_paragraphs(region.sec, region.start, Some(region.end), paras)
        };
        self.relayout_toc_section(region.sec, region);
        let used = entries.iter().map(|e| e.page).collect();
        self.settle_toc_pages(opts, region, Some(field_id), used)
    }

    /// 제목 차례 표시(kind="title" — Mtit)·차례 숨김(kind="hide" — Mign)·없애기(kind="none"). 이미 같은 표시면 없앤다(켜고 끄기)
    /// → 지금 문단의 표시("title"|"hide"|"none")
    pub(crate) fn set_title_mark(&mut self, sec: usize, para: usize, kind: &str) -> Result<&'static str, HwpError> {
        let p = self
            .document
            .sections
            .get_mut(sec)
            .and_then(|s| s.paragraphs.get_mut(para))
            .ok_or_else(|| HwpError::RenderError("문단이 없습니다".into()))?;
        let want_ignore = match kind {
            "title" => Some(true),
            "hide" => Some(false),
            _ => None,
        };
        let had_same = want_ignore.is_some_and(|w| p.title_marks.iter().any(|m| m.ignore == w));
        p.title_marks.clear();
        let now = match want_ignore {
            Some(w) if !had_same => {
                // 한/글은 표시를 문단 맨 앞에 둔다(캐럿 자리와 무관 — 실측)
                p.title_marks.push(TitleMark { char_idx: 0, ignore: w });
                if w {
                    "title"
                } else {
                    "hide"
                }
            }
            _ => "none",
        };
        self.document.sections[sec].raw_stream = None;
        self.mark_section_dirty(sec);
        Ok(now)
    }

    /// 문단의 차례 표시 상태
    pub(crate) fn title_mark_state(&self, sec: usize, para: usize) -> &'static str {
        match self.document.sections.get(sec).and_then(|s| s.paragraphs.get(para)) {
            Some(p) if p.title_marks.iter().any(|m| !m.ignore) => "hide",
            Some(p) if p.title_marks.iter().any(|m| m.ignore) => "title",
            _ => "none",
        }
    }

    /// 하이퍼링크 Command(`?#<id>;…`)의 문서 안 대상 → (구역, 본문 문단, 컨트롤?)
    pub(crate) fn find_link_target(&self, command: &str) -> Option<(usize, usize, Option<usize>)> {
        let rest = command.trim().strip_prefix('?')?;
        let rest = rest.strip_prefix('#').unwrap_or(rest);
        let id_txt: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let id: u32 = id_txt.parse().ok()?;
        let kind: Option<u8> = rest.split(';').nth(2).and_then(|s| s.trim().parse().ok());
        if id == 0 {
            return None;
        }
        let want_obj = matches!(kind, Some(2..=4));
        for (s, sec) in self.document.sections.iter().enumerate() {
            for (p, para) in sec.paragraphs.iter().enumerate() {
                if !want_obj && para_instance_id(para) == id {
                    return Some((s, p, None));
                }
                for (ci, c) in para.controls.iter().enumerate() {
                    let cid = match c {
                        Control::Table(t) => t.common.instance_id,
                        Control::Picture(pic) => pic.common.instance_id,
                        Control::Equation(e) => e.common.instance_id,
                        Control::Shape(sh) => sh.common().instance_id,
                        _ => 0,
                    };
                    if cid == id {
                        return Some((s, p, Some(ci)));
                    }
                }
            }
        }
        // 책갈피 이름 링크(`?이름;…`)
        let name: String = command.trim().trim_start_matches('?').split(';').next().unwrap_or("").to_string();
        if !name.is_empty() {
            for (s, sec) in self.document.sections.iter().enumerate() {
                for (p, para) in sec.paragraphs.iter().enumerate() {
                    if para.controls.iter().any(|c| matches!(c, Control::Bookmark(b) if b.name == name)) {
                        return Some((s, p, None));
                    }
                }
            }
        }
        None
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TocRequest {
    sec: usize,
    para: usize,
    #[serde(default)]
    options: Option<TocOptions>,
    #[serde(default)]
    kind: Option<String>,
    /// 만들 위치: 현재 문서의 새 구역(한/글 '차례 만들기' 만들 위치)
    #[serde(default)]
    new_section: bool,
}

fn region_json(r: TocRegion, field_id: Option<u32>, opts: Option<&TocOptions>, entries: Option<usize>) -> serde_json::Value {
    let mut v = serde_json::json!({ "sec": r.sec, "start": r.start, "end": r.end });
    if let Some(f) = field_id {
        v["fieldId"] = serde_json::json!(f);
    }
    if let Some(o) = opts {
        v["options"] = serde_json::to_value(o).unwrap_or(serde_json::Value::Null);
    }
    if let Some(n) = entries {
        v["entries"] = serde_json::json!(n);
    }
    v
}

fn parse_req(json: &str) -> Result<TocRequest, HwpError> {
    serde_json::from_str(json).map_err(|e| HwpError::InvalidField(format!("차례 요청 JSON: {}", e)))
}

impl DocumentCore {
    /// 차례 만들기 — 입력 `{"sec","para","options":{…TocOptions},"newSection"?}` → `{"ok":true,"sec","start","end","entries","fieldId"?}`
    pub fn make_toc_native(&mut self, json: &str) -> Result<String, HwpError> {
        let req = parse_req(json)?;
        let opts = req.options.unwrap_or_default();
        let (r, n) = self.make_toc(req.sec, req.para, &opts, req.new_section)?;
        let fid = Self::toc_field_in(&self.document.sections[r.sec].paragraphs[r.start]).map(|x| x.1);
        let mut v = region_json(r, fid, None, Some(n));
        v["ok"] = serde_json::json!(true);
        Ok(v.to_string())
    }

    /// 문단이 든 차례 — 입력 `{"sec","para"}` → `{"found":false}` | `{"found":true,"sec","start","end","fieldId","options"}`
    pub fn get_toc_at_native(&self, json: &str) -> Result<String, HwpError> {
        let req = parse_req(json)?;
        Ok(match self.toc_region_at(req.sec, req.para) {
            Some((r, fid, opts)) => {
                let mut v = region_json(r, Some(fid), opts.as_ref(), None);
                v["found"] = serde_json::json!(true);
                v.to_string()
            }
            None => r#"{"found":false}"#.to_string(),
        })
    }

    /// 문서의 차례 필드 목록
    pub fn list_tocs_native(&self) -> String {
        let list: Vec<serde_json::Value> =
            self.toc_regions().into_iter().map(|(r, fid, o)| region_json(r, Some(fid), o.as_ref(), None)).collect();
        serde_json::Value::Array(list).to_string()
    }

    /// 차례 새로 고침(고침) — 입력 `{"sec","para","options"?}` (options 가 있으면 그 선택 사항으로 고친다) → `{"ok":true,"sec","start","end","entries"}`
    pub fn update_toc_native(&mut self, json: &str) -> Result<String, HwpError> {
        let req = parse_req(json)?;
        let (region, fid, saved) = self
            .toc_region_at(req.sec, req.para)
            .ok_or_else(|| HwpError::InvalidField("캐럿 자리에 차례 필드가 없습니다".into()))?;
        let opts = req.options.or(saved).unwrap_or_default();
        let opts = TocOptions { field: true, ..opts };
        let (r, n) = self.update_toc(region, fid, &opts)?;
        let mut v = region_json(r, Some(fid), None, Some(n));
        v["ok"] = serde_json::json!(true);
        Ok(v.to_string())
    }

    /// 모든 차례 새로 고침 → `{"ok":true,"count":n}`
    pub fn update_all_tocs_native(&mut self) -> Result<String, HwpError> {
        let mut i = 0;
        loop {
            let regions = self.toc_regions();
            let Some((region, fid, saved)) = regions.into_iter().nth(i) else { break };
            let opts = TocOptions { field: true, ..saved.unwrap_or_default() };
            self.update_toc(region, fid, &opts)?;
            i += 1;
            if i > 64 {
                break;
            }
        }
        Ok(format!(r#"{{"ok":true,"count":{}}}"#, i))
    }

    /// 제목 차례 표시/차례 숨기기 — 입력 `{"sec","para","kind":"title"|"hide"|"none"}` (같은 표시가 있으면 없앤다) → `{"ok":true,"state"}`
    pub fn set_title_mark_native(&mut self, json: &str) -> Result<String, HwpError> {
        let req = parse_req(json)?;
        let state = self.set_title_mark(req.sec, req.para, req.kind.as_deref().unwrap_or("title"))?;
        self.paginate_if_needed();
        Ok(format!(r#"{{"ok":true,"state":"{}"}}"#, state))
    }

    /// 문단의 차례 표시 — 입력 `{"sec","para"}` → `{"state":"title"|"hide"|"none"}`
    pub fn get_title_mark_native(&self, json: &str) -> Result<String, HwpError> {
        let req = parse_req(json)?;
        Ok(format!(r#"{{"state":"{}"}}"#, self.title_mark_state(req.sec, req.para)))
    }

    /// 하이퍼링크 Command 의 문서 안 대상 → `{"found":false}` | `{"found":true,"sec","para","control"?}`
    pub fn find_link_target_native(&self, command: &str) -> String {
        match self.find_link_target(command) {
            Some((s, p, c)) => {
                let mut v = serde_json::json!({ "found": true, "sec": s, "para": p });
                if let Some(c) = c {
                    v["control"] = serde_json::json!(c);
                }
                v.to_string()
            }
            None => r#"{"found":false}"#.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_matches_hangul_layout() {
        let o = TocOptions::default();
        assert_eq!(
            o.command(),
            "TableOfContents:set:140:ContentsMake:uint:31 ContentsStyles:wstring:0: ContentsLevel:int:2 ContentsAutoTabRight:int:0 ContentsLeader:int:3 ContentsHyperlink:bool:1  "
        );
        let back = TocOptions::from_command(&o.command()).unwrap();
        assert_eq!(back, o);
        let s = TocOptions { use_styles: true, styles: vec!["본문".into(), "개요 1".into()], outline: false, hyperlink: false, table: false, picture: false, equation: false, ..Default::default() };
        assert!(s.command().contains("ContentsMake:uint:33 ContentsStyles:wstring:8:본문;개요 1; "));
        assert_eq!(TocOptions::from_command(&s.command()).unwrap().styles, vec!["본문", "개요 1"]);
    }

    /// 한/글 기본 머리(ref_empty.hwpx)에 개요 n 스타일 문단들을 더한 시험지. `heads` = (수준, 새 번호 형식).
    fn outline_probe(seq: &[u8], text: impl Fn(usize, u8) -> String, heads: &[(u8, &str)]) -> Vec<u8> {
        use std::io::{Read, Write};
        let src: &[u8] = include_bytes!("../../../samples/hwpx/ref/ref_empty.hwpx");
        // 개요 n 스타일 id = n+1, 문단 모양: 개요 1~7 = n+1, 개요 8 = 18, 9 = 16, 10 = 17
        let pp = |n: u8| match n {
            8 => 18,
            9 => 16,
            10 => 17,
            n => n as u32 + 1,
        };
        let mut zin = zip::ZipArchive::new(std::io::Cursor::new(src)).unwrap();
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zout = zip::ZipWriter::new(&mut out);
            for i in 0..zin.len() {
                let mut f = zin.by_index(i).unwrap();
                let name = f.name().unwrap().to_string();
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                let method = if name == "mimetype" { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated };
                let opts = zip::write::SimpleFileOptions::default().compression_method(method);
                if name == "Contents/section0.xml" {
                    let xml = String::from_utf8(data).unwrap();
                    let paras: String = seq
                        .iter()
                        .enumerate()
                        .map(|(i, &n)| {
                            format!(
                                r#"<hp:p id="{}" paraPrIDRef="{}" styleIDRef="{}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>{}</hp:t></hp:run></hp:p>"#,
                                1000 + i,
                                pp(n),
                                n + 1,
                                text(i, n)
                            )
                        })
                        .collect();
                    data = xml.replace("</hs:sec>", &format!("{paras}</hs:sec>")).into_bytes();
                } else if name == "Contents/header.xml" {
                    let mut xml = String::from_utf8(data).unwrap();
                    for (level, fmt) in heads {
                        let key = format!(r#"<hh:paraHead start="1" level="{level}" "#);
                        let at = xml.find(&key).unwrap();
                        let gt = at + xml[at..].find('>').unwrap();
                        let self_closing = xml[..gt].ends_with('/');
                        let open_end = if self_closing { gt - 1 } else { gt };
                        let close = if self_closing {
                            gt + 1
                        } else {
                            gt + 1 + xml[gt + 1..].find("</hh:paraHead>").unwrap() + "</hh:paraHead>".len()
                        };
                        let head = xml[at..open_end].to_string();
                        xml.replace_range(at..close, &format!("{head}>{fmt}</hh:paraHead>"));
                    }
                    data = xml.into_bytes();
                }
                zout.start_file(name, opts).unwrap();
                zout.write_all(&data).unwrap();
            }
            zout.finish().unwrap();
        }
        out.into_inner()
    }

    fn markers(core: &DocumentCore, from: usize) -> Vec<String> {
        core.document.sections[0].paragraphs[from..]
            .iter()
            .map(|p| p.numbering_marker.text().unwrap_or("").to_string())
            .collect()
    }

    /// [hwpx-cowork] 2026-11-04 개요 8~10 번호 — 한/글 2022 실측(문단마다 GetHeadingString, HWPX·HWP 같음).
    /// 한/글 기본 개요 8~10 문단 모양은 heading 이 2016 확장 switch 라 종전 엔진은 머리 없음으로 보고 번호를 안 그렸다.
    #[test]
    fn outline_8_to_10_numbers_follow_hangul() {
        let probe = |seq: &[u8], heads: &[(u8, &str)]| {
            DocumentCore::from_bytes(&outline_probe(seq, |i, n| format!("p{} 개요{}", i + 1, n), heads)).unwrap()
        };
        // 기본 번호 모양: 8 = ^8(원 가나다), 9·10 = 빈 형식
        let core = probe(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 8], &[]);
        assert_eq!(markers(&core, 1), ["1.", "가.", "1)", "가)", "(1)", "(가)", "①", "㉮", "", "", "2.", "㉮"]);
        // 내보내기: 번호 글이 있는 개요 8 문단 둘만 한/글처럼 문단 머리 번호 글 대체 switch(개요 9·10 은 번호 글이 비어 없음)
        {
            use std::io::Read;
            let out = crate::serializer::hwpx::serialize_hwpx(&core.document).expect("serialize");
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
            let mut sec = String::new();
            zip.by_name("Contents/section0.xml").unwrap().read_to_string(&mut sec).unwrap();
            let fallback = r#"<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/paragraph"/><hp:default><hp:run charPrIDRef="0"><hp:t>㉮ </hp:t></hp:run></hp:default></hp:switch><hp:run charPrIDRef="0"><hp:t>p8 개요8</hp:t>"#;
            assert!(sec.contains(fallback), "개요 8 번호 글 대체");
            assert_eq!(sec.matches("2016/paragraph\"/><hp:default>").count(), 2, "번호 글 대체는 개요 8 둘");
            // 다시 읽으면 대체 글은 본문이 아니다(번호는 셈으로 그린다)
            let again = DocumentCore::from_bytes(&crate::serializer::hwpx::serialize_hwpx(&core.document).unwrap()).unwrap();
            assert_eq!(again.document.sections[0].paragraphs[8].text, "p8 개요8");
            assert_eq!(markers(&again, 1), markers(&core, 1));
        }
        // 셈·되돌림 + 9수준 "^9)", 10수준 "^10]"(= ^1 + "0]")
        let core = probe(&[1, 1, 1, 7, 8, 8, 9, 10, 10, 9, 10, 8, 9, 7, 8, 2, 8], &[(9, "^9)"), (10, "^10]")]);
        assert_eq!(
            markers(&core, 1),
            ["1.", "2.", "3.", "①", "㉮", "㉯", "ㄱ)", "30]", "30]", "ㄴ)", "30]", "㉰", "ㄱ)", "②", "㉮", "나.", "㉮"]
        );
        // 9수준 "^1-^8-^9", 10수준 "^0]"
        let core = probe(&[1, 8, 8, 9, 10, 10, 9, 10, 1, 10], &[(9, "^1-^8-^9"), (10, "^0]")]);
        assert_eq!(markers(&core, 1), ["1.", "㉮", "㉯", "1-㉯-ㄱ", "0]", "0]", "1-㉯-ㄴ", "0]", "2.", "0]"]);
        // 8수준 "^0", 9수준 "^N", 10수준 "^n" — 경로는 아라비아 숫자
        let core = probe(&[1, 1, 3, 8, 9, 10, 10], &[(8, "^0"), (9, "^N"), (10, "^n")]);
        assert_eq!(
            markers(&core, 1),
            ["1.", "2.", "1)", "0", "2.1.1.1.1.1.1.1.1.", "2.1.1.1.1.1.1.1.1.1", "2.1.1.1.1.1.1.1.1.2"]
        );
    }

    /// [hwpx-cowork] 2026-11-04 차례 만들기 — 개요 1~10 + ContentsLevel 6·7·9 를 한/글 2022 가 다시 만든 차례
    /// (UpdateAllContents): 수준 ≤ ContentsLevel 인 개요만(8~10 도), 항목 스타일은 'TOC n' 이 없으면 더 얕은 것 중
    /// 가장 깊은 TOC 스타일(이 문서는 차례 1~3 → 개요 4~10 = 차례 3), 번호 글이 빈 개요 9·10 은 번호 없이.
    #[test]
    fn toc_outline_8_to_10_follows_hangul() {
        let seq = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 8];
        let bytes = outline_probe(&seq, |i, n| format!("제목{} 개요{}", i + 1, n), &[]);
        let all = [
            ("차례 1", "1. 제목1 개요1"),
            ("차례 2", "가. 제목2 개요2"),
            ("차례 3", "1) 제목3 개요3"),
            ("차례 3", "가) 제목4 개요4"),
            ("차례 3", "(1) 제목5 개요5"),
            ("차례 3", "(가) 제목6 개요6"),
            ("차례 3", "① 제목7 개요7"),
            ("차례 3", "㉮ 제목8 개요8"),
            ("차례 3", "제목9 개요9"),
            ("차례 3", "제목10 개요10"),
            ("차례 1", "2. 제목11 개요1"),
            ("차례 3", "㉮ 제목12 개요8"),
        ];
        // ContentsLevel → 모으는 개요 n 의 끝(개요 n ≤ ContentsLevel + 1)
        for level in [6u8, 7, 9] {
            let mut core = DocumentCore::from_bytes(&bytes).unwrap();
            let len = core.document.sections[0].paragraphs[0].text.chars().count();
            core.split_paragraph_native(0, 0, len, None).unwrap();
            let opts = TocOptions { level, table: false, picture: false, equation: false, hyperlink: false, ..Default::default() };
            let (r, _) = core.make_toc(0, 1, &opts, false).unwrap();
            let doc = &core.document;
            let got: Vec<(String, String)> = doc.sections[0].paragraphs[r.start..=r.end]
                .iter()
                .map(|p| {
                    let style = doc.doc_info.styles.get(p.style_id as usize).map(|s| s.local_name.clone()).unwrap_or_default();
                    let text = p.text.split('\t').next().unwrap_or("");
                    (style, clean_text(text).trim().to_string())
                })
                .collect();
            let want: Vec<(String, String)> = std::iter::once(("차례 제목".to_string(), "<제목 차례>".to_string()))
                .chain(
                    all.iter()
                        .zip(seq.iter())
                        .filter(|(_, &n)| n <= level + 1)
                        .map(|((s, t), _)| (s.to_string(), t.to_string())),
                )
                .chain(std::iter::once(("바탕글".to_string(), String::new())))
                .collect();
            assert_eq!(got, want, "ContentsLevel {level}");
        }
    }
}
