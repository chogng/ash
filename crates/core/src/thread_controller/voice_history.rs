use super::ThreadController;
use crate::CoreError;
use ash_protocol::VoiceHistoryCoverage;
use ash_protocol::VoiceHistoryEntry;
use ash_protocol::VoiceHistoryPage;
use ash_protocol::VoiceHistoryQuery;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    query: VoiceHistoryQuery,
    snapshot: u64,
    after: u64,
}

impl ThreadController {
    /// Reads immutable voice revisions without loading a live Thread or its Turn history.
    pub fn read_voice_history(
        &self,
        request: &VoiceHistoryQuery,
    ) -> Result<VoiceHistoryPage, CoreError> {
        let invalid = || CoreError::InvalidInput("invalid voice history query or cursor".into());
        if !(1..=500).contains(&request.limit)
            || request
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.len() > 8192)
            || request.filter.voice_session_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
            })
            || request.filter.event_id.as_ref().is_some_and(|id| {
                id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)
            })
            || request
                .filter
                .from_recorded_at_ms
                .zip(request.filter.to_recorded_at_ms)
                .is_some_and(|(from, to)| from >= to)
            || [
                Some(request.after_sequence),
                request.snapshot_sequence,
                request.required_sequence,
                request.filter.from_recorded_at_ms,
                request.filter.to_recorded_at_ms,
            ]
            .into_iter()
            .flatten()
            .any(|value| value > 9_007_199_254_740_991)
        {
            return Err(invalid());
        }
        let session = self
            .read_session_catalog(&request.session_id)?
            .ok_or_else(|| CoreError::NotFound(request.session_id.to_string()))?;
        if !session
            .threads
            .iter()
            .any(|thread| thread.thread_id == request.thread_id)
        {
            return Err(CoreError::NotFound(request.thread_id.to_string()));
        }
        let mut query = request.clone();
        query.cursor = None;
        query.snapshot_sequence = None;
        query.limit = 0;
        // Keep every generated cursor within the same bound accepted on the next page.
        if ash_utils_string::serialized_json_bytes(&query).map_err(|_| invalid())? > 4096 {
            return Err(invalid());
        }
        let cursor = request
            .cursor
            .as_ref()
            .map(|value| serde_json::from_str::<Cursor>(value).map_err(|_| invalid()))
            .transpose()?;
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.version != 1
                || cursor.snapshot > 9_007_199_254_740_991
                || cursor.query != query
                || request
                    .snapshot_sequence
                    .is_some_and(|snapshot| snapshot != cursor.snapshot)
                || cursor.after <= request.after_sequence
                || cursor.after > cursor.snapshot
        }) {
            return Err(invalid());
        }
        let after = cursor
            .as_ref()
            .map_or(request.after_sequence, |cursor| cursor.after);
        let snapshot = cursor
            .as_ref()
            .map(|cursor| cursor.snapshot)
            .or(request.snapshot_sequence);
        let page = self.store.read_voice_events(
            &request.thread_id,
            after,
            snapshot,
            &request.filter,
            request.limit as usize + 1,
        )?;
        let snapshot = snapshot.unwrap_or(page.current_sequence);
        if request.after_sequence > snapshot {
            return Err(invalid());
        }
        let mut result = VoiceHistoryPage {
            entries: Vec::new(),
            next_cursor: None,
            snapshot_sequence: snapshot,
            committed_sequence: page.current_sequence,
            coverage: VoiceHistoryCoverage::Ready,
        };
        if snapshot > page.current_sequence
            || request
                .required_sequence
                .is_some_and(|required| required > page.current_sequence)
        {
            result.coverage = VoiceHistoryCoverage::Pending;
            return Ok(result);
        }
        let has_more = page.events.len() > request.limit as usize;
        for event in page.events.into_iter().take(request.limit as usize) {
            let ash_protocol::ThreadEvent::VoiceTranscriptRecorded { transcript, .. } = event.event
            else {
                return Err(CoreError::Journal(
                    "voice history contains a non-voice event".into(),
                ));
            };
            result.entries.push(VoiceHistoryEntry {
                event_id: event.event_id.0,
                sequence: event.sequence,
                recorded_at_unix_ms: u64::try_from(event.recorded_at.0)
                    .map_err(|_| CoreError::Journal("voice timestamp exceeds u64".into()))?,
                transcript,
            });
        }
        if has_more && let Some(last) = result.entries.last() {
            result.next_cursor = Some(
                serde_json::to_string(&Cursor {
                    version: 1,
                    query,
                    snapshot,
                    after: last.sequence,
                })
                .map_err(|error| CoreError::Journal(error.to_string()))?,
            );
        }
        // An exact acknowledgement may arrive before another store makes its commit visible.
        // A known event excluded by other filters is still covered by this snapshot.
        if result.entries.is_empty()
            && let Some(event_id) = &request.filter.event_id
        {
            let exact = self.store.read_voice_events(
                &request.thread_id,
                0,
                Some(snapshot),
                &ash_protocol::VoiceHistoryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                },
                1,
            )?;
            if exact.events.is_empty() {
                result.coverage = VoiceHistoryCoverage::Pending;
            }
        }
        Ok(result)
    }
}
