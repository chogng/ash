//! macOS's synchronous FSEvents registration/stop calls are not cancellable. Keep them in
//! a killable helper; neither an OS stall nor notify's runloop join may retain the product.

use notify::Event;
use notify::EventKind;
use notify::RecursiveMode;
use notify::Watcher;
use notify::event::DataChange;
use notify::event::Flag;
use notify::event::ModifyKind;
use notify::event::RenameMode;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::os::fd::AsFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

/// Private arg0 role implemented by products that embed this watcher.
pub const NATIVE_WATCHER_ARGUMENT: &str = "--ash-native-file-watcher";
const VERSION: u16 = 2;

mod polling;
pub use polling::run_polling_watcher;
pub const POLLING_WATCHER_ARGUMENT: &str = "--ash-polling-file-watcher";
const MAX_FRAME: u64 = 4 * 1024 * 1024;
const MAX_PATHS: usize = 10_000;
const START_TIMEOUT: Duration = Duration::from_secs(2);
const REGISTER_TIMEOUT: Duration = Duration::from_secs(1);
const EVENT_TIMEOUT: Duration = Duration::from_millis(750);
const BACKEND_RETRY_INTERVAL: Duration = Duration::from_secs(30);
static RETRY_AFTER: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn backend_available() -> bool {
    RETRY_AFTER
        .lock()
        .unwrap()
        .is_none_or(|deadline| Instant::now() >= deadline)
}

