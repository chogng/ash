use std::time::{Duration, Instant};

use super::{CaretBlinkAdvance, CaretBlinkController, CaretVisibility};

const INTERVAL: Duration = Duration::from_millis(500);

#[test]
fn focus_starts_with_a_visible_caret_and_a_deadline() {
    let now = Instant::now();
    let mut blink = CaretBlinkController::new(INTERVAL);

    blink.focus(now);

    assert_eq!(blink.visibility(), CaretVisibility::Visible);
    assert_eq!(blink.next_deadline(), now.checked_add(INTERVAL));
}

#[test]
fn advancing_toggles_only_after_the_deadline() {
    let now = Instant::now();
    let mut blink = CaretBlinkController::new(INTERVAL);
    blink.focus(now);

    assert_eq!(
        blink.advance(now + Duration::from_millis(499)),
        CaretBlinkAdvance::Unchanged
    );
    assert_eq!(
        blink.advance(now + INTERVAL),
        CaretBlinkAdvance::VisibilityChanged(CaretVisibility::Hidden)
    );
}

#[test]
fn delayed_wakeup_preserves_the_elapsed_blink_phase() {
    let now = Instant::now();
    let mut blink = CaretBlinkController::new(INTERVAL);
    blink.focus(now);

    assert_eq!(
        blink.advance(now + Duration::from_millis(1_500)),
        CaretBlinkAdvance::VisibilityChanged(CaretVisibility::Hidden)
    );
    assert_eq!(
        blink.next_deadline(),
        now.checked_add(Duration::from_millis(2_000))
    );
}

#[test]
fn activity_restarts_the_visible_phase_only_while_focused() {
    let now = Instant::now();
    let activity = now + Duration::from_millis(750);
    let mut blink = CaretBlinkController::new(INTERVAL);

    blink.activity(activity);
    assert_eq!(blink.visibility(), CaretVisibility::Hidden);
    assert_eq!(blink.next_deadline(), None);

    blink.focus(now);
    blink.advance(now + INTERVAL);
    blink.activity(activity);
    assert_eq!(blink.visibility(), CaretVisibility::Visible);
    assert_eq!(blink.next_deadline(), activity.checked_add(INTERVAL));
}

#[test]
fn blur_stops_blinking_and_hides_the_caret() {
    let now = Instant::now();
    let mut blink = CaretBlinkController::new(INTERVAL);
    blink.focus(now);

    blink.blur();

    assert_eq!(blink.visibility(), CaretVisibility::Hidden);
    assert_eq!(blink.next_deadline(), None);
    assert_eq!(blink.advance(now + INTERVAL), CaretBlinkAdvance::Unchanged);
}
