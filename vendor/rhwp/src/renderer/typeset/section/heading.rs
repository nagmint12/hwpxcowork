//! 구역 문단 처리의 keep_heading_with_following_block 단계. 조건·예약·발행 순서를 유지한다.
use crate::renderer::typeset::{PageItem, Paragraph, TypesetEngine, TypesetState};

/// 저장 쪽 경계의 증거는 재조판 누적 좌표와 섞지 않는다.
/// 줄 수·내용·셀 배치가 바뀐 원본 스냅샷은 현재 줄의 위치 증거가 아니다.
fn stored_row_position(paragraph: &Paragraph, row: usize) -> Option<i32> {
    if paragraph.stored_text_partition_is_dirty()
        || paragraph.cell_format_vpos_dirty
        // 현재 줄 구성의 공백/개체 원장은 파생 기하의 출처다. 유효한 새 줄도
        // 원본이 기록한 쪽 경계의 독립 증거로 다시 해석하지 않는다.
        || !paragraph.layout_space_metrics.is_empty()
        || paragraph.layout_object_projection
        || paragraph
            .line_segs
            .iter()
            .any(super::super::is_synthetic_line_seg)
    {
        return None;
    }
    let line = paragraph.line_segs.get(row)?;
    match &paragraph.source_line_seg_vertical_pos {
        Some(source) if source.len() == paragraph.line_segs.len() => source.get(row).copied(),
        Some(_) => None,
        None => Some(line.vertical_pos),
    }
}
impl TypesetEngine {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn keep_heading_with_following_block(
        &self,
        st: &mut TypesetState,
        para_idx: usize,
        para: &Paragraph,
        paragraphs: &[Paragraph],
    ) {
        match self.keep_heading_with_following_block_with_storage(
            st,
            para_idx,
            para,
            paragraphs,
            &crate::storage::Unbounded,
        ) {
            Ok(value) => value,
            Err(never) => match never {},
        }
    }

