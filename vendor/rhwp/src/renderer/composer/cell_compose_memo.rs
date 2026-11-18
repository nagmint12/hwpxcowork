//! [hwpx-cowork] 칸 문단의 줄 구성(조합 + 칸 폭 재조판) 결과를 문단 **내용 지문**으로 기억한다(2026-11-18).
//!
//! 칸 하나에 글을 쳐 줄 수가 바뀌면 전체 쪽 나눔이 표의 모든 칸 문단을 다시 줄 나눔했다 — 측정이 두 번,
//! 조판의 칸 유닛이 한 번, 그 뒤 쪽 나무가 또 한 번(1,936칸 표: 줄이 한 줄 늘 때마다 0.3초 안팎).
//! 글·글자 모양·저장 줄과 측정 환경이 그대로인 문단은 같은 폭에서 같은 줄 구성을 내므로 이를 재사용한다.
//!
//! 안전장치는 세 겹이다.
//! 1. 열쇠 = 문단의 모든 필드 지문(`fingerprint` — 필드를 빠짐없이 풀어 쓰므로 필드가 늘면 컴파일이 멈춘다)
//!    + 폭·한 줄로 입력·dpi·저장 줄 정책·HWP5 여부. 주소가 아니라 내용이 열쇠라 문단이 옮겨지거나 사본이어도 맞다.
//! 2. 기억하는 문단은 좁게: 개체·누름틀·번호 머리·탭이 없는 가로 글 문단만(그 밖은 늘 새로 계산).
//! 3. 수명: 같은 문서에서 변경이 없거나 글 편집만 마무리하는 쪽 나눔에 걸쳐 보존한다.
//!    스타일이나 글꼴 측정 환경이 바뀌면 비운다. 보관할 사본의 수와 데이터 크기도 제한한다.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

use super::ComposedParagraph;
use crate::model::paragraph::{NumberingMarker, Paragraph};
use crate::model::provenance::StoredGeometryPolicy;

/// 한 문서가 기억하는 문단 수의 상한(넘으면 통째로 비우고 다시 채운다).
const MAX_ENTRIES: usize = 60_000;
// [hwpx-cowork] 긴 칸에 한 글자씩 넣더라도 연속된 모든 본문과 줄 사본을 누적하지 않는다.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    content: (u64, u64),
    width: u64,
    dpi: u64,
    line_wrap: u8,
    flags: u8,
}

#[derive(Default)]
struct State {
    /// 지난 쪽 나눔의 환경 표지(글꼴 측정 문맥·dpi 등). 달라지면 비운다.
    environment: Option<u64>,
    /// 다음 쪽 나눔 시작에서 비우지 않는다(미룬 글 편집의 마무리 한 번만).
    keep_next_pass: bool,
    // `Arc` 로 싸지 않는다 — 문서(`DocumentCore: Send`)가 쥐는 값이라 `ComposedParagraph: Send` 만 요구한다.
    entries: HashMap<Key, ComposedParagraph>,
    payload_bytes: usize,
    hits: u64,
    misses: u64,
    /// 쪽 나눔 시작 횟수 · 그중 기억을 남긴 횟수 · 환경 표지가 달라 비운 횟수(진단).
    passes: u64,
    kept_passes: u64,
    environment_changes: u64,
}

impl State {
    fn clear_entries(&mut self) {
        self.entries.clear();
        self.payload_bytes = 0;
    }
}

/// 보관하는 평문 문단의 키·값과 줄·런·글·프레임 데이터 크기(할당기 오버헤드 제외).
/// 별도 복합 데이터를 소유하는 결과는 문서 수명으로 연장하지 않는다.
fn payload_bytes(composed: &ComposedParagraph) -> Option<usize> {
    use std::mem::{size_of, size_of_val};
    if composed.horizontal_shaping.is_some()
        || composed.numbering_text.is_some()
        || !composed.inline_controls.is_empty()
        || !composed.tac_controls.is_empty()
        || !composed.footnote_positions.is_empty()
        || !composed.tab_extended.is_empty()
    {
        return None;
    }
    let mut bytes = size_of::<(Key, ComposedParagraph)>() + size_of_val(composed.lines.as_slice());
    for line in &composed.lines {
        bytes += size_of_val(line.runs.as_slice());
        for run in &line.runs {
            if run.char_overlap.is_some() {
                return None;
            }
            bytes += run.text.len() + run.display_text.as_ref().map_or(0, String::len);
        }
    }
    if let Some(frame) = &composed.frame_geometry {
        // 프레임은 Arc이므로 기존 벡터의 여유 공간까지 살아남는다.
        bytes += size_of_val(frame.as_ref())
            + frame.line_segs.capacity() * size_of::<crate::model::paragraph::LineSeg>()
            + frame.space_metrics.capacity()
                * size_of::<(u32, crate::model::paragraph::SpaceMetric)>()
            + frame.inline_table_heights.capacity() * size_of::<(usize, u32)>();
    }
    Some(bytes)
}

