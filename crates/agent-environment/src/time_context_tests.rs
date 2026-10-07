use super::*;
use ash_protocol::UnixMillis;

fn snapshot(at: &str, zone: &str, mode: TimeContextMode) -> TimeSnapshot {
    let millis = DateTime::parse_from_rfc3339(at).unwrap().timestamp_millis() as u64;
    TimeSnapshot::capture(
        UnixMillis::new(millis).unwrap(),
        zone.into(),
        TimeZoneOrigin::Configured,
        mode,
    )
    .unwrap()
}

#[test]
fn time_context_separates_current_day_from_an_immutable_input_reference() {
    let reference = snapshot(
        "2026-09-13T06:59:50Z",
        "America/Los_Angeles",
        TimeContextMode::Date,
    );
    let current = snapshot(
        "2026-09-13T07:00:05Z",
        "America/Los_Angeles",
        TimeContextMode::Date,
    );
    assert!(reference.render_reference().contains("date=\"2026-09-12\""));
    assert!(current.render().contains("date: 2026-09-13"));
    assert!(reference.render_reference().contains("date=\"2026-09-12\""));
    assert!(!current.render().contains("07:00"));
}

#[test]
fn time_context_handles_zone_boundaries_and_repeated_dst_hours() {
    let tokyo = snapshot("2026-09-12T23:30:00Z", "Asia/Tokyo", TimeContextMode::Time);
    assert!(tokyo.render().contains("2026-09-13T08:30:00+09:00"));
    let first = snapshot(
        "2026-11-01T08:30:00Z",
        "America/Los_Angeles",
        TimeContextMode::Time,
    );
    let second = snapshot(
        "2026-11-01T09:30:00Z",
        "America/Los_Angeles",
        TimeContextMode::Time,
    );
    assert!(
        first
            .render_reference()
            .contains("2026-11-01T01:30:00-07:00")
    );
    assert!(
        second
            .render_reference()
            .contains("2026-11-01T01:30:00-08:00")
    );
    assert_ne!(
        first.facts().sampled_at_unix_ms,
        second.facts().sampled_at_unix_ms
    );
}

#[test]
fn time_context_rejects_invalid_calendar_facts_instead_of_substituting_a_zone() {
    for zone in ["", "Mars/Base", "UTC\"><injected>", " America/Los_Angeles"] {
        assert!(validate_time_zone(zone).is_err());
    }
    let mut facts = snapshot("2026-01-01T00:00:00Z", "UTC", TimeContextMode::Time)
        .facts()
        .clone();
    facts.mode = TimeContextMode::Off;
    assert!(TimeSnapshot::new(facts).is_err());
}

#[test]
fn time_context_restores_the_recorded_offset_without_reinterpreting_the_calendar() {
    let mut recorded = snapshot(
        "2026-09-13T07:00:05Z",
        "America/Los_Angeles",
        TimeContextMode::Time,
    )
    .facts()
    .clone();
    // A retained fact is authoritative even when today's zone rules differ.
    recorded.utc_offset_seconds = -8 * 60 * 60;
    let restored = TimeSnapshot::new(recorded.clone()).unwrap();
    assert!(
        restored
            .render_reference()
            .contains("2026-09-12T23:00:05-08:00")
    );
    assert_eq!(restored.facts(), &recorded);
    recorded.utc_offset_seconds = 86_400;
    assert!(TimeSnapshot::new(recorded).is_err());
}
