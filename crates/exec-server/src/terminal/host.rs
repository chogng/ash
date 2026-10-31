//! Profile-scoped PTY ownership independent of the replaceable App Server.
//!
//! Only current-user, equal-elevation local peers may reach this internal endpoint.
//! The App Server supplies already-authorized directories; renderers never receive
//! the endpoint. Connection IDs are allocated here, so replacing an App Server
//! cannot accidentally reuse another client's process authority.

use super::*;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;
use ash_uds::IpcStream;
use ash_uds::SocketDirectory;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::thread;

const VERSION: u32 = 2;
const SOCKET: &str = "pty.sock";
const MAX_PEERS: usize = 64;
const MAX_ROOTS: usize = 64;
const MAX_OWNERS_PER_PEER: usize = 256;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
// A terminal retains more output than an exec request. JSON byte arrays and
// escaped shell metadata expand the bounded replay ring; keep a separate wire
// budget without weakening the existing execution protocol's frame limit.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

fn read_frame<T: DeserializeOwned>(reader: &mut impl BufRead) -> Result<T, crate::Error> {
    crate::transport::read_frame_with_limit(reader, MAX_FRAME_BYTES)
}

fn write_frame(stream: &mut impl Write, value: &impl Serialize) -> Result<(), crate::Error> {
    crate::transport::write_frame_with_limit(stream, value, MAX_FRAME_BYTES)
}

#[derive(Serialize, Deserialize)]
struct Request {
    version: u32,
    root: PathBuf,
    owner: u64,
    operation: Operation,
}

// This private wire contract is shared by the client and host in the same Rust
// domain. It deliberately exposes neither arbitrary execution nor JSON-RPC relay.
#[derive(Serialize, Deserialize, Clone)]
pub(super) enum Operation {
    Ping,
    Guard(String),
    Resolve(TerminalProfileSelection),
    Environment(Option<Vec<String>>),
    Create {
        params: TerminalCreateRequest,
        root: PathBuf,
    },
    Attach {
        params: TerminalAttachRequest,
        root: Option<PathBuf>,
    },
    Detach(String),
    Write(TerminalWriteRequest),
    WriteBinary(TerminalWriteBinaryRequest),
    AutoReplies {
        terminal_id: String,
        rules: Vec<TerminalAutoReply>,
    },
    Signal {
        terminal_id: String,
        signal: TerminalSignal,
    },
    ProcessInfo(String),
    Resize(TerminalResizeRequest),
    Read(TerminalReadRequest),
    Close(String),
    CloseOwner,
    Count,
    Terminate,
    Retire(Vec<String>),
}

impl Operation {
    fn terminal_id(&self) -> Option<&str> {
        match self {
            Operation::Attach { params, .. } => Some(params.terminal_id.as_str()),
            Operation::Detach(id) | Operation::ProcessInfo(id) | Operation::Close(id) => {
                Some(id.as_str())
            }
            Operation::Write(params) => Some(params.terminal_id.as_str()),
            Operation::WriteBinary(params) => Some(params.terminal_id.as_str()),
            Operation::Read(params) => Some(params.terminal_id.as_str()),
            Operation::Resize(params) => Some(params.terminal_id.as_str()),
            Operation::AutoReplies { terminal_id, .. } | Operation::Signal { terminal_id, .. } => {
                Some(terminal_id.as_str())
            }
            Operation::Guard(_)
            | Operation::Ping
            | Operation::Resolve(_)
            | Operation::Environment(_)
            | Operation::Create { .. }
            | Operation::CloseOwner
            | Operation::Count
            | Operation::Terminate
            | Operation::Retire(_) => None,
        }
    }
}

// Serialize directly from the domain DTOs: materializing every output byte as
// a serde_json::Value would allocate a large object graph on each terminal poll.
#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Unit,
    Count(usize),
    Resolved(TerminalResolvedProfile),
    Environment(HashMap<String, String>),
    Created(TerminalCreateResult),
    Attached(TerminalAttachResult),
    Lease(TerminalReconnectLease),
    ProcessInfo(TerminalProcessInfo),
    Read(TerminalReadResult),
}