#[derive(Default)]
pub(crate) struct CellComposeMemo {
    state: Mutex<State>,
}

impl std::fmt::Debug for CellComposeMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (entries, hits, misses) = self.stats();
        write!(
            f,
            "CellComposeMemo {{ entries: {entries}, hits: {hits}, misses: {misses} }}"
        )
    }
}

impl CellComposeMemo {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // 기억은 파생값뿐이다 — 잠금이 오염됐어도(다른 스레드의 panic) 그대로 이어 쓴다.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 스타일·글꼴 측정 환경이 바뀜 — 모두 버린다.
    pub(crate) fn invalidate(&self) {
        let mut state = self.lock();
        state.clear_entries();
        state.keep_next_pass = false;
    }

    /// 다음 쪽 나눔 한 번은 비우지 않는다(그사이 바뀐 것이 미룬 글 편집뿐일 때만 부른다).
    pub(crate) fn keep_for_next_pass(&self) {
        self.lock().keep_next_pass = true;
    }

    /// 쪽 나눔 시작. 환경 표지가 달라졌거나 남기라는 표시가 없으면 비운다.
    pub(crate) fn begin_pass(&self, environment: u64) {
        let mut state = self.lock();
        let keep = std::mem::take(&mut state.keep_next_pass);
        let same_environment = state.environment == Some(environment);
        state.passes += 1;
        if !same_environment && state.environment.is_some() {
            state.environment_changes += 1;
        }
        if keep && same_environment {
            state.kept_passes += 1;
        } else {
            state.clear_entries();
        }
        state.environment = Some(environment);
    }

    /// (기억한 문단 수, 재사용 횟수, 새로 계산한 횟수)
    pub(crate) fn stats(&self) -> (usize, u64, u64) {
        let state = self.lock();
        (state.entries.len(), state.hits, state.misses)
    }

    /// (쪽 나눔 시작 횟수, 그중 기억을 남긴 횟수, 환경 표지가 달라진 횟수)
    pub(crate) fn pass_stats(&self) -> (u64, u64, u64) {
        let state = self.lock();
        (state.passes, state.kept_passes, state.environment_changes)
    }

    /// 가로 글 칸 문단의 줄 구성. 기억할 수 있는 문단이고 같은 열쇠가 있으면 그 사본을, 아니면 `compute` 결과를 돌려준다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn compose<E>(
        &self,
        para: &Paragraph,
        width: f64,
        cell_line_wrap: u8,
        dpi: f64,
        policy: StoredGeometryPolicy,
        native_hwp5: bool,
        compute: impl FnOnce() -> Result<ComposedParagraph, E>,
    ) -> Result<ComposedParagraph, E> {
        let Some(content) = fingerprint(para) else {
            return compute();
        };
        if !width.is_finite() {
            return compute();
        }
        let StoredGeometryPolicy {
            preserve_hwp3_origins,
            requires_realign,
            hwpx_cell_geometry,
            stored_rows_before_hancom_2020,
        } = policy;
        let key = Key {
            content,
            width: width.to_bits(),
            dpi: dpi.to_bits(),
            line_wrap: cell_line_wrap,
            flags: u8::from(native_hwp5)
                | u8::from(preserve_hwp3_origins) << 1
                | u8::from(requires_realign) << 2
                | u8::from(hwpx_cell_geometry) << 3
                | u8::from(stored_rows_before_hancom_2020) << 4,
        };
        {
            let mut state = self.lock();
            if let Some(found) = state.entries.get(&key).cloned() {
                state.hits += 1;
                return Ok(found);
            }
        }
        // 계산하는 동안은 잠그지 않는다(중첩 호출·오래 걸리는 줄 나눔).
        let composed = compute()?;
        let mut state = self.lock();
        state.misses += 1;
        if let Some(bytes) = payload_bytes(&composed).filter(|bytes| *bytes <= MAX_PAYLOAD_BYTES) {
            if state.entries.len() >= MAX_ENTRIES || state.payload_bytes + bytes > MAX_PAYLOAD_BYTES
            {
                state.clear_entries();
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = state.entries.entry(key) {
                slot.insert(composed.clone());
                state.payload_bytes += bytes;
            }
        }
        Ok(composed)
    }
}

