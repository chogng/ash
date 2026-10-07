#[test]
fn revoking_consent_erases_counts_and_stops_recording() {
    let analytics = super::Analytics::default();
    analytics.record(super::UsageEvent::TurnStarted);
    assert!(analytics.snapshot().counts.is_empty());
    analytics.set_enabled(true);
    analytics.record(super::UsageEvent::TurnStarted);
    assert_eq!(
        analytics.snapshot().counts.values().copied().sum::<u64>(),
        1
    );
    analytics.set_enabled(false);
    analytics.record(super::UsageEvent::TurnStarted);
    assert_eq!(analytics.snapshot(), super::UsageSnapshot::default());
}
