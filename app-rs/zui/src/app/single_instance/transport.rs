use std::collections::VecDeque;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

use fs2::FileExt;
use sha2::Digest;
use sha2::Sha256;

#[cfg(unix)]
use std::os::unix::net::UnixListener;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use uds_windows::UnixListener;
#[cfg(windows)]
use uds_windows::UnixStream;

use super::SecondInstance;
use super::SingleInstanceKey;
use super::wire;

const ACQUISITION_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(20);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_PENDING_INVOCATIONS: usize = 64;
const ACKNOWLEDGED: u8 = 1;
const REJECTED: u8 = 0;

pub(crate) enum Acquisition {
    Primary(PrimaryInstance),
    Forwarded,
}

pub(crate) struct PrimaryInstance {
    lock_file: Option<File>,
    socket_path: PathBuf,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    dispatch: Arc<DispatchQueue>,
}

impl PrimaryInstance {
    pub(crate) fn attach(&self, handler: impl Fn(SecondInstance) -> bool + Send + Sync + 'static) {
        self.dispatch.attach(Arc::new(handler));
    }
}

impl Drop for PrimaryInstance {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
        remove_socket(&self.socket_path);
        if let Some(lock_file) = self.lock_file.take() {
            let _ = FileExt::unlock(&lock_file);
        }
    }
}

pub(crate) fn acquire(key: &SingleInstanceKey, event: &SecondInstance) -> io::Result<Acquisition> {
    let paths = EndpointPaths::for_key(key)?;
    acquire_at(paths, event, ACQUISITION_TIMEOUT)
}