/// 기억이 없으면(`None`) 그대로 계산한다 — 호출부가 한 줄로 쓰게.
#[allow(clippy::too_many_arguments)]
pub(crate) fn compose_cell_paragraph<E>(
    memo: Option<&CellComposeMemo>,
    para: &Paragraph,
    width: f64,
    cell_line_wrap: u8,
    dpi: f64,
    policy: StoredGeometryPolicy,
    native_hwp5: bool,
    compute: impl FnOnce() -> Result<ComposedParagraph, E>,
) -> Result<ComposedParagraph, E> {
    match memo {
        Some(memo) => memo.compose(
            para,
            width,
            cell_line_wrap,
            dpi,
            policy,
            native_hwp5,
            compute,
        ),
        None => compute(),
    }
}

/// 두 개의 독립 해시(충돌 여유).
struct Fingerprint(
    std::collections::hash_map::DefaultHasher,
    std::collections::hash_map::DefaultHasher,
);

impl Fingerprint {
    fn new() -> Self {
        let mut second = std::collections::hash_map::DefaultHasher::new();
        0x9E37_79B9_7F4A_7C15_u64.hash(&mut second);
        Self(std::collections::hash_map::DefaultHasher::new(), second)
    }

    fn put<T: Hash + ?Sized>(&mut self, value: &T) {
        value.hash(&mut self.0);
        value.hash(&mut self.1);
    }

    fn finish(self) -> (u64, u64) {
        (self.0.finish(), self.1.finish())
    }
}

