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

struct Collector<'a> {
    core: &'a DocumentCore,
    entries: CanvasRequestEntries,
    work: usize,
    bytes: usize,
}
impl Collector<'_> {
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
                        if self.entries.contains_key(&key) {
                            continue;
                        }
                        self.bytes = self.bytes.saturating_add(
                            key.len() + font.len() + cluster.len() + style.font_family.len(),
                        );
                        if self.entries.len() >= MAX_SUPPLEMENTAL_ENTRIES
                            || self.bytes > MAX_SUPPLEMENTAL_KEY_BYTES
                        {
                            return Err(MetricError::LimitExceeded);
                        }
                        self.entries.insert(
                            key.clone(),
                            (
                                CanvasMetricRequest {
                                    key,
                                    cluster: cluster.into(),
                                    font,
                                },
                                style.clone(),
                            ),
                        );
                    }
                }
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
        let mut collector = Collector {
            core: self,
            entries: BTreeMap::new(),
            work: 0,
            bytes: 0,
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
        let mut collector = Collector {
            core: self,
            entries,
            work: 0,
            bytes,
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
