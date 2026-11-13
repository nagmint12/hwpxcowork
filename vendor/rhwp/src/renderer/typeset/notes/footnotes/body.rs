//! 본문 각주 등록 조정. 앵커/현재/다음 쪽 선택 뒤 원래 예약 순서로 확정한다.

use crate::renderer::typeset::notes::footnotes::boundary::{
    native_hwp5_body_footnote_tail_reset, native_hwp5_final_marker_footnote_uses_next_reset_page,
    native_hwp5_footnote_fragment_height, native_hwp5_footnote_reset_fragments,
    native_hwp5_two_line_footnote_fragments, NativeHwp5FootnoteFragmentSplit,
};
use crate::renderer::typeset::{
    hwpunit_to_px, native_hwp5_rowbreak_host_precedes_first_fragment, Control, Footnote,
    FootnoteRef, FootnoteSource, Paragraph, ResolvedStyleSet, TypesetEngine, TypesetState,
};

/// [hwpx-cowork] `k` 줄 뒤 나머지 각주 조각의 내용 높이.
fn footnote_suffix_height(lines: &[(f64, f64)], k: usize) -> f64 {
    super::boundary::footnote_prefix_height(&lines[k.min(lines.len())..], lines.len())
}

impl TypesetEngine {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::renderer::typeset) fn register_body_footnote(
        &self,
        st: &mut TypesetState,
        para_idx: usize,
        para: &Paragraph,
        paragraphs: &[Paragraph],
        ctrl_idx: usize,
        fn_ctrl: &Footnote,
        styles: &ResolvedStyleSet,
        native_hwp5_footnote_break: Option<super::boundary::NativeHwp5FootnoteBreak>,
    ) {
        // 본문 내 참조는 그대로 배치하며, 원본에 없는 각주 번호/구분선을 만들지 않는다.
        if (st.profile.hwpx_stored_layout() || st.profile.hwp5_stored_pagination_layout())
            && !st.profile.session_edited()
            && crate::renderer::stored_footnote_is_bodyless(fn_ctrl)
        {
            // 같은 호스트의 실제 각주 영역 뒤 빈 줄은 참조 번호와 별개로
            // 물리 공간을 소유한다. 단독 빈 참조는 새 영역을 만들지 않는다.
            let follows_same_host_note = st
                .pages
                .last()
                .and_then(|page| page.footnotes.last())
                .is_some_and(|note| {
                    matches!(note.source,
                    FootnoteSource::Body { para_index, control_index }
                        if para_index == para_idx && control_index < ctrl_idx)
                });
            if follows_same_host_note {
                let line = &fn_ctrl.paragraphs[0].line_segs[0];
                st.record_current_footnote(FootnoteRef {
                    column_index: 0,
                    number: fn_ctrl.number,
                    source: FootnoteSource::Body {
                        para_index: para_idx,
                        control_index: ctrl_idx,
                    },
                    fragment: Some(crate::renderer::pagination::FootnoteFragment {
                        start_line: 0,
                        end_line: 1,
                        draw_separator: false,
                        draw_number: false,
                        defer_floats_from: None,
                        carry_floats_from: None,
                        float_cut: None,
                    }),
                });
                st.add_footnote_fragment_height(hwpunit_to_px(line.line_height, self.dpi), false);
            }
            return;
        }
        let source = FootnoteSource::Body {
            para_index: para_idx,
            control_index: ctrl_idx,
        };
        let note_measure = super::measure::BodyFootnoteMeasure {
            engine: self,
            styles,
        };
        let block_content_height = note_measure.block_content_height(st, fn_ctrl, None);
        let content_height =
            block_content_height.unwrap_or_else(|| note_measure.content_height(st, fn_ctrl));
        // 번호는 문서 순서다. 앞 각주의 저장 suffix가 다음 쪽 lane을 열었으면
        // 뒤 번호를 현재 쪽에 끼워 넣지 않고 같은 lane에서 이어받는다.
        // 본문 marker의 소유 쪽은 이 예약으로 바뀌지 않는다.
        // 앞 각주의 뒤 조각이 다음 쪽을 소유하면 같은 현재 쪽 표시의 후속
        // 각주도 그 뒤에 둔다. 이미 완료된 쪽의 표시는 기존 소급 경로가 맡는다.
        if st.has_deferred_body_footnotes()
            && crate::renderer::pagination::find_inline_control_target_page(
                &st.pages,
                &st.current_items,
                para_idx,
                ctrl_idx,
                para,
            )
            .is_none()
        {
            st.defer_body_footnote_for_next_page(
                FootnoteRef {
                    column_index: 0,
                    number: fn_ctrl.number,
                    source,
                    fragment: None,
                },
                content_height,
            );
            return;
        }
        // 원본 HWPX의 표 뒤 형제 각주도 실제 끝 조각 소유를 따른다.
        // 편집·무효 텍스트 분할·합성 줄은 원본 저장 캡션의 근거로 사용하지 않는다.
        let original_hwpx_table_host = st.profile.hwpx_stored_layout()
            && !st.profile.session_edited()
            && !para.stored_text_partition_is_dirty()
            && !para.line_segs.is_empty()
            && para.line_segs.iter().all(|line| {
                line.tag & crate::model::paragraph::LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0
            });
        let stored_table_host_footnote = if (st.profile.hwp5_stored_pagination_layout()
            || original_hwpx_table_host)
            && st.col_count == 1
            && para
                .controls
                .iter()
                .filter(|control| matches!(control, Control::Footnote(_)))
                .count()
                == 1
        {
            let mut top_level_tables =
                para.controls
                    .iter()
                    .enumerate()
                    .filter_map(|(index, control)| {
                        if let Control::Table(table) = control {
                            Some((index, table))
                        } else {
                            None
                        }
                    });
            match (top_level_tables.next(), top_level_tables.next()) {
                (Some((table_control_index, table)), None)
                    if table_control_index + 1 == ctrl_idx
                        && native_hwp5_rowbreak_host_precedes_first_fragment(para, table)
                        && (!original_hwpx_table_host
                            || !self.render_normalization.table_text_reflowed(table)) =>
                {
                    let full_content_height = content_height;
                    st.table_host_terminal_fragment_placement(
                        para_idx,
                        table_control_index,
                        table.row_count,
                    )
                    .map(|terminal_fragment_is_current| {
                        let split = native_hwp5_footnote_reset_fragments(fn_ctrl, self.dpi)
                            .filter(|split| split.force_next_page && st.col_count == 1);
                        let (content_height, draw_separator) = split
                            .map(|split| (split.prefix_height, split.prefix.draw_separator))
                            .unwrap_or_else(|| (full_content_height, true));
                        (
                            terminal_fragment_is_current,
                            content_height,
                            draw_separator,
                            full_content_height,
                        )
                    })
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some((
            terminal_fragment_is_current,
            content_height,
            draw_separator,
            full_content_height,
        )) = stored_table_host_footnote
        {
            let overlap_guard = if terminal_fragment_is_current {
                32.0
            } else {
                0.0
            };
            if !st.footnote_fragment_fits_current_page(
                content_height,
                draw_separator,
                overlap_guard,
            ) {
                // terminal 표가 이미 확정된 page의 body/각주 lane을
                // 소급 축소하지 않는다. 각주가 들어갈 공간이 없으면 표
                // owner를 먼저 flush하고 fresh page에 보존한다.
                st.force_new_page();
            }
            // 표 셀 내부 각주는 table fragment queue가 별도로 등록하지만,
            // 넘버링 caption 뒤의 최상위 형제 각주는 Body source다.
            // 일반 Body marker-page 소급 heuristic을 타지 않는다
            // (정책연구 p87/p91/p95의 note 138/142/147).
            self.register_unqueued_table_footnote_with_content_height(
                st,
                fn_ctrl,
                source,
                full_content_height,
            );
        } else {
            // 최상위 본문 control의 각주는 같은 문단의 형제 표와 독립적이다.
            // 셀 내부 각주는 별도의 fragment queue에서 등록한다.
            let fn_height = content_height;
            // [hwpx-cowork] A following body-page reset does not assign an
            // entire object note to that page. Its accepted float/table cut
            // owns a prefix on the marker page (Hancom saved B straddle).
            let move_to_next_reset_page = !note_measure.has_floating_objects(st, fn_ctrl)
                && native_hwp5_final_marker_footnote_uses_next_reset_page(
                st, para_idx, para, paragraphs, ctrl_idx, fn_ctrl, fn_height,
            );
            // 저장 HWPX는 본문·그림 항목을 확정한 뒤 각주를 등록한다.
            // marker가 현재 쪽에 있고 실제 각주 높이를 예약할 자리가 없으면
            // 이미 놓인 본문을 침범하지 않도록 각주 본문만 다음 쪽에서 시작한다.
            let hwpx_note_overflows_current_page = st.profile.hwpx_stored_layout()
                && st.col_count == 1
                && matches!(
                    st.current_items.last(),
                    Some(crate::renderer::pagination::PageItem::Shape { para_index, .. })
                        if *para_index == para_idx
                )
                && crate::renderer::pagination::find_inline_control_target_page(
                    &st.pages,
                    &st.current_items,
                    para_idx,
                    ctrl_idx,
                    para,
                )
                .is_none()
                && !st.footnote_fragment_fits_current_page(content_height, true, 0.0);
            let body_tail_reset =
                native_hwp5_body_footnote_tail_reset(st, para_idx, para, ctrl_idx);
            // 두 줄 각주는 full-note owner route와 다른 계약이다. marker
            // anchor에 첫 line을 소급하고 tail current page에 두 번째 line을
            // 두는 기존 fallback을 보존한다(p31 note 30).
            let collision_routed = native_hwp5_footnote_break.map(|_| {
                crate::renderer::pagination::find_inline_control_target_page(
                    &st.pages,
                    &st.current_items,
                    para_idx,
                    ctrl_idx,
                    para,
                )
            });
            // 본문 문단이 이미 physical page로 나뉜 뒤 처리되는 Body
            // Footnote는, anchor page가 기존 각주를 이미 가진 경우에는 marker가
            // 든 PartialParagraph의 owner를 따라야 한다. 그렇지 않으면 p52의
            // note 60처럼 marker는 p52에 남고 각주는 tail page p53에 등록된다.
            // 첫 각주가 없는 page까지 일반화하면 p62 note 74처럼 기존 흐름에서
            // 예약하던 각주가 빠져 후속 쪽 나눔을 바꾼다. Native 경로와 함께
            // 유효한 본문 reset을 입증한 HWPX도 같은 표시 쪽 소유를 사용한다.
            // HWPX의 소급 예약은 이미 수용한 본문 점유 끝과 실제 각주 예산이
            // 양립할 때만 허용하며 첫 각주가 없는 쪽은 기존 흐름을 유지한다.
            let saved_hwpx_tail = !st.profile.hwp5_stored_pagination_layout()
                && st.profile.hwpx_stored_layout()
                && body_tail_reset.is_some();
            // 편집하지 않은 HWPX 본문 각주도 표 각주와 같은 저장 줄의 일대일
            // 대응 및 각주 영역 재시작 계약을 사용한다. 조회에서 합성·재구성 줄을
            // 거절하며, 편집한 HWPX는 기존 통째 각주 소유를 유지한다.
            let saved_note_layout = st.profile.hwp5_stored_pagination_layout()
                || (st.profile.hwpx_stored_layout() && !st.profile.session_edited());
            // [hwpx-cowork] Stored text resets cannot cut an object's physical
            // footprint. Object notes use the shared capacity/float-cut splitter
            // below, including the Hancom-resaved input route.
            let source_reset_fragments = (saved_note_layout
                && !note_measure.has_floating_objects(st, fn_ctrl))
                .then(|| native_hwp5_footnote_reset_fragments(fn_ctrl, self.dpi))
                .flatten();
            // [hwpx-cowork] 표시 쪽(완료 쪽)이 받아야 하는 높이는 각주 전체가 아니라, 각주 저장 줄이
            // 다음 쪽에서 다시 시작하면(`0 → 0`) 그 앞 조각뿐이다. 한/글 2022: 실문서A
            // 각주 18(3줄, 저장 vpos 0·0·1172)은 표시가 든 16쪽 각주 영역 맨 아래에 첫 줄, 17쪽에
            // 두 줄. 종전에는 전체 높이(3줄)로 견주어 완료 쪽에 자리가 없다고 보고 각주를 통째로
            // 다음 쪽에 놓아, 저장 줄 재시작 때문에 첫째·둘째 줄이 같은 높이에 겹쳤다.
            let tail_note_height = source_reset_fragments
                .filter(|split| saved_hwpx_tail && split.force_next_page)
                .map_or(fn_height, |split| split.prefix_height);
            // 이어지는 쪽에서 저장 reset 으로 끝낸 조각은 그 안 표시의 각주를 이미 계상해
            // 경계를 정했다(`stored_body_reset_fragment_matches_current_flow`). 그 각주는 표시
            // 쪽이 첫 각주 쪽이어도 그 쪽에 둔다(합성 `cont_reset_F20_L70_N4`).
            let stored_reset_fragment_route = crate::renderer::pagination::find_inline_control_target_page(
                &st.pages,
                &st.current_items,
                para_idx,
                ctrl_idx,
                para,
            )
            .filter(|(page_idx, col_idx)| {
                st.pages
                    .get(*page_idx)
                    .and_then(|page| page.column_contents.get(*col_idx))
                    .is_some_and(|column| {
                        column.items.iter().any(|item| {
                            matches!(item,
                                crate::renderer::pagination::PageItem::PartialParagraph {
                                    para_index, start_line, ..
                                } if *para_index == para_idx
                                    && st.stored_reset_note_fragments.contains(&(para_idx, *start_line)))
                        })
                    })
            });
            let multi_note_routed =
                if st.profile.hwp5_stored_pagination_layout() || saved_hwpx_tail {
                    crate::renderer::pagination::find_inline_control_target_page(
                        &st.pages,
                        &st.current_items,
                        para_idx,
                        ctrl_idx,
                        para,
                    )
                    .filter(|(page_idx, col_idx)| {
                        st.pages
                            .get(*page_idx)
                            .is_some_and(|page| !page.footnotes.is_empty())
                            && (!saved_hwpx_tail
                                || st.completed_body_fragment_note_fits(
                                    *page_idx,
                                    *col_idx,
                                    para_idx,
                                    tail_note_height,
                                ))
                    })
                } else {
                    None
                }
                .or(stored_reset_fragment_route);
            // marker 본문이 이미 두 physical page로 나뉜 경우, 각주 자체의
            // stored reset도 일대일이면 prefix는 marker page, suffix는 현재
            // tail page가 소유한다(p129 note 176). 표 셀용으로 검증된 같은
            // 보수적 판정을 재사용하되 Body tail과 기존 marker-page 각주를
            // 모두 확인해 일반 각주를 임의 capacity로 나누지 않는다.
            let stored_reset_fragments = body_tail_reset
                .filter(|_| {
                    multi_note_routed.is_some()
                        // 첫 각주 충돌 경로도 표시가 완료된 앞 조각 쪽에 속함을
                        // 입증한다. 독립적으로 유효성을 확인한 각주 재시작은
                        // 이에 대응하는 꼬리를 소유한다. 이 계약에는
                        // 기존 각주가 있을 필요가 없다.
                        || collision_routed.flatten().is_some()
                })
                .and(source_reset_fragments);
            // body marker와 문단은 현재 page에 끝났지만 각주 stored line이
            // `0 -> 0`으로 다시 시작하면 suffix의 물리 owner만 다음 page다
            // (p178 note 240). p30처럼 본문 자체가 이미 split된 두 줄 각주는
            // 기존 collision route가 맡는다.
            let current_page_reset_fragments = source_reset_fragments.filter(|split| {
                // 각주 내부 저장 재시작과 다음 본문 쪽 경계가 함께 확인되면,
                // 전체 각주 이월보다 저장된 앞/뒤 조각의 소속을 먼저 보존한다.
                (split.force_next_page || move_to_next_reset_page)
                    && body_tail_reset.is_none()
                    && native_hwp5_footnote_break.is_none()
                    && crate::renderer::pagination::find_inline_control_target_page(
                        &st.pages,
                        &st.current_items,
                        para_idx,
                        ctrl_idx,
                        para,
                    )
                    .is_none()
            });
            let fragments = native_hwp5_footnote_break
                .filter(|footnote_break| footnote_break.split_footnote)
                .and_then(|_| native_hwp5_two_line_footnote_fragments(fn_ctrl))
                .map(|(prefix, suffix)| NativeHwp5FootnoteFragmentSplit {
                    prefix_height: native_hwp5_footnote_fragment_height(fn_ctrl, prefix, self.dpi),
                    suffix_height: native_hwp5_footnote_fragment_height(fn_ctrl, suffix, self.dpi),
                    prefix,
                    suffix,
                    // 이 fallback은 두 줄 각주의 일반 분할이며,
                    // stored page-top reset을 판독한 경로가 아니다.
                    force_next_page: false,
                })
                .or(stored_reset_fragments);
            // 기존 각주가 있는 marker page의 마지막 prefix line에서 바로
            // body reset이 시작되고 각주 자체에는 fragment reset이 없으면,
            // 한컴은 새 각주 전체를 tail page로 보낸다(p131 note 180).
            // marker가 reset보다 더 앞선 일반 split과 내부 reset 각주는 각각
            // 기존 marker owner/fragment 경로를 유지한다.
            let whole_note_owned_by_tail_page = stored_reset_fragments.is_none()
                && multi_note_routed.is_some()
                && body_tail_reset.is_some_and(|(marker_line, reset_line)| {
                    marker_line + 1 == reset_line
                        && para.line_segs.get(marker_line).is_some_and(|line| {
                            hwpunit_to_px(
                                line.vertical_pos.saturating_add(line.line_height),
                                self.dpi,
                            ) >= st.layout.body_area.height * 0.90
                        })
                });
            // first-footnote collision은 기존에 `Some(None)` 자체도
            // “현재 page에 둔다”는 결정이었다. 그 결정을 multi-note
            // filter로 덮으면 p30 note 29가 tail p31에 떨어진다.
            let routed = if whole_note_owned_by_tail_page {
                None
            } else {
                match collision_routed {
                    Some(route) => route,
                    None => multi_note_routed,
                }
            };
            let fragment_routed_page = fragments.as_ref().and_then(|_| {
                collision_routed
                    .flatten()
                    .or(multi_note_routed)
                    .or_else(|| {
                        // reset 직전 줄 안의 marker라도 current item의 char 범위를
                        // 찾지 못하면 일반 라우터는 tail page를 가리킨다. 이 좁은
                        // HWP5 형상은 저장 reset 전 page가 첫 footnote line owner다.
                        st.pages.len().checked_sub(2).map(|page_idx| (page_idx, 0))
                    })
            });
            if let Some((page_idx, _)) = fragment_routed_page {
                if let Some(split) = fragments {
                    if st.pages.len() > page_idx + 1
                        && st.add_footnote_fragment_to_completed_page(
                            page_idx,
                            fn_ctrl.number,
                            source.clone(),
                            split.prefix,
                            split.prefix_height,
                        )
                    {
                        st.record_current_footnote(FootnoteRef {
                            column_index: 0,
                            number: fn_ctrl.number,
                            source: source.clone(),
                            fragment: Some(split.suffix),
                        });
                        st.add_footnote_fragment_height(
                            split.suffix_height,
                            split.suffix.draw_separator,
                        );
                        return;
                    }
                }
            }
            if let Some(split) = current_page_reset_fragments {
                st.record_current_footnote(FootnoteRef {
                    column_index: 0,
                    number: fn_ctrl.number,
                    source: source.clone(),
                    fragment: Some(split.prefix),
                });
                st.add_footnote_fragment_height(split.prefix_height, split.prefix.draw_separator);
                // 각주 사다리의 재시작은 각주만 다음 쪽에 소유시킨다.
                // 표시 뒤 본문은 현재 쪽의 남은 본문 상자를 계속 사용한다.
                st.defer_body_footnote_for_next_page(
                    FootnoteRef {
                        column_index: 0,
                        number: fn_ctrl.number,
                        source: source.clone(),
                        fragment: Some(split.suffix),
                    },
                    split.suffix_height,
                );
                return;
            }
            if let Some((page_idx, _)) = routed {
                if st.add_footnote_to_completed_page(
                    page_idx,
                    fn_ctrl.number,
                    source.clone(),
                    fn_height,
                ) {
                    return;
                }
            }
            // [hwpx-cowork] 저장 쪽 나눔을 따르지 않는 문서에서 표시 문단이 쪽을 넘었으면, 표시가 든 앞 쪽이
            // 각주 자리를 먼저 갖는다 — 문단을 놓을 때 `first_footnote_reserve_break_line` 이 비워 둔
            // 자리에 통째(들어가면) 또는 앞 몇 줄을 두고 나머지만 지금 쪽에 둔다(한/글 2022 회귀 F).
            if !st.profile.hwp5_stored_pagination_layout() && st.col_count == 1 {
                if let Some((page_idx, col_idx)) =
                    crate::renderer::pagination::find_inline_control_target_page(
                        &st.pages,
                        &st.current_items,
                        para_idx,
                        ctrl_idx,
                        para,
                    )
                {
                    let lines = super::boundary::footnote_line_metrics(fn_ctrl, self.dpi);
                    let total = lines.len();
                    let owned = (1..=total).rev().find(|&k| {
                        st.completed_body_fragment_note_fits(
                            page_idx,
                            col_idx,
                            para_idx,
                            if k == total {
                                fn_height
                            } else {
                                super::boundary::footnote_prefix_height(&lines, k)
                            },
                        )
                    });
                    if owned == Some(total)
                        && st.add_footnote_to_completed_page(
                            page_idx,
                            fn_ctrl.number,
                            source.clone(),
                            fn_height,
                        )
                    {
                        return;
                    }
                    if let Some(k) = owned.filter(|&k| k < total) {
                        let fragment = |start_line, end_line, draw_number| {
                            crate::renderer::pagination::FootnoteFragment {
                                start_line,
                                end_line,
                                draw_separator: true,
                                draw_number,
                                defer_floats_from: None,
                                carry_floats_from: None,
                                float_cut: None,
                            }
                        };
                        let suffix_height = footnote_suffix_height(&lines, k);
                        if st.add_footnote_fragment_to_completed_page(
                            page_idx,
                            fn_ctrl.number,
                            source.clone(),
                            fragment(0, k, true),
                            super::boundary::footnote_prefix_height(&lines, k),
                        ) {
                            st.record_current_footnote(FootnoteRef {
                                // [hwpx-cowork] Current/deferred registration resolves the owning column.
                                column_index: 0,
                                number: fn_ctrl.number,
                                source: source.clone(),
                                fragment: Some(fragment(k, total, false)),
                            });
                            st.add_footnote_fragment_height(suffix_height, true);
                            return;
                        }
                    }
                }
            }
            // [hwpx-cowork] 각주가 지금 쪽에 다 들어가지 않으면 한/글처럼 줄 단위로 나눠 들어가는
            // 줄까지 이 쪽에 두고 나머지는 다음 쪽 각주 영역으로 넘긴다(글자처럼 개체 줄·떠 있는
            // 개체를 가진 문단은 통째로 넘어간다). 한/글 2022 재저장본: 각주 줄 vpos 가 0 으로
            // 다시 시작하고 본문 뒤 문단은 남은 자리가 없을 때만 다음 쪽으로 간다.
            if !move_to_next_reset_page && !hwpx_note_overflows_current_page && st.col_count == 1 {
                // [hwpx-cowork] Split and whole-note measurement share the same
                // section/column/profile/normalization context and float plans.
                let engine = note_measure.configured_layout(st);
                let full = FootnoteRef {
                    // [hwpx-cowork] Current/deferred registration resolves the owning column.
                    column_index: 0,
                    number: fn_ctrl.number,
                    source: source.clone(),
                    fragment: None,
                };
                // [hwpx-cowork] 표시 문단이 이 쪽에서 끝나면 그 마지막 줄 뒤 줄간격·문단 아래 간격은 각주 영역과
                // 겹쳐도 된다 — 한/글 2022 회귀 F(채움 28, 한 줄 표시 문단이 쪽 끝 줄): 줄 바닥 62480HU 아래에
                // 각주 첫 줄(구분선 포함 2558HU)이 들어가 0쪽에 한 줄, 줄간격 880 까지 치면 들어가지 않는다.
                // 실문서A 각주 13(문단 아래 간격 6.7px)도 표시 쪽 바닥에 한 줄로 든다.
                let content_bottom = match st.current_items.last() {
                    Some(crate::renderer::pagination::PageItem::FullParagraph { para_index })
                        if *para_index == para_idx =>
                    {
                        st.footnote_host_content_bottom
                            .filter(|(host, _)| *host == para_idx)
                            .map(|(_, bottom)| bottom)
                    }
                    Some(crate::renderer::pagination::PageItem::PartialParagraph {
                        para_index,
                        end_line,
                        ..
                    }) if *para_index == para_idx && *end_line >= para.line_segs.len() => st
                        .paragraph_fragment_content_bottoms
                        .get(&(para_idx, *end_line))
                        .map(|bounds| bounds.content_bottom),
                    _ => None,
                }
                .filter(|bottom| *bottom <= st.current_height)
                .unwrap_or(st.current_height);
                let fits = |h: f64| {
                    st.footnote_fragment_fits_body_bottom(h, true, false, content_bottom, false)
                };
                let split = engine.split_footnote_for_capacity(
                    &full,
                    paragraphs,
                    styles,
                    st.layout.body_area.width,
                    &fits,
                );
                // [hwpx-cowork] Recorded only by the explicit decision query.
                if crate::renderer::layout_trace_log::enabled() {
                    crate::renderer::layout_trace_log::record(st.pages.len(), "bodyNoteCapacity",
                        st.current_height, st.current_height,
                        format!("content={fn_height} bottom={content_bottom} fits={} split={split:?}", fits(fn_height)),
                        std::panic::Location::caller());
                }
                if let Some((prefix, prefix_height, suffix, suffix_height)) = split {
                    st.record_current_footnote(FootnoteRef {
                        // [hwpx-cowork] Current/deferred registration resolves the owning column.
                        column_index: 0,
                        number: fn_ctrl.number,
                        source: source.clone(),
                        fragment: Some(prefix),
                    });
                    st.add_footnote_fragment_height(prefix_height, prefix.draw_separator);
                    st.defer_footnote_to_next_page(
                        FootnoteRef {
                            // [hwpx-cowork] Current/deferred registration resolves the owning column.
                            column_index: 0,
                            number: fn_ctrl.number,
                            source,
                            fragment: Some(suffix),
                        },
                        suffix_height,
                    );
                    return;
                }
                // [hwpx-cowork] 첫 줄조차 들어가지 않으면 표시는 이 쪽에 두고 각주를 통째로 다음 쪽
                // 각주 영역으로 넘긴다 — 한/글 2022 실문서A 각주 78(108쪽 끝 제목 문단의
                // 표시, 각주 8줄은 109쪽 79 위). 종전에는 이 쪽에 통째로 두어 본문 위에 겹쳤다.
                if !fits(fn_height)
                    && fn_ctrl.paragraphs.iter().all(|note_para| {
                        note_para
                            .controls
                            .iter()
                            .all(|control| matches!(control, Control::AutoNumber(_)))
                    })
                {
                    st.defer_footnote_to_next_page(full, fn_height);
                    return;
                }
            }
            if move_to_next_reset_page || hwpx_note_overflows_current_page {
                // marker/body는 방금 확정한 current page에 그대로 두고,
                // 다음 paragraph의 stored vpos reset이 시작하는 fresh page에
                // 이 단일 각주만 등록한다. p31 two-line fragment와 p43의
                // existing-note reset은 helper guard 밖이므로 영향이 없다.
                st.force_new_page();
                if hwpx_note_overflows_current_page {
                    st.mark_deferred_hwpx_note_body();
                }
            }
            st.record_current_footnote(FootnoteRef {
                column_index: 0,
                number: fn_ctrl.number,
                source,
                fragment: None,
            });
            st.add_footnote_height(fn_height);
        }
    }
}
