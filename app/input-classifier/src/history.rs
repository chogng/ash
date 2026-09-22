use difflib::sequencematcher::SequenceMatcher;

use crate::InputClassification;
use crate::InputClassificationSource;
use crate::InputRoute;

const HISTORY_ENTRY_MATCH_CUTOFF: f32 = 0.9;

/// One chronological user submission available to history-aware classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputHistoryEntry {
    text: String,
    route: InputRoute,
}

impl InputHistoryEntry {
    /// Creates an Agent prompt history entry.
    pub fn agent(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            route: InputRoute::Agent,
        }
    }

    /// Creates a direct Shell command history entry.
    pub fn shell(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            route: InputRoute::Shell,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct InputHistory {
    entries: Vec<InputHistoryEntry>,
}

impl InputHistory {
    pub(super) fn replace(&mut self, entries: impl IntoIterator<Item = InputHistoryEntry>) -> bool {
        let entries: Vec<_> = entries
            .into_iter()
            .filter(|entry| !entry.text.trim().is_empty())
            .collect();
        if self.entries == entries {
            return false;
        }
        self.entries = entries;
        true
    }

    pub(super) fn record(&mut self, entry: InputHistoryEntry) {
        if entry.text.trim().is_empty() {
            return;
        }
        self.entries.push(entry);
    }

    pub(super) fn classify(&self, input: &str) -> Option<InputClassification> {
        let mut matcher = SequenceMatcher::new("", input);
        self.entries.iter().rev().find_map(|entry| {
            matcher.set_first_seq(&entry.text);
            (real_quick_ratio(&entry.text, input) >= HISTORY_ENTRY_MATCH_CUTOFF
                && matcher.ratio() >= HISTORY_ENTRY_MATCH_CUTOFF)
                .then(|| {
                    InputClassification::deterministic(
                        entry.route,
                        InputClassificationSource::HistoryMatch,
                    )
                })
        })
    }
}

fn real_quick_ratio(left: &str, right: &str) -> f32 {
    let total = left.len() + right.len();
    if total == 0 {
        1.0
    } else {
        2.0 * left.len().min(right.len()) as f32 / total as f32
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
