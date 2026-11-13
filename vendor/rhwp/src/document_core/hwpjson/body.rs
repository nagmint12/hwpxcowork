//! 본문(`Contents/section0.xml`) 생성기.
//!
//! 파이썬 정본 `hj/conv/body.py` 를 옮긴 것이다. 클립보드 문서모델의 `ro`/`sl`/`cs` 풀을
//! HWPX `<hs:sec>` 로 직렬화한다(원본 대조 실적: 문단 259/259·표 15/15·셀 63/63,
//! 마스킹 후 원시 문자열 153,523자 동일).
//!
//! 사양서 `hj/schema-map.md` 의 "문단·문자 ro/cs" · "개체 sl/bi/bidt" 절을 따른다.

use serde_json::{Map, Value};

use super::ctx::{
    attrs, av, b01, enum_raw, esc_attr, esc_text, getarr, getb, geti, getobj, gets, issue, nullv,
    sorted_items, sub, u32v, Ids, Model,
};

// ---------------------------------------------------------------- 상수

pub const SEC_XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?>";

const SEC_OPEN: &str = concat!(
    "<hs:sec",
    " xmlns:ha=\"http://www.hancom.co.kr/hwpml/2011/app\"",
    " xmlns:hp=\"http://www.hancom.co.kr/hwpml/2011/paragraph\"",
    " xmlns:hp10=\"http://www.hancom.co.kr/hwpml/2016/paragraph\"",
    " xmlns:hs=\"http://www.hancom.co.kr/hwpml/2011/section\"",
    " xmlns:hc=\"http://www.hancom.co.kr/hwpml/2011/core\"",
    " xmlns:hh=\"http://www.hancom.co.kr/hwpml/2011/head\"",
    " xmlns:hhs=\"http://www.hancom.co.kr/hwpml/2011/history\"",
    " xmlns:hm=\"http://www.hancom.co.kr/hwpml/2011/master-page\"",
    " xmlns:hpf=\"http://www.hancom.co.kr/schema/2011/hpf\"",
    " xmlns:dc=\"http://purl.org/dc/elements/1.1/\"",
    " xmlns:opf=\"http://www.idpf.org/2007/opf/\"",
    " xmlns:ooxmlchart=\"http://www.hancom.co.kr/hwpml/2016/ooxmlchart\"",
    " xmlns:hwpunitchar=\"http://www.hancom.co.kr/hwpml/2016/HwpUnitChar\"",
    " xmlns:epub=\"http://www.idpf.org/2007/ops\"",
    " xmlns:config=\"urn:oasis:names:tc:opendocument:xmlns:config:1.0\">",
);

// `ch[].ci` — 컨트롤 4CC(big-endian ASCII) → 종류
const CI_SECD: i64 = 1_936_024_420; // b"secd"
const CI_COLD: i64 = 1_668_246_628; // b"cold"
const CI_PGNP: i64 = 1_885_826_672; // b"pgnp"
const CI_TBL: i64 = 1_952_607_264; // b"tbl "
const CI_GSO: i64 = 1_735_618_336; // b"gso "
// [hwpx-cowork] Measured Hancom clipboard controls (same 4CC as HWP5).
const CI_ATNO: i64 = 1_635_020_399; // b"atno"
const CI_NWNO: i64 = 1_853_320_815; // b"nwno"
const CI_MEMO_BEGIN: i64 = 623_209_829; // b"%%me"
// [hwpx-cowork] 한글 2022에서 실제 복사한 하이퍼링크 필드의 시작/끝 4CC.
const CI_HYPERLINK_BEGIN: i64 = 627_600_491; // b"%hlk"
const CI_HYPERLINK_END: i64 = 6_843_499; // b"\0hlk"
const CI_MEMO_END: i64 = 2_452_837;
// [hwpx-cowork] Additional control mappings shared with the measured exporter.
const CI_PGHD: i64 = 1_885_825_124;
const CI_BOKM: i64 = 1_651_469_165;
const CI_FN: i64 = 1_718_493_216;
const CI_EN: i64 = 1_701_716_000;
const CI_HEAD: i64 = 1_751_474_532;
const CI_FOOT: i64 = 1_718_579_060;
const CI_EQED: i64 = 1_701_930_340;
                                   // `cs[gso].rc.ci` — 도형 레코드 종류(별도 네임스페이스)
const RC_REC: i64 = 611_476_835; // b"$rec"
const RC_PIC: i64 = 611_346_787;
const RC_LIN: i64 = 611_084_654;
const RC_POL: i64 = 611_348_332;
const RC_ELL: i64 = 610_626_668;
const RC_ARC: i64 = 610_366_051;
const RC_COL: i64 = 610_496_364;
const RC_CON: i64 = 610_496_366;
const RC_CUR: i64 = 610_497_906;

// --- 열거표 (사양서에서 확정된 쌍은 주석에 원본 근거를 적었다) -------------
const E_NUMBERING: [&str; 4] = ["NONE", "PICTURE", "TABLE", "EQUATION"]; // 1·2 확정
const E_TEXTWRAP: [&str; 4] = [
    "SQUARE",
    "TOP_AND_BOTTOM",
    "BEHIND_TEXT",
    "IN_FRONT_OF_TEXT",
]; // 1 확정
const E_TEXTFLOW: [&str; 4] = ["BOTH_SIDES", "LEFT_ONLY", "RIGHT_ONLY", "LARGEST_ONLY"]; // 0 확정
const E_WREL: [&str; 5] = ["PAPER", "PAGE", "COLUMN", "PARA", "ABSOLUTE"]; // 4 확정
const E_HREL: [&str; 3] = ["PAPER", "PAGE", "ABSOLUTE"]; // 2 확정
const E_VRELTO: [&str; 3] = ["PAPER", "PAGE", "PARA"]; // 2 확정
const E_HRELTO: [&str; 4] = ["PAPER", "PAGE", "COLUMN", "PARA"]; // 0·3 확정
const E_VALIGN: [&str; 5] = ["TOP", "CENTER", "BOTTOM", "INSIDE", "OUTSIDE"]; // 0·1 확정
const E_HALIGN: [&str; 5] = ["LEFT", "CENTER", "RIGHT", "INSIDE", "OUTSIDE"]; // 0 확정
const E_TEXTDIR: [&str; 2] = ["HORIZONTAL", "VERTICAL"]; // 0 확정
const E_LINEWRAP: [&str; 3] = ["BREAK", "SQUEEZE", "KEEP"]; // 0 확정
const E_TBLBREAK: [&str; 3] = ["NONE", "TABLE", "CELL"]; // 2 확정(나머지 미검증)
const E_IMGEFFECT: [&str; 4] = ["REAL_PIC", "GRAY_SCALE", "BLACK_WHITE", "PATTERN8x8"]; // 0 확정
const E_PAGENUMPOS: [&str; 11] = [
    "NONE",
    "TOP_LEFT",
    "TOP_CENTER",
    "TOP_RIGHT",
    "BOTTOM_LEFT",
    "BOTTOM_CENTER",
    "BOTTOM_RIGHT",
    "OUTSIDE_TOP",
    "OUTSIDE_BOTTOM",
    "INSIDE_TOP",
    "INSIDE_BOTTOM",
]; // 5 확정
const E_NUMFORMAT: [&str; 6] = [
    "DIGIT",
    "CIRCLED_DIGIT",
    "ROMAN_CAPITAL",
    "ROMAN_SMALL",
    "LATIN_CAPITAL",
    "LATIN_SMALL",
]; // 0 확정
const E_NOTENUM: [&str; 3] = ["CONTINUOUS", "ON_SECTION", "ON_PAGE"]; // 0 확정
const E_FN_PLACE: [&str; 3] = ["EACH_COLUMN", "MERGED_COLUMN", "RIGHT_MOST_COLUMN"];
const E_EN_PLACE: [&str; 2] = ["END_OF_DOCUMENT", "END_OF_SECTION"];
// [hwpx-cowork] 2·3 은 DOT·DASH — HWPX 이름이 한글 코드와 뒤바뀌어 있다(한글 2022 탭 채움 DASH=3 실측).
const E_LINETYPE: [&str; 12] = [
    "NONE",
    "SOLID",
    "DOT",
    "DASH",
    "DASH_DOT",
    "DASH_DOT_DOT",
    "LONG_DASH",
    "CIRCLE",
    "DOUBLE_SLIM",
    "SLIM_THICK",
    "THICK_SLIM",
    "SLIM_THICK_SLIM",
]; // 0·1 확정
const E_LINEWIDTH: [&str; 16] = [
    "0.1 mm", "0.12 mm", "0.15 mm", "0.2 mm", "0.25 mm", "0.3 mm", "0.4 mm", "0.5 mm", "0.6 mm",
    "0.7 mm", "1.0 mm", "1.5 mm", "2.0 mm", "3.0 mm", "4.0 mm", "5.0 mm",
]; // 0 확정
const E_ENDCAP: [&str; 3] = ["ROUND", "FLAT", "SQUARE"]; // 1 확정
const E_ARROW: [&str; 7] = [
    "NORMAL",
    "ARROW",
    "SPEAR",
    "CONCAVE_ARROW",
    "EMPTY_DIAMOND",
    "EMPTY_CIRCLE",
    "EMPTY_BOX",
]; // 0 확정
const E_ARROWSZ: [&str; 9] = [
    "SMALL_SMALL",
    "SMALL_MEDIUM",
    "SMALL_LARGE",
    "MEDIUM_SMALL",
    "MEDIUM_MEDIUM",
    "MEDIUM_LARGE",
    "LARGE_SMALL",
    "LARGE_MEDIUM",
    "LARGE_LARGE",
]; // 0 확정
const E_OUTLINE: [&str; 3] = ["NORMAL", "OUTER", "INNER"]; // 0 확정
const E_SHADOW: [&str; 5] = [
    "NONE",
    "LEFT_TOP",
    "RIGHT_TOP",
    "LEFT_BOTTOM",
    "RIGHT_BOTTOM",
]; // 0 확정
const E_GUTTER: [&str; 3] = ["LEFT_ONLY", "LEFT_RIGHT", "TOP_BOTTOM"]; // 0 확정
const E_PAGESTART: [&str; 3] = ["BOTH", "EVEN", "ODD"]; // 0 확정
const E_PBF_TYPE: [&str; 3] = ["BOTH", "EVEN", "ODD"]; // 0·1·2 확정
const E_FILLAREA: [&str; 3] = ["PAPER", "PAGE", "BORDER"]; // 0 확정
const E_COLTYPE: [&str; 3] = ["NEWSPAPER", "BALANCED_NEWSPAPER", "PARALLEL"]; // 0 확정
const E_COLLAYOUT: [&str; 3] = ["LEFT", "RIGHT", "MIRROR"]; // 0 확정

