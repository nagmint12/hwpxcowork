//! 저장 줄이 없는 TAC 표의 흐름과 배치가 공유하는 실제 측정 결과.

use crate::model::table::Table;
use crate::model::{control::Control, paragraph::Paragraph};
use crate::renderer::height_measurer::{HeightMeasurer, MeasuredTable};
use crate::renderer::style_resolver::ResolvedStyleSet;

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
    Ok(table.common.treat_as_char
        && (super::table_cells_have_no_stored_lines(table)
            || inline_table_width_cache_is_stale_with_storage(table, storage)?))
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
    Ok(table
        .closed_inline_grid_width_hu_with_storage(storage)?
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
    HeightMeasurer::new(dpi)
        .with_session_edited(true)
        .measure_table_with_storage(table, 0, 0, styles, storage)
        .map(Some)
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
        let measured = HeightMeasurer::new(dpi)
            .with_session_edited(true)
            .measure_table_with_storage(table, 0, 0, styles, storage)?;
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
