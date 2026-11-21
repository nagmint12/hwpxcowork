//! [hwpx-cowork] 2026-11-20 구역 조판 체크포인트 — 편집한 자리 앞의 쪽부터 다시 조판한다(앞쪽 재사용).
//!
//! 편집 한 번마다 쪽 나눔이 구역 첫 문단부터 끝까지 다시 조판했다. 바뀌지 않은 앞쪽도 문단마다 구성
//! 기억을 찾고 배치를 다시 하므로, 86쪽 문서 80쪽에서 Enter 를 쳐도 2쪽에서 친 것과 같은 시간이 들었다.
//! 조판은 문단 차례로 앞으로만 나아가는 작업(`SectionTypesetJob`)이라, 지난 조판이 쪽 경계마다 남긴 작업
//! 사본에서 이어 가면 앞쪽은 다시 하지 않아도 된다.
//!
//! 이어 가도 처음부터 한 것과 같으려면 그 사본을 만들 때 읽은 입력이 지금도 같아야 한다.
//! 1. 시작 단계가 구역 전체에서 정한 값(사다리 판정·용지 기준 개체 범위·저장 줄 유무·머리말 목록·쪽 번호
//!    위치·마지막 내용 문단 등)과 쪽 정의·단 정의·호환 정책이 같다(`begin_summary`). 문단 번호가 든 값은
//!    바뀐 자리 뒤 번호를 문단 수 차이만큼 옮겨 견준다.
//! 2. 바뀐 자리(문서가 알려 준 '이 번호 앞 문단은 그대로')보다 앞의 문단만 사본에 영향을 주었다. 조판은
//!    뒤 문단을 엿보는 규칙이 있다(다음 문단과 함께 두기, 표 뒤 문단, 미리 채운 줄 등). 그래서
//!    - 보류 목록(미리 채운·미리 내보낸 문단, 미룬 표·그림·각주·개체, 다음 쪽으로 넘긴 것)이 비어 있거나
//!      사본 앞 문단만 가리키는 '조용한' 사본만 쓰고(`is_quiet`),
//!    - 바뀐 자리보다 `MARGIN_PARAGRAPHS` 문단 이상 앞이면서 그런 사본 가운데 마지막 것보다
//!      `MARGIN_CHECKPOINTS` 개 더 앞의 사본에서 시작한다.
//! 3. 측정 환경·문단 목록이 바뀐 길을 문서가 알 수 없으면 사본을 쓰지 않는다(문서 쪽 판단).
//!
//! 검증 모드(`setLayoutMemoVerify(true)`)에서는 이어 간 결과마다 처음부터 다시 조판해 견주고, 다르면 처음부터 한
//! 결과를 쓴 뒤 그 횟수를 센다(`typeset_resume_stats`).

use super::*;

/// 사본을 남기는 간격(닫힌 쪽 수).
const CHECKPOINT_PAGES: usize = 2;
/// 바뀐 자리보다 이만큼 앞 문단까지만 사본이 닿을 수 있다.
const MARGIN_PARAGRAPHS: usize = 3;
/// 조건에 맞는 사본 가운데 마지막 것보다 이만큼 더 앞의 사본에서 시작한다(한 간격 이상의 여유).
const MARGIN_CHECKPOINTS: usize = 1;
/// [hwpx-cowork] 2026-11-20 뒤쪽 미루기: 편집한 문단이 끝난 쪽 뒤로 이만큼 닫힌 쪽까지는 바로 조판한다
/// (편집한 쪽과 화면에 함께 보일 다음 쪽).
const TAIL_PAGES_AFTER_EDIT: usize = 2;
/// 그 뒤 지난 조판의 쪽 시작과 맞는 쪽 경계를 이만큼 더 찾는다. 못 찾으면 끝까지 바로 조판한다.
const TAIL_ALIGN_EXTRA_PAGES: usize = 6;
/// 지난 조판에서 맞는 쪽을 찾는 범위(지금 닫힌 쪽 수 앞뒤).
const TAIL_ALIGN_SEARCH: usize = 6;
/// 미룰 쪽이 이보다 적게 남으면(구역 끝 근처 편집) 미루지 않는다.
const TAIL_MIN_DEFERRED_PAGES: usize = 8;

/// 사본은 한 번 남기면 바뀌지 않는다 — 목록을 넘길 때 작업 상태를 다시 복제하지 않도록 함께 쓴다.
#[derive(Clone)]
struct Checkpoint {
    job: std::sync::Arc<SectionTypesetJob>,
}

/// 한 구역 조판이 남긴 체크포인트.
pub(crate) struct SectionCheckpoints {
    summary: String,
    hf_entries: Vec<(usize, String)>,
    last_content_para_idx: Option<usize>,
    paragraph_count: usize,
    points: Vec<Checkpoint>,
}

impl SectionCheckpoints {
    // [hwpx-cowork] 점진 열기에서도 같은 입력 표지와 재개 상태를 만든다. 첫 편집이
    // 구역 전체를 한 번 더 조판해야만 앞쪽을 재사용할 수 있었던 비용을 없앤다.
    pub(crate) fn at_open(engine: &TypesetEngine, input: &SectionTypesetInput<'_>, job: &SectionTypesetJob) -> Self {
        Self {
            summary: begin_summary(engine, input, job),
            hf_entries: hf_entries_summary(job),
            last_content_para_idx: job.last_content_para_idx,
            paragraph_count: job.paragraph_count,
            points: Vec::new(),
        }
    }

    pub(crate) fn record_open_step(&mut self, job: &SectionTypesetJob) {
        record_checkpoint(&mut self.points, job);
    }

    pub(crate) fn len(&self) -> usize {
        self.points.len()
    }
}