// ---------------------------------------------------------------- 유틸

/// JSON 색 정수는 COLORREF `0x00BBGGRR` — 바이트를 뒤집어 `#RRGGBB` 로.
///
/// 🔴 `fonts_charpr::color` 와 다르다 — 본문 쪽은 음수와 `0xFFFFFFFF` 를 모두 `none` 으로 보고,
///    8자리 표기를 쓰지 않는다(파이썬 정본이 두 갈래로 갈라져 있었고 그대로 검증됐다).
fn color(v: i64) -> String {
    if v == 0xFFFF_FFFF || v < 0 {
        return "none".to_string();
    }
    let (r, g, b) = (v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

/// 행렬 실수 표기 — 정수값이면 정수로(원본이 `e1="1"` 처럼 적는다).
fn num(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "0".to_string(),
        Some(Value::Bool(b)) => b01(*b).to_string(),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f == f.trunc() {
                    format!("{}", f as i64)
                } else {
                    format!("{f}")
                }
            } else {
                n.to_string()
            }
        }
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 파이썬 `'%s' % value` 를 그대로 흉내 낸다 — 정본이 `hp:integerParam/@value` 한 자리에서만
/// 이런 날 것 포맷을 쓴다(표본에는 이 분기가 등장하지 않지만 출력이 갈리지 않게 맞춰 둔다).
fn pyfmt(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".to_string(),
        Some(Value::Bool(b)) => if *b { "True" } else { "False" }.to_string(),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                let s = format!("{f}");
                // 파이썬 repr 은 정수값 실수도 소수점을 남긴다(1.0 → "1.0")
                if s.contains(['.', 'e', 'E']) || !f.is_finite() {
                    s
                } else {
                    format!("{s}.0")
                }
            } else {
                n.to_string()
            }
        }
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 파이썬 truthiness 로 본 '비지 않은 객체'.
fn is_truthy_obj(v: &Value) -> bool {
    v.as_object().is_some_and(|o| !o.is_empty())
}

// ---------------------------------------------------------------- id 발급

fn charpr_ref(ids: &mut Ids, objid: &str) -> Option<i64> {
    issue(&mut ids.charpr_id, objid)
}

fn parapr_ref(ids: &mut Ids, objid: &str) -> Option<i64> {
    issue(&mut ids.parapr_id, objid)
}

fn style_ref(ids: &mut Ids, objid: &str) -> Option<i64> {
    issue(&mut ids.style_id, objid)
}

fn borderfill_ref(ids: &mut Ids, objid: &str) -> Option<i64> {
    issue(&mut ids.borderfill_id, objid)
}

/// `img.bi`(저장소 이름) → `imageN`. `bin_id` 가 비면 `bi` 배열 순서로 채운다.
fn bin_ref(m: &Model, ids: &mut Ids, key: &str) -> String {
    if ids.bin_id.is_empty() {
        for (i, item) in m.bi().iter().enumerate() {
            let sr = match item {
                Value::String(s) => s.as_str(),
                other => other.get("sr").and_then(Value::as_str).unwrap_or(""),
            };
            if !sr.is_empty() {
                ids.bin_id.insert(sr.to_string(), (i + 1) as u16);
            }
        }
    }
    let n = match ids.bin_id.get(key) {
        Some(n) => *n,
        None => {
            // 못 찾으면 등장 순서로 뒤에 붙인다
            let n = (ids.bin_id.len() + 1) as u16;
            ids.bin_id.insert(key.to_string(), n);
            n
        }
    };
    format!("image{n}")
}

/// `nu`(개요)·`mp`(메모) 처럼 별도 발급표가 없는 풀 — 정의표와 같은 순서(id)로 1부터.
fn pool_ref(pool: &Map<String, Value>, objid: &str) -> Option<i64> {
    if objid.is_empty() {
        return None;
    }
    for (i, (k, _)) in sorted_items(pool).into_iter().enumerate() {
        if k == objid {
            return Some(1 + i as i64);
        }
    }
    Some(1)
}

// ---------------------------------------------------------------- 구역 정의