/// 문단 내용 지문. 기억하지 않는 문단(개체·누름틀·번호 머리·탭·특수 표지)은 `None`.
///
/// 필드를 하나도 빠뜨리지 않게 `..` 없이 풀어 쓴다 — `Paragraph` 에 필드가 생기면 여기서 컴파일이 멈춘다.
/// 줄 구성과 무관해 보이는 필드도 넣는다(무관한지 따지다 틀리는 것보다 덜 맞는 편이 안전하다).
fn fingerprint(para: &Paragraph) -> Option<(u64, u64)> {
    let Paragraph {
        char_count,
        control_mask,
        para_shape_id,
        hwpx_missing_para_shape,
        style_id,
        column_type,
        raw_break_type,
        page_break_synthesized,
        text,
        text_element_origins,
        char_offsets,
        literal_figure_spaces,
        nb_space_control_indices,
        char_shapes,
        line_segs,
        hwp3_saved_space_corrections,
        layout_space_metrics,
        layout_object_projection,
        layout_float_band,
        layout_field_values,
        hwpx_axis_shift,
        layout_only_fill_lines,
        source_line_seg_vertical_pos,
        layout_rebased_body_axis,
        layout_source_text_partition,
        layout_cell_grid,
        range_tags,
        field_ranges,
        orphan_field_ends,
        controls,
        ctrl_data_records,
        char_count_msb,
        raw_header_extra,
        has_para_text,
        tab_extended,
        title_marks,
        markpen_marks,
        numbering_restart,
        stored_text_partition_dirty,
        cell_format_vpos_dirty,
        cell_vpos_reset,
        stored_flow_shifted,
        numbering_marker,
    } = para;
    // 개체·누름틀·동적 필드 값·원고지 격자·영역 표지·제목/형광펜 표지·번호 머리·탭이 있으면 기억하지 않는다
    // (쪽 소속·번호·탭 자리 같은 문단 밖 상태를 읽을 수 있는 것들).
    if !controls.is_empty()
        || !ctrl_data_records.is_empty()
        || !field_ranges.is_empty()
        || !orphan_field_ends.is_empty()
        || !layout_field_values.is_empty()
        || layout_cell_grid.is_some()
        || !range_tags.is_empty()
        || !title_marks.is_empty()
        || !markpen_marks.is_empty()
        || !tab_extended.is_empty()
        || numbering_restart.is_some()
        || matches!(numbering_marker, NumberingMarker::Text(..))
        || text.contains('\t')
    {
        return None;
    }
    let mut fp = Fingerprint::new();
    // 번호 머리가 없는 두 상태(아직 안 정함·번호 문단 아님)는 구별해 둔다.
    fp.put(&matches!(numbering_marker, NumberingMarker::Absent));
    fp.put(char_count);
    fp.put(control_mask);
    fp.put(para_shape_id);
    fp.put(hwpx_missing_para_shape);
    fp.put(style_id);
    fp.put(&std::mem::discriminant(column_type));
    fp.put(raw_break_type);
    fp.put(page_break_synthesized);
    fp.put(text.as_str());
    fp.put(text_element_origins);
    fp.put(char_offsets);
    fp.put(literal_figure_spaces);
    fp.put(nb_space_control_indices);
    fp.put(&char_shapes.len());
    for shape in char_shapes {
        let crate::model::paragraph::CharShapeRef {
            start_pos,
            char_shape_id,
        } = shape;
        fp.put(start_pos);
        fp.put(char_shape_id);
    }
    fp.put(&line_segs.len());
    for seg in line_segs {
        let crate::model::paragraph::LineSeg {
            text_start,
            vertical_pos,
            line_height,
            text_height,
            baseline_distance,
            line_spacing,
            column_start,
            segment_width,
            tag,
        } = seg;
        fp.put(&(
            *text_start,
            *vertical_pos,
            *line_height,
            *text_height,
            *baseline_distance,
            *line_spacing,
            *column_start,
            *segment_width,
            *tag,
        ));
    }
    fp.put(hwp3_saved_space_corrections);
    fp.put(&layout_space_metrics.len());
    for (start, metric) in layout_space_metrics {
        fp.put(start);
        fp.put(&std::mem::discriminant(metric));
    }
    fp.put(layout_object_projection);
    fp.put(layout_float_band);
    fp.put(hwpx_axis_shift);
    fp.put(layout_only_fill_lines);
    fp.put(source_line_seg_vertical_pos);
    fp.put(layout_rebased_body_axis);
    fp.put(layout_source_text_partition);
    fp.put(char_count_msb);
    fp.put(raw_header_extra);
    fp.put(has_para_text);
    fp.put(stored_text_partition_dirty);
    fp.put(cell_format_vpos_dirty);
    fp.put(cell_vpos_reset);
    fp.put(stored_flow_shifted);
    Some(fp.finish())
}

