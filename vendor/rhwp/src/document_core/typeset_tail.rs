//! [hwpx-cowork] 2026-11-20 뒤쪽 미루기 — 편집한 쪽 근처까지만 바로 조판하고 나머지는 쉬는 동안 마무리한다.
//!
//! 편집 한 번의 쪽 나눔은 체크포인트(`renderer::typeset::section::checkpoints`) 덕에 편집한 자리 앞의 쪽부터
//! 하지만, 그 뒤 구역 끝까지는 그 자리에서 다 했다. 앞쪽에서 Enter 를 치면 뒤 80쪽을 다 조판한 뒤에야 입력이
//! 돌아왔다. 편집기가 켜면(`set_typeset_tail_deferral`) 구역 조판이 편집한 쪽 뒤 두 쪽까지 하고, 그 뒤 지난 조판의
//! 쪽 시작과 새 조판의 쪽 시작이 같은 경계에서 멈춰 지난 쪽을 잠정으로 잇는다(조건은 `TailWindow`). 멈춘 작업은
//! 이 파일의 `step_typeset_tail` 이 쉬는 동안 이어 끝내고, 끝낸 결과를 보통 쪽 나눔 후처리에 넘겨 바꾼다.
//!
//! - 서버·다른 사용처는 켜지 않으므로 늘 끝까지 바로 조판한다(지금과 같다).
//! - 멈춘 뒤 문서가 바뀌었으면(구역 dirty·목록 주소·정규화 세대·측정 환경·조판 기억 세대) 이어 가지 않는다.
//!   그 변경을 반영하는 다음 쪽 나눔이 이 작업을 버리고 새로 한다(`paginate_pass` 시작).
//! - 저장·인쇄·내보내기·명시 마무리(`flush_deferred_pagination`)는 남은 작업을 먼저 끝낸다.
//! - 검증 모드(`setLayoutMemoVerify(true)`)는 마무리한 결과를 처음부터 한 조판과 견준다(`typesetResumeStats`).
use super::DocumentCore;
use crate::model::page::ColumnDef;
use crate::renderer::pagination::EndnoteDeferral;
use crate::renderer::typeset::{ParkedSection, SectionTypesetInput, TypesetEngine};
use std::collections::HashSet;

pub(crate) struct TypesetTailJob {
    pub(crate) typesetter: TypesetEngine,
    pub(crate) parked: Option<ParkedSection>, // [hwpx-cowork] 자연 경계에서 예약한 새 작업은 첫 유휴 조각에서 시작한다.
    pub(crate) config: TypesetTailConfig,
}

/// 멈춘 구역 조판의 입력을 다시 세우는 값과 멈출 때의 입력 표지(하나라도 다르면 이어 가지 않는다).
pub(crate) struct TypesetTailConfig {
    pub(crate) section_index: usize,
    pub(crate) column_def: ColumnDef,
    pub(crate) skip_spacing_before_prededuct: bool,
    pub(crate) hwp3_origin_page_tolerance: bool,
    pub(crate) paragraphs_ptr: usize,
    pub(crate) composed_ptr: usize,
    pub(crate) environment: u64,
    pub(crate) layout_generation: u64,
    pub(crate) respect_vpos_reset: bool,
    pub(crate) normalized: bool,
    pub(crate) source_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypesetTailState {
    /// 남은 작업이 없다.
    None,
    /// 더 남았다.
    Pending,
    /// 끝냈고 쪽 나눔을 바꿨다.
    Complete,
    /// 멈춘 뒤 문서가 바뀌어 버렸다(그 변경의 쪽 나눔이 새로 한다).
    Stale,
}

impl TypesetTailState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pending => "pending",
            Self::Complete => "complete",
            Self::Stale => "stale",
        }
    }
}

pub(super) fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

