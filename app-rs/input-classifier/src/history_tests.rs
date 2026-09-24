use super::InputHistory;
use crate::InputClassificationSource;
use crate::InputHistoryEntry;
use crate::InputRoute;

#[test]
fn newest_close_history_match_wins_across_routes() {
    let mut history = InputHistory::default();
    history.replace([
        InputHistoryEntry::shell("cargo test"),
        InputHistoryEntry::agent("cargo tests"),
    ]);

    let classification = history.classify("cargo tests").unwrap();

    assert_eq!(classification.route, InputRoute::Agent);
    assert_eq!(
        classification.source,
        InputClassificationSource::HistoryMatch
    );
}

#[test]
fn unrelated_history_does_not_bypass_the_model() {
    let mut history = InputHistory::default();
    history.record(InputHistoryEntry::shell("cargo test"));

    assert!(history.classify("explain this failure").is_none());
}
