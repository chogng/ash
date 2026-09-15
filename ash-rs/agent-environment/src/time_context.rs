use crate::AgentEnvironmentError;
use ash_protocol::TimeContext;
use ash_protocol::TimeContextMode;
use ash_protocol::TimeZoneOrigin;
use chrono::DateTime;
use chrono::FixedOffset;
use chrono::Offset;
use chrono::SecondsFormat;
use chrono::Utc;
use chrono_tz::Tz;

/// Validates an explicit IANA time zone; no local-zone substitution occurs on error.
pub fn validate_time_zone(value: &str) -> Result<(), AgentEnvironmentError> {
    parse_zone(value).map(|_| ())
}

/// Validated immutable clock facts with deterministic calendar rendering and no I/O.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeSnapshot {
    facts: TimeContext,
    instant: DateTime<Utc>,
    offset: FixedOffset,
}

impl TimeSnapshot {
    /// Resolves the calendar offset once when sampling; the facts can then be persisted.
    pub fn capture(
        sampled_at_unix_ms: ash_protocol::UnixMillis,
        time_zone: String,
        origin: TimeZoneOrigin,
        mode: TimeContextMode,
    ) -> Result<Self, AgentEnvironmentError> {
        let zone = parse_zone(&time_zone)?;
        let instant = DateTime::from_timestamp_millis(sampled_at_unix_ms.get() as i64)
            .ok_or_else(|| invalid("time context timestamp is out of range"))?;
        let utc_offset_seconds = instant
            .with_timezone(&zone)
            .offset()
            .fix()
            .local_minus_utc();
        Self::new(TimeContext {
            sampled_at_unix_ms,
            time_zone,
            utc_offset_seconds,
            origin,
            mode,
        })
    }

    pub fn new(facts: TimeContext) -> Result<Self, AgentEnvironmentError> {
        if facts.mode == TimeContextMode::Off {
            return Err(invalid("disabled time context must be absent"));
        }
        parse_zone(&facts.time_zone)?;
        let offset = FixedOffset::east_opt(facts.utc_offset_seconds)
            .ok_or_else(|| invalid("UTC offset is out of range"))?;
        let instant = DateTime::from_timestamp_millis(facts.sampled_at_unix_ms.get() as i64)
            .ok_or_else(|| invalid("time context timestamp is out of range"))?;
        Ok(Self {
            facts,
            instant,
            offset,
        })
    }

    pub fn facts(&self) -> &TimeContext {
        &self.facts
    }

    /// Current snapshot belongs after reusable history, never in the durable user text.
    pub fn render(&self) -> String {
        let (field, value) = self.value();
        format!(
            "<time_context>\n{field}: {value}\ntime_zone: {} ({})\nUse each message's user_time for relative dates; unavailable means its original calendar is unknown. This is a request-preparation snapshot.\n</time_context>",
            self.facts.time_zone,
            self.origin(),
        )
    }

    /// This annotation stays attached to its original user input across later requests.
    pub fn render_reference(&self) -> String {
        let (field, value) = self.value();
        format!(
            "<user_time {field}=\"{value}\" time_zone=\"{}\" origin=\"{}\" />",
            self.facts.time_zone,
            self.origin()
        )
    }

    fn value(&self) -> (&'static str, String) {
        let local = self.instant.with_timezone(&self.offset);
        match self.facts.mode {
            TimeContextMode::Date => ("date", local.format("%Y-%m-%d").to_string()),
            TimeContextMode::Time => ("time", local.to_rfc3339_opts(SecondsFormat::Secs, false)),
            TimeContextMode::Off => unreachable!("validated snapshot is enabled"),
        }
    }

    fn origin(&self) -> &'static str {
        match self.facts.origin {
            TimeZoneOrigin::Host => "host",
            TimeZoneOrigin::Configured => "configured",
        }
    }
}

fn parse_zone(value: &str) -> Result<Tz, AgentEnvironmentError> {
    if value.is_empty() || value.len() > 128 {
        return Err(invalid(
            "time zone must be a non-empty IANA identifier of at most 128 bytes",
        ));
    }
    value
        .parse()
        .map_err(|_| invalid("unrecognized IANA time zone"))
}

fn invalid(message: &str) -> AgentEnvironmentError {
    AgentEnvironmentError::InvalidTime {
        message: message.into(),
    }
}

#[cfg(test)]
#[path = "time_context_tests.rs"]
mod tests;
