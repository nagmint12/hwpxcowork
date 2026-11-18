//! [hwpx-cowork] 문단 **내용 지문**으로 찾는 조판 중간 결과 기억(2026-11-19).
//!
//! 쪽 나눔 한 번은 구역의 모든 문단을 다시 줄 나눔했다 — 조판의 문단 구성(`typeset::paragraph::format`)과
//! 렌더 정규화의 저장 줄 투영(`render_normalization::stored_word_tail`)이 문단마다 글자 폭을 재며 줄을 새로 짰다.
//! 한 글자를 고쳐도 59쪽 보고서는 쪽 나눔마다 0.14초, 저장 줄 없는 8쪽 글 문서는 0.07초가 들었다(구역 크기에 비례).
//! 내용·폭·조판 문맥이 같은 문단은 같은 결과를 내므로 그 결과를 문서 수명 동안 기억한다.
//!
//! 칸 문단 줄 구성 기억(`composer::cell_compose_memo`)과 달리 **구조 편집 뒤에도 남긴다** — 그림을 넣어 뒤 쪽이
//! 밀리는 편집에서 바뀌지 않은 문단을 다시 계산하지 않는 것이 목적이다. 그래서 열쇠는 결과가 읽는 입력을 모두 담고
//! (문단의 모든 필드 지문 + 폭 + 조판 문맥 표지), 문단 밖 상태를 읽는 문단(개체·누름틀·동적 필드 값)은 기억하지 않는다.
//! 스타일을 다시 풀거나 글꼴 측정 환경이 바뀌면 통째로 비운다(문서가 `invalidate`·`begin_pass` 로 알린다).
//!
//! 검증 모드(`set_verify`)에서는 찾은 결과마다 새로 계산해 견주고, 다르면 세어 두고 새 결과를 돌려준다 —
//! 열쇠가 빠뜨린 입력이 없는지 실제 문서·편집 차례로 확인하는 데 쓴다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 기억 하나의 열쇠. `kind` 는 쓰임(어느 계산의 결과인가), `content` 는 문단 내용 지문,
/// `a`·`b`·`c`·`flags` 는 쓰임마다 정한 나머지 입력(폭·문맥 표지 등)이다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct MemoKey {
    pub(crate) kind: u8,
    pub(crate) content: (u64, u64),
    pub(crate) a: u64,
    pub(crate) b: u64,
    pub(crate) c: u64,
    pub(crate) flags: u32,
}

struct Entry<V> {
    value: V,
    bytes: usize,
    /// 마지막으로 쓰인 쪽 나눔 차례 — 오래 안 쓰인 것부터 버린다.
    last_pass: u64,
}

struct State<V> {
    /// 지난 쪽 나눔의 환경 표지(글꼴 측정 문맥·dpi 등). 달라지면 비운다.
    environment: Option<u64>,
    pass: u64,
    entries: HashMap<MemoKey, Entry<V>>,
    payload_bytes: usize,
    hits: u64,
    misses: u64,
    /// 열쇠를 만들 수 없어(기억하지 않는 문단) 그대로 계산한 횟수.
    uncached: u64,
    /// 결과가 보관 조건에 맞지 않아 넣지 않은 횟수.
    unstored: u64,
    environment_changes: u64,
    evictions: u64,
    verify_checks: u64,
    verify_mismatches: u64,
    first_mismatch: Option<String>,
}

impl<V> Default for State<V> {
    fn default() -> Self {
        Self {
            environment: None,
            pass: 0,
            entries: HashMap::new(),
            payload_bytes: 0,
            hits: 0,
            misses: 0,
            uncached: 0,
            unstored: 0,
            environment_changes: 0,
            evictions: 0,
            verify_checks: 0,
            verify_mismatches: 0,
            first_mismatch: None,
        }
    }
}

impl<V> State<V> {
    fn clear_entries(&mut self) {
        self.entries.clear();
        self.payload_bytes = 0;
    }