#[cfg(test)]
mod tests {
    //! 계약 시험(합성 입력): 같은 내용·같은 폭이면 한 번만 계산하고, 내용·폭·정책이 달라지면 다시 계산하며,
    //! 기억하지 않는 문단은 늘 계산하고, 쪽 나눔 경계·환경 변화에서 비우는지. 조판 좌표는 다루지 않는다.
    use super::*;
    use crate::model::control::Control;
    use crate::model::paragraph::LineSeg;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            text: text.to_string(),
            char_count: text.chars().count() as u32,
            ..Default::default()
        }
    }

    fn composed(lines: usize) -> ComposedParagraph {
        let mut out = crate::renderer::composer::compose_paragraph_in_context(
            &para("x"),
            &crate::renderer::style_resolver::ResolvedStyleSet::default(),
        );
        out.para_style_id = lines as u16;
        out
    }

    fn run(
        memo: &CellComposeMemo,
        p: &Paragraph,
        width: f64,
        calls: &std::cell::Cell<usize>,
    ) -> u16 {
        memo.compose::<std::convert::Infallible>(
            p,
            width,
            0,
            96.0,
            StoredGeometryPolicy::default(),
            false,
            || {
                calls.set(calls.get() + 1);
                Ok(composed(calls.get()))
            },
        )
        .map(|c| c.para_style_id)
        .unwrap_or_else(|never| match never {})
    }

    #[test]
    fn same_content_and_width_is_computed_once_even_for_a_different_object() {
        let memo = CellComposeMemo::default();
        let calls = std::cell::Cell::new(0);
        let a = para("가나다");
        let b = para("가나다");
        assert_eq!(run(&memo, &a, 100.0, &calls), 1);
        assert_eq!(run(&memo, &a, 100.0, &calls), 1);
        assert_eq!(
            run(&memo, &b, 100.0, &calls),
            1,
            "주소가 달라도 내용이 같으면 같은 결과"
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(memo.stats(), (1, 2, 1));
    }

    #[test]
    fn any_content_or_argument_change_recomputes() {
        let memo = CellComposeMemo::default();
        let calls = std::cell::Cell::new(0);
        let base = para("가나다");
        run(&memo, &base, 100.0, &calls);
        // 글
        run(&memo, &para("가나라"), 100.0, &calls);
        // 폭
        run(&memo, &base, 101.0, &calls);
        // 글자 모양
        let mut shaped = para("가나다");
        shaped
            .char_shapes
            .push(crate::model::paragraph::CharShapeRef {
                start_pos: 0,
                char_shape_id: 7,
            });
        run(&memo, &shaped, 100.0, &calls);
        // 문단 모양
        let mut styled = para("가나다");
        styled.para_shape_id = 3;
        run(&memo, &styled, 100.0, &calls);
        // 저장 줄
        let mut lined = para("가나다");
        lined.line_segs.push(LineSeg {
            line_height: 1200,
            ..Default::default()
        });
        run(&memo, &lined, 100.0, &calls);
        assert_eq!(calls.get(), 6);
        // 정책·HWP5 여부·한 줄로 입력
        let mut n = 0;
        for (wrap, native, policy) in [
            (1_u8, false, StoredGeometryPolicy::default()),
            (0, true, StoredGeometryPolicy::default()),
            (0, false, StoredGeometryPolicy::from(true)),
        ] {
            memo.compose::<std::convert::Infallible>(
                &base,
                100.0,
                wrap,
                96.0,
                policy,
                native,
                || {
                    n += 1;
                    Ok(composed(0))
                },
            )
            .unwrap_or_else(|never| match never {});
        }
        assert_eq!(n, 3);
    }

    #[test]
    fn paragraphs_with_outside_state_are_never_remembered() {
        let memo = CellComposeMemo::default();
        let calls = std::cell::Cell::new(0);
        let mut with_control = para("가나다");
        with_control.controls.push(Control::Table(Box::default()));
        let with_tab = para("가\t나");
        let mut with_field_value = para("가나다");
        with_field_value
            .layout_field_values
            .push((0, "3".to_string()));
        for p in [&with_control, &with_tab, &with_field_value] {
            run(&memo, p, 100.0, &calls);
            run(&memo, p, 100.0, &calls);
        }
        assert_eq!(calls.get(), 6);
        assert_eq!(memo.stats().0, 0);
        assert!(fingerprint(&para("가나다")).is_some());
        // 쪽 나눔이 번호를 정한 뒤의 보통 문단(번호 문단 아님)은 기억한다 — 번호 글이 붙은 문단만 뺀다.
        let mut plain = para("가나다");
        plain.numbering_marker = NumberingMarker::Absent;
        assert!(fingerprint(&plain).is_some());
        assert_ne!(fingerprint(&plain), fingerprint(&para("가나다")));
        let mut numbered = para("가나다");
        numbered.numbering_marker = NumberingMarker::Text("1.".to_string(), Default::default());
        assert!(fingerprint(&numbered).is_none());
    }

    #[test]
    fn cleared_at_pass_start_unless_kept_and_environment_is_unchanged() {
        let memo = CellComposeMemo::default();
        let calls = std::cell::Cell::new(0);
        let p = para("가나다");
        memo.begin_pass(1);
        run(&memo, &p, 100.0, &calls);
        // 보통 쪽 나눔: 비운다
        memo.begin_pass(1);
        assert_eq!(memo.stats().0, 0);
        run(&memo, &p, 100.0, &calls);
        // 미룬 글 편집의 마무리: 남긴다(한 번만)
        memo.keep_for_next_pass();
        memo.begin_pass(1);
        assert_eq!(memo.stats().0, 1);
        memo.begin_pass(1);
        assert_eq!(memo.stats().0, 0);
        run(&memo, &p, 100.0, &calls);
        // 남기라고 했어도 환경이 달라졌으면 비운다
        memo.keep_for_next_pass();
        memo.begin_pass(2);
        assert_eq!(memo.stats().0, 0);
        run(&memo, &p, 100.0, &calls);
        // 스타일을 다시 풀면 그 자리에서 비우고 남기라는 표시도 거둔다
        memo.keep_for_next_pass();
        memo.invalidate();
        assert_eq!(memo.stats().0, 0);
        run(&memo, &p, 100.0, &calls);
        memo.begin_pass(2);
        assert_eq!(memo.stats().0, 0);
        assert_eq!(calls.get(), 5);
    }

    #[test]
    fn long_edit_versions_do_not_accumulate_or_evict_for_an_oversized_result() {
        let memo = CellComposeMemo::default();
        let cache_version = |id, text_bytes| {
            memo.compose::<std::convert::Infallible>(
                &para(id),
                100.0,
                0,
                96.0,
                StoredGeometryPolicy::default(),
                false,
                || {
                    let mut value = composed(0);
                    value.lines[0].runs[0].text = "x".repeat(text_bytes);
                    Ok(value)
                },
            )
            .unwrap();
        };
        cache_version("a", MAX_PAYLOAD_BYTES / 2);
        cache_version("ab", MAX_PAYLOAD_BYTES / 2);
        assert_eq!(
            memo.stats().0,
            1,
            "두 버전의 줄·글 사본 합이 문서 예산을 넘긴다"
        );
        let bytes = memo.lock().payload_bytes;
        assert!(bytes > MAX_PAYLOAD_BYTES / 2 && bytes <= MAX_PAYLOAD_BYTES);
        cache_version("abc", MAX_PAYLOAD_BYTES);
        assert_eq!(memo.stats().0, 1);
        assert_eq!(memo.lock().payload_bytes, bytes);
        let calls = std::cell::Cell::new(0);
        run(&memo, &para("ab"), 100.0, &calls);
        assert_eq!(
            calls.get(),
            0,
            "예산보다 큰 단일 결과는 이전 정상 항목을 밀어내지 않는다"
        );
        memo.invalidate();
        assert_eq!(memo.lock().payload_bytes, 0);
    }

    fn document_with_cached_cell() -> crate::document_core::DocumentCore {
        let mut core = crate::document_core::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let inserted = core.create_table_native(0, 0, 0, 2, 2).unwrap();
        let table: serde_json::Value = serde_json::from_str(&inserted).unwrap();
        let paragraph = table["paraIdx"].as_u64().unwrap() as usize;
        let control = table["controlIdx"].as_u64().unwrap() as usize;
        core.insert_text_in_cell_native(0, paragraph, control, 0, 0, 0, "가나다 ABC")
            .unwrap();
        assert!(core.cell_compose_memo.stats().0 > 0);
        core
    }

    #[test]
    fn exact_font_registration_invalidates_before_batch_pagination() {
        let mut core = document_with_cached_cell();
        let passes = core.cell_compose_memo.pass_stats().0;
        core.begin_batch_native().unwrap();
        core.register_exact_font_source_native(
            0,
            1,
            include_bytes!("../../../tests/fixtures/fonts/RHWPExactKerningSmoke.ttf"),
            0,
        )
        .unwrap();
        assert_eq!(
            core.cell_compose_memo.pass_stats().0,
            passes,
            "쪽 나눔 전이다"
        );
        assert_eq!(
            core.cell_compose_memo.stats().0,
            0,
            "이전 글꼴로 만든 줄을 쓰지 않는다"
        );
    }

    #[cfg(feature = "pdf-import")]
    #[test]
    fn budgeted_pagination_does_not_use_the_editors_cached_copies() {
        use crate::parser::pdf::allocation::Allocation;
        use pdf_oxide::import_limits::ImportBudget;
        let mut core = document_with_cached_cell();
        let stats = core.cell_compose_memo.stats();
        core.mark_all_sections_dirty();
        let budget = ImportBudget::new(Default::default()).unwrap();
        core.paginate_with_storage(&Allocation(&budget)).unwrap();
        assert_eq!(core.cell_compose_memo.stats(), stats);
        assert!(
            budget.decoded_bytes() > 0,
            "측정과 조판이 요청 예산을 사용한다"
        );
    }
}
