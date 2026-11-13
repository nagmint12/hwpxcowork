//! [hwpx-cowork] 설치 글꼴 폭 표(`font_metrics_local.rs`)로 한/글과 **같은** 글자 전진폭을 잰다.
//!
//! 한/글은 글자 폭을 글꼴 파일의 hmtx 전진폭으로 정하되 내부 단위 4 HWPUNIT(1/1800 inch) 격자에서
//! 반올림한다. 2026-10-27 보정 문서(글꼴 5종 × 크기 9~22pt × 자간 -8~+10% × 장평 90~100% ×
//! 진하게 × 공백폭 사용, 글자 28종 — 한/글 2024 PDF 의 600dpi 글자 위치, 1,428건)로 확인한 셈법:
//!
//! ```text
//!   S   = floor(글자 크기 HU / 4)                       (10pt → 250, 9.5pt → 237)
//!   자연폭 = 장평 100% : round_half_up(g × S)          g = 전진폭 / unitsPerEm
//!          장평 ≠100% : floor(g × S × 장평/100)
//!   공백(글꼴 공백폭 안 씀) 자연폭 = round_half_up(floor(S/2) × 장평/100) — 글꼴과 무관한 반각
//!   전진폭 = 4 × (자연폭 + round_half_away(자연폭 × 자간/100))   HWPUNIT
//! ```
//!
//! 진하게는 전진폭을 바꾸지 않는다(맑은 고딕 진하게도 보통 글꼴 hmtx). 자간은 글자 폭 비례다
//! (종전 rhwp 의 `glyph_letter_spacing` 과 같은 축이나 격자 반올림이 없어 한 글자 ±4HU 까지 어긋났다 —
//! 11pt 바탕 한 줄 45자에서 2px, 줄 끝 낱말이 한 글자 일찍 꺾였다).
//! 표에 없는 글꼴·글자는 이 셈법을 쓰지 않고 종전 측정(내장 메트릭·휴리스틱)으로 간다.

use super::font_metrics_local::{LocalFontFace, LOCAL_FONT_FACES, LOCAL_FONT_NAMES};
use std::cell::RefCell;
use std::collections::HashMap;

impl LocalFontFace {
    /// 글자의 hmtx 전진폭(글꼴 단위). 글꼴에 없는 글자는 `None`.
    pub(crate) fn advance(&self, c: char) -> Option<u16> {
        let cp = c as u32;
        // [hwpx-cowork] Extracted native HFT faces store sparse Unicode runs,
        // including KS Hangul. Installed SFNT's compressed Hangul table stays
        // authoritative when present; absent syllables are never invented.
        if (0xAC00..=0xD7A3).contains(&cp) && !self.hangul.widths.is_empty() {
            let h = &self.hangul;
            if h.widths.is_empty() {
                return None;
            }
            let i = (cp - 0xAC00) as usize;
            let (cho, jung, jong) = (i / 588, (i % 588) / 28, i % 28);
            let idx = (h.cho[cho] as usize * h.nj as usize + h.jung[jung] as usize) * h.nk as usize
                + h.jong[jong] as usize;
            return h.widths.get(idx).copied().filter(|w| *w > 0);
        }
        let i = self.runs.partition_point(|r| r.0 <= cp);
        let &(start, extra, w) = self.runs.get(i.checked_sub(1)?)?;
        (cp <= start + u32::from(extra) && w > 0).then_some(w)
    }

    /// 전진폭을 em 비율로.
    pub(crate) fn advance_em(&self, c: char) -> Option<f64> {
        self.advance(c)
            .map(|w| f64::from(w) / f64::from(self.upm.max(1)))
    }
}

thread_local! {
    // [hwpx-cowork] 2026-11-10 P1 성능: 글자마다 불리는 이름 조회라 SipHash 대신 빠른 해셔(값은 같다).
    static FACE_CACHE: RefCell<HashMap<String, Option<u16>, super::hancom_fontdb::FastBuild>> =
        RefCell::new(HashMap::default());
}

