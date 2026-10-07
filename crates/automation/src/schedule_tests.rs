use super::*;
use chrono::TimeZone;
use chrono::Utc;

fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> UnixMillis {
    UnixMillis::new(
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64,
    )
    .unwrap()
}

fn weekly(timezone: &str, hour: u8, minute: u8) -> AutomationSchedule {
    AutomationSchedule::Weekly {
        timezone: timezone.into(),
        weekdays: vec![7],
        hour,
        minute,
    }
}

#[test]
fn weekly_skips_missing_spring_clock_time() {
    let rule = weekly("America/New_York", 2, 30);
    assert_eq!(
        next_occurrence(&rule, at(2024, 3, 10, 0, 0)).unwrap(),
        Some(at(2024, 3, 17, 6, 30))
    );
}

#[test]
fn weekly_uses_only_the_first_repeated_autumn_clock_time() {
    let rule = weekly("America/New_York", 1, 30);
    assert_eq!(
        next_occurrence(&rule, at(2024, 11, 3, 0, 0)).unwrap(),
        Some(at(2024, 11, 3, 5, 30))
    );
    assert_eq!(
        next_occurrence(&rule, at(2024, 11, 3, 5, 31)).unwrap(),
        Some(at(2024, 11, 10, 6, 30))
    );
}

#[test]
fn local_daily_rules_cross_leap_day_and_utc_date() {
    let rule = AutomationSchedule::Weekly {
        timezone: "Asia/Shanghai".into(),
        weekdays: (1..=7).collect(),
        hour: 0,
        minute: 30,
    };
    assert_eq!(
        next_occurrence(&rule, at(2024, 2, 28, 16, 31)).unwrap(),
        Some(at(2024, 2, 29, 16, 30))
    );
}

#[test]
fn interval_keeps_its_anchor_and_handles_exact_boundaries() {
    let rule = AutomationSchedule::Interval {
        anchor: UnixMillis::new(10_000).unwrap(),
        minutes: 3,
    };
    for (from, expected) in [
        (0, 10_000),
        (10_000, 10_000),
        (10_001, 190_000),
        (190_000, 190_000),
    ] {
        assert_eq!(
            next_occurrence(&rule, UnixMillis::new(from).unwrap()).unwrap(),
            Some(UnixMillis::new(expected).unwrap())
        );
    }
}

#[test]
fn invalid_rules_and_out_of_range_timestamps_are_rejected() {
    let zero = UnixMillis::new(0).unwrap();
    for rule in [
        AutomationSchedule::Interval {
            anchor: zero,
            minutes: 0,
        },
        weekly("Unknown/Zone", 9, 0),
        weekly("UTC", 24, 0),
        weekly("UTC", 9, 60),
        AutomationSchedule::Weekly {
            timezone: "UTC".into(),
            weekdays: vec![1, 1],
            hour: 9,
            minute: 0,
        },
    ] {
        assert!(next_occurrence(&rule, zero).is_err());
    }
    assert!(serde_json::from_str::<UnixMillis>("-1").is_err());
    assert!(serde_json::from_str::<UnixMillis>("253402300800000").is_err());
    assert_eq!(serde_json::to_string(&zero).unwrap(), "0");
}
