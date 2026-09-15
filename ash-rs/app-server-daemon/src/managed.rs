//! Control and connection boundary hosted by the managed App Server process.

use ash_app_server_protocol::schema_hash;
use ash_app_server_transport::DeadlineStream;
use ash_app_server_transport::LocalSocketAccept;
use ash_app_server_transport::PollingLocalListener;
use ash_uds::UnixStream;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use crate::ConnectionOptions;
use crate::endpoint::EndpointPaths;
use crate::endpoint::SocketCleanup;
use crate::process::ProcessRecord;
use crate::process::ProcessRecordGuard;
use crate::wire::CONNECTION_PRELUDE_TIMEOUT;
use crate::wire::ControlCommand;
use crate::wire::ControlResponse;
use crate::wire::ControlState;
use crate::wire::IncomingPrelude;
use crate::wire::read_prelude;
use crate::wire::write_json_line;

/// One validated local connection, preserving any buffered protocol bytes after its prelude.
pub struct ManagedConnection {
    pub options: ConnectionOptions,
    pub web: Option<ash_app_server_protocol::WebLaunchOptions>,
    pub reader: BufReader<DeadlineStream>,
    pub writer: DeadlineStream,
}

/// Owns the managed process record, authenticated local endpoint, and stop requests.
/// Application services and background work remain owned by the executable using this endpoint.
pub struct ManagedEndpoint {
    listener: PollingLocalListener,
    _socket_cleanup: SocketCleanup,
    _record_guard: ProcessRecordGuard,
    endpoint: EndpointPaths,
    record: ProcessRecord,
    profile_root: PathBuf,
    stopping: Arc<AtomicBool>,
    signals: Vec<signal_hook::SigId>,
    last_log_maintenance: Instant,
}

impl ManagedEndpoint {
    /// Binds the profile endpoint and publishes the identity of the current App Server process.
    pub fn bind(profile_root: &Path) -> Result<Self, String> {
        let endpoint = EndpointPaths::prepare(profile_root)?;
        let listener = PollingLocalListener::new(endpoint.bind_listener()?)
            .map_err(|error| error.to_string())?;
        let socket_cleanup = SocketCleanup::new(endpoint.socket.clone());
        let record = ProcessRecord::current(&endpoint)?;
        let record_guard = ProcessRecordGuard::publish(&endpoint.pid, &record)?;
        let mut managed = Self {
            listener,
            _socket_cleanup: socket_cleanup,
            _record_guard: record_guard,
            endpoint,
            record,
            profile_root: profile_root.to_path_buf(),
            stopping: Arc::new(AtomicBool::new(false)),
            signals: Vec::new(),
            last_log_maintenance: Instant::now(),
        };
        managed.register_shutdown_signals()?;
        eprintln!(
            "managed App Server endpoint ready: {} (pid {})",
            managed.endpoint.socket.display(),
            managed.record.pid
        );
        Ok(managed)
    }

    fn register_shutdown_signals(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
            self.signals.push(
                signal_hook::flag::register(signal, Arc::clone(&self.stopping))
                    .map_err(|error| error.to_string())?,
            );
        }
        Ok(())
    }

    /// Returns whether an authenticated control request or process signal requested shutdown.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    /// Handles lifecycle traffic and returns the next application connection when available.
    pub fn poll_connection(&mut self) -> Result<Option<ManagedConnection>, String> {
        if self.last_log_maintenance.elapsed() >= Duration::from_secs(1) {
            self.endpoint.open_log()?;
            self.last_log_maintenance = Instant::now();
        }
        match self
            .listener
            .poll_accept()
            .map_err(|error| error.to_string())?
        {
            LocalSocketAccept::Pending => Ok(None),
            LocalSocketAccept::Rejected(error) => {
                eprintln!("managed App Server rejected connection: {error}");
                Ok(None)
            }
            LocalSocketAccept::Accepted(stream) => match self.read_connection(stream) {
                Ok(connection) => Ok(connection),
                Err(error) => {
                    eprintln!("managed App Server prelude failed: {error}");
                    Ok(None)
                }
            },
        }
    }

    fn read_connection(&mut self, stream: UnixStream) -> Result<Option<ManagedConnection>, String> {
        let deadline = Instant::now() + CONNECTION_PRELUDE_TIMEOUT;
        let reader = stream.try_clone().map_err(|error| error.to_string())?;
        let mut writer =
            DeadlineStream::new(stream, deadline).map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(
            DeadlineStream::new(reader, deadline).map_err(|error| error.to_string())?,
        );
        match read_prelude(&mut reader)? {
            IncomingPrelude::Control(control) => {
                if matches!(control.command, ControlCommand::Stop) {
                    self.stopping.store(true, Ordering::Release);
                }
                let response = ControlResponse::new(
                    if self.is_stopping() {
                        ControlState::Stopping
                    } else {
                        ControlState::Running
                    },
                    self.record.pid,
                    self.record.instance_id.clone(),
                    schema_hash(),
                );
                write_json_line(&mut writer, &response).map_err(|error| error.to_string())?;
                Ok(None)
            }
            IncomingPrelude::Connection(connection) => {
                reader
                    .get_mut()
                    .clear_deadline()
                    .map_err(|error| error.to_string())?;
                writer.clear_deadline().map_err(|error| error.to_string())?;
                let options = ConnectionOptions::new(
                    &self.profile_root,
                    connection.dir_root.clone(),
                    connection.grant_source(),
                    connection.product_services,
                );
                Ok(Some(ManagedConnection {
                    options,
                    web: connection.web,
                    reader,
                    writer,
                }))
            }
        }
    }
}

impl Drop for ManagedEndpoint {
    fn drop(&mut self) {
        for signal in self.signals.drain(..) {
            signal_hook::low_level::unregister(signal);
        }
    }
}
