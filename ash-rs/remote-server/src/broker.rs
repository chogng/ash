#[cfg(unix)]
mod unix {
    use std::fs;
    use std::fs::DirBuilder;
    use std::fs::File;
    use std::fs::OpenOptions;
    use std::io;
    use std::io::BufReader;
    use std::net::Shutdown;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::path::PathBuf;
    use std::process::Command;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::thread;
    use std::time::Duration;
    use std::time::Instant;

    use ash_app_server_protocol::schema_hash;
    use ash_app_server_transport::relay_output;
    use sha2::Digest;
    use sha2::Sha256;

    use crate::server::PRODUCT_SERVICES_PATH_ENV;
    use crate::server::RemoteServerError;
    use crate::server::RemoteServerOptions;
    use crate::server::open_server;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
    const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(50);
    const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
    const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);
    const IDLE_TIMEOUT_ENV: &str = "ASH_REMOTE_SERVER_IDLE_TIMEOUT_MILLIS";
    const MAX_LOG_BYTES: u64 = 1024 * 1024;
    const MAX_PRODUCT_SERVICES_IDENTITY_BYTES: u64 = 1024 * 1024;
    const STALE_START_LOCK_AGE: Duration = Duration::from_secs(15);

    pub(super) fn connect(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
        let endpoint = BrokerEndpoint::prepare(&options)?;
        let stream = connect_or_start(&endpoint, &options)?;
        proxy_stdio(stream).map_err(RemoteServerError::from_io)
    }

    pub(super) fn serve(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
        let endpoint = BrokerEndpoint::prepare(&options)?;
        let listener = bind_listener(&endpoint)?;
        let _socket_cleanup = SocketCleanup(endpoint.socket.clone());
        let _ = fs::remove_dir(&endpoint.start_lock);
        listener
            .set_nonblocking(true)
            .map_err(RemoteServerError::from_io)?;
        let server = Arc::new(open_server(&options)?);
        let _queue = server.start_queue().map_err(RemoteServerError::new)?;
        let active_connections = Arc::new(AtomicUsize::new(0));
        let idle_timeout = configured_idle_timeout()?;
        let mut idle_since = None;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream
                        .set_nonblocking(false)
                        .map_err(RemoteServerError::from_io)?;
                    idle_since = None;
                    active_connections.fetch_add(1, Ordering::AcqRel);
                    let server = Arc::clone(&server);
                    let connection_counter = Arc::clone(&active_connections);
                    thread::Builder::new()
                        .name("ash-remote-server-connection".into())
                        .spawn(move || {
                            let _connection = ActiveConnection(connection_counter);
                            let reader = match stream.try_clone() {
                                Ok(reader) => reader,
                                Err(error) => {
                                    eprintln!("remote server connection clone failed: {error}");
                                    return;
                                }
                            };
                            if let Err(error) =
                                server.serve_product_host_jsonl(BufReader::new(reader), stream)
                            {
                                eprintln!("remote server connection failed: {error}");
                            }
                        })
                        .map_err(|error| {
                            active_connections.fetch_sub(1, Ordering::AcqRel);
                            RemoteServerError::from_io(error)
                        })?;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if active_connections.load(Ordering::Acquire) == 0
                        && server.active_terminal_count() == 0
                        && !server.queue_needs_host().map_err(RemoteServerError::new)?
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
                Err(error) => return Err(RemoteServerError::from_io(error)),
            }
        }
    }

    struct ActiveConnection(Arc<AtomicUsize>);

    impl Drop for ActiveConnection {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    struct SocketCleanup(PathBuf);

    impl Drop for SocketCleanup {
        fn drop(&mut self) {
            if fs::symlink_metadata(&self.0).is_ok_and(|metadata| metadata.file_type().is_socket())
            {
                let _ = fs::remove_file(&self.0);
            }
        }
    }

    fn configured_idle_timeout() -> Result<Duration, RemoteServerError> {
        let Some(value) = std::env::var_os(IDLE_TIMEOUT_ENV) else {
            return Ok(DEFAULT_IDLE_TIMEOUT);
        };
        let value = value.to_string_lossy();
        let millis = value.parse::<u64>().map_err(|_| {
            RemoteServerError::new(format!("{IDLE_TIMEOUT_ENV} must be milliseconds"))
        })?;
        if millis < IDLE_POLL_INTERVAL.as_millis() as u64 {
            return Err(RemoteServerError::new(format!(
                "{IDLE_TIMEOUT_ENV} must be at least {}",
                IDLE_POLL_INTERVAL.as_millis()
            )));
        }
        Ok(Duration::from_millis(millis))
    }

    struct BrokerEndpoint {
        socket: PathBuf,
        start_lock: PathBuf,
        log: PathBuf,
    }

    impl BrokerEndpoint {
        fn prepare(options: &RemoteServerOptions) -> Result<Self, RemoteServerError> {
            fs::create_dir_all(options.profile_root()).map_err(RemoteServerError::from_io)?;
            let profile_root =
                fs::canonicalize(options.profile_root()).map_err(RemoteServerError::from_io)?;
            let dir_root =
                fs::canonicalize(options.dir_root()).map_err(RemoteServerError::from_io)?;
            let runtime_executable = std::env::current_exe()
                .and_then(fs::canonicalize)
                .map_err(RemoteServerError::from_io)?;
            let effective_uid = rustix::process::geteuid().as_raw();
            let runtime_root = PathBuf::from(format!("/tmp/ash-remote-server-{effective_uid}"));
            ensure_private_runtime_root(&runtime_root, effective_uid)?;
            let identity =
                endpoint_identity(options, &profile_root, &dir_root, &runtime_executable)?;
            Ok(Self {
                socket: runtime_root.join(format!("{identity}.sock")),
                start_lock: runtime_root.join(format!("{identity}.starting")),
                log: runtime_root.join(format!("{identity}.log")),
            })
        }
    }

    pub(super) fn endpoint_identity(
        options: &RemoteServerOptions,
        profile_root: &Path,
        dir_root: &Path,
        runtime_executable: &Path,
    ) -> Result<String, RemoteServerError> {
        let executable_metadata =
            fs::metadata(runtime_executable).map_err(RemoteServerError::from_io)?;
        if !executable_metadata.is_file() {
            return Err(RemoteServerError::new(
                "Remote server runtime executable is not a regular file",
            ));
        }
        let mut digest = Sha256::new();
        digest.update(profile_root.as_os_str().as_bytes());
        digest.update([0]);
        digest.update(dir_root.as_os_str().as_bytes());
        digest.update([0]);
        digest.update(runtime_executable.as_os_str().as_bytes());
        digest.update([0]);
        digest.update(executable_metadata.dev().to_le_bytes());
        digest.update(executable_metadata.ino().to_le_bytes());
        digest.update(executable_metadata.len().to_le_bytes());
        digest.update(executable_metadata.mtime().to_le_bytes());
        digest.update(executable_metadata.mtime_nsec().to_le_bytes());
        digest.update(executable_metadata.ctime().to_le_bytes());
        digest.update(executable_metadata.ctime_nsec().to_le_bytes());
        digest.update([0]);
        if let Some(path) = options.product_services_path() {
            let metadata = fs::symlink_metadata(path).map_err(RemoteServerError::from_io)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > MAX_PRODUCT_SERVICES_IDENTITY_BYTES
            {
                return Err(RemoteServerError::new(
                    "Remote product services manifest is not a bounded regular file",
                ));
            }
            let canonical_path = fs::canonicalize(path).map_err(RemoteServerError::from_io)?;
            let contents = fs::read(&canonical_path).map_err(RemoteServerError::from_io)?;
            digest.update(canonical_path.as_os_str().as_bytes());
            digest.update([0]);
            digest.update(Sha256::digest(contents));
            digest.update([0]);
        }
        digest.update(schema_hash().as_bytes());
        let identity = format!("{:x}", digest.finalize());
        Ok(identity[..32].into())
    }

    fn ensure_private_runtime_root(
        path: &Path,
        effective_uid: u32,
    ) -> Result<(), RemoteServerError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => validate_private_directory(path, &metadata, effective_uid),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                DirBuilder::new()
                    .mode(0o700)
                    .create(path)
                    .map_err(RemoteServerError::from_io)?;
                let metadata = fs::symlink_metadata(path).map_err(RemoteServerError::from_io)?;
                validate_private_directory(path, &metadata, effective_uid)
            }
            Err(error) => Err(RemoteServerError::from_io(error)),
        }
    }

    fn validate_private_directory(
        path: &Path,
        metadata: &fs::Metadata,
        effective_uid: u32,
    ) -> Result<(), RemoteServerError> {
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != effective_uid
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(RemoteServerError::new(format!(
                "Remote server runtime directory is not private: {}",
                path.display()
            )));
        }
        Ok(())
    }

    fn connect_or_start(
        endpoint: &BrokerEndpoint,
        options: &RemoteServerOptions,
    ) -> Result<UnixStream, RemoteServerError> {
        if let Some(stream) = connect_existing(&endpoint.socket)? {
            return Ok(stream);
        }
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        let mut owns_start_lock = false;
        while Instant::now() < deadline {
            if let Some(stream) = connect_existing(&endpoint.socket)? {
                if owns_start_lock {
                    let _ = fs::remove_dir(&endpoint.start_lock);
                }
                return Ok(stream);
            }
            if !owns_start_lock && acquire_start_lock(&endpoint.start_lock)? {
                owns_start_lock = true;
                if let Err(error) = spawn_daemon(endpoint, options) {
                    let _ = fs::remove_dir(&endpoint.start_lock);
                    return Err(error);
                }
            }
            thread::sleep(CONNECT_RETRY_INTERVAL);
        }
        if owns_start_lock {
            let _ = fs::remove_dir(&endpoint.start_lock);
        }
        Err(RemoteServerError::new(format!(
            "Remote server daemon did not become ready; inspect {}",
            endpoint.log.display()
        )))
    }

    fn connect_existing(path: &Path) -> Result<Option<UnixStream>, RemoteServerError> {
        match UnixStream::connect(path) {
            Ok(stream) => Ok(Some(stream)),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(RemoteServerError::from_io(error)),
        }
    }

    fn acquire_start_lock(path: &Path) -> Result<bool, RemoteServerError> {
        match DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(path).map_err(RemoteServerError::from_io)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(RemoteServerError::new(
                        "Remote server start lock is not a real directory",
                    ));
                }
                let stale = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= STALE_START_LOCK_AGE);
                if stale {
                    fs::remove_dir(path).map_err(RemoteServerError::from_io)?;
                }
                Ok(false)
            }
            Err(error) => Err(RemoteServerError::from_io(error)),
        }
    }

    fn spawn_daemon(
        endpoint: &BrokerEndpoint,
        options: &RemoteServerOptions,
    ) -> Result<(), RemoteServerError> {
        let executable = std::env::current_exe().map_err(RemoteServerError::from_io)?;
        let log = open_log(&endpoint.log)?;
        let error_log = log.try_clone().map_err(RemoteServerError::from_io)?;
        let mut command = Command::new(executable);
        command
            .arg("daemon")
            .env("ASH_HOME", options.profile_root())
            .env("ASH_WORKSPACE_ROOT", options.dir_root())
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        if let Some(path) = options.product_services_path() {
            command.env(PRODUCT_SERVICES_PATH_ENV, path);
        }
        command.spawn().map_err(RemoteServerError::from_io)?;
        Ok(())
    }

    fn open_log(path: &Path) -> Result<File, RemoteServerError> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(RemoteServerError::from_io)?;
        let metadata = file.metadata().map_err(RemoteServerError::from_io)?;
        if !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(RemoteServerError::new(
                "Remote server log is not a private regular file",
            ));
        }
        if metadata.len() > MAX_LOG_BYTES {
            file.set_len(0).map_err(RemoteServerError::from_io)?;
        }
        Ok(file)
    }

    fn bind_listener(endpoint: &BrokerEndpoint) -> Result<UnixListener, RemoteServerError> {
        match connect_existing(&endpoint.socket)? {
            Some(_) => {
                return Err(RemoteServerError::new(
                    "Remote server daemon is already running",
                ));
            }
            None => remove_stale_socket(&endpoint.socket)?,
        }
        let listener = UnixListener::bind(&endpoint.socket).map_err(RemoteServerError::from_io)?;
        fs::set_permissions(&endpoint.socket, fs::Permissions::from_mode(0o600))
            .map_err(RemoteServerError::from_io)?;
        Ok(listener)
    }

    fn remove_stale_socket(path: &Path) -> Result<(), RemoteServerError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                fs::remove_file(path).map_err(RemoteServerError::from_io)
            }
            Ok(_) => Err(RemoteServerError::new(
                "Remote server endpoint is not a Unix socket",
            )),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(RemoteServerError::from_io(error)),
        }
    }

    fn proxy_stdio(stream: UnixStream) -> io::Result<()> {
        let mut socket_writer = stream.try_clone()?;
        let input = thread::Builder::new()
            .name("ash-remote-server-stdin".into())
            .spawn(move || {
                let copied = io::copy(&mut io::stdin().lock(), &mut socket_writer);
                let _ = socket_writer.shutdown(Shutdown::Write);
                copied
            })?;
        let mut output = io::stdout().lock();
        relay_output(&mut BufReader::new(stream), &mut output)?;
        input
            .join()
            .map_err(|_| io::Error::other("Remote server stdin proxy panicked"))??;
        Ok(())
    }
}

use crate::server::RemoteServerError;
use crate::server::RemoteServerOptions;

#[cfg(all(test, unix))]
#[path = "broker_tests.rs"]
mod tests;

#[cfg(unix)]
pub(crate) fn connect(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    unix::connect(options)
}

#[cfg(unix)]
pub(crate) fn serve(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    unix::serve(options)
}

#[cfg(not(unix))]
pub(crate) fn connect(_options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    Err(RemoteServerError::new(
        "durable Remote server connections currently require a POSIX host",
    ))
}

#[cfg(not(unix))]
pub(crate) fn serve(_options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    Err(RemoteServerError::new(
        "durable Remote server connections currently require a POSIX host",
    ))
}