    /// `keep` 차례 안에 쓰인 것만 남긴다.
    fn evict_older_than(&mut self, keep: u64) {
        let pass = self.pass;
        let before = self.entries.len();
        let mut bytes = 0usize;
        self.entries.retain(|_, entry| {
            let fresh = entry.last_pass.saturating_add(keep) >= pass;
            if fresh {
                bytes += entry.bytes;
            }
            fresh
        });
        self.payload_bytes = bytes;
        self.evictions += (before - self.entries.len()) as u64;
    }
}

/// 진단용 셈(`wasm_api` 가 JSON 으로 내보낸다).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MemoStats {
    pub(crate) entries: usize,
    pub(crate) payload_bytes: usize,
    pub(crate) hits: u64,
    pub(crate) misses: u64,
    pub(crate) uncached: u64,
    pub(crate) unstored: u64,
    pub(crate) passes: u64,
    pub(crate) environment_changes: u64,
    pub(crate) evictions: u64,
    pub(crate) verify_checks: u64,
    pub(crate) verify_mismatches: u64,
    pub(crate) first_mismatch: Option<String>,
}

impl MemoStats {
    pub(crate) fn to_json(&self) -> String {
        format!(
            "{{\"entries\":{},\"bytes\":{},\"hits\":{},\"misses\":{},\"uncached\":{},\"unstored\":{},\"passes\":{},\"environmentChanges\":{},\"evictions\":{},\"verifyChecks\":{},\"verifyMismatches\":{},\"firstMismatch\":{}}}",
            self.entries,
            self.payload_bytes,
            self.hits,
            self.misses,
            self.uncached,
            self.unstored,
            self.passes,
            self.environment_changes,
            self.evictions,
            self.verify_checks,
            self.verify_mismatches,
            self.first_mismatch
                .as_ref()
                .map_or_else(|| "null".to_string(), |text| format!("{text:?}")),
        )
    }
}

/// 내용 지문 열쇠의 기억. 값은 `Clone` 사본으로 넣고 꺼낸다.
pub(crate) struct ContentMemo<V> {
    state: Mutex<State<V>>,
    verify: AtomicBool,
    disabled: AtomicBool,
    max_entries: usize,
    max_bytes: usize,
}

/// 한 문서가 기억하는 항목 수·데이터 크기의 상한(넘으면 오래 안 쓰인 것부터 버린다).
// 기억 하나의 상한이다(문서마다 기억이 넷 — 문단 구성·저장 줄 투영·프레임 재구성·보충 측정 요청).
// 59쪽 보고서는 기억 하나에 0.4MB 안팎을 쓴다. WASM 메모리는 한 번 늘면 줄지 않으므로(휴대전화 앱도 같은 엔진)
// 긴 편집에서 낡은 항목이 쌓여도 이 값의 3/4 에서 오래된 것부터 버린다.
const DEFAULT_MAX_ENTRIES: usize = 120_000;
const DEFAULT_MAX_BYTES: usize = 16 * 1024 * 1024;
/// 상한의 3/4 를 넘었을 때 남기는 차례 수 — 쪽 나눔 몇 번 동안 쓰이지 않은 문단(지금은 없는 옛 글)을 버린다.
const KEEP_PASSES: u64 = 4;

impl<V> Default for ContentMemo<V> {
    fn default() -> Self {
        Self::with_budget(DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES)
    }
}

impl<V> std::fmt::Debug for ContentMemo<V> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let stats = self.stats();
        write!(
            f,
            "ContentMemo {{ entries: {}, hits: {}, misses: {} }}",
            stats.entries, stats.hits, stats.misses
        )
    }
}

