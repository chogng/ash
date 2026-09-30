//! Profile-wide service runtime executed by `ash-app-server --managed`.

mod execution;
mod gateway;
mod registry;
mod ssh;
mod web;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::ConnectionRole;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::ManagedEndpoint;
use ash_app_server_transport::LocalConnections;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use registry::ProfileAppServerRegistry;

const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const IDLE_TIMEOUT_ENV: &str = "ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS";
const STOP_GRACE_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) fn run(profile_root: PathBuf, product_services: Option<PathBuf>) -> Result<(), String> {
    let history = ash_state::SqliteThreadStore::open(profile_root.join("state.sqlite3"))
        .map_err(|error| error.to_string())?;
    // Once ownership transfers, this host is execution-only. Opening the profile services
    // would replay old Turns and restart automation against history owned by the receiver.
    let registry = match history
        .history_receiver()
        .map_err(|error| error.to_string())?
    {
        Some(_) => None,
        None => Some(Arc::new(ProfileAppServerRegistry::open(
            ConnectionOptions::new(
                &profile_root,
                None,
                GrantSource::HostConfiguration,
                product_services,
            ),
        )?)),
    };
    drop(history);
    let idle_timeout = configured_idle_timeout()?;
    let mut endpoint = ManagedEndpoint::bind(&profile_root)?;
    let _automatic_updates = ash_app_server_daemon::start_automatic_updates(&profile_root)?;
    let mut automation = registry
        .as_ref()
        .map(|registry| registry.start_automation())
        .transpose()?;
    let mut queue = registry
        .as_ref()
        .map(|registry| registry.start_queue())
        .transpose()?;
    let active_connections = Arc::new(LocalConnections::new());
    let execution = Arc::new(execution::ExecutionRegistry::default());
    let mut idle_since = None;
    let mut stopping_since = None;
    let mut connection_shutdown_since = None;
    loop {
        if endpoint.is_stopping() {
            if stopping_since.is_none() {
                execution.stop()?;
            }
            drop(automation.take());
            drop(queue.take());
            let stopping_since = stopping_since.get_or_insert_with(Instant::now);
            if active_connections.is_empty()
                && registry
                    .as_ref()
                    .is_none_or(|registry| registry.active_terminal_count() == 0)
                && !execution.needs_host()?
            {
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
        if let Some(mut connection) = endpoint.poll_connection()? {
            idle_since = None;
            let shutdown_stream = connection
                .writer
                .try_clone()
                .map_err(|error| error.to_string())?;
            let registration = active_connections
                .register(shutdown_stream)
                .map_err(|error| error.to_string())?;
            let web_registry = registry.clone();
            let execution_registry = Arc::clone(&execution);
            thread::Builder::new()
                .name("ash-local-app-server-connection".into())
                .spawn(move || {
                    let _registration = registration;
                    if let ConnectionRole::Execution { environment } = connection.options.role() {
                        if let Err(error) = execution_registry.serve(connection, &environment) {
                            eprintln!("managed execution connection failed: {error}");
                        }
                        return;
                    }
                    let Some(web_registry) = web_registry else {
                        eprintln!("managed profile history belongs to another host; only execution connections are allowed");
                        return;
                    };
                    if let Some(target) = connection.options.ssh().cloned() {
                        if let Err(error) = ssh::serve(connection, &target)
                            && !is_peer_disconnect(&error)
                        {
                            eprintln!("managed SSH connection failed: {error}");
                        }
                        return;
                    }
                    let server = match web_registry.server_for(connection.options.clone()) {
                        Ok(server) => server,
                        Err(error) => {
                            eprintln!("managed App Server directory runtime failed: {error}");
                            return;
                        }
                    };
                    if let Some(options) = connection.web.take() {
                        if let Err(error) = web::serve(server, web_registry, connection, options) {
                            eprintln!("Managed Web listener failed: {error}");
                        }
                        return;
                    }
                    let served = if connection.options.role() == ConnectionRole::Agents {
                        gateway::serve(
                            web_registry,
                            server,
                            connection.reader,
                            connection.writer,
                            gateway::RemoteLaunch::from_environment(),
                        )
                    } else {
                        server.serve_product_host_stream(connection.reader, connection.writer)
                    };
                    if let Err(error) = served
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
                && !endpoint.has_pending_connections()
                && registry
                    .as_ref()
                    .is_none_or(|registry| registry.active_terminal_count() == 0)
                && !execution.needs_host()?
                && !profile_needs_host(&registry)?
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

fn profile_needs_host(registry: &Option<Arc<ProfileAppServerRegistry>>) -> Result<bool, String> {
    match registry {
        Some(registry) => Ok(registry.automation_needs_host()? || registry.queue_needs_host()?),
        None => Ok(false),
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
