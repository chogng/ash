//! Control and connection boundary hosted by the managed App Server process.

use ash_app_server_protocol::schema_hash;
use ash_app_server_transport::LocalSocketAccept;
use ash_app_server_transport::LocalStream;
use ash_app_server_transport::PollingLocalListener;
use ash_uds::UnixStream;
use std::collections::VecDeque;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Chain;
use std::io::Cursor;
use std::io::Read;
use std::io::Write;
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
use crate::wire::MAX_PRELUDE_BYTES;
use crate::wire::decode_prelude;

const MAX_PENDING_PRELUDES: usize = 32;

/// One validated local connection, preserving any buffered protocol bytes after its prelude.
pub struct ManagedConnection {
    pub options: ConnectionOptions,
    pub web: Option<ash_app_server_protocol::WebLaunchOptions>,
    pub reader: BufReader<Chain<Cursor<Vec<u8>>, LocalStream>>,
    pub writer: LocalStream,
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
    pending: VecDeque<PendingConnection>,
}

struct PendingConnection {
    reader: BufReader<UnixStream>,
    deadline: Instant,
    line: Vec<u8>,
    response: Option<(Vec<u8>, usize)>,
}

enum PreludeProgress {
    Pending(PendingConnection),
    Control,
    Connection(ManagedConnection),
}

impl PendingConnection {
    fn new(stream: UnixStream) -> io::Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            reader: BufReader::new(stream),
            deadline: Instant::now() + CONNECTION_PRELUDE_TIMEOUT,
            line: Vec::new(),
            response: None,
        })
    }

    fn poll(
        mut self,
        profile_root: &Path,
        record: &ProcessRecord,
        stopping: &AtomicBool,
    ) -> Result<PreludeProgress, String> {
        if Instant::now() >= self.deadline {
            return Err("local App Server connection prelude deadline elapsed".into());
        }
        if self.response.is_none() {
            loop {
                let available = match self.reader.fill_buf() {
                    Ok([]) => return Err("local App Server connection prelude is missing".into()),
                    Ok(available) => available,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        return Ok(PreludeProgress::Pending(self));
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error.to_string()),
                };
                let newline = available.iter().position(|byte| *byte == b'\n');
                let length = newline.map_or(available.len(), |index| index + 1);
                if self.line.len() + length > MAX_PRELUDE_BYTES {
                    return Err("local App Server connection prelude is too large".into());
                }
                self.line.extend_from_slice(&available[..length]);
                self.reader.consume(length);
                if newline.is_some() {
                    break;
                }
            }
            match decode_prelude(&self.line)? {
                IncomingPrelude::Control(control) => {
                    if matches!(control.command, ControlCommand::Stop) {
                        stopping.store(true, Ordering::Release);
                    }
                    let response = ControlResponse::new(
                        if stopping.load(Ordering::Acquire) {
                            ControlState::Stopping
                        } else {
                            ControlState::Running
                        },
                        record.pid,
                        record.instance_id.clone(),
                        schema_hash(),
                    );
                    let mut bytes =
                        serde_json::to_vec(&response).map_err(|error| error.to_string())?;
                    bytes.push(b'\n');
                    self.response = Some((bytes, 0));
                }
                IncomingPrelude::Connection(connection) => {
                    let grant_source = connection.grant_source();
                    // A single socket read may contain the prelude and the first RPC. Preserve
                    // those already-read bytes while transferring established IO to its shared
                    // connection-close lifetime.
                    let buffered = self.reader.buffer().to_vec();
                    let stream = self.reader.into_inner();
                    let (reader, writer) =
                        LocalStream::pair(stream).map_err(|error| error.to_string())?;
                    let mut options = ConnectionOptions::new(
                        profile_root,
                        connection.dir_root,
                        grant_source,
                        connection.product_services,
                    )
                    .with_role(connection.role);
                    if let Some(ssh) = connection.ssh {
                        options = options.with_ssh(ssh.options()?)?;
                    }
                    return Ok(PreludeProgress::Connection(ManagedConnection {
                        options,
                        web: connection.web,
                        reader: BufReader::new(Cursor::new(buffered).chain(reader)),
                        writer,
                    }));
                }
            }
        }
        let (response, offset) = self.response.as_mut().expect("control response exists");
        while *offset < response.len() {
            match self.reader.get_mut().write(&response[*offset..]) {
                Ok(0) => return Err("local App Server control connection closed".into()),
                Ok(written) => *offset += written,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(PreludeProgress::Pending(self));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(PreludeProgress::Control)
    }
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
            pending: VecDeque::new(),
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

    /// Incomplete handshakes keep the endpoint alive until they finish or reach their deadline.
    pub fn has_pending_connections(&self) -> bool {
        !self.pending.is_empty()
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
            LocalSocketAccept::Pending => {}
            LocalSocketAccept::Rejected(error) => {
                eprintln!("managed App Server rejected connection: {error}");
            }
            LocalSocketAccept::Accepted(stream) => {
                if self.pending.len() == MAX_PENDING_PRELUDES {
                    eprintln!("managed App Server prelude capacity exhausted");
                } else {
                    self.pending.push_back(
                        PendingConnection::new(stream).map_err(|error| error.to_string())?,
                    );
                }
            }
        }
        // No peer may occupy the lifecycle loop while it sends a partial prelude or receives a
        // control response. Each polling round advances every pending peer without adding threads.
        for _ in 0..self.pending.len() {
            let pending = self.pending.pop_front().expect("pending prelude exists");
            match pending.poll(&self.profile_root, &self.record, &self.stopping) {
                Ok(PreludeProgress::Pending(pending)) => self.pending.push_back(pending),
                Ok(PreludeProgress::Connection(connection)) => {
                    if !self.is_stopping() {
                        return Ok(Some(connection));
                    }
                }
                Ok(PreludeProgress::Control) => {}
                Err(error) => eprintln!("managed App Server prelude failed: {error}"),
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
#[path = "managed_tests.rs"]
mod tests;

impl Drop for ManagedEndpoint {
    fn drop(&mut self) {
        for signal in self.signals.drain(..) {
            signal_hook::low_level::unregister(signal);
        }
    }
}