impl<V> ContentMemo<V> {
    pub(crate) fn with_budget(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            state: Mutex::new(State::default()),
            verify: AtomicBool::new(false),
            disabled: AtomicBool::new(false),
            max_entries,
            max_bytes,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State<V>> {
        // 기억은 파생값뿐이다 — 잠금이 오염됐어도(다른 스레드의 panic) 그대로 이어 쓴다.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 스타일·글꼴 측정 환경이 바뀜 — 모두 버린다.
    pub(crate) fn invalidate(&self) {
        self.lock().clear_entries();
    }

    /// 찾은 결과를 새로 계산해 견주는 검증 모드(느리다 — 시험·진단용).
    pub(crate) fn set_verify(&self, enabled: bool) {
        self.verify.store(enabled, Ordering::Relaxed);
    }

    pub(crate) fn verify_enabled(&self) -> bool {
        self.verify.load(Ordering::Relaxed)
    }

    /// 끄면 늘 새로 계산한다(견줌·되돌림용). 켤 때는 비운 상태에서 시작한다.
    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.disabled.store(!enabled, Ordering::Relaxed);
        self.invalidate();
    }

    pub(crate) fn enabled(&self) -> bool {
        !self.disabled.load(Ordering::Relaxed)
    }

    /// 환경 표지가 달라졌으면 비운다(쪽 나눔 밖에서 쓰기 전에 부른다).
    pub(crate) fn sync_environment(&self, environment: u64) {
        let mut state = self.lock();
        if state.environment != Some(environment) {
            if state.environment.is_some() {
                state.environment_changes += 1;
            }
            state.clear_entries();
            state.environment = Some(environment);
        }
    }

    /// 쪽 나눔 시작: 환경이 달라졌으면 비우고, 상한에 가까우면 오래 안 쓰인 것을 버린다.
    pub(crate) fn begin_pass(&self, environment: u64) {
        self.sync_environment(environment);
        let mut state = self.lock();
        state.pass += 1;
        if state.entries.len() > self.max_entries / 4 * 3
            || state.payload_bytes > self.max_bytes / 4 * 3
        {
            state.evict_older_than(KEEP_PASSES);
        }
    }

    pub(crate) fn stats(&self) -> MemoStats {
        let state = self.lock();
        MemoStats {
            entries: state.entries.len(),
            payload_bytes: state.payload_bytes,
            hits: state.hits,
            misses: state.misses,
            uncached: state.uncached,
            unstored: state.unstored,
            passes: state.pass,
            environment_changes: state.environment_changes,
            evictions: state.evictions,
            verify_checks: state.verify_checks,
            verify_mismatches: state.verify_mismatches,
            first_mismatch: state.first_mismatch.clone(),
        }
    }

    /// 열쇠를 만들 수 없는 문단을 그대로 계산했다.
    pub(crate) fn note_uncached(&self) {
        self.lock().uncached += 1;
    }

    /// 검증 모드의 견줌 결과를 적는다. 다르면 처음 한 건의 설명을 남긴다.
    pub(crate) fn record_verify(&self, same: bool, describe: impl FnOnce() -> String) {
        let mut state = self.lock();
        state.verify_checks += 1;
        if !same {
            state.verify_mismatches += 1;
            if state.first_mismatch.is_none() {
                state.first_mismatch = Some(describe());
            }
        }
    }
}

impl<V: Clone> ContentMemo<V> {
    /// 같은 열쇠의 사본. 찾으면 이번 차례에 쓰였다고 적는다.
    pub(crate) fn lookup(&self, key: &MemoKey) -> Option<V> {
        let mut state = self.lock();
        let pass = state.pass;
        match state.entries.get_mut(key) {
            Some(entry) => {
                entry.last_pass = pass;
                let value = entry.value.clone();
                state.hits += 1;
                Some(value)
            }
            None => {
                state.misses += 1;
                None
            }
        }
    }

    /// 보관 조건 밖의 결과였다(넣지 않았다).
    pub(crate) fn note_unstored(&self) {
        self.lock().unstored += 1;
    }

    /// 새로 계산한 결과를 넣는다. 한 항목이 예산의 1/4 을 넘으면 넣지 않는다.
    pub(crate) fn store(&self, key: MemoKey, value: V, bytes: usize) {
        let mut state = self.lock();
        if bytes > self.max_bytes / 4 {
            state.unstored += 1;
            return;
        }
        if state.entries.len() >= self.max_entries || state.payload_bytes + bytes > self.max_bytes {
            // 이번·지난 차례에 쓰인 것만 남겨 본다. 그래도 넘치면 통째로 비운다.
            state.evict_older_than(1);
            if state.entries.len() >= self.max_entries
                || state.payload_bytes + bytes > self.max_bytes
            {
                let dropped = state.entries.len() as u64;
                state.clear_entries();
                state.evictions += dropped;
            }
        }
        let pass = state.pass;
        if let std::collections::hash_map::Entry::Vacant(slot) = state.entries.entry(key) {
            slot.insert(Entry {
                value,
                bytes,
                last_pass: pass,
            });
            state.payload_bytes += bytes;
        }
    }

