//! [hwpx-cowork] 초기 조판의 읽기 전용 미리보기. 2026-11-10 P2: 여러 구역 문서는 첫 쪽 예산이 끝나는 구역에서
//! 멈춘다(앞 구역은 조판 끝, 뒤 구역은 dirty 로 남아 마무리 `paginate` 가 이어서 짠다).
//! 동일한 typesetter 상태를 이어가고 완료 결과는 기존 paginate 후처리에 넘긴다.
use super::DocumentCore;
use crate::error::HwpError;
use crate::model::page::ColumnDef;
use crate::renderer::pagination::EndnoteDeferral;
use crate::renderer::typeset::{SectionTypesetInput, SectionTypesetJob, TypesetEngine};
use std::collections::HashSet;

pub(crate) struct ProgressiveOpenJob {
    pub typesetter: TypesetEngine,
    pub job: SectionTypesetJob,
    // [hwpx-cowork] 미리보기와 같은 조판 작업에서 수집한다. 완료할 때만 공개한다.
    pub checkpoints: Option<super::TypesetCheckpointStore>,
    /// 멈춘 구역.
    pub section_index: usize,
    pub config: ProgressiveOpenConfig,
}

pub(crate) struct ProgressiveOpenConfig {
    /// 문서 끝 미주 구역(마지막 아님): 미주 본문을 이 구역에서 그리지 않는다(`EndnoteDeferral::Suppress`).
    pub suppress_endnotes: bool,
    pub deferred_endnotes: Vec<crate::renderer::pagination::DeferredEndnote>, // [hwpx-cowork] 구역 사이 미주의 원본 번호와 내용 유지
    pub column_def: ColumnDef,
    pub skip_spacing_before_prededuct: bool,
    pub hwp3_origin_page_tolerance: bool,
    pub force_break_before: HashSet<usize>,
}

impl DocumentCore {
    /// 직렬화는 완주한 조판/저장 프레임만 소비한다. UI는 완료까지 저장을 잠근다.
    pub(crate) fn require_progressive_open_complete(&self) -> Result<(), HwpError> {
        if self.progressive_open_job.is_some() {
            return Err(HwpError::RenderError("문서 조판 중입니다. 완료 후 저장하세요".to_string()));
        }
        Ok(())
    }
    pub(super) fn progressive_open_input<'a>(&'a self, section_index: usize, config: &'a ProgressiveOpenConfig) -> SectionTypesetInput<'a> {
        let section = &self.document.sections[section_index];
        let source_revision = self.render_normalization.section_revisions[section_index];
        let normalized = self.render_normalization.sections[section_index].as_ref()
            .filter(|section| section.source_revision == source_revision);
        SectionTypesetInput {
            paragraphs: normalized.map_or(section.paragraphs.as_slice(), |section| section.paragraphs.as_slice()),
            composed: normalized.map_or(self.composed[section_index].as_slice(), |section| section.composed.as_slice()),
            styles: &self.styles,
            page_def: &section.section_def.page_def,
            column_def: &config.column_def,
            section_index,
            measured_tables: &self.measured_tables[section_index],
            hide_empty_line: section.section_def.hide_empty_line,
            profile: self.effective_layout_profile(),
            skip_spacing_before_prededuct: config.skip_spacing_before_prededuct,
            hwp3_origin_page_tolerance: config.hwp3_origin_page_tolerance,
            footnote_shape: Some(&section.section_def.footnote_shape),
            endnote_shape: Some(&section.section_def.endnote_shape),
            force_break_before: &config.force_break_before,
            endnote_deferral: if !config.deferred_endnotes.is_empty() { EndnoteDeferral::RenderAll(&config.deferred_endnotes) } else if config.suppress_endnotes { EndnoteDeferral::Suppress } else { EndnoteDeferral::None },
        }
    }

    pub fn progressive_open_state_json(&self) -> String {
        let total: usize = self.document.sections.iter().map(|s| s.paragraphs.len()).sum();
        serde_json::json!({
            "state": if self.progressive_open_job.is_some() { "pending" } else { "complete" },
            "pageCount": self.page_count(),
            "processedParagraphs": self.progressive_open_job.as_ref().map_or(total, |p| p.job.processed_paragraphs()),
            "totalParagraphs": self.progressive_open_job.as_ref().map_or(total, |p| p.job.paragraph_count()),
        }).to_string()
    }

    /// 본문 문단 경계에서 중단한다. 단일 거대 표는 한 호출의 예산을 넘을 수 있다.
    pub fn step_progressive_open(&mut self, paragraph_budget: usize) -> String {
        let Some(mut pending) = self.progressive_open_job.take() else {
            return self.progressive_open_state_json();
        };
        // 입력은 편집 불가인 같은 세대다. 미리보기를 위해 작업 본체를 finalize하지 않는다.
        let section_index = pending.section_index;
        let input = self.progressive_open_input(section_index, &pending.config);
        // [hwpx-cowork] 나뉜 칸 미룬 개체 띠 표는 이 문서 키로 채운다.
        let _split_cell_doc = crate::renderer::layout::split_cell_doc_scope(self.split_cell_doc_id);
        // [hwpx-cowork] flush(usize::MAX)도 정상적인 점진 열기와 같은 재개 지점을 남긴다.
        let start = pending.job.processed_paragraphs();
        let complete = loop {
            let remaining = paragraph_budget.max(1).saturating_sub(pending.job.processed_paragraphs() - start);
            if remaining == 0 { break false; }
            let page_budget = if pending.checkpoints.is_some() { 2 } else { usize::MAX };
            if pending.typesetter.step_section(&mut pending.job, &input, remaining, page_budget) {
                break true;
            }
            if let Some(store) = pending.checkpoints.as_mut() {
                store.checkpoints.record_open_step(&pending.job);
            }
        };
        if complete {
            let input = self.progressive_open_input(section_index, &pending.config);
            let result = pending.typesetter.finish_section(pending.job, &input);
            self.typeset_checkpoints[section_index] = pending.checkpoints;
            self.progressive_open_completed = Some((section_index, result, self.measured_sections[section_index].clone()));
            // 앞 구역은 끝난 조판을 그대로 쓰고(dirty 아님), 뒤 구역은 처음부터 dirty 다.
            self.dirty_sections[section_index] = true;
            self.paginate();
            // 일반 생성자처럼 초기 materialization이 끝난 뒤 다시 봉인한다.
            self.document.seal_body_raw_provenance();
        } else {
            // 첫 미리보기를 유지한다. 이미 처리한 모든 쪽을 매 조각마다 복제하면
            // 큰 문서의 전체 열기가 O(조각 수×쪽 수) 추가 비용을 지게 된다.
            // 진행률은 문단 수로 알리고, 최종 결과는 기존 후처리에서 한 번만 발행한다.
            self.progressive_open_job = Some(pending);
        }
        self.progressive_open_state_json()
    }

    pub fn flush_progressive_open(&mut self) -> String {
        while self.progressive_open_job.is_some() {
            self.step_progressive_open(usize::MAX);
        }
        self.progressive_open_state_json()
    }
}
