use super::ScreenEscapeOutcome;
use super::ScreenEscapeSequence;
use std::time::Duration;
use std::time::Instant;

#[test]
fn second_press_inside_the_window_completes_the_sequence() {
    let mut sequence = ScreenEscapeSequence::default();
    let started = Instant::now();

    assert_eq!(
        sequence.press(started),
        ScreenEscapeOutcome::WaitingForSecondPress
    );
    assert_eq!(
        sequence.press(started + Duration::from_millis(200)),
        ScreenEscapeOutcome::OpenRewind
    );
}

#[test]
fn expired_or_reset_sequences_require_two_new_presses() {
    let mut sequence = ScreenEscapeSequence::default();
    let started = Instant::now();

    assert_eq!(
        sequence.press(started),
        ScreenEscapeOutcome::WaitingForSecondPress
    );
    assert_eq!(
        sequence.press(started + Duration::from_millis(600)),
        ScreenEscapeOutcome::WaitingForSecondPress
    );
    sequence.reset();
    assert_eq!(
        sequence.press(started + Duration::from_millis(700)),
        ScreenEscapeOutcome::WaitingForSecondPress
    );
    assert_eq!(
        sequence.press(started + Duration::from_millis(800)),
        ScreenEscapeOutcome::OpenRewind
    );
}