    /// 열쇠가 있으면 기억을 쓰고(없으면 계산해 넣고), 열쇠가 없으면 그대로 계산한다.
    /// `bytes` 는 보관할 결과의 크기(보관하지 않을 결과면 `None`), `same` 은 검증 모드의 견줌이다.
    pub(crate) fn get_or_compute<E>(
        &self,
        key: Option<MemoKey>,
        bytes: impl FnOnce(&V) -> Option<usize>,
        same: impl FnOnce(&V, &V) -> bool,
        describe: impl FnOnce() -> String,
        compute: impl FnOnce() -> Result<V, E>,
    ) -> Result<V, E> {
        if !self.enabled() {
            return compute();
        }
        let Some(key) = key else {
            self.note_uncached();
            return compute();
        };
        if let Some(found) = self.lookup(&key) {
            if self.verify_enabled() {
                let fresh = compute()?;
                self.record_verify(same(&found, &fresh), describe);
                return Ok(fresh);
            }
            return Ok(found);
        }
        // 계산하는 동안은 잠그지 않는다(중첩 호출·오래 걸리는 줄 나눔).
        let fresh = compute()?;
        match bytes(&fresh) {
            Some(size) => self.store(key, fresh.clone(), size),
            None => self.note_unstored(),
        }
        Ok(fresh)
    }
}

/// 열쇠에 섞는 작은 해시 도우미(한 값짜리 표지).
pub(crate) fn stamp<T: std::hash::Hash + ?Sized>(value: &T) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    //! 계약 시험(합성 입력): 같은 열쇠는 한 번만 계산, 환경·무효화에서 비움, 상한에서 오래된 것부터 버림,
    //! 검증 모드는 다른 결과를 세고 새 결과를 돌려준다. 조판 좌표는 다루지 않는다.
    use super::*;

    fn key(n: u64) -> MemoKey {
        MemoKey {
            kind: 1,
            content: (n, n ^ 7),
            a: 0,
            b: 0,
            c: 0,
            flags: 0,
        }
    }

    fn get(
        memo: &ContentMemo<u32>,
        k: Option<MemoKey>,
        value: u32,
        calls: &std::cell::Cell<u32>,
    ) -> u32 {
        memo.get_or_compute::<std::convert::Infallible>(
            k,
            |_| Some(8),
            |a, b| a == b,
            || "mismatch".to_string(),
            || {
                calls.set(calls.get() + 1);
                Ok(value)
            },
        )
        .unwrap_or_else(|never| match never {})
    }

    #[test]
    fn same_key_is_computed_once_and_missing_key_always_computes() {
        let memo = ContentMemo::<u32>::default();
        let calls = std::cell::Cell::new(0);
        memo.begin_pass(1);
        assert_eq!(get(&memo, Some(key(1)), 10, &calls), 10);
        assert_eq!(
            get(&memo, Some(key(1)), 11, &calls),
            10,
            "기억한 값을 돌려준다"
        );
        assert_eq!(get(&memo, Some(key(2)), 20, &calls), 20);
        assert_eq!(get(&memo, None, 30, &calls), 30);
        assert_eq!(get(&memo, None, 31, &calls), 31);
        assert_eq!(calls.get(), 4);
        let stats = memo.stats();
        assert_eq!(
            (stats.entries, stats.hits, stats.misses, stats.uncached),
            (2, 1, 2, 2)
        );
    }

    #[test]
    fn kept_across_passes_but_cleared_on_environment_change_and_invalidate() {
        let memo = ContentMemo::<u32>::default();
        let calls = std::cell::Cell::new(0);
        memo.begin_pass(1);
        get(&memo, Some(key(1)), 10, &calls);
        // 구조 편집 뒤의 쪽 나눔에도 남는다(환경이 같으면)
        memo.begin_pass(1);
        memo.begin_pass(1);
        assert_eq!(get(&memo, Some(key(1)), 11, &calls), 10);
        // 환경이 달라지면 비운다
        memo.begin_pass(2);
        assert_eq!(memo.stats().entries, 0);
        assert_eq!(get(&memo, Some(key(1)), 12, &calls), 12);
        // 쪽 나눔 밖에서 환경만 맞출 때도 같다
        memo.sync_environment(2);
        assert_eq!(memo.stats().entries, 1);
        memo.sync_environment(3);
        assert_eq!(memo.stats().entries, 0);
        get(&memo, Some(key(1)), 13, &calls);
        // 스타일을 다시 풀면 그 자리에서 비운다
        memo.invalidate();
        assert_eq!(memo.stats().entries, 0);
        assert_eq!(memo.stats().environment_changes, 2);
    }

