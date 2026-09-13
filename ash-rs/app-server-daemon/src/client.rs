use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::path::Path;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_app_server_protocol::schema_hash;
use ash_uds::UnixStream;
use serde_json::Value;
use serde_json::json;

use crate::ConnectionOptions;
use crate::LifecycleCommand;
use crate::LifecycleOutput;
use crate::LifecycleStatus;
use crate::endpoint::EndpointPaths;
use crate::endpoint::connect_existing;
use crate::process::ExecutableIdentity;
use crate::process::ProcessRecord;
use crate::process::executable_identity;
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
        LifecycleCommand::Restart => {
            let _ = stop_unlocked(&endpoint)?;
            let mut output = start_unlocked(&endpoint, &options, backend_executable)?;
            output.status = LifecycleStatus::Restarted;
            Ok(output)
        }
        LifecycleCommand::Stop => stop_unlocked(&endpoint),
        LifecycleCommand::Version => version_unlocked(&endpoint, &options, backend_executable),
    }
}

pub(crate) fn connect(options: ConnectionOptions, backend_executable: &Path) -> Result<(), String> {
    trace_local_connection("lifecycle begin");
    run_lifecycle(LifecycleCommand::Start, options.clone(), backend_executable)?;
    trace_local_connection("lifecycle ready");
    let endpoint = EndpointPaths::prepare(options.profile_root())?;
    let stream = connect_existing(&endpoint.socket)?
        .ok_or_else(|| "Local App Server daemon exited before the client connected".to_string())?;
    trace_local_connection("socket connected");
    proxy_stdio(stream, &options).map_err(|error| error.to_string())
}

fn start_unlocked(
    endpoint: &EndpointPaths,
    options: &ConnectionOptions,
    backend_executable: &Path,
) -> Result<LifecycleOutput, String> {
    let daemon = resolve_backend_executable(backend_executable)?;
    let mut replaced_stale_daemon = false;
    if let Some(control) = request_control(endpoint, ControlCommand::Status)? {
        if control.state == ControlState::Stopping {
            return Err("Local App Server daemon is stopping".into());
        }
        let record = validate_managed_response(endpoint, &control)?;
        if validate_executable_identity(&record, &daemon.identity).is_ok() {
            let probe = probe_app_server(endpoint, options)
                .map_err(|error| diagnostic_error(endpoint, &error))?;
            return Ok(lifecycle_output(
                LifecycleStatus::AlreadyRunning,
                endpoint,
                Some(&control),
                Some(&probe),
            ));
        }
        let _ = stop_unlocked(endpoint)?;
        replaced_stale_daemon = true;
    }

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
                        if replaced_stale_daemon {
                            LifecycleStatus::Restarted
                        } else {
                            LifecycleStatus::Started
                        },
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
    backend_executable: &Path,
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
    let record = validate_managed_response(endpoint, &control)?;
    let expected = executable_identity(backend_executable)?;
    validate_executable_identity(&record, &expected)?;
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
        .is_some_and(|actual| actual.same_contents(expected))
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
    if control.daemon_version != build_info::VERSION || control.schema_hash != schema_hash() {
        return Err("running Local App Server daemon is incompatible with this client".into());
    }
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
    trace_local_connection("proxy prelude begin");
    write_json_line(&mut stream, &ConnectionPrelude::from_options(options))?;
    trace_local_connection("proxy prelude written");
    let mut socket_writer = stream.try_clone()?;
    let input = thread::Builder::new()
        .name("ash-local-app-server-stdin".into())
        .spawn(move || {
            trace_local_connection("stdin copy begin");
            let copied = io::copy(&mut io::stdin().lock(), &mut socket_writer);
            trace_local_connection("stdin copy returned");
            let _ = socket_writer.shutdown(Shutdown::Write);
            copied
        })?;
    let mut output = io::stdout().lock();
    trace_local_connection("stdout copy begin");
    io::copy(&mut BufReader::new(stream), &mut output)?;
    trace_local_connection("stdout copy returned");
    output.flush()?;
    input
        .join()
        .map_err(|_| io::Error::other("Local App Server stdin proxy panicked"))??;
    Ok(())
}

fn trace_local_connection(stage: &str) {
    if let Some(path) = std::env::var_os("ASH_TUI_TEST_TRACE_FILE")
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = file.write_all(format!("ASH local connection: {stage}\n").as_bytes());
    }
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