type Reply = Result<Response, TerminalError>;

/// One authorization facade's transport, not a second owner of terminal state.
pub(super) struct Client {
    stream: Mutex<BufReader<IpcStream>>,
    disconnected: AtomicBool,
    connection: Option<ConnectionOptions>,
    // Revocation objects cannot cross a process boundary. Retain their proofs
    // here so the owning grant can explicitly retire processes in the host.
    authorizations: Mutex<HashMap<String, Authorization>>,
}

struct ConnectionOptions {
    profile: PathBuf,
    executable: PathBuf,
}

impl Client {
    pub(super) fn connect(profile: &Path, executable: &Path) -> Result<Self, TerminalError> {
        Self::connect_with_guard(profile, executable, None)
    }

    fn connect_with_guard(
        profile: &Path,
        executable: &Path,
        guard: Option<&str>,
    ) -> Result<Self, TerminalError> {
        let directory = directory(profile).map_err(operation_failed)?;
        // The OS releases the startup lock even if its holder crashes. Never
        // steal a socket from a host which has live commands or an older build.
        let lock = startup_lock(&directory).map_err(operation_failed)?;
        lock.lock().map_err(operation_failed)?;
        let stream = match connect(&directory) {
            Ok(stream) => stream,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                #[cfg(unix)]
                directory
                    .remove_socket(Path::new(SOCKET))
                    .map_err(operation_failed)?;
                let mut command = Command::new(executable);
                command
                    .arg("--terminal-host")
                    .arg(directory.path())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::inherit());
                detach(&mut command).map_err(operation_failed)?;
                let mut child = command.spawn().map_err(operation_failed)?;
                let deadline = Instant::now() + IO_TIMEOUT;
                let stream = loop {
                    match connect(&directory) {
                        Ok(stream) => break Ok(stream),
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                            ) => {}
                        Err(error) => break Err(operation_failed(error)),
                    }
                    if child.try_wait().map_err(operation_failed)?.is_some()
                        || Instant::now() >= deadline
                    {
                        break Err(TerminalError::OperationFailed);
                    }
                    thread::sleep(Duration::from_millis(10));
                };
                if stream.is_err() {
                    let _ = child.kill();
                }
                // Reap our child if we live longer than it; dropping the Child
                // handle must never terminate the independent host.
                thread::spawn(move || {
                    let _ = child.wait();
                });
                stream?
            }
            Err(error) => return Err(operation_failed(error)),
        };
        let client = Self {
            stream: Mutex::new(BufReader::new(stream)),
            disconnected: AtomicBool::new(false),
            connection: Some(ConnectionOptions {
                profile: profile.into(),
                executable: executable.into(),
            }),
            authorizations: Mutex::new(HashMap::new()),
        };
        client.unchecked::<()>(Path::new(""), 0, Operation::Ping)?;
        if let Some(guard) = guard {
            client.unchecked::<()>(Path::new(""), 0, Operation::Guard(guard.into()))?;
        }
        drop(lock);
        Ok(client)
    }

    pub(super) fn request<T: DeserializeOwned>(
        &self,
        authorization: &Authorization,
        owner: u64,
        operation: Operation,
    ) -> Result<T, TerminalError> {
        validate_authorization(authorization)?;
        let configuration = match &operation {
            Operation::Resolve(_) | Operation::Environment(_) => Some(operation.clone()),
            Operation::Guard(_)
            | Operation::Ping
            | Operation::Create { .. }
            | Operation::Attach { .. }
            | Operation::Detach(_)
            | Operation::Write(_)
            | Operation::WriteBinary(_)
            | Operation::AutoReplies { .. }
            | Operation::Signal { .. }
            | Operation::ProcessInfo(_)
            | Operation::Resize(_)
            | Operation::Read(_)
            | Operation::Close(_)
            | Operation::CloseOwner
            | Operation::Count
            | Operation::Terminate
            | Operation::Retire(_) => None,
        };
        // Starting a new shell and explicitly attaching a lease may establish a
        // new owner connection. Existing process operations never migrate by ID.
        if configuration.is_some()
            || matches!(
                &operation,
                Operation::Create { .. } | Operation::Attach { .. }
            )
        {
            self.reconnect_if_disconnected()?;
        }
        let id = operation.terminal_id();
        if let Some(authorization) = id.and_then(|id| {
            self.authorizations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(id)
                .cloned()
        }) {
            validate_authorization(&authorization)?;
        }
        let result = self.unchecked(authorization.dir().canonical_path(), owner, operation);
        if result.is_err()
            && self.disconnected.load(Ordering::Acquire)
            && let Some(configuration) = configuration
        {
            // Only configuration reads are safe to retry after a lost response.
            self.reconnect_if_disconnected()?;
            return self.unchecked(authorization.dir().canonical_path(), owner, configuration);
        }
        result
    }

    fn reconnect_if_disconnected(&self) -> Result<(), TerminalError> {
        if !self.disconnected.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut stream = self.stream.lock().map_err(|_| TerminalError::Busy)?;
        if !self.disconnected.load(Ordering::Acquire) {
            return Ok(());
        }
        let connection = self
            .connection
            .as_ref()
            .ok_or(TerminalError::OperationFailed)?;
        let replacement = Self::connect(&connection.profile, &connection.executable)?;
        *stream = replacement
            .stream
            .into_inner()
            .map_err(|_| TerminalError::Busy)?;
        self.disconnected.store(false, Ordering::Release);
        Ok(())
    }

    pub(super) fn write(
        &self,
        authorization: &Authorization,
        owner: u64,
        params: TerminalWriteRequest,
    ) -> Result<(), TerminalError> {
        self.admit_input(authorization, owner, || Operation::Write(params.clone()))
    }

    pub(super) fn write_binary(
        &self,
        authorization: &Authorization,
        owner: u64,
        params: TerminalWriteBinaryRequest,
    ) -> Result<(), TerminalError> {
        self.admit_input(authorization, owner, || {
            Operation::WriteBinary(params.clone())
        })
    }

    fn admit_input(
        &self,
        authorization: &Authorization,
        owner: u64,
        operation: impl Fn() -> Operation,
    ) -> Result<(), TerminalError> {
        let mut delay = Duration::from_millis(1);
        loop {
            match self.request(authorization, owner, operation()) {
                // Busy means this input was not admitted. Release the transport
                // between attempts so reads, signals and close can unblock the
                // child. A lost response is never retried: it may have committed.
                Err(TerminalError::Busy) => {
                    thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
                result => return result,
            }
        }
    }

    pub(super) fn unchecked<T: DeserializeOwned>(
        &self,
        root: &Path,
        owner: u64,
        operation: Operation,
    ) -> Result<T, TerminalError> {
        let mut stream = self.stream.lock().map_err(|_| TerminalError::Busy)?;
        let reply = (|| {
            write_frame(
                stream.get_mut(),
                &Request {
                    version: VERSION,
                    root: root.into(),
                    owner,
                    operation,
                },
            )
            .map_err(operation_failed)?;
            read_frame::<Result<T, TerminalError>>(&mut *stream).map_err(operation_failed)
        })();
        match reply {
            Ok(reply) => reply,
            Err(error) => {
                // A lost response can have committed a mutation. Poison this
                // transport instead of replaying input, creation or token rotation.
                let _ = stream.get_mut().shutdown(std::net::Shutdown::Both);
                self.disconnected.store(true, Ordering::Release);
                Err(error)
            }
        }
    }

    pub(super) fn remember(&self, id: &str, authorization: Authorization) {
        self.authorizations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.into(), authorization);
    }

    pub(super) fn remember_attached(
        &self,
        id: &str,
        authorization: Option<Authorization>,
        service_authorization: Authorization,
    ) {
        let mut grants = self
            .authorizations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(authorization) = authorization {
            grants.insert(id.into(), authorization);
        } else {
            grants.entry(id.into()).or_insert(service_authorization);
        }
    }

    fn forget(&self, id: &str) {
        self.authorizations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    pub(super) fn close(&self, root: &Path, owner: u64, id: &str) -> Result<(), TerminalError> {
        let known = self
            .authorizations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id);
        if known {
            self.reconnect_if_disconnected()?;
        }
        let mut result = self.unchecked::<()>(root, owner, Operation::Close(id.into()));
        if known && result.is_err() && self.disconnected.load(Ordering::Acquire) {
            // Releasing a known identity is idempotent. This never retries a
            // command or substitutes authority over a different live process.
            self.reconnect_if_disconnected()?;
            result = self.unchecked(root, owner, Operation::Close(id.into()));
        }
        if known && result == Err(TerminalError::NotFound) {
            result = Ok(());
        }
        if result.is_ok() {
            self.forget(id);
        }
        result
    }

    pub(super) fn revoke(&self, root: &Path) {
        let ids = {
            let grants = self
                .authorizations
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let ids = grants
                .iter()
                .filter(|(_, authorization)| authorization.ensure_active().is_err())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids
        };
        // Transferred terminals can leave more historical proofs than the host's
        // simultaneous-process quota. They cannot obstruct revoking a live PTY.
        for batch in ids.chunks(MAX_ACTIVE_TERMINALS) {
            if self
                .unchecked::<()>(root, 0, Operation::Retire(batch.to_vec()))
                .is_ok()
            {
                let mut grants = self
                    .authorizations
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                for id in batch {
                    grants.remove(id);
                }
            }
        }
    }
}

