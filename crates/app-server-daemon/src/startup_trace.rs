//! Opt-in connection diagnostics. Durations use a local Instant, never another process's clock.

use serde::Deserialize;
use serde::Serialize;
use std::cell::RefCell;
use std::io::Write;
use std::marker::PhantomData;
use std::rc::Rc;
use std::time::Instant;

pub(crate) const ID_ENV: &str = "ASH_DESKTOP_STARTUP_TRACE_ID";
pub(crate) const CARRIER_PID_ENV: &str = "ASH_DESKTOP_STARTUP_TRACE_CARRIER_PID";

thread_local! {
    // Only synchronous startup scopes use this context. New connection workers enter
    // their validated prelude explicitly; the long-lived daemon never inherits a lease.
    static CURRENT: RefCell<Option<StartupTrace>> = const { RefCell::new(None) };
}

/// Credential-free lineage linking a precreated carrier to its probe and client connection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupTrace {
    id: String,
    carrier_pid: u32,
    scope: TraceScope,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum TraceScope {
    Connection,
    Probe,
}

impl StartupTrace {
    /// Reads only explicit diagnostic inputs; malformed diagnostics do not break startup.
    pub fn from_environment() -> Option<Self> {
        if std::env::var("ASH_DESKTOP_STARTUP_TRACE").as_deref() != Ok("1") {
            return None;
        }
        let trace = Self {
            id: std::env::var(ID_ENV).ok()?,
            carrier_pid: match std::env::var(CARRIER_PID_ENV) {
                Ok(pid) => pid.parse().ok()?,
                Err(std::env::VarError::NotPresent) => std::process::id(),
                Err(_) => return None,
            },
            scope: TraceScope::Connection,
        };
        trace.validate().ok()?;
        Some(trace)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.carrier_pid == 0
            || self.id.len() != 36
            || !self.id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            })
        {
            return Err("invalid startup trace identity".into());
        }
        Ok(())
    }

    /// Captures lineage for a child worker or a private connection prelude.
    pub fn current() -> Option<Self> {
        CURRENT.with(|current| current.borrow().clone())
    }

    /// Enters one synchronous owner scope and restores its predecessor on every exit path.
    pub fn enter(trace: Option<Self>) -> StartupTraceScope {
        StartupTraceScope {
            previous: CURRENT.with(|current| current.replace(trace)),
            thread: PhantomData,
        }
    }

    pub(crate) fn probe(mut self) -> Self {
        self.scope = TraceScope::Probe;
        self
    }

    pub(crate) fn apply_to(&self, command: &mut std::process::Command) {
        command
            .env(ID_ENV, &self.id)
            .env(CARRIER_PID_ENV, self.carrier_pid.to_string());
    }

    /// Records scope lifetime, including error returns. Presence alone does not imply success.
    pub fn span(phase: &'static str) -> Option<StartupSpan> {
        Self::current().map(|trace| StartupSpan {
            trace,
            phase,
            start: Instant::now(),
        })
    }
}

/// Thread-bound restoration guard; it cannot carry one connection's context to another worker.
pub struct StartupTraceScope {
    previous: Option<StartupTrace>,
    thread: PhantomData<Rc<()>>,
}

impl Drop for StartupTraceScope {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.previous.take()));
    }
}

/// Emits only fixed phase names, process identity and a local duration to diagnostic stderr.
pub struct StartupSpan {
    trace: StartupTrace,
    phase: &'static str,
    start: Instant,
}

impl Drop for StartupSpan {
    fn drop(&mut self) {
        let record = serde_json::json!({
            "traceId": self.trace.id,
            "carrierPid": self.trace.carrier_pid,
            "pid": std::process::id(),
            "scope": self.trace.scope,
            "phase": self.phase,
            "durationMs": self.start.elapsed().as_secs_f64() * 1000.0,
        });
        // One bounded line under the stderr lock, separate from protocol stdout. A closed
        // diagnostic consumer must never change the connection's result.
        let _ = writeln!(std::io::stderr().lock(), "ASH_STARTUP_TRACE {record}");
    }
}

#[cfg(test)]
#[path = "startup_trace_tests.rs"]
mod tests;