fn backend_failed() {
    *RETRY_AFTER.lock().unwrap() = Some(Instant::now() + BACKEND_RETRY_INTERVAL);
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WatchRequest {
    id: u64,
    paths: Vec<WireWatch>,
    replace: Vec<Vec<u8>>,
    probe: Vec<u8>,
    polling_interval_millis: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireWatch {
    path: Vec<u8>,
    recursive: bool,
    contents: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
enum Change {
    Content,
    Metadata,
    Topology,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Reply {
    Ready {
        version: u16,
    },
    Applied {
        id: u64,
        error: Option<ApplyFailure>,
    },
    Changed {
        kind: Change,
        paths: Vec<Vec<u8>>,
    },
    Rescan {},
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", content = "message", deny_unknown_fields)]
enum ApplyFailure {
    Backend(String),
    Path(String),
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<(), String>>>>>;

/// One helper and its private duplex socket. Reader shutdown follows socket shutdown and
/// child termination; no thread is detached and the helper never spawns descendants.
pub(crate) struct NativeWatcher {
    child: Child,
    socket: UnixStream,
    reader: Option<thread::JoinHandle<()>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    paths: BTreeMap<PathBuf, RecursiveMode>,
    next_id: u64,
    timeout: Duration,
    probe: tempfile::TempDir,
}

enum HelperMode {
    Native,
    Polling,
}

impl HelperMode {
    fn argument(&self) -> &'static str {
        match self {
            Self::Native => NATIVE_WATCHER_ARGUMENT,
            Self::Polling => POLLING_WATCHER_ARGUMENT,
        }
    }
}

fn helper_command(mode: HelperMode) -> Result<Command, String> {
    let mut command = if let Some(host) = std::env::var_os("ASH_FILE_WATCHER_TEST_HOST") {
        let mut host = PathBuf::from(host);
        if !host.is_absolute()
            && let (Some(root), Some(workspace)) = (
                std::env::var_os("TEST_SRCDIR"),
                std::env::var_os("TEST_WORKSPACE"),
            )
        {
            host = PathBuf::from(root).join(workspace).join(host);
        }
        if !host.is_absolute() || !host.is_file() {
            return Err("file watcher test host must be an existing absolute executable".into());
        }
        let mut command = Command::new(host);
        command.arg(mode.argument());
        command
    } else {
        let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        #[cfg(not(test))]
        command.arg(mode.argument());
        #[cfg(test)]
        command.args([
            "--exact",
            match mode {
                HelperMode::Native => "native::tests::native_process_helper",
                HelperMode::Polling => "native::tests::polling_process_helper",
            },
            "--ignored",
            "--nocapture",
        ]);
        command
    };
    command.env_clear();
    Ok(command)
}

impl NativeWatcher {
    pub(crate) fn new(events: crate::ingress::EventSender) -> Result<Self, String> {
        let command = helper_command(HelperMode::Native)?;
        Self::spawn(command, events, REGISTER_TIMEOUT).inspect_err(|_| backend_failed())
    }

    pub(crate) fn spawn(
        mut command: Command,
        events: crate::ingress::EventSender,
        timeout: Duration,
    ) -> Result<Self, String> {
        // The parent owns probe cleanup even when the helper must be killed inside an OS call.
        let probe = tempfile::Builder::new()
            .prefix("ash-native-watch-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        let (socket, child_socket) = UnixStream::pair().map_err(|error| error.to_string())?;
        socket
            .set_write_timeout(Some(timeout))
            .map_err(|error| error.to_string())?;
        let input: std::os::fd::OwnedFd = child_socket.into();
        let child = command
            .stdin(Stdio::from(input))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let pending: Pending = Arc::default();
        let (ready, started) = mpsc::channel();
        pending.lock().unwrap().insert(0, ready);
        let alive = Arc::new(AtomicBool::new(true));
        let mut watcher = Self {
            child,
            socket,
            reader: None,
            pending,
            alive,
            paths: BTreeMap::new(),
            next_id: 1,
            timeout,
            probe,
        };
        let reader = watcher
            .socket
            .try_clone()
            .map_err(|error| error.to_string())?;
        let waiting = Arc::clone(&watcher.pending);
        let live = Arc::clone(&watcher.alive);
        watcher.reader = Some(
            thread::Builder::new()
                .name("ash-native-watcher-reader".into())
                .spawn(move || {
                    let result = read_replies(reader, &waiting, &events);
                    let message = result
                        .err()
                        .unwrap_or_else(|| "native watcher exited".into());
                    for (_, sender) in waiting.lock().unwrap().drain() {
                        let _ = sender.send(Err(message.clone()));
                    }
                    if live.swap(false, Ordering::AcqRel) {
                        backend_failed();
                        let _ = events.send(Err(notify::Error::generic(&message)));
                    }
                })
                .map_err(|error| error.to_string())?,
        );
        started
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| "native watcher did not initialize".to_string())??;
        Ok(watcher)
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(crate) fn new_polling(events: crate::ingress::EventSender) -> Result<Self, String> {
        let command = helper_command(HelperMode::Polling)?;
        Self::spawn(command, events, REGISTER_TIMEOUT)
    }

    pub(crate) fn apply_polling(
        &mut self,
        paths: &BTreeMap<PathBuf, (RecursiveMode, bool)>,
        replaced: &BTreeSet<PathBuf>,
        interval: Duration,
    ) -> Result<(), String> {
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or("polling watcher request IDs exhausted")?;
        let request = WatchRequest {
            id,
            paths: paths
                .iter()
                .map(|(path, (mode, contents))| WireWatch {
                    path: path.as_os_str().as_bytes().to_vec(),
                    recursive: *mode == RecursiveMode::Recursive,
                    contents: *contents,
                })
                .collect(),
            replace: replaced
                .iter()
                .map(|path| path.as_os_str().as_bytes().to_vec())
                .collect(),
            probe: Vec::new(),
            polling_interval_millis: Some(interval.as_millis().clamp(1, 60_000) as u64),
        };
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let result = write_frame(&mut self.socket, &request).and_then(|()| {
            receiver
                .recv_timeout(self.timeout)
                .map_err(|_| "polling watcher registration deadline elapsed".to_string())?
        });
        if result.is_err() {
            self.stop();
        }
        result
    }

    pub(crate) fn apply(
        &mut self,
        added: &BTreeMap<PathBuf, RecursiveMode>,
        removed: &BTreeSet<PathBuf>,
    ) -> Result<(), String> {
        if !self.is_alive() {
            return Err("native watcher is unavailable".into());
        }
        let previous = self.paths.clone();
        for path in removed {
            self.paths.remove(path);
        }
        self.paths
            .extend(added.iter().map(|(path, mode)| (path.clone(), *mode)));
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or("native watcher request IDs exhausted")?;
        let request = WatchRequest {
            id,
            polling_interval_millis: None,
            probe: self
                .probe
                .path()
                .canonicalize()
                .map_err(|error| error.to_string())?
                .as_os_str()
                .as_bytes()
                .to_vec(),
            paths: self
                .paths
                .iter()
                .map(|(path, mode)| WireWatch {
                    path: path.as_os_str().as_bytes().to_vec(),
                    recursive: *mode == RecursiveMode::Recursive,
                    contents: true,
                })
                .collect(),
            replace: removed
                .iter()
                .filter(|path| self.paths.contains_key(*path))
                .map(|path| path.as_os_str().as_bytes().to_vec())
                .collect(),
        };
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let result = write_frame(&mut self.socket, &request)
            .inspect_err(|_| backend_failed())
            .and_then(|()| {
                receiver.recv_timeout(self.timeout).map_err(|_| {
                    backend_failed();
                    "native watcher registration deadline elapsed".to_string()
                })?
            });
        if result.is_err() {
            self.paths = previous;
            self.stop();
        }
        result
    }

    fn stop(&mut self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.socket.shutdown(Shutdown::Both);
        // notify::drop can itself block in FSEvents stop/join. Reap the OS process instead.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for NativeWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_replies(
    socket: UnixStream,
    pending: &Pending,
    events: &crate::ingress::EventSender,
) -> Result<(), String> {
    let mut reader = BufReader::new(socket);
    while let Some(reply) = read_frame::<Reply>(&mut reader)? {
        match reply {
            Reply::Ready { version } => {
                if version != VERSION {
                    return Err("native watcher protocol mismatch".into());
                }
                acknowledge(pending, 0, Ok(()))?;
            }
            Reply::Applied { id, error } => {
                let result = match error {
                    None => Ok(()),
                    Some(ApplyFailure::Backend(message)) => {
                        backend_failed();
                        Err(message)
                    }
                    Some(ApplyFailure::Path(message)) => Err(message),
                };
                acknowledge(pending, id, result)?;
            }
            Reply::Changed { kind, paths } => {
                if paths.len() > MAX_PATHS {
                    return Err("native watcher event limit exceeded".into());
                }
                let mut event = Event::new(EventKind::Modify(match kind {
                    Change::Content => ModifyKind::Data(DataChange::Any),
                    Change::Metadata => ModifyKind::Metadata(notify::event::MetadataKind::Any),
                    Change::Topology => ModifyKind::Name(RenameMode::Any),
                }));
                event.paths = paths
                    .into_iter()
                    .map(decode_path)
                    .collect::<Result<_, _>>()?;
                let _ = events.send(Ok(event));
            }
            Reply::Rescan {} => {
                let _ = events.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)));
            }
        }
    }
    Ok(())
}

fn acknowledge(pending: &Pending, id: u64, result: Result<(), String>) -> Result<(), String> {
    let sender = pending
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or("unknown native watcher response")?;
    sender
        .send(result)
        .map_err(|_| "native watcher response was retired".into())
}

fn read_frame<T: serde::de::DeserializeOwned>(
    reader: &mut impl BufRead,
) -> Result<Option<T>, String> {
    let mut bytes = Vec::new();
    if reader
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?
        == 0
    {
        return Ok(None);
    }
    if bytes.len() as u64 > MAX_FRAME || bytes.last() != Some(&b'\n') {
        return Err("invalid native watcher frame".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "invalid native watcher message".into())
}

fn write_frame(writer: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "invalid native watcher message")?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_FRAME {
        return Err("native watcher frame limit exceeded".into());
    }
    writer.write_all(&bytes).map_err(|error| error.to_string())
}

fn decode_path(bytes: Vec<u8>) -> Result<PathBuf, String> {
    if bytes.is_empty() || bytes.len() > 32 * 1024 || bytes.contains(&0) {
        return Err("invalid native watcher path".into());
    }
    let path = PathBuf::from(OsString::from_vec(bytes));
    if !path.is_absolute() {
        return Err("native watcher path must be absolute".into());
    }
    Ok(path)
}

/// Runs only the internal arg0 watcher role over an inherited private duplex stdin socket.
/// No workspace, installation state, credentials or product RPC is loaded in this process.
pub fn run_native_watcher() -> Result<(), String> {
    let socket = UnixStream::from(
        std::io::stdin()
            .as_fd()
            .try_clone_to_owned()
            .map_err(|error| error.to_string())?,
    );
    socket
        .set_write_timeout(Some(REGISTER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(
        socket.try_clone().map_err(|error| error.to_string())?,
    ));
    let output = Arc::clone(&writer);
    type Probe = Arc<Mutex<Option<(PathBuf, mpsc::Sender<()>)>>>;
    let probe: Probe = Arc::default();
    let observed_probe = Arc::clone(&probe);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = &result
            && let Some((path, sender)) = &*observed_probe.lock().unwrap()
            && event
                .paths
                .iter()
                .all(|event_path| event_path.starts_with(path.parent().unwrap()))
            && !event.paths.is_empty()
        {
            if event.paths.contains(path) && is_mutation(event.kind) && !event.need_rescan() {
                let _ = sender.send(());
            }
            return;
        }
        let reply = match result {
            Ok(event) if !event.need_rescan() && is_mutation(event.kind) => Reply::Changed {
                kind: match event.kind {
                    EventKind::Modify(ModifyKind::Data(_)) => Change::Content,
                    EventKind::Modify(ModifyKind::Metadata(_)) => Change::Metadata,
                    _ => Change::Topology,
                },
                paths: event
                    .paths
                    .iter()
                    .map(|path| path.as_os_str().as_bytes().to_vec())
                    .collect(),
            },
            Ok(event) if !event.need_rescan() => return,
            Ok(_) | Err(_) => Reply::Rescan {},
        };
        if write_frame(&mut *output.lock().unwrap(), &reply).is_err() {
            // A broken/full channel or oversized event must be observable by the parent.
            // Dropping notify here could block on its own callback/runloop thread.
            std::process::exit(1);
        }
    })
    .map_err(|error| error.to_string())?;
    write_frame(
        &mut *writer.lock().unwrap(),
        &Reply::Ready { version: VERSION },
    )?;
    // Observe parent death independently of synchronous native calls. EOF must terminate
    // this helper even while the control thread is stuck in FSEvents or notify::drop.
    let (requests, incoming) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("ash-native-watcher-control".into())
        .spawn(move || {
            let mut reader = BufReader::new(socket);
            loop {
                match read_frame::<WatchRequest>(&mut reader) {
                    Ok(Some(request)) => {
                        if requests.try_send(request).is_err() {
                            std::process::exit(1);
                        }
                    }
                    Ok(None) => std::process::exit(0),
                    Err(_) => std::process::exit(1),
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let mut active = BTreeMap::<PathBuf, RecursiveMode>::new();
    let mut last_id = 0;
    while let Ok(request) = incoming.recv() {
        if request.polling_interval_millis.is_some()
            || request.id <= last_id
            || request.paths.len() > MAX_PATHS
            || request.replace.len() > MAX_PATHS
        {
            return Err("invalid native watcher request".into());
        }
        last_id = request.id;
        let has_roots = !request.paths.is_empty();
        let mut next = BTreeMap::new();
        for path in request.paths {
            if next
                .insert(
                    decode_path(path.path)?,
                    if path.recursive {
                        RecursiveMode::Recursive
                    } else {
                        RecursiveMode::NonRecursive
                    },
                )
                .is_some()
            {
                return Err("duplicate native watcher path".into());
            }
        }
        let replace = request
            .replace
            .into_iter()
            .map(decode_path)
            .collect::<Result<BTreeSet<_>, _>>()?;
        let probe_root = decode_path(request.probe)?;
        let readiness = if has_roots {
            next.insert(probe_root.clone(), RecursiveMode::NonRecursive);
            let path = probe_root.join(format!("event-{}", request.id));
            let (sender, receiver) = mpsc::channel();
            *probe.lock().unwrap() = Some((path.clone(), sender));
            Some((path, receiver))
        } else {
            None
        };
        let mut batch = watcher.paths_mut();
        let mut failure = None;
        let mut backend_failure = false;
        for (path, mode) in &active {
            if next.get(path) != Some(mode) || replace.contains(path) {
                if let Err(error) = batch.remove(path)
                    && !matches!(error.kind, notify::ErrorKind::WatchNotFound)
                {
                    failure.get_or_insert(error.to_string());
                }
            }
        }
        for (path, mode) in &next {
            if active.get(path) != Some(mode) || replace.contains(path) {
                if let Err(error) = batch.add(path, *mode) {
                    failure.get_or_insert(error.to_string());
                }
            }
        }
        if let Err(error) = batch.commit() {
            failure.get_or_insert(error.to_string());
        }
        if failure.is_none()
            && let Some((path, receiver)) = readiness
        {
            // FSEventStreamStart succeeding does not prove events are being delivered.
            // Check the newly committed stream with a unique file outside all product roots.
            let result = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| error.to_string())
                .and_then(|_| {
                    receiver.recv_timeout(EVENT_TIMEOUT).map_err(|_| {
                        "native watcher did not deliver its readiness event".to_string()
                    })
                });
            if let Err(error) = result {
                backend_failure = true;
                failure.get_or_insert(error);
            }
            // Leave the probe identity installed until the next transaction, so delayed
            // create/remove events cannot appear as product filesystem changes.
            let _ = std::fs::remove_file(path);
        }
        if failure.is_none() {
            active = next;
        }
        write_frame(
            &mut *writer.lock().unwrap(),
            &Reply::Applied {
                id: request.id,
                error: failure.map(|error| {
                    if backend_failure {
                        ApplyFailure::Backend(error)
                    } else {
                        ApplyFailure::Path(error)
                    }
                }),
            },
        )?;
    }
    Ok(())
}

fn is_mutation(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;
