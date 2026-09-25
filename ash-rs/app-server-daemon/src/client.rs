use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::net::Shutdown;
use std::path::Path;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_uds::UnixStream;
use serde_json::Value;
use serde_json::json;

use crate::ConnectionOptions;
use crate::LifecycleCommand;
use crate::LifecycleOutput;
use crate::LifecycleStatus;
use crate::endpoint::EndpointPaths;
use crate::endpoint::connect_existing;
use crate::process::BackendExecutable;
use crate::process::ExecutableIdentity;
use crate::process::ProcessRecord;
use crate::process::force_terminate;
use crate::process::read_process_record;
use crate::process::record_is_active;
use crate::process::remove_matching_process_record;
use crate::process::remove_stale_process_record;
use crate::process::resolve_backend_executable;
use crate::process::spawn_backend;
use crate::wire::ConnectionPrelude;
use crate::wire::ControlCommand;
use crate::wire::ControlPrelude;
use crate::wire::ControlResponse;
use crate::wire::ControlState;
use crate::wire::write_json_line;
use ash_app_server_transport::DeadlineStream;
use ash_app_server_transport::relay_output;

const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProbeInfo {
    server_name: String,
    schema_hash: String,
}

pub(crate) fn run_lifecycle(
    command: LifecycleCommand,
    options: ConnectionOptions,
    backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    let endpoint = EndpointPaths::prepare(options.profile_root())?;
    let _operation_lock = endpoint.acquire_operation_lock()?;
    match command {
        LifecycleCommand::Start => start_unlocked(&endpoint, &options, backend_executable),
        LifecycleCommand::EnsureSelected => {
            ensure_selected_unlocked(&endpoint, &options, backend_executable)
        }
        LifecycleCommand::Restart => {
            let _ = stop_unlocked(&endpoint)?;
            let mut output = start_unlocked(&endpoint, &options, backend_executable)?;
            output.status = LifecycleStatus::Restarted;
            Ok(output)
        }
        LifecycleCommand::Stop => stop_unlocked(&endpoint),
        LifecycleCommand::Version => version_unlocked(&endpoint, &options),
    }
}

pub(crate) fn connect(options: ConnectionOptions, backend_executable: &Path) -> Result<(), String> {
    run_lifecycle(LifecycleCommand::Start, options.clone(), backend_executable)?;
    connect_ready(&options)
}

pub(crate) fn connect_selected(
    options: ConnectionOptions,
    backend_executable: &Path,
) -> Result<(), String> {
    run_lifecycle(
        LifecycleCommand::EnsureSelected,
        options.clone(),
        backend_executable,
    )?;
    connect_ready(&options)
}

fn connect_ready(options: &ConnectionOptions) -> Result<(), String> {
    let endpoint = EndpointPaths::prepare(options.profile_root())?;
    let stream = connect_existing(&endpoint.socket)?
        .ok_or_else(|| "Local App Server daemon exited before the client connected".to_string())?;
    proxy_stdio(stream, options).map_err(|error| error.to_string())
}

