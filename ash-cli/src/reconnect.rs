use std::time::Duration;

const WINDOW: Duration = Duration::from_secs(30);
const INITIAL_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(2);

pub(super) enum Failure {
    Retryable(String),
    Terminal(String),
}

pub(super) fn recovery_error(error: impl std::fmt::Display, command: &[String]) -> String {
    format!("{error}\nReconnect: {}", format_command(command))
}

fn format_command(command: &[String]) -> String {
    command
        .iter()
        .map(|argument| quote_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_argument(argument: &str) -> String {
    if !argument.is_empty()
        && argument.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':' | b'@')
        })
    {
        argument.to_owned()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

pub(super) fn retry<T>(
    connection_name: &str,
    initial_reason: &str,
    mut reconnect: impl FnMut() -> Result<T, Failure>,
    mut wait: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
    mut report: impl FnMut(usize, Duration),
) -> Result<T, String> {
    let mut attempts = 0;
    let mut last_reason = initial_reason.to_owned();
    loop {
        let Some(delay) = delay_within_window(elapsed(), attempts) else {
            return Err(format!(
                "{connection_name} did not recover within {} seconds after {attempts} attempts: {last_reason}",
                WINDOW.as_secs()
            ));
        };
        attempts += 1;
        report(attempts, delay);
        wait(delay);
        match reconnect() {
            Ok(ready) => return Ok(ready),
            Err(Failure::Retryable(error)) => last_reason = error,
            Err(Failure::Terminal(error)) => return Err(error),
        }
    }
}

fn delay_within_window(elapsed: Duration, attempt: usize) -> Option<Duration> {
    let remaining = WINDOW.checked_sub(elapsed)?;
    let delay = delay(attempt);
    (delay <= remaining).then_some(delay)
}

fn delay(attempt: usize) -> Duration {
    let multiplier = 1_u32 << (attempt.min(31) as u32);
    (INITIAL_DELAY * multiplier).min(MAX_DELAY)
}

#[cfg(test)]
#[path = "reconnect_tests.rs"]
mod tests;
