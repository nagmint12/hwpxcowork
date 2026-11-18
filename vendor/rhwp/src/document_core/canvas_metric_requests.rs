//! Bounded source-side preparation. No font I/O and no paint-time document scan.
use super::DocumentCore;
use crate::error::HwpError;
use crate::model::{control::Control, paragraph::Paragraph, shape::ShapeObject};
use crate::renderer::{
    canvas_text_font::CanvasTextFont,
    composer::compose_paragraph_for_metric_requests,
    layout::{resolved_to_text_style, trace_char_width_decisions},
    supplemental_metrics::{
        accepts_prepared_glyph_advance, MetricContext, MetricError, SupplementalMetric,
        MAX_SUPPLEMENTAL_ENTRIES, MAX_SUPPLEMENTAL_KEY_BYTES,
    },
    TextStyle,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Serialize)]
pub struct CanvasMetricRequest {
    pub key: String,
    pub cluster: String,
    pub font: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMetricBatch {
    pub revision: u64,
    pub requests: Vec<CanvasMetricRequest>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasMetricReply {
    pub key: String,
    pub cluster: String,
    pub font: String,
    pub resolved_font: String,
    pub measured_advance_px: f64,
}

// [hwpx-cowork] Keys contain the effective style and scalar identity. Position
// changes do not invalidate their natural advances within one font generation.
pub(super) type CanvasRequestEntries = BTreeMap<String, (CanvasMetricRequest, TextStyle)>;

pub(super) struct PendingCanvasRequests {
    context: MetricContext,
    revision: u64,
    source: (u64, Vec<u64>, u64),
    entries: CanvasRequestEntries,
}

/// [hwpx-cowork] 2026-11-19: 문단 하나의 자기 글이 내는 요청(문단 안에서 열쇠가 처음 나온 차례대로).
type OwnRequests = std::sync::Arc<Vec<(CanvasMetricRequest, TextStyle)>>;

/// [hwpx-cowork] 문단별 요청의 기억.
///
/// 구조·서식 편집 뒤의 전체 모으기(`collect_canvas_metric_requests`)는 문서의 모든 문단을 다시 구성하고 글자마다
/// 폭 근거를 다시 따졌다 — 화면 편집기는 그런 편집마다 이 모으기를 부른다(59쪽 보고서에서 한 번에 약 30ms,
/// 칸에서 Enter 한 번의 주 스레드 95ms 가운데 가장 큰 몫). 문단의 요청은 문단 내용과 스타일의 함수이므로
/// 내용 지문으로 기억한다(`renderer::layout_memo`). 열쇠를 만들 수 없는 문단(개체·누름틀)은 늘 새로 계산한다.
/// 요청은 보충 측정값을 읽지 않으므로(`supplemental_metrics = None`) 측정값이 바뀌어도 남긴다.
/// 스타일 값·실제 글꼴 문맥이 바뀌면 문서가 비운다(`invalidate_layout_memos`).
pub(crate) type MetricRequestMemo = crate::renderer::layout_memo::ContentMemo<OwnRequests>;

const KIND_METRIC_REQUESTS: u8 = 5;

fn own_requests_bytes(requests: &OwnRequests) -> usize {
    std::mem::size_of::<(crate::renderer::layout_memo::MemoKey, OwnRequests)>()
        + requests
            .iter()
            .map(|(request, style)| {
                std::mem::size_of::<(CanvasMetricRequest, TextStyle)>()
                    + request.key.len()
                    + request.cluster.len()
                    + request.font.len()
                    + style.font_family.len()
            })
            .sum::<usize>()
}

struct Collector<'a> {
    core: &'a DocumentCore,
    entries: CanvasRequestEntries,
    work: usize,
    bytes: usize,
    // [hwpx-cowork] 문서의 문단별 요청 기억. 실제 글꼴 문맥을 쥔 문서는 걸지 않는다(늘 새로 계산).
    memo: Option<std::sync::Arc<MetricRequestMemo>>,
}
impl Collector<'_> {
    /// [hwpx-cowork] 문단 자기 글의 요청을 차례대로 낸다(종전 `paragraphs` 의 글자 훑기 그대로 —
    /// 요청마다 같은 검증을 거치고, 문단 안에서 이미 나온 열쇠는 건너뛴다).
    fn own_requests(&self, para: &Paragraph) -> Result<OwnRequests, MetricError> {
        let mut seen = std::collections::BTreeSet::new();
        let mut requests = Vec::new();
        for line in compose_paragraph_for_metric_requests(para).lines {
            for run in line.runs {
                // Markers/overlap have their own paint contracts, not ordinary text.
                if run.footnote_marker.is_some()
                    || run.char_overlap.is_some()
                    || run.display_text.is_some()
                    || run.supplemental_metrics_blocked
                {
                    continue;
                }
                let mut style = run.text_style(&self.core.styles);
                style.supplemental_metrics = None;
                let decisions = trace_char_width_decisions(&run.text, &style);
                let mut index = 0;
                for cluster in run.text.graphemes(true) {
                    let count = cluster.chars().count();
                    let decision = &decisions[index];
                    index += count;
                    let ch = cluster.chars().next().unwrap();
                    if count != 1
                        || !accepts_prepared_glyph_advance(decision.width_source)
                        || decision.dash_leader
                        || ch.is_whitespace()
                        || ch.is_control()
                        || crate::renderer::enclosed_pua(ch).is_some()
                    {
                        continue;
                    }
                    let font = CanvasTextFont::for_positioned_text(&style, 0.0)
                        .descriptor()
                        .to_owned();
                    // Validate the same style/scalar/descriptor contract before exposing a request.
                    let metric = SupplementalMetric::from_canvas_measurement(
                        &style,
                        cluster,
                        &font,
                        font.clone(),
                        0.0,
                    )?;
                    let key = metric.request_key();
                    if !seen.insert(key.clone()) {
                        continue;
                    }
                    requests.push((
                        CanvasMetricRequest {
                            key,
                            cluster: cluster.into(),
                            font,
                        },
                        style.clone(),
                    ));
                }
            }
        }
        Ok(std::sync::Arc::new(requests))
    }