pub(crate) fn launch_web(
    options: ConnectionOptions,
    mut web: ash_app_server_protocol::WebLaunchOptions,
    backend_executable: &Path,
) -> Result<(), String> {
    use std::io::Write;
    use std::sync::mpsc;
    run_lifecycle(LifecycleCommand::Start, options.clone(), backend_executable)?;
    let endpoint = EndpointPaths::prepare(options.profile_root())?;
    let workspace = dunce::canonicalize(
        options
            .dir_root()
            .ok_or("Web launch requires a workspace")?,
    )
    .map_err(io_error)?;
    let directory = ash_app_server_transport::browser_session_directory(
        options.profile_root(),
        &workspace,
        web.origin.as_deref(),
        &web.lease_id,
    );
    let (events, receiver) = mpsc::channel();
    let input_events = events.clone();
    thread::Builder::new()
        .name("ash-web-lease-input".into())
        .spawn(move || {
            let _ = io::stdin().lock().read(&mut [0_u8; 1]);
            let _ = input_events.send(true);
        })
        .map_err(io_error)?;
    let mut published = false;
    loop {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(true) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            _ => {}
        }
        let Some(control) = request_control(&endpoint, ControlCommand::Status)? else {
            continue;
        };
        if control.state == ControlState::Stopping {
            continue;
        }
        validate_managed_response(&endpoint, &control)?;
        let Some(stream) = connect_existing(&endpoint.socket)? else {
            continue;
        };
        let mut stream =
            DeadlineStream::new(stream, Instant::now() + START_TIMEOUT).map_err(io_error)?;
        let mut prelude = ConnectionPrelude::from_options(&options);
        prelude.web = Some(web.clone());
        write_json_line(&mut stream, &prelude).map_err(io_error)?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        (&mut reader)
            .take(16_385)
            .read_line(&mut line)
            .map_err(io_error)?;
        if line.len() > 16_384 || !line.ends_with('\n') {
            return Err("Invalid Web listener response".into());
        }
        let info: ash_app_server_protocol::WebListenInfo =
            serde_json::from_str(&line).map_err(|error| error.to_string())?;
        let port = info
            .endpoint
            .strip_prefix("http://127.0.0.1:")
            .and_then(|value| value.strip_suffix('/'))
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or("Invalid Web listener endpoint")?;
        if published && port != web.port {
            return Err("Web listener changed its port".into());
        }
        web.port = port;
        reader.get_mut().clear_deadline().map_err(io_error)?;
        let shutdown = reader.get_ref().try_clone().map_err(io_error)?;
        if !published {
            io::stdout()
                .lock()
                .write_all(line.as_bytes())
                .map_err(io_error)?;
            io::stdout().lock().flush().map_err(io_error)?;
            published = true;
        }
        let closed_events = events.clone();
        let closed = thread::Builder::new()
            .name("ash-web-lease-backend".into())
            .spawn(move || {
                let _ = reader.read(&mut [0_u8; 1]);
                let _ = closed_events.send(false);
            })
            .map_err(io_error)?;
        let stopping = receiver.recv().unwrap_or(true);
        let _ = shutdown.shutdown(Shutdown::Both);
        closed
            .join()
            .map_err(|_| "Web lease reader panicked".to_string())?;
        if stopping {
            break;
        }
    }
    if published {
        match std::fs::remove_file(directory.join(format!("{}.session", web.port))) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn start_unlocked(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
    backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    if let Some(control) = request_control(endpoint, ControlCommand::Status)? {
        if control.state == ControlState::Stopping {
            return Err("Local App Server daemon is stopping".into());
        }
        validate_managed_response(endpoint, &control)?;
        let probe = probe_app_server(endpoint, options)
            .map_err(|error| diagnostic_error(endpoint, &error))?;
        return Ok(lifecycle_output(
            LifecycleStatus::AlreadyRunning,
            endpoint,
            Some(&control),
            Some(&probe),
        ));
    }

    let daemon = resolve_backend_executable(backend_executable)?;
    start_new_unlocked(endpoint, options, &daemon)
}

fn start_new_unlocked(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
    daemon: &BackendExecutable,
) -> Result<LifecycleOutput, String> {
    remove_stale_process_record(&endpoint.pid)?;
    let mut spawned = spawn_backend(endpoint, options, &daemon.path)?;
    let result = (|| {
        let deadline = Instant::now() + START_TIMEOUT;
        let mut last_error = None;
        while Instant::now() < deadline {
            if let Some(status) = spawned.exit_status()? {
                return Err(diagnostic_error(
                    endpoint,
                    &format!("App Server exited before initialization: {status}"),
                ));
            }
            match request_control(endpoint, ControlCommand::Status) {
                Ok(Some(control)) if control.state == ControlState::Running => {
                    let record = validate_managed_response(endpoint, &control)
                        .map_err(|error| diagnostic_error(endpoint, &error))?;
                    validate_executable_identity(&record, &daemon.identity)
                        .map_err(|error| diagnostic_error(endpoint, &error))?;
                    let probe = probe_app_server(endpoint, options)
                        .map_err(|error| diagnostic_error(endpoint, &error))?;
                    return Ok(lifecycle_output(
                        LifecycleStatus::Started,
                        endpoint,
                        Some(&control),
                        Some(&probe),
                    ));
                }
                Ok(Some(_)) | Ok(None) => {}
                Err(error) => last_error = Some(error),
            }
            thread::sleep(CONNECT_RETRY_INTERVAL);
        }
        let reason = last_error.unwrap_or_else(|| "daemon control endpoint was unavailable".into());
        Err(diagnostic_error(
            endpoint,
            &format!("Local App Server daemon did not become ready: {reason}"),
        ))
    })();
    match result {
        Ok(output) => {
            spawned.release();
            Ok(output)
        }
        Err(error) => {
            spawned
                .abort()
                .map_err(|cleanup| format!("{error}; startup cleanup failed: {cleanup}"))?;
            Err(error)
        }
    }
}

fn ensure_selected_unlocked(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
    backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    let selected = resolve_backend_executable(backend_executable)?;
    let mut replaced = false;
    if let Some(control) = request_control(endpoint, ControlCommand::Status)? {
        if control.state == ControlState::Stopping {
            return Err("Local App Server daemon is stopping".into());
        }
        let record = validate_managed_response(endpoint, &control)?;
        if validate_executable_identity(&record, &selected.identity).is_ok() {
            let probe = probe_app_server(endpoint, options)
                .map_err(|error| diagnostic_error(endpoint, &error))?;
            return Ok(lifecycle_output(
                LifecycleStatus::AlreadyRunning,
                endpoint,
                Some(&control),
                Some(&probe),
            ));
        }
        stop_unlocked(endpoint)?;
        // A service can remove its process record before all worker threads exit.
        // The old generation must be gone before the selected binary binds.
        if record_is_active(&record)? {
            force_terminate(&record)?;
        }
        replaced = true;
    }
    let mut output = start_new_unlocked(endpoint, options, &selected)?;
    if replaced {
        output.status = LifecycleStatus::Restarted;
    }
    Ok(output)
}

fn stop_unlocked(endpoint: &EndpointPaths) -> Result<LifecycleOutput, String> {
    let control = match request_control(endpoint, ControlCommand::Status) {
        Ok(Some(control)) => control,
        Ok(None) | Err(_) => return stop_recorded_process(endpoint),
    };
    let record = validate_managed_response(endpoint, &control)?;
    if let Ok(Some(stop)) = request_control(endpoint, ControlCommand::Stop)
        && (stop.instance_id != control.instance_id || stop.pid != control.pid)
    {
        return Err("Local App Server changed generation during stop".into());
    }

    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !record_is_active(&record)? {
            remove_matching_process_record(&endpoint.pid, &record)?;
            return Ok(lifecycle_output(
                LifecycleStatus::Stopped,
                endpoint,
                Some(&control),
                None,
            ));
        }
        thread::sleep(CONNECT_RETRY_INTERVAL);
    }

    force_terminate(&record).map_err(|error| diagnostic_error(endpoint, &error))?;
    remove_matching_process_record(&endpoint.pid, &record)?;
    Ok(lifecycle_output(
        LifecycleStatus::Stopped,
        endpoint,
        Some(&control),
        None,
    ))
}

