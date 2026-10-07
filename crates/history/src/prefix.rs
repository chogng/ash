use crate::StoredEvent;
use ash_protocol::ContentDigest;
use ash_protocol::HistoryPrefixRef;
use serde::Deserialize;
use serde::Serialize;

/// Retained original events. Nested prefix references remain explicit and immutable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HistoryPrefix {
    pub events: Vec<StoredEvent>,
}

impl HistoryPrefix {
    pub fn reference(&self) -> Result<HistoryPrefixRef, String> {
        let first = self
            .events
            .first()
            .ok_or("history prefix must not be empty")?;
        if !matches!(
            &first.event,
            ash_protocol::ThreadEvent::ThreadCreated { .. }
        ) {
            return Err("history prefix must start with ThreadCreated".into());
        }
        for (index, event) in self.events.iter().enumerate() {
            if event.thread_id != first.thread_id
                || event.event.thread_id() != &first.thread_id
                || event.sequence != index as u64 + 1
                || !crate::supports_stored_event_schema_version(event.schema_version)
            {
                return Err(
                    "history prefix records must preserve one original contiguous Thread stream"
                        .into(),
                );
            }
        }
        let encoded = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        Ok(HistoryPrefixRef {
            digest: ContentDigest::sha256(&encoded),
            source_thread_id: first.thread_id.clone(),
            source_sequence: self.events.len() as u64,
        })
    }

    pub fn validate(&self, reference: &HistoryPrefixRef) -> Result<(), String> {
        if &self.reference()? != reference {
            return Err("history prefix digest or source does not match its reference".into());
        }
        Ok(())
    }
}
