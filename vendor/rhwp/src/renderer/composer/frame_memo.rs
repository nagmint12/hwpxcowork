//! [hwpx-cowork] 문단 프레임 재구성(`recompose_stored_lines_in_frame…`) 결과의 기억(2026-11-19).
//!
//! 본문 문단의 줄은 같은 함수가 세 군데에서 다시 짠다 — 측정(`height_measurer`), 조판의 문단 구성
//! (`typeset::paragraph::format` — 그쪽은 구성 결과 전체를 따로 기억한다), 쪽 나무(`layout::paragraph_layout`).
//! 서식을 적용하거나 쪽을 나누면 측정이 구역의 모든 문단을 다시 짰고(59쪽 보고서에서 진하게 한 번에 31ms),
//! 편집으로 쪽이 밀리면 보이는 쪽의 문단을 그릴 때 또 다시 짰다(저장 줄 없는 글 문서는 쪽 나무 한 장 9ms 가운데 4ms).
//! 재구성은 문단 내용·구성·프레임 폭·문맥의 함수이므로 그 입력을 열쇠로 기억한다(`renderer::layout_memo`).
//! 측정과 쪽 나무는 같은 열쇠 꼴을 쓰므로 입력이 같으면 서로의 결과를 쓴다.
//!
//! 열쇠를 만들 수 없는 문단(개체·누름틀·쪽 번호 같은 문단 밖 상태를 읽는 것)은 늘 새로 계산한다.
//! 스타일 값·글꼴 측정 환경이 바뀌면 문서가 통째로 비운다(`DocumentCore::invalidate_layout_memos`).

use super::cell_compose_memo::{
    composed_digest, composed_payload_bytes, paragraph_fingerprint, FingerprintScope,
};
use super::ComposedParagraph;
use crate::model::paragraph::Paragraph;
use crate::model::provenance::StoredGeometryPolicy;
use crate::renderer::float_placement::FloatCarveEvidence;
use crate::renderer::layout_memo::{ContentMemo, MemoKey};
use crate::renderer::style_resolver::ResolvedStyleSet;

/// 문서가 쥐는 프레임 재구성 기억. 값은 재구성 결과(`None` = 다시 짜지 않고 원래 구성을 쓴다).
pub(crate) type FrameMemo = ContentMemo<Option<ComposedParagraph>>;

const KIND_FRAME: u8 = 4;

/// 프레임 재구성의 열쇠. 재구성이 읽는 입력을 모두 담는다:
/// 문단 내용(지문) · 구성(요약 지문 — 문단 모양 번호 포함) · 프레임 폭 · 문맥(dpi·저장 줄 정책·
/// 용지/쪽 기준 어울림 증거·구역 기본 탭 폭) · 세 표지(어울림 밴드·HWPX 저장 조판·구역의 합성 사다리).
/// 문단 상자와 안쪽 폭은 프레임 폭과 문단 모양에서 나오므로(`ParagraphBox::body_for_style`) 따로 넣지 않는다 —
/// 이 열쇠를 쓰는 호출부는 상자와 안쪽 폭을 그렇게 만들어야 한다. 실측 인라인 표 높이를 넘기는 호출은 기억하지 않는다.
/// 스타일과 글꼴 측정 환경은 열쇠에 없다 — 바뀌면 문서가 기억을 통째로 비운다.
#[allow(clippy::too_many_arguments)]
pub(crate) fn key(
    para: &Paragraph,
    composed: &ComposedParagraph,
    styles: &ResolvedStyleSet,
    frame_width_px: f64,
    dpi: f64,
    policy: StoredGeometryPolicy,
    float_carve_evidence: &[FloatCarveEvidence],
    known_square_band: bool,
    hwpx_stored_layout: bool,
    stored_rows_untrusted: bool,
) -> Option<MemoKey> {
    use std::hash::{Hash, Hasher};
    if !frame_width_px.is_finite() {
        return None;
    }
    // 합성 줄만 가진 문단은 줄을 비운 사본으로 다시 짜므로(`fresh_body`) 세로 좌표가 결과에 쓰이지 않는다 —
    // 조판의 문단 구성과 같은 지문 범위를 쓴다.
    let content = paragraph_fingerprint(para, FingerprintScope::FlowFormat)?;
    // 필드를 `..` 없이 풀어 쓴다 — 정책에 필드가 늘면 여기서 컴파일이 멈춘다.
    let StoredGeometryPolicy {
        preserve_hwp3_origins,
        requires_realign,
        hwpx_cell_geometry,
        stored_rows_before_hancom_2020,
    } = policy;
    let mut context = std::collections::hash_map::DefaultHasher::new();
    dpi.to_bits().hash(&mut context);
    styles.section_tab_key().hash(&mut context);
    float_carve_evidence.len().hash(&mut context);
    for item in float_carve_evidence {
        let FloatCarveEvidence { width, vertical } = item;
        (*width, vertical.start, vertical.end).hash(&mut context);
    }
    Some(MemoKey {
        kind: KIND_FRAME,
        content,
        a: composed_digest(composed),
        b: frame_width_px.to_bits(),
        c: context.finish(),
        flags: u32::from(preserve_hwp3_origins)
            | u32::from(requires_realign) << 1
            | u32::from(hwpx_cell_geometry) << 2
            | u32::from(stored_rows_before_hancom_2020) << 3
            | u32::from(known_square_band) << 4
            | u32::from(hwpx_stored_layout) << 5
            | u32::from(stored_rows_untrusted) << 6,
    })
}

