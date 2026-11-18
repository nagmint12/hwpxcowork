//! [hwpx-cowork] 문단 구성(`format`) 결과의 기억 — 열쇠와 보관 꼴(2026-11-19).
//!
//! 쪽 나눔은 구역의 모든 문단을 `format_paragraph_for_flow` 로 다시 구성했다. 저장 줄이 없는 문단은 그때마다
//! 줄을 새로 나누고(글자 폭 측정), 저장 줄이 있는 문단도 줄이 낡았는지 다시 쟀다 — 한 글자 편집의 쪽 나눔이
//! 구역 전체 글의 양에 비례했다(저장 줄 없는 8쪽 글 문서 73ms 중 69ms, 59쪽 보고서 154ms 중 63ms).
//! 구성 결과는 문단 내용·구성(`ComposedParagraph`)·단 폭·조판 문맥의 함수이므로 그 입력을 열쇠로 기억한다
//! (`renderer::layout_memo`). 열쇠를 만들 수 없는 문단(개체·누름틀 등)과 보관 꼴에 담지 못하는 결과는 늘 새로 계산한다.

use crate::model::paragraph::{LineSeg, Paragraph};
use crate::renderer::composer::cell_compose_memo::{
    composed_digest, composed_payload_bytes, paragraph_fingerprint, FingerprintScope,
};
use crate::renderer::composer::ComposedParagraph;
use crate::renderer::layout_memo::{stamp, ContentMemo, MemoKey};
use crate::renderer::style_resolver::ResolvedStyleSet;

use super::context::ParagraphFormatContext;
use super::metrics::FormattedParagraph;

/// 문서가 쥐는 문단 구성 기억.
pub(crate) type ParagraphFormatMemo = ContentMemo<StoredFormat>;

const KIND_PARAGRAPH_FORMAT: u8 = 1;

/// 기억에 넣는 문단 구성 결과. 개체 없는 글 문단의 결과만 담는다 — 표·어울림 host 가 쓰는 필드
/// (`tail_line_remaining_width`·`computed_host_lines`·`host_composition`·`square_host_plan`)가 있으면 넣지 않는다.
#[derive(Clone, Debug)]
pub(crate) struct StoredFormat {
    stored_ladder_is_filler: bool,
    exact_reflow_text_box: bool,
    computed_paragraph: Option<ComposedParagraph>,
    total_height: f64,
    line_heights: Vec<f64>,
    line_spacings: Vec<f64>,
    spacing_before: f64,
    spacing_after: f64,
    height_for_fit: f64,
    tac_outer_margin_v_px: f64,
}

impl StoredFormat {
    /// 보관 꼴과 그 크기. 담지 못하는 결과면 `None`.
    pub(in crate::renderer::typeset) fn from_formatted(
        formatted: &FormattedParagraph,
    ) -> Option<(Self, usize)> {
        // 필드를 `..` 없이 풀어 쓴다 — 결과에 필드가 늘면 여기서 컴파일이 멈춘다.
        let FormattedParagraph {
            stored_ladder_is_filler,
            exact_reflow_text_box,
            computed_paragraph,
            tail_line_remaining_width,
            computed_host_lines,
            host_composition,
            square_host_plan,
            total_height,
            line_heights,
            line_spacings,
            spacing_before,
            spacing_after,
            height_for_fit,
            tac_outer_margin_v_px,
        } = formatted;
        if tail_line_remaining_width.is_some()
            || computed_host_lines.is_some()
            || host_composition.is_some()
            || square_host_plan.is_some()
        {
            return None;
        }
        let mut bytes = std::mem::size_of::<(MemoKey, Self)>()
            + std::mem::size_of_val(line_heights.as_slice())
            + std::mem::size_of_val(line_spacings.as_slice());
        if let Some(composed) = computed_paragraph {
            bytes += composed_payload_bytes(composed)?;
        }
        Some((
            Self {
                stored_ladder_is_filler: *stored_ladder_is_filler,
                exact_reflow_text_box: *exact_reflow_text_box,
                computed_paragraph: computed_paragraph.clone(),
                total_height: *total_height,
                line_heights: line_heights.clone(),
                line_spacings: line_spacings.clone(),
                spacing_before: *spacing_before,
                spacing_after: *spacing_after,
                height_for_fit: *height_for_fit,
                tac_outer_margin_v_px: *tac_outer_margin_v_px,
            },
            bytes,
        ))
    }