// [hwpx-cowork] 사본은 닫힌 쪽과 문단별 배치 기록까지 소유한다. 모든 두 쪽에서
// 누적 상태를 복제하면 한 구역이 길어질수록 메모리가 제곱으로 늘어난다. 입력 문단
// 수로 저장 간격을 정해 한 구역의 누적 사본 수를 제한한다. 실행 조각의 예산과는 별개다.
fn record_checkpoint(points: &mut Vec<Checkpoint>, job: &SectionTypesetJob) {
    const SAMPLES: usize = 16;
    let (prior_para, prior_page) = points.last().map_or((0, 0), |p| {
        (p.job.next_para_idx, p.job.closed_page_count())
    });
    if job.closed_page_count().saturating_sub(prior_page) >= CHECKPOINT_PAGES
        && job.next_para_idx.saturating_sub(prior_para) >= job.paragraph_count.div_ceil(SAMPLES)
    {
        points.push(Checkpoint { job: std::sync::Arc::new(job.clone()) });
    }
}

/// 다시 조판할 때 문서가 건네는 문맥.
pub(crate) struct ResumeRequest<'a> {
    /// 지난 조판의 체크포인트(문서가 측정 환경·문단 목록이 바뀐 길을 확인한 것만).
    pub(crate) previous: Option<&'a SectionCheckpoints>,
    /// 이 번호 앞의 문단은 지난 조판 뒤로 바뀌지 않았다(문서가 편집에서 모은 값). `None` = 모름.
    pub(crate) unchanged_before: Option<usize>,
    /// 이번 조판의 체크포인트를 남긴다.
    pub(crate) record: bool,
    /// 이어 간 결과를 처음부터 한 조판과 견준다.
    pub(crate) verify: bool,
    /// [hwpx-cowork] 2026-11-20 뒤쪽 미루기를 허락한다(편집기가 켜고, 문서가 조건을 확인한 구역만).
    pub(crate) tail: Option<TailWindow>,
}

/// [hwpx-cowork] 2026-11-20 뒤쪽 미루기 — 편집한 쪽 근처까지만 바로 조판하고, 그 뒤는 지난 조판의 쪽을
/// 잠정으로 보이며 쉬는 동안 같은 작업을 이어 마무리한다.
///
/// 잠정 쪽은 지난 조판의 쪽 시작과 **새 조판의 쪽 시작 항목이 같은** 쪽 경계에서만 잇는다(문단 번호는 문단
/// 수 차이만큼 옮겨 견준다 — `PageItem::matches_with_offset`). 그 경계 뒤로는 바뀐 문단이 없으므로 뒤쪽이
/// 대개 그대로이지만, 조판 상태 전체가 같다는 보장은 아니라서 멈춘 작업을 끝까지 이어 정확한 결과로 바꾼다
/// (`DocumentCore::step_typeset_tail`). 맞는 경계를 `TAIL_ALIGN_EXTRA_PAGES` 안에서 못 찾으면(한 줄이 끝까지
/// 밀리는 문서) 미루지 않고 끝까지 바로 조판한다.
pub(crate) struct TailWindow {
    /// 지난 조판 결과(구역 후처리까지 마친 것) — 바뀐 자리 뒤 문단 번호가 지금과 문단 수 차이만큼 어긋나 있다.
    /// 이번 조판이 대신하므로 문서가 넘겨준다(잠정 쪽은 복제하지 않고 옮긴다).
    pub(crate) previous_result: PaginationResult,
}

/// 멈춘 구역 조판 작업. 같은 입력이면 이어서 끝까지 하면 처음부터 한 조판과 같은 결과를 낸다.
pub(crate) struct ParkedSection {
    job: SectionTypesetJob,
    kept: Vec<Checkpoint>,
    summary: String,
    hf_entries: Vec<(usize, String)>,
    resumed_from: Option<usize>,
}

/// 멈춘 작업을 마무리한 결과.
pub(crate) struct ParkedOutcome {
    pub(crate) result: PaginationResult,
    pub(crate) checkpoints: SectionCheckpoints,
    pub(crate) verify_checked: bool,
    pub(crate) verify_mismatch: bool,
    pub(crate) verify_note: Option<String>,
}

pub(crate) struct ResumeOutcome {
    pub(crate) result: PaginationResult,
    pub(crate) checkpoints: Option<SectionCheckpoints>,
    /// 이어 간 문단 번호(처음부터 했으면 `None`).
    pub(crate) resumed_from: Option<usize>,
    /// 검증 모드에서 이어 간 결과와 처음부터 한 결과가 달랐다.
    pub(crate) verify_mismatch: bool,
    /// 검증 모드에서 견준 횟수(0 또는 1).
    pub(crate) verify_checked: bool,
    /// 다를 때 처음 다른 줄(쪽)의 앞부분(진단용).
    pub(crate) verify_note: Option<String>,
    /// [hwpx-cowork] 2026-11-20 뒤쪽을 미뤘으면 멈춘 작업(`result` 는 잠정 결과).
    pub(crate) parked: Option<ParkedSection>,
}

impl SectionTypesetJob {
    /// 보류 목록이 비어 있거나 이 사본 앞 문단만 가리킨다(뒤 문단에 기대는 진행 중 결정이 없다).
    fn is_quiet(&self) -> bool {
        let next = self.next_para_idx;
        let st = &self.state;
        let before = |index: usize| index < next;
        st.deferred_table_successor_start.is_none()
            && !st.has_pending_origin_or_terminal_gap()
            && st.stored_paragraph_boundary_carry.is_none_or(|(para, _)| before(para))
            && st.prefilled_paras.iter().all(|&para| before(para))
            && st.prefilled_line_prefixes.keys().all(|&para| before(para))
            && st.pre_emitted_host_paras.iter().all(|&para| before(para))
            && st.pre_emitted_host_heights.keys().all(|&para| before(para))
            && st.pre_emitted_host_content_heights.keys().all(|&para| before(para))
            && st.hangul2024_spill_para.is_none_or(before)
            && st.defer_host_line_item_para.is_none()
            && st.behind_float_table_para.is_none_or(before)
            && st.overlay_shape_shortcut_para.is_none_or(before)
            && st.deferred_table_controls.is_empty()
            && st.deferred_column_shapes.is_empty()
            && st.deferred_next_page_square_pictures.is_empty()
            && st.deferred_next_page_footnotes.is_empty()
            && st.deferred_next_page_stored_frames.is_empty()
            && st.deferred_next_column_stored_frames.is_empty()
            && st.deferred_body_footnotes.is_empty()
            && st.pending_picture_pile.is_empty()
            && st.page_start_square_pictures.is_empty()
            && st.pending_overlay_continuations.is_empty()
            && st.behind_pending_absorbs.is_empty()
    }
}

