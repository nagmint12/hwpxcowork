//! Backend-bound metric ownership. Font data is render state, never document IR.

use std::sync::Arc;

use crate::error::HwpError;
use crate::renderer::supplemental_metrics::{
    MetricBackend, MetricContext, MetricError, SupplementalMetric, SupplementalMetricSnapshot,
    SupplementalMetricStore,
};

use super::DocumentCore;

pub(crate) struct CanvasMetricSession {
    context: MetricContext,
    store: SupplementalMetricStore,
    enabled: bool,
    pub(super) pending: Option<super::canvas_metric_requests::PendingCanvasRequests>,
    // [hwpx-cowork] A successfully registered full request set can be extended
    // by stable text edits without scanning every unchanged paragraph again.
    pub(super) prepared_requests: Option<super::canvas_metric_requests::CanvasRequestEntries>,
    pub(super) next_request: u64,
}

impl CanvasMetricSession {
    pub(crate) fn active_snapshot(&self) -> Option<Arc<SupplementalMetricSnapshot>> {
        self.enabled.then(|| self.store.snapshot()).flatten()
    }
}

impl DocumentCore {
    /// Bind the renderer's document/font generation. Changing context discards
    /// old measurements before restoring portable pagination. Repeating it is a no-op.
    pub fn begin_canvas_metric_session(
        &mut self,
        context: MetricContext,
    ) -> Result<(), MetricError> {
        if self.batch_mode {
            return Err(MetricError::EditInProgress);
        }
        if context.backend != MetricBackend::Canvas2d {
            return Err(MetricError::ContextMismatch);
        }
        if self
            .canvas_metrics
            .as_ref()
            .is_some_and(|s| s.context == context)
        {
            return Ok(());
        }
        let was_active = self.canvas_metrics_active();
        self.canvas_metrics = Some(CanvasMetricSession {
            context,
            store: SupplementalMetricStore::new(context),
            enabled: false,
            pending: None,
            prepared_requests: None,
            next_request: 0,
        }); // dropping the old owner invalidates retained TextStyles too
        // [hwpx-cowork] 보충 측정값을 쓰고 있었다면 그 값을 읽은 조판 기억을 버린다(요청 기억은 측정값을 읽지 않는다).
        // 쓰지 않던 문서(스타일에 측정값 없음)는 조판 환경이 그대로다 — 문서를 연 직후 화면이 측정 세션을 처음 열 때
        // 여는 동안 채운 기억을 버리면, 첫 편집의 쪽 나눔이 문서 전체를 다시 계산한다(59쪽 보고서 135ms).
        if self.styles.supplemental_metrics.take().is_some() {
            self.invalidate_measured_layout_memos();
        }
        if was_active {
            self.rebuild_derived_state();
        }
        Ok(())
    }

    /// Validate the whole batch before publishing. Unchanged data does not cause
    /// another pagination pass. Registration alone does not select Canvas2D.
    pub fn register_canvas_metrics(
        &mut self,
        context: MetricContext,
        entries: Vec<SupplementalMetric>,
    ) -> Result<bool, MetricError> {
        if self.batch_mode {
            return Err(MetricError::EditInProgress);
        }
        let session = self
            .canvas_metrics
            .as_mut()
            .ok_or(MetricError::ContextMismatch)?;
        let before = session.store.snapshot();
        session.store.replace(context, entries)?;
        let after = session.store.snapshot();
        let changed = match (&before, &after) {
            (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
            (None, None) => false,
            _ => true,
        };
        if changed && session.enabled {
            self.rebuild_derived_state();
        }
        Ok(changed)
    }

    /// Switch the whole layout context, not just the painter. Portable exports
    /// must use false; a Canvas2D view may restore true after the export ends.
    pub fn select_canvas_metrics(&mut self, enabled: bool) -> Result<bool, MetricError> {
        if self.batch_mode {
            return Err(MetricError::EditInProgress);
        }
        let Some(session) = self.canvas_metrics.as_mut() else {
            return if enabled {
                Err(MetricError::ContextMismatch)
            } else {
                Ok(false)
            };
        };
        if enabled && session.store.snapshot().is_none() {
            return Err(MetricError::ContextMismatch);
        }
        if session.enabled == enabled {
            return Ok(false);
        }
        session.enabled = enabled;
        self.rebuild_derived_state();
        Ok(true)
    }

    pub fn canvas_metrics_active(&self) -> bool {
        self.canvas_metrics.as_ref().is_some_and(|s| s.enabled)
    }

    /// Do not export positions derived from Canvas's implicit fallback to a
    /// backend that cannot paint that same source. Caller must select portable
    /// metrics (and thus rebuild pagination) before enumerating export pages.
    pub(crate) fn require_portable_metrics(&self) -> Result<(), HwpError> {
        if self.canvas_metrics_active() {
            return Err(HwpError::RenderError(
                "Canvas2D supplemental metrics are active; select portable metrics before exporting"
                    .into(),
            ));
        }
        Ok(())
    }
}