fn startup_lock(directory: &SocketDirectory) -> io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let lock = options.open(directory.path().join("startup.lock"))?;
    if !lock.metadata()?.is_file() {
        return Err(io::Error::other("invalid terminal startup lock"));
    }
    Ok(lock)
}

fn directory(profile: &Path) -> io::Result<SocketDirectory> {
    let profile = std::fs::canonicalize(profile)?;
    let hash = format!(
        "{:x}",
        Sha256::digest(profile.as_os_str().as_encoded_bytes())
    );
    // macOS per-user temporary paths can exceed sockaddr_un's 104-byte limit.
    #[cfg(unix)]
    let base = PathBuf::from("/tmp");
    #[cfg(windows)]
    let base = std::env::temp_dir();
    SocketDirectory::prepare(&base.join(format!("ash-pty-v{VERSION}-{}", &hash[..32])))
}

fn connect(directory: &SocketDirectory) -> io::Result<IpcStream> {
    let stream = directory.connect(Path::new(SOCKET))?;
    validate_peer(&stream)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    Ok(stream)
}

fn validate_peer(stream: &IpcStream) -> io::Result<()> {
    let peer = ash_uds::peer_identity(stream)?;
    if peer.same_user && peer.same_elevation {
        Ok(())
    } else {
        Err(io::ErrorKind::PermissionDenied.into())
    }
}