impl DocumentCore {
    /// 편집기가 켠다. 끄면 남은 작업을 끝낸다.
    pub fn set_typeset_tail_deferral(&mut self, enabled: bool) {
        // [hwpx-cowork] 일반 열기는 조판 뒤에 편집기가 연결된다. 편집 모드 진입 때
        // 한 번만 독립 구역을 찾는다. 점진 열기의 미완료 구역은 완주 pass에서 등록한다.
        if enabled && !self.typeset_tail_deferral && !self.has_body_page_fields() {
            let env = self.layout_environment_stamp();
            self.flow_sections = (0..self.pagination.len().min(self.document.sections.len()))
                .map(|i| (self.progressive_open_job.as_ref().is_none_or(|job| i < job.section_index)
                    && self.dirty_sections.get(i) == Some(&false)).then(|| self.classify_flow_section(i, env)).flatten())
                .collect();
        }
        self.typeset_tail_deferral = enabled;
        if !enabled {
            self.flush_typeset_tail();
        }
    }

    pub fn typeset_tail_pending(&self) -> bool {
        self.interactive_layout.pending || self.typeset_tail_job.is_some() || self.row_tail.is_some() || self.row_text.is_some() // [hwpx-cowork]
    }

    fn typeset_tail_current(&self, config: &TypesetTailConfig) -> bool {
        let idx = config.section_index;
        if idx + 1 != self.document.sections.len() || self.batch_mode {
            return false;
        }
        let revision = self.render_normalization.section_revisions.get(idx).copied();
        let normalized_now = self
            .render_normalization
            .sections
            .get(idx)
            .and_then(|section| section.as_ref())
            .is_some_and(|section| Some(section.source_revision) == revision);
        !self.dirty_sections.get(idx).copied().unwrap_or(true)
            && self.document.sections[idx].paragraphs.as_ptr() as usize == config.paragraphs_ptr
            && self.composed.get(idx).map_or(0, |c| c.as_ptr() as usize) == config.composed_ptr
            && revision == Some(config.source_revision)
            && normalized_now == config.normalized
            && self.layout_environment_stamp() == config.environment
            && self.typeset_resume.layout_generation.get() == config.layout_generation
            && self.respect_vpos_reset == config.respect_vpos_reset
            && self.measured_sections.get(idx).is_some()
    }