/// 시작 단계와 입력이 구역 전체에서 정한 값 가운데 문단 번호가 들지 않은 것.
fn begin_summary(engine: &TypesetEngine, input: &SectionTypesetInput<'_>, job: &SectionTypesetJob) -> String {
    let st = &job.state;
    let endnote_deferral = match input.endnote_deferral {
        EndnoteDeferral::None => 0_u8,
        EndnoteDeferral::Suppress => 1,
        EndnoteDeferral::RenderAll(_) => 2,
    };
    let mut forced: Vec<usize> = input.force_break_before.iter().copied().collect();
    forced.sort_unstable();
    format!(
        "{:?}|{}|{:?}|{:?}|{:?}|{:?}|{}|{:?}|{}|{}|{:?}|{:?}|{}|{:?}|{}|{}|{}|{}|{}|{:?}|{:?}|{}",
        input.profile,
        engine.uniform_filler_ladder.get(),
        engine.float_carve_evidence.borrow(),
        engine.section_column_spacing_hu.get(),
        input.page_def,
        input.column_def,
        input.hide_empty_line,
        input.footnote_shape,
        input.skip_spacing_before_prededuct,
        input.hwp3_origin_page_tolerance,
        input.endnote_shape,
        forced,
        endnote_deferral,
        job.page_number_pos,
        job.body_height_hu_for_variant,
        st.has_stored_line_segs,
        st.stored_initial_column_band.to_bits(),
        st.omit_fresh_recalc_doc,
        st.stored_ladder_spacing_omitted,
        st.layout,
        st.footnote_placement,
        engine.dpi.to_bits(),
    )
}

fn hf_entries_summary(job: &SectionTypesetJob) -> Vec<(usize, String)> {
    job.hf_entries
        .iter()
        .map(|(para, reference, is_header, apply)| {
            (*para, format!("{:?}|{}|{:?}", reference.control_index, is_header, apply))
        })
        .collect()
}

impl TypesetEngine {
    // [hwpx-cowork] 자연 쪽 나눔이 밀린 경우 편집한 쪽을 먼저 발행하고,
    // 같은 원본과 조판 옵션을 쓰는 작업을 기존 유휴 조판기가 예산별로 끝낸다.
    pub(crate) fn start_flow_tail(&self, input: &SectionTypesetInput<'_>) -> ParkedSection {
        let job = self.begin_section(input);
        ParkedSection {
            summary: begin_summary(self, input, &job),
            hf_entries: hf_entries_summary(&job), job, kept: Vec::new(), resumed_from: None,
        }
    }

