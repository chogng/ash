use crate::AutomationError;
use ash_protocol::AutomationDefinition;
use ash_protocol::AutomationSchedule;
use ash_protocol::UnixMillis;
use chrono::DateTime;
use chrono::Datelike;
use chrono::Days;
use chrono::TimeZone;
use chrono_tz::Tz;

#[cfg(test)]
#[path = "schedule_tests.rs"]
mod tests;

pub fn validate_definition(definition: &AutomationDefinition) -> Result<(), AutomationError> {
    for (label, value, max) in [
        ("title", definition.title.as_str(), 200),
        ("prompt", definition.prompt.as_str(), 100_000),
        ("directory", definition.directory.as_str(), 4_096),
    ] {
        if value.trim().is_empty() || value.len() > max || value.contains('\0') {
            return Err(AutomationError::Invalid(format!(
                "{label} is empty or exceeds its limit"
            )));
        }
    }
    if !std::path::Path::new(&definition.directory).is_absolute() {
        return Err(AutomationError::Invalid(
            "directory must be absolute".into(),
        ));
    }
    validate_schedule(&definition.schedule)
}

fn validate_schedule(schedule: &AutomationSchedule) -> Result<(), AutomationError> {
    match schedule {
        AutomationSchedule::Once { .. } => Ok(()),
        AutomationSchedule::Interval { minutes, .. } if (1..=525_600).contains(minutes) => Ok(()),
        AutomationSchedule::Weekly {
            timezone,
            weekdays,
            hour,
            minute,
        } => {
            timezone
                .parse::<Tz>()
                .map_err(|_| AutomationError::Invalid("unknown IANA timezone".into()))?;
            if *hour > 23
                || *minute > 59
                || weekdays.is_empty()
                || weekdays.len() > 7
                || weekdays.iter().any(|day| !(1..=7).contains(day))
                || weekdays
                    .iter()
                    .enumerate()
                    .any(|(index, day)| weekdays[..index].contains(day))
            {
                return Err(AutomationError::Invalid(
                    "invalid weekly clock or weekdays".into(),
                ));
            }
            Ok(())
        }
        _ => Err(AutomationError::Invalid(
            "interval must be at least one minute".into(),
        )),
    }
}

/// Returns the first occurrence at or after `from`, selecting the earlier ambiguous local time
/// and skipping nonexistent local times. Persisted rules retain their timezone and anchor.
pub fn next_occurrence(
    schedule: &AutomationSchedule,
    from: UnixMillis,
) -> Result<Option<UnixMillis>, AutomationError> {
    validate_schedule(schedule)?;
    match schedule {
        AutomationSchedule::Once { at } => Ok((*at >= from).then_some(*at)),
        AutomationSchedule::Interval { anchor, minutes } => {
            let interval = u64::from(*minutes) * 60_000;
            let count = from.get().saturating_sub(anchor.get()).div_ceil(interval);
            let next = count
                .checked_mul(interval)
                .and_then(|offset| anchor.get().checked_add(offset));
            Ok(next.and_then(|value| UnixMillis::new(value).ok()))
        }
        AutomationSchedule::Weekly {
            timezone,
            weekdays,
            hour,
            minute,
        } => {
            let timezone: Tz = timezone
                .parse()
                .map_err(|_| AutomationError::Invalid("unknown IANA timezone".into()))?;
            let now = DateTime::from_timestamp_millis(from.get() as i64)
                .ok_or_else(|| AutomationError::Invalid("unsupported timestamp".into()))?;
            let mut date = now.with_timezone(&timezone).date_naive();
            // Weekly rules have at least one selected day. Two weeks spans a skipped DST date.
            for _ in 0..15 {
                if weekdays.contains(&(date.weekday().number_from_monday() as u8)) {
                    let local = date
                        .and_hms_opt(u32::from(*hour), u32::from(*minute), 0)
                        .ok_or_else(|| AutomationError::Invalid("invalid local time".into()))?;
                    if let Some(candidate) = timezone.from_local_datetime(&local).earliest() {
                        let millis = candidate.timestamp_millis();
                        if millis >= from.get() as i64 {
                            return Ok(UnixMillis::new(millis as u64).ok());
                        }
                    }
                }
                let Some(next) = date.checked_add_days(Days::new(1)) else {
                    return Ok(None);
                };
                date = next;
            }
            Err(AutomationError::Invalid(
                "no occurrence within the supported weekly window".into(),
            ))
        }
    }
}
