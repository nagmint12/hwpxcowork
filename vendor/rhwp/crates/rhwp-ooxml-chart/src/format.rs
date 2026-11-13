//! [hwpx-cowork] 차트 구성 편집 — 한/글 2022 '차트 디자인' 도구 상자의 차트 종류 변경(ChangeChart)·
//! 차트 구성 추가(제목·범례·데이터 레이블·축·축 제목·눈금선)를 **한/글이 같은 조작으로 저장하는 꼴**로 쓴다.
//!
//! 근거: 한/글 2022(12.0.0.3146) COM 실측 2026-11-11 — `tests/fixtures/chart_hangul.hwpx` 를 열어 `ChangeChart`
//! (`ChartObjShape{ChartGroup, ChartIndex}`)·`ChartLayoutList` 를 실행하고 다시 저장한 `Chart/chart1.xml`
//! (원장 `research/hangul2022-features-20261111/impl/ledger_chart.md` 0절). 요소 이름·차례·기본값은 그 저장본을 따른다.

use crate::xml_tree::{El, Node, XmlDoc};
use serde_like::Json;

/// 한/글 갤러리 좌표(`ChartGroup`, `ChartIndex`) → 이 모듈이 쓰는 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// 막대 — 가로(`bar`)/세로(`col`), 묶음 방식, 3차원 상자.
    Bar { horizontal: bool, grouping: &'static str, three_d: bool },
    /// 꺾은선 — 표식 여부, 3차원.
    Line { grouping: &'static str, markers: bool, three_d: bool },
    /// 영역(2차원만 — 3차원 영역은 그리기가 없어 받지 않는다).
    Area { grouping: &'static str },
    /// 원형 — 쪼개짐, 3차원.
    Pie { exploded: bool, three_d: bool },
    /// 원형 대 원형(false)/원형 대 가로 막대(true).
    OfPie { bar: bool },
    /// [hwpx-cowork] 도넛형·쪼개진 도넛형(마지막 계열만 explosion 25 — 한/글 실측).
    Doughnut { exploded: bool },
    /// [hwpx-cowork] 분산형 — scatterStyle(marker·smoothMarker·smooth·lineMarker·line, 한/글 갤러리 차례).
    Scatter { style: &'static str },
}

const SCATTER_STYLES: [&str; 5] = ["marker", "smoothMarker", "smooth", "lineMarker", "line"];

const GROUPINGS: [&str; 3] = ["clustered", "stacked", "percentStacked"];
const LINE_GROUPINGS: [&str; 3] = ["standard", "stacked", "percentStacked"];

/// 받는 종류 목록(갤러리 좌표, 한/글 이름). 그리기가 없는 종류(원통·원뿔·피라미드·3차원 영역·도넛·분산형·거품형·주식형·방사형·표면형)는 뺐다.
pub const SUPPORTED_KINDS: &[(u8, u8, &str)] = &[
    (0, 0, "묶은 가로 막대형"),
    (0, 1, "누적 가로 막대형"),
    (0, 2, "100% 기준 누적 가로 막대형"),
    (0, 3, "3차원 묶은 가로 막대형"),
    (0, 4, "3차원 누적 가로 막대형"),
    (0, 5, "3차원 100% 기준 누적 가로 막대형"),
    (1, 0, "묶은 세로 막대형"),
    (1, 1, "누적 세로 막대형"),
    (1, 2, "100% 기준 누적 세로 막대형"),
    (1, 3, "3차원 묶은 세로 막대형"),
    (1, 4, "3차원 누적 세로 막대형"),
    (1, 5, "3차원 100% 기준 누적 세로 막대형"),
    (1, 6, "3차원 세로 막대형"),
    (2, 0, "꺾은선형"),
    (2, 1, "누적 꺾은선형"),
    (2, 2, "100% 기준 누적 꺾은선형"),
    (2, 3, "표식이 있는 꺾은선형"),
    (2, 4, "표식이 있는 누적 꺾은선형"),
    (2, 5, "표식이 있는 100% 기준 누적 꺾은선형"),
    (2, 6, "3차원 꺾은선형"),
    (2, 7, "영역형"),
    (2, 8, "누적 영역형"),
    (2, 9, "100% 기준 누적 영역형"),
    (3, 0, "2차원 원형"),
    (3, 1, "쪼개진 원형"),
    (3, 2, "원형 대 원형"),
    (3, 3, "원형 대 가로 막대형"),
    (3, 4, "3차원 원형"),
    (3, 5, "3차원 쪼개진 원형"),
    (3, 6, "도넛형"),
    (3, 7, "쪼개진 도넛형"),
    (4, 0, "표식만 있는 분산형"),
    (4, 1, "곡선 및 표식이 있는 분산형"),
    (4, 2, "곡선이 있는 분산형"),
    (4, 3, "직선 및 표식이 있는 분산형"),
    (4, 4, "직선이 있는 분산형"),
];

pub fn family_of(group: u8, index: u8) -> Option<Family> {
    let i = index as usize;
    Some(match (group, index) {
        (0 | 1, 0..=2) => Family::Bar { horizontal: group == 0, grouping: GROUPINGS[i], three_d: false },
        (0 | 1, 3..=5) => Family::Bar { horizontal: group == 0, grouping: GROUPINGS[i - 3], three_d: true },
        (1, 6) => Family::Bar { horizontal: false, grouping: "standard", three_d: true },
        (2, 0..=2) => Family::Line { grouping: LINE_GROUPINGS[i], markers: false, three_d: false },
        (2, 3..=5) => Family::Line { grouping: LINE_GROUPINGS[i - 3], markers: true, three_d: false },
        (2, 6) => Family::Line { grouping: "standard", markers: false, three_d: true },
        (2, 7..=9) => Family::Area { grouping: LINE_GROUPINGS[i - 7] },
        (3, 0) => Family::Pie { exploded: false, three_d: false },
        (3, 1) => Family::Pie { exploded: true, three_d: false },
        (3, 2) => Family::OfPie { bar: false },
        (3, 3) => Family::OfPie { bar: true },
        (3, 4) => Family::Pie { exploded: false, three_d: true },
        (3, 5) => Family::Pie { exploded: true, three_d: true },
        (3, 6) => Family::Doughnut { exploded: false },
        (3, 7) => Family::Doughnut { exploded: true },
        (4, 0..=4) => Family::Scatter { style: SCATTER_STYLES[i] },
        _ => return None,
    })
}

/// 지금 차트의 갤러리 좌표(알아볼 수 없으면 None).
fn kind_of(chart: &El) -> Option<(u8, u8)> {
    let plot = chart.child("plotArea")?.elems().find(|e| e.local().ends_with("Chart"))?;
    let grouping = plot.child_val("grouping").unwrap_or("standard");
    let gi = |list: &[&str; 3], g: &str| list.iter().position(|x| *x == g).map(|p| p as u8);
    match plot.local() {
        "barChart" | "bar3DChart" => {
            let h = plot.child_val("barDir") == Some("bar");
            let three = plot.local() == "bar3DChart";
            if three && plot.child_val("shape").is_some_and(|s| s != "box") {
                return None;
            }
            if three && grouping == "standard" {
                return (!h).then_some((1, 6));
            }
            let g = gi(&GROUPINGS, grouping).or((grouping == "standard").then_some(0))?;
            Some((if h { 0 } else { 1 }, g + if three { 3 } else { 0 }))
        }
        "lineChart" => {
            let g = gi(&LINE_GROUPINGS, grouping)?;
            let markers = plot.children("ser").any(|s| {
                s.child("marker").is_none_or(|m| m.child_val("symbol") != Some("none"))
            });
            Some((2, g + if markers { 3 } else { 0 }))
        }
        "line3DChart" => Some((2, 6)),
        "areaChart" => Some((2, 7 + gi(&LINE_GROUPINGS, grouping)?)),
        "pieChart" | "pie3DChart" => {
            let exploded = plot.children("ser").any(|s| s.child_val("explosion").is_some_and(|v| v != "0"));
            let three = plot.local() == "pie3DChart";
            Some((3, match (three, exploded) {
                (false, false) => 0,
                (false, true) => 1,
                (true, false) => 4,
                (true, true) => 5,
            }))
        }
        "ofPieChart" => Some((3, if plot.child_val("ofPieType") == Some("bar") { 3 } else { 2 })),
        "scatterChart" => {
            let st = plot.child_val("scatterStyle").unwrap_or("marker");
            SCATTER_STYLES.iter().position(|x| *x == st).map(|i| (4, i as u8))
        }
        "doughnutChart" => {
            let exploded = plot.children("ser").any(|s| s.child_val("explosion").is_some_and(|v| v != "0"));
            Some((3, if exploded { 7 } else { 6 }))
        }
        _ => None,
    }
}

// ───────────── 작은 JSON(serde 없이 — 이 상자는 quick-xml 만 쓴다) ─────────────
mod serde_like {
    /// 읽기 전용 JSON 값.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Json {
        Null,
        Bool(bool),
        Num(f64),
        Str(String),
        Arr(Vec<Json>),
        Obj(Vec<(String, Json)>),
    }

    impl Json {
        pub fn get(&self, k: &str) -> Option<&Json> {
            match self {
                Json::Obj(v) => v.iter().find(|(n, _)| n == k).map(|(_, j)| j),
                _ => None,
            }
        }
        pub fn as_str(&self) -> Option<&str> {
            match self {
                Json::Str(s) => Some(s),
                _ => None,
            }
        }
        pub fn as_bool(&self) -> Option<bool> {
            match self {
                Json::Bool(b) => Some(*b),
                _ => None,
            }
        }
        pub fn as_f64(&self) -> Option<f64> {
            match self {
                Json::Num(n) => Some(*n),
                _ => None,
            }
        }
        pub fn parse(s: &str) -> Result<Json, String> {
            let b = s.as_bytes();
            let mut i = 0;
            let v = value(b, &mut i)?;
            ws(b, &mut i);
            if i != b.len() {
                return Err(format!("JSON 끝에 남는 글이 있습니다({i})"));
            }
            Ok(v)
        }
    }

    fn ws(b: &[u8], i: &mut usize) {
        while *i < b.len() && b[*i].is_ascii_whitespace() {
            *i += 1;
        }
    }

    fn value(b: &[u8], i: &mut usize) -> Result<Json, String> {
        ws(b, i);
        match b.get(*i) {
            Some(b'{') => {
                *i += 1;
                let mut v = Vec::new();
                ws(b, i);
                if b.get(*i) == Some(&b'}') {
                    *i += 1;
                    return Ok(Json::Obj(v));
                }
                loop {
                    ws(b, i);
                    let k = string(b, i)?;
                    ws(b, i);
                    if b.get(*i) != Some(&b':') {
                        return Err("':' 가 필요합니다".into());
                    }
                    *i += 1;
                    v.push((k, value(b, i)?));
                    ws(b, i);
                    match b.get(*i) {
                        Some(b',') => *i += 1,
                        Some(b'}') => {
                            *i += 1;
                            return Ok(Json::Obj(v));
                        }
                        _ => return Err("',' 나 '}' 가 필요합니다".into()),
                    }
                }
            }
            Some(b'[') => {
                *i += 1;
                let mut v = Vec::new();
                ws(b, i);
                if b.get(*i) == Some(&b']') {
                    *i += 1;
                    return Ok(Json::Arr(v));
                }
                loop {
                    v.push(value(b, i)?);
                    ws(b, i);
                    match b.get(*i) {
                        Some(b',') => *i += 1,
                        Some(b']') => {
                            *i += 1;
                            return Ok(Json::Arr(v));
                        }
                        _ => return Err("',' 나 ']' 가 필요합니다".into()),
                    }
                }
            }
            Some(b'"') => Ok(Json::Str(string(b, i)?)),
            Some(b't') if b[*i..].starts_with(b"true") => {
                *i += 4;
                Ok(Json::Bool(true))
            }
            Some(b'f') if b[*i..].starts_with(b"false") => {
                *i += 5;
                Ok(Json::Bool(false))
            }
            Some(b'n') if b[*i..].starts_with(b"null") => {
                *i += 4;
                Ok(Json::Null)
            }
            Some(_) => {
                let s = *i;
                while *i < b.len() && matches!(b[*i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    *i += 1;
                }
                std::str::from_utf8(&b[s..*i])
                    .ok()
                    .and_then(|t| t.parse().ok())
                    .map(Json::Num)
                    .ok_or_else(|| format!("JSON 값을 읽지 못했습니다({s})"))
            }
            None => Err("JSON 이 끝났습니다".into()),
        }
    }

    fn string(b: &[u8], i: &mut usize) -> Result<String, String> {
        if b.get(*i) != Some(&b'"') {
            return Err("문자열이 필요합니다".into());
        }
        *i += 1;
        let mut out: Vec<u16> = Vec::new();
        let mut bytes: Vec<u8> = Vec::new();
        let flush = |bytes: &mut Vec<u8>, out: &mut Vec<u16>| {
            if !bytes.is_empty() {
                out.extend(String::from_utf8_lossy(bytes).encode_utf16());
                bytes.clear();
            }
        };
        loop {
            match b.get(*i) {
                None => return Err("문자열이 닫히지 않았습니다".into()),
                Some(b'"') => {
                    *i += 1;
                    flush(&mut bytes, &mut out);
                    return Ok(String::from_utf16_lossy(&out));
                }
                Some(b'\\') => {
                    flush(&mut bytes, &mut out);
                    *i += 1;
                    let c = *b.get(*i).ok_or("이스케이프가 끝났습니다")?;
                    *i += 1;
                    match c {
                        b'n' => out.push(10),
                        b't' => out.push(9),
                        b'r' => out.push(13),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'u' => {
                            let h = std::str::from_utf8(b.get(*i..*i + 4).ok_or("\\u 가 짧습니다")?)
                                .map_err(|e| e.to_string())?;
                            out.push(u16::from_str_radix(h, 16).map_err(|e| e.to_string())?);
                            *i += 4;
                        }
                        other => out.push(other as u16),
                    }
                }
                Some(&c) => {
                    bytes.push(c);
                    *i += 1;
                }
            }
        }
    }

    pub fn quote(s: &str) -> String {
        let mut o = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                '\n' => o.push_str("\\n"),
                '\r' => o.push_str("\\r"),
                '\t' => o.push_str("\\t"),
                c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
                c => o.push(c),
            }
        }
        o.push('"');
        o
    }
}

pub use serde_like::quote as json_quote;

// ───────────── 차례표(한/글 저장본의 요소 차례) ─────────────

/// `c:chart` 의 자식 차례.
const CHART_ORDER: &[&str] = &[
    "title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall", "plotArea", "legend",
    "plotVisOnly", "dispBlanksAs", "showDLblsOverMax", "extLst",
];
/// 축 자식 차례 — 한/글 저장본은 ECMA 와 달리 `axPos`·`crossAx` 를 앞에 둔다(실측).
const AXIS_ORDER: &[&str] = &[
    "axId", "scaling", "axPos", "crossAx", "delete", "majorGridlines", "minorGridlines", "title", "numFmt",
    "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crosses", "crossesAt", "crossBetween", "auto",
    "lblAlgn", "lblOffset", "tickLblSkip", "tickMarkSkip", "noMultiLvlLbl", "majorUnit", "minorUnit", "dispUnits",
    "extLst",
];
/// plot 요소 자식 차례(막대·꺾은선·영역·원형 공통 상위 집합).
const PLOT_ORDER: &[&str] = &[
    "barDir", "ofPieType", "grouping", "varyColors", "ser", "dLbls", "dropLines", "hiLowLines", "upDownBars",
    "gapWidth", "overlap", "gapDepth", "shape", "marker", "smooth", "serLines", "firstSliceAng", "holeSize",
    "secondPieSize", "splitType", "splitPos", "axId", "extLst",
];
/// `c:title` 자식 차례.
const TITLE_ORDER: &[&str] = &["tx", "layout", "overlay", "spPr", "txPr", "extLst"];

struct Ns {
    c: String,
    a: String,
}

impl Ns {
    fn c(&self, local: &str) -> String {
        if self.c.is_empty() {
            local.to_string()
        } else {
            format!("{}:{}", self.c, local)
        }
    }
    fn a(&self, local: &str) -> String {
        format!("{}:{}", self.a, local)
    }
}

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

fn namespaces(doc: &mut XmlDoc) -> Ns {
    let root = &mut doc.root;
    let prefix_for = |root: &El, uri: &str| -> Option<String> {
        root.attrs.iter().find(|(k, v)| v == uri && k.starts_with("xmlns")).map(|(k, _)| {
            k.strip_prefix("xmlns:").unwrap_or("").to_string()
        })
    };
    let c = prefix_for(root, NS_C).unwrap_or_else(|| {
        root.name.split_once(':').map(|(p, _)| p.to_string()).unwrap_or_default()
    });
    let a = match prefix_for(root, NS_A) {
        Some(a) if !a.is_empty() => a,
        _ => {
            root.attrs.push(("xmlns:a".to_string(), NS_A.to_string()));
            "a".to_string()
        }
    };
    Ns { c, a }
}

// ───────────── 차트 상태 읽기 ─────────────

fn rich_text(title: &El) -> Option<String> {
    let rich = title.child("tx")?.child("rich")?;
    let paras: Vec<String> = rich
        .children("p")
        .map(|p| {
            let mut s = String::new();
            for r in p.elems() {
                match r.local() {
                    "r" | "fld" => {
                        if let Some(t) = r.child("t") {
                            s.push_str(&t.text());
                        }
                    }
                    "br" => s.push('\n'),
                    _ => {}
                }
            }
            s
        })
        .collect();
    Some(paras.join("\n"))
}

fn axes(plot_area: &El) -> Vec<&El> {
    plot_area
        .elems()
        .filter(|e| matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx"))
        .collect()
}

fn is_horizontal_bar(plot_area: &El) -> bool {
    plot_area
        .elems()
        .find(|e| e.local().ends_with("Chart"))
        .is_some_and(|p| matches!(p.local(), "barChart" | "bar3DChart") && p.child_val("barDir") == Some("bar"))
}

/// 기본 가로 축(`false`)·세로 축(`true`)의 요소 차례 번호(plotArea 자식 기준). 첫 plot 이 쓰는 축 두 개에서 고른다.
/// 세로 막대·꺾은선·영역은 가로 = 항목 축, 세로 = 값 축. 가로 막대는 반대(한/글은 가로 막대에도 axPos 를 b/l 로 둔다 — 실측).
fn primary_axis_index(plot_area: &El, vertical: bool) -> Option<usize> {
    let plot = plot_area.elems().find(|e| e.local().ends_with("Chart"))?;
    let ids: Vec<&str> = plot.children("axId").filter_map(|a| a.attr("val")).collect();
    let horizontal_bar = is_horizontal_bar(plot_area);
    let want_value = vertical != horizontal_bar;
    let scatter = plot.local() == "scatterChart";
    let mut pick = None;
    for (i, n) in plot_area.kids.iter().enumerate() {
        let Node::El(e) = n else { continue };
        if !matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx") {
            continue;
        }
        let id = e.child_val("axId").unwrap_or("");
        if !ids.is_empty() && !ids.contains(&id) {
            continue;
        }
        let ok = if scatter {
            let pos = e.child_val("axPos").unwrap_or("b");
            (matches!(pos, "l" | "r")) == vertical
        } else {
            (e.local() == "valAx") == want_value
        };
        if ok {
            pick = Some(i);
            break;
        }
    }
    pick
}

fn el_at(parent: &El, i: usize) -> &El {
    match &parent.kids[i] {
        Node::El(e) => e,
        _ => unreachable!(),
    }
}

fn el_at_mut(parent: &mut El, i: usize) -> &mut El {
    match &mut parent.kids[i] {
        Node::El(e) => e,
        _ => unreachable!(),
    }
}

/// 차트 구성 상태(JSON). 편집기 '차트 구성' 창이 처음 값을 고를 때 쓴다.
pub fn chart_format_json(xml: &[u8]) -> Result<String, String> {
    let doc = XmlDoc::parse(xml)?;
    let chart = doc.root.child("chart").ok_or("c:chart 가 없습니다")?;
    let plot_area = chart.child("plotArea").ok_or("c:plotArea 가 없습니다")?;
    let plots: Vec<&El> = plot_area.elems().filter(|e| e.local().ends_with("Chart")).collect();
    let mut o: Vec<(String, String)> = Vec::new();
    let mut push = |k: &str, v: String| o.push((k.to_string(), v));
    match kind_of(chart) {
        Some((g, i)) if plots.len() == 1 => {
            push("group", g.to_string());
            push("index", i.to_string());
        }
        _ => {
            push("group", "null".into());
            push("index", "null".into());
        }
    }
    push(
        "plots",
        format!("[{}]", plots.iter().map(|p| json_quote(p.local())).collect::<Vec<_>>().join(",")),
    );
    let title = chart.child("title");
    let auto_deleted = chart.child_val("autoTitleDeleted") == Some("1");
    let title_mode = match title {
        None => "none",
        Some(t) if t.child_val("overlay") == Some("1") => "overlay",
        Some(_) => "top",
    };
    let _ = auto_deleted;
    push("title", json_quote(title_mode));
    push(
        "titleText",
        title.and_then(rich_text).map(|t| json_quote(&t)).unwrap_or_else(|| "null".into()),
    );
    let legend = chart
        .child("legend")
        .map(|l| match l.child_val("legendPos").unwrap_or("r") {
            "t" => "top",
            "l" => "left",
            "b" => "bottom",
            "tr" => "topRight",
            _ => "right",
        })
        .unwrap_or("none");
    push("legend", json_quote(legend));
    let labels = plots.iter().any(|p| {
        p.child("dLbls").is_some_and(|d| d.child_val("showVal") == Some("1") || d.child_val("showPercent") == Some("1"))
            || p.children("ser").any(|s| {
                s.child("dLbls").is_some_and(|d| d.child_val("delete") != Some("1") && (d.child_val("showVal") == Some("1") || d.child_val("showPercent") == Some("1")))
            })
    });
    push("dataLabels", labels.to_string());
    let pie = plots.iter().any(|p| matches!(p.local(), "pieChart" | "pie3DChart" | "ofPieChart" | "doughnutChart"));
    push("hasAxes", (!pie && !axes(plot_area).is_empty()).to_string());
    for (key, vertical) in [("horizontalAxis", false), ("verticalAxis", true)] {
        let v = match primary_axis_index(plot_area, vertical) {
            Some(i) => {
                let ax = el_at(plot_area, i);
                let t = ax.child("title");
                format!(
                    "{{\"kind\":{},\"visible\":{},\"majorGrid\":{},\"minorGrid\":{},\"title\":{},\"titleText\":{}}}",
                    json_quote(ax.local()),
                    ax.child_val("delete") != Some("1"),
                    ax.child("majorGridlines").is_some(),
                    ax.child("minorGridlines").is_some(),
                    t.is_some(),
                    t.and_then(rich_text).map(|s| json_quote(&s)).unwrap_or_else(|| "null".into())
                )
            }
            None => "null".into(),
        };
        push(key, v);
    }
    let names: Vec<String> = plots
        .iter()
        .flat_map(|p| p.children("ser"))
        .map(|s| {
            s.child("tx").map(|t| t.text()).map(|t| json_quote(&t)).unwrap_or_else(|| "null".into())
        })
        .collect();
    push("series", format!("[{}]", names.join(",")));
    let body: Vec<String> = o.iter().map(|(k, v)| format!("{}:{}", json_quote(k), v)).collect();
    Ok(format!("{{{}}}", body.join(",")))
}

// ───────────── 편집 ─────────────

/// 한/글 제목 요소 꼴(글이 없으면 자동 제목 — `c:txPr` 만, 실측). 글이 있으면 `c:tx/c:rich`.
fn title_el(ns: &Ns, overlay: bool, text: Option<&str>, vertical_axis: bool) -> El {
    let body_pr = |rot: &str| {
        El::new(ns.a("bodyPr"))
            .with_attr("rot", rot)
            .with_attr("vert", "horz")
            .with_attr("wrap", "none")
            .with_attr("lIns", "0")
            .with_attr("tIns", "0")
            .with_attr("rIns", "0")
            .with_attr("bIns", "0")
            .with_attr("anchor", "ctr")
            .with_attr("anchorCtr", "1")
    };
    let rot = if vertical_axis { "-5400000" } else { "0" };
    let def_rpr = || El::new(ns.a("defRPr")).with_attr("b", "0").with_attr("i", "0").with_attr("u", "none");
    let mut t = El::new(ns.c("title"));
    match text.filter(|s| !s.is_empty()) {
        Some(text) => {
            let mut rich = El::new(ns.c("rich")).with(body_pr(rot));
            for line in text.split('\n') {
                let mut p = El::new(ns.a("p")).with(El::new(ns.a("pPr")).with(def_rpr()));
                if !line.is_empty() {
                    p = p.with(
                        El::new(ns.a("r"))
                            .with(El::new(ns.a("rPr")).with_attr("lang", "ko-KR").with_attr("altLang", "en-US").with_attr("b", "0"))
                            .with(El::new(ns.a("t")).with_text(line)),
                    );
                }
                rich = rich.with(p);
            }
            t = t.with(El::new(ns.c("tx")).with(rich));
            t = t.with(El::new(ns.c("layout")));
            t = t.with(El::val(ns.c("overlay"), if overlay { "1" } else { "0" }));
        }
        None => {
            t = t.with(El::new(ns.c("layout")));
            t = t.with(El::val(ns.c("overlay"), if overlay { "1" } else { "0" }));
            t = t.with(
                El::new(ns.c("txPr")).with(body_pr(rot)).with(
                    El::new(ns.a("p"))
                        .with(El::new(ns.a("pPr")).with_attr("algn", "l").with(def_rpr()))
                        .with(El::new(ns.a("endParaRPr"))),
                ),
            );
        }
    }
    t
}

/// 기존 제목 요소의 글만 바꾼다(겹치기·서식은 그대로). `None` 은 그대로 둔다.
fn retitle(ns: &Ns, t: &mut El, text: &str, vertical_axis: bool) {
    let overlay = t.child_val("overlay") == Some("1");
    let fresh = title_el(ns, overlay, Some(text), vertical_axis);
    t.remove_all("tx");
    if text.is_empty() {
        if t.child("txPr").is_none() {
            if let Some(tx) = title_el(ns, overlay, None, vertical_axis).child("txPr").cloned() {
                t.put_ordered(tx, TITLE_ORDER);
            }
        }
        return;
    }
    if let Some(tx) = fresh.child("tx").cloned() {
        t.insert_ordered(tx, TITLE_ORDER);
    }
    // 글이 있으면 자동 제목용 txPr 는 rich 의 bodyPr 와 겹친다 — 한/글 저장본(글 없는 꼴)에만 있으므로 지운다
    t.remove_all("txPr");
}

/// 데이터 레이블 요소 — 한/글 레이아웃 실측 꼴. `pos` 없으면 dLblPos 를 쓰지 않는다(꺾은선 기본·영역·원형 변환).
fn dlbls_el(ns: &Ns, pos: Option<&str>) -> El {
    let mut d = El::new(ns.c("dLbls")).with(El::val(ns.c("delete"), "0"));
    if let Some(p) = pos {
        d = d.with(El::val(ns.c("dLblPos"), p));
    }
    for (k, v) in [
        ("showLegendKey", "0"),
        ("showVal", "1"),
        ("showCatName", "0"),
        ("showSerName", "0"),
        ("showPercent", "0"),
        ("showBubbleSize", "0"),
        ("showLeaderLines", "0"),
    ] {
        d = d.with(El::val(ns.c(k), v));
    }
    d
}

fn default_label_pos(plot: &El) -> Option<&'static str> {
    match plot.local() {
        "barChart" | "bar3DChart" => Some(match plot.child_val("grouping") {
            Some("stacked") | Some("percentStacked") => "ctr",
            _ => "outEnd",
        }),
        "lineChart" | "line3DChart" => Some("r"),
        "pieChart" | "pie3DChart" | "ofPieChart" | "doughnutChart" => Some("ctr"),
        _ => None,
    }
}