    /// [hwpx-cowork] 문단의 요청 — 내용이 같은 문단은 문서의 기억에서 찾는다.
    fn paragraph_requests(&self, para: &Paragraph) -> Result<OwnRequests, MetricError> {
        use crate::renderer::composer::cell_compose_memo::{paragraph_fingerprint, FingerprintScope};
        let Some(memo) = self.memo.as_deref() else {
            return self.own_requests(para);
        };
        // 요청은 문단 내용(글·글자 모양·줄)과 스타일에서 나온다. 구역 기본 탭 폭은 글자 스타일에 실릴 수 있어 함께 넣는다.
        let key = paragraph_fingerprint(para, FingerprintScope::FlowFormat).map(|content| {
            crate::renderer::layout_memo::MemoKey {
                kind: KIND_METRIC_REQUESTS,
                content,
                a: 0,
                b: 0,
                c: self.core.styles.section_tab_key(),
                flags: 0,
            }
        });
        memo.get_or_compute(
            key,
            |requests| Some(own_requests_bytes(requests)),
            |found, fresh| format!("{found:?}") == format!("{fresh:?}"),
            || {
                format!(
                    "metric requests: {:?}",
                    para.text.chars().take(24).collect::<String>()
                )
            },
            || self.own_requests(para),
        )
    }

