use crate::ExecEventSink;
use crate::ExecOutcome;
use crate::ExecRunRequest;
use crate::ExecSinkError;
use crate::connection::ExecConnection;
use crate::connection::ServerConnection;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_async_utils::CancellationToken;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use thiserror::Error;

/// Read-only cancellation signal polled by a synchronous headless run.
///
/// Implementations must make `is_cancelled` cheap and non-blocking. The runner maps the first
/// observed cancellation after Turn creation to a typed App Server `InterruptTurn` command.
pub trait ExecCancellation {
    fn is_cancelled(&self) -> bool;
}

impl<R> ExecCancellation for CancellationToken<R> {
    fn is_cancelled(&self) -> bool {
        CancellationToken::is_cancelled(self)
    }
}

impl ExecCancellation for AtomicBool {
    fn is_cancelled(&self) -> bool {
        self.load(Ordering::Acquire)
    }
}

impl<T> ExecCancellation for Arc<T>
where
    T: ExecCancellation + ?Sized,
{
    fn is_cancelled(&self) -> bool {
        self.as_ref().is_cancelled()
    }
}

/// Bounded wait policy for one headless Turn and its cancellation handshake.
#[derive(Clone, Copy, Debug)]
pub struct ExecRunnerOptions {
    pub(crate) turn_timeout: Duration,
    pub(crate) interrupt_timeout: Duration,
    pub(crate) event_poll_interval: Duration,
}

impl ExecRunnerOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_turn_timeout(mut self, timeout: Duration) -> Self {
        self.turn_timeout = timeout;
        self
    }

    pub fn with_interrupt_timeout(mut self, timeout: Duration) -> Self {
        self.interrupt_timeout = timeout;
        self
    }

    pub fn with_event_poll_interval(mut self, interval: Duration) -> Self {
        self.event_poll_interval = interval;
        self
    }
}

impl Default for ExecRunnerOptions {
    fn default() -> Self {
        Self {
            turn_timeout: Duration::from_secs(60),
            interrupt_timeout: Duration::from_secs(5),
            event_poll_interval: Duration::from_millis(50),
        }
    }
}

/// Runs one Agent Turn through a shared App Server client session.
pub struct ExecRunner {
    command: StdioAppServerCommand,
    client_info: ClientInfo,
    options: ExecRunnerOptions,
}

impl ExecRunner {
    pub fn new(command: StdioAppServerCommand, client_info: ClientInfo) -> Self {
        Self {
            command,
            client_info,
            options: ExecRunnerOptions::default(),
        }
    }

    pub fn with_options(mut self, options: ExecRunnerOptions) -> Self {
        self.options = options;
        self
    }

    pub fn run<S, K>(
        &self,
        request: ExecRunRequest,
        mut sink: S,
        cancellation: &K,
    ) -> Result<ExecOutcome, ExecError>
    where
        S: ExecEventSink,
        K: ExecCancellation + ?Sized,
    {
        self.validate(&request)?;
        if cancellation.is_cancelled() {
            return Err(ExecError::CancelledBeforeStart);
        }
        let mut connection =
            ServerConnection::start_stdio(self.command.clone(), self.client_info.clone())
                .map_err(|error| ExecError::StartAppServer(error.to_string()))?;
        let result = self.run_connected(&mut connection, request, &mut sink, cancellation);
        let shutdown = connection.close();
        match (result, shutdown) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(ExecError::Shutdown(error.to_string())),
            (Ok(outcome), Ok(())) => Ok(outcome),
        }
    }

    fn validate(&self, request: &ExecRunRequest) -> Result<(), ExecError> {
        if request.entry.input().is_empty() {
            return Err(ExecError::InvalidRequest(
                "a headless run requires at least one input item".into(),
            ));
        }
        for (name, duration) in [
            ("turn timeout", self.options.turn_timeout),
            ("interrupt timeout", self.options.interrupt_timeout),
            ("event poll interval", self.options.event_poll_interval),
        ] {
            if duration.is_zero() {
                return Err(ExecError::InvalidRequest(format!(
                    "{name} must be greater than zero"
                )));
            }
        }
        let now = Instant::now();
        for (name, duration) in [
            ("turn timeout", self.options.turn_timeout),
            ("interrupt timeout", self.options.interrupt_timeout),
        ] {
            if now.checked_add(duration).is_none() {
                return Err(ExecError::InvalidRequest(format!("{name} is too large")));
            }
        }
        Ok(())
    }

    fn run_connected<C, S, K>(
        &self,
        connection: &mut C,
        request: ExecRunRequest,
        sink: &mut S,
        cancellation: &K,
    ) -> Result<ExecOutcome, ExecError>
    where
        C: ExecConnection,
        S: ExecEventSink + ?Sized,
        K: ExecCancellation + ?Sized,
    {
        crate::run_loop::run_connected(self.options, connection, request, sink, cancellation)
    }
}

#[derive(Debug, Error)]
pub enum ExecError {
    #[error("invalid exec request: {0}")]
    InvalidRequest(String),
    #[error("headless run was cancelled before a Turn started")]
    CancelledBeforeStart,
    #[error("could not start App Server: {0}")]
    StartAppServer(String),
    #[error("App Server {operation} failed: {message}")]
    AppServer {
        operation: &'static str,
        message: String,
    },
    #[error("event output failed: {0}")]
    Output(#[from] ExecSinkError),
    #[error("App Server shutdown failed: {0}")]
    Shutdown(String),
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
