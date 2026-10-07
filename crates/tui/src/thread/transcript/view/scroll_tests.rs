use super::ChatHistoryScroll;
use super::TranscriptScrollAnchor;
use super::TranscriptScrollTarget;

#[test]
fn transcript_scroll_switches_between_a_stable_anchor_and_follow_latest() {
    let mut scroll = ChatHistoryScroll::default();
    let anchor = TranscriptScrollAnchor::Cell {
        cell_id: "message-2".into(),
        line_offset: 3,
    };

    assert_eq!(scroll.anchor(), None);
    assert!(scroll.apply(TranscriptScrollTarget::Anchor(anchor.clone())));
    assert_eq!(scroll.anchor(), Some(&anchor));
    assert!(!scroll.apply(TranscriptScrollTarget::Anchor(anchor)));

    scroll.follow_latest();
    assert_eq!(scroll.anchor(), None);
}