#[cfg(unix)]
fn detach(command: &mut Command) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(())
}

#[cfg(windows)]
fn detach(command: &mut Command) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    let mut flags = 0x0000_0200 | 0x0800_0000; // NEW_PROCESS_GROUP | NO_WINDOW
    // Escape controller jobs when permitted. A managed backend may already
    // have escaped an inner job while remaining in a restrictive ancestor;
    // requesting breakaway again then fails with ERROR_ACCESS_DENIED. Inherit
    // that ancestor's constraints without tying the host to this process.
    if ash_utils_pty::JobObject::current_allows_breakaway()? {
        flags |= 0x0100_0000; // BREAKAWAY_FROM_JOB
    }
    command.creation_flags(flags);
    Ok(())
}

fn operation_failed(_: impl std::fmt::Debug) -> TerminalError {
    TerminalError::OperationFailed
}

#[derive(Default)]
struct Registry {
    services: HashMap<PathBuf, Arc<TerminalService>>,
    lifetimes: HashMap<String, Arc<AtomicBool>>,
    ever_guarded: bool,
}

type Services = Arc<Mutex<Registry>>;

/// Runs the internal terminal-host role of a product backend executable.
/// Live commands survive backend loss without a deadline; explicit handoffs expire.
pub fn run(path: &Path) -> Result<(), String> {
    let directory = SocketDirectory::open(path).map_err(|e| e.to_string())?;
    let listener = directory
        .bind(Path::new(SOCKET))
        .map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let services: Services = Arc::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
    let mut idle_since = Instant::now();
    let shutdown_lock;
    loop {
        workers.retain(|worker| !worker.is_finished());
        match listener.accept() {
            Ok((stream, _)) if workers.len() < MAX_PEERS => {
                if validate_peer(&stream).is_ok() {
                    let services = Arc::clone(&services);
                    let next_owner = Arc::clone(&next_owner);
                    let worker = thread::Builder::new()
                        .name("ash-pty-host-client".into())
                        .spawn(move || {
                            serve(stream, services, next_owner);
                        })
                        .map_err(|e| e.to_string())?;
                    workers.push(worker);
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.to_string()),
        }
        let (active, released) = {
            let mut registry = services.lock().unwrap_or_else(|e| e.into_inner());
            registry
                .services
                .retain(|_, service| service.active_count() != 0 || Arc::strong_count(service) > 1);
            let running = registry
                .services
                .values()
                .any(|service| service.active_count() != 0);
            (
                !registry.services.is_empty(),
                registry.ever_guarded && registry.lifetimes.is_empty() && !running,
            )
        };
        // Dead window owners cannot issue further work. Configuration facades in
        // a shared backend must not pin an otherwise unused terminal host.
        let idle = workers.is_empty() && !active && idle_since.elapsed() >= IDLE_TIMEOUT;
        if released || idle {
            let lock = startup_lock(&directory).map_err(|e| e.to_string())?;
            if lock.try_lock().is_ok() {
                let registry = services.lock().unwrap_or_else(|e| e.into_inner());
                let still_released = registry.ever_guarded
                    && registry.lifetimes.is_empty()
                    && registry
                        .services
                        .values()
                        .all(|service| service.active_count() == 0);
                if still_released || (idle && registry.services.is_empty()) {
                    shutdown_lock = lock;
                    break;
                }
            }
        }
        if !workers.is_empty() || active {
            idle_since = Instant::now();
        }
        thread::sleep(Duration::from_millis(50));
    }
    drop(listener);
    #[cfg(unix)]
    directory
        .remove_socket(Path::new(SOCKET))
        .map_err(|e| e.to_string())?;
    drop(shutdown_lock);
    Ok(())
}

fn serve(stream: IpcStream, services: Services, next_owner: Arc<AtomicU64>) {
    // The accept loop polls a nonblocking listener. In particular on macOS,
    // accepted streams need their own blocking mode before framed reads.
    if stream.set_nonblocking(false).is_err()
        || stream.set_read_timeout(None).is_err()
        || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
    {
        return;
    }
    let mut reader = BufReader::new(stream);
    let mut owners = HashMap::new();
    let mut used_services = HashMap::new();
    loop {
        let Ok(request) = read_frame::<Request>(&mut reader) else {
            break;
        };
        if let Operation::Guard(token) = &request.operation {
            if request.version == VERSION && owners.is_empty() && used_services.is_empty() {
                serve_lifetime(&mut reader, &services, token);
            }
            break;
        }
        let root = request.root.clone();
        let reply = dispatch(
            request,
            &services,
            &next_owner,
            &mut owners,
            &mut used_services,
        );
        if write_frame(reader.get_mut(), &reply).is_err() {
            break;
        }
        // Keep an idle directory's configuration while its facade is connected;
        // a workspace switch can release its empty predecessor immediately.
        used_services.retain(|path, service| path == &root || service.active_count() != 0);
    }
    // EOF includes SIGKILL of the App Server. Reconnectable sessions become
    // detached with their existing bearer token; connection-owned tasks terminate.
    for service in used_services.values() {
        for owner in owners.values() {
            service.close_owner(*owner);
        }
    }
}

fn authorization(root: &Path) -> Result<Authorization, TerminalError> {
    if !root.is_absolute() {
        return Err(TerminalError::InvalidInput);
    }
    let dir = Dir::open_local(root).map_err(operation_failed)?;
    Grant::for_environment(
        dir,
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ExecuteCommands]),
    )
    .authorize(Permission::ExecuteCommands)
    .map_err(operation_failed)
}

