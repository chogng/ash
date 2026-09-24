use std::time::Duration;
use std::time::Instant;

use super::Hover;
use super::HoverPresence;

#[test]
fn immediate_hover_enters_and_leaves_with_pointer_presence() {
    let now = Instant::now();
    let mut hover = Hover::default();

    assert!(hover.pointer_presence(HoverPresence::Over, now));
    assert!(hover.is_hovered());
    assert!(hover.pointer_presence(HoverPresence::Outside, now));
    assert!(!hover.is_hovered());
}

#[test]
fn delayed_hover_exposes_one_deadline_and_can_be_cancelled() {
    let now = Instant::now();
    let delay = Duration::from_millis(300);
    let mut hover = Hover::new(delay);

    assert!(!hover.pointer_presence(HoverPresence::Over, now));
    assert_eq!(hover.next_deadline(), Some(now + delay));
    assert!(!hover.advance(now + delay - Duration::from_millis(1)));
    assert!(!hover.pointer_presence(HoverPresence::Outside, now));
    assert_eq!(hover.next_deadline(), None);
    assert!(!hover.is_hovered());
}

#[test]
fn delayed_hover_enters_at_deadline() {
    let now = Instant::now();
    let delay = Duration::from_millis(300);
    let mut hover = Hover::new(delay);

    hover.pointer_presence(HoverPresence::Over, now);

    assert!(hover.advance(now + delay));
    assert!(hover.is_hovered());
    assert_eq!(hover.next_deadline(), None);
}
