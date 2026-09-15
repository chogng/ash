use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use ash_app_server_protocol::schema_hash;
use ash_uds::SocketDirectory;
use ash_uds::UnixListener;
use ash_uds::UnixStream;
use sha2::Digest;
use sha2::Sha256;

const ENDPOINT_CONTRACT_VERSION: u32 = 2;
const HEARTBEAT_FILE_NAME: &str = "heartbeat";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(50);
const LOCK_TIMEOUT: Duration = Duration::from_secs(75);
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const MAX_LOG_TAIL_BYTES: u64 = 4096;
#[cfg(not(test))]
const STALE_OPERATION_LOCK_AGE: Duration = Duration::from_secs(30);
#[cfg(test)]
const STALE_OPERATION_LOCK_AGE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug)]
pub(crate) struct EndpointPaths {
    directory: SocketDirectory,
    pub(crate) socket: PathBuf,
    pub(crate) operation_lock: PathBuf,
    pub(crate) log: PathBuf,
    pub(crate) pid: PathBuf,
}

impl EndpointPaths {
    pub(crate) fn prepare(profile_root: &Path) -> Result<Self, String> {
        fs::create_dir_all(profile_root).map_err(io_error)?;
        let profile_root = dunce::canonicalize(profile_root).map_err(io_error)?;
        let runtime_root = runtime_root(&profile_root);
        let directory = SocketDirectory::prepare(&runtime_root).map_err(io_error)?;
        let runtime_root = directory.path();
        let identity = endpoint_identity(&profile_root);
        Ok(Self {
            socket: runtime_root.join(format!("{identity}.sock")),
            operation_lock: runtime_root.join(format!("{identity}.operation")),
            log: runtime_root.join(format!("{identity}.log")),
            pid: runtime_root.join(format!("{identity}.pid.json")),
            directory,
        })
    }

    pub(crate) fn acquire_operation_lock(&self) -> Result<OperationLock, String> {
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            match create_private_directory(&self.operation_lock) {
                Ok(()) => return OperationLock::start(self.operation_lock.clone()),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&self.operation_lock).map_err(io_error)?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(
                            "Local App Server operation lock is not a real directory".into()
                        );
                    }
                    let heartbeat = self.operation_lock.join(HEARTBEAT_FILE_NAME);
                    let stale = fs::symlink_metadata(&heartbeat)
                        .or_else(|error| {
                            if error.kind() == io::ErrorKind::NotFound {
                                Ok(metadata)
                            } else {
                                Err(error)
                            }
                        })
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age >= STALE_OPERATION_LOCK_AGE);
                    if stale {
                        match fs::remove_file(&heartbeat) {
                            Ok(()) => {}
                            Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {
                            }
                            Err(remove_error) => return Err(io_error(remove_error)),
                        }
                        match fs::remove_dir(&self.operation_lock) {
                            Ok(()) => continue,
                            Err(remove_error) if remove_error.kind() == io::ErrorKind::NotFound => {
                                continue;
                            }
                            Err(remove_error) => return Err(io_error(remove_error)),
                        }
                    }
                }
                Err(error) => return Err(io_error(error)),
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "timed out waiting for Local App Server operation lock {}",
                    self.operation_lock.display()
                ));
            }
            thread::sleep(LOCK_POLL_INTERVAL);
        }
    }

    pub(crate) fn bind_listener(&self) -> Result<UnixListener, String> {
        match connect_existing(&self.socket)? {
            Some(_) => return Err("Local App Server daemon is already running".into()),
            None => self
                .directory
                .remove_socket(self.socket.file_name().unwrap().as_ref())
                .map_err(io_error)?,
        }
        self.directory
            .bind(self.socket.file_name().unwrap().as_ref())
            .map_err(io_error)
    }

    pub(crate) fn open_log(&self) -> Result<File, String> {
        open_log(&self.log)
    }

    pub(crate) fn log_tail(&self) -> Option<String> {
        read_log_tail(&self.log, MAX_LOG_TAIL_BYTES).ok().flatten()
    }
}