fn acquire_at(
    paths: EndpointPaths,
    event: &SecondInstance,
    timeout: Duration,
) -> io::Result<Acquisition> {
    paths.prepare_directory()?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::other("single-instance acquisition deadline overflow"))?;
    let lock_file = loop {
        match OpenOptions::new()
            .create(true)
            .read(true)
            .truncate(false)
            .write(true)
            .open(&paths.lock)
        {
            Ok(lock_file) => break lock_file,
            Err(error) if retryable_lock_open_error(&error) => {
                if Instant::now() >= deadline {
                    return Err(error);
                }
                match forward(&paths.socket, event) {
                    Ok(()) => return Ok(Acquisition::Forwarded),
                    Err(error) if retryable_forward_error(&error) && Instant::now() < deadline => {
                        thread::sleep(RETRY_INTERVAL);
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        }
    };
    loop {
        match FileExt::try_lock_exclusive(&lock_file) {
            Ok(()) => return become_primary(lock_file, paths.socket),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
        match forward(&paths.socket, event) {
            Ok(()) => return Ok(Acquisition::Forwarded),
            Err(error) if retryable_forward_error(&error) && Instant::now() < deadline => {
                thread::sleep(RETRY_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
}

fn become_primary(lock_file: File, socket_path: PathBuf) -> io::Result<Acquisition> {
    remove_socket(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    listener.set_nonblocking(true)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let dispatch = Arc::new(DispatchQueue::default());
    let worker_stopping = Arc::clone(&stopping);
    let worker_dispatch = Arc::clone(&dispatch);
    let worker = match thread::Builder::new()
        .name("zui-single-instance".into())
        .spawn(move || listen(listener, &worker_stopping, &worker_dispatch))
    {
        Ok(worker) => worker,
        Err(error) => {
            remove_socket(&socket_path);
            return Err(error);
        }
    };
    Ok(Acquisition::Primary(PrimaryInstance {
        lock_file: Some(lock_file),
        socket_path,
        stopping,
        worker: Some(worker),
        dispatch,
    }))
}

fn listen(listener: UnixListener, stopping: &AtomicBool, dispatch: &DispatchQueue) {
    while !stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let accepted = receive(&mut stream)
                    .map(|event| dispatch.deliver(event))
                    .unwrap_or(false);
                let response = if accepted { ACKNOWLEDGED } else { REJECTED };
                let _ = stream.write_all(&[response]);
                let _ = stream.flush();
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::park_timeout(RETRY_INTERVAL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) if stopping.load(Ordering::Acquire) => break,
            Err(_) => thread::park_timeout(RETRY_INTERVAL),
        }
    }
}

fn receive(stream: &mut UnixStream) -> io::Result<SecondInstance> {
    stream.set_read_timeout(Some(CONNECTION_TIMEOUT))?;
    stream.set_write_timeout(Some(CONNECTION_TIMEOUT))?;
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = usize::try_from(u32::from_le_bytes(length))
        .map_err(|_| invalid_data("invalid secondary invocation length"))?;
    if length > wire::MAX_MESSAGE_BYTES {
        return Err(invalid_data("secondary invocation exceeds 1 MiB"));
    }
    let mut encoded = vec![0; length];
    stream.read_exact(&mut encoded)?;
    wire::decode(&encoded)
}

fn forward(socket_path: &Path, event: &SecondInstance) -> io::Result<()> {
    let encoded = wire::encode(event)?;
    let length = u32::try_from(encoded.len())
        .map_err(|_| io::Error::other("secondary invocation length overflow"))?;
    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(CONNECTION_TIMEOUT))?;
    stream.set_write_timeout(Some(CONNECTION_TIMEOUT))?;
    stream.write_all(&length.to_le_bytes())?;
    stream.write_all(&encoded)?;
    stream.flush()?;
    let mut response = [0];
    stream.read_exact(&mut response)?;
    match response[0] {
        ACKNOWLEDGED => Ok(()),
        REJECTED => Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "primary application rejected the secondary invocation",
        )),
        _ => Err(invalid_data("invalid primary application acknowledgement")),
    }
}

fn retryable_forward_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::TimedOut
            | io::ErrorKind::WouldBlock
    )
}

fn retryable_lock_open_error(error: &io::Error) -> bool {
    #[cfg(windows)]
    {
        // Windows can reject opening a byte-range-locked file before fs2 can
        // report the contention through try_lock_exclusive.
        matches!(error.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
}

type Handler = dyn Fn(SecondInstance) -> bool + Send + Sync;

#[derive(Default)]
struct DispatchQueue {
    state: Mutex<DispatchState>,
}

#[derive(Default)]
struct DispatchState {
    handler: Option<Arc<Handler>>,
    pending: VecDeque<SecondInstance>,
}

impl DispatchQueue {
    fn attach(&self, handler: Arc<Handler>) {
        let mut state = self.state.lock().expect("single-instance dispatch lock");
        assert!(
            state.handler.is_none(),
            "single-instance handler attached twice"
        );
        state.handler = Some(Arc::clone(&handler));
        while let Some(event) = state.pending.pop_front() {
            if !handler(event) {
                state.pending.clear();
                break;
            }
        }
    }

    fn deliver(&self, event: SecondInstance) -> bool {
        let mut state = self.state.lock().expect("single-instance dispatch lock");
        let Some(handler) = state.handler.clone() else {
            if state.pending.len() == MAX_PENDING_INVOCATIONS {
                return false;
            }
            state.pending.push_back(event);
            return true;
        };
        handler(event)
    }
}

#[derive(Clone)]
struct EndpointPaths {
    lock: PathBuf,
    socket: PathBuf,
}

impl EndpointPaths {
    fn for_key(key: &SingleInstanceKey) -> io::Result<Self> {
        let directory = endpoint_root();
        let token = hash_token(key.as_str().as_bytes(), 16);
        let paths = Self {
            lock: directory.join(format!("{token}.l")),
            socket: directory.join(format!("{token}.s")),
        };
        paths.prepare_directory()?;
        Ok(paths)
    }

    fn prepare_directory(&self) -> io::Result<()> {
        let directory = self
            .lock
            .parent()
            .ok_or_else(|| io::Error::other("single-instance lock has no parent directory"))?;
        fs::create_dir_all(directory)?;
        if !fs::symlink_metadata(directory)?.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "single-instance endpoint parent is not a directory",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn endpoint_root() -> PathBuf {
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR")
        && !runtime.is_empty()
    {
        return PathBuf::from(runtime).join("zsi");
    }
    let identity = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .or_else(|| std::env::var_os("USERNAME"))
        .unwrap_or_default();
    let identity = hash_token(identity.to_string_lossy().as_bytes(), 4);
    std::env::temp_dir().join(format!("zsi-{identity}"))
}

#[cfg(not(target_os = "linux"))]
fn endpoint_root() -> PathBuf {
    std::env::temp_dir().join("zsi")
}

fn hash_token(value: &[u8], byte_count: usize) -> String {
    let digest = Sha256::digest(value);
    let mut token = String::with_capacity(byte_count * 2);
    for byte in &digest[..byte_count] {
        use std::fmt::Write;

        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

fn remove_socket(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