    #[test]
    fn budget_evicts_entries_unused_in_recent_passes_first() {
        let memo = ContentMemo::<u32>::with_budget(8, 1 << 20);
        let calls = std::cell::Cell::new(0);
        memo.begin_pass(1);
        for n in 0..6 {
            get(&memo, Some(key(n)), n as u32, &calls);
        }
        // 다음 차례들에서는 0·1 만 쓴다
        for _ in 0..(KEEP_PASSES + 1) {
            memo.begin_pass(1);
            get(&memo, Some(key(0)), 0, &calls);
            get(&memo, Some(key(1)), 1, &calls);
        }
        // 상한의 3/4(6개)에 닿지 않았으므로 아직 남아 있다
        assert_eq!(memo.stats().entries, 6);
        get(&memo, Some(key(100)), 100, &calls);
        memo.begin_pass(1);
        // 7개 > 6 → 최근 KEEP_PASSES 차례에 쓰인 것만 남는다
        let stats = memo.stats();
        assert_eq!(stats.entries, 3, "0·1·100 만 남는다");
        assert!(stats.evictions >= 4);
        let before = calls.get();
        get(&memo, Some(key(0)), 0, &calls);
        assert_eq!(calls.get(), before, "자주 쓰인 것은 남는다");
        // 넘치는 한 번의 넣기는 이번·지난 차례 것만 남기고, 그래도 넘치면 통째로 비운다
        for n in 200..230 {
            get(&memo, Some(key(n)), n as u32, &calls);
        }
        assert!(memo.stats().entries <= 8);
    }

    #[test]
    fn oversized_or_unstorable_results_are_returned_but_not_kept() {
        let memo = ContentMemo::<u32>::with_budget(8, 400);
        memo.begin_pass(1);
        let big = memo
            .get_or_compute::<std::convert::Infallible>(
                Some(key(1)),
                |_| Some(300),
                |a, b| a == b,
                String::new,
                || Ok(1),
            )
            .unwrap();
        let none = memo
            .get_or_compute::<std::convert::Infallible>(
                Some(key(2)),
                |_| None,
                |a, b| a == b,
                String::new,
                || Ok(2),
            )
            .unwrap();
        assert_eq!((big, none), (1, 2));
        let stats = memo.stats();
        assert_eq!((stats.entries, stats.unstored), (0, 2));
    }

    #[test]
    fn verify_mode_counts_mismatches_and_returns_the_fresh_result() {
        let memo = ContentMemo::<u32>::default();
        let calls = std::cell::Cell::new(0);
        memo.begin_pass(1);
        get(&memo, Some(key(1)), 10, &calls);
        memo.set_verify(true);
        assert_eq!(get(&memo, Some(key(1)), 10, &calls), 10);
        assert_eq!(get(&memo, Some(key(1)), 99, &calls), 99, "다르면 새 결과");
        let stats = memo.stats();
        assert_eq!((stats.verify_checks, stats.verify_mismatches), (2, 1));
        assert_eq!(stats.first_mismatch.as_deref(), Some("mismatch"));
        assert!(stats.to_json().contains("\"verifyMismatches\":1"));
        // 끄면 늘 새로 계산하고 기억도 비운다
        memo.set_verify(false);
        memo.set_enabled(false);
        assert_eq!(get(&memo, Some(key(1)), 5, &calls), 5);
        assert_eq!(memo.stats().entries, 0);
        memo.set_enabled(true);
        assert_eq!(get(&memo, Some(key(1)), 6, &calls), 6);
        assert_eq!(get(&memo, Some(key(1)), 7, &calls), 6);
    }
}