fn dispatch(
    request: Request,
    services: &Services,
    next_owner: &AtomicU64,
    owners: &mut HashMap<u64, u64>,
    used_services: &mut HashMap<PathBuf, Arc<TerminalService>>,
) -> Reply {
    if request.version != VERSION {
        return Err(TerminalError::Unsupported);
    }
    if matches!(request.operation, Operation::Ping) {
        return Ok(Response::Unit);
    }
    match &request.operation {
        Operation::CloseOwner => {
            if let Some(owner) = owners.get(&request.owner) {
                for service in used_services.values() {
                    service.close_owner(*owner);
                }
            }
            return Ok(Response::Unit);
        }
        Operation::Count => {
            let mut count = 0;
            for service in used_services.values() {
                count += with_owned_sessions(service, owners, |sessions, owned| {
                    Ok(sessions
                        .values()
                        .filter(|session| belongs(session, owned))
                        .count())
                })?;
            }
            return Ok(Response::Count(count));
        }
        Operation::Terminate => {
            for service in used_services.values() {
                with_owned_sessions(service, owners, |sessions, owned| {
                    sessions.retain(|_, session| {
                        if !belongs(session, owned) {
                            return true;
                        }
                        session.process.request_terminate();
                        false
                    });
                    Ok(())
                })?;
            }
            return Ok(Response::Unit);
        }
        Operation::Retire(ids) => {
            if ids.len() > MAX_ACTIVE_TERMINALS {
                return Err(TerminalError::InvalidInput);
            }
            for service in used_services.values() {
                with_owned_sessions(service, owners, |sessions, owned| {
                    sessions.retain(|id, session| {
                        if !ids.contains(id) || !belongs(session, owned) {
                            return true;
                        }
                        session.process.request_terminate();
                        false
                    });
                    Ok(())
                })?;
            }
            return Ok(Response::Unit);
        }
        Operation::Guard(_)
        | Operation::Ping
        | Operation::Resolve(_)
        | Operation::Environment(_)
        | Operation::Create { .. }
        | Operation::Attach { .. }
        | Operation::Detach(_)
        | Operation::Write(_)
        | Operation::WriteBinary(_)
        | Operation::AutoReplies { .. }
        | Operation::Signal { .. }
        | Operation::ProcessInfo(_)
        | Operation::Resize(_)
        | Operation::Read(_)
        | Operation::Close(_) => {}
    }
    let lifetime = {
        let token = match &request.operation {
            Operation::Create { params, .. } => params.lifetime_token.as_deref(),
            Operation::Attach { params, .. } => params.lifetime_token.as_deref(),
            Operation::Ping
            | Operation::Guard(_)
            | Operation::Resolve(_)
            | Operation::Environment(_)
            | Operation::Detach(_)
            | Operation::Write(_)
            | Operation::WriteBinary(_)
            | Operation::AutoReplies { .. }
            | Operation::Signal { .. }
            | Operation::ProcessInfo(_)
            | Operation::Resize(_)
            | Operation::Read(_)
            | Operation::Close(_)
            | Operation::CloseOwner
            | Operation::Count
            | Operation::Terminate
            | Operation::Retire(_) => None,
        };
        let registry = services.lock().map_err(|_| TerminalError::Busy)?;
        token
            .map(|token| {
                registry
                    .lifetimes
                    .get(token)
                    .filter(|alive| alive.load(Ordering::Acquire))
                    .cloned()
                    .ok_or(TerminalError::AttachRejected)
            })
            .transpose()?
    };
    let (service_root, service) = {
        let mut registry = services.lock().map_err(|_| TerminalError::Busy)?;
        let services = &mut registry.services;
        // Session restoration can visit directories in a different order. Route
        // existing opaque identities to their original owner, rather than to the
        // new facade's first selected directory. The prefix is owned by this
        // module and selects a service; it grants no process or lease authority.
        let retained = request.operation.terminal_id().and_then(|id| {
            let prefix = id.strip_prefix("terminal-")?.split_once('-')?.0;
            services
                .iter()
                .find(|(_, service)| service.terminal_id_prefix == prefix)
                .map(|(root, service)| (root.clone(), Arc::clone(service)))
        });
        if let Some(retained) = retained {
            retained
        } else {
            if !services.contains_key(&request.root) {
                if services.len() >= MAX_ROOTS {
                    return Err(TerminalError::Busy);
                }
                let authorization = authorization(&request.root)?;
                if authorization.dir().canonical_path() != request.root {
                    return Err(TerminalError::InvalidInput);
                }
                services.insert(
                    request.root.clone(),
                    Arc::new(TerminalService::new(authorization)?),
                );
            }
            (request.root.clone(), Arc::clone(&services[&request.root]))
        }
    };
    used_services.insert(service_root, Arc::clone(&service));
    if !owners.contains_key(&request.owner) {
        if owners.len() >= MAX_OWNERS_PER_PEER {
            let mut live = HashSet::new();
            for service in used_services.values() {
                let sessions = service.sessions.lock().map_err(|_| TerminalError::Busy)?;
                for session in sessions.values() {
                    live.insert(match session.owner {
                        TerminalOwner::Attached(owner) => owner,
                        TerminalOwner::Detached { previous_owner, .. }
                        | TerminalOwner::Disconnected { previous_owner, .. } => previous_owner,
                    });
                }
            }
            // Renderer reloads retire connection IDs without replacing this
            // facade. Keep authority for live/detached PTYs, not their history.
            owners.retain(|_, owner| live.contains(owner));
            if owners.len() >= MAX_OWNERS_PER_PEER {
                return Err(TerminalError::Busy);
            }
        }
        owners.insert(request.owner, next_owner.fetch_add(1, Ordering::Relaxed));
    }
    let owner = owners[&request.owner];
    match request.operation {
        Operation::Guard(_) => Err(TerminalError::Unsupported),
        Operation::Ping => Ok(Response::Unit),
        Operation::Resolve(profile) => Ok(Response::Resolved(service.resolve_profile(&profile)?)),
        Operation::Environment(names) => Ok(Response::Environment(match names {
            Some(names) => service.environment(&names)?,
            None => service.environment_snapshot()?,
        })),
        Operation::Create { params, root } => Ok(Response::Created(service.create_with_lifetime(
            owner,
            params,
            authorization(&root)?,
            lifetime,
        )?)),
        Operation::Attach { params, root } => {
            Ok(Response::Attached(service.attach_with_authorization(
                owner,
                params,
                Some(authorization(root.as_deref().unwrap_or(&request.root))?),
                lifetime,
            )?))
        }
        Operation::Detach(id) => Ok(Response::Lease(service.detach(owner, &id)?)),
        Operation::Write(params) => unit(service.write_input(
            owner,
            &params.terminal_id,
            params.data.into_bytes(),
            InputAdmission::NonBlocking,
        )),
        Operation::WriteBinary(params) => unit(service.write_input(
            owner,
            &params.terminal_id,
            params.data,
            InputAdmission::NonBlocking,
        )),
        Operation::AutoReplies { terminal_id, rules } => {
            unit(service.set_auto_replies(owner, &terminal_id, rules))
        }
        Operation::Signal {
            terminal_id,
            signal,
        } => unit(service.send_signal(owner, &terminal_id, signal)),
        Operation::ProcessInfo(id) => Ok(Response::ProcessInfo(service.process_info(owner, &id)?)),
        Operation::Resize(params) => unit(service.resize(owner, params)),
        Operation::Read(params) => Ok(Response::Read(service.read(owner, params)?)),
        Operation::Close(id) => unit(service.close(owner, &id)),
        Operation::CloseOwner | Operation::Count | Operation::Terminate | Operation::Retire(_) => {
            unreachable!("maintenance is handled before selecting a directory service")
        }
    }
}