    /// [hwpx-cowork] 구역 조판 — 지난 조판의 체크포인트에서 이어 갈 수 있으면 이어 간다(모듈 설명).
    pub(crate) fn typeset_section_resumable_with_storage<S: crate::storage::Storage>(
        &self,
        input: &SectionTypesetInput<'_>,
        request: ResumeRequest<'_>,
        storage: &S,
    ) -> Result<ResumeOutcome, S::Error> {
        // 구역 조판 동안 이 구역 문단의 글자처럼 취급 표는 한 번만 잰다(`typeset_section_with_variant_with_storage` 와 같다).
        let _reflow_table_memo = crate::renderer::composer::reflow_table_memo_scope(
            self.cell_compose_memo.clone().filter(|_| S::UNBOUNDED),
            S::UNBOUNDED.then_some((input.paragraphs, input.styles)),
        );
        // 한정된 Storage(PDF 들여오기 등)는 할당을 세므로 사본을 만들지도 쓰지도 않는다.
        let record = request.record && S::UNBOUNDED;
        let fresh = self.begin_section_with_storage(input, storage)?;
        let summary = record.then(|| begin_summary(self, input, &fresh));
        let hf_entries = record.then(|| hf_entries_summary(&fresh));
        // 지난 조판의 구역 전체 값이 지금과 같은가(바뀐 자리 뒤는 문단 수 차이만큼 옮겨) — 체크포인트를 쓰거나
        // 뒤쪽을 지난 쪽으로 잠정 이을 수 있는 조건.
        let comparable = match (request.previous, request.unchanged_before, &summary, &hf_entries) {
            (Some(previous), Some(floor), Some(summary), Some(hf_entries)) if S::UNBOUNDED => {
                previous_comparable(previous, summary, hf_entries, &fresh, floor)
            }
            _ => false,
        };
        let start = match (request.previous, request.unchanged_before) {
            (Some(previous), Some(floor)) if comparable => pick_checkpoint(previous, floor),
            _ => None,
        };
        let mut kept: Vec<Checkpoint> = Vec::new();
        let mut job = match (start, request.previous) {
            (Some(index), Some(previous)) => {
                kept.extend(previous.points[..=index].iter().cloned());
                let mut job = SectionTypesetJob::clone(&previous.points[index].job);
                // 구역 전체에서 정한 값 가운데 문단 번호·문단 수가 든 것은 지금 입력의 값을 쓴다
                // (바뀐 자리 앞의 값은 같음을 `pick_checkpoint` 가 확인했다).
                job.paragraph_count = fresh.paragraph_count;
                job.last_content_para_idx = fresh.last_content_para_idx;
                job.hf_entries = fresh.hf_entries.clone();
                job.page_number_pos = fresh.page_number_pos.clone();
                job.profile_enabled = fresh.profile_enabled;
                job
            }
            _ => fresh,
        };
        let resumed_from = start.map(|_| job.next_para_idx);
        // [hwpx-cowork] 2026-11-20 뒤쪽 미루기: 지난 조판과 견줄 수 있고 바뀐 자리를 알 때만(체크포인트가 없으면 처음부터
        // 조판하며 편집한 쪽 뒤에서 멈춘다). 바뀐 자리 뒤 문단 번호는 지난 조판보다 `delta` 만큼 밀려 있다.
        let mut tail = match (request.tail, request.unchanged_before, request.previous) {
            (Some(window), Some(floor), Some(previous)) if record && comparable => Some((
                window,
                floor,
                input.paragraphs.len() as i64 - previous.paragraph_count as i64,
            )),
            _ => None,
        };
        // 이어 간 사본의 닫힌 쪽 — 그 앞쪽은 지난 조판의 쪽과 같다(바뀐 문단 앞).
        let start_closed = job.closed_page_count();
        let mut edit_page: Option<usize> = None;
        loop {
            // 편집한 쪽을 지나 맞는 경계를 찾는 동안은 쪽마다 멈추고 사본은 남기지 않는다(사본 하나가 그때까지의 쪽을
            // 모두 복제한다). 멈출 때 한 번 남긴다.
            let seeking = tail.is_some() && edit_page.is_some();
            let page_budget = if !record {
                usize::MAX
            } else if seeking {
                1
            } else {
                CHECKPOINT_PAGES
            };
            let done = self.step_section_with_storage(&mut job, input, usize::MAX, page_budget, storage)?;
            if done {
                break;
            }
            let closed = job.closed_page_count();
            if record && !seeking {
                record_checkpoint(&mut kept, &job);
            }
            let Some((floor, delta)) = tail.as_ref().map(|(_, floor, delta)| (*floor, *delta)) else {
                continue;
            };
            if edit_page.is_none() && job.next_para_idx > floor {
                let edit = job.state.pages.len().saturating_sub(1);
                edit_page = Some(edit);
                // 구역 끝이 가까우면 멈추는 값(잠정 결과 만들기·사본)이 남은 쪽 조판보다 크다 — 끝까지 바로 조판한다.
                let previous_pages = tail.as_ref().map_or(0, |(window, _, _)| window.previous_result.pages.len());
                if previous_pages < edit + 1 + TAIL_PAGES_AFTER_EDIT + TAIL_MIN_DEFERRED_PAGES {
                    tail = None;
                    continue;
                }
            }
            let Some(edit) = edit_page else { continue };
            if closed < edit + 1 + TAIL_PAGES_AFTER_EDIT {
                continue;
            }
            if closed > edit + 1 + TAIL_PAGES_AFTER_EDIT + TAIL_ALIGN_EXTRA_PAGES {
                // 맞는 경계가 없다(한 줄이 끝까지 밀린다) — 끝까지 바로 조판한다(사본은 다시 종전 간격으로).
                tail = None;
                record_checkpoint(&mut kept, &job);
                continue;
            }
            if !job.is_quiet() {
                continue;
            }
            let Some((window, _, _)) = tail.as_mut() else { continue };
            let Some(provisional) = self.provisional_with_previous_tail(
                &job,
                input,
                &mut window.previous_result,
                delta,
                start_closed,
            ) else {
                continue;
            };
            // 다음 편집이 이 근처에서 다시 시작할 수 있게 멈춘 상태를 사본으로 남긴다.
            record_checkpoint(&mut kept, &job);
            let (Some(summary), Some(hf_entries)) = (summary, hf_entries) else {
                unreachable!("record 일 때만 미룬다");
            };
            let checkpoints = SectionCheckpoints {
                summary: summary.clone(),
                hf_entries: hf_entries.clone(),
                last_content_para_idx: last_content_paragraph(input.paragraphs),
                paragraph_count: input.paragraphs.len(),
                points: kept.clone(),
            };
            return Ok(ResumeOutcome {
                result: provisional,
                checkpoints: Some(checkpoints),
                resumed_from,
                verify_mismatch: false,
                verify_checked: false,
                verify_note: None,
                parked: Some(ParkedSection { job, kept, summary, hf_entries, resumed_from }),
            });
        }
        let result = self.finish_section_with_storage(job, input, storage)?;
        let mut outcome = ResumeOutcome {
            result,
            checkpoints: None,
            resumed_from,
            verify_mismatch: false,
            verify_checked: false,
            verify_note: None,
            parked: None,
        };
        if request.verify && resumed_from.is_some() {
            let full = self.run_section_from_start_with_storage(input, storage)?;
            outcome.verify_checked = true;
            if let Some(note) = first_difference(&full, &outcome.result, input.section_index, resumed_from) {
                outcome.verify_mismatch = true;
                outcome.verify_note = Some(note);
                outcome.result = full;
                // 사본이 처음부터 한 조판과 다른 결과를 냈다 — 이번 사본은 남기지 않는다.
                kept.clear();
            }
        }
        if let (true, Some(summary), Some(hf_entries)) = (record, summary, hf_entries) {
            outcome.checkpoints = Some(SectionCheckpoints {
                summary,
                hf_entries,
                last_content_para_idx: last_content_paragraph(input.paragraphs),
                paragraph_count: input.paragraphs.len(),
                points: kept,
            });
        }
        Ok(outcome)
    }

    /// [hwpx-cowork] 2026-11-20 멈춘 구역 조판을 닫힌 쪽 `CHECKPOINT_PAGES` 만큼 더 한다. 끝났으면 `true`.
    /// `input` 은 멈출 때와 같은 문서 상태여야 한다(문서가 확인한다 — `DocumentCore::step_typeset_tail`).
    pub(crate) fn continue_parked_with_storage<S: crate::storage::Storage>(
        &self,
        parked: &mut ParkedSection,
        input: &SectionTypesetInput<'_>,
        storage: &S,
    ) -> Result<bool, S::Error> {
        let _reflow_table_memo = crate::renderer::composer::reflow_table_memo_scope(
            self.cell_compose_memo.clone().filter(|_| S::UNBOUNDED),
            S::UNBOUNDED.then_some((input.paragraphs, input.styles)),
        );
        let done =
            self.step_section_with_storage(&mut parked.job, input, usize::MAX, CHECKPOINT_PAGES, storage)?;
        if !done {
            record_checkpoint(&mut parked.kept, &parked.job);
        }
        Ok(done)
    }

