use super::*;

#[test]
fn delayed_hardware_capture_cannot_reenter_after_unmute() {
    let shared = Shared::new(1, 48_000, 48_000);
    let old = shared.clock;
    shared.recording.store(false, Ordering::Release);
    assert!(!shared.capture_allowed(old, 1));
    shared.capture_epoch.store(2, Ordering::Release);
    shared.capture_cutoff.store(10_000_000, Ordering::Release);
    shared.recording.store(true, Ordering::Release);
    assert!(!shared.capture_allowed(old, 2));
    assert!(!shared.capture_allowed(old + Duration::from_millis(20), 1));
    assert!(shared.capture_allowed(old + Duration::from_millis(20), 2));
}
