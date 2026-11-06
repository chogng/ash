//! Profile-wide service runtime executed by `ash-app-server --managed`.

mod execution;
mod gateway;
pub(crate) use gateway::probe_runtime;
mod registry;
mod ssh;
mod web;
pub(crate) use gateway::task_request;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::ConnectionRole;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::ManagedConnection;
use ash_app_server_daemon::ManagedEndpoint;
use ash_app_server_protocol::protocol::initialize::TransportHelloResult;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_app_server_protocol::protocol::registry::client_method;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcSuccess;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_app_server_transport::LocalConnections;
use std::io;
use std::io::BufRead;
use std::io::Cursor;
use std::io::Read;
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

pub(crate) fn run(
    profile_root: PathBuf,
    product_services: Option<PathBuf>,
    diff_handler: crate::DiffRequestHandler,
    build_info: build_info::BuildInfo,
) -> Result<(), String> {
    // Keep progress enforcement alive while profile owners and connection workers
    // are being dropped as well as while the endpoint loop is serving traffic.
    let watchdog = process_hardening::ProcessWatchdog::start(Duration::from_secs(60))
        .map_err(|error| error.to_string())?;
    let startup_trace = ash_app_server_daemon::startup_trace::StartupTrace::from_environment();
    let _trace = ash_app_server_daemon::startup_trace::StartupTrace::enter(startup_trace);
    let startup = ash_app_server_daemon::startup_trace::StartupTrace::span("managed-startup");
    let history_open = ash_app_server_daemon::startup_trace::StartupTrace::span("managed-history");
    let history = ash_state::SqliteThreadStore::open(profile_root.join("state.sqlite3"))
        .map_err(|error| error.to_string())?;
    drop(history_open);
    let profile_open = ash_app_server_daemon::startup_trace::StartupTrace::span("managed-profile");
    // Once ownership transfers, this host is execution-only. Opening the profile services
    // would replay old Turns and restart automation against history owned by the receiver.
    let registry = match history
        .history_receiver()
        .map_err(|error| error.to_string())?
    {
        Some(_) => None,
        None => Some(Arc::new(ProfileAppServerRegistry::open_with_terminal_host(
            ConnectionOptions::new(
                &profile_root,
                None,
                GrantSource::HostConfiguration,
                product_services,
            ),
            diff_handler,
            Some(std::env::current_exe().map_err(|error| error.to_string())?),
            build_info,
        )?)),
    };
    drop(history);
    drop(profile_open);
    let idle_timeout = configured_idle_timeout()?;
    let connection_contract = match &registry {
        Some(_) => ash_app_server_daemon::ManagedConnectionContract::Agent {
            protocol_version:
                ash_app_server_protocol::protocol::initialize::ProtocolVersion::current(),
        },
        None => ash_app_server_daemon::ManagedConnectionContract::Execution,
    };
    let bind = ash_app_server_daemon::startup_trace::StartupTrace::span("managed-bind");
    let mut endpoint = ManagedEndpoint::bind(&profile_root, connection_contract)?;
    drop(bind);
    drop(startup);
    drop(_trace);
    // Keep the endpoint leased until directory and profile destructors finish, so a
    // new generation cannot open the same profile while its old services stop.
    let registry = registry;
    let _automatic_updates = ash_app_server_daemon::start_automatic_updates(&profile_root)?;
    let mut symphony = registry
        .as_ref()
        .map(|registry| registry.start_symphony())
        .transpose()?;
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
    let mut connection_workers = ConnectionWorkers {
        connections: Arc::clone(&active_connections),
        workers: Vec::new(),
    };
    let mut idle_since = None;
    let mut stopping_since = None;
    loop {
        watchdog.tick();
        connection_workers.reap();
        if endpoint.is_stopping() {
            // Keep lifecycle status observable during the grace period. The
            // endpoint rejects business admission after the stop flag is set.
            let _ = endpoint.poll_connection()?;
            if stopping_since.is_none() {
                execution.stop()?;
            }
            drop(symphony.take());
            drop(automation.take());
            drop(queue.take());
            let stopping_since = stopping_since.get_or_insert_with(Instant::now);
            if active_connections.is_empty()
                && registry
                    .as_ref()
                    .is_none_or(|registry| registry.active_terminal_count() == 0)
                && !execution.needs_host()?
            {
                return Ok(());
            }
            if stopping_since.elapsed() >= STOP_GRACE_TIMEOUT {
                // The connection owner closes sockets and joins their workers before
                // directory services drop. The daemon owns the process stop deadline.
                return Ok(());
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
            let worker = thread::Builder::new()
                .name("ash-local-app-server-connection".into())
                .spawn(move || {
                    let _registration = registration;
                    let _trace = ash_app_server_daemon::startup_trace::StartupTrace::enter(connection.startup_trace.take());
                    if let ConnectionRole::Execution { environment, .. } = connection.options.role() {
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
                    if connection.options.role() == ConnectionRole::Workbench && connection.web.is_none() {
                        if let Err(error) = serve_workbench(&web_registry, connection)
                            && !is_peer_disconnect(&error)
                        {
                            eprintln!("managed App Server connection failed: {error}");
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
                    if connection.options.role() == ConnectionRole::Credentials {
                        let shutdown = connection.writer.try_clone().ok();
                        if let Err(error) = server.serve_host_credentials(connection.reader, connection.writer)
                            && !is_peer_disconnect(&error)
                        {
                            eprintln!("managed private credential connection failed: {error}");
                        }
                        if let Some(stream) = shutdown { let _ = stream.shutdown(std::net::Shutdown::Both); }
                        return;
                    }
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
                    } else if connection.options.role() == ConnectionRole::Remote {
                        server.serve_remote_stream(connection.reader, connection.writer)
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
            connection_workers.workers.push(worker);
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
            endpoint.wait_for_activity(IDLE_POLL_INTERVAL)?;
        }
    }
}

fn serve_workbench(
    registry: &ProfileAppServerRegistry,
    mut connection: ManagedConnection,
) -> io::Result<()> {
    let shutdown = connection.writer.try_clone()?;
    let server = thread::scope(|scope| {
        let handshake = thread::Builder::new()
            .name("ash-workbench-transport-hello".into())
            .spawn_scoped(scope, || {
                read_workbench_hello(&mut connection.reader, &mut connection.writer)
            })?;
        // Directory preparation keeps its existing connection thread and trace.
        // A slow directory cannot hold the protocol identity response.
        let server = registry.server_for(connection.options);
        if server.is_err() {
            // Wake the reader if startup fails before the client sends its first frame.
            let _ = shutdown.shutdown(std::net::Shutdown::Both);
        }
        let first = handshake
            .join()
            .map_err(|_| io::Error::other("App Server handshake worker panicked"))?;
        Ok::<_, io::Error>((server.map_err(io::Error::other)?, first?))
    })?;
    let (server, first) = server;
    match first {
        WorkbenchFirstFrame::Hello(id) => {
            server.serve_product_host_stream_after_hello(connection.reader, connection.writer, id)
        }
        WorkbenchFirstFrame::Replay(first) => server.serve_product_host_stream(
            Cursor::new(first).chain(connection.reader),
            connection.writer,
        ),
    }
}

enum WorkbenchFirstFrame {
    Hello(u64),
    Replay(Vec<u8>),
}

fn read_workbench_hello(
    reader: impl BufRead,
    writer: impl Write,
) -> io::Result<WorkbenchFirstFrame> {
    let Some(first) = JsonlReader::new(reader, DEFAULT_MAX_MESSAGE_BYTES).read_message()? else {
        return Ok(WorkbenchFirstFrame::Replay(Vec::new()));
    };
    if let Ok(request) = serde_json::from_str::<JsonRpcRequest<()>>(&first)
        && client_method(&request.method) == Some(ClientMethod::TransportHello)
        && let Some(id) = request.id.as_u64().filter(|id| *id > 0)
    {
        let response = JsonRpcSuccess::new(request.id, TransportHelloResult::current());
        let message = serde_json::to_string(&response).map_err(io::Error::other)?;
        JsonlWriter::new(writer, DEFAULT_MAX_MESSAGE_BYTES).write_message(&message)?;
        return Ok(WorkbenchFirstFrame::Hello(id));
    }
    // Existing clients still send initialize first. Replay the frame verbatim
    // through the normal dispatcher without discarding buffered follow-up frames.
    let mut first = first.into_bytes();
    first.push(b'\n');
    Ok(WorkbenchFirstFrame::Replay(first))
}

fn profile_needs_host(registry: &Option<Arc<ProfileAppServerRegistry>>) -> Result<bool, String> {
    match registry {
        Some(registry) => Ok(registry.automation_needs_host()?
            || registry.queue_needs_host()?
            || registry.symphony_needs_host()?),
        None => Ok(false),
    }
}

struct ConnectionWorkers {
    connections: Arc<LocalConnections>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl ConnectionWorkers {
    fn reap(&mut self) {
        let mut index = 0;
        while index < self.workers.len() {
            if self.workers[index].is_finished() {
                if self.workers.swap_remove(index).join().is_err() {
                    eprintln!("managed App Server connection worker panicked");
                }
            } else {
                index += 1;
            }
        }
    }
}

impl Drop for ConnectionWorkers {
    fn drop(&mut self) {
        self.connections.shutdown_all();
        for worker in self.workers.drain(..) {
            if worker.join().is_err() {
                eprintln!("managed App Server connection worker panicked");
            }
        }
    }
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
