//! 저장 줄이 없는 TAC 표의 흐름과 배치가 공유하는 실제 측정 결과.

use crate::model::table::Table;
use crate::model::{control::Control, paragraph::Paragraph};
use crate::renderer::composer::cell_compose_memo::CellComposeMemo;
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredTable};
use crate::renderer::style_resolver::ResolvedStyleSet;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

// [hwpx-cowork] 2026-11-20 글자처럼 취급 표의 줄 점유·본체 높이는 문단 구성 깊숙한 곳(줄 나눔의 개체 크기,
// 흐름 문단 구성의 표 높이 목록)에서 `HeightMeasurer::new` 로 새로 만든 측정기가 잰다. 그 측정기에는 문서의
// 칸 문단 줄 구성 기억이 없어, 저장 줄이 없는 TAC 표가 많은 문서는 쪽 나눔마다 모든 칸 문단을 다시 줄
// 나눔했다(86쪽 문서·TAC 표 163개·칸 문단 13,883개: 문단 나누기 한 번 1.5초 — 그중 93% 가 칸 줄 구성.
// 한 쪽 나눔에서 표마다 네 번 — 문단 구성 두 번 × 높이 목록·줄 나눔 각각).
// 1) 쪽 나눔·쪽 나무가 이 기억을 가진 동안만 그 측정기에 같은 기억을 건다. 기억의 열쇠는 칸 문단의 모든 필드·
//    폭·dpi·저장 줄 정책이고 줄 구성 계산이 읽는 측정기 값은 열쇠에 든 정책·HWP5 여부뿐이라
//    (`cell_compose_memo`), 다른 측정기와 같은 기억을 나눠도 결과는 새로 계산한 것과 같다.
// 2) 구역 조판 한 번(쪽 나눔 한 번) 안에서 그 구역 문단의 표는 한 번만 잰다 — 같은 문단을 구역 진행과 배치가
//    두 번 구성하고, 구성마다 표 높이 목록과 줄 나눔이 같은 표를 같은 측정기로 잰다. 범위를 연 문단들과 스타일은
//    범위 동안 빌려진 채라 바뀌거나 해제되지 않으므로, 그 표의 주소는 범위 안에서 다른 표의 주소가 될 수 없다.
//    줄 나눔은 합성 줄을 비운 사본 문단으로 하므로(표도 깊은 사본) 사본을 만드는 자리가 사본 표 → 원본 표
//    대응을 그 사본이 사는 동안만 등록한다. 그 밖의 사본 표·다른 스타일로 재는 경우는 다시 쓰지 않는다.
// 범위 밖(편집 명령·한정된 저장소)은 종전처럼 늘 새로 계산한다.
#[derive(Default)]
struct ReflowTableScopeState {
    memo: Option<Arc<CellComposeMemo>>,
    /// 범위를 연 문단들의 표 주소와 그 조판의 스타일 주소(없으면 측정 결과를 다시 쓰지 않는다).
    host_tables: HashSet<*const Table>,
    host_styles: Option<*const ResolvedStyleSet>,
    /// 사본 표 → 원본 표: 범위를 연 문단을 줄만 바꿔 복제한 사본의 표(`alias_reflow_tables` — 그 guard 가 사는 동안).
    aliases: HashMap<*const Table, *const Table>,
    /// 범위 안에서 잰 원본 표들의 결과(열쇠에 dpi).
    measured: HashMap<(*const Table, u64), MeasuredTable>,
}

thread_local! {
    static REFLOW_TABLE_SCOPE: RefCell<ReflowTableScopeState> = RefCell::new(ReflowTableScopeState::default());
}

/// [`reflow_table_memo_scope`] 가 돌려주는 범위. 사라질 때 들어오기 전 상태로 되돌린다(중첩·다른 문서 안전).
/// 이미 같은 기억·스타일로 이 문단들의 표를 맡은 범위 안이면 아무것도 바꾸지 않는다(`previous` 없음).
pub(crate) struct ReflowTableMemoScope {
    previous: Option<ReflowTableScopeState>,
}

