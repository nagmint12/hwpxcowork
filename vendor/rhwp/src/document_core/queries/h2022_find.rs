//! [hwpx-cowork] 한/글 2022 찾기 옵션 — 온전한 낱말·아무개 문자·여러 단어 찾기·띄어쓰기 무시·자소 단위 찾기.
//!
//! 한/글 2022 COM 실측(2026-11-11, `FindReplace` 파라미터 셋으로 `AllReplace`, 원문
//! `학교에 학교 학교가 school schools School 가나 가 나 가  나 abcd abxd a1c a22c ab a?c`)이 근거다.
//! - 대소문자 구별(MatchCase) 끔이 기본: `school` 이 `School` 까지 찾는다.
//! - 온전한 낱말(WholeWordOnly): 앞뒤 글자가 글자·숫자가 아닐 때만 — `학교` 는 `학교에`·`학교가` 를 찾지 않고,
//!   `가` 는 `가나` 를 찾지 않는다(한글 음절도 낱말 글자다).
//! - 아무개 문자(UseWildCards): `?` 는 한 글자, `*` 는 띄어쓰기를 넘지 않는 0글자 이상 — `a*c` 가 `abxd a1c` 를 한 번에 잡지 않는다.
//!   끄면 `?`·`*` 는 그 글자 그대로다.
//! - 여러 단어 찾기(SeveralWords): 쉼표(`,`)·쌍반점(`;`)으로 나눈 낱말을 모두 찾는다. 빈칸은 나누지 않는다.
//! - 띄어쓰기 무시(AllWordForms — 공식 표 이름 '문자열 결합'): 찾을 말의 빈칸 하나가 본문의 빈칸 0~1개에 맞는다
//!   (`가 나` → `가나`·`가 나`, `가  나` 는 아님). 찾을 말에 빈칸이 없으면 본문 빈칸을 건너뛰지 않는다(`가나` ↛ `가 나`).
//! - 자소 단위 찾기(FindJaso): 한글 음절을 자모로 풀어 맞추고, 찾은 범위는 음절 단위다(`ㅎ` → `학`, `학교` → `학교`).
//!
//! 매처는 [`super::search_query`] 의 `find_in_text` 가 이 옵션이 켜진 동안(스레드 지역) 대신 부른다 —
//! 찾기·모두 찾기·모두 바꾸기가 같은 규칙을 쓴다.

use std::cell::RefCell;

/// 찾기 옵션(편집기 찾기 대화상자 ↔ JSON).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FindOptions {
    pub match_case: bool,
    pub whole_word: bool,
    pub wildcard: bool,
    pub several_words: bool,
    pub ignore_space: bool,
    pub jaso: bool,
}

impl FindOptions {
    /// 종전 매처와 다른 규칙이 하나라도 켜졌는가(대소문자만이면 종전 매처 그대로).
    fn needs_custom(&self) -> bool {
        self.whole_word || self.wildcard || self.several_words || self.ignore_space || self.jaso
    }
}

thread_local! {
    static ACTIVE: RefCell<Option<FindOptions>> = const { RefCell::new(None) };
}

struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        ACTIVE.with(|a| *a.borrow_mut() = None);
    }
}

/// `opts` 를 켠 채 `f` 를 부른다(돌아오면 — 패닉이어도 — 끈다).
pub(crate) fn with_options<T>(opts: FindOptions, f: impl FnOnce() -> T) -> T {
    let custom = opts.needs_custom();
    ACTIVE.with(|a| *a.borrow_mut() = custom.then_some(opts));
    let _reset = Reset;
    f()
}

