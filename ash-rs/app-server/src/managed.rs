//! Profile-wide service runtime executed by `ash-app-server --managed`.

mod registry;

use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::ManagedEndpoint;
use ash_app_server_transport::LocalConnections;

use registry::ProfileAppServerRegistry;

const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const IDLE_TIMEOUT_ENV: &str = "ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS";
const STOP_GRACE_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) fn run(profile_root: PathBuf) -> Result<(), String> {
    let registry = Arc::new(ProfileAppServerRegistry::open(ConnectionOptions::new(
        &profile_root,
        None,
        GrantSource::HostConfiguration,
        None,
    ))?);
    let idle_timeout = configured_idle_timeout()?;
    let mut endpoint = ManagedEndpoint::bind(&profile_root)?;
    let mut automation = Some(registry.start_automation()?);
    let mut queue = Some(registry.start_queue()?);
    let active_connections = Arc::new(LocalConnections::new());
    let mut idle_since = None;
    let mut stopping_since = None;
    let mut connection_shutdown_since = None;
    loop {
        if endpoint.is_stopping() {
            drop(automation.take());
            drop(queue.take());
            let stopping_since = stopping_since.get_or_insert_with(Instant::now);
            if active_connections.is_empty() && registry.active_terminal_count() == 0 {
                exit_after_stop(endpoint);
            }
            if stopping_since.elapsed() >= STOP_GRACE_TIMEOUT {
                let shutdown_since = connection_shutdown_since.get_or_insert_with(|| {
                    active_connections.shutdown_all();
                    Instant::now()
                });
                if active_connections.is_empty()
                    || shutdown_since.elapsed() >= STOP_CONNECTION_DRAIN_TIMEOUT
                {
                    exit_after_stop(endpoint);
                }
            }
            thread::sleep(IDLE_POLL_INTERVAL);
            continue;
        }
        if let Some(connection) = endpoint.poll_connection()? {
            idle_since = None;
            let server = match registry.server_for(connection.options) {
                Ok(server) => server,
                Err(error) => {
                    eprintln!("managed App Server directory runtime failed: {error}");
                    continue;
                }
            };
            let shutdown_stream = connection
                .writer
                .try_clone()
                .map_err(|error| error.to_string())?;
            let registration = active_connections
                .register(shutdown_stream)
                .map_err(|error| error.to_string())?;
            thread::Builder::new()
                .name("ash-local-app-server-connection".into())
                .spawn(move || {
                    let _registration = registration;
                    if let Err(error) =
                        server.serve_product_host_jsonl(connection.reader, connection.writer)
                        && !is_peer_disconnect(&error)
                    {
                        eprintln!("managed App Server connection failed: {error}");
                    }
                })
                .map_err(|error| error.to_string())?;
        } else {
            if endpoint.is_stopping() {
                continue;
            }
            if active_connections.is_empty()
                && registry.active_terminal_count() == 0
                && !registry.automation_needs_host()?
                && !registry.queue_needs_host()?
            {
                let idle_since = idle_since.get_or_insert_with(Instant::now);
                if idle_since.elapsed() >= idle_timeout {
                    return Ok(());
                }
            } else {
                idle_since = None;
            }
            thread::sleep(IDLE_POLL_INTERVAL);
        }
    }
}

fn exit_after_stop(endpoint: ManagedEndpoint) -> ! {
    eprintln!("managed App Server stopped");
    let _ = io::stderr().flush();
    drop(endpoint);
    // Background runtime destructors must not exceed the managed shutdown deadline.
    std::process::exit(0);
}

fn configured_idle_timeout() -> Result<Duration, String> {
    let Some(value) = std::env::var_os(IDLE_TIMEOUT_ENV) else {
        return Ok(DEFAULT_IDLE_TIMEOUT);
    };
    let millis = value
        .to_string_lossy()
        .parse::<u64>()
        .map_err(|_| format!("{IDLE_TIMEOUT_ENV} must be milliseconds"))?;
    if millis < IDLE_POLL_INTERVAL.as_millis() as u64 {
        return Err(format!(
            "{IDLE_TIMEOUT_ENV} must be at least {}",
            IDLE_POLL_INTERVAL.as_millis()
        ));
    }
    Ok(Duration::from_millis(millis))
}

fn is_peer_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;
