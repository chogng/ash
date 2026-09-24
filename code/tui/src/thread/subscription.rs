use super::request::require_history_boundary;
use super::request::validate_thread_scope;
use super::request::validate_transcript_scope;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::MAX_THREAD_SNAPSHOT_TURNS;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionThreadUnsubscribeParams;
use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptSnapshot;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdateEnvelope;

/// Tracks the server subscription and last canonical snapshot for the active Thread.
///
/// It does not apply Thread events locally. A newer durable sequence asks the caller to read a
/// fresh authoritative snapshot, which keeps the product reducer in Core.
#[derive(Clone, Debug)]
pub(crate) struct ThreadSubscription {
    session_id: SessionId,
    thread_id: ThreadId,
    confirmed_sequence: u64,
    confirmed_transcript_revision: u64,
    history_turn_limit: u32,
    oldest_turn_id: Option<ash_protocol::TurnId>,
    has_older_turns: bool,
}

const HISTORY_PAGE_TURNS: u32 = 50;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ThreadUpdateDisposition {
    Ignore,
    RefreshSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TranscriptUpdateDisposition {
    Ignore,
    Apply,
    RefreshSnapshot,
}

pub(crate) enum ThreadSwitch {
    Complete {
        snapshot: Thread,
        transcript: ThreadTranscriptSnapshot,
    },
    StaleSubscription {
        snapshot: Thread,
        transcript: ThreadTranscriptSnapshot,
        error: ClientError,
    },
}

impl ThreadSubscription {
    pub(crate) fn start<T>(
        client: &mut AppServerClient<T>,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<(Self, Thread, ThreadTranscriptSnapshot), ClientError>
    where
        T: JsonRpcTransport,
    {
        let result = client.subscribe_session_thread(SessionThreadSubscribeParams {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            after_sequence: 0,
            history: Some(ThreadSnapshotHistory::Latest {
                turn_limit: HISTORY_PAGE_TURNS,
            }),
        })?;
        validate_thread_scope(&result.thread, session_id, thread_id)?;
        validate_transcript_scope(&result.transcript, session_id, thread_id)?;
        validate_update_scopes(&result.updates, session_id, thread_id)?;

        let (mut snapshot, mut transcript, boundary) = if result
            .updates
            .iter()
            .any(|update| update.durable_sequence > result.thread.sequence)
        {
            let read = client.read_session_thread(SessionThreadReadParams {
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                history: Some(ThreadSnapshotHistory::Latest {
                    turn_limit: HISTORY_PAGE_TURNS,
                }),
            })?;
            validate_transcript_scope(&read.transcript, session_id, thread_id)?;
            let boundary = require_history_boundary(read.history)?;
            (read.thread, read.transcript, boundary)
        } else {
            let boundary = require_history_boundary(result.history)?;
            (result.thread, result.transcript, boundary)
        };
        validate_thread_scope(&snapshot, session_id, thread_id)?;

        let mut subscription =
            Self::from_snapshot_with_boundary(&snapshot, HISTORY_PAGE_TURNS, Some(boundary));
        subscription.confirmed_transcript_revision = transcript.revision;
        let mut seen = std::collections::BTreeSet::new();
        let mut pages = Vec::new();
        while subscription.has_older_turns {
            let before = subscription.oldest_turn_id.clone().ok_or_else(|| {
                ClientError::Protocol("older history omitted its turn cursor".into())
            })?;
            if !seen.insert(before.clone()) {
                return Err(ClientError::Protocol(
                    "older history cursor did not advance".into(),
                ));
            }
            let page =
                super::request::read_older_thread_history(client, session_id, thread_id, before)?;
            subscription.apply_history_page(&page.thread, page.boundary);
            pages.push((page.thread.turns, page.transcript.entries));
        }
        // Pages arrive newest first. Install them oldest first without replacing
        // the latest snapshot's sequence or transcript revision.
        let mut turns = Vec::new();
        let mut entries = Vec::new();
        for (page_turns, page_entries) in pages.into_iter().rev() {
            turns.extend(page_turns);
            entries.extend(page_entries);
        }
        turns.append(&mut snapshot.turns);
        entries.append(&mut transcript.entries);
        snapshot.turns = turns;
        transcript.entries = entries;
        Ok((subscription, snapshot, transcript))
    }

    pub(crate) fn switch<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Result<ThreadSwitch, ClientError>
    where
        T: JsonRpcTransport,
    {
        if self.session_id == *session_id && self.thread_id == *thread_id {
            let result = client.read_session_thread(SessionThreadReadParams {
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                history: Some(self.history()),
            })?;
            let snapshot = result.thread;
            let transcript = result.transcript;
            validate_transcript_scope(&transcript, session_id, thread_id)?;
            let boundary = require_history_boundary(result.history)?;
            validate_thread_scope(&snapshot, session_id, thread_id)?;
            *self = Self::from_snapshot_with_boundary(
                &snapshot,
                self.history_turn_limit,
                Some(boundary),
            );
            self.confirmed_transcript_revision = transcript.revision;
            return Ok(ThreadSwitch::Complete {
                snapshot,
                transcript,
            });
        }

        let previous_session_id = self.session_id.clone();
        let previous_thread_id = self.thread_id.clone();
        let (next, snapshot, transcript) = Self::start(client, session_id, thread_id)?;
        *self = next;
        let cleanup = client.unsubscribe_session_thread(SessionThreadUnsubscribeParams {
            session_id: previous_session_id,
            thread_id: previous_thread_id,
        });
        match cleanup {
            Ok(()) => Ok(ThreadSwitch::Complete {
                snapshot,
                transcript,
            }),
            Err(error) => Ok(ThreadSwitch::StaleSubscription {
                snapshot,
                transcript,
                error,
            }),
        }
    }

    pub(crate) fn classify_update(
        &mut self,
        update: &ThreadUpdateEnvelope,
    ) -> ThreadUpdateDisposition {
        if update.thread_id != self.thread_id || update.session_id != self.session_id {
            return ThreadUpdateDisposition::Ignore;
        }
        if matches!(update.update, ash_protocol::ThreadUpdate::Committed { .. })
            && update.durable_sequence > self.confirmed_sequence
        {
            return ThreadUpdateDisposition::RefreshSnapshot;
        }
        ThreadUpdateDisposition::Ignore
    }

    pub(crate) fn classify_transcript_update(
        &mut self,
        update: &ThreadTranscriptUpdateEnvelope,
    ) -> TranscriptUpdateDisposition {
        if update.thread_id != self.thread_id || update.session_id != self.session_id {
            return TranscriptUpdateDisposition::Ignore;
        }
        if update.revision <= self.confirmed_transcript_revision {
            return TranscriptUpdateDisposition::Ignore;
        }
        let is_next = self.confirmed_transcript_revision.checked_add(1) == Some(update.revision);
        let resets_transient_state = update
            .changes
            .iter()
            .any(|change| matches!(change, ThreadTranscriptChange::ClearTransient));
        if !is_next && !resets_transient_state {
            return TranscriptUpdateDisposition::RefreshSnapshot;
        }
        self.confirmed_transcript_revision = update.revision;
        TranscriptUpdateDisposition::Apply
    }

    pub(crate) fn confirm_sequence(&mut self, sequence: u64) {
        if sequence > self.confirmed_sequence {
            self.confirmed_sequence = sequence;
        }
    }

    pub(crate) fn history(&self) -> ThreadSnapshotHistory {
        ThreadSnapshotHistory::Latest {
            turn_limit: self.history_turn_limit,
        }
    }

    /// Applies sequence, transcript revision, and history boundary from a latest snapshot.
    pub(crate) fn apply_latest_snapshot(
        &mut self,
        snapshot: &Thread,
        transcript_revision: u64,
        boundary: ThreadHistoryBoundary,
    ) -> bool {
        self.confirm_sequence(snapshot.sequence);
        self.oldest_turn_id = boundary
            .oldest_turn_id
            .clone()
            .or_else(|| snapshot.turns.first().map(|turn| turn.turn_id.clone()));
        self.has_older_turns = boundary.has_older_turns;
        if transcript_revision < self.confirmed_transcript_revision {
            return false;
        }
        self.confirmed_transcript_revision = transcript_revision;
        true
    }

    pub(crate) fn older_history(&self) -> Option<ThreadSnapshotHistory> {
        self.has_older_turns
            .then(|| self.oldest_turn_id.clone())
            .flatten()
            .map(|turn_id| ThreadSnapshotHistory::Before {
                turn_id,
                turn_limit: HISTORY_PAGE_TURNS,
            })
    }

    pub(crate) fn apply_history_page(
        &mut self,
        snapshot: &Thread,
        boundary: ThreadHistoryBoundary,
    ) {
        self.history_turn_limit = self
            .history_turn_limit
            .saturating_add(snapshot.turns.len() as u32)
            .min(MAX_THREAD_SNAPSHOT_TURNS);
        self.oldest_turn_id = boundary
            .oldest_turn_id
            .clone()
            .or_else(|| snapshot.turns.first().map(|turn| turn.turn_id.clone()));
        self.has_older_turns = boundary.has_older_turns;
    }

    #[cfg(test)]
    pub(crate) fn expand_history(&mut self) {
        self.history_turn_limit = self
            .history_turn_limit
            .saturating_add(HISTORY_PAGE_TURNS)
            .min(MAX_THREAD_SNAPSHOT_TURNS);
    }

    #[cfg(test)]
    fn from_snapshot(snapshot: &Thread, history_turn_limit: u32) -> Self {
        Self::from_snapshot_with_boundary(snapshot, history_turn_limit, None)
    }

    fn from_snapshot_with_boundary(
        snapshot: &Thread,
        history_turn_limit: u32,
        boundary: Option<ThreadHistoryBoundary>,
    ) -> Self {
        let oldest_turn_id = boundary
            .as_ref()
            .and_then(|history| history.oldest_turn_id.clone())
            .or_else(|| snapshot.turns.first().map(|turn| turn.turn_id.clone()));
        Self {
            session_id: snapshot.session_id.clone(),
            thread_id: snapshot.thread_id.clone(),
            confirmed_sequence: snapshot.sequence,
            confirmed_transcript_revision: 0,
            history_turn_limit,
            oldest_turn_id,
            has_older_turns: boundary.is_some_and(|history| history.has_older_turns),
        }
    }
}

fn validate_update_scopes(
    updates: &[ThreadUpdateEnvelope],
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<(), ClientError> {
    if let Some(update) = updates
        .iter()
        .find(|update| update.session_id != *session_id || update.thread_id != *thread_id)
    {
        return Err(ClientError::Protocol(format!(
            "thread subscription returned update for {}/{}; expected {session_id}/{thread_id}",
            update.session_id, update.thread_id
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;