    pub(in crate::renderer::typeset) fn into_formatted(self) -> FormattedParagraph {
        FormattedParagraph {
            stored_ladder_is_filler: self.stored_ladder_is_filler,
            exact_reflow_text_box: self.exact_reflow_text_box,
            computed_paragraph: self.computed_paragraph,
            tail_line_remaining_width: None,
            computed_host_lines: None,
            host_composition: None,
            square_host_plan: None,
            total_height: self.total_height,
            line_heights: self.line_heights,
            line_spacings: self.line_spacings,
            spacing_before: self.spacing_before,
            spacing_after: self.spacing_after,
            height_for_fit: self.height_for_fit,
            tac_outer_margin_v_px: self.tac_outer_margin_v_px,
        }
    }
}

/// 문단 구성의 열쇠. 구성 결과가 읽는 입력을 모두 담는다:
/// 문단 내용(지문) · 구성(요약 지문) · 단 폭 · 두 흐름 표지 · 조판 문맥(dpi·호환 정책·구역의 합성 사다리 여부·
/// 용지/쪽 기준 어울림 증거·구역 기본 탭 폭·뒤 문단의 첫 저장 줄 좌표).
/// 스타일과 글꼴 측정 환경은 열쇠에 없다 — 바뀌면 문서가 기억을 통째로 비운다.
pub(in crate::renderer::typeset) fn key(
    ctx: &ParagraphFormatContext<'_>,
    para: &Paragraph,
    composed: Option<&ComposedParagraph>,
    styles: &ResolvedStyleSet,
    column_width_px: Option<f64>,
    hwp3_body_reflow: bool,
    known_square_band: bool,
) -> Option<MemoKey> {
    if column_width_px.is_some_and(|width| !width.is_finite()) {
        return None;
    }
    let content = paragraph_fingerprint(para, FingerprintScope::FlowFormat)?;
    // 뒤 문단의 첫 저장 줄 좌표는 원본 한 줄(합성 표시 없음)짜리 문단의 구성만 읽는다(`format` 의
    // `stored_ladder_advances_anchor_line`). 그 밖의 문단에서는 열쇠에 넣지 않아, 앞 편집으로 뒤 문단의
    // 좌표만 밀린 경우에도 같은 결과를 찾는다.
    let next_stored_vpos = match para.line_segs.as_slice() {
        [line] if line.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0 => ctx.next_stored_vpos(),
        _ => None,
    };
    let evidence = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let evidence = ctx.float_carve_evidence();
        evidence.len().hash(&mut hasher);
        for item in evidence.iter() {
            let crate::renderer::float_placement::FloatCarveEvidence { width, vertical } = item;
            (*width, vertical.start, vertical.end).hash(&mut hasher);
        }
        hasher.finish()
    };
    let context = stamp(&(
        ctx.dpi().to_bits(),
        ctx.profile().memo_stamp(),
        ctx.uniform_filler_ladder(),
        evidence,
        styles.section_tab_key(),
        next_stored_vpos,
    ));
    Some(MemoKey {
        kind: KIND_PARAGRAPH_FORMAT,
        content,
        a: composed.map_or(0, composed_digest),
        b: column_width_px.map_or(0, f64::to_bits),
        c: context,
        flags: u32::from(hwp3_body_reflow)
            | u32::from(known_square_band) << 1
            | u32::from(column_width_px.is_some()) << 2
            | u32::from(composed.is_some()) << 3,
    })
}

#[cfg(test)]
mod tests {
    //! 계약 시험(합성 입력): 열쇠가 문단 구성의 입력을 가르는지, 합성 줄의 세로 좌표만 밀린 문단은 같은 열쇠인지,
    //! 기억을 쓴 쪽 나눔이 기억 없이 한 쪽 나눔과 같은 쪽 나무를 내는지 본다. 한/글 조판 좌표는 다루지 않는다.
    use super::*;
    use crate::model::paragraph::NumberingMarker;
    use crate::model::provenance::LayoutCompatibilityProfile;
    use crate::renderer::float_placement::FloatCarveEvidence;
    use std::cell::{Cell, RefCell};