/// 종류에 맞지 않는 dLblPos 를 고친다(한/글: 막대 outEnd → 꺾은선 r, 원형으로 바꾸면 지움 — 실측).
fn fix_label_pos(d: &mut El, plot_local: &str, grouping: &str) {
    let ok: &[&str] = match plot_local {
        "barChart" | "bar3DChart" if grouping == "clustered" || grouping == "standard" => &["outEnd", "inEnd", "ctr", "inBase"],
        "barChart" | "bar3DChart" => &["inEnd", "ctr", "inBase"],
        "lineChart" | "line3DChart" => &["r", "l", "t", "b", "ctr"],
        _ => &[],
    };
    let cur = d.child_val("dLblPos").map(str::to_string);
    match cur {
        Some(p) if ok.contains(&p.as_str()) => {}
        Some(_) if plot_local.starts_with("line") => {
            if let Some(e) = d.child_mut("dLblPos") {
                e.set_attr("val", "r");
            }
        }
        Some(_) if plot_local.starts_with("bar") => {
            if let Some(e) = d.child_mut("dLblPos") {
                e.set_attr("val", if ok.contains(&"outEnd") { "outEnd" } else { "ctr" });
            }
        }
        Some(_) => {
            d.remove_all("dLblPos");
        }
        None => {}
    }
}