impl Drop for ReflowTableMemoScope {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            REFLOW_TABLE_SCOPE.with(|slot| *slot.borrow_mut() = previous);
        }
    }
}

/// [hwpx-cowork] 범위 동안 TAC 표 측정(`measure_tac_table_with_storage`)이 `memo` 를 쓰게 한다(`None` 이면 쓰지 않게).
/// `hosts` 를 주면 그 문단들의 표는 범위 안에서 같은 스타일·dpi 로 한 번만 잰다 — 범위는 `hosts` 와 스타일을
/// 빌린 동안만 둔다(구역 조판 한 번·문단 구성 한 번).
pub(crate) fn reflow_table_memo_scope(
    memo: Option<Arc<CellComposeMemo>>,
    hosts: Option<(&[Paragraph], &ResolvedStyleSet)>,
) -> ReflowTableMemoScope {
    let next = match hosts {
        Some((paragraphs, styles)) => {
            let host_styles = styles as *const ResolvedStyleSet;
            // 바깥 범위(구역 조판)가 같은 기억·스타일로 이 문단들의 표를 이미 맡았으면 그 결과를 이어 쓴다
            // — 한 번의 쪽 나눔이 같은 문단을 여러 번 구성한다(구역 진행·배치).
            let inherited = REFLOW_TABLE_SCOPE.with(|slot| {
                let state = slot.borrow();
                state.host_styles == Some(host_styles)
                    && same_memo(&state.memo, &memo)
                    && paragraphs
                        .iter()
                        .flat_map(paragraph_tables)
                        .all(|table| state.host_tables.contains(&table))
            });
            if inherited {
                return ReflowTableMemoScope { previous: None };
            }
            ReflowTableScopeState {
                memo,
                host_tables: paragraphs.iter().flat_map(paragraph_tables).collect(),
                host_styles: Some(host_styles),
                ..ReflowTableScopeState::default()
            }
        }
        None => ReflowTableScopeState { memo, ..ReflowTableScopeState::default() },
    };
    let previous = REFLOW_TABLE_SCOPE.with(|slot| slot.replace(next));
    ReflowTableMemoScope { previous: Some(previous) }
}

fn same_memo(a: &Option<Arc<CellComposeMemo>>, b: &Option<Arc<CellComposeMemo>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

fn paragraph_tables(paragraph: &Paragraph) -> impl Iterator<Item = *const Table> + '_ {
    paragraph.controls.iter().filter_map(|control| match control {
        Control::Table(table) => Some(&**table as *const Table),
        _ => None,
    })
}

/// [`alias_reflow_tables`] 가 돌려주는 등록. 사라질 때 사본 표의 대응을 지운다 — 사본 문단보다 먼저 사라지게
/// 사본 다음에 선언한다(사본이 해제된 뒤 그 주소에 다른 표가 생겨도 원본의 결과를 받지 않게).
pub(crate) struct ReflowTableAliasGuard {
    copies: Vec<*const Table>,
}

impl Drop for ReflowTableAliasGuard {
    fn drop(&mut self) {
        if self.copies.is_empty() {
            return;
        }
        REFLOW_TABLE_SCOPE.with(|slot| {
            let mut state = slot.borrow_mut();
            for copy in &self.copies {
                state.aliases.remove(copy);
            }
        });
    }
}

/// [hwpx-cowork] `copy` 가 범위를 연 문단(`original`)을 줄만 바꿔 복제한 문단일 때(개체는 그대로 복제), 사본의 표도
/// 원본 표의 측정 결과를 쓰게 한다. 줄 나눔이 사본으로 표 크기를 다시 재는 자리(`recompose_stored_lines_in_frame…`).
pub(crate) fn alias_reflow_tables(original: &Paragraph, copy: &Paragraph) -> ReflowTableAliasGuard {
    let mut copies = Vec::new();
    REFLOW_TABLE_SCOPE.with(|slot| {
        let mut state = slot.borrow_mut();
        if state.host_tables.is_empty() || original.controls.len() != copy.controls.len() {
            return;
        }
        for (source, copied) in paragraph_tables(original).zip(paragraph_tables(copy)) {
            if source != copied
                && state.host_tables.contains(&source)
                && !state.aliases.contains_key(&copied)
            {
                state.aliases.insert(copied, source);
                copies.push(copied);
            }
        }
    });
    ReflowTableAliasGuard { copies }
}