    /// 끝까지 이은 작업의 구역 끝 처리. 검증 모드면 처음부터 한 조판과 견준다.
    pub(crate) fn finish_parked_with_storage<S: crate::storage::Storage>(
        &self,
        parked: ParkedSection,
        input: &SectionTypesetInput<'_>,
        verify: bool,
        storage: &S,
    ) -> Result<ParkedOutcome, S::Error> {
        let _reflow_table_memo = crate::renderer::composer::reflow_table_memo_scope(
            self.cell_compose_memo.clone().filter(|_| S::UNBOUNDED),
            S::UNBOUNDED.then_some((input.paragraphs, input.styles)),
        );
        let ParkedSection { mut job, mut kept, summary, hf_entries, resumed_from } = parked;
        // 남은 문단이 있으면(마무리를 한 번에 부른 경우) 끝까지 한다.
        while !self.step_section_with_storage(&mut job, input, usize::MAX, CHECKPOINT_PAGES, storage)? {
            record_checkpoint(&mut kept, &job);
        }
        let mut result = self.finish_section_with_storage(job, input, storage)?;
        let mut outcome_verify = (false, false, None);
        if verify {
            let full = self.run_section_from_start_with_storage(input, storage)?;
            outcome_verify.0 = true;
            if let Some(note) = first_difference(&full, &result, input.section_index, resumed_from) {
                outcome_verify = (true, true, Some(format!("tail {note}")));
                result = full;
                kept.clear();
            }
        }
        Ok(ParkedOutcome {
            result,
            checkpoints: SectionCheckpoints {
                summary,
                hf_entries,
                last_content_para_idx: last_content_paragraph(input.paragraphs),
                paragraph_count: input.paragraphs.len(),
                points: kept,
            },
            verify_checked: outcome_verify.0,
            verify_mismatch: outcome_verify.1,
            verify_note: outcome_verify.2,
        })
    }

    /// [hwpx-cowork] 2026-11-20 잠정 결과: 새 조판의 닫힌 쪽 + 쪽 시작 항목이 새 조판의 열린 쪽 시작과 같은
    /// 지난 조판의 쪽부터 끝까지(문단 번호를 `delta` 만큼 옮김). 맞는 쪽이 없거나 옮긴 쪽이 지금 문단을 벗어나는
    /// 항목을 가리키면 `None`.
    fn provisional_with_previous_tail(
        &self,
        job: &SectionTypesetJob,
        input: &SectionTypesetInput<'_>,
        previous: &mut PaginationResult,
        delta: i64,
        start_closed: usize,
    ) -> Option<PaginationResult> {
        let offset = i32::try_from(delta).ok()?;
        // 미주는 구역 끝에 모여 문단 번호 공간이 따로다 — 미주가 있는 구역은 미루지 않는다.
        if !previous.endnotes.is_empty()
            || !previous.endnote_paragraphs.is_empty()
            || !job.state.endnotes.is_empty()
        {
            return None;
        }
        // 열린 쪽(아직 닫히지 않은 마지막 쪽)의 첫 항목.
        let open = job.state.pages.last()?;
        let first_new = open
            .column_contents
            .iter()
            .flat_map(|column| column.items.iter())
            .next()
            .or_else(|| job.state.current_items.first())?;
        // 쪽 앞에 붙일 개체가 남아 있으면 그 쪽의 첫 항목이 아직 정해지지 않았다.
        if !job.state.page_start_stored_frames.is_empty() {
            return None;
        }
        let closed = job.closed_page_count();
        let last = previous.pages.len().checked_sub(1)?;
        let lo = closed.saturating_sub(TAIL_ALIGN_SEARCH).max(1);
        let hi = (closed + TAIL_ALIGN_SEARCH).min(last);
        let from = (lo..=hi).find(|&index| {
            previous.pages[index]
                .column_contents
                .first()
                .and_then(|column| column.items.first())
                .is_some_and(|old| first_new.matches_with_offset(old, offset))
        })?;
        if from < start_closed || !tail_items_fit(&previous.pages[from..], offset, input.paragraphs, input.composed) {
            return None;
        }
        // 이어 간 사본 앞의 쪽은 지난 조판의 쪽을 그대로 옮기고(바뀐 문단 앞이라 번호를 옮기지 않는다), 이번에 조판한
        // 쪽만 복제한다 — 쪽 수에 비례하는 복제를 하지 않는다. 쪽 번호·머리말·바탕쪽은 아래와 구역 후처리가 다시 정한다.
        let mut result = job.state.snapshot_closed_pages_from(start_closed);
        let tail_pages: Vec<_> = previous.pages.drain(from..).collect();
        let mut pages: Vec<_> = previous.pages.drain(..start_closed).collect();
        pages.append(&mut result.pages);
        for page in tail_pages {
            pages.push(page.into_shifted(offset));
        }
        for (index, page) in pages.iter_mut().enumerate() {
            page.page_index = index as u32;
        }
        result.pages = pages;
        // 구역 단위 목록: 경계 문단부터는 지난 조판의 값을 옮겨 더한다(앞은 새 조판의 값).
        let boundary = first_new.para_index();
        let shift = |pi: usize| (pi as i64 + delta).max(0) as usize;
        for &pi in &previous.hidden_empty_paras {
            if shift(pi) >= boundary {
                result.hidden_empty_paras.insert(shift(pi));
            }
        }
        for &pi in &previous.pre_emitted_host_paras {
            if shift(pi) >= boundary {
                result.pre_emitted_host_paras.insert(shift(pi));
            }
        }
        for (&pi, &height) in &previous.pre_emitted_host_heights {
            if shift(pi) >= boundary {
                result.pre_emitted_host_heights.insert(shift(pi), height);
            }
        }
        for (&pi, &height) in &previous.pre_emitted_host_content_heights {
            if shift(pi) >= boundary {
                result.pre_emitted_host_content_heights.insert(shift(pi), height);
            }
        }
        for wrap in &previous.wrap_around_paras {
            if shift(wrap.para_index) >= boundary {
                result.wrap_around_paras.push(crate::renderer::pagination::WrapAroundPara {
                    para_index: shift(wrap.para_index),
                    table_para_index: shift(wrap.table_para_index),
                    ..wrap.clone()
                });
            }
        }
        // 쪽 번호·머리말은 합친 쪽 전체로 다시 정한다.
        super::super::state::finalize::finalize_pages(
            &mut result.pages,
            &job.hf_entries,
            &job.page_number_pos,
            input.paragraphs,
        );
        Some(result)
    }

