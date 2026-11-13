//! [hwpx-cowork] 쪽 나눔 결정 기록 — `getLayoutDecisions()` 가 켤 때만 모은다(평소에는 비용 없음).
//!
//! 쪽 나눔 엔진(typeset)의 흐름 높이(current_height)를 바꾸는 자리·쪽을 넘기는 자리·항목을 쪽에 넣는 자리가 모두
//! `TypesetState` 의 몇몇 메서드를 지나므로, 그 메서드에서 `#[track_caller]` 로 **부른 코드 줄**과 값을 남긴다.
//! "문단 N 이 왜 다음 쪽으로 갔나 / 흐름이 어디서 얼마나 늘었나" 를 엔진 소스 줄 단위로 짚는다.

use std::cell::RefCell;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TraceEvent {
    /// 구역 번호
    pub sec: usize,
    /// 쪽(구역 안 0부터)
    pub page: usize,
    /// 지금 다루는 문단(알 때만)
    pub pi: Option<usize>,
    /// advance | align | reclaim | item | newPage | newColumn
    pub op: &'static str,
    /// 흐름 높이(px) — 바뀌기 전·뒤
    pub before: f64,
    pub after: f64,
    /// 항목 설명(op=item) 등
    pub detail: String,
    /// 부른 엔진 소스 자리 `파일:줄`
    pub at: String,
}

thread_local! {
    static LOG: RefCell<Option<Vec<TraceEvent>>> = const { RefCell::new(None) };
    static CTX: RefCell<(usize, Option<usize>)> = const { RefCell::new((0, None)) };
}

/// 상한 — 아주 큰 문서에서 기록이 메모리를 잡아먹지 않게.
const MAX_EVENTS: usize = 200_000;

pub fn start() {
    LOG.with(|l| *l.borrow_mut() = Some(Vec::new()));
}

pub fn finish() -> Vec<TraceEvent> {
    LOG.with(|l| l.borrow_mut().take().unwrap_or_default())
}

#[inline]
pub fn enabled() -> bool {
    LOG.with(|l| l.borrow().is_some())
}

/// 지금 조판 중인 구역·문단 — typeset 의 문단 순회가 알려 준다.
pub fn set_context(sec: usize, pi: Option<usize>) {
    if enabled() {
        CTX.with(|c| *c.borrow_mut() = (sec, pi));
    }
}

pub fn record(
    page: usize,
    op: &'static str,
    before: f64,
    after: f64,
    detail: String,
    at: &std::panic::Location<'_>,
) {
    LOG.with(|l| {
        let mut l = l.borrow_mut();
        let Some(log) = l.as_mut() else { return };
        if log.len() >= MAX_EVENTS {
            return;
        }
        let (sec, pi) = CTX.with(|c| *c.borrow());
        let file = at.file().replace('\\', "/");
        let file = file.split("/src/").last().unwrap_or(&file).to_string();
        log.push(TraceEvent {
            sec,
            page,
            pi,
            op,
            before,
            after,
            detail,
            at: format!("{}:{}", file, at.line()),
        });
    });
}
