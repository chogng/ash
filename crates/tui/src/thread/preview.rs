use super::ThreadPresentationEvent;
use super::ThreadState;
use super::transcript::CellView;
use super::transcript::TranscriptScrollDirection;
use super::transcript::first_scroll_target;
use super::transcript::scroll_target;
use super::transcript::viewport::PreviewViewport;
use crate::render::RenderContext;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ratatui::layout::Rect;
use std::collections::BTreeSet;

/// A read-only conversation snapshot with its own history and request lifecycle.
#[derive(Debug)]
pub(crate) struct ConversationPreview {
    pub(crate) generation: u64,
    pub(crate) title: String,
    request: SessionThreadReadParams,
    thread: ThreadState,
    boundary: Option<ThreadHistoryBoundary>,
    loading: bool,
    error: Option<String>,
}

impl ConversationPreview {
    pub(crate) fn session_id(&self) -> &ash_protocol::SessionId {
        &self.request.session_id
    }

    pub(crate) fn new(generation: u64, title: String, request: SessionThreadReadParams) -> Self {
        Self {
            generation,
            title,
            request,
            thread: Default::default(),
            boundary: None,
            loading: true,
            error: None,
        }
    }

    pub(crate) fn messages(&self) -> Vec<CellView<'_>> {
        self.thread.views(&BTreeSet::new(), None)
    }

    pub(crate) fn notice(&self) -> Option<&str> {
        if self.loading {
            Some("Loading conversation…")
        } else {
            self.error.as_deref()
        }
    }

    pub(crate) fn install(&mut self, result: Result<SessionThreadReadResult, String>) {
        self.loading = false;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        if result.thread.session_id != self.request.session_id
            || result.thread.thread_id != self.request.thread_id
            || result.transcript.session_id != self.request.session_id
            || result.transcript.thread_id != self.request.thread_id
        {
            self.error = Some("Preview response belongs to another conversation".into());
            return;
        }
        let Some(boundary) = result.history else {
            self.error = Some("Preview response is missing its history boundary".into());
            return;
        };
        self.error = None;
        self.boundary = Some(boundary);
        if matches!(
            self.request.history,
            Some(ThreadSnapshotHistory::Before { .. })
        ) {
            self.thread
                .update(ThreadPresentationEvent::TranscriptHistoryPageReceived(
                    result.transcript,
                ));
        } else {
            self.thread
                .update(ThreadPresentationEvent::TranscriptSnapshotReceived(
                    result.transcript,
                ));
        }
    }

    pub(crate) fn navigate(
        &mut self,
        viewport: &mut PreviewViewport,
        direction: TranscriptScrollDirection,
        rows: usize,
        area: Rect,
        header_rows: usize,
        context: RenderContext<'_>,
    ) -> Option<SessionThreadReadParams> {
        let messages = self.messages();
        if let Some(target) = scroll_target(
            area,
            header_rows,
            &messages,
            &viewport.scroll,
            &viewport.cache,
            context,
            direction,
            rows,
        ) && viewport.scroll.apply(target)
        {
            return None;
        }
        if direction == TranscriptScrollDirection::Down || self.loading {
            return None;
        }
        self.older()
    }

    pub(crate) fn first(
        &mut self,
        viewport: &mut PreviewViewport,
    ) -> Option<SessionThreadReadParams> {
        if let Some(target) = first_scroll_target(true, &self.messages()) {
            viewport.scroll.apply(target);
        }
        if self.loading {
            return None;
        }
        self.older()
    }

    fn older(&mut self) -> Option<SessionThreadReadParams> {
        let boundary = self.boundary.as_ref()?;
        if !boundary.has_older_turns {
            return None;
        }
        self.request.history = Some(ThreadSnapshotHistory::Before {
            turn_id: boundary.oldest_turn_id.clone()?,
            turn_limit: 50,
        });
        self.loading = true;
        Some(self.request.clone())
    }
}