    /// 체크포인트 없이 처음부터 조판한다(검증 모드의 견줌용).
    fn run_section_from_start_with_storage<S: crate::storage::Storage>(
        &self,
        input: &SectionTypesetInput<'_>,
        storage: &S,
    ) -> Result<PaginationResult, S::Error> {
        let mut job = self.begin_section_with_storage(input, storage)?;
        self.step_section_with_storage(&mut job, input, usize::MAX, usize::MAX, storage)?;
        self.finish_section_with_storage(job, input, storage)
    }
}

/// 끝에서부터 글이나 개체가 있는 첫 문단.
fn last_content_paragraph(paragraphs: &[Paragraph]) -> Option<usize> {
    paragraphs
        .iter()
        .enumerate()
        .rev()
        .find(|(_, p)| !(p.text.is_empty() && p.controls.is_empty()))
        .map(|(index, _)| index)
}

/// [hwpx-cowork] 2026-11-20 잠정 쪽의 항목이 지금 문단을 벗어나지 않는가(문단 번호·줄·개체·표 행).
/// 지난 조판 뒤로 뒤 문단의 번호 매김·캡션 번호가 바뀌어 줄 수가 달라질 수 있다 — 그리기가 범위 밖을
/// 읽지 않도록 확인하고, 벗어나면 미루지 않는다.
fn tail_items_fit(
    pages: &[crate::renderer::pagination::PageContent],
    offset: i32,
    paragraphs: &[Paragraph],
    composed: &[ComposedParagraph],
) -> bool {
    use crate::model::control::Control;
    use crate::renderer::pagination::{FootnoteSource, PageItem};
    // 옮긴 뒤 문단 번호(음수가 되면 범위 밖).
    let shifted = |pi: usize| usize::try_from(pi as i64 + i64::from(offset)).unwrap_or(usize::MAX);
    let lines = |pi: usize| {
        composed.get(pi).map_or(0, |c| c.lines.len()).max(paragraphs.get(pi).map_or(0, |p| p.line_segs.len()))
    };
    let control = |pi: usize, ci: usize| paragraphs.get(shifted(pi)).and_then(|p| p.controls.get(ci));
    pages.iter().all(|page| {
        page.column_contents.iter().all(|column| {
            column.items.iter().all(|item| match item {
                PageItem::FullParagraph { para_index } => shifted(*para_index) < paragraphs.len(),
                PageItem::PartialParagraph { para_index, start_line, end_line } => {
                    shifted(*para_index) < paragraphs.len()
                        && start_line <= end_line
                        && *end_line <= lines(shifted(*para_index))
                }
                PageItem::Table { para_index, control_index } => {
                    matches!(control(*para_index, *control_index), Some(Control::Table(_)))
                }
                PageItem::PartialTable { para_index, control_index, end_row, row_cursor_is_nested, .. } => {
                    match control(*para_index, *control_index) {
                        Some(Control::Table(table)) => {
                            *row_cursor_is_nested || *end_row <= usize::from(table.row_count)
                        }
                        _ => false,
                    }
                }
                PageItem::Shape { para_index, control_index } => {
                    control(*para_index, *control_index).is_some()
                }
                PageItem::EndnoteSeparator { .. } => true,
            })
        }) && page.footnotes.iter().all(|note| match &note.source {
            FootnoteSource::Body { para_index, control_index } => {
                control(*para_index, *control_index).is_some()
            }
            FootnoteSource::TableCell { para_index, .. }
            | FootnoteSource::NestedTableCell { para_index, .. }
            | FootnoteSource::ShapeTextBox { para_index, .. } => shifted(*para_index) < paragraphs.len(),
        })
    })
}

/// 두 조판 결과가 다르면 처음 다른 줄(쪽)의 앞부분을 돌려준다(검증 모드의 진단).
fn first_difference(
    expected: &PaginationResult,
    actual: &PaginationResult,
    section_index: usize,
    resumed_from: Option<usize>,
) -> Option<String> {
    let expected_text = canonical_pagination(expected);
    let actual_text = canonical_pagination(actual);
    if expected_text == actual_text {
        return None;
    }
    let line = expected_text
        .lines()
        .zip(actual_text.lines())
        .position(|(a, b)| a != b)
        .unwrap_or(expected_text.lines().count().min(actual_text.lines().count()));
    let excerpt = |text: &str, other: &str| {
        let row = text.lines().nth(line).unwrap_or("");
        let other_row = other.lines().nth(line).unwrap_or("");
        let at = row
            .char_indices()
            .zip(other_row.chars())
            .find(|((_, a), b)| a != b)
            .map_or(0, |((index, _), _)| index);
        let start = row[..at].char_indices().rev().nth(80).map_or(0, |(index, _)| index);
        row[start..].chars().take(240).collect::<String>()
    };
    Some(format!(
        "section={} resumedFrom={:?} line={} pagesFull={} pagesResumed={} full=<{}> resumed=<{}>",
        section_index,
        resumed_from,
        line,
        expected.pages.len(),
        actual.pages.len(),
        excerpt(&expected_text, &actual_text),
        excerpt(&actual_text, &expected_text)
    ))
}