    fn budget(&mut self, work: usize, depth: usize) -> Result<(), MetricError> {
        self.work = self.work.saturating_add(work);
        if self.work > 4 * 1024 * 1024 || depth > 128 {
            return Err(MetricError::LimitExceeded);
        }
        Ok(())
    }
    fn paragraphs(&mut self, paragraphs: &[Paragraph], depth: usize) -> Result<(), MetricError> {
        for para in paragraphs {
            self.budget(1 + para.text.len() + para.controls.len(), depth)?;
            // [hwpx-cowork] 문단의 요청(기억 또는 새 계산)을 문서 차례대로 합친다 — 먼저 나온 열쇠가 남고,
            // 크기 셈과 한도 판정은 새 열쇠를 넣을 때마다 한다(종전 글자 훑기와 같은 차례·같은 값).
            let own = self.paragraph_requests(para)?;
            for (request, style) in own.iter() {
                if self.entries.contains_key(&request.key) {
                    continue;
                }
                self.bytes = self.bytes.saturating_add(
                    request.key.len()
                        + request.font.len()
                        + request.cluster.len()
                        + style.font_family.len(),
                );
                if self.entries.len() >= MAX_SUPPLEMENTAL_ENTRIES
                    || self.bytes > MAX_SUPPLEMENTAL_KEY_BYTES
                {
                    return Err(MetricError::LimitExceeded);
                }
                self.entries
                    .insert(request.key.clone(), (request.clone(), style.clone()));
            }
            for control in &para.controls {
                match control {
                    Control::Table(t) => {
                        if let Some(c) = &t.caption {
                            self.paragraphs(&c.paragraphs, depth + 1)?;
                        }
                        for cell in &t.cells {
                            self.paragraphs(&cell.paragraphs, depth + 1)?;
                        }
                    }
                    Control::Shape(s) => self.shape(s, depth + 1)?,
                    Control::Picture(p) => {
                        if let Some(c) = &p.caption {
                            self.paragraphs(&c.paragraphs, depth + 1)?;
                        }
                    }
                    Control::Header(h) => self.paragraphs(&h.paragraphs, depth + 1)?,
                    Control::Footer(h) => self.paragraphs(&h.paragraphs, depth + 1)?,
                    Control::Footnote(n) => self.paragraphs(&n.paragraphs, depth + 1)?,
                    Control::Endnote(n) => self.paragraphs(&n.paragraphs, depth + 1)?,
                    Control::HiddenComment(c) => self.paragraphs(&c.paragraphs, depth + 1)?,
                    Control::Field(f) => self.paragraphs(&f.memo_paragraphs, depth + 1)?,
                    _ => {}
                }
            }
        }
        Ok(())
    }
    fn shape(&mut self, shape: &ShapeObject, depth: usize) -> Result<(), MetricError> {
        self.budget(1, depth)?;
        if let Some(drawing) = shape.drawing() {
            if let Some(t) = &drawing.text_box {
                self.paragraphs(&t.paragraphs, depth + 1)?;
            }
            if let Some(c) = &drawing.caption {
                self.paragraphs(&c.paragraphs, depth + 1)?;
            }
        }
        match shape {
            ShapeObject::Group(g) => {
                if let Some(c) = &g.caption {
                    self.paragraphs(&c.paragraphs, depth + 1)?;
                }
                for child in &g.children {
                    self.shape(child, depth + 1)?;
                }
            }
            ShapeObject::Picture(p) => {
                if let Some(c) = &p.caption {
                    self.paragraphs(&c.paragraphs, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

impl DocumentCore {
    /// [hwpx-cowork] 이번 모으기가 쓸 문단별 요청 기억. 실제 글꼴 문맥(kerning·shaping)을 쥔 문서는 쓰지 않는다 —
    /// 그 문맥은 스타일을 다시 풀 때 비었다가 다음 쪽 나눔에서 다시 걸리므로, 그 사이의 요청과 섞이지 않게 한다.
    /// 쪽 나눔 밖에서 부르므로 측정 환경 표지(보충 측정값 제외)를 여기서 견준다.
    fn metric_request_memo_for_collection(&self) -> Option<std::sync::Arc<MetricRequestMemo>> {
        if self.styles.kerning_measurement_context.is_some()
            || self.styles.horizontal_shaping_context.is_some()
            || self.layout_engine.exact_font_source_registry_counts().0 > 0
        {
            return None;
        }
        self.metric_request_memo
            .sync_environment(self.font_environment_stamp());
        Some(std::sync::Arc::clone(&self.metric_request_memo))
    }

    /// Collect once per settled document revision, outside layout/paint.
    pub fn collect_canvas_metric_requests(
        &mut self,
        context: MetricContext,
    ) -> Result<CanvasMetricBatch, MetricError> {
        self.begin_canvas_metric_session(context)?;
        // [hwpx-cowork] A full pass is the structural/style refresh boundary.
        // Its old union must not remain eligible if collection or registration
        // fails, nor while the replacement full batch is still awaiting replies.
        let session = self.canvas_metrics.as_mut().unwrap();
        session.prepared_requests = None;
        session.pending = None;
        let memo = self.metric_request_memo_for_collection();
        let mut collector = Collector {
            core: self,
            entries: BTreeMap::new(),
            work: 0,
            bytes: 0,
            memo,
        };
        for section in &self.document.sections {
            collector.paragraphs(&section.paragraphs, 0)?;
            for master in &section.section_def.master_pages {
                collector.paragraphs(&master.paragraphs, 0)?;
            }
        }
        self.publish_canvas_metric_requests(context, collector.entries)
    }

    /// [hwpx-cowork] Prepare an edited leaf paragraph using the same collector
    /// and evidence as full-document preparation. The caller uses this only for
    /// a stable text mutation; structural/style mutations still collect fully.
    /// Retaining unused old keys after deletion is safe: style/scalar lookup
    /// cannot apply those advances to another glyph. A full pass trims them.
    pub fn collect_canvas_metric_requests_for_paragraph(
        &mut self,
        context: MetricContext,
        target_json: &str,
    ) -> Result<CanvasMetricBatch, HwpError> {
        let metric_error = |e| HwpError::RenderError(format!("Canvas metrics: {e:?}"));
        let target = super::commands::CodeTarget::from_json(target_json)?;
        self.begin_canvas_metric_session(context)
            .map_err(metric_error)?;
        let Some(entries) = self.canvas_metrics.as_ref().and_then(|session| {
            // A prior async preparation may have collected a different
            // edited paragraph but not registered yet. Its source-owned
            // keys must survive this newer batch; only replies to the
            // latest stamped source are eligible for publication below.
            session.prepared_requests.as_ref().map(|prepared| {
                session
                    .pending
                    .as_ref()
                    .map_or_else(|| prepared.clone(), |pending| pending.entries.clone())
            })
        }) else {
            return self
                .collect_canvas_metric_requests(context)
                .map_err(metric_error);
        };
        let paragraph = if target.path.is_empty() {
            self.document
                .sections
                .get(target.sec)
                .and_then(|section| section.paragraphs.get(target.para))
                .ok_or_else(|| HwpError::RenderError("Canvas metric paragraph not found".into()))?
        } else {
            self.resolve_paragraph_by_path(target.sec, target.para, &target.path)?
        };
        let bytes = entries
            .iter()
            .map(|(key, (request, style))| {
                key.len() + request.font.len() + request.cluster.len() + style.font_family.len()
            })
            .sum();
        let memo = self.metric_request_memo_for_collection();
        let mut collector = Collector {
            core: self,
            entries,
            work: 0,
            bytes,
            memo,
        };
        match collector.paragraphs(std::slice::from_ref(paragraph), 0) {
            Ok(()) => self
                .publish_canvas_metric_requests(context, collector.entries)
                .map_err(metric_error),
            // Old unused keys can fill the bounded union. Recollect current
            // document keys rather than failing or dropping another paragraph.
            Err(MetricError::LimitExceeded) => self
                .collect_canvas_metric_requests(context)
                .map_err(metric_error),
            Err(error) => Err(metric_error(error)),
        }
    }

    fn publish_canvas_metric_requests(
        &mut self,
        context: MetricContext,
        entries: CanvasRequestEntries,
    ) -> Result<CanvasMetricBatch, MetricError> {
        let requests = entries.values().map(|(r, _)| r.clone()).collect();
        let source = self.canvas_metric_source_revision();
        let session = self.canvas_metrics.as_mut().unwrap();
        session.next_request = session
            .next_request
            .checked_add(1)
            .ok_or(MetricError::LimitExceeded)?;
        let revision = session.next_request;
        self.canvas_metrics.as_mut().unwrap().pending = Some(PendingCanvasRequests {
            context,
            revision,
            source,
            entries,
        });
        Ok(CanvasMetricBatch { revision, requests })
    }

    pub fn register_canvas_metric_replies(
        &mut self,
        context: MetricContext,
        revision: u64,
        replies: Vec<CanvasMetricReply>,
    ) -> Result<bool, MetricError> {
        if self.batch_mode {
            return Err(MetricError::EditInProgress);
        }
        let pending = self
            .canvas_metrics
            .as_ref()
            .and_then(|s| s.pending.as_ref())
            .ok_or(MetricError::ContextMismatch)?;
        if pending.context != context
            || pending.revision != revision
            || pending.source != self.canvas_metric_source_revision()
        {
            return Err(MetricError::ContextMismatch);
        }
        if replies.len() != pending.entries.len() {
            return Err(MetricError::ContextMismatch);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut entries = Vec::with_capacity(replies.len());
        for reply in replies {
            if !seen.insert(reply.key.clone()) {
                return Err(MetricError::DuplicateKey);
            }
            let (request, style) = pending
                .entries
                .get(&reply.key)
                .ok_or(MetricError::ContextMismatch)?;
            if reply.font != request.font || reply.cluster != request.cluster {
                return Err(MetricError::InvalidDescriptor);
            }
            entries.push(SupplementalMetric::from_canvas_measurement(
                style,
                &reply.cluster,
                &reply.font,
                reply.resolved_font,
                reply.measured_advance_px,
            )?);
        }
        // Publish the request cache only after the exact source/revision batch
        // and every reply have validated successfully.
        let prepared_requests = pending.entries.clone();
        let changed = self.register_canvas_metrics(context, entries)?;
        let session = self.canvas_metrics.as_mut().unwrap();
        session.prepared_requests = Some(prepared_requests);
        session.pending = None;
        Ok(changed)
    }

    fn canvas_metric_source_revision(&self) -> (u64, Vec<u64>, u64) {
        (
            self.render_normalization.document_epoch,
            self.render_normalization.section_revisions.clone(),
            self.dpi.to_bits(),
        )
    }
}

#[cfg(test)]
mod tests {
    //! 계약 시험(합성 입력): 문단별 요청 기억을 쓴 모으기가 기억 없이 한 모으기와 같은 요청을 같은 차례로 내는지,
    //! 편집 뒤 바뀌지 않은 문단은 다시 훑지 않는지 본다. 화면 글꼴 실측값이나 조판 좌표는 다루지 않는다.
    use super::*;
    use crate::renderer::supplemental_metrics::MetricBackend;

    fn context() -> MetricContext {
        MetricContext {
            document_generation: 1,
            font_generation: 1,
            backend: MetricBackend::Canvas2d,
        }
    }

    fn document(memo: bool) -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.metric_request_memo.set_enabled(memo);
        for index in 0..24 {
            // 그림 글자는 글꼴 폭 표에 없어 화면 실측을 요청한다.
            let text = format!("문단 {index} 가나다 abc 😀👍 {}", "🎉".repeat(index % 3));
            core.insert_text_native(0, index, 0, &text).unwrap();
            core.split_paragraph_native(0, index, text.chars().count(), None)
                .unwrap();
        }
        core
    }

    fn requests(core: &mut DocumentCore) -> Vec<(String, String, String)> {
        core.collect_canvas_metric_requests(context())
            .expect("collect")
            .requests
            .into_iter()
            .map(|request| (request.key, request.cluster, request.font))
            .collect()
    }

    #[test]
    fn memoized_collection_matches_fresh_collection_and_skips_unchanged_paragraphs() {
        let mut with = document(true);
        let mut without = document(false);
        let first = requests(&mut with);
        assert_eq!(first, requests(&mut without));
        assert!(!first.is_empty(), "그림 글자가 요청을 낸다");
        let before = with.metric_request_memo.stats();
        // 글을 고치고 문단을 나눠도 같은 요청, 바뀌지 않은 문단은 기억에서 찾는다.
        // (빈 문서에 친 글은 줄에 합성 표시가 없어 뒤 문단은 저장 좌표가 밀린다 — 끝 쪽을 고쳐 앞 문단의 재사용을 본다.)
        for core in [&mut with, &mut without] {
            core.insert_text_native(0, 21, 0, "새 글 🚀 ").unwrap();
            core.split_paragraph_native(0, 22, 2, None).unwrap();
        }
        let second = requests(&mut with);
        assert_eq!(second, requests(&mut without));
        assert!(second.len() > first.len(), "새 그림 글자의 요청이 더해진다");
        let after = with.metric_request_memo.stats();
        assert!(
            after.hits - before.hits >= 20 && after.misses - before.misses <= 6,
            "바뀐 문단만 다시 훑는다: {before:?} → {after:?}"
        );
        assert_eq!(without.metric_request_memo.stats().hits, 0);
        // 검증 모드: 찾은 결과마다 새로 계산해 견줘도 다른 것이 없다
        with.metric_request_memo.set_verify(true);
        assert_eq!(requests(&mut with), second);
        let checked = with.metric_request_memo.stats();
        assert!(checked.verify_checks >= 20, "{checked:?}");
        assert_eq!(checked.verify_mismatches, 0, "{:?}", checked.first_mismatch);
    }

    #[test]
    fn applying_a_new_shape_changes_only_that_paragraphs_requests() {
        let mut with = document(true);
        let mut without = document(false);
        requests(&mut with);
        for core in [&mut with, &mut without] {
            core.apply_char_format_native(0, 2, 0, 12, r#"{"bold":true}"#)
                .unwrap();
        }
        let before = with.metric_request_memo.stats();
        assert_eq!(requests(&mut with), requests(&mut without));
        let after = with.metric_request_memo.stats();
        assert!(
            after.hits - before.hits >= 20,
            "서식 적용 뒤에도 다른 문단의 요청은 기억에서 찾는다: {before:?} → {after:?}"
        );
    }
}