fn ln_solid_accent(ns: &Ns, k: usize) -> El {
    let accent = format!("accent{}", k % 6 + 1);
    let fill = || El::new(ns.a("solidFill")).with(El::val(ns.a("schemeClr"), accent.clone()));
    El::new(ns.c("spPr")).with(fill()).with(
        El::new(ns.a("ln"))
            .with_attr("w", "9525")
            .with_attr("cap", "flat")
            .with_attr("cmpd", "sng")
            .with_attr("algn", "ctr")
            .with(fill())
            .with(El::val(ns.a("prstDash"), "solid"))
            .with(El::new(ns.a("round")))
            .with(El::new(ns.a("headEnd")).with_attr("w", "med").with_attr("len", "med"))
            .with(El::new(ns.a("tailEnd")).with_attr("w", "med").with_attr("len", "med")),
    )
}

fn point_count(ser: &El) -> usize {
    let block = ser.child("val").or_else(|| ser.child("yVal"));
    block
        .and_then(|b| b.elems().next())
        .and_then(|r| r.elems().find(|c| c.local().ends_with("Cache") || c.local() == "numLit" || c.local() == "strLit"))
        .and_then(|c| c.child_val("ptCount"))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// 계열 하나를 새 종류의 계열 꼴로(한/글 저장본 차례).
fn convert_series(ns: &Ns, ser: &El, fam: Family, pos: usize, count: usize) -> El {
    let mut out = El { name: ser.name.clone(), attrs: ser.attrs.clone(), kids: Vec::new() };
    let keep = |l: &str| ser.child(l).cloned();
    for l in ["idx", "order", "tx"] {
        if let Some(e) = keep(l) {
            out.kids.push(Node::El(e));
        }
    }
    // 계열 선·채우기(빈 spPr 는 한/글도 지운다 — 실측). 원형은 점마다 dPt 로 칠한다.
    let sp = ser.child("spPr").filter(|s| !s.kids.is_empty()).cloned();
    let cat = ser.child("cat").cloned().or_else(|| {
        ser.child("xVal").cloned().map(|mut x| {
            x.name = ns.c("cat");
            x
        })
    });
    let val = ser.child("val").cloned().or_else(|| {
        ser.child("yVal").cloned().map(|mut y| {
            y.name = ns.c("val");
            y
        })
    });
    let dl = ser.child("dLbls").cloned();
    match fam {
        Family::Bar { .. } => {
            if let Some(s) = sp {
                out.kids.push(Node::El(s));
            }
            out.kids.push(Node::El(El::val(ns.c("invertIfNegative"), "0")));
            if let Some(d) = dl {
                out.kids.push(Node::El(d));
            }
        }
        Family::Line { markers, .. } => {
            if let Some(s) = sp {
                out.kids.push(Node::El(s));
            }
            let mut m = El::new(ns.c("marker"));
            if !markers {
                m = m.with(El::val(ns.c("symbol"), "none"));
            }
            m = m.with(El::val(ns.c("size"), "7"));
            out.kids.push(Node::El(m));
            if let Some(d) = dl {
                out.kids.push(Node::El(d));
            }
        }
        Family::Area { .. } => {
            if let Some(s) = sp {
                out.kids.push(Node::El(s));
            }
            if let Some(d) = dl {
                out.kids.push(Node::El(d));
            }
        }
        Family::Pie { .. } | Family::OfPie { .. } | Family::Doughnut { .. } => {
            // 쪼개진 원형은 모든 계열, 쪼개진 도넛형은 마지막 계열(바깥 고리)만 25(실측)
            let ex = match fam {
                Family::Pie { exploded: true, .. } => "25",
                Family::Doughnut { exploded: true } if pos + 1 == count => "25",
                _ => "0",
            };
            out.kids.push(Node::El(El::val(ns.c("explosion"), ex)));
            let n = point_count(ser) + usize::from(matches!(fam, Family::OfPie { .. }));
            for k in 0..n {
                out.kids.push(Node::El(
                    El::new(ns.c("dPt"))
                        .with(El::val(ns.c("idx"), k.to_string()))
                        .with(El::val(ns.c("invertIfNegative"), "0"))
                        .with(El::val(ns.c("bubble3D"), "0"))
                        .with(El::val(ns.c("explosion"), ex))
                        .with(ln_solid_accent(ns, k)),
                ));
            }
            if let Some(d) = dl {
                out.kids.push(Node::El(d));
            }
        }
        Family::Scatter { .. } => {}
    }
    if let Some(c) = cat {
        out.kids.push(Node::El(c));
    }
    if let Some(v) = val {
        out.kids.push(Node::El(v));
    }
    if matches!(fam, Family::Line { .. }) {
        out.kids.push(Node::El(El::val(ns.c("smooth"), "0")));
    }
    out
}

/// 한/글이 원형 → 막대로 바꿀 때 새로 만드는 축 두 개(실측: 항목 축 numFmt 없음, 값 축 눈금선 없음).
fn fresh_axes(ns: &Ns, cat_id: &str, val_id: &str) -> [El; 2] {
    let common = |id: &str, pos: &str, cross: &str| {
        El::new("")
            .with(El::val(ns.c("axId"), id))
            .with(El::new(ns.c("scaling")).with(El::val(ns.c("orientation"), "minMax")))
            .with(El::val(ns.c("axPos"), pos))
            .with(El::val(ns.c("crossAx"), cross))
            .with(El::val(ns.c("delete"), "0"))
    };
    let mut cat = common(cat_id, "b", val_id);
    cat.name = ns.c("catAx");
    for (k, v) in [
        ("majorTickMark", "out"),
        ("minorTickMark", "none"),
        ("tickLblPos", "nextTo"),
        ("crosses", "autoZero"),
        ("auto", "1"),
        ("lblAlgn", "ctr"),
        ("lblOffset", "100"),
        ("tickMarkSkip", "1"),
        ("noMultiLvlLbl", "0"),
    ] {
        cat.kids.push(Node::El(El::val(ns.c(k), v)));
    }
    let mut val = common(val_id, "l", cat_id);
    val.name = ns.c("valAx");
    val.kids.push(Node::El(
        El::new(ns.c("numFmt")).with_attr("formatCode", "General").with_attr("sourceLinked", "1"),
    ));
    for (k, v) in [
        ("majorTickMark", "out"),
        ("minorTickMark", "none"),
        ("tickLblPos", "nextTo"),
        ("crosses", "autoZero"),
        ("crossBetween", "between"),
    ] {
        val.kids.push(Node::El(El::val(ns.c(k), v)));
    }
    [cat, val]
}

fn view3d(ns: &Ns, pie: bool) -> El {
    let mut v = El::new(ns.c("view3D")).with(El::val(ns.c("rAngAx"), "1"));
    for (k, val) in [
        ("rotX", if pie { "30" } else { "15" }),
        ("rotY", if pie { "0" } else { "20" }),
        ("perspective", "30"),
        ("hPercent", "100"),
        ("depthPercent", "100"),
    ] {
        v = v.with(El::val(ns.c(k), val));
    }
    v
}

/// 차트 종류를 바꾼다(`ChangeChart` 꼴). 계열의 이름·항목·값·참조식·선 색은 그대로 옮긴다.
fn change_kind(doc: &mut XmlDoc, ns: &Ns, fam: Family) -> Result<(), String> {
    let chart = doc.root.child_mut("chart").ok_or("c:chart 가 없습니다")?;
    let plot_area = chart.child_mut("plotArea").ok_or("c:plotArea 가 없습니다")?;
    let plot_pos: Vec<usize> = plot_area
        .kids
        .iter()
        .enumerate()
        .filter_map(|(i, n)| matches!(n, Node::El(e) if e.local().ends_with("Chart")).then_some(i))
        .collect();
    let first = *plot_pos.first().ok_or("차트 그림(plot) 요소가 없습니다")?;
    let old_first = el_at(plot_area, first).clone();
    if matches!(old_first.local(), "stockChart" | "surfaceChart" | "surface3DChart" | "bubbleChart" | "radarChart") {
        return Err(format!("{} 차트의 종류 바꾸기는 아직 받지 않습니다", old_first.local()));
    }
    let mut sers: Vec<El> = Vec::new();
    for &i in &plot_pos {
        sers.extend(el_at(plot_area, i).children("ser").cloned());
    }
    if sers.is_empty() {
        return Err("계열이 없습니다".into());
    }
    let ax_ids: Vec<String> = plot_pos
        .iter()
        .map(|&i| el_at(plot_area, i))
        .find_map(|p| {
            let v: Vec<String> = p.children("axId").filter_map(|a| a.attr("val").map(str::to_string)).collect();
            (v.len() >= 2).then_some(v)
        })
        .unwrap_or_default();
    if let Family::Scatter { style } = fam {
        return change_to_scatter(doc, ns, style, &plot_pos, sers, ax_ids);
    }
    let plot_dlbls = old_first.child("dLbls").cloned();
    let old_gap = matches!(old_first.local(), "barChart" | "bar3DChart")
        .then(|| old_first.child_val("gapWidth").map(str::to_string))
        .flatten();
    // 옛 plot 들을 지우고 첫 자리에 새 plot 을 넣는다
    for &i in plot_pos.iter().rev() {
        plot_area.kids.remove(i);
    }
    let needs_axes = !matches!(fam, Family::Pie { .. } | Family::OfPie { .. } | Family::Doughnut { .. });
    let (cat_id, val_id) = if ax_ids.len() >= 2 {
        (ax_ids[0].clone(), ax_ids[1].clone())
    } else {
        ("1001".to_string(), "1002".to_string())
    };

    let mut plot = El::new(match fam {
        Family::Bar { three_d: false, .. } => ns.c("barChart"),
        Family::Bar { three_d: true, .. } => ns.c("bar3DChart"),
        Family::Line { three_d: false, .. } => ns.c("lineChart"),
        Family::Line { three_d: true, .. } => ns.c("line3DChart"),
        Family::Area { .. } => ns.c("areaChart"),
        Family::Pie { three_d: false, .. } => ns.c("pieChart"),
        Family::Pie { three_d: true, .. } => ns.c("pie3DChart"),
        Family::OfPie { .. } => ns.c("ofPieChart"),
        Family::Doughnut { .. } => ns.c("doughnutChart"),
        Family::Scatter { .. } => ns.c("scatterChart"),
    });
    let grouping = match fam {
        Family::Bar { grouping, .. } | Family::Line { grouping, .. } | Family::Area { grouping } => Some(grouping),
        _ => None,
    };
    match fam {
        Family::Bar { horizontal, .. } => plot.kids.push(Node::El(El::val(ns.c("barDir"), if horizontal { "bar" } else { "col" }))),
        Family::OfPie { bar } => plot.kids.push(Node::El(El::val(ns.c("ofPieType"), if bar { "bar" } else { "pie" }))),
        _ => {}
    }
    if let Some(g) = grouping {
        plot.kids.push(Node::El(El::val(ns.c("grouping"), g)));
    }
    let pie_like = !needs_axes;
    plot.kids.push(Node::El(El::val(ns.c("varyColors"), if pie_like { "1" } else { "0" })));
    for (k, s) in sers.iter().enumerate() {
        plot.kids.push(Node::El(convert_series(ns, s, fam, k, sers.len())));
    }
    if let Some(mut d) = plot_dlbls {
        fix_label_pos(&mut d, crate::xml_tree::local_of(&plot.name), grouping.unwrap_or(""));
        plot.kids.push(Node::El(d));
    }
    match fam {
        Family::Bar { three_d, grouping, .. } => {
            plot.kids.push(Node::El(El::val(ns.c("gapWidth"), old_gap.unwrap_or_else(|| "150".into()))));
            if three_d {
                plot.kids.push(Node::El(El::val(ns.c("gapDepth"), "150")));
                plot.kids.push(Node::El(El::val(ns.c("shape"), "box")));
            } else {
                let overlap = if grouping == "clustered" { "0" } else { "100" };
                plot.kids.push(Node::El(El::val(ns.c("overlap"), overlap)));
            }
        }
        Family::Line { three_d: false, .. } => {
            plot.kids.push(Node::El(El::val(ns.c("marker"), "1")));
            plot.kids.push(Node::El(El::val(ns.c("smooth"), "0")));
        }
        Family::Line { three_d: true, .. } => plot.kids.push(Node::El(El::val(ns.c("gapDepth"), "150"))),
        Family::Pie { three_d: false, .. } => plot.kids.push(Node::El(El::val(ns.c("firstSliceAng"), "0"))),
        Family::Doughnut { .. } => {
            plot.kids.push(Node::El(El::val(ns.c("firstSliceAng"), "0")));
            plot.kids.push(Node::El(El::val(ns.c("holeSize"), "50")));
        }
        Family::OfPie { .. } => {
            plot.kids.push(Node::El(El::val(ns.c("gapWidth"), "100")));
            plot.kids.push(Node::El(El::val(ns.c("secondPieSize"), "75")));
            plot.kids.push(Node::El(El::new(ns.c("serLines"))));
        }
        _ => {}
    }
    if needs_axes {
        plot.kids.push(Node::El(El::val(ns.c("axId"), cat_id.clone())));
        plot.kids.push(Node::El(El::val(ns.c("axId"), val_id.clone())));
    }
    plot_area.kids.insert(first, Node::El(plot));

    // 축: 원형이면 모두 지우고, 아니면 이 plot 의 두 축만 남긴다(없으면 한/글처럼 새로 만든다)
    if needs_axes {
        plot_area.kids.retain(|n| match n {
            Node::El(e) if matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx") => {
                let id = e.child_val("axId").unwrap_or("");
                id == cat_id || id == val_id
            }
            _ => true,
        });
        let have_cat = axes(plot_area).iter().any(|a| a.child_val("axId") == Some(&cat_id));
        let have_val = axes(plot_area).iter().any(|a| a.child_val("axId") == Some(&val_id));
        if !have_cat || !have_val {
            plot_area.kids.retain(|n| !matches!(n, Node::El(e) if matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx")));
            let [c, v] = fresh_axes(ns, &cat_id, &val_id);
            let at = plot_area
                .kids
                .iter()
                .position(|n| matches!(n, Node::El(e) if e.local() == "spPr" || e.local() == "extLst"))
                .unwrap_or(plot_area.kids.len());
            plot_area.kids.insert(at, Node::El(v));
            plot_area.kids.insert(at, Node::El(c));
        }
        // 분산형에서 온 값 축 두 개 → 항목 축이 필요하다
        for e in plot_area.elems_mut() {
            if e.local() == "valAx" && e.child_val("axId") == Some(&cat_id) {
                e.name = ns.c("catAx");
                e.remove_all("crossBetween");
                if let Some(s) = e.child_mut("scaling") {
                    s.remove_all("logBase");
                }
            }
        }
        // 영역형은 값 축 crossBetween=midCat, 그 밖은 between(실측)
        let cb = if matches!(fam, Family::Area { .. }) { "midCat" } else { "between" };
        // 100% 기준 누적은 값 축 숫자 서식 0%(실측 — 가로/세로 막대·꺾은선·영역 모두). 다른 종류로 바꾸면 0% 를 General 로 되돌린다(추정, 원장).
        let percent = grouping == Some("percentStacked");
        for e in plot_area.elems_mut() {
            if e.local() == "valAx" {
                if let Some(nf) = e.child_mut("numFmt") {
                    if percent {
                        nf.set_attr("formatCode", "0%");
                    } else if nf.attr("formatCode") == Some("0%") {
                        nf.set_attr("formatCode", "General");
                    }
                }
                match e.child_mut("crossBetween") {
                    Some(c) => c.set_attr("val", cb),
                    None => e.insert_ordered(El::val(ns.c("crossBetween"), cb), AXIS_ORDER),
                }
            }
        }
    } else {
        plot_area.kids.retain(|n| !matches!(n, Node::El(e) if matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx")));
    }

    // 3차원 카메라
    let chart = doc.root.child_mut("chart").expect("위에서 확인함");
    match fam {
        Family::Bar { three_d: true, .. } | Family::Line { three_d: true, .. } => chart.put_ordered(view3d(ns, false), CHART_ORDER),
        Family::Pie { three_d: true, .. } => chart.put_ordered(view3d(ns, true), CHART_ORDER),
        _ => {
            chart.remove_all("view3D");
        }
    }
    // 한/글은 종류를 바꾸면 차트 스타일 번호를 -1 로, 문서 색상표(-1)를 기본 색상표 0 으로 쓴다(실측 — 같은 종류를 다시 골라도)
    set_hnc_style(&mut doc.root, "styleIndex", "-1");
    if hnc_style(&doc.root, "colorIndex").as_deref() == Some("-1") {
        set_hnc_style(&mut doc.root, "colorIndex", "0");
    }
    Ok(())
}

fn hnc_style(root: &El, key: &str) -> Option<String> {
    root.child("extLst")?.find("hncChartStyle")?.attr(key).map(str::to_string)
}

/// [hwpx-cowork] 분산형으로 바꾸기 — 한/글 2022 저장 꼴(실측 `hangul_kind_g4i*.xml`): 계열은 항목(cat)을 그대로 X(xVal, 글 참조 그대로)·
/// 값(val)을 Y(yVal)로, 표식만 있는 꼴은 계열 선 없음(ln noFill 28575)+표식 크기 7, 곡선·직선만은 표식 symbol none,
/// 축은 값 축(Y)을 그대로 두고 항목 축을 X 값 축(logBase 2·axPos b)으로 바꿔 Y 뒤에 둔다. 그림은 X 를 1·2·3… 로그 눈금으로 그린다(renderer).
fn change_to_scatter(
    doc: &mut XmlDoc,
    ns: &Ns,
    style: &'static str,
    plot_pos: &[usize],
    sers: Vec<El>,
    ax_ids: Vec<String>,
) -> Result<(), String> {
    let chart = doc.root.child_mut("chart").ok_or("c:chart 가 없습니다")?;
    let plot_area = chart.child_mut("plotArea").ok_or("c:plotArea 가 없습니다")?;
    let first = plot_pos[0];
    for &i in plot_pos.iter().rev() {
        plot_area.kids.remove(i);
    }
    let (x_id, y_id) = if ax_ids.len() >= 2 { (ax_ids[0].clone(), ax_ids[1].clone()) } else { ("1001".into(), "1002".into()) };
    let mut plot = El::new(ns.c("scatterChart"))
        .with(El::val(ns.c("scatterStyle"), style))
        .with(El::val(ns.c("varyColors"), "0"));
    let ln_none = || {
        El::new(ns.c("spPr")).with(
            El::new(ns.a("ln"))
                .with_attr("w", "28575")
                .with_attr("cap", "flat")
                .with_attr("cmpd", "sng")
                .with_attr("algn", "ctr")
                .with(El::new(ns.a("noFill")))
                .with(El::val(ns.a("prstDash"), "solid"))
                .with(El::new(ns.a("round")))
                .with(El::new(ns.a("headEnd")).with_attr("w", "med").with_attr("len", "med"))
                .with(El::new(ns.a("tailEnd")).with_attr("w", "med").with_attr("len", "med")),
        )
    };
    for ser in &sers {
        let mut out = El { name: ser.name.clone(), attrs: ser.attrs.clone(), kids: Vec::new() };
        for l in ["idx", "order", "tx"] {
            if let Some(e) = ser.child(l) {
                out.kids.push(Node::El(e.clone()));
            }
        }
        match style {
            "marker" => {
                out.kids.push(Node::El(ln_none()));
                out.kids.push(Node::El(El::new(ns.c("marker")).with(El::val(ns.c("size"), "7")).with(El::new(ns.c("spPr")))));
            }
            "smooth" | "line" => {
                if let Some(sp) = ser.child("spPr").filter(|s| !s.kids.is_empty()) {
                    out.kids.push(Node::El(sp.clone()));
                }
                out.kids.push(Node::El(El::new(ns.c("marker")).with(El::val(ns.c("symbol"), "none")).with(El::val(ns.c("size"), "7"))));
            }
            _ => {
                if let Some(sp) = ser.child("spPr").filter(|s| !s.kids.is_empty()) {
                    out.kids.push(Node::El(sp.clone()));
                }
            }
        }
        if let Some(d) = ser.child("dLbls") {
            out.kids.push(Node::El(d.clone()));
        }
        let x = ser.child("xVal").or_else(|| ser.child("cat")).cloned();
        let y = ser.child("yVal").or_else(|| ser.child("val")).cloned();
        if let Some(mut x) = x {
            x.name = ns.c("xVal");
            out.kids.push(Node::El(x));
        }
        if let Some(mut y) = y {
            y.name = ns.c("yVal");
            out.kids.push(Node::El(y));
        }
        let smooth = if matches!(style, "smoothMarker" | "smooth") { "1" } else { "0" };
        out.kids.push(Node::El(El::val(ns.c("smooth"), smooth)));
        plot.kids.push(Node::El(out));
    }
    plot.kids.push(Node::El(El::val(ns.c("axId"), x_id.clone())));
    plot.kids.push(Node::El(El::val(ns.c("axId"), y_id.clone())));
    plot_area.kids.insert(first, Node::El(plot));
    // 축: 이미 값 축 둘(분산형)이면 그대로. 아니면 항목 축을 지우고 X 값 축을 Y 값 축 뒤에 넣는다.
    let has_x_val = plot_area.elems().any(|e| e.local() == "valAx" && e.child_val("axId") == Some(&x_id));
    if !has_x_val {
        plot_area.kids.retain(|n| !matches!(n, Node::El(e) if matches!(e.local(), "catAx" | "dateAx" | "serAx")));
        if !plot_area.elems().any(|e| e.local() == "valAx" && e.child_val("axId") == Some(&y_id)) {
            let [_, v] = fresh_axes(ns, &x_id, &y_id);
            plot_area.insert_ordered(v, &["layout", "barChart", "scatterChart", "valAx", "spPr", "extLst"]);
        }
        let mut xa = El::new(ns.c("valAx"))
            .with(El::val(ns.c("axId"), x_id.clone()))
            .with(El::new(ns.c("scaling")).with(El::val(ns.c("logBase"), "2")).with(El::val(ns.c("orientation"), "minMax")))
            .with(El::val(ns.c("axPos"), "b"))
            .with(El::val(ns.c("crossAx"), y_id.clone()))
            .with(El::val(ns.c("delete"), "0"))
            .with(El::new(ns.c("numFmt")).with_attr("formatCode", "General").with_attr("sourceLinked", "1"));
        for (k, v) in [("majorTickMark", "out"), ("minorTickMark", "none"), ("tickLblPos", "nextTo"), ("crosses", "autoZero"), ("crossBetween", "between")] {
            xa.kids.push(Node::El(El::val(ns.c(k), v)));
        }
        let at = plot_area
            .kids
            .iter()
            .rposition(|n| matches!(n, Node::El(e) if e.local() == "valAx"))
            .map(|i| i + 1)
            .unwrap_or(plot_area.kids.len());
        plot_area.kids.insert(at, Node::El(xa));
    }
    chart.remove_all("view3D");
    set_hnc_style(&mut doc.root, "styleIndex", "-1");
    if hnc_style(&doc.root, "colorIndex").as_deref() == Some("-1") {
        set_hnc_style(&mut doc.root, "colorIndex", "0");
    }
    Ok(())
}

fn set_hnc_style(root: &mut El, key: &str, val: &str) {
    fn walk(e: &mut El, key: &str, val: &str) {
        if e.local() == "hncChartStyle" {
            e.set_attr(key, val);
            return;
        }
        for k in e.elems_mut() {
            walk(k, key, val);
        }
    }
    if let Some(ext) = root.child_mut("extLst") {
        walk(ext, key, val);
    }
}

fn set_title(chart: &mut El, ns: &Ns, mode: &str, text: Option<&str>) -> Result<(), String> {
    match mode {
        "none" => {
            chart.remove_all("title");
            chart.put_ordered(El::val(ns.c("autoTitleDeleted"), "1"), CHART_ORDER);
        }
        "top" | "overlay" => {
            let overlay = mode == "overlay";
            match chart.child_mut("title") {
                Some(t) => {
                    t.put_ordered(El::val(ns.c("overlay"), if overlay { "1" } else { "0" }), TITLE_ORDER);
                    if let Some(text) = text {
                        retitle(ns, t, text, false);
                    }
                }
                None => chart.insert_ordered(title_el(ns, overlay, text, false), CHART_ORDER),
            }
            chart.put_ordered(El::val(ns.c("autoTitleDeleted"), "0"), CHART_ORDER);
        }
        other => return Err(format!("제목 위치 '{other}' 를 모릅니다(none|top|overlay)")),
    }
    Ok(())
}

fn set_legend(chart: &mut El, ns: &Ns, pos: &str) -> Result<(), String> {
    let code = match pos {
        "none" => {
            chart.remove_all("legend");
            return Ok(());
        }
        "right" => "r",
        "top" => "t",
        "left" => "l",
        "bottom" => "b",
        other => return Err(format!("범례 위치 '{other}' 를 모릅니다(none|right|top|left|bottom)")),
    };
    match chart.child_mut("legend") {
        Some(l) => match l.child_mut("legendPos") {
            Some(p) => p.set_attr("val", code),
            None => l.kids.insert(0, Node::El(El::val(ns.c("legendPos"), code))),
        },
        None => chart.insert_ordered(
            El::new(ns.c("legend"))
                .with(El::val(ns.c("legendPos"), code))
                .with(El::new(ns.c("layout")))
                .with(El::val(ns.c("overlay"), "0")),
            CHART_ORDER,
        ),
    }
    Ok(())
}

fn set_data_labels(chart: &mut El, ns: &Ns, show: bool) {
    let Some(plot_area) = chart.child_mut("plotArea") else { return };
    for plot in plot_area.elems_mut().filter(|e| e.local().ends_with("Chart")) {
        if show {
            let pos = default_label_pos(plot);
            match plot.child_mut("dLbls") {
                Some(d) => {
                    d.put_ordered(El::val(ns.c("delete"), "0"), DLBLS_ORDER);
                    d.put_ordered(El::val(ns.c("showVal"), "1"), DLBLS_ORDER);
                }
                None => plot.insert_ordered(dlbls_el(ns, pos), PLOT_ORDER),
            }
            for s in plot.elems_mut().filter(|e| e.local() == "ser") {
                if let Some(d) = s.child_mut("dLbls") {
                    d.put_ordered(El::val(ns.c("delete"), "0"), DLBLS_ORDER);
                    d.put_ordered(El::val(ns.c("showVal"), "1"), DLBLS_ORDER);
                }
            }
        } else {
            plot.remove_all("dLbls");
            for s in plot.elems_mut().filter(|e| e.local() == "ser") {
                s.remove_all("dLbls");
            }
        }
    }
}

const DLBLS_ORDER: &[&str] = &[
    "dLbl", "delete", "numFmt", "spPr", "txPr", "dLblPos", "showLegendKey", "showVal", "showCatName", "showSerName",
    "showPercent", "showBubbleSize", "separator", "showLeaderLines", "leaderLines", "extLst",
];

/// 축 하나의 편집(보이기·주/부 눈금선·제목).
fn edit_axis(plot_area: &mut El, ns: &Ns, vertical: bool, spec: &Json) -> Result<(), String> {
    let Some(i) = primary_axis_index(plot_area, vertical) else {
        return Err(format!("기본 {} 축이 없습니다", if vertical { "세로" } else { "가로" }));
    };
    let ax = el_at_mut(plot_area, i);
    if let Some(v) = spec.get("visible").and_then(Json::as_bool) {
        ax.put_ordered(El::val(ns.c("delete"), if v { "0" } else { "1" }), AXIS_ORDER);
    }
    for (key, local) in [("majorGrid", "majorGridlines"), ("minorGrid", "minorGridlines")] {
        if let Some(v) = spec.get(key).and_then(Json::as_bool) {
            if v {
                if ax.child(local).is_none() {
                    ax.insert_ordered(El::new(ns.c(local)), AXIS_ORDER);
                }
            } else {
                ax.remove_all(local);
            }
        }
    }
    let text = spec.get("titleText").and_then(Json::as_str);
    match spec.get("title").and_then(Json::as_bool) {
        Some(false) => {
            ax.remove_all("title");
        }
        Some(true) => match ax.child_mut("title") {
            Some(t) => {
                if let Some(text) = text {
                    retitle(ns, t, text, vertical);
                }
            }
            None => ax.insert_ordered(title_el(ns, false, text, vertical), AXIS_ORDER),
        },
        None => {
            if let (Some(text), Some(t)) = (text, ax.child_mut("title")) {
                retitle(ns, t, text, vertical);
            }
        }
    }
    Ok(())
}

// ───────────── 차트 색(한/글 ChartSeriesColorList — hncChartStyle colorIndex) ─────────────

/// 단색형(colorIndex 10~22) 계열 수 n 별 명암 — 한/글 2022 COM 실측(계열 1~16, `ChartSeriesColorList` ChartGroup 1 — 2026-11-11).
/// ("shade"|"tint"|"", 값). 계열 n 개에 n 칸. 17 개 넘는 계열은 실측이 없어 받지 않는다.
const MONO_SPREAD: [&[(&str, u32)]; 16] = [
    &[("", 0)],
    &[("shade", 64410), ("tint", 82690)],
    &[("shade", 59820), ("", 0), ("tint", 84950)],
    &[("shade", 56560), ("shade", 85550), ("tint", 86550), ("tint", 57560)],
    &[("shade", 54040), ("shade", 86790), ("", 0), ("tint", 55040), ("tint", 22280)],
    &[("shade", 51970), ("shade", 69890), ("shade", 87810), ("tint", 88810), ("tint", 70890), ("tint", 52970)],
    &[("shade", 50230), ("shade", 69450), ("shade", 88670), ("", 0), ("tint", 70450), ("tint", 51230), ("tint", 32010)],
    &[("shade", 48720), ("shade", 62280), ("shade", 75850), ("shade", 89410), ("tint", 90410), ("tint", 76850), ("tint", 63280), ("tint", 49720)],
    &[("shade", 47380), ("shade", 61610), ("shade", 75840), ("shade", 90070), ("", 0), ("tint", 76840), ("tint", 62610), ("tint", 48380), ("tint", 34150)],
    &[("shade", 46190), ("shade", 57310), ("shade", 68420), ("shade", 79540), ("shade", 90660), ("tint", 91660), ("tint", 80540), ("tint", 69420), ("tint", 58310), ("tint", 47190)],
    &[("shade", 45110), ("shade", 56630), ("shade", 68150), ("shade", 79670), ("shade", 91190), ("", 0), ("tint", 80670), ("tint", 69150), ("tint", 57630), ("tint", 46110), ("tint", 34590)],
    &[("shade", 44130), ("shade", 53640), ("shade", 63140), ("shade", 72650), ("shade", 82160), ("shade", 91670), ("tint", 92670), ("tint", 83160), ("tint", 73650), ("tint", 64140), ("tint", 54640), ("tint", 45130)],
    &[("shade", 43220), ("shade", 53000), ("shade", 62780), ("shade", 72560), ("shade", 82340), ("shade", 92120), ("", 0), ("tint", 83340), ("tint", 73560), ("tint", 63780), ("tint", 54000), ("tint", 44220), ("tint", 34440)],
    &[("shade", 42380), ("shade", 50740), ("shade", 59100), ("shade", 67460), ("shade", 75810), ("shade", 84170), ("shade", 92530), ("tint", 93530), ("tint", 85170), ("tint", 76810), ("tint", 68460), ("tint", 60100), ("tint", 51740), ("tint", 43380)],
    &[("shade", 41600), ("shade", 50150), ("shade", 58700), ("shade", 67260), ("shade", 75810), ("shade", 84360), ("shade", 92920), ("", 0), ("tint", 85360), ("tint", 76810), ("tint", 68260), ("tint", 59700), ("tint", 51150), ("tint", 42600), ("tint", 34050)],
    &[("shade", 40870), ("shade", 48360), ("shade", 55840), ("shade", 63330), ("shade", 70820), ("shade", 78300), ("shade", 85790), ("shade", 93270), ("tint", 94270), ("tint", 86790), ("tint", 79300), ("tint", 71820), ("tint", 64330), ("tint", 56840), ("tint", 49360), ("tint", 41870)],
];

/// 색상형(colorIndex 1~3)의 묶음별 명도 바꿈(lumMod, lumOff) — 계열 셋마다 다음 묶음(실측 계열 16 까지).
const COLORFUL_MODS: [(u32, u32); 6] = [(0, 0), (60000, 0), (80000, 20000), (80000, 0), (60000, 40000), (50000, 0)];
/// 회색(colorIndex 16) dk1 tint — 8 개씩 되풀이(실측 계열 12).
const GRAY_TINTS: [u32; 8] = [88000, 65000, 80000, 95000, 75000, 60000, 70000, 50000];

/// colorIndex `c` 에서 n 개 중 j 번째 색 — (테마 색 이름, [(바꿈 이름, 값)]). None = 색 지정 없음(색상표 그대로).
fn color_entry(c: i64, j: usize, n: usize) -> Result<Option<(String, Vec<(&'static str, u32)>)>, String> {
    Ok(match c {
        0 => None,
        1..=3 => {
            let accents: [&str; 3] = match c {
                1 => ["accent1", "accent3", "accent5"],
                2 => ["accent2", "accent4", "accent6"],
                _ => ["accent6", "accent5", "accent4"],
            };
            let (m, o) = *COLORFUL_MODS.get(j / 3).ok_or("이 색상표는 계열 18 개까지만 실측했습니다")?;
            let mut mods = Vec::new();
            if m > 0 {
                mods.push(("lumMod", m));
            }
            if o > 0 {
                mods.push(("lumOff", o));
            }
            Some((accents[j % 3].to_string(), mods))
        }
        10..=15 | 17..=22 => {
            let reversed = c >= 17;
            let accent = format!("accent{}", if reversed { c - 16 } else { c - 9 });
            let row = *MONO_SPREAD.get(n.wrapping_sub(1)).ok_or("단색 색상표는 계열 16 개까지만 실측했습니다")?;
            let entry = if !reversed {
                row[j]
            } else if n <= 3 || n % 2 == 0 {
                // 계열 3 개 이하·짝수: 정순의 거꾸로(실측 4·8·12·3)
                row[n - 1 - j]
            } else {
                // 홀수(5 이상): 앞 k 개는 tint(shade_j + 1000), 가운데 없음, 뒤는 shade 거꾸로(실측 5·7)
                let k = n / 2;
                if j < k {
                    ("tint", row[j].1 + 1000)
                } else if j == k {
                    ("", 0)
                } else {
                    row[n - 1 - j]
                }
            };
            let mods = if entry.0.is_empty() { Vec::new() } else { vec![(if entry.0 == "shade" { "shade" } else { "tint" }, entry.1)] };
            Some((accent, mods))
        }
        16 => Some(("dk1".to_string(), vec![("tint", GRAY_TINTS[j % GRAY_TINTS.len()])])),
        _ => return Err(format!("차트 색 {c} 은 한/글 목록에 없습니다(0~3 색상형, 10~22 단색형)")),
    })
}

fn color_fill(ns: &Ns, theme: &str, mods: &[(&str, u32)]) -> El {
    let mut clr = El::val(ns.a("schemeClr"), theme);
    for (m, v) in mods {
        clr = clr.with(El::val(ns.a(m), v.to_string()));
    }
    El::new(ns.a("solidFill")).with(clr)
}

fn ln_of(ns: &Ns, w: &str, fill: El) -> El {
    El::new(ns.a("ln"))
        .with_attr("w", w)
        .with_attr("cap", "flat")
        .with_attr("cmpd", "sng")
        .with_attr("algn", "ctr")
        .with(fill)
        .with(El::val(ns.a("prstDash"), "solid"))
        .with(El::new(ns.a("round")))
        .with(El::new(ns.a("headEnd")).with_attr("w", "med").with_attr("len", "med"))
        .with(El::new(ns.a("tailEnd")).with_attr("w", "med").with_attr("len", "med"))
}

const SER_ORDER: &[&str] = &[
    "idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker", "explosion", "dPt", "dLbls", "trendline",
    "errBars", "cat", "val", "xVal", "yVal", "smooth", "shape", "bubbleSize", "bubble3D", "extLst",
];

/// '차트 색' 목록 적용 — 한/글 2022 저장 꼴(실측): 막대·영역 = 계열 spPr 단색 채우기, 꺾은선 = 계열 선(ln 28575)+표식 채우기·선(ln 9525),
/// 원형·도넛 = 점(dPt)마다 단색 채우기(점 수로 명암을 나눈다). colorIndex 0 은 계열 색을 지운다(원형은 점마다 accentN 채우기).
fn apply_colors(doc: &mut XmlDoc, ns: &Ns, c: i64) -> Result<(), String> {
    color_entry(c, 0, 1)?;
    let chart = doc.root.child_mut("chart").ok_or("c:chart 가 없습니다")?;
    let plot_area = chart.child_mut("plotArea").ok_or("c:plotArea 가 없습니다")?;
    for plot in plot_area.elems_mut().filter(|e| e.local().ends_with("Chart")) {
        let kind = plot.local().to_string();
        let pie = matches!(kind.as_str(), "pieChart" | "pie3DChart" | "ofPieChart" | "doughnutChart");
        let line = matches!(kind.as_str(), "lineChart" | "line3DChart");
        if matches!(kind.as_str(), "scatterChart" | "bubbleChart" | "stockChart" | "radarChart" | "surfaceChart" | "surface3DChart") {
            return Err(format!("{kind} 에는 '차트 색' 꼴을 실측하지 않았습니다"));
        }
        let n = plot.children("ser").count();
        for (j, ser) in plot.elems_mut().filter(|e| e.local() == "ser").enumerate() {
            if pie {
                let pts: Vec<usize> = ser.children("dPt").filter_map(|d| d.child_val("idx").and_then(|v| v.parse().ok())).collect();
                let np = pts.len();
                for d in ser.elems_mut().filter(|e| e.local() == "dPt") {
                    let k: usize = d.child_val("idx").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let pos = pts.iter().position(|p| *p == k).unwrap_or(0);
                    let sp = match color_entry(c, pos, np)? {
                        Some((t, m)) => El::new(ns.c("spPr")).with(color_fill(ns, &t, &m)),
                        // 색상 조합 1(colorIndex 0) 원형 = 점마다 accentN 채우기만(선 없음 — 실측)
                        None => El::new(ns.c("spPr")).with(color_fill(ns, &format!("accent{}", k % 6 + 1), &[])),
                    };
                    d.put_ordered(sp, &["idx", "invertIfNegative", "marker", "bubble3D", "explosion", "spPr", "pictureOptions", "extLst"]);
                }
                continue;
            }
            let entry = color_entry(c, j, n)?;
            ser.remove_all("spPr");
            let Some((t, m)) = entry else {
                if line {
                    if let Some(mk) = ser.child_mut("marker") {
                        mk.remove_all("spPr");
                    }
                }
                continue;
            };
            if line {
                ser.insert_ordered(El::new(ns.c("spPr")).with(ln_of(ns, "28575", color_fill(ns, &t, &m))), SER_ORDER);
                if let Some(mk) = ser.child_mut("marker") {
                    mk.remove_all("spPr");
                    mk.kids.push(Node::El(
                        El::new(ns.c("spPr")).with(color_fill(ns, &t, &m)).with(ln_of(ns, "9525", color_fill(ns, &t, &m))),
                    ));
                }
            } else {
                ser.insert_ordered(El::new(ns.c("spPr")).with(color_fill(ns, &t, &m)), SER_ORDER);
            }
        }
    }
    set_hnc_style(&mut doc.root, "colorIndex", &c.to_string());
    Ok(())
}

// ───────────── 차트 레이아웃(한/글 ChartLayoutList 0~10) ─────────────

/// 종류×레이아웃 표 — 한/글 2022 COM 실측 저장본(tests/fixtures/h2022_chart/layouts/*.xml)에서 뽑은 생성물
/// (artifacts/h2022-chart/gen_layouts.mjs). 레이아웃이 정하는 칸만 담는다: 제목·autoTitleDeleted·범례·plot 단 데이터 레이블·
/// gapWidth/overlap·항목/값 축의 delete·주/부 눈금선·축 제목·눈금 표시·축 선(spPr).
const LAYOUTS_JSON: &str = include_str!("layouts.json");

/// 지금 차트가 쓰는 레이아웃 표 이름(실측한 종류만).
fn layout_family(chart: &El) -> Option<&'static str> {
    let plot = chart.child("plotArea")?.elems().find(|e| e.local().ends_with("Chart"))?;
    Some(match plot.local() {
        "barChart" if plot.child_val("barDir") == Some("bar") => "barh",
        "barChart" => "col",
        "lineChart" => "line",
        "line3DChart" => "line3d",
        "areaChart" => "area",
        "pieChart" | "ofPieChart" | "doughnutChart" => "pie",
        "pie3DChart" => "pie3d",
        _ => return None,
    })
}

/// 실측 조각(접두어 c:/a:)을 이 문서의 접두어로 읽는다.
fn snippet(ns: &Ns, raw: &str) -> Result<El, String> {
    let mut t = raw.to_string();
    if ns.c != "c" {
        let to = if ns.c.is_empty() { String::new() } else { format!("{}:", ns.c) };
        t = t.replace("<c:", &format!("<{to}")).replace("</c:", &format!("</{to}"));
    }
    if ns.a != "a" {
        t = t.replace("<a:", &format!("<{}:", ns.a)).replace("</a:", &format!("</{}:", ns.a));
    }
    Ok(XmlDoc::parse(t.as_bytes())?.root)
}

fn put_snippet(parent: &mut El, ns: &Ns, local: &str, spec: Option<&Json>, order: &[&str]) -> Result<(), String> {
    parent.remove_all(local);
    if let Some(raw) = spec.and_then(Json::as_str) {
        parent.insert_ordered(snippet(ns, raw)?, order);
    }
    Ok(())
}

fn apply_layout(doc: &mut XmlDoc, ns: &Ns, n: usize) -> Result<(), String> {
    let table = Json::parse(LAYOUTS_JSON)?;
    let chart = doc.root.child_mut("chart").ok_or("c:chart 가 없습니다")?;
    let fam = layout_family(chart).ok_or("이 차트 종류에는 레이아웃 표가 없습니다(실측한 종류: 세로/가로 막대·꺾은선·3차원 꺾은선·영역·원형·3차원 원형)")?;
    let spec = match table.get(fam) {
        Some(Json::Arr(v)) => v.get(n).ok_or("레이아웃 번호가 표에 없습니다")?,
        _ => return Err("레이아웃 표를 읽지 못했습니다".into()),
    };
    put_snippet(chart, ns, "title", spec.get("title"), CHART_ORDER)?;
    if let Some(v) = spec.get("autoTitleDeleted").and_then(Json::as_str) {
        chart.put_ordered(El::val(ns.c("autoTitleDeleted"), v), CHART_ORDER);
    }
    put_snippet(chart, ns, "legend", spec.get("legend"), CHART_ORDER)?;
    let plot_area = chart.child_mut("plotArea").ok_or("c:plotArea 가 없습니다")?;
    if let Some(plot) = plot_area.elems_mut().find(|e| e.local().ends_with("Chart")) {
        put_snippet(plot, ns, "dLbls", spec.get("plotDLbls"), PLOT_ORDER)?;
        for k in ["gapWidth", "overlap"] {
            if let Some(v) = spec.get(k).and_then(Json::as_str) {
                plot.put_ordered(El::val(ns.c(k), v), PLOT_ORDER);
            }
        }
    }
    for kind in ["catAx", "valAx"] {
        let Some(a) = spec.get(kind).filter(|a| !matches!(a, Json::Null)) else { continue };
        let Some(ax) = plot_area.elems_mut().find(|e| e.local() == kind) else { continue };
        if let Some(v) = a.get("delete").and_then(Json::as_str) {
            ax.put_ordered(El::val(ns.c("delete"), v), AXIS_ORDER);
        }
        put_snippet(ax, ns, "majorGridlines", a.get("majorGridlines"), AXIS_ORDER)?;
        put_snippet(ax, ns, "minorGridlines", a.get("minorGridlines"), AXIS_ORDER)?;
        put_snippet(ax, ns, "title", a.get("title"), AXIS_ORDER)?;
        if let Some(v) = a.get("majorTickMark").and_then(Json::as_str) {
            ax.put_ordered(El::val(ns.c("majorTickMark"), v), AXIS_ORDER);
        }
        put_snippet(ax, ns, "spPr", a.get("spPr"), AXIS_ORDER)?;
    }
    Ok(())
}

/// 차트 구성 편집을 적용한 새 XML. `ops` 는 JSON:
/// `{ "kind": {"group":1,"index":0}, "title": {"mode":"none|top|overlay", "text":"…"}, "legend": "none|right|top|left|bottom",
///    "dataLabels": true|false, "horizontalAxis": {"visible":b,"majorGrid":b,"minorGrid":b,"title":b,"titleText":"…"}, "verticalAxis": {…} }`
/// 모르는 키는 거부한다. 차례: 종류 → 제목 → 범례 → 데이터 레이블 → 축.
pub fn apply_chart_format(xml: &[u8], ops_json: &str) -> Result<Vec<u8>, String> {
    let ops = Json::parse(ops_json)?;
    let Json::Obj(fields) = &ops else {
        return Err("편집은 JSON 객체여야 합니다".into());
    };
    for (k, _) in fields {
        if !matches!(k.as_str(), "kind" | "layout" | "colors" | "title" | "legend" | "dataLabels" | "horizontalAxis" | "verticalAxis") {
            return Err(format!("모르는 편집 '{k}'"));
        }
    }
    let mut doc = XmlDoc::parse(xml)?;
    let ns = namespaces(&mut doc);
    if doc.root.local() != "chartSpace" {
        return Err("c:chartSpace 가 아닙니다".into());
    }
    if let Some(kind) = ops.get("kind") {
        let g = kind.get("group").and_then(Json::as_f64).ok_or("kind.group 이 필요합니다")?;
        let i = kind.get("index").and_then(Json::as_f64).ok_or("kind.index 가 필요합니다")?;
        let fam = family_of(g as u8, i as u8)
            .filter(|_| g >= 0.0 && i >= 0.0 && g.fract() == 0.0 && i.fract() == 0.0)
            .ok_or_else(|| format!("받지 않는 차트 종류입니다(group {g}, index {i})"))?;
        change_kind(&mut doc, &ns, fam)?;
    }
    if let Some(c) = ops.get("colors") {
        let c = c.as_f64().filter(|c| c.fract() == 0.0).ok_or("colors 는 색상표 번호(정수)여야 합니다")? as i64;
        apply_colors(&mut doc, &ns, c)?;
    }
    if let Some(l) = ops.get("layout") {
        let n = l.as_f64().filter(|n| n.fract() == 0.0 && (0.0..=10.0).contains(n)).ok_or("layout 은 0~10 이어야 합니다")?;
        apply_layout(&mut doc, &ns, n as usize)?;
    }
    let chart = doc.root.child_mut("chart").ok_or("c:chart 가 없습니다")?;
    if let Some(t) = ops.get("title") {
        let mode = t.get("mode").and_then(Json::as_str).unwrap_or("top");
        set_title(chart, &ns, mode, t.get("text").and_then(Json::as_str))?;
    }
    if let Some(l) = ops.get("legend") {
        set_legend(chart, &ns, l.as_str().ok_or("legend 는 글이어야 합니다")?)?;
    }
    if let Some(d) = ops.get("dataLabels") {
        set_data_labels(chart, &ns, d.as_bool().ok_or("dataLabels 는 참/거짓이어야 합니다")?);
    }
    for (key, vertical) in [("horizontalAxis", false), ("verticalAxis", true)] {
        if let Some(spec) = ops.get(key) {
            let plot_area = chart.child_mut("plotArea").ok_or("c:plotArea 가 없습니다")?;
            edit_axis(plot_area, &ns, vertical, spec)?;
        }
    }
    Ok(doc.to_string().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HANGUL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><c:chartSpace xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:date1904 val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>A&amp;B</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr/><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>가</c:v></c:pt><c:pt idx="1"><c:v>나</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="150"/><c:overlap val="0"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart><c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="1002"/><c:delete val="0"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/></c:catAx><c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1001"/><c:delete val="0"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="r"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="0"/></c:chart><c:extLst><c:ext uri="x"><ho:hncChartStyle xmlns:ho="http://schemas.haansoft.com/office/8.0" layoutIndex="-1" colorIndex="0" styleIndex="0"/></c:ext></c:extLst></c:chartSpace>"#;

    fn apply(ops: &str) -> String {
        String::from_utf8(apply_chart_format(HANGUL.as_bytes(), ops).unwrap()).unwrap()
    }

    #[test]
    fn round_trip_is_identity() {
        assert_eq!(XmlDoc::parse(HANGUL.as_bytes()).unwrap().to_string(), HANGUL);
    }

    #[test]
    fn kind_detected() {
        let j = chart_format_json(HANGUL.as_bytes()).unwrap();
        assert!(j.contains("\"group\":1,\"index\":0"), "{j}");
        assert!(j.contains("\"legend\":\"right\""), "{j}");
    }

    #[test]
    fn to_line_matches_hangul_shape() {
        let x = apply(r#"{"kind":{"group":2,"index":0}}"#);
        assert!(x.contains("<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/><c:ser>"), "{x}");
        assert!(x.contains("</c:tx><c:marker><c:symbol val=\"none\"/><c:size val=\"7\"/></c:marker><c:cat>"), "{x}");
        assert!(x.contains("</c:val><c:smooth val=\"0\"/></c:ser><c:marker val=\"1\"/><c:smooth val=\"0\"/><c:axId val=\"1001\"/>"), "{x}");
        assert!(x.contains("styleIndex=\"-1\""));
        assert!(!x.contains("<c:spPr/>"));
        assert!(x.contains("A&amp;B"));
    }

    #[test]
    fn to_pie_and_back() {
        let x = apply(r#"{"kind":{"group":3,"index":1}}"#);
        assert!(!x.contains("catAx") && !x.contains("valAx"));
        assert!(x.contains("<c:explosion val=\"25\"/><c:dPt><c:idx val=\"0\"/>"));
        assert_eq!(x.matches("<c:dPt>").count(), 2);
        let back = String::from_utf8(apply_chart_format(x.as_bytes(), r#"{"kind":{"group":1,"index":1}}"#).unwrap()).unwrap();
        assert!(back.contains("<c:catAx><c:axId val=\"1001\"/>"), "{back}");
        assert!(back.contains("<c:grouping val=\"stacked\"/>") && back.contains("<c:overlap val=\"100\"/>"));
        assert!(!back.contains("dPt"));
    }

    #[test]
    fn components() {
        let x = apply(r#"{"title":{"mode":"top","text":"매출 <요약>"},"legend":"none","dataLabels":true,"verticalAxis":{"title":true,"majorGrid":false},"horizontalAxis":{"visible":false}}"#);
        assert!(x.contains("<c:chart><c:title><c:tx><c:rich>"), "{x}");
        assert!(x.contains("<a:t>매출 &lt;요약&gt;</a:t>"));
        assert!(x.contains("<c:autoTitleDeleted val=\"0\"/>"));
        assert!(!x.contains("<c:legend>"));
        assert!(x.contains("</c:ser><c:dLbls><c:delete val=\"0\"/><c:dLblPos val=\"outEnd\"/>"));
        assert!(!x.contains("majorGridlines"));
        assert!(x.contains("<c:delete val=\"0\"/><c:title><c:layout/><c:overlay val=\"0\"/><c:txPr><a:bodyPr rot=\"-5400000\""), "{x}");
        assert!(x.contains("<c:catAx><c:axId val=\"1001\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:axPos val=\"b\"/><c:crossAx val=\"1002\"/><c:delete val=\"1\"/>"));
        let j = chart_format_json(x.as_bytes()).unwrap();
        assert!(j.contains("\"titleText\":\"매출 <요약>\""), "{j}");
        assert!(j.contains("\"legend\":\"none\"") && j.contains("\"dataLabels\":true"), "{j}");
        let y = String::from_utf8(apply_chart_format(x.as_bytes(), r#"{"title":{"mode":"none"},"legend":"left","dataLabels":false}"#).unwrap()).unwrap();
        assert!(!y.contains("<c:chart><c:title>") && y.contains("<c:autoTitleDeleted val=\"1\"/>"));
        assert!(y.contains("<c:legend><c:legendPos val=\"l\"/>"));
        assert!(!y.contains("dLbls"));
    }

    /// [hwpx-cowork] 한/글 실측 대조(밖의 자료 폴더가 필요해 기본 실행에서 뺀다):
    /// H2022_CHART_FIXTURES=<hwpx_cowork>/tests/fixtures/h2022_chart cargo test -p rhwp-ooxml-chart --lib format -- --ignored
    #[test]
    #[ignore = "H2022_CHART_FIXTURES(한/글 실측 저장본 폴더)가 필요하다"]
    fn layouts_match_hangul_saves() {
        let dir = std::path::PathBuf::from(std::env::var("H2022_CHART_FIXTURES").expect("H2022_CHART_FIXTURES 를 주세요"));
        let mut bad = Vec::new();
        for fam in ["col", "barh", "line", "line3d", "area", "pie", "pie3d"] {
            let base = std::fs::read(dir.join("layouts").join(format!("{fam}_base.xml"))).unwrap();
            for n in 0..=10 {
                let want = std::fs::read_to_string(dir.join("layouts").join(format!("{fam}_L{n:02}.xml"))).unwrap();
                let got = String::from_utf8(apply_chart_format(&base, &format!("{{\"layout\":{n}}}")).unwrap()).unwrap();
                if got != want {
                    let a: Vec<&str> = got.split('>').collect();
                    let b: Vec<&str> = want.split('>').collect();
                    let i = a.iter().zip(b.iter()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
                    bad.push(format!("{fam} L{n}: ours …{}… / hangul …{}…", a[i.saturating_sub(2)..(i + 3).min(a.len())].join(">"), b[i.saturating_sub(2)..(i + 3).min(b.len())].join(">")));
                }
            }
        }
        assert!(bad.is_empty(), "{} 개 다름: {}", bad.len(), bad.join(" || "));
    }

    #[test]
    fn rejects_unknown() {
        assert!(apply_chart_format(HANGUL.as_bytes(), r#"{"kind":{"group":5,"index":0}}"#).is_err());
        assert!(apply_chart_format(HANGUL.as_bytes(), r#"{"bogus":1}"#).is_err());
    }
}