fn emit_secpr(m: &Model, ids: &mut Ids, o: &Value) -> String {
    let a = attrs(&[
        ("id", av("")),
        ("textDirection", av(enum_raw(&E_TEXTDIR, geti(o, "td", 0)))),
        ("spaceColumns", av(geti(o, "sc", 0))),
        // ts 는 HWPUNIT 의 2배 스케일 — tabStop=ts, tabStopVal=ts/2 (사양서 반증)
        ("tabStop", av(geti(o, "ts", 0))),
        ("tabStopVal", av(geti(o, "ts", 0) / 2)),
        ("tabStopUnit", av("HWPUNIT")),
        (
            "outlineShapeIDRef",
            pool_ref(m.table("nu"), gets(o, "os")).map(|v| v.to_string()),
        ),
        (
            "memoShapeIDRef",
            pool_ref(m.table("mp"), gets(o, "ms")).map(|v| v.to_string()),
        ),
        ("textVerticalWidthHead", av(b01(getb(o, "tv")))),
        ("masterPageCnt", av(getarr(o, "mp").len())),
    ]);
    let mut out = format!("<hp:secPr{a}>");
    out.push_str(&format!(
        "<hp:grid lineGrid=\"{}\" charGrid=\"{}\" wonggojiFormat=\"{}\"/>",
        geti(o, "gl", 0),
        geti(o, "gc", 0),
        b01(getb(o, "gw"))
    ));
    out.push_str(&format!(
        "<hp:startNum pageStartsOn=\"{}\" page=\"{}\" pic=\"{}\" tbl=\"{}\" equation=\"{}\"/>",
        enum_raw(&E_PAGESTART, geti(o, "ns", 0)),
        geti(o, "np", 0),
        geti(o, "ni", 0),
        geti(o, "nt", 0),
        geti(o, "ne", 0)
    ));
    // border/fill 은 JSON bool 4개(fb·hb·fi·hi) ↔ HWPX 열거 2개의 대응이 미확정.
    // 표본이 전부 false/SHOW_ALL 이라 SHOW_ALL 고정으로 낸다(사양서 미해결 항목).
    out.push_str(&format!(
        "<hp:visibility hideFirstHeader=\"{}\" hideFirstFooter=\"{}\" \
 hideFirstMasterPage=\"{}\" border=\"SHOW_ALL\" fill=\"SHOW_ALL\" \
 hideFirstPageNum=\"{}\" hideFirstEmptyLine=\"{}\" showLineNumber=\"{}\"/>",
        b01(getb(o, "hh")),
        b01(getb(o, "hf")),
        b01(getb(o, "hm")),
        b01(getb(o, "hp")),
        b01(getb(o, "he")),
        b01(getb(o, "sl"))
    ));
    out.push_str(&format!(
        "<hp:lineNumberShape restartType=\"{}\" countBy=\"{}\" distance=\"{}\" \
 startNumber=\"{}\"/>",
        geti(o, "lr", 0),
        geti(o, "lc", 0),
        geti(o, "ld", 0),
        geti(o, "ls", 0)
    ));
    let pp = sub(o, "pp");
    out.push_str(&format!(
        "<hp:pagePr landscape=\"{}\" width=\"{}\" height=\"{}\" gutterType=\"{}\">",
        if getb(pp, "ls") { "NARROWLY" } else { "WIDELY" },
        geti(pp, "wi", 0),
        geti(pp, "he", 0),
        enum_raw(&E_GUTTER, geti(pp, "gt", 0))
    ));
    out.push_str(&format!(
        "<hp:margin header=\"{}\" footer=\"{}\" gutter=\"{}\" left=\"{}\" \
 right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(pp, "mh", 0),
        geti(pp, "mf", 0),
        geti(pp, "mg", 0),
        geti(pp, "ml", 0),
        geti(pp, "mr", 0),
        geti(pp, "mt", 0),
        geti(pp, "mb", 0)
    ));
    out.push_str("</hp:pagePr>");
    out.push_str(&emit_notepr(sub(o, "fn"), "footNotePr", &E_FN_PLACE));
    out.push_str(&emit_notepr(sub(o, "en"), "endNotePr", &E_EN_PLACE));
    for pb in getarr(o, "pb") {
        out.push_str(&format!(
            "<hp:pageBorderFill type=\"{}\" borderFillIDRef=\"{}\" \
 textBorder=\"{}\" headerInside=\"{}\" footerInside=\"{}\" fillArea=\"{}\">",
            enum_raw(&E_PBF_TYPE, geti(pb, "ty", 0)),
            opt_str(borderfill_ref(ids, gets(pb, "bf"))),
            if getb(pb, "tb") { "PAPER" } else { "CONTENT" },
            b01(getb(pb, "hi")),
            b01(getb(pb, "fi")),
            enum_raw(&E_FILLAREA, geti(pb, "fa", 0))
        ));
        out.push_str(&format!(
            "<hp:offset left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
            geti(pb, "ol", 0),
            geti(pb, "or", 0),
            geti(pb, "ot", 0),
            geti(pb, "ob", 0)
        ));
        out.push_str("</hp:pageBorderFill>");
    }
    out.push_str("</hp:secPr>");
    out
}

/// 파이썬은 `%s` 로 `None` 을 "None" 이라 적는다. 여기서도 같은 자리(속성 생략이 아닌 곳)에서만
/// 쓰이며, 실제 모델에서는 항상 값이 있다.
fn opt_str(v: Option<i64>) -> String {
    match v {
        Some(v) => v.to_string(),
        None => "None".to_string(),
    }
}