pub(crate) struct OperationLock {
    directory: PathBuf,
    heartbeat: PathBuf,
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl OperationLock {
    fn start(directory: PathBuf) -> Result<Self, String> {
        let heartbeat = directory.join(HEARTBEAT_FILE_NAME);
        write_heartbeat(&heartbeat)?;
        let (stop, receiver) = mpsc::channel();
        let worker_heartbeat = heartbeat.clone();
        let worker = match thread::Builder::new()
            .name("ash-app-server-daemon-lock-heartbeat".into())
            .spawn(move || {
                loop {
                    match receiver.recv_timeout(HEARTBEAT_INTERVAL) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let _ = write_heartbeat(&worker_heartbeat);
                        }
                    }
                }
            }) {
            Ok(worker) => worker,
            Err(error) => {
                let _ = fs::remove_file(&heartbeat);
                let _ = fs::remove_dir(&directory);
                return Err(error.to_string());
            }
        };
        Ok(Self {
            directory,
            heartbeat,
            stop: Some(stop),
            worker: Some(worker),
        })
    }
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = fs::remove_file(&self.heartbeat);
        let _ = fs::remove_dir(&self.directory);
    }
}

pub(crate) struct SocketCleanup(PathBuf);

impl SocketCleanup {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if socket_path_exists(&self.0) {
            let _ = fs::remove_file(&self.0);
        }
    }
}

pub(crate) fn connect_existing(path: &Path) -> Result<Option<UnixStream>, String> {
    let directory =
        SocketDirectory::open(path.parent().ok_or("socket has no parent")?).map_err(io_error)?;
    match directory.connect(path.file_name().ok_or("socket has no filename")?.as_ref()) {
        Ok(stream) => {
            ash_app_server_transport::validate_local_peer(&stream).map_err(io_error)?;
            Ok(Some(stream))
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(io_error(error)),
    }
}

pub(crate) fn endpoint_identity(profile_root: &Path) -> String {
    let mut digest = Sha256::new();
    update_path_digest(&mut digest, profile_root);
    digest.update(b"ash-app-server-daemon");
    digest.update(ENDPOINT_CONTRACT_VERSION.to_le_bytes());
    digest.update(build_info::VERSION.as_bytes());
    digest.update([0]);
    digest.update(schema_hash().as_bytes());
    let identity = format!("{:x}", digest.finalize());
    identity[..32].into()
}

#[cfg(unix)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    digest.update(path.as_os_str().as_bytes());
    digest.update([0]);
}

#[cfg(windows)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;

    for code_unit in path.as_os_str().encode_wide() {
        digest.update(code_unit.to_le_bytes());
    }
    digest.update([0]);
}

#[cfg(unix)]
fn runtime_root(_profile_root: &Path) -> PathBuf {
    let effective_uid = rustix::process::geteuid().as_raw();
    PathBuf::from(format!("/tmp/ash-local-app-server-{effective_uid}"))
}

#[cfg(windows)]
fn runtime_root(profile_root: &Path) -> PathBuf {
    profile_root.join("run")
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    SocketDirectory::create(path).map(drop)
}

fn write_heartbeat(path: &Path) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    fs::write(path, now.to_string()).map_err(io_error)
}

#[cfg(unix)]
fn open_log(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("Local App Server log is not a private regular file".into());
    }
    truncate_log(&file, &metadata)?;
    Ok(file)
}

#[cfg(windows)]
fn open_log(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err("Local App Server log is not a regular file".into());
    }
    truncate_log(&file, &metadata)?;
    Ok(file)
}

fn truncate_log(file: &File, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.len() > MAX_LOG_BYTES {
        file.set_len(0).map_err(io_error)?;
    }
    Ok(())
}

fn read_log_tail(path: &Path, byte_limit: u64) -> Result<Option<String>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let len = file.metadata().map_err(io_error)?.len();
    if len == 0 {
        return Ok(None);
    }
    let start = len.saturating_sub(byte_limit);
    file.seek(SeekFrom::Start(start)).map_err(io_error)?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).map_err(io_error)?;
    let mut bytes = bytes.as_slice();
    if start > 0
        && let Some(newline) = bytes.iter().position(|byte| *byte == b'\n')
    {
        bytes = &bytes[newline + 1..];
    }
    let contents = String::from_utf8_lossy(bytes).trim_end().to_string();
    Ok((!contents.is_empty()).then_some(contents))
}

#[cfg(unix)]
fn socket_path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[cfg(windows)]
fn socket_path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_file())
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "endpoint_tests.rs"]
mod tests;