/// 검증 모드의 견줌용: 쪽 나눔 결과를 HashMap·HashSet 의 순서와 무관한 글로 만든다.
/// (WASM 의 HashMap 은 인스턴스마다 해시 키가 달라 `Debug` 순서가 바뀐다 — 사본을 이어 간 결과는 사본의 맵을,
/// 처음부터 한 결과는 새 맵을 쓰므로 내용이 같아도 `Debug` 글이 다를 수 있다.)
/// 필드를 `..` 없이 풀어 쓴다 — 결과에 필드가 늘면 여기서 컴파일이 멈춘다.
fn canonical_pagination(result: &PaginationResult) -> String {
    use std::fmt::Write as _;
    fn map<K: std::fmt::Debug, V: std::fmt::Debug>(
        out: &mut String,
        entries: impl Iterator<Item = (K, V)>,
    ) {
        let mut rows: Vec<String> = entries.map(|(key, value)| format!("{key:?}={value:?}")).collect();
        rows.sort_unstable();
        let _ = write!(out, "{{{}}}", rows.join(","));
    }
    fn set<K: std::fmt::Debug>(out: &mut String, entries: impl Iterator<Item = K>) {
        let mut rows: Vec<String> = entries.map(|key| format!("{key:?}")).collect();
        rows.sort_unstable();
        let _ = write!(out, "[{}]", rows.join(","));
    }
    let PaginationResult {
        pages,
        wrap_around_paras,
        hidden_empty_paras,
        pre_emitted_host_paras,
        pre_emitted_host_heights,
        pre_emitted_host_content_heights,
        endnotes,
        endnote_paragraphs,
        endnote_para_sources,
        endnote_measured_tables,
        endnote_between_notes_hu,
        endnote_separator_above_hu,
        endnote_separator_below_hu,
    } = result;
    let mut out = String::new();
    for page in pages {
        let crate::renderer::pagination::PageContent {
            page_index,
            page_number,
            section_index,
            layout,
            column_contents,
            active_header,
            active_footer,
            page_number_restarted,
            page_number_pos,
            page_hide,
            footnotes,
            active_master_page,
            extra_master_pages,
            ladder_band_tables,
        } = page;
        let _ = write!(
            out,
            "P{page_index:?}|{page_number:?}|{section_index:?}|{layout:?}|{active_header:?}|{active_footer:?}|{page_number_restarted:?}|{page_number_pos:?}|{page_hide:?}|{footnotes:?}|{active_master_page:?}|{extra_master_pages:?}|{ladder_band_tables:?}"
        );
        for column in column_contents {
            let crate::renderer::pagination::ColumnContent {
                paragraph_origins,
                computed_paragraphs,
                host_compositions,
                stored_paragraph_flow_ends,
                stored_column_top_spacings,
                paragraph_float_placements,
                float_pushed_line_spacings,
                page_band_flow_starts,
                inline_flow_plans,
                inline_placements,
                column_index,
                start_height,
                endnote_flow,
                items,
                zone_layout,
                zone_y_offset,
                wrap_around_paras,
                used_height,
                wrap_anchors,
                overlay_continuations,
                overlay_cuts,
            } = column;
            let _ = write!(
                out,
                "|C{column_index:?}|{start_height:?}|{endnote_flow:?}|{items:?}|{zone_layout:?}|{zone_y_offset:?}|{wrap_around_paras:?}|{used_height:?}|{overlay_continuations:?}|{overlay_cuts:?}"
            );
            map(&mut out, paragraph_origins.iter());
            map(&mut out, computed_paragraphs.iter());
            map(&mut out, host_compositions.iter());
            map(&mut out, stored_paragraph_flow_ends.iter());
            map(&mut out, stored_column_top_spacings.iter());
            map(&mut out, paragraph_float_placements.iter());
            map(&mut out, float_pushed_line_spacings.iter());
            map(&mut out, page_band_flow_starts.iter());
            map(&mut out, inline_flow_plans.iter());
            map(&mut out, inline_placements.iter());
            map(&mut out, wrap_anchors.iter());
        }
        out.push('\n');
    }
    let _ = write!(out, "{wrap_around_paras:?}");
    set(&mut out, hidden_empty_paras.iter());
    set(&mut out, pre_emitted_host_paras.iter());
    map(&mut out, pre_emitted_host_heights.iter());
    map(&mut out, pre_emitted_host_content_heights.iter());
    let _ = write!(
        out,
        "{endnotes:?}|{endnote_paragraphs:?}|{endnote_para_sources:?}|{endnote_measured_tables:?}|{endnote_between_notes_hu:?}|{endnote_separator_above_hu:?}|{endnote_separator_below_hu:?}"
    );
    out
}

/// 지난 조판의 구역 전체 값이 지금과 같은가(모듈 설명의 1).
fn previous_comparable(
    previous: &SectionCheckpoints,
    summary: &str,
    hf_entries: &[(usize, String)],
    fresh: &SectionTypesetJob,
    floor: usize,
) -> bool {
    if previous.summary != summary || floor == usize::MAX {
        return false;
    }
    // 마지막 내용 문단이 바뀐 자리 앞이면(문서 끝 빈 문단 편집) 그 뒤 빈 문단 처리가 앞 결정에 닿을 수 있다.
    if previous.last_content_para_idx.is_none_or(|index| index < floor)
        || fresh.last_content_para_idx.is_none_or(|index| index < floor)
    {
        return false;
    }
    // 머리말·꼬리말 목록: 바뀐 자리 앞은 그대로, 뒤는 문단 수 차이만큼 옮겨 같아야 한다.
    let delta = fresh.paragraph_count as i64 - previous.paragraph_count as i64;
    // [hwpx-cowork] 새 머리말 목록은 저장했던 목록과 비교한다. 현재 목록끼리 비교하면
    // 머리말 앞에 문단을 넣을 때 재개가 잘못 거절되고, 내용 변경은 반대로 놓칠 수 있다.
    hf_entries.len() == previous.hf_entries.len()
        && hf_entries.iter().zip(&previous.hf_entries).all(|((new_para, new), (old_para, old))| {
            new == old
                && if *old_para < floor {
                    new_para == old_para
                } else {
                    *new_para as i64 == *old_para as i64 + delta
                }
        })
}

