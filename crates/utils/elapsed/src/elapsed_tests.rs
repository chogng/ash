use super::format_compact_duration;
use super::format_duration;
use std::time::Duration;

#[test]
fn formats_subsecond_durations_as_milliseconds() {
    assert_eq!(format_duration(Duration::ZERO), "0ms");
    assert_eq!(format_duration(Duration::from_millis(250)), "250ms");
    assert_eq!(format_duration(Duration::from_millis(999)), "999ms");
}

#[test]
fn formats_durations_below_one_minute_as_fractional_seconds() {
    assert_eq!(format_duration(Duration::from_secs(1)), "1.00s");
    assert_eq!(format_duration(Duration::from_millis(1_500)), "1.50s");
    assert_eq!(format_duration(Duration::from_millis(59_999)), "60.00s");
}

#[test]
fn formats_long_durations_as_total_minutes_and_seconds() {
    assert_eq!(format_duration(Duration::from_secs(60)), "1m 00s");
    assert_eq!(format_duration(Duration::from_secs(75)), "1m 15s");
    assert_eq!(format_duration(Duration::from_secs(3_601)), "60m 01s");
}

#[test]
fn formats_long_running_status_durations_as_compact_whole_seconds() {
    assert_eq!(format_compact_duration(Duration::ZERO), "0s");
    assert_eq!(
        format_compact_duration(Duration::from_millis(59_999)),
        "59s"
    );
    assert_eq!(format_compact_duration(Duration::from_secs(62)), "1m 02s");
    assert_eq!(
        format_compact_duration(Duration::from_secs(3_789)),
        "1h 03m 09s"
    );
    assert_eq!(
        format_compact_duration(Duration::from_secs(86_399)),
        "23h 59m 59s"
    );
    assert_eq!(
        format_compact_duration(Duration::from_secs(86_400)),
        "1d 00h"
    );
    assert_eq!(
        format_compact_duration(Duration::from_secs(258_987)),
        "2d 23h"
    );
}