    pub(crate) fn typeset_tail_input<'a>(
        &'a self,
        config: &'a TypesetTailConfig,
        no_breaks: &'a HashSet<usize>,
    ) -> SectionTypesetInput<'a> {
        let idx = config.section_index;
        let section = &self.document.sections[idx];
        SectionTypesetInput {
            paragraphs: self.section_render_paragraphs(idx),
            composed: self.section_render_composed(idx),
            styles: &self.styles,
            page_def: &section.section_def.page_def,
            column_def: &config.column_def,
            section_index: idx,
            measured_tables: &self.measured_sections[idx].tables,
            hide_empty_line: section.section_def.hide_empty_line,
            profile: self.effective_layout_profile(),
            skip_spacing_before_prededuct: config.skip_spacing_before_prededuct,
            hwp3_origin_page_tolerance: config.hwp3_origin_page_tolerance,
            footnote_shape: Some(&section.section_def.footnote_shape),
            endnote_shape: Some(&section.section_def.endnote_shape),
            force_break_before: no_breaks,
            endnote_deferral: EndnoteDeferral::None,
        }
    }

    /// 남은 작업을 `budget_ms` 동안(최소 한 걸음) 잇는다. 끝나면 쪽 나눔을 바꾼다.
    pub fn step_typeset_tail(&mut self, budget_ms: f64) -> TypesetTailState {
        if self.interactive_layout.pending { return self.step_interactive_layout(budget_ms); } // [hwpx-cowork]
        // [hwpx-cowork] 한 칸에서 이어 친 글자는 마지막 리비전의 근접 창을 한 번만
        // 발행한다. 다음 스케줄러 차례에서 그 뒤쪽을 재개한다.
        if self.settle_row_text() {
            return if self.typeset_tail_pending() { TypesetTailState::Pending } else { TypesetTailState::Complete };
        }
        if self.row_tail.is_some() {
            return self.advance_row_tail();
        }
        let Some(mut tail) = self.typeset_tail_job.take() else {
            return TypesetTailState::None;
        };
        if !self.typeset_tail_current(&tail.config) {
            // [hwpx-cowork] 자연 흐름의 앞쪽에서 친 다음 글자가 기존 작업을 무효화했다.
            // 잠정 쪽의 경계는 구역에 남아 있다. 이번 글자를 포함한 새 작업으로 이어 간다.
            if self.dirty_sections.get(tail.config.section_index) == Some(&true)
                && self.only_text_edits_pending.get() && self.settle_flow_text() {
                return if self.typeset_tail_pending() { TypesetTailState::Pending } else { TypesetTailState::Complete };
            }
            // 바뀐 문서는 그 변경의 쪽 나눔이 새로 한다. dirty 가 아닌데 입력이 달라졌으면(다른 길로 바뀜)
            // 잠정 쪽이 남지 않도록 지금 처음부터 다시 나눈다.
            let idx = tail.config.section_index;
            if idx < self.document.sections.len()
                && !self.batch_mode
                && !self.dirty_sections.get(idx).copied().unwrap_or(true)
            {
                self.mark_section_pagination_dirty(idx);
                self.paginate();
            }
            return TypesetTailState::Stale;
        }
        let _split_cell_doc = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
        let spacing = self.document.sections[tail.config.section_index].section_def.default_tab_spacing;
        let _tabs = self.styles.section_tab_scope(spacing, self.dpi); // [hwpx-cowork] 예약한 구역의 탭 간격
        let started = now_ms();
        let no_breaks = HashSet::new();
        let done = loop {
            let input = self.typeset_tail_input(&tail.config, &no_breaks);
            let parked = tail.parked.get_or_insert_with(|| tail.typesetter.start_flow_tail(&input));
            let done = match tail.typesetter.continue_parked_with_storage(
                parked,
                &input,
                &crate::storage::Unbounded,
            ) {
                Ok(done) => done,
                Err(never) => match never {},
            };
            if done || now_ms() - started >= budget_ms {
                break done;
            }
        };
        if !done {
            self.typeset_tail_job = Some(tail);
            return TypesetTailState::Pending;
        }
        self.complete_typeset_tail(tail);
        TypesetTailState::Complete
    }

    /// 남은 작업을 지금 끝낸다(저장·인쇄·명시 마무리).
    pub fn flush_typeset_tail(&mut self) -> TypesetTailState {
        loop {
            let state = self.step_typeset_tail(f64::INFINITY);
            if state != TypesetTailState::Pending && !self.typeset_tail_pending() { return state; } // [hwpx-cowork] 합쳐진 작업까지 모두 마무리
        }
    }

    fn complete_typeset_tail(&mut self, tail: TypesetTailJob) {
        let TypesetTailJob { typesetter, parked, config, .. } = tail;
        let idx = config.section_index;
        let verify = self.typeset_resume.verify.get();
        let outcome = {
            let _split_cell_doc = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
            let no_breaks = HashSet::new();
            let input = self.typeset_tail_input(&config, &no_breaks);
            match typesetter.finish_parked_with_storage(parked.expect("completed tail has started"), &input, verify, &crate::storage::Unbounded) {
                Ok(outcome) => outcome,
                Err(never) => match never {},
            }
        };
        let control = &self.typeset_resume;
        if outcome.verify_checked {
            control.verify_checks.set(control.verify_checks.get() + 1);
        }
        if outcome.verify_mismatch {
            control.verify_mismatches.set(control.verify_mismatches.get() + 1);
            if control.first_mismatch.borrow().is_none() {
                *control.first_mismatch.borrow_mut() = outcome.verify_note.clone();
            }
        }
        control.tail_completed.set(control.tail_completed.get() + 1);
        if self.typeset_checkpoints.len() <= idx {
            self.typeset_checkpoints.resize_with(idx + 1, || None);
        }
        self.typeset_checkpoints[idx] = Some(super::TypesetCheckpointStore {
            checkpoints: outcome.checkpoints,
            paragraphs_ptr: config.paragraphs_ptr,
            composed_ptr: config.composed_ptr,
            environment: config.environment,
            layout_generation: config.layout_generation,
            respect_vpos_reset: config.respect_vpos_reset,
            normalized: config.normalized,
        });
        // 끝낸 결과를 보통 쪽 나눔 후처리(쪽 번호·바탕쪽·머리말·각주 번호·쪽 번호 필드)에 넘긴다.
        self.typeset_tail_completed = Some((idx, outcome.result));
        self.dirty_sections[idx] = true;
        self.paginate();
    }
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;

    const LINE: &str = "뒤쪽을 미룬 조판이 끝까지 바로 한 조판과 같은 쪽을 내는지 보려고 여러 줄에 걸치게 넣는 시험 글입니다. ";

    /// 글 문단 여러 개로 여러 쪽짜리 구역을 만든다. 일정한 간격으로 쪽 나누기를 넣어 앞쪽 편집의 밀림이
    /// 그 쪽에서 흡수되게 한다(맞는 쪽 경계가 생긴다).
    fn pages_with_breaks(paragraphs: usize, break_every: usize) -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, &LINE.repeat(3)).unwrap();
        for index in 1..paragraphs {
            let len = core.document.sections[0].paragraphs[index - 1].text.chars().count();
            core.split_paragraph_native(0, index - 1, len, None).unwrap();
            core.insert_text_native(0, index, 0, &LINE.repeat(1 + index % 3)).unwrap();
            if index % break_every == 0 {
                core.document.sections[0].paragraphs[index].column_type =
                    crate::model::paragraph::ColumnBreakType::Page;
                core.recompose_paragraph(0, index);
                core.paginate();
            }
        }
        core
    }

    fn canonical(core: &DocumentCore) -> String {
        core.pagination
            .iter()
            .map(|section| format!("{:?}", section.pages.iter().map(|p| (p.page_number, p.column_contents.iter().map(|c| format!("{:?}", c.items)).collect::<Vec<_>>())).collect::<Vec<_>>()))
            .collect()
    }

    /// 앞쪽 Enter 는 편집한 쪽 근처까지만 조판하고 멈춘다. 쉬는 동안 마무리한 결과(검증 모드: 처음부터 한
    /// 조판과 견줌)가 미루지 않은 문서와 같다.
    #[test]
    fn early_enter_parks_the_tail_and_completion_matches_direct_typesetting() {
        let mut direct = pages_with_breaks(200, 8);
        let mut deferred = pages_with_breaks(200, 8);
        deferred.typeset_resume.verify.set(true);
        deferred.set_typeset_tail_deferral(true);
        assert!(direct.page_count() >= 10, "여러 쪽짜리 구역: {}", direct.page_count());

        // 쪽 나누기 사이의 앞쪽 문단(체크포인트가 그 앞에 있다).
        let target = 100;
        direct.split_paragraph_native(0, target, 5, None).unwrap();
        deferred.split_paragraph_native(0, target, 5, None).unwrap();
        assert!(deferred.typeset_tail_pending(), "앞쪽 Enter 는 뒤쪽을 미룬다");
        assert_eq!(deferred.typeset_resume.tail_parked.get(), 1);
        // 잠정 결과도 쪽 수가 같다(맞는 경계에서 이었다).
        assert_eq!(deferred.page_count(), direct.page_count());

        while deferred.step_typeset_tail(0.0) == super::TypesetTailState::Pending {}
        assert!(!deferred.typeset_tail_pending());
        assert_eq!(deferred.typeset_resume.tail_completed.get(), 1);
        assert_eq!(deferred.typeset_resume.verify_mismatches.get(), 0, "{:?}", deferred.typeset_resume.first_mismatch.borrow());
        assert_eq!(canonical(&deferred), canonical(&direct));

        // 마무리 전에 다시 편집하면 멈춘 작업은 버리고 새로 한다.
        direct.split_paragraph_native(0, target + 3, 5, None).unwrap();
        deferred.split_paragraph_native(0, target + 3, 5, None).unwrap();
        direct.merge_paragraph_native(0, target + 4).unwrap();
        deferred.merge_paragraph_native(0, target + 4).unwrap();
        deferred.flush_typeset_tail();
        assert_eq!(deferred.typeset_resume.verify_mismatches.get(), 0, "{:?}", deferred.typeset_resume.first_mismatch.borrow());
        assert_eq!(canonical(&deferred), canonical(&direct));

        // 잠정 쪽(앞 편집이 미룬 뒤쪽) 안을 마무리 전에 편집해도 마무리한 결과가 같다.
        direct.split_paragraph_native(0, 60, 5, None).unwrap();
        deferred.split_paragraph_native(0, 60, 5, None).unwrap();
        assert!(deferred.typeset_tail_pending());
        direct.insert_text_native(0, 170, 0, &LINE.repeat(2)).unwrap();
        deferred.insert_text_native(0, 170, 0, &LINE.repeat(2)).unwrap();
        direct.merge_paragraph_native(0, 150).unwrap();
        deferred.merge_paragraph_native(0, 150).unwrap();
        deferred.flush_typeset_tail();
        assert!(!deferred.typeset_tail_pending());
        assert_eq!(deferred.typeset_resume.verify_mismatches.get(), 0, "{:?}", deferred.typeset_resume.first_mismatch.borrow());
        assert_eq!(canonical(&deferred), canonical(&direct));
    }

    /// 한 줄이 구역 끝까지 밀리는 문서(쪽 나누기 없음): 맞는 쪽 경계가 없으면 끝까지 바로 조판하고, 우연히 맞으면
    /// 미뤘다가 마무리한다 — 어느 쪽이든 미루지 않은 문서와 같다.
    #[test]
    fn cascading_edit_matches_direct_typesetting() {
        let mut direct = pages_with_breaks(160, usize::MAX);
        let mut deferred = pages_with_breaks(160, usize::MAX);
        deferred.typeset_resume.verify.set(true);
        deferred.set_typeset_tail_deferral(true);
        for (para, offset) in [(60, 5), (61, 0), (100, 7)] {
            direct.split_paragraph_native(0, para, offset, None).unwrap();
            deferred.split_paragraph_native(0, para, offset, None).unwrap();
        }
        deferred.flush_typeset_tail();
        assert_eq!(deferred.typeset_resume.verify_mismatches.get(), 0, "{:?}", deferred.typeset_resume.first_mismatch.borrow());
        assert_eq!(canonical(&deferred), canonical(&direct));
    }

    /// 켜지 않으면(서버 등) 늘 끝까지 바로 조판한다.
    #[test]
    fn without_opt_in_nothing_is_deferred() {
        let mut core = pages_with_breaks(60, 8);
        core.split_paragraph_native(0, 12, 5, None).unwrap();
        assert!(!core.typeset_tail_pending());
        assert_eq!(core.typeset_resume.tail_parked.get(), 0);
    }

    /// 멈춘 뒤 다른 길로 구역이 바뀌면(dirty) 이어 가지 않는다.
    #[test]
    fn stale_tail_is_dropped() {
        let mut core = pages_with_breaks(200, 8);
        core.set_typeset_tail_deferral(true);
        core.split_paragraph_native(0, 100, 5, None).unwrap();
        assert!(core.typeset_tail_pending());
        core.mark_section_pagination_dirty(0);
        assert_eq!(core.step_typeset_tail(1000.0), super::TypesetTailState::Stale);
        assert!(!core.typeset_tail_pending());
    }
}