fn stop_recorded_process(endpoint: &EndpointPaths) -> Result<LifecycleOutput, String> {
    let Some(record) = read_process_record(&endpoint.pid)? else {
        return Ok(lifecycle_output(
            LifecycleStatus::NotRunning,
            endpoint,
            None,
            None,
        ));
    };
    let active = record_is_active(&record)?;
    if active {
        force_terminate(&record)?;
    }
    remove_matching_process_record(&endpoint.pid, &record)?;
    let mut output = lifecycle_output(
        if active {
            LifecycleStatus::Stopped
        } else {
            LifecycleStatus::NotRunning
        },
        endpoint,
        None,
        None,
    );
    if active {
        output.pid = Some(record.pid);
        output.instance_id = Some(record.instance_id);
    }
    Ok(output)
}

fn version_unlocked(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
) -> Result<LifecycleOutput, String> {
    let Some(control) = request_control(endpoint, ControlCommand::Status)? else {
        remove_stale_process_record(&endpoint.pid)?;
        return Ok(lifecycle_output(
            LifecycleStatus::NotRunning,
            endpoint,
            None,
            None,
        ));
    };
    if control.state == ControlState::Stopping {
        return Err("Local App Server daemon is stopping".into());
    }
    validate_managed_response(endpoint, &control)?;
    let probe =
        probe_app_server(endpoint, options).map_err(|error| diagnostic_error(endpoint, &error))?;
    Ok(lifecycle_output(
        LifecycleStatus::Running,
        endpoint,
        Some(&control),
        Some(&probe),
    ))
}

fn validate_executable_identity(
    record: &ProcessRecord,
    expected: &ExecutableIdentity,
) -> Result<(), String> {
    if !record
        .executable_identity
        .as_ref()
        .is_some_and(|actual| actual.same_generation(expected))
    {
        return Err("running Local App Server daemon executable is stale".into());
    }
    Ok(())
}

fn lifecycle_output(
    status: LifecycleStatus,
    endpoint: &EndpointPaths,
    control: Option<&ControlResponse>,
    probe: Option<&ProbeInfo>,
) -> LifecycleOutput {
    LifecycleOutput {
        status,
        pid: control.map(|control| control.pid),
        instance_id: control.map(|control| control.instance_id.clone()),
        daemon_version: control
            .map(|control| control.daemon_version.clone())
            .unwrap_or_else(|| build_info::VERSION.into()),
        endpoint_path: endpoint.socket.clone(),
        log_path: endpoint.log.clone(),
        app_server_name: probe.map(|probe| probe.server_name.clone()),
        schema_hash: probe.map(|probe| probe.schema_hash.clone()),
    }
}