/// 기억을 거쳐 재구성한다. 기억이 없거나 꺼져 있으면 `compute` 를 그대로 부른다(열쇠도 만들지 않는다).
pub(crate) fn recompose<E>(
    memo: Option<&FrameMemo>,
    key: impl FnOnce() -> Option<MemoKey>,
    para: &Paragraph,
    compute: impl FnOnce() -> Result<Option<ComposedParagraph>, E>,
) -> Result<Option<ComposedParagraph>, E> {
    let Some(memo) = memo.filter(|memo| memo.enabled()) else {
        return compute();
    };
    memo.get_or_compute(
        key(),
        |value| match value {
            None => Some(std::mem::size_of::<(MemoKey, Option<ComposedParagraph>)>()),
            Some(composed) => composed_payload_bytes(composed),
        },
        |found, fresh| format!("{found:?}") == format!("{fresh:?}"),
        || {
            format!(
                "frame: {:?}",
                para.text.chars().take(24).collect::<String>()
            )
        },
        compute,
    )
}

#[cfg(test)]
mod tests {
    //! 계약 시험(합성 입력): 열쇠가 재구성의 입력을 가르는지, 기억이 없으면 그대로 계산하는지 본다.
    //! 조판 좌표는 다루지 않는다(쪽 나무가 기억 없이 한 것과 같은지는 `typeset::paragraph::format_memo` 의 시험이 본다).
    use super::*;
    use crate::model::paragraph::{LineSeg, NumberingMarker};

    fn para(text: &str) -> Paragraph {
        Paragraph {
            text: text.to_string(),
            char_count: text.chars().count() as u32,
            numbering_marker: NumberingMarker::Absent,
            line_segs: vec![LineSeg {
                line_height: 1000,
                text_height: 1000,
                line_spacing: 600,
                tag: LineSeg::TAG_IMPLEMENTATION_PROPERTY,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn key_separates_width_flags_policy_and_evidence() {
        let styles = ResolvedStyleSet::default();
        let p = para("가나다라");
        let composed = crate::renderer::composer::compose_paragraph_in_context(&p, &styles);
        let policy = StoredGeometryPolicy::default();
        let make = |width: f64,
                    band: bool,
                    hwpx: bool,
                    untrusted: bool,
                    evidence: &[FloatCarveEvidence]| {
            key(
                &p, &composed, &styles, width, 96.0, policy, evidence, band, hwpx, untrusted,
            )
        };
        let base = make(600.0, false, false, false, &[]).expect("plain paragraph");
        assert_eq!(make(600.0, false, false, false, &[]), Some(base));
        assert_ne!(
            make(601.0, false, false, false, &[]),
            Some(base),
            "프레임 폭"
        );
        assert_ne!(
            make(600.0, true, false, false, &[]),
            Some(base),
            "어울림 밴드"
        );
        assert_ne!(
            make(600.0, false, true, false, &[]),
            Some(base),
            "HWPX 저장 조판"
        );
        assert_ne!(
            make(600.0, false, false, true, &[]),
            Some(base),
            "구역의 합성 사다리"
        );
        let evidence = [FloatCarveEvidence {
            width: 100,
            vertical: 0..10,
        }];
        assert_ne!(
            make(600.0, false, false, false, &evidence),
            Some(base),
            "어울림 증거"
        );
        let mut other_policy = policy;
        other_policy.requires_realign = !other_policy.requires_realign;
        assert_ne!(
            key(
                &p,
                &composed,
                &styles,
                600.0,
                96.0,
                other_policy,
                &[],
                false,
                false,
                false
            ),
            Some(base),
            "저장 줄 정책"
        );
        assert_ne!(
            key(
                &p,
                &composed,
                &styles,
                600.0,
                120.0,
                policy,
                &[],
                false,
                false,
                false
            ),
            Some(base),
            "dpi"
        );
        assert!(make(f64::INFINITY, false, false, false, &[]).is_none());
        let mut with_control = p.clone();
        with_control
            .controls
            .push(crate::model::control::Control::Table(Box::default()));
        assert!(
            key(
                &with_control,
                &composed,
                &styles,
                600.0,
                96.0,
                policy,
                &[],
                false,
                false,
                false
            )
            .is_none(),
            "개체가 있는 문단은 기억하지 않는다"
        );
    }

    #[test]
    fn recompose_uses_the_memo_once_per_key_and_computes_directly_without_it() {
        let styles = ResolvedStyleSet::default();
        let p = para("가나다라");
        let composed = crate::renderer::composer::compose_paragraph_in_context(&p, &styles);
        let policy = StoredGeometryPolicy::default();
        let memo = FrameMemo::default();
        let calls = std::cell::Cell::new(0);
        let run = |memo: Option<&FrameMemo>| {
            recompose::<std::convert::Infallible>(
                memo,
                || {
                    key(
                        &p,
                        &composed,
                        &styles,
                        600.0,
                        96.0,
                        policy,
                        &[],
                        false,
                        false,
                        false,
                    )
                },
                &p,
                || {
                    calls.set(calls.get() + 1);
                    Ok(Some(composed.clone()))
                },
            )
            .unwrap()
        };
        let first = run(Some(&memo));
        let second = run(Some(&memo));
        assert_eq!(calls.get(), 1, "같은 열쇠는 한 번만 계산한다");
        assert_eq!(format!("{first:?}"), format!("{second:?}"));
        run(None);
        assert_eq!(calls.get(), 2, "기억이 없으면 그대로 계산한다");
        memo.set_enabled(false);
        run(Some(&memo));
        assert_eq!(calls.get(), 3, "꺼 둔 기억은 쓰지 않는다");
    }
}