fn emit_notepr(n: &Value, tag: &str, place_table: &[&'static str]) -> String {
    let mut out = format!("<hp:{tag}>");
    out.push_str(&format!(
        "<hp:autoNumFormat type=\"{}\" userChar=\"{}\" prefixChar=\"{}\" \
 suffixChar=\"{}\" supscript=\"{}\"/>",
        enum_raw(&E_NUMFORMAT, geti(n, "at", 0)),
        esc_attr(gets(n, "au")),
        esc_attr(gets(n, "ap")),
        esc_attr(gets(n, "ac")),
        b01(getb(n, "as"))
    ));
    out.push_str(&format!(
        "<hp:noteLine length=\"{}\" type=\"{}\" width=\"{}\" color=\"{}\"/>",
        geti(n, "ll", -1),
        enum_raw(&E_LINETYPE, geti(n, "lt", 1)),
        enum_raw(&E_LINEWIDTH, geti(n, "lw", 0)),
        color(geti(n, "lc", 0))
    ));
    out.push_str(&format!(
        "<hp:noteSpacing betweenNotes=\"{}\" belowLine=\"{}\" aboveLine=\"{}\"/>",
        geti(n, "st", 0),
        geti(n, "sb", 0),
        geti(n, "sa", 0)
    ));
    out.push_str(&format!(
        "<hp:numbering type=\"{}\" newNum=\"{}\"/>",
        enum_raw(&E_NOTENUM, geti(n, "nt", 0)),
        geti(n, "nn", 1)
    ));
    out.push_str(&format!(
        "<hp:placement place=\"{}\" beneathText=\"{}\"/>",
        enum_raw(place_table, geti(n, "pp", 0)),
        b01(getb(n, "pb"))
    ));
    out.push_str(&format!("</hp:{tag}>"));
    out
}

fn emit_colpr(o: &Value) -> String {
    format!(
        "<hp:ctrl><hp:colPr id=\"\" type=\"{}\" layout=\"{}\" colCount=\"{}\" \
 sameSz=\"{}\" sameGap=\"{}\"/></hp:ctrl>",
        enum_raw(&E_COLTYPE, geti(o, "ty", 0)),
        enum_raw(&E_COLLAYOUT, geti(o, "la", 0)),
        geti(o, "co", 1),
        b01(getb(o, "ss")),
        b01(getb(o, "sg"))
    )
}

fn emit_pagenum(o: &Value) -> String {
    let pn = sub(o, "pn");
    format!(
        "<hp:ctrl><hp:pageNum pos=\"{}\" formatType=\"{}\" sideChar=\"{}\"/></hp:ctrl>",
        enum_raw(&E_PAGENUMPOS, geti(pn, "po", 0)),
        enum_raw(&E_NUMFORMAT, geti(pn, "ft", 0)),
        esc_attr(gets(pn, "sc"))
    )
}

// ---------------------------------------------------------------- 개체 공통

fn emit_sz(o: &Value) -> String {
    format!(
        "<hp:sz width=\"{}\" widthRelTo=\"{}\" height=\"{}\" heightRelTo=\"{}\" \
 protect=\"{}\"/>",
        geti(o, "swi", 0),
        enum_raw(&E_WREL, geti(o, "swr", 4)),
        geti(o, "she", 0),
        enum_raw(&E_HREL, geti(o, "shr", 2)),
        b01(getb(o, "spr"))
    )
}

fn emit_pos(o: &Value) -> String {
    format!(
        "<hp:pos treatAsChar=\"{}\" affectLSpacing=\"{}\" flowWithText=\"{}\" \
 allowOverlap=\"{}\" holdAnchorAndSO=\"{}\" vertRelTo=\"{}\" horzRelTo=\"{}\" \
 vertAlign=\"{}\" horzAlign=\"{}\" vertOffset=\"{}\" horzOffset=\"{}\"/>",
        b01(getb(o, "pta")),
        b01(getb(o, "pal")),
        b01(getb(o, "pfw")),
        b01(getb(o, "pao")),
        b01(getb(o, "pha")),
        enum_raw(&E_VRELTO, geti(o, "pvr", 2)),
        enum_raw(&E_HRELTO, geti(o, "phr", 3)),
        enum_raw(&E_VALIGN, geti(o, "pva", 0)),
        enum_raw(&E_HALIGN, geti(o, "ph1", 0)),
        geti(o, "pvo", 0),
        geti(o, "ph2", 0)
    )
}

fn emit_outmargin(o: &Value) -> String {
    format!(
        "<hp:outMargin left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(o, "ole", 0),
        geti(o, "ori", 0),
        geti(o, "oto", 0),
        geti(o, "obo", 0)
    )
}

fn emit_shapecomment(o: &Value) -> String {
    let sc = gets(o, "sc");
    if sc.is_empty() {
        return String::new();
    }
    // JSON 은 CRLF, HWPX 는 LF (사양서 확정)
    let sc = sc.replace("\r\n", "\n").replace('\r', "\n");
    format!("<hp:shapeComment>{}</hp:shapeComment>", esc_text(&sc))
}

/// `ps = {na, pa:[{na, ty, va}]}` → `hp:parameterset`/`hp:listParam`/`hp:stringParam`.
fn emit_paramset(o: &Value) -> String {
    let Some(ps) = o.get("ps").filter(|v| is_truthy_obj(v)) else {
        return String::new();
    };
    let pa = getarr(ps, "pa");
    let mut out = format!(
        "<hp:parameterset cnt=\"{}\" name=\"{}\">",
        pa.len(),
        geti(ps, "na", 0)
    );
    for it in pa {
        out.push_str(&emit_param(it));
    }
    out.push_str("</hp:parameterset>");
    out
}

fn emit_param(it: &Value) -> String {
    let ty = geti(it, "ty", -1);
    let va = it.get("va");
    if ty == 32768 {
        if let Some(inner_obj) = va.filter(|v| v.is_object()) {
            // 중첩 세트
            let inner = getarr(inner_obj, "pa");
            let name = if inner_obj.get("na").is_some() {
                geti(inner_obj, "na", 0)
            } else {
                geti(it, "na", 0)
            };
            let mut out = format!("<hp:listParam cnt=\"{}\" name=\"{}\">", inner.len(), name);
            for s in inner {
                out.push_str(&emit_param(s));
            }
            out.push_str("</hp:listParam>");
            return out;
        }
    }
    if ty == 1 {
        return format!(
            "<hp:stringParam name=\"{}\">{}</hp:stringParam>",
            geti(it, "na", 0),
            esc_text(va.and_then(Value::as_str).unwrap_or(""))
        );
    }
    format!(
        "<hp:integerParam name=\"{}\" value=\"{}\"/>",
        geti(it, "na", 0),
        pyfmt(va)
    )
}

/// `hp:tbl` / `hp:pic` / `hp:rect` 공통 앞머리 속성.
fn obj_common_attrs(o: &Value, extra: &[(&str, Option<String>)]) -> String {
    let mut v: Vec<(&str, Option<String>)> = vec![
        ("id", av(u32v(geti(o, "id", 0)))),
        ("zOrder", av(geti(o, "zo", 0))),
        (
            "numberingType",
            av(enum_raw(&E_NUMBERING, geti(o, "nt", 0))),
        ),
        ("textWrap", av(enum_raw(&E_TEXTWRAP, geti(o, "tw", 1)))),
        ("textFlow", av(enum_raw(&E_TEXTFLOW, geti(o, "tf", 0)))),
        ("lock", av(b01(getb(o, "lo")))),
        ("dropcapstyle", av("None")),
    ];
    v.extend_from_slice(extra);
    attrs(&v)
}

// ---------------------------------------------------------------- 표

fn emit_tbl(m: &Model, ids: &mut Ids, o: &Value) -> Result<String, String> {
    let a = obj_common_attrs(
        o,
        &[
            ("pageBreak", av(enum_raw(&E_TBLBREAK, geti(o, "pb", 2)))),
            ("repeatHeader", av(b01(getb(o, "rh")))),
            ("rowCnt", av(geti(o, "rc", 0))),
            ("colCnt", av(geti(o, "cco", 0))),
            ("cellSpacing", av(geti(o, "cs", 0))),
            (
                "borderFillIDRef",
                borderfill_ref(ids, gets(o, "bf")).map(|v| v.to_string()),
            ),
            ("noAdjust", av(b01(getb(o, "na")))),
        ],
    );
    let mut out = format!("<hp:tbl{a}>");
    out.push_str(&emit_sz(o));
    out.push_str(&emit_pos(o));
    out.push_str(&emit_outmargin(o));
    out.push_str(&emit_caption(m, ids, o)?);
    out.push_str(&format!(
        "<hp:inMargin left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(o, "ile", 0),
        geti(o, "iri", 0),
        geti(o, "ito", 0),
        geti(o, "ibo", 0)
    ));
    if getb(o, "cl") {
        out.push_str("<hp:cellzoneList/>"); // 표본 없음 — 빈 목록만 방어적으로
    }
    for row in getarr(o, "tr") {
        out.push_str("<hp:tr>");
        for cell in row.as_array().map_or(&[][..], |v| &v[..]) {
            out.push_str(&emit_tc(m, ids, cell)?);
        }
        out.push_str("</hp:tr>");
    }
    out.push_str(&emit_shapecomment(o));
    out.push_str("</hp:tbl>");
    Ok(out)
}

/// `tr[][].ps = {na:539, pa:[{na:16384, ty:1, va:"셀이름"}]}` → `hp:tc/@name`.
fn cell_name(cell: &Value) -> String {
    let Some(ps) = cell.get("ps").filter(|v| is_truthy_obj(v)) else {
        return String::new();
    };
    for it in getarr(ps, "pa") {
        if geti(it, "na", 0) == 16384 && geti(it, "ty", 0) == 1 {
            return it
                .get("va")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    }
    String::new()
}

fn emit_tc(m: &Model, ids: &mut Ids, cell: &Value) -> Result<String, String> {
    let head = m.table("sl").get(gets(cell, "so")).unwrap_or(nullv());
    let tc = sub(head, "tc");
    let a = attrs(&[
        ("name", av(cell_name(cell))),
        ("header", av(b01(getb(tc, "he")))),
        ("hasMargin", av(b01(getb(tc, "hm")))),
        ("protect", av(b01(getb(tc, "pr")))),
        ("editable", av(b01(getb(tc, "ed")))),
        ("dirty", av(b01(getb(tc, "di")))),
        (
            "borderFillIDRef",
            borderfill_ref(ids, gets(tc, "bf")).map(|v| v.to_string()),
        ),
    ]);
    let mut out = format!("<hp:tc{a}>");
    out.push_str(&emit_sublist(m, ids, head)?);
    out.push_str(&format!(
        "<hp:cellAddr colAddr=\"{}\" rowAddr=\"{}\"/>",
        geti(tc, "ac", 0),
        geti(tc, "ar", 0)
    ));
    out.push_str(&format!(
        "<hp:cellSpan colSpan=\"{}\" rowSpan=\"{}\"/>",
        geti(tc, "sc", 1),
        geti(tc, "sr", 1)
    ));
    out.push_str(&format!(
        "<hp:cellSz width=\"{}\" height=\"{}\"/>",
        geti(tc, "sw", 0),
        geti(tc, "sh", 0)
    ));
    out.push_str(&format!(
        "<hp:cellMargin left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(tc, "ml", 0),
        geti(tc, "mr", 0),
        geti(tc, "mt", 0),
        geti(tc, "mb", 0)
    ));
    out.push_str("</hp:tc>");
    Ok(out)
}

/// 표 칸·도형 글상자의 `hp:subList` (문단 포함).
fn emit_sublist(m: &Model, ids: &mut Ids, head: &Value) -> Result<String, String> {
    // JSON 은 객체, HWPX 는 그 JSON 문자열을 속성에 이스케이프해 넣는다
    let metatag = getobj(head, "mt")
        .filter(|mt| !mt.is_empty())
        .and_then(|mt| serde_json::to_string(&Value::Object(mt.clone())).ok());
    let a = attrs(&[
        ("id", av("")),
        (
            "textDirection",
            av(enum_raw(&E_TEXTDIR, geti(head, "td", 0))),
        ),
        ("lineWrap", av(enum_raw(&E_LINEWRAP, geti(head, "lw", 0)))),
        ("vertAlign", av(enum_raw(&E_VALIGN, geti(head, "va", 0)))),
        (
            "linkListIDRef",
            av(non_empty(gets(head, "ll")).unwrap_or("0")),
        ),
        (
            "linkListNextIDRef",
            av(non_empty(gets(head, "ln")).unwrap_or("0")),
        ),
        ("textWidth", av(geti(head, "tw", 0))),
        ("textHeight", av(geti(head, "th", 0))),
        ("hasTextRef", av(b01(getb(head, "ht")))),
        ("hasNumRef", av(b01(getb(head, "hn")))),
        ("metatag", metatag),
    ]);
    let mut out = format!("<hp:subList{a}>");
    let sl = m.table("sl");
    for pid in m.sublist_paragraph_ids(gets(head, "hp")) {
        if let Some(p) = sl.get(&pid) {
            out.push_str(&emit_paragraph(m, ids, p)?);
        }
    }
    out.push_str("</hp:subList>");
    Ok(out)
}

fn non_empty(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// [hwpx-cowork] Captions are separate sublists referenced by object.ca.so.
fn emit_caption(m: &Model, ids: &mut Ids, object: &Value) -> Result<String, String> {
    let key = gets(sub(object, "ca"), "so");
    let Some(head) = m.table("sl").get(key) else { return Ok(String::new()); };
    let ca = sub(head, "ca");
    let mut out = format!("<hp:caption side=\"{}\" fullSz=\"{}\" width=\"{}\" gap=\"{}\" lastWidth=\"{}\">",
        enum_raw(&["LEFT", "RIGHT", "TOP", "BOTTOM"], geti(ca, "si", 3)),
        b01(getb(ca, "fs")), geti(ca, "wi", 0), geti(ca, "ga", 0), geti(ca, "lw", 0));
    out.push_str(&emit_sublist(m, ids, head)?);
    out.push_str("</hp:caption>");
    Ok(out)
}

fn emit_auto_number(o: &Value) -> String {
    let an = sub(o, "an");
    format!("<hp:ctrl><hp:autoNum num=\"{}\" numType=\"{}\"><hp:autoNumFormat type=\"{}\" userChar=\"{}\" prefixChar=\"{}\" suffixChar=\"{}\" supscript=\"{}\"/></hp:autoNum></hp:ctrl>",
        geti(an, "nu", 1), enum_raw(&["PAGE", "FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION", "TOTAL_PAGE"], geti(an, "nt", 0)),
        enum_raw(&E_NUMFORMAT, geti(an, "at", 0)), esc_attr(gets(an, "au")),
        esc_attr(gets(an, "ap")), esc_attr(gets(an, "ac")), b01(getb(an, "as")))
}

// ---------------------------------------------------------------- 그리기 개체

fn emit_gso(m: &Model, ids: &mut Ids, o: &Value) -> Result<String, String> {
    emit_gso_at(m,ids,o,0)
}

fn emit_gso_at(m: &Model, ids: &mut Ids, o: &Value, depth: usize) -> Result<String,String> {
    if depth>64 { return Err("묶음 도형의 중첩 깊이가 너무 큽니다".to_string()); }
    let rc = sub(o, "rc");
    // [hwpx-cowork] A non-rectangle is not necessarily a picture. Treating an
    // ellipse/line as a picture silently discarded its geometry and text box.
    match geti(rc, "ci", 0) {
        RC_REC => emit_drawing(m, ids, o, rc, "rect"),
        RC_LIN => emit_drawing(m, ids, o, rc, "line"),
        RC_POL => emit_drawing(m, ids, o, rc, "polygon"),
        RC_ELL => emit_drawing(m, ids, o, rc, "ellipse"),
        RC_ARC => emit_drawing(m, ids, o, rc, "arc"),
        RC_COL => emit_drawing(m, ids, o, rc, "connectLine"),
        RC_CUR => emit_drawing(m, ids, o, rc, "curve"),
        RC_CON => {
            let mut out = emit_shape_head(o, rc, "container", &[]);
            for (index, child) in getarr(rc, "co").iter().enumerate() {
                let child_id = u32v(geti(child, "ii", 0)).wrapping_add(0x3FFF_FFFF);
                let object = serde_json::json!({"rc":child, "id":child_id, "zo":index,
                    "swi":geti(child,"ow",0),"she":geti(child,"oh",0),"swr":4,"shr":2});
                out.push_str(&emit_gso_at(m, ids, &object, depth+1)?);
            }
            out.push_str(&emit_sz(o));out.push_str(&emit_pos(o));out.push_str(&emit_outmargin(o));
            out.push_str(&emit_shapecomment(o));out.push_str(&emit_caption(m, ids, o)?);
            out.push_str("</hp:container>");
            Ok(out)
        }
        RC_PIC => emit_pic(m, ids, o, rc),
        ci => Err(format!("지원하지 않는 hwpjson 도형 종류: {ci}")),
    }
}

fn emit_shape_head(
    o: &Value,
    rc: &Value,
    tag: &str,
    last_attr: &[(&str, Option<String>)],
) -> String {
    let mut extra: Vec<(&str, Option<String>)> = vec![
        ("href", av(gets(rc, "hr"))),
        ("groupLevel", av(geti(rc, "gl", 0))),
        ("instid", av(u32v(geti(rc, "ii", 0)))),
    ];
    extra.extend_from_slice(last_attr);
    let a = obj_common_attrs(o, &extra);
    let mut out = format!("<hp:{tag}{a}>");
    // JSON 은 부호 있는 int32, HWPX 는 부호 없는 uint32
    out.push_str(&format!(
        "<hp:offset x=\"{}\" y=\"{}\"/>",
        u32v(geti(rc, "ox", 0)),
        u32v(geti(rc, "oy", 0))
    ));
    out.push_str(&format!(
        "<hp:orgSz width=\"{}\" height=\"{}\"/>",
        geti(rc, "ow", 0),
        geti(rc, "oh", 0)
    ));
    out.push_str(&format!(
        "<hp:curSz width=\"{}\" height=\"{}\"/>",
        geti(rc, "cw", 0),
        geti(rc, "ch", 0)
    ));
    out.push_str(&format!(
        "<hp:flip horizontal=\"{}\" vertical=\"{}\"/>",
        b01(getb(rc, "fh")),
        b01(getb(rc, "fv"))
    ));
    out.push_str(&format!(
        "<hp:rotationInfo angle=\"{}\" centerX=\"{}\" centerY=\"{}\" rotateimage=\"{}\"/>",
        geti(rc, "ra", 0),
        geti(rc, "rcx", 0),
        geti(rc, "rcy", 0),
        b01(getb(rc, "ri"))
    ));
    out.push_str(&emit_rendering(sub(rc, "in")));
    out
}

fn mat(tag: &str, m: &Value) -> String {
    format!(
        "<hc:{} e1=\"{}\" e2=\"{}\" e3=\"{}\" e4=\"{}\" e5=\"{}\" e6=\"{}\"/>",
        tag,
        num(m.get("e1")),
        num(m.get("e2")),
        num(m.get("e3")),
        num(m.get("e4")),
        num(m.get("e5")),
        num(m.get("e6"))
    )
}

fn emit_rendering(inf: &Value) -> String {
    let mut out = String::from("<hp:renderingInfo>");
    out.push_str(&mat("transMatrix", sub(inf, "tm")));
    for step in getarr(inf, "re") {
        out.push_str(&mat("scaMatrix", sub(step, "sm")));
        out.push_str(&mat("rotMatrix", sub(step, "ro")));
    }
    out.push_str("</hp:renderingInfo>");
    out
}

fn emit_pic(m: &Model, ids: &mut Ids, o: &Value, rc: &Value) -> Result<String, String> {
    let mut out = emit_shape_head(o, rc, "pic", &[("reverse", av(b01(getb(rc, "rc"))))]);
    let img = sub(rc, "img");
    out.push_str(&format!(
        "<hc:img binaryItemIDRef=\"{}\" bright=\"{}\" contrast=\"{}\" \
 effect=\"{}\" alpha=\"{}\"/>",
        bin_ref(m, ids, gets(img, "bi")),
        geti(img, "br", 0),
        geti(img, "co", 0),
        enum_raw(&E_IMGEFFECT, geti(img, "ef", 0)),
        geti(img, "al", 0)
    ));
    out.push_str("<hp:imgRect>");
    for i in 0..4 {
        out.push_str(&format!(
            "<hc:pt{} x=\"{}\" y=\"{}\"/>",
            i,
            geti(rc, &format!("ix{i}"), 0),
            geti(rc, &format!("iy{i}"), 0)
        ));
    }
    out.push_str("</hp:imgRect>");
    out.push_str(&format!(
        "<hp:imgClip left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(rc, "il", 0),
        geti(rc, "ir", 0),
        geti(rc, "it", 0),
        geti(rc, "ib", 0)
    ));
    out.push_str(&format!(
        "<hp:inMargin left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
        geti(rc, "ml", 0),
        geti(rc, "mr", 0),
        geti(rc, "mt", 0),
        geti(rc, "mb", 0)
    ));
    out.push_str(&format!(
        "<hp:imgDim dimwidth=\"{}\" dimheight=\"{}\"/>",
        geti(rc, "iw", 0),
        geti(rc, "ih", 0)
    ));
    // 효과(ef)는 표본이 전부 빈 객체라 채워진 형태가 미확정 — 항상 빈 요소로 낸다.
    out.push_str("<hp:effects/>");
    out.push_str(&emit_sz(o));
    out.push_str(&emit_pos(o));
    out.push_str(&emit_outmargin(o));
    out.push_str(&emit_shapecomment(o));
    out.push_str(&emit_paramset(o));
    out.push_str("</hp:pic>");
    let caption = emit_caption(m, ids, o)?;
    if !caption.is_empty() {
        out = out.replacen("</hp:pic>", &format!("{}</hp:pic>", caption), 1);
    }
    Ok(out)
}

fn emit_drawing(m: &Model, ids: &mut Ids, o: &Value, rc: &Value, kind: &str) -> Result<String, String> {
    // [hwpx-cowork] Shared drawing properties; geometry stays in its own type.
    let extra = match kind {
        "rect" => vec![("ratio", av(geti(rc, "rra", 0)))],
        "line" => vec![("isReverseHV", av(b01(getb(rc, "ir"))))],
        "ellipse" => vec![("intervalDirty", av(b01(getb(rc, "id")))),
            ("hasArcPr", av(b01(getb(rc, "ha")))),
            ("arcType", av(enum_raw(&["NORMAL", "PIE", "CHORD"], geti(rc, "at", 0))))],
        "arc" => vec![("type", av(enum_raw(&["NORMAL", "PIE", "CHORD"], geti(rc, "ty", geti(rc, "at", 0)))))],
        "connectLine" => vec![("type", av(enum_raw(&["STRAIGHT_NOARROW", "STRAIGHT_ONEWAY", "STRAIGHT_BOTH", "STROKE_NOARROW", "STROKE_ONEWAY", "STROKE_BOTH", "ARC_NOARROW", "ARC_ONEWAY", "ARC_BOTH"], geti(rc, "ty", 0))))],
        _ => vec![],
    };
    let mut out = emit_shape_head(o, rc, kind, &extra);
    let ls = sub(rc, "ls");
    out.push_str(&format!(
        "<hp:lineShape color=\"{}\" width=\"{}\" style=\"{}\" endCap=\"{}\" \
 headStyle=\"{}\" tailStyle=\"{}\" headfill=\"{}\" tailfill=\"{}\" \
 headSz=\"{}\" tailSz=\"{}\" outlineStyle=\"{}\" alpha=\"{}\"/>",
        color(geti(ls, "co", 0)),
        geti(ls, "wi", 0),
        enum_raw(&E_LINETYPE, geti(ls, "st", 0)),
        enum_raw(&E_ENDCAP, geti(ls, "ec", 0)),
        enum_raw(&E_ARROW, geti(ls, "hs", 0)),
        enum_raw(&E_ARROW, geti(ls, "ts", 0)),
        b01(getb(ls, "he")),
        b01(getb(ls, "ta")),
        enum_raw(&E_ARROWSZ, geti(ls, "h1", 0)),
        enum_raw(&E_ARROWSZ, geti(ls, "t1", 0)),
        enum_raw(&E_OUTLINE, geti(ls, "os", 0)),
        geti(ls, "al", 0)
    ));
    let wb = sub(rc, "fb").get("wb").filter(|v| is_truthy_obj(v));
    if let Some(wb) = wb {
        out.push_str(&format!(
            "<hc:fillBrush><hc:winBrush faceColor=\"{}\" hatchColor=\"{}\" \
 alpha=\"{}\"/></hc:fillBrush>",
            color(geti(wb, "fc", 0)),
            color(geti(wb, "hc", 0)),
            geti(wb, "al", 0)
        ));
    }
    let sh = sub(rc, "sh");
    if getb(rc, "sh") {
        out.push_str(&format!(
            "<hp:shadow type=\"{}\" color=\"{}\" offsetX=\"{}\" offsetY=\"{}\" alpha=\"{}\"/>",
            enum_raw(&E_SHADOW, geti(sh, "ty", 0)),
            color(geti(sh, "co", 0)),
            geti(sh, "ox", 0),
            geti(sh, "oy", 0),
            geti(sh, "al", 0)
        ));
    }
    let so = gets(rc, "so");
    if let Some(head) = m.table("sl").get(so).filter(|_| !so.is_empty()) {
        let dt = sub(head, "dt");
        // dt.lw 는 클립보드가 -1(미설정)로 버린다 → 소유 컨트롤의 swi 로 복원(사양서 확정)
        let mut lw = geti(dt, "lw", -1);
        if lw < 0 {
            lw = geti(o, "swi", 0);
        }
        out.push_str(&format!(
            "<hp:drawText lastWidth=\"{}\" name=\"\" editable=\"{}\">",
            lw,
            b01(getb(dt, "ed"))
        ));
        out.push_str(&emit_sublist(m, ids, head)?);
        out.push_str(&format!(
            "<hp:textMargin left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\"/>",
            geti(dt, "ml", 0),
            geti(dt, "mr", 0),
            geti(dt, "mt", 0),
            geti(dt, "mb", 0)
        ));
        out.push_str("</hp:drawText>");
    }
    match kind {
        "line" => {
            out.push_str(&format!("<hc:startPt x=\"{}\" y=\"{}\"/><hc:endPt x=\"{}\" y=\"{}\"/>",
                geti(rc, "sx", 0), geti(rc, "sy", 0), geti(rc, "ex", 0), geti(rc, "ey", 0)));
        }
        "polygon" => {
            for pt in getarr(rc, "pt") {
                out.push_str(&format!("<hc:pt x=\"{}\" y=\"{}\"/>", geti(pt, "x", 0), geti(pt, "y", 0)));
            }
        }
        "ellipse" => {
            for (tag, x, y) in [("center", "cx", "cy"), ("ax1", "x1", "y1"), ("ax2", "x2", "y2"),
                ("start1", "sx1", "sy1"), ("end1", "ex1", "ey1"), ("start2", "sx2", "sy2"), ("end2", "ex2", "ey2")] {
                out.push_str(&format!("<hc:{tag} x=\"{}\" y=\"{}\"/>", geti(rc, x, 0), geti(rc, y, 0)));
            }
        }
        "arc" => {
            // [hwpx-cowork] Actual Hancom $arc uses cx1/ax1/ax2 (not $ell's cx/x1/x2).
            for (tag,x,y,old_x,old_y) in [("center","cx1","cy1","cx","cy"),
                ("ax1","ax1","ay1","x1","y1"),("ax2","ax2","ay2","x2","y2")] {
                out.push_str(&format!("<hc:{tag} x=\"{}\" y=\"{}\"/>",
                    geti(rc,x,geti(rc,old_x,0)),geti(rc,y,geti(rc,old_y,0))));
            }
        }
        "connectLine" => {
            for (tag,key) in [("startPt","sp"),("endPt","ep")] {
                let p=sub(rc,key);
                out.push_str(&format!("<hp:{tag} x=\"{}\" y=\"{}\" subjectIDRef=\"{}\" subjectIdx=\"{}\"/>",
                    geti(p,"x",0),geti(p,"y",0),u32v(geti(p,"sr",0)),geti(p,"si",0)));
            }
            if !getarr(rc,"cp").is_empty() {out.push_str("<hp:controlPoints>");}
            for p in getarr(rc,"cp") {
                out.push_str(&format!("<hp:point x=\"{}\" y=\"{}\" type=\"{}\"/>",
                    geti(p,"x",0),geti(p,"y",0),geti(p,"ty",0)));
            }
            if !getarr(rc,"cp").is_empty() {out.push_str("</hp:controlPoints>");}
        }
        "curve" => {
            let points=getarr(rc,"sp");
            for (index,seg) in getarr(rc,"st").iter().enumerate() {
                let start=points.get(index).ok_or_else(|| "곡선의 시작 좌표가 없습니다".to_string())?;
                let end=points.get(index+1).ok_or_else(|| "곡선의 끝 좌표가 없습니다".to_string())?;
                out.push_str(&format!("<hp:seg type=\"{}\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"/>",
                    if geti(seg,"ty",0)==0 {"LINE"} else {"CURVE"},geti(start,"x",0),geti(start,"y",0),geti(end,"x",0),geti(end,"y",0)));
            }
        }
        _ => for i in 0..4 {
            out.push_str(&format!("<hc:pt{i} x=\"{}\" y=\"{}\"/>",
                geti(rc, &format!("x{i}"), 0), geti(rc, &format!("y{i}"), 0)));
        },
    }
    out.push_str(&emit_sz(o));
    out.push_str(&emit_pos(o));
    out.push_str(&emit_outmargin(o));
    out.push_str(&emit_shapecomment(o));
    out.push_str(&emit_paramset(o));
    out.push_str(&format!("</hp:{kind}>"));
    let caption = emit_caption(m, ids, o)?;
    Ok(out.replacen(&format!("</hp:{kind}>"), &format!("{caption}</hp:{kind}>"), 1))
}

// [hwpx-cowork] HWP5 4CC names used by the existing Hancom model exporter.
fn field_type(ci: i64) -> Option<&'static str> {
    [("CLICK_HERE", b"%clk"), ("SUMMARY", b"%smr"), ("TABLEOFCONTENTS", b"%toc"),
        ("CROSSREF", b"%xrf"), ("BOOKMARK", b"%bmk"), ("DATE", b"%dte"),
        ("DOCDATE", b"%ddt"), ("PATH", b"%pat"), ("MAILMERGE", b"%mmg"),
        ("FORMULA", b"%fmu"), ("USERINFO", b"%usr"), ("PRIVATEINFO", b"%cpr"),
        ("REVISION_SIGN", b"%sig")].into_iter()
        .find_map(|(name, tag)| (i64::from(u32::from_be_bytes(*tag)) == ci).then_some(name))
}

// ---------------------------------------------------------------- 문단·run

/// `{cc, ci, co}` 제어문자 → 그 자리에 인라인 중첩되는 HWPX 요소.
fn emit_control(m: &Model, ids: &mut Ids, ch: &Value) -> Result<String, String> {
    // [hwpx-cowork] Tabs have no cs reference; they are inline text tokens.
    if geti(ch, "cc", 0) == 9 {
        return Ok(format!("<hp:t><hp:tab width=\"{}\" leader=\"{}\" type=\"{}\"/></hp:t>",
            geti(ch, "wi", 0), geti(ch, "le", 0), geti(ch, "ty", 1)));
    }
    let control_id = gets(ch, "co");
    let Some(o) = m.table("cs").get(control_id) else {
        return Err(format!("지원하지 않는 hwpjson control 참조: {control_id}"));
    };
    match geti(ch, "ci", 0) {
        CI_SECD => Ok(emit_secpr(m, ids, o)), // ctrl 래핑 없음(사양서 반증 확정)
        CI_COLD => Ok(emit_colpr(o)),         // ctrl 래핑 있음
        CI_PGNP => Ok(emit_pagenum(o)),       // ctrl 래핑 있음
        CI_ATNO => Ok(emit_auto_number(o)),
        CI_NWNO => {
            let nn = sub(o, "nn");
            Ok(format!("<hp:ctrl><hp:newNum num=\"{}\" numType=\"{}\"/></hp:ctrl>",
                geti(nn, "nu", 1), enum_raw(&["PAGE", "FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION", "TOTAL_PAGE"], geti(nn, "nt", 0))))
        }
        CI_MEMO_BEGIN => {
            let fb = sub(o, "fb");
            let id = u32v(geti(fb, "id", 0));
            // [hwpx-cowork] 한글 클립보드에는 협업용 ID가 없으므로 새 메모로
            // 식별한다. Command/작성자까지 보존해야 실시간 저장에서도 살아남는다.
            let pa = sub(fb, "pa");
            let command = gets(pa, "co");
            let parts: Vec<_> = command.splitn(6, '/').collect();
            let author = parts.get(5).and_then(|tail| tail.rsplit_once('/'))
                .map(|(author, _)| author).unwrap_or("");
            let shape = parts.get(1).copied().unwrap_or("65535");
            let number = geti(fb, "zo", 1).max(1);
            let mut out = format!(
                "<hp:ctrl><hp:fieldBegin id=\"{id}\" type=\"MEMO\" name=\"\" editable=\"{}\" dirty=\"{}\" zorder=\"{number}\" fieldid=\"{}\">\
                 <hp:parameters cnt=\"6\" name=\"\"><hp:integerParam name=\"Prop\">{}</hp:integerParam>\
                 <hp:stringParam name=\"Command\">{}</hp:stringParam>\
                 <hp:stringParam name=\"ID\">clipboard-memo-{id}</hp:stringParam>\
                 <hp:integerParam name=\"Number\">{number}</hp:integerParam>\
                 <hp:stringParam name=\"Author\">{}</hp:stringParam>\
                 <hp:stringParam name=\"MemoShapeIDRef\">{}</hp:stringParam></hp:parameters>",
                b01(getb(fb, "ed")), b01(getb(fb, "di")), u32v(geti(fb, "fi", CI_MEMO_BEGIN)),
                geti(pa, "pr", 0), esc_text(command), esc_text(author), esc_text(shape)
            );
            if let Some(head) = m.table("sl").get(gets(fb, "so")) {
                out.push_str(&emit_sublist(m, ids, head)?);
            }
            out.push_str("</hp:fieldBegin></hp:ctrl>");
            Ok(out)
        }
        CI_MEMO_END => {
            let begin = m.table("cs").get(gets(o, "fo")).unwrap_or(nullv());
            Ok(format!("<hp:ctrl><hp:fieldEnd beginIDRef=\"{}\"/></hp:ctrl>", u32v(geti(sub(begin, "fb"), "id", 0))))
        }
        CI_HYPERLINK_BEGIN => {
            let fb = sub(o, "fb");
            if !fb.is_object() || fb.get("id").is_none() {
                return Err("하이퍼링크 시작 필드 정보가 없습니다".to_string());
            }
            let pa = sub(fb, "pa");
            // Command는 한글의 이스케이프·대상 종류·옵션까지 포함하는 원본이다.
            // URL만 추출해 다시 만들면 문서 안 링크와 특수문자가 달라질 수 있다.
            Ok(format!(
                "<hp:ctrl><hp:fieldBegin id=\"{}\" type=\"HYPERLINK\" name=\"\" editable=\"{}\" dirty=\"{}\" fieldid=\"{}\">\
                 <hp:parameters cnt=\"3\" name=\"\"><hp:integerParam name=\"Prop\">{}</hp:integerParam>\
                 <hp:stringParam name=\"Command\">{}</hp:stringParam>\
                 <hp:stringParam name=\"Fiexde\">{}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>",
                u32v(geti(fb, "id", 0)), b01(getb(fb, "ed")), b01(getb(fb, "di")),
                u32v(geti(fb, "fi", CI_HYPERLINK_BEGIN)), geti(pa, "pr", 0),
                esc_text(gets(pa, "co")), b01(getb(pa, "fi"))
            ))
        }
        CI_HYPERLINK_END => {
            let begin = m.table("cs").get(gets(o, "fo"))
                .filter(|begin| geti(begin, "ci", 0) == CI_HYPERLINK_BEGIN)
                .ok_or_else(|| "하이퍼링크 끝 필드의 시작 참조가 없습니다".to_string())?;
            let fb = sub(begin, "fb");
            if fb.get("id").is_none() {
                return Err("하이퍼링크 시작 필드의 id가 없습니다".to_string());
            }
            Ok(format!("<hp:ctrl><hp:fieldEnd beginIDRef=\"{}\"/></hp:ctrl>", u32v(geti(fb, "id", 0))))
        }
        CI_TBL => emit_tbl(m, ids, o),
        CI_GSO => emit_gso(m, ids, o),
        CI_PGHD => {
            let ph = sub(o, "ph");
            Ok(format!("<hp:ctrl><hp:pageHiding hideHeader=\"{}\" hideFooter=\"{}\" hideMasterPage=\"{}\" hideBorder=\"{}\" hideFill=\"{}\" hidePageNum=\"{}\"/></hp:ctrl>",
                b01(getb(ph, "hh")), b01(getb(ph, "hf")), b01(getb(ph, "hm")),
                b01(getb(ph, "hb")), b01(getb(ph, "hi")), b01(getb(ph, "hp"))))
        }
        CI_BOKM => {
            let name = getarr(sub(o, "ps"), "pa").iter().find(|p| geti(p, "na", 0) == 16384)
                .and_then(|p| p.get("va")).and_then(Value::as_str)
                .ok_or_else(|| "책갈피 이름이 없습니다".to_string())?;
            Ok(format!("<hp:ctrl><hp:bookmark name=\"{}\"/></hp:ctrl>", esc_attr(name)))
        }
        CI_FN | CI_EN | CI_HEAD | CI_FOOT => {
            let (tag, key) = match geti(ch, "ci", 0) {
                CI_FN => ("footNote", "fn"), CI_EN => ("endNote", "en"),
                CI_HEAD => ("header", "he"), _ => ("footer", "fo"),
            };
            let value = sub(o, key);
            let head = m.table("sl").get(gets(value, "so"))
                .ok_or_else(|| format!("{tag} 문단 목록이 없습니다"))?;
            let apply = if matches!(geti(ch, "ci", 0), CI_HEAD | CI_FOOT) {
                format!(" applyPageType=\"{}\"", enum_raw(&["BOTH", "EVEN", "ODD"], geti(value, "ap", 0)))
            } else { String::new() };
            Ok(format!("<hp:ctrl><hp:{tag} id=\"{}\"{apply}>{}</hp:{tag}></hp:ctrl>",
                u32v(geti(value, "id", 0)), emit_sublist(m, ids, head)?))
        }
        CI_EQED => {
            let eq = sub(o, "eq");
            let extra = [("version", av(gets(eq, "ve"))), ("baseLine", av(geti(eq, "bl", 0))),
                ("textColor", av(color(geti(eq, "tc", 0)))), ("baseUnit", av(geti(eq, "bu", 1000))),
                ("lineMode", av(if getb(eq, "lm") { "LINE" } else { "CHAR" })), ("font", av(gets(eq, "fn")))];
            Ok(format!("<hp:equation{}>{}{}{}{}<hp:script>{}</hp:script>{}</hp:equation>",
                obj_common_attrs(o, &extra), emit_sz(o), emit_pos(o), emit_outmargin(o),
                emit_shapecomment(o), esc_text(gets(eq, "sc")), emit_caption(m, ids, o)?))
        }
        ci if field_type(ci).is_some() && geti(ch, "cc", 0) == 3 => {
            let fb = sub(o, "fb");
            let pa = sub(fb, "pa");
            if fb.get("id").is_none() { return Err("필드 시작 id가 없습니다".to_string()); }
            Ok(format!("<hp:ctrl><hp:fieldBegin id=\"{}\" type=\"{}\" name=\"{}\" editable=\"{}\" dirty=\"{}\" fieldid=\"{}\"><hp:parameters cnt=\"3\" name=\"\"><hp:integerParam name=\"Prop\">{}</hp:integerParam><hp:stringParam name=\"Command\">{}</hp:stringParam><hp:stringParam name=\"Fiexde\">{}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>",
                u32v(geti(fb, "id", 0)), field_type(ci).unwrap_or(""), esc_attr(gets(fb, "na")),
                b01(getb(fb, "ed")), b01(getb(fb, "di")), u32v(geti(fb, "fi", ci)),
                geti(pa, "pr", 0), esc_text(gets(pa, "co")), b01(getb(pa, "fi"))))
        }
        ci if geti(ch, "cc", 0) == 4 && o.get("fo").is_some() => {
            let begin = m.table("cs").get(gets(o, "fo"))
                .ok_or_else(|| "지원하지 않는 필드 끝: 시작 참조가 없습니다".to_string())?;
            let begin_ci = geti(begin, "ci", 0);
            let expected = if field_type(begin_ci) == Some("TABLEOFCONTENTS") {
                0x0800_0000 | (begin_ci & 0x00FF_FFFF)
            } else { begin_ci & 0x00FF_FFFF };
            if field_type(begin_ci).is_none() || expected != ci || sub(begin, "fb").get("id").is_none() {
                return Err(format!("지원하지 않는 필드 끝 종류 또는 잘못된 시작 참조: {ci}"));
            }
            Ok(format!("<hp:ctrl><hp:fieldEnd beginIDRef=\"{}\"/></hp:ctrl>", u32v(geti(sub(begin, "fb"), "id", 0))))
        }
        ci => Err(format!(
            "지원하지 않는 hwpjson control 종류: ci={ci}, co={control_id}"
        )),
    }
}

/// 원본은 구역정의 run 과 그 뒤 내용을 분리해 적는다.
///
/// `cc=2`(secd/cold) 뒤에 다른 내용이 이어지면 run 을 둘로 나눈다
/// (원본 첫 문단: run1=[secPr, ctrl/colPr], run2=[ctrl/pageNum, t]).
fn split_run(ch: &[Value]) -> Vec<&[Value]> {
    let mut last2: i64 = -1;
    for (i, c) in ch.iter().enumerate() {
        if geti(c, "cc", 0) == 2 {
            last2 = i as i64;
        }
    }
    if last2 >= 0 && (last2 as usize) < ch.len().saturating_sub(1) {
        let cut = last2 as usize + 1;
        return vec![&ch[..cut], &ch[cut..]];
    }
    vec![ch]
}

fn emit_run(m: &Model, ids: &mut Ids, cp_objid: &str, ch: &[Value]) -> Result<String, String> {
    let cid = charpr_ref(ids, cp_objid);
    let has_obj = ch.iter().any(|c| c.get("t").is_none());
    let mut body = String::new();
    for c in ch {
        if let Some(t) = c.get("t").and_then(Value::as_str) {
            // 개체 없는 run 의 빈 텍스트는 원본이 <hp:run …/> 로만 적는다
            if t.is_empty() && !has_obj {
                continue;
            }
            if t.is_empty() {
                body.push_str("<hp:t/>");
            } else {
                // [hwpx-cowork] Hancom encodes these inline controls as HWP5
                // characters. Restore semantic XML instead of dropping C0 bytes.
                let text = t.chars().map(|c| match c {
                    '\n' => "<hp:lineBreak/>".to_string(),
                    '\u{1e}' => "<hp:nbSpace/>".to_string(),
                    '\u{1f}' => "<hp:fwSpace/>".to_string(),
                    '\u{18}' => "<hp:hypen/>".to_string(),
                    _ => esc_text(&c.to_string()),
                }).collect::<String>();
                body.push_str(&format!("<hp:t>{text}</hp:t>"));
            }
        } else {
            body.push_str(&emit_control(m, ids, c)?);
        }
    }
    // 🔴 정본은 참조가 없어도 속성을 생략하지 않는다(빈 run 도 charPrIDRef 를 달고 나간다).
    let cid = opt_str(cid);
    if body.is_empty() {
        Ok(format!("<hp:run charPrIDRef=\"{cid}\"/>"))
    } else {
        Ok(format!("<hp:run charPrIDRef=\"{cid}\">{body}</hp:run>"))
    }
}

fn emit_paragraph(m: &Model, ids: &mut Ids, p: &Value) -> Result<String, String> {
    let bf = geti(p, "bf", 0);
    let sec_break = bf & 1; // 구역 나누기 — HWPX 는 구조로 표현, 속성은 전부 0
    let a = attrs(&[
        ("id", av(u32v(geti(p, "id", 0)))),
        (
            "paraPrIDRef",
            parapr_ref(ids, gets(p, "pp")).map(|v| v.to_string()),
        ),
        (
            "styleIDRef",
            style_ref(ids, gets(p, "si")).map(|v| v.to_string()),
        ),
        (
            "pageBreak",
            av(if sec_break != 0 { 0 } else { (bf >> 2) & 1 }),
        ),
        (
            "columnBreak",
            // [hwpx-cowork] bit 1은 다단 정의, bit 3이 실제 단 나누기다.
            av(if sec_break != 0 { 0 } else { (bf >> 3) & 1 }),
        ),
        ("merged", av(0)),
    ]);
    let mut out = format!("<hp:p{a}>");
    for run in getarr(p, "ru") {
        let ch = getarr(run, "ch");
        let cp = gets(run, "cp").to_string();
        for part in split_run(ch) {
            out.push_str(&emit_run(m, ids, &cp, part)?);
        }
    }
    // hp:linesegarray 는 레이아웃 캐시이며 클립보드 모델에 값이 없다 → 생략
    // (한글이 열 때 다시 계산한다)
    out.push_str("</hp:p>");
    Ok(out)
}

// ---------------------------------------------------------------- 공개 API

/// `<hs:sec …> … </hs:sec>` 전체를 문자열로 만든다.
pub fn emit_section(m: &Model, ids: &mut Ids) -> Result<String, String> {
    let mut out = String::from(SEC_OPEN);
    let ro = m.table("ro");
    for pid in m.body_paragraph_ids() {
        if let Some(p) = ro.get(&pid) {
            out.push_str(&emit_paragraph(m, ids, p)?);
        }
    }
    out.push_str("</hs:sec>");
    Ok(out)
}

/// XML 선언 + 본문.
pub fn emit_section_file(m: &Model, ids: &mut Ids) -> Result<String, String> {
    let mut s = String::from(SEC_XML_DECL);
    s.push_str(&emit_section(m, ids)?);
    Ok(s)
}
