use std::time::Duration;

/// Converts a duration into a compact, human-readable execution time.
///
/// Durations below one second use integer milliseconds, durations below one minute use seconds
/// with two decimal places, and longer durations use total minutes plus whole seconds.
#[must_use]
pub fn format_duration(duration: Duration) -> String {
    let millis = duration.as_millis();
    if millis < 1_000 {
        format!("{millis}ms")
    } else if millis < 60_000 {
        format!("{:.2}s", millis as f64 / 1_000.0)
    } else {
        let minutes = millis / 60_000;
        let seconds = millis % 60_000 / 1_000;
        format!("{minutes}m {seconds:02}s")
    }
}

/// Converts a duration into the compact whole-second form used by long-running status surfaces.
///
/// The result uses seconds below one minute, minutes and seconds below one hour, hours, minutes,
/// and seconds below one day, and days and hours for longer durations.
#[must_use]
pub fn format_compact_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        return format!("{seconds}s");
    }
    if seconds < 3_600 {
        let minutes = seconds / 60;
        let seconds = seconds % 60;
        return format!("{minutes}m {seconds:02}s");
    }
    if seconds < 86_400 {
        let hours = seconds / 3_600;
        let minutes = seconds % 3_600 / 60;
        let seconds = seconds % 60;
        return format!("{hours}h {minutes:02}m {seconds:02}s");
    }
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3_600;
    format!("{days}d {hours:02}h")
}

#[cfg(test)]
#[path = "elapsed_tests.rs"]
mod tests;