    fn para(text: &str, segs: &[(i32, u32)]) -> Paragraph {
        Paragraph {
            text: text.to_string(),
            char_count: text.chars().count() as u32,
            numbering_marker: NumberingMarker::Absent,
            line_segs: segs
                .iter()
                .map(|(vertical_pos, tag)| LineSeg {
                    vertical_pos: *vertical_pos,
                    line_height: 1000,
                    text_height: 1000,
                    line_spacing: 600,
                    tag: *tag,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    struct Env {
        profile: Cell<LayoutCompatibilityProfile>,
        ladder: Cell<bool>,
        evidence: RefCell<Vec<FloatCarveEvidence>>,
        styles: ResolvedStyleSet,
    }

    impl Env {
        fn new() -> Self {
            Self {
                profile: Cell::new(Default::default()),
                ladder: Cell::new(false),
                evidence: RefCell::new(Vec::new()),
                styles: ResolvedStyleSet::default(),
            }
        }

        fn key(&self, p: &Paragraph, width: f64, next: Option<i32>, band: bool) -> Option<MemoKey> {
            let ctx = ParagraphFormatContext::new(
                96.0,
                &self.profile,
                &self.ladder,
                &self.evidence,
                next,
            );
            key(&ctx, p, None, &self.styles, Some(width), false, band)
        }
    }

    const SYNTHETIC: u32 = LineSeg::TAG_IMPLEMENTATION_PROPERTY;

    #[test]
    fn key_separates_every_input_of_the_format() {
        let env = Env::new();
        let base = para("가나다라", &[(0, SYNTHETIC), (1600, SYNTHETIC)]);
        let k = env.key(&base, 600.0, None, false).expect("plain paragraph");
        assert_eq!(
            env.key(
                &para("가나다라", &[(0, SYNTHETIC), (1600, SYNTHETIC)]),
                600.0,
                None,
                false
            ),
            Some(k),
            "주소가 달라도 내용이 같으면 같은 열쇠"
        );
        assert_ne!(
            env.key(
                &para("가나다마", &[(0, SYNTHETIC), (1600, SYNTHETIC)]),
                600.0,
                None,
                false
            ),
            Some(k),
            "글"
        );
        assert_ne!(env.key(&base, 601.0, None, false), Some(k), "단 폭");
        assert_ne!(
            env.key(&base, 600.0, None, true),
            Some(k),
            "어울림 밴드 표지"
        );
        let mut styled = base.clone();
        styled.para_shape_id = 3;
        assert_ne!(env.key(&styled, 600.0, None, false), Some(k), "문단 모양");
        // 조판 문맥
        env.ladder.set(true);
        assert_ne!(
            env.key(&base, 600.0, None, false),
            Some(k),
            "구역의 합성 사다리 여부"
        );
        env.ladder.set(false);
        env.evidence.borrow_mut().push(FloatCarveEvidence {
            width: 100,
            vertical: 0..10,
        });
        assert_ne!(
            env.key(&base, 600.0, None, false),
            Some(k),
            "용지/쪽 기준 어울림 증거"
        );
        env.evidence.borrow_mut().clear();
        {
            let _tabs = env.styles.section_tab_scope(4000, 96.0);
            assert_ne!(
                env.key(&base, 600.0, None, false),
                Some(k),
                "구역 기본 탭 폭"
            );
        }
        assert_eq!(env.key(&base, 600.0, None, false), Some(k));
        // 구성(ComposedParagraph)이 다르면 다른 열쇠
        let ctx = ParagraphFormatContext::new(96.0, &env.profile, &env.ladder, &env.evidence, None);
        let composed = crate::renderer::composer::compose_paragraph_in_context(&base, &env.styles);
        let with_composed = key(
            &ctx,
            &base,
            Some(&composed),
            &env.styles,
            Some(600.0),
            false,
            false,
        );
        assert_ne!(with_composed, Some(k));
        let mut other = composed.clone();
        other.para_style_id = other.para_style_id.wrapping_add(1);
        assert_ne!(
            key(
                &ctx,
                &base,
                Some(&other),
                &env.styles,
                Some(600.0),
                false,
                false
            ),
            with_composed
        );
    }

    #[test]
    fn layout_only_lines_ignore_a_uniform_vertical_shift_but_stored_lines_do_not() {
        let env = Env::new();
        // 합성 줄만 가진 문단: 앞 문단이 늘어 좌표가 통째로 밀려도 같은 열쇠, 줄 사이가 달라지면 다른 열쇠
        let synthetic = para("가나다라", &[(0, SYNTHETIC), (1600, SYNTHETIC)]);
        let shifted = para("가나다라", &[(4800, SYNTHETIC), (6400, SYNTHETIC)]);
        let stretched = para("가나다라", &[(0, SYNTHETIC), (1700, SYNTHETIC)]);
        let k = env.key(&synthetic, 600.0, None, false);
        assert!(k.is_some());
        assert_eq!(env.key(&shifted, 600.0, None, false), k);
        assert_ne!(env.key(&stretched, 600.0, None, false), k);
        // 뒤 문단의 좌표도 열쇠에 넣지 않는다(합성 줄 문단의 구성은 읽지 않는다)
        assert_eq!(env.key(&synthetic, 600.0, Some(9999), false), k);
        // 원본 줄(한/글이 저장한 줄)은 좌표가 근거다 — 밀리면 다른 열쇠
        let stored = para("가나다라", &[(0, 0), (1600, 0)]);
        let stored_shifted = para("가나다라", &[(4800, 0), (6400, 0)]);
        assert_ne!(
            env.key(&stored, 600.0, None, false),
            env.key(&stored_shifted, 600.0, None, false)
        );
        assert_ne!(
            env.key(&stored, 600.0, None, false),
            k,
            "합성 줄과 원본 줄은 섞이지 않는다"
        );
        // 원본 줄 나눔에 합성 표시만 붙은 문단(끼운 문단 뒤 복원 구간)도 좌표를 그대로 넣는다
        let mut restored = synthetic.clone();
        restored.layout_source_text_partition = true;
        let mut restored_shifted = shifted.clone();
        restored_shifted.layout_source_text_partition = true;
        assert_ne!(
            env.key(&restored, 600.0, None, false),
            env.key(&restored_shifted, 600.0, None, false)
        );
        // 원본 한 줄짜리 문단만 뒤 문단의 첫 저장 줄 좌표를 읽는다
        let single = para("가", &[(0, 0)]);
        assert_ne!(
            env.key(&single, 600.0, Some(1600), false),
            env.key(&single, 600.0, Some(1700), false)
        );
    }

    #[test]
    fn paragraphs_reading_outside_state_have_no_key_and_flow_scope_admits_tabs_and_markers() {
        let env = Env::new();
        let mut with_control = para("가나다", &[]);
        with_control
            .controls
            .push(crate::model::control::Control::Table(Box::default()));
        assert!(env.key(&with_control, 600.0, None, false).is_none());
        let mut with_field_value = para("가나다", &[]);
        with_field_value
            .layout_field_values
            .push((0, "3".to_string()));
        assert!(env.key(&with_field_value, 600.0, None, false).is_none());
        let mut unresolved = para("가나다", &[]);
        unresolved.numbering_marker = NumberingMarker::Unresolved;
        assert!(
            env.key(&unresolved, 600.0, None, false).is_none(),
            "번호를 아직 정하지 않은 문단"
        );
        // 탭·번호 머리는 값으로 넣는다(칸 문단 줄 구성 지문은 거절한다)
        let with_tab = para("가\t나", &[]);
        let mut numbered = para("가나다", &[]);
        numbered.numbering_marker = NumberingMarker::Text("1.".to_string(), Default::default());
        let mut renumbered = para("가나다", &[]);
        renumbered.numbering_marker = NumberingMarker::Text("2.".to_string(), Default::default());
        assert!(env.key(&with_tab, 600.0, None, false).is_some());
        assert!(env.key(&numbered, 600.0, None, false).is_some());
        assert_ne!(
            env.key(&numbered, 600.0, None, false),
            env.key(&renumbered, 600.0, None, false),
            "번호 글"
        );
        assert_ne!(
            env.key(&numbered, 600.0, None, false),
            env.key(&para("가나다", &[]), 600.0, None, false)
        );
        for p in [&with_tab, &numbered] {
            assert!(paragraph_fingerprint(p, FingerprintScope::Cell).is_none());
            assert!(paragraph_fingerprint(p, FingerprintScope::FlowExact).is_some());
        }
        assert!(env
            .key(&para("가나다", &[]), f64::NAN, None, false)
            .is_none());
    }

    #[test]
    fn stored_form_round_trips_and_rejects_host_results() {
        let formatted = FormattedParagraph {
            stored_ladder_is_filler: true,
            exact_reflow_text_box: true,
            computed_paragraph: None,
            tail_line_remaining_width: None,
            computed_host_lines: None,
            host_composition: None,
            square_host_plan: None,
            total_height: 40.0,
            line_heights: vec![13.0, 13.0],
            line_spacings: vec![8.0, 6.0],
            spacing_before: 1.0,
            spacing_after: 2.0,
            height_for_fit: 32.0,
            tac_outer_margin_v_px: 0.5,
        };
        let (stored, bytes) = StoredFormat::from_formatted(&formatted).expect("plain result");
        assert!(bytes >= std::mem::size_of::<StoredFormat>());
        assert_eq!(
            format!("{:?}", stored.into_formatted()),
            format!("{formatted:?}")
        );
        let mut host = formatted.clone();
        host.tail_line_remaining_width = Some(3.0);
        assert!(StoredFormat::from_formatted(&host).is_none());
        let mut lines = formatted.clone();
        lines.computed_host_lines = Some(Vec::new());
        assert!(StoredFormat::from_formatted(&lines).is_none());
    }

    /// 저장 줄 없이 열린 문서처럼 만든다 — 줄 정보에 합성 표시를 붙인다(로더가 저장 줄 없는 문서에 하는 일).
    /// 서버가 내보낸 HWPX 는 줄 정보가 없어 편집기에서 늘 이 상태로 열리고, 그 문서에서 고친 문단의 줄도 합성 표시를
    /// 잇는다. 빈 문서에 새로 친 글은 원본 줄처럼 표시가 없어 앞이 밀리면 저장 좌표가 달라진다(그 문단은 새로 계산한다).
    fn mark_lines_as_layout_only(core: &mut crate::document_core::DocumentCore) {
        for paragraph in &mut core.document.sections[0].paragraphs {
            for line in &mut paragraph.line_segs {
                line.tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            }
        }
        core.rebuild_derived_state();
    }

    /// 문단 60개 문서에서 앞 문단을 여러 줄 늘리고 문단을 나누고 합쳐 뒤 문단을 모두 민다 — 기억을 켠 문서와 끈
    /// 문서의 쪽 나무가 같고, 켠 문서는 바뀌지 않은 문단의 구성을 다시 계산하지 않는다.
    #[test]
    fn pagination_with_the_memo_matches_pagination_without_it_after_a_shift() {
        let build = |memo: bool| {
            let mut core = crate::document_core::DocumentCore::new_empty();
            core.create_blank_document_native().unwrap();
            core.paragraph_format_memo.set_enabled(memo);
            core.stored_rows_memo.set_enabled(memo);
            core.measure_frame_memo.set_enabled(memo);
            for index in 0..60 {
                let text = format!("문단 {index} 가나다라마바사아자차카타파하 abcdefg 0123456789 ")
                    .repeat(1 + index % 4);
                core.insert_text_native(0, index, 0, &text).unwrap();
                core.split_paragraph_native(0, index, text.chars().count(), None)
                    .unwrap();
            }
            mark_lines_as_layout_only(&mut core);
            let before = core.paragraph_format_memo.stats();
            core.insert_text_native(0, 0, 0, &"앞 문단이 늘어난다 ".repeat(40))
                .unwrap();
            core.split_paragraph_native(0, 2, 3, None).unwrap();
            core.merge_paragraph_native(0, 5).unwrap();
            let after = core.paragraph_format_memo.stats();
            (core, after.hits - before.hits, after.misses - before.misses)
        };
        let (with, hits, misses) = build(true);
        let (without, off_hits, _) = build(false);
        assert_eq!(off_hits, 0);
        assert!(
            with.page_count() >= 2,
            "여러 쪽이어야 밀림을 본다: {}",
            with.page_count()
        );
        assert_eq!(with.page_count(), without.page_count());
        for page in 0..with.page_count() {
            assert_eq!(
                format!("{:?}", with.build_page_tree(page).unwrap().root),
                format!("{:?}", without.build_page_tree(page).unwrap().root),
                "page {page}"
            );
        }
        assert!(
            hits > 100 && hits > misses * 3,
            "세 번의 구조 편집에서 바뀌지 않은 문단은 기억을 쓴다: hits={hits} misses={misses}"
        );
        // 검증 모드: 찾은 결과마다 새로 계산해 견줘도 다른 것이 없다
        let (mut verified, _, _) = build(true);
        verified.paragraph_format_memo.set_verify(true);
        verified.stored_rows_memo.set_verify(true);
        verified
            .insert_text_native(0, 1, 0, &"한 번 더 민다 ".repeat(30))
            .unwrap();
        let stats = verified.paragraph_format_memo.stats();
        assert!(stats.verify_checks > 30, "{stats:?}");
        assert_eq!(stats.verify_mismatches, 0, "{:?}", stats.first_mismatch);
        assert_eq!(verified.stored_rows_memo.stats().verify_mismatches, 0);
    }

    /// 진하게·줄 간격을 새로 적용하면 모양 표 끝에 새 번호가 붙을 뿐이다 — 기억은 남고(바뀐 문단만 새로 계산),
    /// 결과는 기억 없이 한 쪽 나눔과 같다. 검증 모드로 찾은 결과마다 견줘도 다른 것이 없다.
    #[test]
    fn applying_a_new_shape_keeps_the_memo_and_matches_pagination_without_it() {
        let build = |memo: bool, verify: bool| {
            let mut core = crate::document_core::DocumentCore::new_empty();
            core.create_blank_document_native().unwrap();
            core.paragraph_format_memo.set_enabled(memo);
            core.stored_rows_memo.set_enabled(memo);
            core.measure_frame_memo.set_enabled(memo);
            for index in 0..40 {
                let text = format!("문단 {index} 가나다라마바사아자차카타파하 abcdefg 0123456789 ")
                    .repeat(1 + index % 3);
                core.insert_text_native(0, index, 0, &text).unwrap();
                core.split_paragraph_native(0, index, text.chars().count(), None)
                    .unwrap();
            }
            mark_lines_as_layout_only(&mut core);
            core.paragraph_format_memo.set_verify(verify);
            core.stored_rows_memo.set_verify(verify);
            core.measure_frame_memo.set_verify(verify);
            let before = core.paragraph_format_memo.stats();
            core.apply_char_format_native(0, 3, 0, 4, r#"{"bold":true}"#)
                .unwrap();
            core.apply_para_format_native(0, 7, r#"{"lineSpacing":200}"#)
                .unwrap();
            let after = core.paragraph_format_memo.stats();
            (core, before, after)
        };
        let (with, before, after) = build(true, false);
        let (without, _, _) = build(false, false);
        assert_eq!(with.page_count(), without.page_count());
        for page in 0..with.page_count() {
            assert_eq!(
                format!("{:?}", with.build_page_tree(page).unwrap().root),
                format!("{:?}", without.build_page_tree(page).unwrap().root),
                "page {page}"
            );
        }
        assert!(
            after.entries >= before.entries && after.entries > 20,
            "서식 적용이 기억을 비우지 않는다: {before:?} → {after:?}"
        );
        assert!(
            after.hits - before.hits > 60,
            "바뀌지 않은 문단은 기억을 쓴다: {before:?} → {after:?}"
        );
        // 서식 적용은 구역을 통째로 다시 잰다 — 바뀌지 않은 문단의 프레임 재구성은 측정 기억에서 찾는다.
        let frame = with.measure_frame_memo.stats();
        assert!(frame.hits > 40, "측정의 프레임 재구성 기억: {frame:?}");
        assert_eq!(without.measure_frame_memo.stats().hits, 0);
        let (verified, _, checked) = build(true, true);
        assert!(checked.verify_checks > 60, "{checked:?}");
        assert_eq!(checked.verify_mismatches, 0, "{:?}", checked.first_mismatch);
        assert_eq!(verified.stored_rows_memo.stats().verify_mismatches, 0);
        let frame = verified.measure_frame_memo.stats();
        assert!(frame.verify_checks > 40, "{frame:?}");
        assert_eq!(frame.verify_mismatches, 0, "{:?}", frame.first_mismatch);
    }
}