fn validate_managed_response(
    endpoint: &EndpointPaths,
    control: &ControlResponse,
) -> Result<ProcessRecord, String> {
    control.validate()?;
    let record = read_process_record(&endpoint.pid)?.ok_or_else(|| {
        "App Server daemon endpoint is running without a managed process record".to_string()
    })?;
    if !record_is_active(&record)? {
        return Err("App Server control response belongs to an exited or reused process".into());
    }
    if record.pid != control.pid
        || record.instance_id != control.instance_id
        || record.daemon_version != control.daemon_version
    {
        return Err("App Server daemon endpoint does not match its managed process record".into());
    }
    Ok(record)
}

fn request_control(
    endpoint: &EndpointPaths,
    command: ControlCommand,
) -> Result<Option<ControlResponse>, String> {
    let Some(stream) = connect_existing(&endpoint.socket)? else {
        return Ok(None);
    };
    let mut stream = DeadlineStream::new(stream, Instant::now() + CONTROL_TIMEOUT)
        .map_err(|error| format!("Local App Server control deadline failed: {error}"))?;
    write_json_line(&mut stream, &ControlPrelude::new(command)).map_err(io_error)?;
    let mut line = String::new();
    let read = BufReader::new(stream)
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_line(&mut line)
        .map_err(io_error)?;
    if read == 0 || read > MAX_RESPONSE_BYTES || !line.ends_with('\n') {
        return Err("Local App Server daemon returned an invalid control response".into());
    }
    let response: ControlResponse =
        serde_json::from_str(&line).map_err(|error| error.to_string())?;
    response.validate()?;
    Ok(Some(response))
}

fn probe_app_server(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
) -> Result<ProbeInfo, String> {
    let stream = connect_existing(&endpoint.socket)?
        .ok_or_else(|| "Local App Server daemon control endpoint is unavailable".to_string())?;
    let mut stream = DeadlineStream::new(stream, Instant::now() + PROBE_TIMEOUT)
        .map_err(|error| format!("App Server initialize probe deadline failed: {error}"))?;
    write_json_line(&mut stream, &ConnectionPrelude::from_options(options)).map_err(io_error)?;
    write_json_line(
        &mut stream,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "ash-app-server-daemon-probe",
                    "version": build_info::VERSION,
                },
                "capabilities": {},
            },
        }),
    )
    .map_err(io_error)?;

    let mut line = String::new();
    let read = BufReader::new(stream)
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_line(&mut line)
        .map_err(io_error)?;
    if read == 0 || read > MAX_RESPONSE_BYTES || !line.ends_with('\n') {
        return Err("App Server initialize probe returned no bounded response".into());
    }
    let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if let Some(error) = response.get("error") {
        return Err(format!("App Server initialize probe failed: {error}"));
    }
    if response.get("id") != Some(&Value::from(1)) {
        return Err("App Server initialize probe returned the wrong request id".into());
    }
    let initialized: InitializeResult = serde_json::from_value(
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "App Server initialize response has no result".to_string())?,
    )
    .map_err(|error| format!("App Server initialize response is malformed: {error}"))?;
    if initialized.server_info.name != "ash-app-server" {
        return Err(format!(
            "Unexpected App Server identity: {}",
            initialized.server_info.name
        ));
    }
    ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES)
        .map_err(|error| format!("App Server protocol is incompatible: {error}"))?;
    Ok(ProbeInfo {
        server_name: initialized.server_info.name,
        schema_hash: initialized.schema_hash.0,
    })
}

fn proxy_stdio(mut stream: UnixStream, options: &ConnectionOptions) -> io::Result<()> {
    write_json_line(&mut stream, &ConnectionPrelude::from_options(options))?;
    relay_stdio(stream)
}

fn relay_stdio(stream: UnixStream) -> io::Result<()> {
    let mut socket_writer = stream.try_clone()?;
    let input = thread::Builder::new()
        .name("ash-local-app-server-stdin".into())
        .spawn(move || {
            let copied = io::copy(&mut io::stdin().lock(), &mut socket_writer);
            let _ = socket_writer.shutdown(Shutdown::Write);
            copied
        })?;
    let mut output = io::stdout().lock();
    relay_output(&mut BufReader::new(stream), &mut output)?;
    // The command must exit when the daemon closes its side, even while the
    // launcher keeps stdin open. A blocking process-stdin read cannot be joined
    // here; the command process owns and terminates that reader thread.
    if input.is_finished() {
        input
            .join()
            .map_err(|_| io::Error::other("Local App Server stdin proxy panicked"))??;
    }
    Ok(())
}

fn diagnostic_error(endpoint: &EndpointPaths, message: &str) -> String {
    match endpoint.log_tail() {
        Some(log) => format!(
            "{message}\n\nManaged daemon log ({}):\n{log}",
            endpoint.log.display()
        ),
        None => format!("{message}; inspect {}", endpoint.log.display()),
    }
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