    pub(super) fn keep_heading_with_following_block_with_storage<S: crate::storage::Storage>(
        &self,
        st: &mut TypesetState,
        para_idx: usize,
        para: &Paragraph,
        paragraphs: &[Paragraph],
        storage: &S,
    ) -> Result<(), S::Error> {
        // [Task #404] heading-orphan 패턴 보정 (vpos 기반).
        // 현재 paragraph 가 누적 height 로는 fit 하지만 HWP vpos 기준 페이지 한계를
        // 넘고, 다음 substantial block(Table/Shape/큰 paragraph)이 잔여 영역에 들어
        // 가지 않을 때 → 현재 paragraph 를 다음 페이지로 push 하여 heading + 후속
        // 블록을 같은 페이지에 배치.
        //
        // 조건 (모두 AND):
        //   A) current_items 비어있지 않음 (페이지 첫 item 자기참조 회피)
        //   B) 단일 단 + wrap-around zone 아님 (multi-column / wrap 의미 차이 회피)
        //   C) 누적 height 로 fit
        //   D) vpos overflow > 1mm (283 HU)
        //   E) 다음 paragraph 의 height 가 substantial (>30px ≈ 8mm) AND 잔여 영역에
        //      들어가지 않음
        //
        // Stage 1 진단 로그 분석으로 false positive 41건 → 1건(pi=83)으로 축소.
        // page_top_vpos 는 current_items 의 첫 item para_index 를 통해 즉시 계산
        // (TypesetState 필드 추적은 typeset_paragraph 내부 페이지 flush 와 동기 안 됨).
        let _: () = if !st.current_items.is_empty() && st.wrap_around_cs < 0 && st.col_count == 1 {
            let page_first_para_idx = st.current_items.iter().find_map(|item| match item {
                PageItem::FullParagraph { para_index } => Some(*para_index),
                PageItem::PartialParagraph { para_index, .. } => Some(*para_index),
                PageItem::Table { para_index, .. } => Some(*para_index),
                // 이어지는 표 조각의 host vpos 는 앞 쪽의 좌표다 — 이 쪽 원점이 아니다.
                PageItem::PartialTable {
                    is_continuation: true,
                    ..
                } => None,
                PageItem::PartialTable { para_index, .. } => Some(*para_index),
                PageItem::Shape { para_index, .. } => Some(*para_index),
                PageItem::EndnoteSeparator { .. } => None,
            });
            let page_top_vpos_opt = page_first_para_idx
                .and_then(|pi| paragraphs.get(pi))
                .and_then(|paragraph| stored_row_position(paragraph, 0));
            if let Some(page_top_vpos) = page_top_vpos_opt {
                let Some(last_index) = para.line_segs.len().checked_sub(1) else {
                    return Ok(());
                };
                let Some(last_vpos) = stored_row_position(para, last_index) else {
                    return Ok(());
                };
                let body_h_hu =
                    crate::renderer::px_to_hwpunit(st.layout.body_area.height, self.dpi);
                let para_h_px: f64 = para
                    .line_segs
                    .iter()
                    .map(|s| {
                        crate::renderer::hwpunit_to_px(
                            s.line_height.saturating_add(s.line_spacing),
                            self.dpi,
                        )
                    })
                    .sum();
                // [Task #643] vpos_end 는 마지막 줄의 bottom (vpos + lh) 기준.
                // para_h_px 누적은 트레일링 line_spacing 까지 포함하여 ~10-12 HU 과대.
                // HWP 가 페이지 끝에서 트레일링 ls 를 고려하지 않고 lh 만 fit 검사하는
                // 시멘틱 정합 (pi=39 page 3 fits 케이스).
                // 손상 입력의 거대한 vpos/height 로 i32 덧셈이 오버플로(패닉)하지
                // 않도록 saturating — 정상값에선 동일, 손상값은 i32::MAX 로 포화.
                let vpos_end = last_vpos.saturating_add(para.line_segs[last_index].line_height);
                let page_bottom_vpos = page_top_vpos.saturating_add(body_h_hu);

                let avail = st.available_height();
                let current_fits = st.current_height + para_h_px <= avail;
                let vpos_overflow = vpos_end > page_bottom_vpos + 283; // 1mm 안전여유

                let next_h_px: f64 = paragraphs
                    .get(para_idx + 1)
                    .map(|p| {
                        p.line_segs
                            .iter()
                            .map(|s| {
                                crate::renderer::hwpunit_to_px(
                                    s.line_height.saturating_add(s.line_spacing),
                                    self.dpi,
                                )
                            })
                            .sum::<f64>()
                    })
                    .unwrap_or(0.0);
                let next_substantial = next_h_px > 30.0;
                let next_doesnt_fit = st.current_height + para_h_px + next_h_px > avail;

                if current_fits && vpos_overflow && next_substantial && next_doesnt_fit {
                    st.advance_column_or_new_page_with_storage(storage)?;
                }
            }
        };
        Ok(())
    }