fn belongs(session: &TerminalSession, owned: &HashSet<u64>) -> bool {
    owned.contains(&match session.owner {
        TerminalOwner::Attached(owner) => owner,
        TerminalOwner::Detached { previous_owner, .. }
        | TerminalOwner::Disconnected { previous_owner, .. } => previous_owner,
    })
}

fn with_owned_sessions<T>(
    service: &TerminalService,
    owners: &HashMap<u64, u64>,
    operation: impl FnOnce(
        &mut HashMap<String, TerminalSession>,
        &HashSet<u64>,
    ) -> Result<T, TerminalError>,
) -> Result<T, TerminalError> {
    let owned = owners.values().copied().collect::<HashSet<_>>();
    let mut sessions = service.sessions.lock().map_err(|_| TerminalError::Busy)?;
    remove_expired_sessions(&mut sessions, Instant::now());
    operation(&mut sessions, &owned)
}

fn unit(result: Result<(), TerminalError>) -> Reply {
    result.map(|()| Response::Unit)
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

// The window's connection, rather than any PID or grace timer, is authoritative.
fn serve_lifetime(reader: &mut BufReader<IpcStream>, services: &Services, token: &str) {
    let alive = Arc::new(AtomicBool::new(true));
    let registered = {
        let mut registry = services.lock().unwrap_or_else(|e| e.into_inner());
        if token.len() != 64
            || !token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || registry.lifetimes.contains_key(token)
        {
            false
        } else {
            registry.lifetimes.insert(token.into(), alive.clone());
            registry.ever_guarded = true;
            true
        }
    };
    let reply: Reply = if registered {
        Ok(Response::Unit)
    } else {
        Err(TerminalError::InvalidInput)
    };
    if registered {
        if write_frame(reader.get_mut(), &reply).is_ok() {
            // No timeout: a live window may outlast arbitrarily slow backend recovery.
            let _ = reader.read(&mut [0]);
        }
        alive.store(false, Ordering::Release);
        let mut registry = services.lock().unwrap_or_else(|e| e.into_inner());
        registry.lifetimes.remove(token);
        for service in registry.services.values() {
            if let Ok(mut sessions) = service.sessions.lock() {
                remove_expired_sessions(&mut sessions, Instant::now());
            }
        }
    } else {
        let _ = write_frame(reader.get_mut(), &reply);
    }
}

/// Holds one window's independent lifetime until its Main-owned stdin pipe closes.
/// Neither backend recovery nor renderer reload participates in this connection.
pub fn run_owner(profile: &Path) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut input = BufReader::new(std::io::stdin());
    let mut token = String::new();
    input
        .by_ref()
        .take(66)
        .read_line(&mut token)
        .map_err(|e| e.to_string())?;
    let token = token
        .strip_suffix('\n')
        .filter(|t| t.len() == 64)
        .ok_or("invalid terminal lifetime credential")?;
    // Observe Main before acquiring any startup lock or waiting for a peer.
    // This dedicated role owns no business state: EOF must end the process even
    // if host startup stalls. OS closure releases its socket and package lease.
    thread::spawn(move || {
        let _ = io::copy(&mut input, &mut io::sink());
        std::process::exit(0);
    });
    let client = Client::connect_with_guard(profile, &executable, Some(token))
        .map_err(|e| format!("{e:?}"))?;
    let mut stream = client.stream.into_inner().map_err(|e| e.to_string())?;
    stream
        .get_mut()
        .set_read_timeout(None)
        .map_err(|e| e.to_string())?;
    println!("ready");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let _ = stream.read(&mut [0]);
    Ok(())
}