/// 이어 갈 사본을 고른다(모듈 설명의 2 — 1 은 `previous_comparable` 이 확인했다). 없으면 `None`.
fn pick_checkpoint(previous: &SectionCheckpoints, floor: usize) -> Option<usize> {
    let limit = floor.checked_sub(MARGIN_PARAGRAPHS)?;
    let candidates: Vec<usize> = previous
        .points
        .iter()
        .enumerate()
        .filter(|(_, point)| point.job.next_para_idx <= limit && point.job.is_quiet())
        .map(|(index, _)| index)
        .collect();
    candidates
        .len()
        .checked_sub(1 + MARGIN_CHECKPOINTS)
        .map(|position| candidates[position])
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;

    const LINE: &str = "체크포인트에서 이어 간 구역 조판이 처음부터 한 조판과 같은 쪽을 내는지 보려고 여러 줄에 걸치게 넣는 시험 글입니다. ";

    /// 글 문단 여러 개로 여러 쪽짜리 구역을 만든다.
    fn many_pages(paragraphs: usize) -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, &LINE.repeat(3)).unwrap();
        for index in 1..paragraphs {
            let len = core.document.sections[0].paragraphs[index - 1].text.chars().count();
            core.split_paragraph_native(0, index - 1, len, None).unwrap();
            core.insert_text_native(0, index, 0, &LINE.repeat(1 + index % 4)).unwrap();
        }
        core
    }

    fn stats(core: &DocumentCore) -> (u64, u64, u64, u64) {
        let control = &core.typeset_resume;
        (
            control.resumed.get(),
            control.full.get(),
            control.verify_checks.get(),
            control.verify_mismatches.get(),
        )
    }

    /// 뒤쪽 문단을 고치면 앞쪽 체크포인트에서 이어 가고, 검증 모드로 견준 결과가 처음부터 한 조판과 같다.
    /// 글 넣기(줄 수 바뀜)·문단 나누기·합치기 모두. 앞쪽을 고치면 이어 갈 체크포인트가 없어 처음부터 한다.
    /// (통계는 문서를 만드는 동안의 조판까지 누적이라 편집 전후의 차이로 본다.)
    #[test]
    fn late_edits_resume_from_a_checkpoint_with_identical_pages() {
        let mut core = many_pages(90);
        core.typeset_resume.verify.set(true);
        let pages = core.page_count();
        assert!(pages >= 6, "여러 쪽짜리 구역이어야 한다: {pages}");
        let late = core.document.sections[0].paragraphs.len() - 5;
        let (resumed0, _, checks0, mismatches0) = stats(&core);
        assert_eq!(mismatches0, 0);

        core.insert_text_native(0, late, 0, &LINE.repeat(2)).unwrap();
        let (resumed, _, checks, mismatches) = stats(&core);
        assert_eq!(resumed, resumed0 + 1, "뒤쪽 글 넣기는 체크포인트에서 이어 간다");
        assert_eq!(checks, checks0 + 1);
        assert_eq!(mismatches, 0, "이어 간 결과가 처음부터 한 조판과 같아야 한다");

        core.split_paragraph_native(0, late, 10, None).unwrap();
        core.merge_paragraph_native(0, late + 1).unwrap();
        let (resumed_after, full_before_early, checks, mismatches) = stats(&core);
        assert!(resumed_after >= resumed + 2, "나누기·합치기도 이어 간다");
        assert!(checks >= checks0 + 3);
        assert_eq!(mismatches, 0);

        // 첫 문단: 이어 갈 체크포인트가 없다 — 처음부터 한다.
        core.insert_text_native(0, 0, 0, "앞").unwrap();
        let (resumed_early, full_early, _, mismatches) = stats(&core);
        assert_eq!(resumed_early, resumed_after, "앞쪽 편집은 이어 가지 않는다");
        assert!(full_early > full_before_early);
        assert_eq!(mismatches, 0);
    }

    /// 체크포인트를 끄면 늘 처음부터 하고, 다시 켠 뒤 첫 조판이 체크포인트를 새로 남긴다.
    #[test]
    fn disabled_resume_always_typesets_from_the_start() {
        let mut core = many_pages(60);
        core.typeset_resume.disabled.set(true);
        core.forget_typeset_checkpoints();
        let late = core.document.sections[0].paragraphs.len() - 3;
        let (resumed0, ..) = stats(&core);
        core.insert_text_native(0, late, 0, "가나다").unwrap();
        assert_eq!(stats(&core).0, resumed0, "끄면 이어 가지 않는다");
        assert!(core.typeset_checkpoints.iter().all(Option::is_none), "끄면 남기지도 않는다");
        core.typeset_resume.disabled.set(false);
        core.insert_text_native(0, late, 0, "라").unwrap();
        assert!(core.typeset_checkpoints.iter().any(Option::is_some), "켜면 첫 조판이 남긴다");
    }

    /// 무엇이 바뀌었는지 모르는 표시(구역 다시 구성)가 끼면 이어 가지 않는다.
    #[test]
    fn unknown_section_change_typesets_from_the_start() {
        let mut core = many_pages(60);
        let late = core.document.sections[0].paragraphs.len() - 3;
        core.insert_text_native(0, late, 0, "가").unwrap();
        let (resumed, ..) = stats(&core);
        core.recompose_section(0);
        core.paginate();
        assert_eq!(stats(&core).0, resumed, "구역을 다시 구성하면 처음부터 한다");
    }
}