    /// [hwpx-cowork] 문단 모양 '다음 문단과 함께'(keepWithNext)·'문단 보호'(keepLines) — 저장 줄 없는 문단.
    /// 저장 줄이 있으면 한/글이 정한 쪽 나눔(vpos 되감김)을 따르므로 손대지 않는다. 생성기·편집기 문서는 저장 줄이 없어
    /// rhwp 가 직접 쪽을 나누는데, 이 두 속성을 보지 않아 한/글과 쪽이 갈렸다(재수강 분석보고서: 쪽 끝의 제목
    /// '2) 재수강의 정의와 판정'(다음 문단과 함께)을 한/글은 다음 쪽 첫머리로, rhwp 는 쪽 끝에 홀로 두었다).
    /// - 다음 문단과 함께: 이 문단(과 이어지는 '함께' 문단들) 뒤에 다음 문단의 첫 줄이 이 쪽에 들어가지 않으면 이 문단부터
    ///   다음 쪽으로. 다음 문단이 표를 단 문단이면 캡션과 표 첫 줄까지.
    /// - 문단 보호: 문단이 이 쪽에 다 들어가지 않으면 나누지 않고 통째로 다음 쪽으로.
    /// 어느 쪽이든 옮길 묶음이 빈 쪽에 들어갈 때만(안 들어가면 한/글도 나눈다).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn keep_synthetic_paragraph_together(
        &self,
        st: &mut TypesetState,
        para_idx: usize,
        paragraphs: &[Paragraph],
        composed: &[crate::renderer::composer::ComposedParagraph],
        styles: &crate::renderer::style_resolver::ResolvedStyleSet,
        measured_tables: &[crate::renderer::height_measurer::MeasuredTable],
    ) {
        if st.current_items.is_empty() || st.wrap_around_cs >= 0 || st.col_count != 1 {
            return;
        }
        let synthetic = |p: &Paragraph| {
            !p.line_segs.is_empty() && p.line_segs.iter().all(super::super::is_synthetic_line_seg)
        };
        let style = |p: &Paragraph| styles.para_styles.get(p.para_shape_id as usize);
        let Some(para) = paragraphs.get(para_idx) else {
            return;
        };
        if !synthetic(para) {
            return;
        }
        let col_w = st
            .layout
            .column_areas
            .get(st.current_column as usize)
            .map(|a| a.width)
            .unwrap_or(st.layout.body_area.width);
        let avail = st.available_height();
        let fresh = st.base_available_height();
        let own = self.format_paragraph(para, composed.get(para_idx), styles, Some(col_w));
        let keep_lines = style(para).is_some_and(|s| s.keep_lines) && own.line_count() > 1;
        // [hwpx-cowork] 글자처럼 취급한 개체(표·그림·도형)만 든 문단도 문단 보호를 지킨다 — 개체는 제 줄을 차지하는
        // 글자다. 표준서식 생성 보고서의 「표 + 줄 바꿈 + 주: …」 문단(문단 보호)은 한/글 2022 에서 표와 주석 일부가
        // 쪽에 들어가도 문단 통째로 다음 쪽에 놓였다(2026-11-16 COM, 본문 306·384번 문단). 종전에는 글 문단만 보았다.
        let only_inline_objects = para.controls.iter().all(|control| match control {
            crate::model::control::Control::Table(table) => table.common.treat_as_char,
            crate::model::control::Control::Picture(picture) => picture.common.treat_as_char,
            crate::model::control::Control::Shape(shape) => shape.common().treat_as_char,
            other => crate::renderer::composer::control_is_width_neutral_marker(other),
        });
        if keep_lines
            && only_inline_objects
            && st.current_height + own.height_for_fit > avail
            && own.height_for_fit <= fresh
        {
            st.advance_column_or_new_page();
            return;
        }
        if !style(para).is_some_and(|s| s.keep_with_next) || own.line_count() > 3 {
            return;
        }
        let mut need = 0.0;
        let mut k = para_idx;
        loop {
            let Some(p) = paragraphs.get(k) else {
                return;
            };
            if k > para_idx && !synthetic(p) {
                return;
            }
            let fmt = if k == para_idx {
                own.clone()
            } else {
                self.format_paragraph(p, composed.get(k), styles, Some(col_w))
            };
            let chained = k > para_idx
                && style(p).is_some_and(|s| s.keep_with_next)
                && fmt.line_count() <= 3
                && paragraphs.get(k + 1).is_some();
            if k == para_idx || chained {
                need += fmt.total_height;
                k += 1;
                if k - para_idx > 8 {
                    return;
                }
                continue;
            }
            // 다음 문단의 첫머리: 문단 앞 간격 + 첫 줄. 문단 기준 자리차지 표면 위 캡션 + 표 첫 줄(행)까지.
            need += fmt.spacing_before;
            let table_head = p
                .controls
                .iter()
                .enumerate()
                .find_map(|(ci, ctrl)| match ctrl {
                    crate::model::control::Control::Table(t)
                        if !t.common.treat_as_char
                            && matches!(
                                t.common.vert_rel_to,
                                crate::model::shape::VertRelTo::Para
                            ) =>
                    {
                        measured_tables
                            .iter()
                            .find(|m| m.para_index == k && m.control_index == ci)
                            .map(|m| {
                                m.caption_height + m.row_heights.first().copied().unwrap_or(0.0)
                            })
                    }
                    _ => None,
                });
            need += table_head.unwrap_or_else(|| fmt.line_heights.first().copied().unwrap_or(0.0));
            break;
        }
        if st.current_height + need > avail && need <= fresh {
            st.advance_column_or_new_page();
        }
    }
}
