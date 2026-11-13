//! [hwpx-cowork] HWPX(header.xml · section0.xml · BinData) → 한글 클립보드 문서모델(hwpjson).
//!
//! 같은 폴더의 정방향 변환기(hwpjson → HWPX)를 거꾸로 돌린다. 한글은 Ctrl+V 때 클립보드 HTML
//! 안의 `<!--[data-hwpjson]{…}-->` 를 읽어 표·그림·캡션·자동번호를 원본 구조로 되살린다.
//! 브라우저가 쓸 수 있는 형식은 HTML 이므로, 이 모델을 실으면 설치 없이 웹 → 한글 원본 붙여넣기가 된다.
//!
//! 키 이름·열거 순서·스케일은 정방향 모듈(`pack`·`fonts_charpr`·`parapr`·`body`)의 매핑을 그대로
//! 뒤집었다. 정방향이 읽지 않는 키는 한글 2022 실측 표본(artifacts/clipboard-import-2026-10-28)의
//! 기본값을 쓴다. 한글처럼 본문이 실제로 참조하는 서식 항목만 싣는다.

use std::collections::{BTreeMap, HashMap};

use roxmltree::Node;

use crate::error::HwpError;

// ---------------------------------------------------------------- JSON 작성기
// serde_json 의 Map 은 키를 정렬하므로 한글 표본과 같은 순서를 지키려고 따로 둔다.