/// 켜진 옵션이 있으면 그 규칙의 매치(겹치지 않음, 원문 글자 자리·길이). 없으면 `None`(종전 매처).
pub(crate) fn active_matches(
    text: &str,
    query: &str,
    case_sensitive: bool,
) -> Option<Vec<(usize, usize)>> {
    ACTIVE.with(|a| {
        a.borrow()
            .as_ref()
            .map(|o| find_with_options(text, query, case_sensitive, o))
    })
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Lit(char),
    /// `?` — 아무 글자 하나
    One,
    /// `*` — 띄어쓰기 아닌 글자 0개 이상
    Many,
    /// 띄어쓰기 무시의 빈칸 — 본문 빈칸 0~1개
    OptSpace,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        return c;
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn tokens(word: &str, o: &FindOptions) -> Vec<Tok> {
    let mut out = Vec::new();
    for c in word.chars() {
        let t = match c {
            '?' if o.wildcard => Tok::One,
            '*' if o.wildcard => Tok::Many,
            c if o.ignore_space && c.is_whitespace() => Tok::OptSpace,
            c => Tok::Lit(c),
        };
        // 이어진 `*` 는 하나와 같다
        if t == Tok::Many && out.last() == Some(&Tok::Many) {
            continue;
        }
        out.push(t);
    }
    out
}

/// 한글 음절이면 (초성, 중성, 종성?) 호환 자모, 아니면 그 글자 하나.
fn jamo_of(c: char) -> Vec<char> {
    const CHO: [char; 19] = [
        'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ',
        'ㅌ', 'ㅍ', 'ㅎ',
    ];
    const JUNG: [char; 21] = [
        'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ',
        'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
    ];
    const JONG: [char; 28] = [
        '\0', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ',
        'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
    ];
    let code = c as u32;
    if !(0xAC00..=0xD7A3).contains(&code) {
        return vec![c];
    }
    let s = code - 0xAC00;
    let (cho, jung, jong) = ((s / 588) as usize, ((s % 588) / 28) as usize, (s % 28) as usize);
    let mut v = vec![CHO[cho], JUNG[jung]];
    if jong > 0 {
        v.push(JONG[jong]);
    }
    v
}

/// 원문 글자 하나를 비교 단위로 — 자소 찾기면 자모 여럿(각 단위는 원문 글자 번호를 기억).
fn units(text: &[char], jaso: bool, cs: bool) -> Vec<(char, usize)> {
    let mut out = Vec::with_capacity(text.len());
    for (i, &c) in text.iter().enumerate() {
        if jaso {
            for j in jamo_of(c) {
                out.push((fold(j, cs), i));
            }
        } else {
            out.push((fold(c, cs), i));
        }
    }
    out
}

/// `units[ui..]` 에서 `pat[pi..]` 가 맞으면 끝 단위 번호(배타).
fn match_here(u: &[(char, usize)], ui: usize, pat: &[Tok], pi: usize) -> Option<usize> {
    if pi == pat.len() {
        return Some(ui);
    }
    match &pat[pi] {
        Tok::Lit(c) => (ui < u.len() && u[ui].0 == *c)
            .then(|| match_here(u, ui + 1, pat, pi + 1))
            .flatten(),
        Tok::One => (ui < u.len()).then(|| match_here(u, ui + 1, pat, pi + 1)).flatten(),
        Tok::OptSpace => {
            if ui < u.len() && u[ui].0.is_whitespace() {
                if let Some(e) = match_here(u, ui + 1, pat, pi + 1) {
                    return Some(e);
                }
            }
            match_here(u, ui, pat, pi + 1)
        }
        Tok::Many => {
            // 짧은 것부터(가장 가까운 끝) — 띄어쓰기를 넘지 않는다
            let mut k = ui;
            loop {
                if let Some(e) = match_here(u, k, pat, pi + 1) {
                    return Some(e);
                }
                if k >= u.len() || u[k].0.is_whitespace() {
                    return None;
                }
                k += 1;
            }
        }
    }
}

/// 한 낱말(여러 단어면 그 하나)의 매치들(겹침 허용 — 호출자가 고른다).
fn word_matches(text: &[char], word: &str, cs: bool, o: &FindOptions) -> Vec<(usize, usize)> {
    let mut pat = tokens(word, o);
    // 앞뒤의 빈칸 무시 칸·`*` 는 범위만 넓히므로 뗀다(빈 매치·불필요한 빈칸 포함 방지)
    while matches!(pat.first(), Some(Tok::OptSpace) | Some(Tok::Many)) {
        pat.remove(0);
    }
    while matches!(pat.last(), Some(Tok::OptSpace) | Some(Tok::Many)) {
        pat.pop();
    }
    if pat.is_empty() {
        return Vec::new();
    }
    let pat: Vec<Tok> = if o.jaso {
        pat.into_iter()
            .flat_map(|t| match t {
                Tok::Lit(c) => jamo_of(c)
                    .into_iter()
                    .map(|j| Tok::Lit(fold(j, cs)))
                    .collect::<Vec<_>>(),
                t => vec![t],
            })
            .collect()
    } else {
        pat.into_iter()
            .map(|t| match t {
                Tok::Lit(c) => Tok::Lit(fold(c, cs)),
                t => t,
            })
            .collect()
    };
    let u = units(text, o.jaso, cs);
    let mut out = Vec::new();
    for ui in 0..u.len() {
        // 자소 찾기도 음절 머리에서만 시작한다
        if ui > 0 && u[ui - 1].1 == u[ui].1 {
            continue;
        }
        let Some(end_u) = match_here(&u, ui, &pat, 0) else {
            continue;
        };
        if end_u == ui {
            continue;
        }
        let start = u[ui].1;
        let end = u[end_u - 1].1 + 1; // 끝 단위가 든 원문 글자까지(자소면 음절째)
        if o.whole_word {
            let before = start.checked_sub(1).map(|i| text[i]);
            let after = text.get(end).copied();
            if before.is_some_and(is_word_char) || after.is_some_and(is_word_char) {
                continue;
            }
        }
        out.push((start, end - start));
    }
    out
}

/// 옵션 규칙으로 찾은 겹치지 않는 매치(앞에서부터, 같은 자리면 긴 것).
pub fn find_with_options(
    text: &str,
    query: &str,
    case_sensitive: bool,
    o: &FindOptions,
) -> Vec<(usize, usize)> {
    if query.is_empty() || text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let cs = case_sensitive || o.match_case;
    let words: Vec<&str> = if o.several_words {
        query
            .split([',', ';'])
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .collect()
    } else {
        vec![query]
    };
    let mut all: Vec<(usize, usize)> = words
        .iter()
        .flat_map(|w| word_matches(&chars, w, cs, o))
        .collect();
    all.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::new();
    let mut end = 0usize;
    for (s, l) in all {
        if s >= end && l > 0 {
            out.push((s, l));
            end = s + l;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! 고정형: 기대값은 2026-11-11 한/글 2022 COM `AllReplace` 실측(모듈 머리 주석의 원문)에서 가져왔다.
    use super::*;

    const T: &str = "학교에 학교 학교가 school schools School 가나 가 나 가  나 abcd abxd a1c a22c ab a?c";

    fn replaced(query: &str, o: FindOptions) -> String {
        let chars: Vec<char> = T.chars().collect();
        let mut out: Vec<char> = Vec::new();
        let mut i = 0;
        for (s, l) in find_with_options(T, query, false, &o) {
            out.extend(&chars[i..s]);
            out.push('#');
            i = s + l;
        }
        out.extend(&chars[i..]);
        out.into_iter().collect()
    }

    #[test]
    fn whole_word_matches_hangul_measurement() {
        let o = FindOptions { whole_word: true, ..Default::default() };
        assert_eq!(replaced("학교", o.clone()), "학교에 # 학교가 school schools School 가나 가 나 가  나 abcd abxd a1c a22c ab a?c");
        assert_eq!(replaced("가", o), "학교에 학교 학교가 school schools School 가나 # 나 #  나 abcd abxd a1c a22c ab a?c");
    }

    #[test]
    fn wildcard_matches_hangul_measurement() {
        let o = FindOptions { wildcard: true, ..Default::default() };
        assert_eq!(replaced("a?c", o.clone()), "학교에 학교 학교가 school schools School 가나 가 나 가  나 #d abxd # a22c ab #");
        assert_eq!(replaced("a*c", o.clone()), "학교에 학교 학교가 school schools School 가나 가 나 가  나 #d abxd # # ab #");
        assert_eq!(replaced("ab*d", o), "학교에 학교 학교가 school schools School 가나 가 나 가  나 # # a1c a22c ab a?c");
    }

    #[test]
    fn several_words_and_spaces_match_hangul_measurement() {
        let o = FindOptions { several_words: true, ..Default::default() };
        assert_eq!(replaced("학교,school", o.clone()), "#에 # #가 # #s # 가나 가 나 가  나 abcd abxd a1c a22c ab a?c");
        assert_eq!(replaced("학교;school", o.clone()), "#에 # #가 # #s # 가나 가 나 가  나 abcd abxd a1c a22c ab a?c");
        assert_eq!(replaced("학교 school", o), T);
        let s = FindOptions { ignore_space: true, ..Default::default() };
        assert_eq!(replaced("가나", s.clone()), "학교에 학교 학교가 school schools School # 가 나 가  나 abcd abxd a1c a22c ab a?c");
        assert_eq!(replaced("가 나", s), "학교에 학교 학교가 school schools School # # 가  나 abcd abxd a1c a22c ab a?c");
    }

    #[test]
    fn jaso_matches_hangul_measurement() {
        let o = FindOptions { jaso: true, ..Default::default() };
        assert_eq!(replaced("ㅎ", o.clone()), "#교에 #교 #교가 school schools School 가나 가 나 가  나 abcd abxd a1c a22c ab a?c");
        assert_eq!(replaced("학교", o), "#에 # #가 school schools School 가나 가 나 가  나 abcd abxd a1c a22c ab a?c");
    }
}