/// 글꼴 이름(한/글 face 이름 또는 CSS 글꼴 목록의 첫 이름)으로 설치 글꼴 폭 표를 찾는다.
/// 이름은 공백을 없애고 소문자로 맞춰 비교한다(`맑은 고딕` = `맑은고딕`).
pub(crate) fn find_local_face(font_family: &str) -> Option<&'static LocalFontFace> {
    let primary = font_family
        .split(',')
        .next()
        .unwrap_or(font_family)
        .trim()
        .trim_matches(|c| c == '\'' || c == '"');
    if primary.is_empty() {
        return None;
    }
    // [hwpx-cowork] Generated SFNT and layout consume the same source advances.
    if let Some(face) = super::hft_ttf::find_face(primary) { return Some(face); }
    let idx = FACE_CACHE.with(|cache| {
        if let Some(hit) = cache.borrow().get(primary) {
            return *hit;
        }
        let key: String = primary
            .chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect();
        let found = LOCAL_FONT_NAMES
            .binary_search_by(|(name, _)| (*name).cmp(key.as_str()))
            .ok()
            .map(|i| LOCAL_FONT_NAMES[i].1);
        cache.borrow_mut().insert(primary.to_string(), found);
        found
    })?;
    LOCAL_FONT_FACES.get(idx as usize)
}

fn round_half_away(x: f64) -> i64 {
    let r = (x.abs() + 0.5 + 1e-9).floor() as i64;
    if x < 0.0 {
        -r
    } else {
        r
    }
}

/// 한/글 4 HWPUNIT 격자의 글자 전진폭(HWPUNIT).
///
/// * `em` — 글리프 전진폭 / unitsPerEm. `None` 이면 글꼴과 무관한 반각 공백 규칙.
/// * `size_hu` — 글자 크기(HWPUNIT, 10pt = 1000)
/// * `ratio_pct` · `spacing_pct` — 장평·자간(%)
pub(crate) fn hancom_advance_hu(em: Option<f64>, size_hu: i64, ratio_pct: i64, spacing_pct: i64) -> i64 {
    const EPS: f64 = 1e-7;
    let s = size_hu.max(0) / 4;
    let natural = match em {
        Some(g) if ratio_pct == 100 => (g * s as f64 + 0.5 + EPS).floor() as i64,
        Some(g) => (g * s as f64 * ratio_pct as f64 / 100.0 + EPS).floor() as i64,
        None => ((s / 2) as f64 * ratio_pct as f64 / 100.0 + 0.5 + EPS).floor() as i64,
    };
    4 * (natural + round_half_away(natural as f64 * spacing_pct as f64 / 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hancom_grid_matches_calibration() {
        // 2026-10-27 한/글 보정 PDF 실측(HWPUNIT)
        assert_eq!(hancom_advance_hu(Some(0.872), 1000, 100, 0), 872);
        assert_eq!(hancom_advance_hu(Some(0.506), 1000, 100, 0), 508); // 126.5 → 127
        assert_eq!(hancom_advance_hu(Some(0.558), 1000, 100, -3), 544); // 140 - 4.2 → 136
        assert_eq!(hancom_advance_hu(Some(0.936), 1100, 100, -3), 996);
        assert_eq!(hancom_advance_hu(Some(0.563), 1000, 90, 0), 504); // floor(126.675)
        assert_eq!(hancom_advance_hu(Some(1.0), 1000, 100, -3), 968); // 250 - 7.5 → 242
        assert_eq!(hancom_advance_hu(Some(0.18), 1100, 100, -3), 192); // 50 - 1.5 → 48
        assert_eq!(hancom_advance_hu(Some(1.0), 950, 100, 0), 948); // S = 237
        assert_eq!(hancom_advance_hu(None, 1000, 100, -3), 484);
        assert_eq!(hancom_advance_hu(None, 1100, 100, -3), 532);
        assert_eq!(hancom_advance_hu(None, 1000, 90, 0), 452);
    }
}
