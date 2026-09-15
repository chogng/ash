use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use std::collections::HashMap;
use std::collections::HashSet;

const MAX_BATCH_ENTRIES: usize = 256;
const MAX_BATCH_TEXT_BYTES: usize = 1024 * 1024;
const MAX_BATCH_UPDATES: usize = 1024;

/// Coalesces complete transient transcript values until an ordering barrier is reached.
pub(crate) struct TranscriptBatch {
    update: ThreadTranscriptUpdateEnvelope,
    positions: HashMap<String, usize>,
    text_bytes: usize,
    update_count: usize,
}

impl TranscriptBatch {
    pub(crate) fn start(
        mut update: ThreadTranscriptUpdateEnvelope,
    ) -> Result<Self, ThreadTranscriptUpdateEnvelope> {
        if !is_transient_upsert(&update) {
            return Err(update);
        }
        let unique_entries = update
            .changes
            .iter()
            .filter_map(|change| match change {
                ThreadTranscriptChange::Upsert { entry } => Some(entry.entry_id()),
                ThreadTranscriptChange::Remove { .. } | ThreadTranscriptChange::ClearTransient => {
                    None
                }
            })
            .collect::<HashSet<_>>();
        if unique_entries.len() > MAX_BATCH_ENTRIES {
            return Err(update);
        }

        let mut entries = Vec::with_capacity(update.changes.len().min(MAX_BATCH_ENTRIES));
        let mut positions = HashMap::new();
        for change in std::mem::take(&mut update.changes) {
            let ThreadTranscriptChange::Upsert { entry } = change else {
                unreachable!("transcript batch only accepts transient upserts");
            };
            let entry_id = entry.entry_id().to_owned();
            if let Some(index) = positions.get(&entry_id).copied() {
                entries[index] = ThreadTranscriptChange::Upsert { entry };
            } else {
                positions.insert(entry_id, entries.len());
                entries.push(ThreadTranscriptChange::Upsert { entry });
            }
        }
        update.changes = entries;
        let text_bytes = update.changes.iter().map(change_text_bytes).sum();
        if text_bytes > MAX_BATCH_TEXT_BYTES {
            return Err(update);
        }
        Ok(Self {
            update,
            positions,
            text_bytes,
            update_count: 1,
        })
    }

    pub(crate) fn push(
        &mut self,
        mut next: ThreadTranscriptUpdateEnvelope,
    ) -> Result<(), ThreadTranscriptUpdateEnvelope> {
        if !self.accepts(&next) || !self.has_capacity_for(&next) {
            return Err(next);
        }

        self.update.stream_cursor = next.stream_cursor.take();
        self.update.revision = next.revision;
        for change in next.changes {
            let ThreadTranscriptChange::Upsert { entry } = change else {
                unreachable!("transcript batch only accepts transient upserts");
            };
            let entry_id = entry.entry_id().to_owned();
            if let Some(index) = self.positions.get(&entry_id).copied() {
                self.text_bytes -= change_text_bytes(&self.update.changes[index]);
                self.text_bytes += entry_text_bytes(&entry);
                self.update.changes[index] = ThreadTranscriptChange::Upsert { entry };
            } else {
                self.positions.insert(entry_id, self.update.changes.len());
                self.text_bytes += entry_text_bytes(&entry);
                self.update
                    .changes
                    .push(ThreadTranscriptChange::Upsert { entry });
            }
        }
        self.update_count += 1;
        Ok(())
    }

    pub(crate) fn finish(self) -> ThreadTranscriptUpdateEnvelope {
        self.update
    }

    fn accepts(&self, next: &ThreadTranscriptUpdateEnvelope) -> bool {
        if !is_transient_upsert(next)
            || next.session_id != self.update.session_id
            || next.thread_id != self.update.thread_id
            || next.durable_sequence != self.update.durable_sequence
        {
            return false;
        }

        let Some(current) = self.update.stream_cursor.as_ref() else {
            return false;
        };
        let Some(next_cursor) = next.stream_cursor.as_ref() else {
            return false;
        };
        current.stream_instance_id == next_cursor.stream_instance_id
            && current.sequence.checked_add(1) == Some(next_cursor.sequence)
            && self.update.revision.checked_add(1) == Some(next.revision)
    }

    fn has_capacity_for(&self, next: &ThreadTranscriptUpdateEnvelope) -> bool {
        let mut added = HashSet::new();
        for change in &next.changes {
            let ThreadTranscriptChange::Upsert { entry } = change else {
                return false;
            };
            if !self.positions.contains_key(entry.entry_id()) {
                added.insert(entry.entry_id());
            }
        }
        if self.update_count >= MAX_BATCH_UPDATES
            || self.positions.len() + added.len() > MAX_BATCH_ENTRIES
        {
            return false;
        }

        let mut replacements = HashMap::new();
        for change in &next.changes {
            let ThreadTranscriptChange::Upsert { entry } = change else {
                return false;
            };
            replacements.insert(entry.entry_id(), entry_text_bytes(entry));
        }
        let mut text_bytes = self.text_bytes;
        for (entry_id, replacement_bytes) in replacements {
            if let Some(index) = self.positions.get(entry_id).copied() {
                text_bytes =
                    text_bytes.saturating_sub(change_text_bytes(&self.update.changes[index]));
            }
            text_bytes = text_bytes.saturating_add(replacement_bytes);
            if text_bytes > MAX_BATCH_TEXT_BYTES {
                return false;
            }
        }
        true
    }
}

fn change_text_bytes(change: &ThreadTranscriptChange) -> usize {
    match change {
        ThreadTranscriptChange::Upsert { entry } => entry_text_bytes(entry),
        ThreadTranscriptChange::Remove { .. } | ThreadTranscriptChange::ClearTransient => 0,
    }
}

fn entry_text_bytes(
    entry: &ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry,
) -> usize {
    use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;

    match entry {
        ThreadTranscriptEntry::Item { item, .. } => match item {
            ash_protocol::ThreadItem::UserMessage { text, .. }
            | ash_protocol::ThreadItem::AgentMessage { text, .. }
            | ash_protocol::ThreadItem::Reasoning { text, .. }
            | ash_protocol::ThreadItem::Plan { text, .. } => text.len(),
            _ => 0,
        },
        ThreadTranscriptEntry::ToolOutput { text, .. } => text.len(),
        ThreadTranscriptEntry::TurnError { error, .. } => error.message.len(),
        ThreadTranscriptEntry::TurnPlan { .. } => 0,
    }
}

fn is_transient_upsert(update: &ThreadTranscriptUpdateEnvelope) -> bool {
    update.stream_cursor.is_some()
        && !update.changes.is_empty()
        && update.changes.iter().all(|change| {
            matches!(
                change,
                ThreadTranscriptChange::Upsert { entry } if entry.is_transient()
            )
        })
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