#[derive(Clone, Debug)]
enum J {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn obj() -> J {
        J::Obj(Vec::new())
    }
    fn set(&mut self, k: &str, v: J) {
        if let J::Obj(items) = self {
            if let Some(slot) = items.iter_mut().find(|(key, _)| key == k) {
                slot.1 = v;
            } else {
                items.push((k.to_string(), v));
            }
        }
    }
    fn with(mut self, k: &str, v: J) -> J {
        self.set(k, v);
        self
    }
    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Int(i) => out.push_str(&i.to_string()),
            J::Num(f) => {
                if f.is_finite() {
                    if *f == f.trunc() && f.abs() < 1e15 {
                        out.push_str(&(*f as i64).to_string());
                    } else {
                        out.push_str(&f.to_string());
                    }
                } else {
                    out.push('0');
                }
            }
            J::Str(s) => write_str(out, s),
            J::Arr(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::Obj(items) => {
                out.push('{');
                for (i, (k, v)) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// JSON 문자열. HTML 주석 안에 들어가므로 `>` 와 `<` 는 \u 이스케이프한다(`-->` 로 주석이 끊기지 않게).
fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn s(v: &str) -> J {
    J::Str(v.to_string())
}
fn i(v: i64) -> J {
    J::Int(v)
}
fn b(v: bool) -> J {
    J::Bool(v)
}

// ---------------------------------------------------------------- 열거표 (정방향과 같은 순서)

const CI_SECD: i64 = 1_936_024_420; // b"secd"
const CI_COLD: i64 = 1_668_246_628; // b"cold"
const CI_PGNP: i64 = 1_885_826_672; // b"pgnp"
const CI_TBL: i64 = 1_952_607_264; // b"tbl "
const CI_GSO: i64 = 1_735_618_336; // b"gso "
const CI_ATNO: i64 = 1_635_020_399; // b"atno"
const CI_NWNO: i64 = 1_853_320_815; // b"nwno"
const CI_PGHD: i64 = 1_885_825_124; // b"pghd"
const CI_BOKM: i64 = 1_651_469_165; // b"bokm"
const CI_FN: i64 = 1_718_493_216; // b"fn  "
const CI_EN: i64 = 1_701_716_000; // b"en  "
const CI_HEAD: i64 = 1_751_474_532; // b"head"
const CI_FOOT: i64 = 1_718_579_060; // b"foot"
const RC_PIC: i64 = 611_346_787; // b"$pic"
const RC_REC: i64 = 611_476_835; // b"$rec"
const RC_LIN: i64 = 611_084_654; // b"$lin"
const RC_POL: i64 = 611_348_332; // b"$pol"
const RC_ELL: i64 = 610_626_668; // b"$ell"
const RC_ARC: i64 = 610_366_051; // b"$arc" — actual Hancom clipboard, clipboard-fidelity-20261031/theirs.json
const RC_COL: i64 = 610_496_364; // b"$col" connector
const RC_CON: i64 = 610_496_366; // b"$con" container
const RC_CUR: i64 = 610_497_906; // b"$cur" curve
const E_CONNECTTYPE: [&str; 9] = ["STRAIGHT_NOARROW", "STRAIGHT_ONEWAY", "STRAIGHT_BOTH",
    "STROKE_NOARROW", "STROKE_ONEWAY", "STROKE_BOTH", "ARC_NOARROW", "ARC_ONEWAY", "ARC_BOTH"];
const E_ARC_TYPE: [&str; 3] = ["NORMAL", "PIE", "CHORD"];
const CI_EQED: i64 = 1_701_930_340; // b"eqed"

const LANGS: [&str; 7] = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];

/// 선 종류 이름 → 한글 코드. 🔴 HWPX 의 DASH/DOT 은 한글 코드와 이름이 뒤바뀌어 있다
/// (DASH=3 점선, DOT=2 파선 — 한글 2022 표본의 탭 채움 DASH→3, rhwp 파서 주석과 일치).
/// 테두리·밑줄·취소선·도형 선·단 구분선·주석선·탭 채움에 같은 규칙을 쓴다.
fn line_code(v: &str) -> i64 {
    match v {
        "NONE" | "" => 0,
        "SOLID" => 1,
        "DOT" => 2,
        "DASH" => 3,
        "DASH_DOT" => 4,
        "DASH_DOT_DOT" => 5,
        "LONG_DASH" => 6,
        "CIRCLE" => 7,
        "DOUBLE_SLIM" | "DOUBLE" | "DOUBLE_LINE" => 8,
        "SLIM_THICK" | "THIN_THICK" => 9,
        "THICK_SLIM" | "THICK_THIN" => 10,
        "SLIM_THICK_SLIM" | "TRIM" => 11,
        "WAVE" => 12,
        "DOUBLE_WAVE" => 13,
        "THICK_3D" | "THICK3D" => 14,
        "THICK_3D_REVERSE" | "THICK_3D_INSET" | "THICKREV3D" => 15,
        "3D" => 16,
        "3D_REVERSE" | "3D_INSET" | "REV3D" => 17,
        other => other.parse::<i64>().unwrap_or(0),
    }
}

fn al(n: Node, k: &str, d: i64) -> i64 {
    match n.attribute(k) {
        Some(v) => line_code(v),
        None => d,
    }
}

const SYM_MARK: [&str; 17] = [
    "NONE", "DOT_ABOVE", "RING_ABOVE", "TILDE", "CARON", "SIDE", "COLON", "GRAVE", "ACUTE",
    "CIRCUMFLEX", "MACRON", "HOOK_ABOVE", "DOT_BELOW", "COMMA_ABOVE", "REVERSED_COMMA_ABOVE",
    "DOUBLE_GRAVE", "BREVE",
];
const UNDERLINE_TYPE: [&str; 4] = ["NONE", "BOTTOM", "CENTER", "TOP"];
const SHADOW_TYPE: [&str; 3] = ["NONE", "DROP", "CONTINUOUS"];
const LINE_WIDTH: [&str; 16] = [
    "0.1 mm", "0.12 mm", "0.15 mm", "0.2 mm", "0.25 mm", "0.3 mm", "0.4 mm", "0.5 mm", "0.6 mm",
    "0.7 mm", "1.0 mm", "1.5 mm", "2.0 mm", "3.0 mm", "4.0 mm", "5.0 mm",
];
const HATCH_STYLE: [&str; 6] = ["HORIZONTAL", "VERTICAL", "BACK_SLASH", "SLASH", "CROSS", "CROSS_DIAGONAL"];
const SLASH_TYPE: [&str; 5] =["NONE", "CENTER", "CENTER_BELOW", "CENTER_ABOVE", "ALL"];
const CENTER_LINE: [&str; 4] = ["NONE", "CROSS", "VERTICAL", "HORIZONTAL"];
const ALIGN_H: [&str; 6] = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"];
const ALIGN_V: [&str; 4] = ["BASELINE", "TOP", "CENTER", "BOTTOM"];
const HEADING_TYPE: [&str; 4] = ["NONE", "OUTLINE", "NUMBER", "BULLET"];
const BREAK_LATIN: [&str; 3] = ["KEEP_WORD", "HYPHENATION", "BREAK_WORD"];
const LINE_WRAP: [&str; 3] = ["BREAK", "SQUEEZE", "KEEP"];
const LINESPACING_TYPE: [&str; 4] = ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"];
const TAB_TYPE: [&str; 4] = ["LEFT", "RIGHT", "CENTER", "DECIMAL"];
const NUM_FORMAT: [&str; 17] = [
    "DIGIT", "CIRCLED_DIGIT", "ROMAN_CAPITAL", "ROMAN_SMALL", "LATIN_CAPITAL", "LATIN_SMALL",
    "CIRCLED_LATIN_CAPITAL", "CIRCLED_LATIN_SMALL", "HANGUL_SYLLABLE", "CIRCLED_HANGUL_SYLLABLE",
    "HANGUL_JAMO", "CIRCLED_HANGUL_JAMO", "HANGUL_PHONETIC", "IDEOGRAPH", "CIRCLED_IDEOGRAPH",
    "DECAGON_CIRCLE", "DECAGON_CIRCLE_HANJA",
];
const PARA_HEAD_ALIGN: [&str; 3] = ["LEFT", "CENTER", "RIGHT"];
const TEXT_OFFSET: [&str; 2] = ["PERCENT", "HWPUNIT"];

const E_NUMBERING: [&str; 4] = ["NONE", "PICTURE", "TABLE", "EQUATION"];
const E_TEXTWRAP: [&str; 4] = ["SQUARE", "TOP_AND_BOTTOM", "BEHIND_TEXT", "IN_FRONT_OF_TEXT"];
const E_TEXTFLOW: [&str; 4] = ["BOTH_SIDES", "LEFT_ONLY", "RIGHT_ONLY", "LARGEST_ONLY"];
const E_WREL: [&str; 5] = ["PAPER", "PAGE", "COLUMN", "PARA", "ABSOLUTE"];
const E_HREL: [&str; 3] = ["PAPER", "PAGE", "ABSOLUTE"];
const E_VRELTO: [&str; 3] = ["PAPER", "PAGE", "PARA"];
const E_HRELTO: [&str; 4] = ["PAPER", "PAGE", "COLUMN", "PARA"];
const E_VALIGN: [&str; 5] = ["TOP", "CENTER", "BOTTOM", "INSIDE", "OUTSIDE"];
const E_HALIGN: [&str; 5] = ["LEFT", "CENTER", "RIGHT", "INSIDE", "OUTSIDE"];
const E_TEXTDIR: [&str; 2] = ["HORIZONTAL", "VERTICAL"];
const E_TBLBREAK: [&str; 3] = ["NONE", "TABLE", "CELL"];
const E_IMGEFFECT: [&str; 4] = ["REAL_PIC", "GRAY_SCALE", "BLACK_WHITE", "PATTERN8x8"];
const E_PAGENUMPOS: [&str; 11] = [
    "NONE", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER",
    "BOTTOM_RIGHT", "OUTSIDE_TOP", "OUTSIDE_BOTTOM", "INSIDE_TOP", "INSIDE_BOTTOM",
];
const E_NOTENUM: [&str; 3] = ["CONTINUOUS", "ON_SECTION", "ON_PAGE"];
const E_FN_PLACE: [&str; 3] = ["EACH_COLUMN", "MERGED_COLUMN", "RIGHT_MOST_COLUMN"];
const E_EN_PLACE: [&str; 2] = ["END_OF_DOCUMENT", "END_OF_SECTION"];
const E_ENDCAP: [&str; 3] = ["ROUND", "FLAT", "SQUARE"];
const E_ARROW: [&str; 7] = [
    "NORMAL", "ARROW", "SPEAR", "CONCAVE_ARROW", "EMPTY_DIAMOND", "EMPTY_CIRCLE", "EMPTY_BOX",
];
const E_ARROWSZ: [&str; 9] = [
    "SMALL_SMALL", "SMALL_MEDIUM", "SMALL_LARGE", "MEDIUM_SMALL", "MEDIUM_MEDIUM",
    "MEDIUM_LARGE", "LARGE_SMALL", "LARGE_MEDIUM", "LARGE_LARGE",
];
const E_OUTLINE: [&str; 3] = ["NORMAL", "OUTER", "INNER"];
const E_SHADOW: [&str; 5] = ["NONE", "LEFT_TOP", "RIGHT_TOP", "LEFT_BOTTOM", "RIGHT_BOTTOM"];
const E_GUTTER: [&str; 3] = ["LEFT_ONLY", "LEFT_RIGHT", "TOP_BOTTOM"];
const E_PAGESTART: [&str; 3] = ["BOTH", "EVEN", "ODD"];
const E_PBF_TYPE: [&str; 3] = ["BOTH", "EVEN", "ODD"];
const E_FILLAREA: [&str; 3] = ["PAPER", "PAGE", "BORDER"];
const E_COLTYPE: [&str; 3] = ["NEWSPAPER", "BALANCED_NEWSPAPER", "PARALLEL"];
const E_COLLAYOUT: [&str; 3] = ["LEFT", "RIGHT", "MIRROR"];
const E_NUMTYPE: [&str; 7] = ["PAGE", "FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION", "TOTAL_PAGE"];
const E_CAPTION_SIDE: [&str; 4] = ["LEFT", "RIGHT", "TOP", "BOTTOM"];

// ---------------------------------------------------------------- XML 읽기 도우미

fn local<'a>(n: Node<'a, '_>) -> &'a str {
    n.tag_name().name()
}

fn attr<'a>(n: Node<'a, '_>, k: &str) -> &'a str {
    n.attribute(k).unwrap_or("")
}

/// 정수 속성. HWPX 는 음수를 uint32 로 적기도 한다(`vertOffset="4294967056"` = -240) —
/// 한글 모델은 int32 이므로 2^31 이상은 부호 있는 값으로 되돌린다. 범위 밖 값은 한글을 죽인다(실측).
fn ai(n: Node, k: &str, d: i64) -> i64 {
    match n.attribute(k) {
        Some(v) => v.trim().parse::<i64>().ok()
            .or_else(|| v.trim().parse::<f64>().ok().map(|f| f as i64))
            .map(|x| if (0x8000_0000..=0xFFFF_FFFF).contains(&x) { x - 0x1_0000_0000 } else { x })
            .unwrap_or(d),
        None => d,
    }
}

fn ab(n: Node, k: &str) -> bool {
    matches!(n.attribute(k), Some("1") | Some("true") | Some("TRUE"))
}

/// 표 안 위치. 표에 없는 이름이 숫자면 그 숫자, 아니면 0.
fn en(table: &[&str], v: &str) -> i64 {
    if let Some(p) = table.iter().position(|t| t.eq_ignore_ascii_case(v)) {
        return p as i64;
    }
    v.parse::<i64>().unwrap_or(0)
}

fn ae(n: Node, k: &str, table: &[&str], d: i64) -> i64 {
    match n.attribute(k) {
        Some(v) if !v.is_empty() => en(table, v),
        _ => d,
    }
}

/// HWPX 색 → COLORREF(`0x00BBGGRR`). `none` → 0xFFFFFFFF. 8자리는 정방향처럼 그대로 담는다.
fn color(v: &str) -> i64 {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("none") {
        return 0xFFFF_FFFF;
    }
    let h = t.trim_start_matches('#');
    match h.len() {
        6 => {
            let n = i64::from_str_radix(h, 16).unwrap_or(0);
            let (r, g, bl) = ((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF);
            (bl << 16) | (g << 8) | r
        }
        8 => i64::from_str_radix(h, 16).unwrap_or(0),
        _ => 0,
    }
}

fn ac(n: Node, k: &str, d: i64) -> i64 {
    match n.attribute(k) {
        Some(v) => color(v),
        None => d,
    }
}

/// HWPX 는 부호 없는 uint32, JSON 은 부호 있는 int32.
fn i32v(v: i64) -> i64 {
    (v as u32) as i32 as i64
}

/// `hp:switch` 는 `hp:default`(없으면 첫 `hp:case`) 쪽으로 펼친 자식 요소들.
fn elems<'a, 'i>(n: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    let mut out = Vec::new();
    for c in n.children().filter(|c| c.is_element()) {
        if local(c) == "switch" {
            let pick = c.children().find(|x| x.is_element() && local(*x) == "default")
                .or_else(|| c.children().find(|x| x.is_element() && local(*x) == "case"));
            if let Some(p) = pick {
                out.extend(elems(p));
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    elems(n).into_iter().find(|c| local(*c) == name)
}

fn children<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Vec<Node<'a, 'i>> {
    elems(n).into_iter().filter(|c| local(*c) == name).collect()
}

// ---------------------------------------------------------------- 입력

/// 변환 입력. `bins` 는 manifest id(`image1`) → (MIME, 확장자, 바이트).
pub struct HwpxFragment<'a> {
    pub header_xml: &'a str,
    pub section_xml: &'a str,
    pub bins: HashMap<String, (String, String, Vec<u8>)>,
    /// 바탕쪽 XML (content.hpf 항목 id → masterpage*.xml). 구역 전체 복사에서 구역 정의와 함께 싣는다.
    pub master_pages: HashMap<String, String>,
    /// 복사가 구역 전체인지. 구역·단 정의는 한글처럼 언제나 싣되, 참이면 원본 구역 정의(바탕쪽·메모 모양·
    /// 개요 번호 참조 포함)를, 거짓이면 한글 부분 복사처럼 '새 문서' 기본 구역 정의를 싣는다.
    pub section_start: bool,
    /// GUID 접두 — 붙여넣기마다 다른 값을 주면 한글 쪽 키가 겹치지 않는다.
    pub seed: u64,
}

/// 변환 결과.
pub struct HwpJsonExport {
    pub json: String,
    /// 이 변환기가 아직 옮기지 못해 빠진 요소 이름(중복 없음).
    pub skipped: Vec<String>,
}

/// [hwpx-cowork] 구역 XML `first` 의 뿌리 요소 끝에 `next` 의 뿌리 요소 안쪽(문단들)을 잇는다.
fn append_section_body(first: &[u8], next: &[u8]) -> Vec<u8> {
    let inner = |x: &[u8]| -> Option<(usize, usize)> {
        let mut at = 0;
        // XML 선언·주석을 건너 첫 요소(뿌리)의 여는 태그 끝
        loop {
            let lt = at + x[at..].iter().position(|&b| b == b'<')?;
            let gt = lt + x[lt..].iter().position(|&b| b == b'>')?;
            if !matches!(x.get(lt + 1), Some(b'?') | Some(b'!')) {
                let close = x.iter().rposition(|&b| b == b'<')?;
                return (gt < close).then_some((gt + 1, close));
            }
            at = gt + 1;
        }
    };
    let (Some((_, first_close)), Some((from, to))) = (inner(first), inner(next)) else {
        return first.to_vec();
    };
    let mut out = Vec::with_capacity(first.len() + (to - from));
    out.extend_from_slice(&first[..first_close]);
    out.extend_from_slice(&next[from..to]);
    out.extend_from_slice(&first[first_close..]);
    out
}

/// HWPX 패키지 바이트(zip) → 변환 입력 조각.
#[allow(clippy::type_complexity)]
pub fn read_hwpx_package(bytes: &[u8]) -> Result<(String, String, HashMap<String, (String, String, Vec<u8>)>, HashMap<String, String>), HwpError> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| HwpError::InvalidFile(format!("HWPX 조각을 열지 못했습니다: {e}")))?;
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let mut f = zip.by_name(name).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let header = read("Contents/header.xml")
        .ok_or_else(|| HwpError::InvalidFile("header.xml 이 없습니다".to_string()))?;
    let mut section = read("Contents/section0.xml")
        .ok_or_else(|| HwpError::InvalidFile("section0.xml 이 없습니다".to_string()))?;
    // [hwpx-cowork] 구역이 여럿인 조각(구역을 넘는 복사)은 뒤 구역 문단을 첫 구역 뒤에 잇는다 — 한글 문서모델은 문단 사슬
    // 하나에 구역 나누기 문단(구역·단 정의)을 끼운 꼴이다(한/글 자체 복사 실측)
    for k in 1.. {
        let Some(next) = read(&format!("Contents/section{k}.xml")) else { break };
        section = append_section_body(&section, &next);
    }
    let hpf = read("Contents/content.hpf").unwrap_or_default();
    let hpf = String::from_utf8_lossy(&hpf).to_string();
    let mut items: Vec<(String, String, String)> = Vec::new();
    let mut master_items: Vec<(String, String)> = Vec::new();
    if let Ok(doc) = roxmltree::Document::parse(&hpf) {
        for n in doc.descendants().filter(|n| n.is_element() && local(*n) == "item") {
            let href = attr(n, "href");
            if href.starts_with("BinData/") {
                items.push((attr(n, "id").to_string(), href.to_string(), attr(n, "media-type").to_string()));
            } else if href.starts_with("Contents/masterpage") {
                master_items.push((attr(n, "id").to_string(), href.to_string()));
            }
        }
    }
    let mut masters = HashMap::new();
    for (id, href) in master_items {
        if let Some(data) = read(&href) {
            masters.insert(id, String::from_utf8_lossy(&data).to_string());
        }
    }
    let mut bins = HashMap::new();
    for (id, href, mime) in items {
        if let Some(data) = read(&href) {
            let ext = href.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "png".to_string());
            let mime = if mime.is_empty() { format!("image/{ext}") } else { mime };
            bins.insert(id, (mime, ext, data));
        }
    }
    Ok((
        String::from_utf8_lossy(&header).to_string(),
        String::from_utf8_lossy(&section).to_string(),
        bins,
        masters,
    ))
}

// ---------------------------------------------------------------- 머리(header.xml) 색인

#[derive(Default)]
struct Header<'a, 'i> {
    fonts: Vec<HashMap<i64, (String, i64)>>,
    bf: BTreeMap<i64, Node<'a, 'i>>,
    cp: BTreeMap<i64, Node<'a, 'i>>,
    tp: BTreeMap<i64, Node<'a, 'i>>,
    nu: BTreeMap<i64, Node<'a, 'i>>,
    bu: BTreeMap<i64, Node<'a, 'i>>,
    pp: BTreeMap<i64, Node<'a, 'i>>,
    st: BTreeMap<i64, Node<'a, 'i>>,
    mp: BTreeMap<i64, Node<'a, 'i>>,
}

fn index_header<'a, 'i>(root: Node<'a, 'i>) -> Header<'a, 'i> {
    let mut h = Header { fonts: vec![HashMap::new(); 7], ..Default::default() };
    for n in root.descendants().filter(|n| n.is_element()) {
        let id = ai(n, "id", -1);
        match local(n) {
            "fontface" => {
                let lang = LANGS.iter().position(|l| *l == attr(n, "lang"));
                if let Some(li) = lang {
                    for f in n.children().filter(|c| c.is_element() && local(*c) == "font") {
                        let ty = if attr(f, "type") == "HFT" { 2 } else { 1 };
                        h.fonts[li].insert(ai(f, "id", 0), (attr(f, "face").to_string(), ty));
                    }
                }
            }
            "borderFill" => { h.bf.insert(id, n); }
            "charPr" => { h.cp.insert(id, n); }
            "tabPr" => { h.tp.insert(id, n); }
            "numbering" => { h.nu.insert(id, n); }
            "bullet" => { h.bu.insert(id, n); }
            "paraPr" => { h.pp.insert(id, n); }
            "style" => { h.st.insert(id, n); }
            "memoPr" => { h.mp.insert(id, n); }
            _ => {}
        }
    }
    h
}

// ---------------------------------------------------------------- 변환 문맥

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
enum Tbl { Bf, Cp, Tp, Nu, Bu, Pp, St, Mp }

struct Ctx<'a, 'i> {
    h: Header<'a, 'i>,
    prefix: String,
    counter: u32,
    /// (표, 원본 id) → GUID
    refs: BTreeMap<(Tbl, i64), String>,
    /// 아직 본문을 만들지 않은 참조
    pending: Vec<(Tbl, i64)>,
    sl: Vec<(String, J)>,
    cs: Vec<(String, J)>,
    sl_seq: i64,
    bi: Vec<J>,
    bidt: Vec<(String, J)>,
    bin_names: HashMap<String, String>,
    bins: HashMap<String, (String, String, Vec<u8>)>,
    skipped: Vec<String>,
    section_start: bool,
    /// fieldBegin id → (시작 컨트롤 GUID, zorder, ci). 필드는 문단을 넘어 끝날 수 있다(차례).
    fields: HashMap<String, (String, i64, i64)>,
    /// 조각 안 모든 fieldEnd 의 beginIDRef — 끝이 없는 필드는 싣지 않는다
    all_ends: std::collections::HashSet<String>,
    /// 지금 문단(직속 run)의 fieldEnd beginIDRef — 메모는 같은 문단에서 닫혀야 한글이 받는다
    para_ends: std::collections::HashSet<String>,
    /// 부분 복사의 첫 단 정의를 기본값으로 바꿀 차례인지
    default_cold_pending: bool,
    /// 원본 머리에 없는 합성 서식 항목(기본 구역의 쪽 테두리 등)
    synth: Vec<(Tbl, String, J)>,
    /// zorder 없는 메모에 매길 순번
    memo_seq: i64,
    /// 바탕쪽 XML (항목 id → XML)
    masters: HashMap<String, String>,
    /// 바탕쪽 목록을 쓰는 중인지 — 그 안의 개체는 rc.in.ma 가 참이다(한글 표본)
    in_master: bool,
}

impl<'a, 'i> Ctx<'a, 'i> {
    fn guid(&mut self) -> String {
        self.counter += 1;
        format!("{}{:08X}", self.prefix, self.counter)
    }

    fn skip(&mut self, what: &str) {
        if !self.skipped.iter().any(|s| s == what) {
            self.skipped.push(what.to_string());
        }
    }

    /// 서식 항목 참조 → GUID. 없는 id 는 빈 문자열(한글 표본의 '참조 없음').
    fn r(&mut self, t: Tbl, id: i64) -> String {
        let exists = match t {
            Tbl::Bf => self.h.bf.contains_key(&id),
            Tbl::Cp => self.h.cp.contains_key(&id),
            Tbl::Tp => self.h.tp.contains_key(&id),
            Tbl::Nu => self.h.nu.contains_key(&id),
            Tbl::Bu => self.h.bu.contains_key(&id),
            Tbl::Pp => self.h.pp.contains_key(&id),
            Tbl::St => self.h.st.contains_key(&id),
            Tbl::Mp => self.h.mp.contains_key(&id),
        };
        if !exists {
            return String::new();
        }
        if let Some(g) = self.refs.get(&(t, id)) {
            return g.clone();
        }
        let g = self.guid();
        self.refs.insert((t, id), g.clone());
        self.pending.push((t, id));
        g
    }

    fn ra(&mut self, t: Tbl, n: Node, k: &str) -> String {
        match n.attribute(k).and_then(|v| v.parse::<i64>().ok()) {
            Some(id) => self.r(t, id),
            None => String::new(),
        }
    }

    fn next_sl_id(&mut self) -> i64 {
        self.sl_seq += 1;
        self.sl_seq
    }
}

// ---------------------------------------------------------------- 서식 항목

/// `hc:fillBrush/hc:winBrush` → `{wb:{fc,hc,al,hs}}`. 무늬 없음은 hs=-1(한글 표본).
fn fill_brush(fb: Option<Node>) -> J {
    let mut fi = J::obj();
    if let Some(wb) = fb.and_then(|f| child(f, "winBrush")) {
        let hs = match wb.attribute("hatchStyle") {
            Some(v) if !v.is_empty() && v != "NONE" => en(&HATCH_STYLE, v),
            _ => -1,
        };
        fi.set("wb", J::obj()
            .with("fc", i(ac(wb, "faceColor", 0xFFFF_FFFF)))
            .with("hc", i(ac(wb, "hatchColor", 0)))
            .with("al", i(ai(wb, "alpha", 0)))
            .with("hs", i(hs)));
    }
    fi
}

fn emit_bf(n: Node) -> J {
    let line = |name: &str| -> (i64, i64, i64) {
        match child(n, name) {
            Some(l) => (
                al(l, "type", 0),
                LINE_WIDTH.iter().position(|w| *w == attr(l, "width")).map_or(0, |p| p as i64),
                ac(l, "color", 0),
            ),
            None => (0, 0, 0),
        }
    };
    let slash = child(n, "slash");
    let back = child(n, "backSlash");
    let (lt, lw, lc) = line("leftBorder");
    let (rt, rw, rc) = line("rightBorder");
    let (tt, tw, tc) = line("topBorder");
    let (bbt, bbw, bbc) = line("bottomBorder");
    let (dt, dw, dc) = line("diagonal");
    let fi = fill_brush(child(n, "fillBrush"));
    J::obj()
        .with("td", b(ab(n, "threeD")))
        .with("sh", b(ab(n, "shadow")))
        .with("st", i(slash.map_or(0, |x| ae(x, "type", &SLASH_TYPE, 0))))
        .with("sc", i(slash.map_or(0, |x| i64::from(ab(x, "Crooked")))))
        .with("si", b(slash.is_some_and(|x| ab(x, "isCounter"))))
        .with("bt", i(back.map_or(0, |x| ae(x, "type", &SLASH_TYPE, 0))))
        .with("bi", b(back.is_some_and(|x| ab(x, "isCounter"))))
        .with("cl", i(ae(n, "centerLine", &CENTER_LINE, 0)))
        .with("bc", b(ab(n, "breakCellSeparateLine")))
        .with("lt", i(lt)).with("lw", i(lw)).with("lc", i(lc))
        .with("rt", i(rt)).with("rw", i(rw)).with("rc", i(rc))
        .with("tt", i(tt)).with("tw", i(tw)).with("tc", i(tc))
        .with("bbt", i(bbt)).with("bbw", i(bbw)).with("bbc", i(bbc))
        .with("dt", i(dt)).with("dw", i(dw)).with("dc", i(dc))
        .with("fi", fi)
}

fn lang_vals(n: Option<Node>, d: i64) -> Vec<i64> {
    let names = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
    names.iter().map(|k| n.map_or(d, |x| ai(x, k, d))).collect()
}

fn emit_cp(cx: &mut Ctx, n: Node) -> J {
    let mut o = J::obj()
        .with("he", i(ai(n, "height", 1000)))
        .with("tc", i(ac(n, "textColor", 0)))
        .with("sc", i(ac(n, "shadeColor", 0xFFFF_FFFF)))
        .with("uf", b(ab(n, "useFontSpace")))
        .with("uk", b(ab(n, "useKerning")))
        .with("sm", i(ae(n, "symMark", &SYM_MARK, 0)));
    let bf = cx.ra(Tbl::Bf, n, "borderFillIDRef");
    o.set("bf", s(&bf));
    let font_ref = child(n, "fontRef");
    let ids = lang_vals(font_ref, 0);
    for (li, fid) in ids.iter().enumerate() {
        let (face, ty) = cx.h.fonts.get(li).and_then(|m| m.get(fid)).cloned()
            .unwrap_or_else(|| ("함초롬바탕".to_string(), 1));
        o.set(&format!("f{}", li + 1), J::Str(face));
        o.set(&format!("t{}", li + 1), i(ty));
    }
    for (tag, key, d) in [("ratio", "r", 100), ("spacing", "s", 0), ("relSz", "e", 100), ("offset", "o", 0)] {
        for (li, v) in lang_vals(child(n, tag), d).iter().enumerate() {
            o.set(&format!("{key}{}", li + 1), i(*v));
        }
    }
    o.set("it", b(child(n, "italic").is_some()));
    o.set("bo", b(child(n, "bold").is_some()));
    // 선이 꺼져 있을 때 색 'none' 은 한글 클립보드가 0(검정)으로 싣고, 켜져 있으면 그대로 둔다(표본 실측)
    let line_color = |x: Node, on: bool| -> i64 {
        match ac(x, "color", 0) {
            0xFFFF_FFFF if !on => 0,
            c => c,
        }
    };
    let ul = child(n, "underline");
    let ut = ul.map_or(0, |u| ae(u, "type", &UNDERLINE_TYPE, 0));
    o.set("ut", i(ut));
    o.set("us", i(ul.map_or(1, |u| al(u, "shape", 1))));
    o.set("uc", i(ul.map_or(0, |u| line_color(u, ut != 0))));
    let so = child(n, "strikeout");
    let ss = so.map_or(0, |x| al(x, "shape", 0));
    o.set("st", b(ss != 0));
    o.set("ss", i(if ss == 0 { 1 } else { ss }));
    o.set("so", i(so.map_or(0, |x| line_color(x, ss != 0))));
    o.set("ot", i(child(n, "outline").map_or(0, |x| al(x, "type", 0))));
    let sh = child(n, "shadow");
    let ht = sh.map_or(0, |x| ae(x, "type", &SHADOW_TYPE, 0));
    // 그림자가 꺼져 있으면 한글 클립보드는 색·오프셋을 0 으로 지운다(정방향 주석 참조)
    let (hc, hx, hy) = match sh {
        Some(x) if ht != 0 => (ac(x, "color", 0), ai(x, "offsetX", 0), ai(x, "offsetY", 0)),
        _ => (0, 0, 0),
    };
    o.set("ht", i(ht));
    o.set("hc", i(hc));
    o.set("hx", i(hx));
    o.set("hy", i(hy));
    o.set("em", b(child(n, "emboss").is_some()));
    o.set("en", b(child(n, "engrave").is_some()));
    o.set("su", b(child(n, "supscript").is_some()));
    o.set("sb", b(child(n, "subscript").is_some()));
    o
}

fn emit_tp(n: Node) -> J {
    let items: Vec<J> = children(n, "tabItem").into_iter().map(|t| {
        J::obj()
            .with("po", i(ai(t, "pos", 0)))
            .with("ty", i(ae(t, "type", &TAB_TYPE, 0)))
            .with("le", i(al(t, "leader", 0)))
    }).collect();
    J::obj()
        .with("al", b(ab(n, "autoTabLeft")))
        .with("ar", b(ab(n, "autoTabRight")))
        .with("tp", J::Arr(items))
}

fn emit_para_head(cx: &mut Ctx, ph: Node, numbering: bool) -> J {
    let cp_raw = ai(ph, "charPrIDRef", 0xFFFF_FFFF);
    let cp = if cp_raw == 0xFFFF_FFFF || cp_raw < 0 { String::new() } else { cx.r(Tbl::Cp, cp_raw) };
    let mut o = J::obj()
        .with("le", i(ai(ph, "level", 0)))
        .with("al", i(ae(ph, "align", &PARA_HEAD_ALIGN, 0)))
        .with("ui", b(ab(ph, "useInstWidth")))
        .with("ai", b(ab(ph, "autoIndent")))
        .with("wa", i(ai(ph, "widthAdjust", 0)))
        .with("tt", i(ae(ph, "textOffsetType", &TEXT_OFFSET, 0)))
        .with("to", i(ai(ph, "textOffset", 50)))
        .with("cp", J::Str(cp));
    if numbering {
        o.set("uf", i(ae(ph, "numFormat", &NUM_FORMAT, 0)));
        o.set("st", i(ai(ph, "start", 1)));
        o.set("sf", J::Str(ph.text().unwrap_or("").to_string()));
    }
    o
}

fn emit_nu(cx: &mut Ctx, n: Node) -> J {
    let heads: Vec<J> = children(n, "paraHead").into_iter().map(|ph| emit_para_head(cx, ph, true)).collect();
    J::obj().with("sn", i(ai(n, "start", 0))).with("ph", J::Arr(heads))
}

fn emit_bu(cx: &mut Ctx, n: Node) -> J {
    let ph = child(n, "paraHead").map(|p| emit_para_head(cx, p, false)).unwrap_or_else(J::obj);
    J::obj()
        .with("ch", s(attr(n, "char")))
        .with("ui", b(ab(n, "useImage")))
        .with("im", J::obj())
        .with("ph", ph)
}

fn emit_pp(cx: &mut Ctx, n: Node) -> J {
    let align = child(n, "align");
    let heading = child(n, "heading");
    let ht = heading.map_or(0, |h| ae(h, "type", &HEADING_TYPE, 0));
    let head_id = heading.map_or(0, |h| ai(h, "idRef", 0));
    let hi = match ht {
        3 => cx.r(Tbl::Bu, head_id),
        2 => cx.r(Tbl::Nu, head_id),
        _ => String::new(),
    };
    let tp = cx.ra(Tbl::Tp, n, "tabPrIDRef");
    let bs = child(n, "breakSetting");
    let sp = child(n, "autoSpacing");
    let margin = child(n, "margin");
    let mv = |k: &str| margin.and_then(|m| child(m, k)).map_or(0, |x| ai(x, "value", 0));
    let ls = child(n, "lineSpacing");
    let border = child(n, "border");
    let bf = border.map_or(String::new(), |x| cx.ra(Tbl::Bf, x, "borderFillIDRef"));
    J::obj()
        .with("ah", i(align.map_or(0, |a| ae(a, "horizontal", &ALIGN_H, 0))))
        .with("av", i(align.map_or(0, |a| ae(a, "vertical", &ALIGN_V, 0))))
        .with("ht", i(ht))
        .with("hi", J::Str(hi))
        .with("hl", i(heading.map_or(0, |h| ai(h, "level", 0))))
        .with("tp", J::Str(tp))
        .with("kb", i(bs.map_or(0, |x| ae(x, "breakLatinWord", &BREAK_LATIN, 0))))
        .with("kn", b(bs.is_some_and(|x| attr(x, "breakNonLatinWord") == "KEEP_WORD")))
        .with("ko", b(bs.is_some_and(|x| ab(x, "widowOrphan"))))
        .with("kk", b(bs.is_some_and(|x| ab(x, "keepWithNext"))))
        .with("kl", b(bs.is_some_and(|x| ab(x, "keepLines"))))
        .with("kp", b(bs.is_some_and(|x| ab(x, "pageBreakBefore"))))
        .with("kw", i(bs.map_or(0, |x| ae(x, "lineWrap", &LINE_WRAP, 0))))
        .with("co", i(ai(n, "condense", 0)))
        .with("fl", b(ab(n, "fontLineHeight")))
        .with("st", b(ab(n, "snapToGrid")))
        .with("sl", b(ab(n, "suppressLineNumbers")))
        .with("ae", b(sp.is_some_and(|x| ab(x, "eAsianEng"))))
        .with("aa", b(sp.is_some_and(|x| ab(x, "eAsianNum"))))
        .with("mi", i(mv("intent")))
        .with("ml", i(mv("left")))
        .with("mr", i(mv("right")))
        .with("mp", i(mv("prev")))
        .with("mn", i(mv("next")))
        .with("lt", i(ls.map_or(0, |x| ae(x, "type", &LINESPACING_TYPE, 0))))
        .with("lv", i(ls.map_or(160, |x| ai(x, "value", 160))))
        .with("bf", J::Str(bf))
        .with("bl", i(border.map_or(0, |x| ai(x, "offsetLeft", 0))))
        .with("br", i(border.map_or(0, |x| ai(x, "offsetRight", 0))))
        .with("bt", i(border.map_or(0, |x| ai(x, "offsetTop", 0))))
        .with("bb", i(border.map_or(0, |x| ai(x, "offsetBottom", 0))))
        .with("bc", b(border.is_some_and(|x| ab(x, "connect"))))
        .with("bi", b(border.is_some_and(|x| ab(x, "ignoreMargin"))))
}

fn emit_st(cx: &mut Ctx, n: Node) -> J {
    let pp = cx.ra(Tbl::Pp, n, "paraPrIDRef");
    let cp = cx.ra(Tbl::Cp, n, "charPrIDRef");
    let ns = cx.ra(Tbl::St, n, "nextStyleIDRef");
    J::obj()
        .with("ty", i(if attr(n, "type") == "CHAR" { 1 } else { 0 }))
        .with("na", s(attr(n, "name")))
        .with("en", s(attr(n, "engName")))
        .with("pp", J::Str(pp))
        .with("cp", J::Str(cp))
        .with("ns", J::Str(ns))
        .with("li", i(ai(n, "langID", 1042)))
        .with("lf", b(ab(n, "lockForm")))
}

fn emit_mp(n: Node) -> J {
    J::obj()
        .with("wi", i(ai(n, "width", 15591)))
        .with("lw", i(ai(n, "lineWidth", 1)))
        .with("lt", i(1))
        .with("lc", i(ac(n, "lineColor", 0)))
        .with("fc", i(ac(n, "fillColor", 0x99FF_CC)))
        .with("ac", i(ac(n, "activeColor", 0x99FF_FF)))
        .with("mt", i(0))
}

/// 참조된 서식 항목을 모두 만든다(만들면서 새 참조가 생기므로 고정점까지 반복).
fn build_header_tables(cx: &mut Ctx) -> BTreeMap<Tbl, Vec<(i64, String, J)>> {
    let mut built: BTreeMap<Tbl, Vec<(i64, String, J)>> = BTreeMap::new();
    while let Some((t, id)) = cx.pending.pop() {
        let guid = cx.refs.get(&(t, id)).cloned().unwrap_or_default();
        let node = match t {
            Tbl::Bf => cx.h.bf.get(&id),
            Tbl::Cp => cx.h.cp.get(&id),
            Tbl::Tp => cx.h.tp.get(&id),
            Tbl::Nu => cx.h.nu.get(&id),
            Tbl::Bu => cx.h.bu.get(&id),
            Tbl::Pp => cx.h.pp.get(&id),
            Tbl::St => cx.h.st.get(&id),
            Tbl::Mp => cx.h.mp.get(&id),
        }.copied();
        let Some(n) = node else { continue };
        let v = match t {
            Tbl::Bf => emit_bf(n),
            Tbl::Cp => emit_cp(cx, n),
            Tbl::Tp => emit_tp(n),
            Tbl::Nu => emit_nu(cx, n),
            Tbl::Bu => emit_bu(cx, n),
            Tbl::Pp => emit_pp(cx, n),
            Tbl::St => emit_st(cx, n),
            Tbl::Mp => emit_mp(n),
        };
        built.entry(t).or_default().push((id, guid, v));
    }
    for (t, guid, v) in std::mem::take(&mut cx.synth) {
        built.entry(t).or_default().push((i64::MAX, guid, v));
    }
    // 한글 표본처럼 원본 순서대로 새 일련번호(id)를 매긴다. bf·nu·bu·mp 는 1부터.
    for (t, items) in built.iter_mut() {
        items.sort_by_key(|(id, _, _)| *id);
        let base = if matches!(t, Tbl::Bf | Tbl::Nu | Tbl::Bu | Tbl::Mp) { 1 } else { 0 };
        for (k, (_, _, v)) in items.iter_mut().enumerate() {
            let mut with_id = J::obj().with("id", i(base + k as i64));
            if let J::Obj(fields) = std::mem::replace(v, J::Null) {
                for (key, val) in fields {
                    with_id.set(&key, val);
                }
            }
            *v = with_id;
        }
    }
    built
}

// ---------------------------------------------------------------- 본문

fn emit_sz_pos(o: &mut J, n: Node) {
    if let Some(sz) = child(n, "sz") {
        o.set("swi", i(ai(sz, "width", 0)));
        o.set("she", i(ai(sz, "height", 0)));
        o.set("swr", i(ae(sz, "widthRelTo", &E_WREL, 4)));
        o.set("shr", i(ae(sz, "heightRelTo", &E_HREL, 2)));
        o.set("spr", b(ab(sz, "protect")));
    }
    if let Some(p) = child(n, "pos") {
        o.set("pta", b(ab(p, "treatAsChar")));
        o.set("pal", b(ab(p, "affectLSpacing")));
        o.set("pvr", i(ae(p, "vertRelTo", &E_VRELTO, 2)));
        o.set("phr", i(ae(p, "horzRelTo", &E_HRELTO, 3)));
        o.set("pva", i(ae(p, "vertAlign", &E_VALIGN, 0)));
        o.set("ph1", i(ae(p, "horzAlign", &E_HALIGN, 0)));
        o.set("pvo", i(ai(p, "vertOffset", 0)));
        o.set("ph2", i(ai(p, "horzOffset", 0)));
        o.set("pfw", b(ab(p, "flowWithText")));
        o.set("pao", b(ab(p, "allowOverlap")));
        o.set("pha", b(ab(p, "holdAnchorAndSO")));
    }
    let om = child(n, "outMargin");
    o.set("ole", i(om.map_or(0, |m| ai(m, "left", 0))));
    o.set("ori", i(om.map_or(0, |m| ai(m, "right", 0))));
    o.set("oto", i(om.map_or(0, |m| ai(m, "top", 0))));
    o.set("obo", i(om.map_or(0, |m| ai(m, "bottom", 0))));
}

/// 개체 id. 한글은 0x40000000~0x7FFFFFFF 를 쓰므로 그 밖의 값은 하위 30비트를 그 범위로 옮긴다.
/// 2^31 이상(보고서 생성기가 매긴 2147500001… 등)을 그대로 싣으면 음수가 되어 한글이 붙여넣다 죽는다(실측).
fn obj_id(n: Node) -> i64 {
    let id = ai(n, "id", 0) as u32;
    i64::from((id & 0x3FFF_FFFF) | 0x4000_0000)
}

/// 그림·도형의 인스턴스 id — 한글 표본은 언제나 `ii = id − 0x3FFFFFFF` 다.
/// 이 관계가 깨지면 한글이 붙여넣으며 회전·배율 행렬을 단위 행렬로 되돌린다(실측).
fn inst_id(n: Node) -> i64 {
    i32v(obj_id(n) - 0x3FFF_FFFF)
}

fn obj_head(n: Node, cc: i64, ci: i64) -> J {
    J::obj()
        .with("cc", i(cc))
        .with("ci", i(ci))
        .with("id", i(i32v(obj_id(n))))
        .with("zo", i(ai(n, "zOrder", 0)))
        .with("nt", i(ae(n, "numberingType", &E_NUMBERING, 0)))
        .with("tw", i(ae(n, "textWrap", &E_TEXTWRAP, 1)))
        .with("tf", i(ae(n, "textFlow", &E_TEXTFLOW, 0)))
        .with("lo", b(ab(n, "lock")))
}

/// 개체 설명. 한글 원문의 줄 끝은 `\r\r\n` 인데 XML 파서가 `\n\n` 으로 바꾸므로 되돌린다(표본).
fn shape_comment(n: Node) -> String {
    child(n, "shapeComment")
        .and_then(|c| c.text())
        .map(|t| t.replace("\n\n", "\u{0}").replace('\n', "\r\n").replace('\u{0}', "\r\r\n"))
        .unwrap_or_default()
}

/// `hp:subList` 머리 + 문단들 → sl 표. 반환: (머리 GUID, 머리 id)
fn emit_sublist(cx: &mut Ctx, owner: &str, sub: Node, extra: Vec<(&str, J)>) -> Result<(String, i64), HwpError> {
    let guid = cx.guid();
    let id = cx.next_sl_id();
    let pos = cx.sl.len();
    cx.sl.push((guid.clone(), J::Null));
    let paras: Vec<Node> = children(sub, "p");
    let first = emit_paragraph_list(cx, &paras, true)?;
    let mut head = J::obj()
        .with("co", s(owner))
        .with("id", i(id))
        .with("td", i(ae(sub, "textDirection", &E_TEXTDIR, 0)))
        .with("lw", i(ae(sub, "lineWrap", &LINE_WRAP, 0)))
        .with("va", i(ae(sub, "vertAlign", &E_VALIGN, 0)))
        .with("ll", s(match attr(sub, "linkListIDRef") { "0" | "" => "", v => v }))
        .with("ln", s(match attr(sub, "linkListNextIDRef") { "0" | "" => "", v => v }));
    for (k, v) in extra {
        head.set(k, v);
    }
    head.set("hp", J::Str(first));
    cx.sl[pos].1 = head;
    Ok((guid, id))
}

fn emit_caption(cx: &mut Ctx, owner: &str, obj: Node) -> Result<Option<J>, HwpError> {
    let Some(cap) = child(obj, "caption") else { return Ok(None) };
    let Some(sub) = child(cap, "subList") else { return Ok(None) };
    let ca = J::obj()
        .with("si", i(ae(cap, "side", &E_CAPTION_SIDE, 3)))
        .with("fs", b(ab(cap, "fullSz")))
        .with("wi", i(ai(cap, "width", 0)))
        .with("ga", i(ai(cap, "gap", 0)))
        .with("lw", i(-1));
    let (g, id) = emit_sublist(cx, owner, sub, vec![("ca", ca)])?;
    Ok(Some(J::obj().with("so", J::Str(g)).with("li", i(id))))
}

fn emit_tbl(cx: &mut Ctx, n: Node) -> Result<J, HwpError> {
    let guid = cx.guid();
    let pos = cx.cs.len();
    cx.cs.push((guid.clone(), J::Null));
    let mut o = obj_head(n, 11, CI_TBL);
    emit_sz_pos(&mut o, n);
    // 한글 표본 순서: 셀 머리 id 가 먼저, 캡션이 뒤
    let mut rows = Vec::new();
    for tr in children(n, "tr") {
        let mut cells = Vec::new();
        for tc in children(tr, "tc") {
            let Some(sub) = child(tc, "subList") else { continue };
            let addr = child(tc, "cellAddr");
            let span = child(tc, "cellSpan");
            let sz = child(tc, "cellSz");
            let mg = child(tc, "cellMargin");
            let bf = cx.ra(Tbl::Bf, tc, "borderFillIDRef");
            let tcj = J::obj()
                .with("he", b(ab(tc, "header")))
                .with("hm", b(ab(tc, "hasMargin")))
                .with("pr", b(ab(tc, "protect")))
                .with("ed", b(ab(tc, "editable")))
                .with("di", b(ab(tc, "dirty")))
                .with("bf", J::Str(bf))
                .with("ac", i(addr.map_or(0, |x| ai(x, "colAddr", 0))))
                .with("ar", i(addr.map_or(0, |x| ai(x, "rowAddr", 0))))
                .with("sc", i(span.map_or(1, |x| ai(x, "colSpan", 1))))
                .with("sr", i(span.map_or(1, |x| ai(x, "rowSpan", 1))))
                .with("sw", i(sz.map_or(0, |x| ai(x, "width", 0))))
                .with("sh", i(sz.map_or(0, |x| ai(x, "height", 0))))
                .with("ml", i(mg.map_or(0, |x| ai(x, "left", 0))))
                .with("mr", i(mg.map_or(0, |x| ai(x, "right", 0))))
                .with("mt", i(mg.map_or(0, |x| ai(x, "top", 0))))
                .with("mb", i(mg.map_or(0, |x| ai(x, "bottom", 0))));
            let (g, id) = emit_sublist(cx, &guid, sub, vec![("tc", tcj)])?;
            let mut cell = J::obj().with("so", J::Str(g)).with("li", i(id));
            let name = attr(tc, "name");
            if !name.is_empty() {
                cell.set("ps", J::obj().with("na", i(539)).with("pa", J::Arr(vec![
                    J::obj().with("na", i(16384)).with("ty", i(1)).with("va", s(name)),
                ])));
            }
            cells.push(cell);
        }
        rows.push(J::Arr(cells));
    }
    // 캡션이 없으면 한글은 빈 객체를 싣는다
    o.set("ca", emit_caption(cx, &guid, n)?.unwrap_or_else(J::obj));
    o.set("sc", J::Str(shape_comment(n)));
    let im = child(n, "inMargin");
    let bf = cx.ra(Tbl::Bf, n, "borderFillIDRef");
    o.set("pb", i(ae(n, "pageBreak", &E_TBLBREAK, 2)));
    o.set("rh", b(ab(n, "repeatHeader")));
    o.set("na", b(ab(n, "noAdjust")));
    o.set("ho", b(false));
    o.set("if", b(false));
    o.set("sa", b(false));
    o.set("rc", i(ai(n, "rowCnt", rows.len() as i64)));
    o.set("cco", i(ai(n, "colCnt", 0)));
    o.set("cs", i(ai(n, "cellSpacing", 0)));
    o.set("bf", J::Str(bf));
    o.set("ile", i(im.map_or(0, |m| ai(m, "left", 0))));
    o.set("iri", i(im.map_or(0, |m| ai(m, "right", 0))));
    o.set("ito", i(im.map_or(0, |m| ai(m, "top", 0))));
    o.set("ibo", i(im.map_or(0, |m| ai(m, "bottom", 0))));
    o.set("cl", J::Arr(Vec::new()));
    o.set("tr", J::Arr(rows));
    cx.cs[pos].1 = o;
    Ok(J::obj().with("cc", i(11)).with("ci", i(CI_TBL)).with("co", J::Str(guid)))
}

fn matrix(m: Option<Node>) -> J {
    let mut o = J::obj();
    for k in ["e1", "e2", "e3", "e4", "e5", "e6"] {
        let v = m.and_then(|x| x.attribute(k)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        o.set(k, J::Num(v));
    }
    o
}

/// 도형 공통 `rc`. `reverse` 는 그림에만 있는 반전 값(표본에서 `rcy` 와 `ri` 사이).
fn shape_rc(n: Node, rc_ci: i64, reverse: Option<bool>, master: bool) -> J {
    let off = child(n, "offset");
    let org = child(n, "orgSz");
    let cur = child(n, "curSz");
    let flip = child(n, "flip");
    let rot = child(n, "rotationInfo");
    let rinfo = child(n, "renderingInfo");
    let mut re = Vec::new();
    if let Some(r) = rinfo {
        let scas = children(r, "scaMatrix");
        let rots = children(r, "rotMatrix");
        for (k, sm) in scas.iter().enumerate() {
            re.push(J::obj().with("sm", matrix(Some(*sm))).with("ro", matrix(rots.get(k).copied())));
        }
    }
    let inf = J::obj()
        .with("ma", b(master))
        .with("rb", b(false))
        .with("tm", matrix(rinfo.and_then(|r| child(r, "transMatrix"))))
        .with("re", J::Arr(re));
    let mut o = J::obj()
        .with("cc", i(11))
        .with("ci", i(rc_ci))
        .with("hr", s(attr(n, "href")))
        .with("gl", i(ai(n, "groupLevel", 0)))
        .with("ii", i(inst_id(n)))
        .with("ox", i(i32v(off.map_or(0, |x| ai(x, "x", 0)))))
        .with("oy", i(i32v(off.map_or(0, |x| ai(x, "y", 0)))))
        .with("ow", i(org.map_or(0, |x| ai(x, "width", 0))))
        .with("oh", i(org.map_or(0, |x| ai(x, "height", 0))))
        .with("cw", i(cur.map(|x| ai(x, "width", 0)).filter(|v| *v != 0).unwrap_or_else(|| org.map_or(0, |x| ai(x, "width", 0)))))
        .with("ch", i(cur.map(|x| ai(x, "height", 0)).filter(|v| *v != 0).unwrap_or_else(|| org.map_or(0, |x| ai(x, "height", 0)))))
        .with("fh", b(flip.is_some_and(|x| ab(x, "horizontal"))))
        .with("fv", b(flip.is_some_and(|x| ab(x, "vertical"))))
        .with("ra", i(rot.map_or(0, |x| ai(x, "angle", 0))))
        .with("rcx", i(rot.map_or(0, |x| ai(x, "centerX", 0))))
        .with("rcy", i(rot.map_or(0, |x| ai(x, "centerY", 0))));
    if let Some(rv) = reverse {
        o.set("rc", b(rv));
    }
    o.with("ri", b(rot.is_some_and(|x| ab(x, "rotateimage"))))
        .with("in", inf)
}

fn emit_pic(cx: &mut Ctx, n: Node) -> Result<J, HwpError> {
    let guid = cx.guid();
    let pos = cx.cs.len();
    cx.cs.push((guid.clone(), J::Null));
    let mut o = obj_head(n, 11, CI_GSO);
    emit_sz_pos(&mut o, n);
    // 캡션이 없으면 한글은 빈 객체를 싣는다
    o.set("ca", emit_caption(cx, &guid, n)?.unwrap_or_else(J::obj));
    o.set("sc", J::Str(shape_comment(n)));
    // rc.rc 는 그림 반전(reverse) — 개체 공통의 rc 와 이름만 같다
    let mut rc = shape_rc(n, RC_PIC, Some(ab(n, "reverse")), cx.in_master);
    rc.set("re", b(false));
    rc.set("ls", J::obj());
    // 원본 그림 크기(imgDim)가 없으면 한글은 자르기 영역의 오른쪽·아래 끝을, 그것도 없으면 orgSz 를 쓴다(표본)
    let dim = child(n, "imgDim");
    let org = child(n, "orgSz");
    let clip = child(n, "imgClip");
    let size = |dk: &str, ck: &str, ok: &str| -> i64 {
        dim.map(|x| ai(x, dk, 0)).filter(|v| *v > 0)
            .or_else(|| clip.map(|x| ai(x, ck, 0)).filter(|v| *v > 0))
            .unwrap_or_else(|| org.map_or(0, |x| ai(x, ok, 0)))
    };
    rc.set("iw", i(size("dimwidth", "right", "width")));
    rc.set("ih", i(size("dimheight", "bottom", "height")));
    let rect = child(n, "imgRect");
    for k in 0..4 {
        let pt = rect.and_then(|r| child(r, &format!("pt{k}")));
        rc.set(&format!("ix{k}"), i(pt.map_or(0, |p| ai(p, "x", 0))));
        rc.set(&format!("iy{k}"), i(pt.map_or(0, |p| ai(p, "y", 0))));
    }
    let clip = child(n, "imgClip");
    rc.set("il", i(clip.map_or(0, |x| ai(x, "left", 0))));
    rc.set("ir", i(clip.map_or(0, |x| ai(x, "right", 0))));
    rc.set("it", i(clip.map_or(0, |x| ai(x, "top", 0))));
    rc.set("ib", i(clip.map_or(0, |x| ai(x, "bottom", 0))));
    let im = child(n, "inMargin");
    rc.set("ml", i(im.map_or(0, |x| ai(x, "left", 0))));
    rc.set("mr", i(im.map_or(0, |x| ai(x, "right", 0))));
    rc.set("mt", i(im.map_or(0, |x| ai(x, "top", 0))));
    rc.set("mb", i(im.map_or(0, |x| ai(x, "bottom", 0))));
    let img = child(n, "img");
    let bin_ref = img.map_or("", |x| attr(x, "binaryItemIDRef")).to_string();
    let sr = bin_store_name(cx, &bin_ref);
    rc.set("img", J::obj()
        .with("br", i(img.map_or(0, |x| ai(x, "bright", 0))))
        .with("co", i(img.map_or(0, |x| ai(x, "contrast", 0))))
        .with("ef", i(img.map_or(0, |x| ae(x, "effect", &E_IMGEFFECT, 0))))
        .with("al", i(img.map_or(0, |x| ai(x, "alpha", 0))))
        .with("ie", b(true))
        .with("bi", J::Str(sr)));
    rc.set("ef", J::obj().with("sh", J::obj()).with("gl", J::obj()).with("se", J::obj()).with("re", J::obj()));
    o.set("rc", rc);
    cx.cs[pos].1 = o;
    Ok(J::obj().with("cc", i(11)).with("ci", i(CI_GSO)).with("co", J::Str(guid)))
}

/// manifest id → bi/bidt 저장소 이름(`GUID.ext`). 처음 보면 원본 바이트를 base64 로 싣는다.
pub(crate) fn compact_clipboard_bitmap(data: &[u8]) -> Option<Vec<u8>> {
    // [hwpx-cowork] Shared by ordinary HTML and Hancom's JSON. Both clipboard
    // representations must avoid uncompressed BMP payloads; never rescale pixels.
    if !data.starts_with(b"BM") { return None; }
    let image = image::load_from_memory_with_format(data, image::ImageFormat::Bmp).ok()?;
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let bytes = png.into_inner();
    (bytes.len() < data.len()).then_some(bytes)
}

fn bin_store_name(cx: &mut Ctx, id: &str) -> String {
    if let Some(n) = cx.bin_names.get(id) {
        return n.clone();
    }
    use base64::Engine as _;
    // [hwpx-cowork] A missing picture still occupies its original shape. Never
    // emit bi=""/an empty path: Hancom may drop that shape and shift the content.
    let fallback = || {
        let mut image = image::RgbImage::from_pixel(32, 32, image::Rgb([238, 238, 238]));
        for y in 0..32u32 {
            for x in 0..32u32 {
                if x.abs_diff(y) <= 1 || (x + y).abs_diff(31) <= 1 {
                    image.put_pixel(x, y, image::Rgb([190, 35, 35]));
                }
            }
        }
        let mut out = std::io::Cursor::new(Vec::new());
        if image::DynamicImage::ImageRgb8(image).write_to(&mut out, image::ImageFormat::Png).is_ok() {
            out.into_inner()
        } else { Vec::new() }
    };
    let (mut mime, mut ext, mut data) = cx.bins.get(id).cloned().unwrap_or_default();
    let mut missing = data.is_empty();
    // [hwpx-cowork] BMP pixels inflate clipboard JSON by over 100 MiB in real
    // documents. A smaller lossless PNG retains pixels and shape dimensions;
    // native/portable HWPX copies continue carrying the original bitmap bytes.
    if data.starts_with(b"BM") {
        match image::load_from_memory_with_format(&data, image::ImageFormat::Bmp) {
            Ok(image) => {
                let mut png = std::io::Cursor::new(Vec::new());
                if image.write_to(&mut png, image::ImageFormat::Png).is_ok() && png.get_ref().len() < data.len() {
                    mime = "image/png".to_string();
                    ext = "png".to_string();
                    data = png.into_inner();
                }
            }
            Err(image::ImageError::Decoding(_) | image::ImageError::IoError(_)) => { missing = true; }
            Err(_) => {}
        }
    } else if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "tif" | "tiff") && (image::guess_format(&data).is_err() || matches!(image::load_from_memory(&data), Err(image::ImageError::Decoding(_) | image::ImageError::IoError(_)))) {
        missing = true;
    }
    if missing {
        cx.skip("image-data");
        mime = "image/png".to_string();
        ext = "png".to_string();
        data = fallback();
    }
    let name = format!("{}.{}", cx.guid(), ext);
    cx.bi.push(J::obj().with("ty", J::Str(mime)).with("sr", s(&name)));
    cx.bidt.push((name.clone(), J::Str(base64::engine::general_purpose::STANDARD.encode(&data))));
    cx.bin_names.insert(id.to_string(), name.clone());
    name
}

/// [hwpx-cowork] 한글 HTML 붙여넣기는 사각형의 renderingInfo 회전 행렬을
/// 초기화한다(한글 자체 HTML 복사도 동일). 회전된 네 꼭짓점을 보내면 사각형
/// 개체·선·채우기·배치 속성과 회전각을 유지한 채 같은 모양으로 붙는다.
/// 원본 HWPX/내부 클립보드는 바꾸지 않으며 이미 변환된 꼭짓점은 다시 돌리지 않는다.
fn bake_clipboard_rectangle(n: Node, o: &mut J, rc: &mut J) {
    let angle = child(n, "rotationInfo").map_or(0, |r| ai(r, "angle", 0));
    if angle.rem_euclid(360) == 0 || child(n, "drawText").is_some() {
        return;
    }
    const ID: [f64; 6] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let read = |node: Option<Node>| -> [f64; 6] {
        let mut m = ID;
        for (index, key) in ["e1", "e2", "e3", "e4", "e5", "e6"].iter().enumerate() {
            if let Some(v) = node.and_then(|x| x.attribute(*key)).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) {
                m[index] = v;
            }
        }
        m
    };
    let mul = |a: [f64; 6], b: [f64; 6]| -> [f64; 6] {
        [a[0]*b[0]+a[1]*b[3], a[0]*b[1]+a[1]*b[4], a[0]*b[2]+a[1]*b[5]+a[2],
         a[3]*b[0]+a[4]*b[3], a[3]*b[1]+a[4]*b[4], a[3]*b[2]+a[4]*b[5]+a[5]]
    };
    let mut points = [(0.0, 0.0); 4];
    for (k, point) in points.iter_mut().enumerate() {
        let Some(p) = child(n, &format!("pt{k}")) else { return };
        *point = (ai(p, "x", 0) as f64, ai(p, "y", 0) as f64);
    }
    let rinfo = child(n, "renderingInfo");
    let mut transform = read(rinfo.and_then(|r| child(r, "transMatrix")));
    let mut has_rotation = false;
    if let Some(r) = rinfo {
        let scales = children(r, "scaMatrix");
        let rotations = children(r, "rotMatrix");
        for k in 0..scales.len().max(rotations.len()) {
            let rotation = read(rotations.get(k).copied());
            has_rotation |= rotation != ID;
            transform = mul(mul(transform, rotation), read(scales.get(k).copied()));
        }
    }
    if !has_rotation {
        // 비축정렬 꼭짓점 + 단위 회전 행렬은 이미 좌표로 회전을 보존한 사각형이다.
        if points[0].1 != points[1].1 || points[1].0 != points[2].0
            || points[2].1 != points[3].1 || points[3].0 != points[0].0
            || points[1].0 < points[0].0 || points[2].1 < points[1].1 {
            return;
        }
        // 편집기에서 각도만 바뀌어 행렬이 아직 단위 행렬인 개체도 처리한다.
        if transform == ID {
            let org = child(n, "orgSz");
            let size = child(n, "sz");
            let ow = org.map_or(0, |v| ai(v, "width", 0));
            let oh = org.map_or(0, |v| ai(v, "height", 0));
            if ow > 0 && oh > 0 {
                transform[0] = size.map_or(ow, |v| ai(v, "width", ow)) as f64 / ow as f64;
                transform[4] = size.map_or(oh, |v| ai(v, "height", oh)) as f64 / oh as f64;
            }
        }
        let (sin, cos) = (angle as f64).to_radians().sin_cos();
        transform = mul([cos, -sin, 0.0, sin, cos, 0.0], transform);
    }
    for point in &mut points {
        *point = (transform[0]*point.0 + transform[1]*point.1 + transform[2],
                  transform[3]*point.0 + transform[4]*point.1 + transform[5]);
    }
    let min_x = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let max_y = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let width = (max_x - min_x).round();
    let height = (max_y - min_y).round();
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0
        || width > i32::MAX as f64 || height > i32::MAX as f64 { return }
    let (width, height) = (width as i64, height as i64);
    for (k, point) in points.iter().enumerate() {
        rc.set(&format!("x{k}"), i((point.0 - min_x).round() as i64));
        rc.set(&format!("y{k}"), i((point.1 - min_y).round() as i64));
    }
    for key in ["ow", "cw"] { rc.set(key, i(width)); }
    for key in ["oh", "ch"] { rc.set(key, i(height)); }
    rc.set("rcx", i(width / 2));
    rc.set("rcy", i(height / 2));
    o.set("swi", i(width));
    o.set("she", i(height));
    let identity = || { let mut m = J::obj(); for (key, value) in ["e1", "e2", "e3", "e4", "e5", "e6"].iter().zip(ID) { m.set(key, J::Num(value)); } m };
    // groupLevel=0인 독립 사각형. 바탕쪽 여부 등 in의 나머지 속성은 보존한다.
    if let J::Obj(fields) = rc {
        if let Some((_, inf)) = fields.iter_mut().find(|(key, _)| key == "in") {
            inf.set("tm", identity());
            inf.set("re", J::Arr(vec![J::obj().with("sm", identity()).with("ro", identity())]));
        }
    }
}

/// 그리기 개체(사각형·선·다각형). 키 순서는 한글 2022 표본(`$rec`·`$lin`·`$pol`)을 따른다.
fn emit_drawing(cx: &mut Ctx, n: Node, kind: &str) -> Result<J, HwpError> {
    let guid = cx.guid();
    let pos = cx.cs.len();
    cx.cs.push((guid.clone(), J::Null));
    let mut o = obj_head(n, 11, CI_GSO);
    emit_sz_pos(&mut o, n);
    // 캡션이 없으면 한글은 빈 객체를 싣는다
    o.set("ca", emit_caption(cx, &guid, n)?.unwrap_or_else(J::obj));
    o.set("sc", J::Str(shape_comment(n)));
    let rc_ci = match kind {
        "line" => RC_LIN,
        "polygon" => RC_POL,
        "ellipse" => RC_ELL,
        "arc" => RC_ARC,
        "connectLine" => RC_COL,
        "curve" => RC_CUR,
        _ => RC_REC,
    };
    let mut rc = shape_rc(n, rc_ci, Some(false), cx.in_master);
    rc.set("ls", match child(n, "lineShape") {
        Some(l) => J::obj()
            .with("co", i(ac(l, "color", 0)))
            .with("wi", i(ai(l, "width", 0)))
            .with("st", i(al(l, "style", 0)))
            .with("ec", i(ae(l, "endCap", &E_ENDCAP, 0)))
            .with("al", i(ai(l, "alpha", 0)))
            .with("hs", i(ae(l, "headStyle", &E_ARROW, 0)))
            .with("ts", i(ae(l, "tailStyle", &E_ARROW, 0)))
            .with("he", b(ab(l, "headfill")))
            .with("ta", b(ab(l, "tailfill")))
            .with("h1", i(ae(l, "headSz", &E_ARROWSZ, 0)))
            .with("t1", i(ae(l, "tailSz", &E_ARROWSZ, 0)))
            .with("os", i(ae(l, "outlineStyle", &E_OUTLINE, 0))),
        None => J::obj(),
    });
    rc.set("fb", fill_brush(child(n, "fillBrush")));
    let sh = child(n, "shadow");
    rc.set("sh", J::obj()
        .with("ty", i(sh.map_or(0, |x| ae(x, "type", &E_SHADOW, 0))))
        .with("co", i(sh.map_or(0, |x| ac(x, "color", 0))))
        .with("ox", i(sh.map_or(0, |x| ai(x, "offsetX", 0))))
        .with("oy", i(sh.map_or(0, |x| ai(x, "offsetY", 0))))
        .with("al", i(sh.map_or(0, |x| ai(x, "alpha", 0)))));
    // 글상자(drawText) — 없으면 so="" li=0
    let (mut so, mut li) = (String::new(), 0);
    if let Some(dt) = child(n, "drawText") {
        if let Some(sub) = child(dt, "subList") {
            let tm = child(dt, "textMargin");
            let dtj = J::obj()
                .with("lw", i(ai(dt, "lastWidth", -1)))
                .with("ed", b(ab(dt, "editable")))
                .with("ml", i(tm.map_or(0, |x| ai(x, "left", 0))))
                .with("mr", i(tm.map_or(0, |x| ai(x, "right", 0))))
                .with("mt", i(tm.map_or(0, |x| ai(x, "top", 0))))
                .with("mb", i(tm.map_or(0, |x| ai(x, "bottom", 0))));
            let (g, id) = emit_sublist(cx, &guid, sub, vec![("dt", dtj)])?;
            so = g;
            li = id;
        }
    }
    rc.set("so", J::Str(so));
    rc.set("li", i(li));
    match kind {
        "line" => {
            let sp = child(n, "startPt");
            let ep = child(n, "endPt");
            rc.set("sx", i(sp.map_or(0, |p| ai(p, "x", 0))));
            rc.set("sy", i(sp.map_or(0, |p| ai(p, "y", 0))));
            rc.set("ex", i(ep.map_or(0, |p| ai(p, "x", 0))));
            rc.set("ey", i(ep.map_or(0, |p| ai(p, "y", 0))));
            rc.set("ir", b(ab(n, "isReverseHV")));
        }
        "polygon" => {
            let pts: Vec<J> = children(n, "pt").into_iter()
                .map(|p| J::obj().with("x", i(ai(p, "x", 0))).with("y", i(ai(p, "y", 0))))
                .collect();
            rc.set("pt", J::Arr(pts));
        }
        "ellipse" | "arc" => {
            let pt = |name: &str, kx: &str, ky: &str, rc: &mut J| {
                let p = child(n, name);
                rc.set(kx, i(p.map_or(0, |x| ai(x, "x", 0))));
                rc.set(ky, i(p.map_or(0, |x| ai(x, "y", 0))));
            };
            if kind == "ellipse" {
                // 한글 표본 `$ell`: id·ha·at, 중심·두 축, 호 시작/끝 두 쌍
                rc.set("id", b(ab(n, "intervalDirty")));
                rc.set("ha", b(ab(n, "hasArcPr")));
                rc.set("at", i(ae(n, "arcType", &E_ARC_TYPE, 0)));
            }
            if kind == "ellipse" {
                pt("center", "cx", "cy", &mut rc);
                pt("ax1", "x1", "y1", &mut rc);
                pt("ax2", "x2", "y2", &mut rc);
                pt("start1", "sx1", "sy1", &mut rc);
                pt("end1", "ex1", "ey1", &mut rc);
                pt("start2", "sx2", "sy2", &mut rc);
                pt("end2", "ex2", "ey2", &mut rc);
            } else {
                // [hwpx-cowork] Actual $arc keys differ from the ellipse keys.
                rc.set("ty", i(ae(n, "type", &E_ARC_TYPE, 0)));
                pt("center", "cx1", "cy1", &mut rc);
                pt("ax1", "ax1", "ay1", &mut rc);
                pt("ax2", "ax2", "ay2", &mut rc);
            }
        }
        "connectLine" => {
            rc.set("ty", i(ae(n, "type", &E_CONNECTTYPE, 0)));
            rc.set("fl", i(0));
            for (tag,key) in [("startPt","sp"),("endPt","ep")] {
                let p=child(n,tag);
                rc.set(key,J::obj().with("x",i(p.map_or(0,|p|ai(p,"x",0))))
                    .with("y",i(p.map_or(0,|p|ai(p,"y",0))))
                    .with("sr",i(p.map_or(0,|p|ai(p,"subjectIDRef",0))))
                    .with("si",i(p.map_or(0,|p|ai(p,"subjectIdx",0)))));
            }
            let points=child(n,"controlPoints").map_or(Vec::new(),|p|children(p,"point"));
            rc.set("cp",J::Arr(points.into_iter().map(|p|J::obj().with("x",i(ai(p,"x",0)))
                .with("y",i(ai(p,"y",0))).with("ty",i(ai(p,"type",0)))).collect()));
        }
        "curve" => {
            let segments=children(n,"seg");
            let mut points=Vec::new();let mut types=Vec::new();
            if let Some(first)=segments.first() {
                points.push(J::obj().with("x",i(ai(*first,"x1",0))).with("y",i(ai(*first,"y1",0))));
            }
            for seg in segments {
                points.push(J::obj().with("x",i(ai(seg,"x2",0))).with("y",i(ai(seg,"y2",0))));
                types.push(J::obj().with("ty",i(i64::from(attr(seg,"type")=="CURVE"))));
            }
            rc.set("sp",J::Arr(points));rc.set("st",J::Arr(types));
        }
        _ => {
            rc.set("rra", i(ai(n, "ratio", 0)));
            for k in 0..4 {
                let pt = child(n, &format!("pt{k}"));
                rc.set(&format!("x{k}"), i(pt.map_or(0, |p| ai(p, "x", 0))));
                rc.set(&format!("y{k}"), i(pt.map_or(0, |p| ai(p, "y", 0))));
            }
        }
    }
    if kind == "rect" && ai(n, "groupLevel", 0) == 0 {
        bake_clipboard_rectangle(n, &mut o, &mut rc);
    }
    o.set("rc", rc);
    cx.cs[pos].1 = o;
    Ok(J::obj().with("cc", i(11)).with("ci", i(CI_GSO)).with("co", J::Str(guid)))
}

/// [hwpx-cowork] Hancom stores group children as component records in rc.co,
/// not as independent body controls. Keep each child's transforms and sublists.
fn emit_group(cx: &mut Ctx, n: Node) -> Result<J,HwpError> {
    let guid=cx.guid();let pos=cx.cs.len();cx.cs.push((guid.clone(),J::Null));
    let mut o=obj_head(n,11,CI_GSO);emit_sz_pos(&mut o,n);
    o.set("ca",emit_caption(cx,&guid,n)?.unwrap_or_else(J::obj));o.set("sc",J::Str(shape_comment(n)));
    let mut rc=shape_rc(n,RC_CON,Some(false),cx.in_master);let mut components=Vec::new();
    for child_node in elems(n) {
        let start=cx.cs.len();
        match local(child_node) {
            "rect"|"line"|"polygon"|"ellipse"|"arc"|"connectLine"|"curve" => {emit_drawing(cx,child_node,local(child_node))?;},
            "pic" => {emit_pic(cx,child_node)?;},
            "container" => {emit_group(cx,child_node)?;},
            _ => continue,
        }
        if let J::Obj(fields)=cx.cs.remove(start).1 {
            if let Some((_,component))=fields.into_iter().find(|(key,_)|key=="rc") {components.push(component);}
        }
    }
    rc.set("co",J::Arr(components));o.set("rc",rc);cx.cs[pos].1=o;
    Ok(J::obj().with("cc",i(11)).with("ci",i(CI_GSO)).with("co",J::Str(guid)))
}

/// 수식. 미리보기 그림(eq.pi)은 싣지 않는다 — 한글이 수식 스크립트로 다시 그린다.
fn emit_equation(cx: &mut Ctx, n: Node) -> Result<J, HwpError> {
    let guid = cx.guid();
    let pos = cx.cs.len();
    cx.cs.push((guid.clone(), J::Null));
    let mut o = obj_head(n, 11, CI_EQED);
    emit_sz_pos(&mut o, n);
    o.set("ca", emit_caption(cx, &guid, n)?.unwrap_or_else(J::obj));
    o.set("sc", J::Str(shape_comment(n)));
    let script = child(n, "script").and_then(|x| x.text()).unwrap_or("").to_string();
    o.set("eq", J::obj()
        .with("ve", s(attr(n, "version")))
        .with("bl", i(ai(n, "baseLine", 0)))
        .with("tc", i(ac(n, "textColor", 0)))
        .with("bu", i(ai(n, "baseUnit", 1000)))
        .with("lm", b(attr(n, "lineMode") == "LINE"))
        .with("fn", s(attr(n, "font")))
        .with("sc", J::Str(script))
        .with("pi", s("")));
    cx.cs[pos].1 = o;
    Ok(J::obj().with("cc", i(11)).with("ci", i(CI_EQED)).with("co", J::Str(guid)))
}

fn note_pr(n: Option<Node>, place: &[&str], ll_default: i64) -> J {
    let f = n.and_then(|x| child(x, "autoNumFormat"));
    let line = n.and_then(|x| child(x, "noteLine"));
    let sp = n.and_then(|x| child(x, "noteSpacing"));
    let num = n.and_then(|x| child(x, "numbering"));
    let pl = n.and_then(|x| child(x, "placement"));
    J::obj()
        .with("at", i(f.map_or(0, |x| ae(x, "type", &NUM_FORMAT, 0))))
        .with("au", s(f.map_or("", |x| attr(x, "userChar"))))
        .with("ap", s(f.map_or("", |x| attr(x, "prefixChar"))))
        .with("ac", s(f.map_or(")", |x| attr(x, "suffixChar"))))
        .with("as", b(f.is_some_and(|x| ab(x, "supscript"))))
        .with("ll", i(line.map_or(ll_default, |x| ai(x, "length", ll_default))))
        .with("lt", i(line.map_or(1, |x| al(x, "type", 1))))
        .with("lw", i(line.map_or(1, |x| LINE_WIDTH.iter().position(|w| *w == attr(x, "width")).map_or(1, |p| p as i64))))
        .with("lc", i(line.map_or(0, |x| ac(x, "color", 0))))
        .with("sa", i(sp.map_or(850, |x| ai(x, "aboveLine", 850))))
        .with("sb", i(sp.map_or(567, |x| ai(x, "belowLine", 567))))
        .with("st", i(sp.map_or(283, |x| ai(x, "betweenNotes", 283))))
        .with("nt", i(num.map_or(0, |x| ae(x, "type", &E_NOTENUM, 0))))
        .with("nn", i(num.map_or(1, |x| ai(x, "newNum", 1))))
        .with("pp", i(pl.map_or(0, |x| ae(x, "place", place, 0))))
        .with("pb", b(pl.is_some_and(|x| ab(x, "beneathText"))))
}

/// 한글은 구역 시작이 아닌 부분 복사에 원본 대신 '새 문서' 기본 구역 정의를 싣는다(표본 3건 동일).
/// 원본 값을 실으면 한글이 붙여넣으며 받는 쪽 문서의 쪽 여백·주석 모양을 바꿔 버린다(실측).
fn default_secd(cx: &mut Ctx) -> J {
    let bf = cx.guid();
    cx.synth.push((Tbl::Bf, bf.clone(), J::obj()
        .with("td", b(false)).with("sh", b(false)).with("st", i(0)).with("sc", i(0)).with("si", b(false))
        .with("bt", i(0)).with("bi", b(false)).with("cl", i(0)).with("bc", b(false))
        .with("lt", i(0)).with("lw", i(0)).with("lc", i(0)).with("rt", i(0)).with("rw", i(0)).with("rc", i(0))
        .with("tt", i(0)).with("tw", i(0)).with("tc", i(0)).with("bbt", i(0)).with("bbw", i(0)).with("bbc", i(0))
        .with("dt", i(1)).with("dw", i(0)).with("dc", i(0)).with("fi", J::obj())));
    let note = |ll: i64, st: i64| J::obj()
        .with("at", i(0)).with("au", s("")).with("ap", s("")).with("ac", s(")")).with("as", b(false))
        .with("ll", i(ll)).with("lt", i(1)).with("lw", i(1)).with("lc", i(0))
        .with("sa", i(850)).with("sb", i(567)).with("st", i(st)).with("nt", i(0)).with("nn", i(1))
        .with("pp", i(0)).with("pb", b(false));
    let pbs = (0..3).map(|ty| J::obj()
        .with("ty", i(ty)).with("bf", s(&bf)).with("tb", b(true)).with("hi", b(false)).with("fi", b(false))
        .with("fa", i(0)).with("ol", i(1417)).with("or", i(1417)).with("ot", i(1417)).with("ob", i(1417)))
        .collect();
    J::obj()
        .with("cc", i(2)).with("ci", i(CI_SECD)).with("td", i(0)).with("tv", b(false))
        .with("sc", i(1134)).with("ts", i(8000)).with("ms", s("")).with("os", s(""))
        .with("gl", i(0)).with("gc", i(0)).with("gw", b(false))
        .with("ns", i(0)).with("np", i(0)).with("ni", i(0)).with("nt", i(0)).with("ne", i(0))
        .with("hh", b(false)).with("hf", b(false)).with("hm", b(false)).with("fb", b(false)).with("hb", b(false))
        .with("fi", b(false)).with("hi", b(false)).with("hp", b(false)).with("he", b(false)).with("sl", b(false))
        .with("lr", i(0)).with("lc", i(0)).with("ld", i(0)).with("ls", i(0))
        .with("pp", J::obj()
            .with("ls", b(false)).with("wi", i(59528)).with("he", i(84188)).with("gt", i(0))
            .with("ml", i(8504)).with("mr", i(8504)).with("mt", i(5668)).with("mb", i(4252))
            .with("mh", i(4252)).with("mf", i(4252)).with("mg", i(0)))
        .with("fn", note(-1, 283))
        .with("en", note(-4, 0))
        .with("pb", J::Arr(pbs))
        .with("mp", J::Arr(Vec::new()))
}

fn emit_secd(cx: &mut Ctx, n: Node, first_style: Option<(String, String, String)>) -> Result<J, HwpError> {
    let guid = cx.guid();
    if !cx.section_start {
        let o = default_secd(cx);
        cx.cs.push((guid.clone(), o));
        push_secd_sublist(cx, &guid, first_style);
        return Ok(J::obj().with("cc", i(2)).with("ci", i(CI_SECD)).with("co", J::Str(guid)));
    }
    let pos = cx.cs.len();
    cx.cs.push((guid.clone(), J::Null));
    let grid = child(n, "grid");
    let sn = child(n, "startNum");
    let vis = child(n, "visibility");
    let lns = child(n, "lineNumberShape");
    let page = child(n, "pagePr");
    let mg = page.and_then(|p| child(p, "margin"));
    let os = n.attribute("outlineShapeIDRef").and_then(|v| v.parse::<i64>().ok())
        .filter(|_| cx.section_start)
        .map(|id| cx.r(Tbl::Nu, id)).unwrap_or_default();
    let ms_id = ai(n, "memoShapeIDRef", 0);
    let ms = if cx.section_start && cx.h.mp.contains_key(&ms_id) {
        cx.r(Tbl::Mp, ms_id)
    } else {
        String::new()
    };
    let mut pbs = Vec::new();
    for pb in children(n, "pageBorderFill") {
        let off = child(pb, "offset");
        let bf = cx.ra(Tbl::Bf, pb, "borderFillIDRef");
        pbs.push(J::obj()
            .with("ty", i(ae(pb, "type", &E_PBF_TYPE, 0)))
            .with("bf", J::Str(bf))
            .with("tb", b(attr(pb, "textBorder") == "PAPER"))
            .with("hi", b(ab(pb, "headerInside")))
            .with("fi", b(ab(pb, "footerInside")))
            .with("fa", i(ae(pb, "fillArea", &E_FILLAREA, 0)))
            .with("ol", i(off.map_or(0, |x| ai(x, "left", 0))))
            .with("or", i(off.map_or(0, |x| ai(x, "right", 0))))
            .with("ot", i(off.map_or(0, |x| ai(x, "top", 0))))
            .with("ob", i(off.map_or(0, |x| ai(x, "bottom", 0)))));
    }
    let o = J::obj()
        .with("cc", i(2))
        .with("ci", i(CI_SECD))
        .with("td", i(ae(n, "textDirection", &E_TEXTDIR, 0)))
        .with("tv", b(ab(n, "textVerticalWidthHead")))
        .with("sc", i(ai(n, "spaceColumns", 1134)))
        .with("ts", i(ai(n, "tabStop", 8000)))
        .with("ms", J::Str(ms))
        .with("os", J::Str(os))
        .with("gl", i(grid.map_or(0, |x| ai(x, "lineGrid", 0))))
        .with("gc", i(grid.map_or(0, |x| ai(x, "charGrid", 0))))
        .with("gw", b(grid.is_some_and(|x| ab(x, "wonggojiFormat"))))
        .with("ns", i(sn.map_or(0, |x| ae(x, "pageStartsOn", &E_PAGESTART, 0))))
        .with("np", i(sn.map_or(0, |x| ai(x, "page", 0))))
        .with("ni", i(sn.map_or(0, |x| ai(x, "pic", 0))))
        .with("nt", i(sn.map_or(0, |x| ai(x, "tbl", 0))))
        .with("ne", i(sn.map_or(0, |x| ai(x, "equation", 0))))
        .with("hh", b(vis.is_some_and(|x| ab(x, "hideFirstHeader"))))
        .with("hf", b(vis.is_some_and(|x| ab(x, "hideFirstFooter"))))
        .with("hm", b(vis.is_some_and(|x| ab(x, "hideFirstMasterPage"))))
        .with("fb", b(false))
        .with("hb", b(false))
        .with("fi", b(false))
        .with("hi", b(false))
        .with("hp", b(vis.is_some_and(|x| ab(x, "hideFirstPageNum"))))
        .with("he", b(vis.is_some_and(|x| ab(x, "hideFirstEmptyLine"))))
        .with("sl", b(vis.is_some_and(|x| ab(x, "showLineNumber"))))
        .with("lr", i(lns.map_or(0, |x| ai(x, "restartType", 0))))
        .with("lc", i(lns.map_or(0, |x| ai(x, "countBy", 0))))
        .with("ld", i(lns.map_or(0, |x| ai(x, "distance", 0))))
        .with("ls", i(lns.map_or(0, |x| ai(x, "startNumber", 0))))
        .with("pp", J::obj()
            .with("ls", b(page.is_some_and(|x| attr(x, "landscape") == "NARROWLY")))
            .with("wi", i(page.map_or(59528, |x| ai(x, "width", 59528))))
            .with("he", i(page.map_or(84186, |x| ai(x, "height", 84186))))
            .with("gt", i(page.map_or(0, |x| ae(x, "gutterType", &E_GUTTER, 0))))
            .with("ml", i(mg.map_or(8504, |x| ai(x, "left", 8504))))
            .with("mr", i(mg.map_or(8504, |x| ai(x, "right", 8504))))
            .with("mt", i(mg.map_or(5668, |x| ai(x, "top", 5668))))
            .with("mb", i(mg.map_or(4252, |x| ai(x, "bottom", 4252))))
            .with("mh", i(mg.map_or(4252, |x| ai(x, "header", 4252))))
            .with("mf", i(mg.map_or(4252, |x| ai(x, "footer", 4252))))
            .with("mg", i(mg.map_or(0, |x| ai(x, "gutter", 0)))))
        .with("fn", note_pr(child(n, "footNotePr"), &E_FN_PLACE, -1))
        .with("en", note_pr(child(n, "endNotePr"), &E_EN_PLACE, 14_692_344))
        .with("pb", J::Arr(pbs))
        .with("mp", J::Arr(emit_master_pages(cx, &guid, n)?));
    cx.cs[pos].1 = o;
    push_secd_sublist(cx, &guid, first_style);
    Ok(J::obj().with("cc", i(2)).with("ci", i(CI_SECD)).with("co", J::Str(guid)))
}

/// 바탕쪽 → 구역 정의 `mp`. 목록 머리는 머리말처럼 글 영역 크기를 싣고, 구역 정의 자신의 목록보다
/// 먼저 놓인다(한글 표본: 바탕쪽 sl id 1·2, 구역 정의 목록 3). 종류는 BOTH 0·EVEN 1·ODD 2, 확장 바탕쪽
/// (LAST_PAGE·OPTIONAL_PAGE)은 둘 다 3(한글 2022 실측).
fn emit_master_pages(cx: &mut Ctx, owner: &str, sec: Node) -> Result<Vec<J>, HwpError> {
    let mut out = Vec::new();
    for r in children(sec, "masterPage") {
        let Some(xml) = cx.masters.get(attr(r, "idRef")).cloned() else {
            cx.skip("masterPage");
            continue;
        };
        let Ok(md) = roxmltree::Document::parse(&xml) else {
            cx.skip("masterPage");
            continue;
        };
        let root = md.root_element();
        let Some(sub) = child(root, "subList") else { continue };
        let extra = vec![
            ("tw", i(ai(sub, "textWidth", 0))),
            ("th", i(ai(sub, "textHeight", 0))),
            ("ht", b(ab(sub, "hasTextRef"))),
            ("hn", b(ab(sub, "hasNumRef"))),
        ];
        cx.in_master = true;
        let emitted = emit_sublist(cx, owner, sub, extra);
        cx.in_master = false;
        let (g, id) = emitted?;
        out.push(J::obj()
            .with("so", J::Str(g))
            .with("li", i(id))
            .with("ty", i(match attr(root, "type") {
                "EVEN" => 1,
                "ODD" => 2,
                "LAST_PAGE" | "OPTIONAL_PAGE" => 3,
                _ => 0,
            }))
            .with("pd", b(ab(root, "pageDuplicate")))
            .with("pf", b(ab(root, "pageFront"))));
    }
    Ok(out)
}

/// 한글은 구역 정의마다 빈 문단 하나짜리 목록을 함께 싣는다(표본 sl id=1)
fn push_secd_sublist(cx: &mut Ctx, guid: &str, first_style: Option<(String, String, String)>) {
    if let Some((pp, si, cp)) = first_style {
        let head = cx.guid();
        let para = cx.guid();
        let id = cx.next_sl_id();
        cx.sl.push((head.clone(), J::obj()
            .with("co", s(guid)).with("id", i(id)).with("td", i(0)).with("lw", i(0)).with("va", i(0))
            .with("ll", s("")).with("ln", s("")).with("hp", s(&para))));
        cx.sl.push((para, J::obj()
            .with("np", s("")).with("id", i(0)).with("pp", J::Str(pp)).with("si", J::Str(si)).with("bf", i(0))
            .with("ru", J::Arr(vec![J::obj().with("cp", J::Str(cp)).with("ch", J::Arr(vec![J::obj().with("t", s(""))]))]))));
    }
}

fn emit_simple_ctrl(cx: &mut Ctx, cc: i64, ci: i64, body: J) -> J {
    let guid = cx.guid();
    let mut o = J::obj().with("cc", i(cc)).with("ci", i(ci));
    if let J::Obj(fields) = body {
        for (k, v) in fields {
            o.set(&k, v);
        }
    }
    cx.cs.push((guid.clone(), o));
    J::obj().with("cc", i(cc)).with("ci", i(ci)).with("co", J::Str(guid))
}

fn ctrl_ci(c: &J) -> i64 {
    if let J::Obj(fields) = c {
        if let Some((_, J::Int(v))) = fields.iter().find(|(k, _)| k == "ci") {
            return *v;
        }
    }
    0
}

/// 필드 종류 → 한글 4CC 컨트롤 id(HWP5 필드 ctrl id). XML 의 fieldid 가 `%xxx` 꼴이면 그것을 쓴다.
fn field_ci(ty: &str, fieldid: i64) -> i64 {
    if (fieldid >> 24) == 0x25 {
        return fieldid;
    }
    let tag: &[u8; 4] = match ty {
        "MEMO" => b"%%me",
        "TABLEOFCONTENTS" => b"%toc",
        "CROSSREF" => b"%xrf",
        "HYPERLINK" => b"%hlk",
        "CLICKHERE" => b"%clk",
        "BOOKMARK" => b"%bmk",
        "DATE" => b"%dte",
        "DOCDATE" => b"%ddt",
        "PATH" => b"%pat",
        "MAILMERGE" => b"%mmg",
        "FORMULA" => b"%fmu",
        "SUMMARY" => b"%smr",
        "USERINFO" => b"%usr",
        "PRIVATEINFO" => b"%cpr",
        "REVISION_SIGN" => b"%sig",
        _ => b"%unk",
    };
    i64::from(u32::from_be_bytes(*tag))
}

/// 필드 끝 ci — 시작 ci 의 아래 3바이트. 차례(%toc)만 위 바이트가 0x08 이다(한글 표본).
fn field_end_ci(begin: i64) -> i64 {
    let low = begin & 0x00FF_FFFF;
    if begin == i64::from(u32::from_be_bytes(*b"%toc")) {
        0x0800_0000 | low
    } else {
        low
    }
}

/// 머리말·꼬리말 쪽 종류
const E_APPLY_PAGE: [&str; 3] = ["BOTH", "EVEN", "ODD"];

fn emit_ctrl(cx: &mut Ctx, n: Node, out: &mut Vec<J>, bf: &mut i64) -> Result<(), HwpError> {
    for c in elems(n) {
        match local(c) {
            "colPr" if cx.default_cold_pending => {
                cx.default_cold_pending = false;
                *bf |= 2;
                out.push(emit_simple_ctrl(cx, 2, CI_COLD, J::obj()
                    .with("ty", i(0)).with("la", i(0)).with("co", i(1)).with("ss", b(true)).with("sg", i(0))
                    .with("lt", i(0)).with("lw", i(0)).with("lc", i(0)).with("cs", J::Arr(Vec::new()))));
            }
            "colPr" => {
                // 단 정의가 든 문단은 다단 나누기(bf bit1) — 한글 표본
                *bf |= 2;
                let line = child(c, "colLine");
                let body = J::obj()
                    .with("ty", i(ae(c, "type", &E_COLTYPE, 0)))
                    .with("la", i(ae(c, "layout", &E_COLLAYOUT, 0)))
                    .with("co", i(ai(c, "colCount", 1)))
                    .with("ss", b(ab(c, "sameSz")))
                    .with("sg", i(ai(c, "sameGap", 0)))
                    .with("lt", i(line.map_or(0, |x| al(x, "type", 0))))
                    .with("lw", i(line.map_or(0, |x| LINE_WIDTH.iter().position(|w| *w == attr(x, "width")).map_or(0, |p| p as i64))))
                    .with("lc", i(line.map_or(0, |x| ac(x, "color", 0))))
                    .with("cs", J::Arr(children(c, "colSz").into_iter()
                        .map(|z| J::obj().with("wi", i(ai(z, "width", 0))).with("ga", i(ai(z, "gap", 0))))
                        .collect()));
                out.push(emit_simple_ctrl(cx, 2, CI_COLD, body));
            }
            "pageNum" => {
                let body = J::obj().with("pn", J::obj()
                    .with("po", i(ae(c, "pos", &E_PAGENUMPOS, 0)))
                    .with("ft", i(ae(c, "formatType", &NUM_FORMAT, 0)))
                    .with("sc", s(attr(c, "sideChar"))));
                out.push(emit_simple_ctrl(cx, 21, CI_PGNP, body));
            }
            "pageHiding" => {
                let body = J::obj().with("ph", J::obj()
                    .with("hh", b(ab(c, "hideHeader")))
                    .with("hf", b(ab(c, "hideFooter")))
                    .with("hm", b(ab(c, "hideMasterPage")))
                    .with("hb", b(ab(c, "hideBorder")))
                    .with("hi", b(ab(c, "hideFill")))
                    .with("hp", b(ab(c, "hidePageNum"))));
                out.push(emit_simple_ctrl(cx, 21, CI_PGHD, body));
            }
            "bookmark" => {
                let body = J::obj().with("ps", J::obj().with("na", i(539)).with("pa", J::Arr(vec![
                    J::obj().with("na", i(16384)).with("ty", i(1)).with("va", s(attr(c, "name"))),
                ])));
                out.push(emit_simple_ctrl(cx, 22, CI_BOKM, body));
            }
            "autoNum" => {
                let f = child(c, "autoNumFormat");
                let body = J::obj().with("an", J::obj()
                    .with("nu", i(ai(c, "num", 1)))
                    .with("nt", i(ae(c, "numType", &E_NUMTYPE, 0)))
                    .with("at", i(f.map_or(0, |x| ae(x, "type", &NUM_FORMAT, 0))))
                    .with("au", s(f.map_or("", |x| attr(x, "userChar"))))
                    .with("ap", s(f.map_or("", |x| attr(x, "prefixChar"))))
                    .with("ac", s(f.map_or("", |x| attr(x, "suffixChar"))))
                    .with("as", b(f.is_some_and(|x| ab(x, "supscript")))));
                out.push(emit_simple_ctrl(cx, 18, CI_ATNO, body));
            }
            "newNum" => {
                let body = J::obj().with("nn", J::obj()
                    .with("nu", i(ai(c, "num", 1)))
                    .with("nt", i(ae(c, "numType", &E_NUMTYPE, 0))));
                out.push(emit_simple_ctrl(cx, 21, CI_NWNO, body));
            }
            "footNote" | "endNote" => {
                let foot = local(c) == "footNote";
                let (ci, key) = if foot { (CI_FN, "fn") } else { (CI_EN, "en") };
                let guid = cx.guid();
                let pos = cx.cs.len();
                cx.cs.push((guid.clone(), J::Null));
                let mut note = J::obj();
                if let Some(sub) = child(c, "subList") {
                    let (g, id) = emit_sublist(cx, &guid, sub, Vec::new())?;
                    note = note.with("so", J::Str(g)).with("li", i(id));
                }
                cx.cs[pos].1 = J::obj().with("cc", i(17)).with("ci", i(ci)).with(key, note);
                out.push(J::obj().with("cc", i(17)).with("ci", i(ci)).with("co", J::Str(guid)));
            }
            "header" | "footer" => {
                let head = local(c) == "header";
                let (ci, key) = if head { (CI_HEAD, "he") } else { (CI_FOOT, "fo") };
                let guid = cx.guid();
                let pos = cx.cs.len();
                cx.cs.push((guid.clone(), J::Null));
                let mut hf = J::obj()
                    .with("ap", i(ae(c, "applyPageType", &E_APPLY_PAGE, 0)))
                    .with("id", i(ai(c, "id", 0)));
                if let Some(sub) = child(c, "subList") {
                    // 머리말·꼬리말 목록 머리는 글상자 크기·참조 여부를 함께 싣는다(한글 표본)
                    let extra = vec![
                        ("tw", i(ai(sub, "textWidth", 0))),
                        ("th", i(ai(sub, "textHeight", 0))),
                        ("ht", b(ab(sub, "hasTextRef"))),
                        ("hn", b(ab(sub, "hasNumRef"))),
                    ];
                    let (g, id) = emit_sublist(cx, &guid, sub, extra)?;
                    hf = hf.with("so", J::Str(g)).with("li", i(id));
                }
                cx.cs[pos].1 = J::obj().with("cc", i(16)).with("ci", i(ci)).with(key, hf);
                out.push(J::obj().with("cc", i(16)).with("ci", i(ci)).with("co", J::Str(guid)));
            }
            "fieldBegin" if {
                let id = attr(c, "id");
                if attr(c, "type") == "MEMO" { !cx.para_ends.contains(id) } else { !cx.all_ends.contains(id) }
            } => {
                // 한글은 끝이 없거나(메모는) 다른 문단에서 끝나는 필드를 버리고, 하나라도 섞이면 메모 전체를 잃는다(실측)
                cx.skip("unbalanced-field");
            }
            "fieldBegin" => {
                let ty = attr(c, "type");
                let ci = field_ci(ty, ai(c, "fieldid", 0));
                let guid = cx.guid();
                let pos = cx.cs.len();
                cx.cs.push((guid.clone(), J::Null));
                let params = child(c, "parameters");
                let param = |name: &str| -> String {
                    params.and_then(|p| elems(p).into_iter().find(|x| attr(*x, "name") == name))
                        .and_then(|x| x.text()).unwrap_or("").to_string()
                };
                // zorder 는 부호 없는 32비트로 싣는다(-1 → 4294967295, 한글 표본). 메모는 1부터의 순번이어야
                // 한글이 받는다 — 0 이면 메모를 버린다(실측). 편집기 HWPX 는 zorder 를 빠뜨리므로 메모 번호로 채운다.
                let memo = ty == "MEMO";
                let zo = match c.attribute("zorder").and_then(|v| v.parse::<i64>().ok()) {
                    Some(z) if !(memo && z <= 0) => i64::from(z as u32),
                    _ if memo => param("Number").parse::<i64>().ok().filter(|n| *n > 0).unwrap_or_else(|| {
                        cx.memo_seq += 1;
                        cx.memo_seq
                    }),
                    _ => 0xFFFF_FFFF,
                };
                let fixed = matches!(param("Fiexde").as_str(), "1" | "true");
                let mut fb = J::obj()
                    .with("id", i(i32v(ai(c, "id", 0))))
                    .with("ty", i(ci))
                    .with("ed", b(ab(c, "editable")))
                    .with("la", i(0))
                    .with("di", b(ab(c, "dirty")))
                    .with("pa", J::obj()
                        .with("fi", b(fixed))
                        .with("pr", i(param("Prop").parse::<i64>().unwrap_or(0)))
                        .with("co", J::Str(param("Command"))))
                    .with("zo", i(zo))
                    .with("fi", i(ci));
                if let Some(sub) = child(c, "subList") {
                    let (g, id) = emit_sublist(cx, &guid, sub, Vec::new())?;
                    fb.set("so", J::Str(g));
                    fb.set("li", i(id));
                }
                cx.cs[pos].1 = J::obj().with("cc", i(3)).with("ci", i(ci)).with("fb", fb);
                cx.fields.insert(attr(c, "id").to_string(), (guid.clone(), zo, ci));
                out.push(J::obj().with("cc", i(3)).with("ci", i(ci)).with("co", J::Str(guid)));
            }
            "fieldEnd" => {
                let begin = attr(c, "beginIDRef").to_string();
                if let Some((g, zo, ci)) = cx.fields.get(&begin).cloned() {
                    let end = field_end_ci(ci);
                    let guid = cx.guid();
                    cx.cs.push((guid.clone(), J::obj().with("fo", J::Str(g)).with("cc", i(4)).with("ci", i(end)).with("zo", i(zo))));
                    out.push(J::obj().with("cc", i(4)).with("ci", i(end)).with("co", J::Str(guid)));
                }
            }
            other => cx.skip(other),
        }
    }
    Ok(())
}

fn push_text(out: &mut Vec<J>, t: &str) {
    if let Some(J::Obj(last)) = out.last_mut() {
        if last.len() == 1 && last[0].0 == "t" {
            if let J::Str(prev) = &mut last[0].1 {
                prev.push_str(t);
                return;
            }
        }
    }
    out.push(J::obj().with("t", s(t)));
}

fn emit_text(cx: &mut Ctx, t: Node, out: &mut Vec<J>) {
    let mut any = false;
    for c in t.children() {
        if c.is_text() {
            if let Some(v) = c.text() {
                push_text(out, v);
                any = true;
            }
            continue;
        }
        if !c.is_element() {
            continue;
        }
        any = true;
        match local(c) {
            // 탭은 글 사이의 별도 항목(한글 표본 {"cc":9,"wi","le","ty"}), 나머지는 HWP5 문자 코드
            "tab" => out.push(J::obj()
                .with("cc", i(9))
                .with("wi", i(ai(c, "width", 0)))
                .with("le", i(match c.attribute("leader") {
                    Some(v) if v.parse::<i64>().is_err() => line_code(v),
                    _ => ai(c, "leader", 0),
                }))
                .with("ty", i(ai(c, "type", 1)))),
            "lineBreak" => push_text(out, "\n"),
            "nbSpace" => push_text(out, "\u{1E}"),
            "fwSpace" => push_text(out, "\u{1F}"),
            "hyphen" | "hypen" => push_text(out, "\u{18}"),
            other => cx.skip(other),
        }
    }
    if !any {
        push_text(out, "");
    }
}

/// 한 문단의 run 목록. 인접한 같은 글자모양 run 은 한글처럼 하나로 합친다.
/// `first_body`: 본문 첫 문단 — 구역·단 정의를 여기서만 싣는다.
fn emit_paragraph(cx: &mut Ctx, p: Node, first_body: bool) -> Result<J, HwpError> {
    let ends: std::collections::HashSet<String> = children(p, "run").into_iter()
        .flat_map(|r| children(r, "ctrl"))
        .flat_map(|c| children(c, "fieldEnd"))
        .map(|e| attr(e, "beginIDRef").to_string())
        .collect();
    let saved = std::mem::replace(&mut cx.para_ends, ends);
    let out = emit_paragraph_inner(cx, p, first_body);
    cx.para_ends = saved;
    out
}

fn emit_paragraph_inner(cx: &mut Ctx, p: Node, first_body: bool) -> Result<J, HwpError> {
    let mut runs: Vec<(String, Vec<J>)> = Vec::new();
    let mut bf = 0;
    if ab(p, "pageBreak") {
        bf |= 4;
    }
    if ab(p, "columnBreak") {
        bf |= 8;
    }
    let pp_guid = cx.ra(Tbl::Pp, p, "paraPrIDRef");
    let st_guid = cx.ra(Tbl::St, p, "styleIDRef");
    for run in children(p, "run") {
        let cp = cx.ra(Tbl::Cp, run, "charPrIDRef");
        let mut ch: Vec<J> = Vec::new();
        for c in elems(run) {
            match local(c) {
                "t" => emit_text(cx, c, &mut ch),
                "secPr" => {
                    let first = cx.h.st.keys().next().copied().map(|sid| {
                        let st = cx.h.st[&sid];
                        let pp = cx.ra(Tbl::Pp, st, "paraPrIDRef");
                        let cp = cx.ra(Tbl::Cp, st, "charPrIDRef");
                        let si = cx.r(Tbl::St, sid);
                        (pp, si, cp)
                    });
                    if first_body {
                        ch.push(emit_secd(cx, c, first)?);
                        cx.default_cold_pending = !cx.section_start;
                        bf |= 3;
                    } else {
                        // [hwpx-cowork] 뒤 구역의 구역 나누기(구역을 넘는 복사) — 한/글 자체 복사처럼 넘는 구역 나누기는
                        // 원본 구역 정의(가로 용지·바탕쪽·메모 모양 참조)째 싣는다(실측: 일부 복사도 같다)
                        let saved = std::mem::replace(&mut cx.section_start, true);
                        let secd = emit_secd(cx, c, first);
                        cx.section_start = saved;
                        ch.push(secd?);
                        bf |= 3;
                    }
                }
                "ctrl" => emit_ctrl(cx, c, &mut ch, &mut bf)?,
                "tbl" => ch.push(emit_tbl(cx, c)?),
                "pic" => ch.push(emit_pic(cx, c)?),
                "rect" | "line" | "polygon" | "ellipse" | "arc" | "connectLine" | "curve" => ch.push(emit_drawing(cx, c, local(c))?),
                "container" => ch.push(emit_group(cx,c)?),
                "equation" => ch.push(emit_equation(cx, c)?),
                other => cx.skip(other),
            }
        }
        // 한글 모델은 구역 정의 뒤에 늘 단 정의가 온다 — 조각에 없으면 1단 기본값을 끼운다
        if bf & 3 == 3 && !ch.iter().any(|c| ctrl_ci(c) == CI_COLD) {
            if let Some(at) = ch.iter().position(|c| ctrl_ci(c) == CI_SECD) {
                let cold = emit_simple_ctrl(cx, 2, CI_COLD, J::obj()
                    .with("ty", i(0)).with("la", i(0)).with("co", i(1)).with("ss", b(true)).with("sg", i(0))
                    .with("lt", i(0)).with("lw", i(0)).with("lc", i(0)).with("cs", J::Arr(Vec::new())));
                ch.insert(at + 1, cold);
            }
        }
        if let Some(last) = runs.last_mut().filter(|(prev, _)| *prev == cp) {
            last.1.extend(ch);
        } else {
            runs.push((cp, ch));
        }
    }
    // 첫 문단이 끝나면 기본 단 정의 대체도 끝난다(뒤쪽 다단 변경은 원본 그대로)
    if first_body {
        cx.default_cold_pending = false;
    }
    // 내용이 하나도 남지 않은 run(버린 필드만 있던 run 등)은 한글처럼 뺀다. 남기면 한글이 그 run 의
    // 글자모양을 다음 글자에 입힌다(차례 제목 '목' 만 작아짐, 실측). 다 비면 첫 run 하나만 남긴다.
    if runs.iter().any(|(_, ch)| !ch.is_empty()) {
        runs.retain(|(_, ch)| !ch.is_empty());
    } else {
        runs.truncate(1);
    }
    // 구역·단 정의만 든 run 은 한글처럼 다음 run 앞에 붙인다(그 run 의 글자모양을 쓴다)
    if runs.len() > 1 && !runs[0].1.is_empty() && runs[0].1.iter().all(|c| matches!(ctrl_ci(c), CI_SECD | CI_COLD)) {
        let (_, head) = runs.remove(0);
        let mut merged = head;
        merged.append(&mut runs[0].1);
        runs[0].1 = merged;
    }
    // 한글 모델에서 문단의 마지막 run 은 언제나 글로 끝난다(탭·개체 뒤에 빈 글, 표본 6만 문단 전수)
    if let Some((_, last)) = runs.last_mut() {
        let ends_text = matches!(last.last(), Some(J::Obj(f)) if f.len() == 1 && f[0].0 == "t");
        if !ends_text {
            last.push(J::obj().with("t", s("")));
        }
    }
    let ru: Vec<J> = runs.into_iter().map(|(cp, mut ch)| {
        if ch.is_empty() {
            ch.push(J::obj().with("t", s("")));
        }
        J::obj().with("cp", J::Str(cp)).with("ch", J::Arr(ch))
    }).collect();
    Ok(J::obj()
        .with("np", s(""))
        .with("id", i(i32v(ai(p, "id", 0))))
        .with("pp", J::Str(pp_guid))
        .with("si", J::Str(st_guid))
        .with("bf", i(bf))
        .with("ru", J::Arr(ru)))
}

/// 문단 목록을 sl(또는 본문은 호출부가 옮길 임시 목록)에 넣고 첫 문단 GUID 를 돌려준다.
fn emit_paragraph_list(cx: &mut Ctx, paras: &[Node], into_sl: bool) -> Result<String, HwpError> {
    let guids: Vec<String> = paras.iter().map(|_| cx.guid()).collect();
    for (k, p) in paras.iter().enumerate() {
        let pos = cx.sl.len();
        if into_sl {
            cx.sl.push((guids[k].clone(), J::Null));
        }
        let mut v = emit_paragraph(cx, *p, false)?;
        v.set("np", s(guids.get(k + 1).map_or("", |g| g.as_str())));
        if into_sl {
            cx.sl[pos].1 = v;
        }
    }
    Ok(guids.first().cloned().unwrap_or_default())
}

// ---------------------------------------------------------------- 공개 API

/// HWPX 조각 → hwpjson 문자열.
pub fn hwpx_to_hwpjson(input: HwpxFragment) -> Result<HwpJsonExport, HwpError> {
    let hdoc = roxmltree::Document::parse(input.header_xml)
        .map_err(|e| HwpError::InvalidFile(format!("header.xml 파싱 실패: {e}")))?;
    let sdoc = roxmltree::Document::parse(input.section_xml)
        .map_err(|e| HwpError::InvalidFile(format!("section0.xml 파싱 실패: {e}")))?;
    let mut cx = Ctx {
        h: index_header(hdoc.root_element()),
        prefix: format!("01DD{:012X}", input.seed & 0xFFFF_FFFF_FFFF),
        counter: 0,
        refs: BTreeMap::new(),
        pending: Vec::new(),
        sl: Vec::new(),
        cs: Vec::new(),
        sl_seq: 0,
        bi: Vec::new(),
        bidt: Vec::new(),
        bin_names: HashMap::new(),
        bins: input.bins,
        skipped: Vec::new(),
        section_start: input.section_start,
        fields: HashMap::new(),
        all_ends: sdoc.descendants()
            .filter(|n| n.is_element() && local(*n) == "fieldEnd")
            .map(|n| attr(n, "beginIDRef").to_string())
            .collect(),
        para_ends: Default::default(),
        default_cold_pending: false,
        synth: Vec::new(),
        memo_seq: 0,
        masters: input.master_pages,
        in_master: false,
    };

    // 본문 문단
    let body: Vec<Node> = children(sdoc.root_element(), "p");
    if body.is_empty() {
        return Err(HwpError::InvalidFile("복사한 문단이 없습니다".to_string()));
    }
    let guids: Vec<String> = body.iter().map(|_| cx.guid()).collect();
    let mut ro: Vec<(String, J)> = vec![("hp".to_string(), s(&guids[0]))];
    for (k, p) in body.iter().enumerate() {
        let mut v = emit_paragraph(&mut cx, *p, k == 0)?;
        v.set("np", s(guids.get(k + 1).map_or("", |g| g.as_str())));
        ro.push((guids[k].clone(), v));
    }

    let tables = build_header_tables(&mut cx);
    let table = |t: Tbl| -> J {
        J::Obj(tables.get(&t).map_or(Vec::new(), |items| {
            items.iter().map(|(_, g, v)| (g.clone(), v.clone())).collect()
        }))
    };

    let root = J::obj()
        .with("documentPr", J::obj()
            .with("di", s(""))
            .with("dp", J::obj()
                .with("dn", s("")).with("ta", i(1)).with("d1", i(5)).with("d2", i(1)).with("dv", i(0))
                .with("dr", i(1)).with("do", i(1)).with("vj", s("1.1")).with("an", s("Hancom Office Hangul"))
                .with("av", s("12, 0, 0, 3146")).with("ao", s("WIN")).with("ab", s("32")).with("ar", s("LE"))
                .with("as", s("Windows_10")))
            .with("dis", b(false))
            .with("ds", J::obj()
                .with("ti", s("")).with("la", s("ko")).with("cr", s("")).with("su", s("")).with("de", s(""))
                .with("cd", s("")).with("md", s("")).with("ke", s(""))))
        .with("dh", J::obj()
            .with("do", J::obj().with("pa", i(1)).with("fo", i(1)).with("en", i(1)).with("pi", i(1)).with("tb", i(1)).with("eq", i(1)))
            .with("fo", J::Arr(Vec::new()))
            .with("cd", J::obj().with("tp", i(0)).with("lc", J::obj()))
            .with("ld", J::obj().with("pa", s("")).with("pi", b(true)).with("fo", b(false))))
        .with("bf", table(Tbl::Bf))
        .with("cp", table(Tbl::Cp))
        .with("tp", table(Tbl::Tp))
        .with("nu", table(Tbl::Nu))
        .with("bu", table(Tbl::Bu))
        .with("pp", table(Tbl::Pp))
        .with("st", table(Tbl::St))
        .with("mp", table(Tbl::Mp))
        .with("ro", J::Obj(ro))
        .with("sl", J::Obj(std::mem::take(&mut cx.sl)))
        .with("cs", J::Obj(std::mem::take(&mut cx.cs)))
        .with("bi", J::Arr(std::mem::take(&mut cx.bi)))
        .with("bidt", J::Obj(std::mem::take(&mut cx.bidt)));
    let mut json = String::new();
    root.write(&mut json);
    Ok(HwpJsonExport { json, skipped: cx.skipped })
}

/// HWPX 패키지(zip) → hwpjson. GUID 접두는 내용 해시로 정한다(같은 조각은 같은 결과).
pub fn hwpx_package_to_hwpjson(bytes: &[u8], section_start: bool) -> Result<HwpJsonExport, HwpError> {
    let (header_xml, section_xml, bins, master_pages) = read_hwpx_package(bytes)?;
    let mut seed: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in section_xml.as_bytes() {
        seed = (seed ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
    }
    hwpx_to_hwpjson(HwpxFragment {
        header_xml: &header_xml,
        section_xml: &section_xml,
        bins,
        master_pages,
        section_start,
        seed,
    })
}

/// 한글이 클립보드 HTML 끝에 싣는 보드 요소. `data-jsonlen` 은 JSON 의 UTF-8 바이트 수다(실측).
pub fn hancom_board_html(json: &str) -> String {
    format!(
        "<div id='hwpEditorBoardContent' class='hwp_editor_board_content' data-hjsonver='1.0' data-jsonlen='{}'><!--[data-hwpjson]{}--></div>",
        json.len(),
        json
    )
}