/// [hwpx-cowork] TAC 표의 줄 점유·본체 높이 측정(편집 세션 측정 + 범위가 건 칸 줄 구성 기억).
pub(crate) fn measure_tac_table_with_storage<S: crate::storage::Storage>(
    table: &Table,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<MeasuredTable, S::Error> {
    let styles_key = styles as *const ResolvedStyleSet;
    let dpi_key = dpi.to_bits();
    // 범위를 연 문단의 표(또는 그 사본의 표)면 원본 표 주소와 dpi. 한정된 Storage 는 할당을 세므로 사본을
    // 돌려주지 않는다(기억도 범위가 걸지 않는다).
    let reusable_key = |state: &ReflowTableScopeState| -> Option<(*const Table, u64)> {
        let pointer = table as *const Table;
        let original = state.aliases.get(&pointer).copied().unwrap_or(pointer);
        (S::UNBOUNDED
            && state.host_styles == Some(styles_key)
            && state.host_tables.contains(&original))
        .then_some((original, dpi_key))
    };
    let (memo, found) = REFLOW_TABLE_SCOPE.with(|slot| {
        let state = slot.borrow();
        let found = reusable_key(&state).and_then(|key| state.measured.get(&key).cloned());
        (state.memo.clone(), found)
    });
    // 재는 동안은 범위를 빌리지 않는다(칸 안 TAC 표가 같은 함수로 다시 들어온다).
    let measure = |memo: Option<Arc<CellComposeMemo>>| {
        HeightMeasurer::new(dpi)
            .with_session_edited(true)
            .with_cell_compose_memo(memo)
            .measure_table_with_storage(table, 0, 0, styles, storage)
    };
    if let Some(found) = found {
        // 검증 모드(`setLayoutMemoVerify`)에서는 다시 쓴 결과도 새로 재서 견주고 새로 잰 값을 쓴다.
        if let Some(verify) = memo.as_ref().filter(|memo| memo.verify_enabled()) {
            let fresh = measure(Some(Arc::clone(verify)))?;
            verify.record_verify(format!("{fresh:?}") == format!("{found:?}"));
            return Ok(fresh);
        }
        return Ok(found);
    }
    let measured = measure(memo)?;
    REFLOW_TABLE_SCOPE.with(|slot| {
        let mut state = slot.borrow_mut();
        if let Some(key) = reusable_key(&state) {
            state.measured.entry(key).or_insert_with(|| measured.clone());
        }
    });
    Ok(measured)
}

pub(crate) fn inline_table_needs_reflow_measurement(table: &Table) -> bool {
    match inline_table_needs_reflow_measurement_with_storage(table, &crate::storage::Unbounded) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
pub(crate) fn inline_table_needs_reflow_measurement_with_storage<S: crate::storage::Storage>(
    table: &Table,
    storage: &S,
) -> Result<bool, S::Error> {
    // [hwpx-cowork] 한/글 2022는 안쪽 표를 담은 줄이 없으면 그 표의 행을 다시 잰다.
    // 이웃 셀이나 뒤 문단의 저장 줄 하나만으로는 호스트 줄의 높이를 알 수 없다.
    if !table.common.treat_as_char {
        return Ok(false);
    }
    if super::table_cells_have_no_stored_lines(table) {
        return Ok(true);
    }
    let has_unmeasured_nested_table = table.common.hwpx_size_rule
        && table
            .cells
            .iter()
            .flat_map(|cell| &cell.paragraphs)
            .any(|paragraph| {
                crate::renderer::para_has_no_stored_line_segs(paragraph)
                    && paragraph.controls.iter().any(|control| {
                        matches!(control, Control::Table(child) if child.common.treat_as_char)
                    })
            });
    Ok(has_unmeasured_nested_table
        || inline_table_width_cache_is_stale_with_storage(table, storage)?)
}
pub(crate) fn inline_table_width_cache_is_stale(table: &Table) -> bool {
    match inline_table_width_cache_is_stale_with_storage(table, &crate::storage::Unbounded) {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
pub(crate) fn inline_table_width_cache_is_stale_with_storage<S: crate::storage::Storage>(
    table: &Table,
    storage: &S,
) -> Result<bool, S::Error> {
    // [hwpx-cowork] 셀에서 다시 구한 폭은 인라인 호스트의 줄 캐시만 무효화한다.
    Ok(table.common.treat_as_char
        && table
            .closed_cell_grid_width_hu_with_storage(storage)?
            .is_some_and(|width| width != table.common.width))
}

/// 재조판 셀의 내용·행 하한·캡션을 개체 선언 높이로 다시 덮어쓰지 않는다.
/// 저장 줄이 있는 표는 기존 저장 프레임 경로에서 측정 결과를 공급한다.
pub(crate) fn measured_reflow_inline_table(
    table: &Table,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Option<MeasuredTable> {
    match measured_reflow_inline_table_with_storage(table, styles, dpi, &crate::storage::Unbounded)
    {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
pub(crate) fn measured_reflow_inline_table_with_storage<S: crate::storage::Storage>(
    table: &Table,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<Option<MeasuredTable>, S::Error> {
    if !inline_table_needs_reflow_measurement_with_storage(table, storage)? {
        return Ok(None);
    }
    measure_tac_table_with_storage(table, styles, dpi, storage).map(Some)
}

/// [hwpx-cowork] 2026-11-09 측정기는 투명 래퍼(1×1 표 안에 표 하나)를 분할용으로 자식 표까지 펼쳐 잰다
/// (`MeasuredTable::unwrapped_table_depth`). 그 `total_height` 는 자식 표의 높이다. 줄 점유·셀 안 중첩
/// 높이는 외곽 표의 물리 상자이므로 래퍼 안 여백과 자식 바깥 여백을 다시 감싼다(배치도 자식을 안 여백
/// 아래에 그린다). fork 0.8.7 은 선언 높이와 실측 중 큰 값을 써서 이 몫이 남았다 — 한/글 2022 실측
/// regression-20261103 B wrapper TAC(래퍼 18000×30000, 안 여백 283×2, 자식 29434): 다음 줄 vpos
/// 31710 = 825 + 30000 + 880. 펼치지 않은 표는 그대로다.
pub(crate) fn measured_inline_table_whole_height(
    table: &Table,
    measured: &MeasuredTable,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> f64 {
    if measured.unwrapped_table_depth == 0 {
        return measured.total_height;
    }
    crate::renderer::height_measurer::unwrapped_table_whole_height(
        table,
        measured.total_height,
        dpi,
        styles,
    )
}

/// [hwpx-cowork] 2026-11-09 표 본체(캡션 제외) 높이. 펼친 투명 래퍼는 자식 캡션이 외곽 칸 안에 있으므로
/// 외곽 프레임 전체가 본체다(줄 점유 `measured_inline_table_whole_height` 와 같은 값).
fn inline_table_body_height(
    table: &Table,
    measured: &MeasuredTable,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> f64 {
    if measured.unwrapped_table_depth == 0 {
        measured.total_height - measured.caption_height
    } else {
        measured_inline_table_whole_height(table, measured, styles, dpi)
    }
}

/// 저장 줄 없는 본문도 셀과 같은 표 실측을 현재 줄의 소유 정보로 발행한다.
/// 캡션을 제외한 본체 높이는 앵커용이며, 줄의 전체 점유는 기존 조판기가 측정한다.
pub(crate) fn reflow_inline_table_heights(
    paragraph: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
) -> Vec<(usize, u32)> {
    if !crate::renderer::para_has_no_stored_line_segs(paragraph) {
        return Vec::new();
    }
    paragraph
        .controls
        .iter()
        .enumerate()
        .filter_map(|(index, control)| {
            let Control::Table(table) = control else {
                return None;
            };
            let measured = measured_reflow_inline_table(table, styles, dpi)?;
            let body = inline_table_body_height(table, &measured, styles, dpi);
            let height = u32::try_from(crate::renderer::px_to_hwpunit(body, dpi)).ok()?;
            (height > 0).then_some((index, height))
        })
        .collect()
}

pub(crate) fn reflow_inline_table_heights_with_storage<S: crate::storage::Storage>(
    paragraph: &Paragraph,
    styles: &ResolvedStyleSet,
    dpi: f64,
    storage: &S,
) -> Result<Vec<(usize, u32)>, S::Error> {
    let mut heights = storage.vec(0)?;
    if !crate::renderer::para_has_no_stored_line_segs(paragraph) {
        return Ok(heights);
    }
    for (index, control) in paragraph.controls.iter().enumerate() {
        let Control::Table(table) = control else {
            continue;
        };
        if !inline_table_needs_reflow_measurement_with_storage(table, storage)? {
            continue;
        }
        let measured = measure_tac_table_with_storage(table, styles, dpi, storage)?;
        if let Ok(height) = u32::try_from(crate::renderer::px_to_hwpunit(
            inline_table_body_height(table, &measured, styles, dpi),
            dpi,
        )) {
            if height > 0 {
                storage.push(&mut heights, (index, height))?;
            }
        }
    }
    Ok(heights)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_memo() -> Option<Arc<CellComposeMemo>> {
        REFLOW_TABLE_SCOPE.with(|slot| slot.borrow().memo.clone())
    }

    #[test]
    fn memo_scope_nests_and_restores_the_previous_memo() {
        let outer = Arc::new(CellComposeMemo::default());
        let inner = Arc::new(CellComposeMemo::default());
        assert!(active_memo().is_none(), "범위 밖에서는 기억이 없다");
        {
            let _outer = reflow_table_memo_scope(Some(Arc::clone(&outer)), None);
            assert!(Arc::ptr_eq(&active_memo().unwrap(), &outer));
            {
                let _inner = reflow_table_memo_scope(Some(Arc::clone(&inner)), None);
                assert!(Arc::ptr_eq(&active_memo().unwrap(), &inner));
            }
            {
                let _none = reflow_table_memo_scope(None, None);
                assert!(active_memo().is_none(), "None 범위는 바깥 기억도 쓰지 않는다");
            }
            assert!(
                Arc::ptr_eq(&active_memo().unwrap(), &outer),
                "안쪽 범위가 끝나면 바깥 기억으로 돌아간다"
            );
        }
        assert!(active_memo().is_none(), "범위가 끝나면 기억을 남기지 않는다");
    }

    fn tac_table_core() -> (crate::document_core::DocumentCore, usize, usize) {
        let mut core = crate::document_core::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let inserted = core.create_table_native(0, 0, 0, 3, 2).unwrap();
        let inserted: serde_json::Value = serde_json::from_str(&inserted).unwrap();
        let paragraph = inserted["paraIdx"].as_u64().unwrap() as usize;
        let control = inserted["controlIdx"].as_u64().unwrap() as usize;
        for (cell, text) in [
            "항목",
            "가나다라마바사아자차카타파하 ABC 123 긴 칸 글",
            "합계",
            "1,234",
        ]
        .into_iter()
        .enumerate()
        {
            core.insert_text_in_cell_native(0, paragraph, control, cell, 0, 0, text)
                .unwrap();
        }
        // 저장 줄 없는 글자처럼 취급 표 — 한/글이 아닌 도구가 만든 HWPX 와 같은 꼴.
        let host = &mut core.document.sections[0].paragraphs[paragraph];
        host.line_segs.clear();
        let Control::Table(table) = &mut host.controls[control] else {
            panic!("표가 아니다");
        };
        table.common.treat_as_char = true;
        for cell in &mut table.cells {
            for para in &mut cell.paragraphs {
                para.line_segs.clear();
            }
        }
        (core, paragraph, control)
    }

    /// 저장 줄 없는 TAC 표: 범위 안의 측정은 칸 줄 구성을 기억에서 다시 쓰고, 결과는 기억 없는 측정과 같다.
    #[test]
    fn scoped_measurement_reuses_cell_lines_and_matches_unscoped_measurement() {
        let (core, paragraph, control) = tac_table_core();
        let Control::Table(table) =
            &core.document.sections[0].paragraphs[paragraph].controls[control]
        else {
            unreachable!()
        };
        assert!(inline_table_needs_reflow_measurement(table));
        let (styles, dpi) = (&core.styles, core.dpi);

        let unscoped = measured_reflow_inline_table(table, styles, dpi).unwrap();
        let memo = Arc::new(CellComposeMemo::default());
        let _scope = reflow_table_memo_scope(Some(Arc::clone(&memo)), None);
        let first = measured_reflow_inline_table(table, styles, dpi).unwrap();
        let (_, hits_after_first, misses) = memo.stats();
        assert!(misses > 0, "처음 재는 칸 문단은 새로 계산해 기억한다");
        let second = measured_reflow_inline_table(table, styles, dpi).unwrap();
        let (_, hits_after_second, misses_after_second) = memo.stats();
        assert_eq!(
            misses_after_second, misses,
            "같은 표를 다시 재면 새로 계산하지 않는다"
        );
        assert!(hits_after_second > hits_after_first);
        assert_eq!(format!("{unscoped:?}"), format!("{first:?}"));
        assert_eq!(format!("{unscoped:?}"), format!("{second:?}"));
    }

    /// 범위를 연 문단의 표는 범위 안에서 한 번만 재고(기억 조회도 다시 하지 않는다), 다른 스타일 값·같은 내용의
    /// 사본 표·범위 밖은 다시 쓰지 않는다. 다시 쓴 결과는 새로 잰 결과와 같다.
    #[test]
    fn host_tables_are_measured_once_per_scope_only_for_the_same_styles() {
        let (core, paragraph, control) = tac_table_core();
        let host = &core.document.sections[0].paragraphs[paragraph];
        let Control::Table(table) = &host.controls[control] else {
            unreachable!()
        };
        let (styles, dpi) = (&core.styles, core.dpi);
        let unscoped = measured_reflow_inline_table(table, styles, dpi).unwrap();
        let memo = Arc::new(CellComposeMemo::default());
        let lookups = |memo: &CellComposeMemo| {
            let (_, hits, misses) = memo.stats();
            hits + misses
        };
        {
            let _scope = reflow_table_memo_scope(Some(Arc::clone(&memo)), Some((std::slice::from_ref(host), styles)));
            let first = measured_reflow_inline_table(table, styles, dpi).unwrap();
            let after_first = lookups(&memo);
            assert!(after_first > 0);
            let heights = reflow_inline_table_heights(host, styles, dpi);
            let again = measured_reflow_inline_table(table, styles, dpi).unwrap();
            assert_eq!(
                lookups(&memo),
                after_first,
                "범위를 연 문단의 표는 다시 재지 않는다"
            );
            assert_eq!(heights.len(), 1);
            assert_eq!(format!("{unscoped:?}"), format!("{first:?}"));
            assert_eq!(format!("{unscoped:?}"), format!("{again:?}"));

            // 검증 모드에서는 다시 쓴 결과도 새로 재서 견준다(칸 줄 구성 기억의 검증 수에 더한다).
            memo.set_verify(true);
            let (checks_before, _) = memo.verify_stats();
            let verified = measured_reflow_inline_table(table, styles, dpi).unwrap();
            let (checks_after, mismatches) = memo.verify_stats();
            assert!(checks_after > checks_before, "검증 모드는 다시 쓴 결과를 견준다");
            assert_eq!(mismatches, 0);
            assert_eq!(format!("{unscoped:?}"), format!("{verified:?}"));
            memo.set_verify(false);

            // 같은 내용의 사본 표(다른 주소)와 다른 스타일 값은 범위를 연 문단의 것이 아니다 — 다시 잰다.
            let copy = table.clone();
            measured_reflow_inline_table(&copy, styles, dpi).unwrap();
            let after_copy = lookups(&memo);
            assert!(after_copy > after_first, "사본 표는 다시 잰다");
            let other_styles = styles.clone();
            measured_reflow_inline_table(table, &other_styles, dpi).unwrap();
            assert!(lookups(&memo) > after_copy, "다른 스타일로는 다시 잰다");
        }
        // 줄만 비운 사본 문단: 대응을 등록한 동안만 사본의 표가 원본의 결과를 쓴다.
        {
            let _scope = reflow_table_memo_scope(Some(Arc::clone(&memo)), Some((std::slice::from_ref(host), styles)));
            measured_reflow_inline_table(table, styles, dpi).unwrap();
            let mut copy = host.clone();
            copy.replace_line_segs(Vec::new());
            let Control::Table(copied_table) = &copy.controls[control] else {
                unreachable!()
            };
            let before_alias = lookups(&memo);
            {
                let _alias = alias_reflow_tables(host, &copy);
                let via_alias = measured_reflow_inline_table(copied_table, styles, dpi).unwrap();
                assert_eq!(lookups(&memo), before_alias, "등록한 사본의 표는 다시 재지 않는다");
                assert_eq!(format!("{unscoped:?}"), format!("{via_alias:?}"));
            }
            measured_reflow_inline_table(copied_table, styles, dpi).unwrap();
            assert!(lookups(&memo) > before_alias, "등록이 끝나면 사본의 표는 다시 잰다");
        }
        // 범위를 연 문단이 아닌 문단의 사본은 등록하지 않는다.
        {
            let _scope = reflow_table_memo_scope(Some(Arc::clone(&memo)), None);
            let copy = host.clone();
            let guard = alias_reflow_tables(host, &copy);
            assert!(guard.copies.is_empty());
        }
        // 범위가 끝나면 다시 쓰지 않는다(기억도 없다).
        let before = lookups(&memo);
        let outside = measured_reflow_inline_table(table, styles, dpi).unwrap();
        assert_eq!(lookups(&memo), before, "범위 밖 측정은 기억을 거치지 않는다");
        assert_eq!(format!("{unscoped:?}"), format!("{outside:?}"));
    }

    /// 구역 범위 안의 문단 구성 범위는 구역 범위의 결과를 이어 쓴다(쪽 나눔 한 번에 표마다 한 번 잰다).
    /// 다른 기억의 범위는 이어 쓰지 않고, 끝나면 구역 범위로 돌아간다.
    #[test]
    fn paragraph_scope_inherits_the_section_scope() {
        let (core, paragraph, control) = tac_table_core();
        let paragraphs = core.document.sections[0].paragraphs.as_slice();
        let host = &paragraphs[paragraph];
        let Control::Table(table) = &host.controls[control] else {
            unreachable!()
        };
        let (styles, dpi) = (&core.styles, core.dpi);
        let lookups = |memo: &CellComposeMemo| {
            let (_, hits, misses) = memo.stats();
            hits + misses
        };
        let memo = Arc::new(CellComposeMemo::default());
        let _section = reflow_table_memo_scope(Some(Arc::clone(&memo)), Some((paragraphs, styles)));
        {
            let _paragraph = reflow_table_memo_scope(
                Some(Arc::clone(&memo)),
                Some((std::slice::from_ref(host), styles)),
            );
            measured_reflow_inline_table(table, styles, dpi).unwrap();
        }
        let after_first = lookups(&memo);
        assert!(after_first > 0);
        {
            let _paragraph = reflow_table_memo_scope(
                Some(Arc::clone(&memo)),
                Some((std::slice::from_ref(host), styles)),
            );
            measured_reflow_inline_table(table, styles, dpi).unwrap();
            assert_eq!(
                lookups(&memo),
                after_first,
                "두 번째 문단 구성은 구역 범위의 결과를 쓴다"
            );
        }
        {
            let other = Arc::new(CellComposeMemo::default());
            let _paragraph = reflow_table_memo_scope(
                Some(Arc::clone(&other)),
                Some((std::slice::from_ref(host), styles)),
            );
            measured_reflow_inline_table(table, styles, dpi).unwrap();
            assert!(lookups(&other) > 0, "다른 기억의 범위는 이어 쓰지 않는다");
        }
        measured_reflow_inline_table(table, styles, dpi).unwrap();
        assert_eq!(lookups(&memo), after_first, "안쪽 범위가 끝나면 구역 범위로 돌아간다");
    }
}
