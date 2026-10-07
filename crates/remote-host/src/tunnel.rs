use std::collections::BTreeMap;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::thread::Thread;
use std::time::Duration;
use std::time::Instant;

use ash_remote::SshHost;
use ash_remote_connections::SshTunnel;
use ash_remote_connections::SshTunnelOptions;
use ash_remote_connections::select_available_loopback_port;

use crate::RemoteTunnelStartup;
use crate::wait_for_remote_tunnel;

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const RECOVERY_WINDOW: Duration = Duration::from_secs(30);
const INITIAL_RECOVERY_DELAY: Duration = Duration::from_millis(250);
const MAX_RECOVERY_DELAY: Duration = Duration::from_secs(2);
static NEXT_TUNNEL_ID: AtomicU32 = AtomicU32::new(1);

/// Stable identity for one logical SSH Tunnel owned by a local Remote host.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RemoteTunnelId(u32);

impl RemoteTunnelId {
    /// Creates an identity from its numeric representation.
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Returns the numeric representation used by product-specific UI identities.
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// A lifecycle update for one logical SSH Tunnel.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteTunnelUpdate {
    /// The loopback listener is ready.
    Ready { local_port: NonZeroU16 },
    /// The SSH process exited and recovery is being attempted.
    Recovering { attempt: u32 },
    /// The Tunnel was stopped by its owner.
    Stopped,
    /// The Tunnel could not start or recover.
    Failed(String),
}

impl RemoteTunnelUpdate {
    /// Returns whether no more updates will be published for this logical Tunnel.
    pub const fn is_terminal(&self) -> bool {
        matches!(self, Self::Stopped | Self::Failed(_))
    }
}

/// A typed lifecycle event emitted by [`RemoteTunnelHost`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteTunnelEvent {
    tunnel_id: RemoteTunnelId,
    remote_port: NonZeroU16,
    update: RemoteTunnelUpdate,
}

impl RemoteTunnelEvent {
    /// Creates an event. This is useful to product adapters and state projection tests.
    pub const fn new(
        tunnel_id: RemoteTunnelId,
        remote_port: NonZeroU16,
        update: RemoteTunnelUpdate,
    ) -> Self {
        Self {
            tunnel_id,
            remote_port,
            update,
        }
    }

    /// Returns the logical Tunnel identity.
    pub const fn tunnel_id(&self) -> RemoteTunnelId {
        self.tunnel_id
    }

    /// Returns the remote endpoint port.
    pub const fn remote_port(&self) -> NonZeroU16 {
        self.remote_port
    }

    /// Returns the lifecycle update.
    pub const fn update(&self) -> &RemoteTunnelUpdate {
        &self.update
    }
}

#[derive(Clone, Debug)]
struct RemoteTunnelTarget {
    host: SshHost,
    ssh_executable: PathBuf,
}

/// Local host-side owner for SSH Tunnels attached to one Remote target.
///
/// The host owns worker threads and OpenSSH child processes. Products receive only typed
/// [`RemoteTunnelEvent`] values through the callback supplied to [`Self::start`]. Dropping the
/// owner cancels every worker and waits for its child process to exit.
pub struct RemoteTunnelHost {
    target: RemoteTunnelTarget,
    processes: BTreeMap<RemoteTunnelId, RemoteTunnelProcess>,
}

impl RemoteTunnelHost {
    /// Creates a Tunnel host for one validated SSH target.
    pub fn new(host: SshHost, ssh_executable: impl Into<PathBuf>) -> Self {
        Self {
            target: RemoteTunnelTarget {
                host,
                ssh_executable: ssh_executable.into(),
            },
            processes: BTreeMap::new(),
        }
    }

    /// Returns the SSH host used by this supervisor.
    pub fn host(&self) -> &SshHost {
        &self.target.host
    }

    /// Starts a logical Tunnel and delivers lifecycle events to `send`.
    pub fn start(
        &mut self,
        remote_port: NonZeroU16,
        send: impl Fn(RemoteTunnelEvent) + Send + 'static,
    ) -> Result<RemoteTunnelId, String> {
        let process = spawn_remote_tunnel(self.target.clone(), remote_port, send)?;
        let tunnel_id = process.tunnel_id();
        self.processes.insert(tunnel_id, process);
        Ok(tunnel_id)
    }

    /// Requests that a logical Tunnel stop. Returns whether it was known to this host.
    pub fn stop(&self, tunnel_id: RemoteTunnelId) -> bool {
        self.processes.get(&tunnel_id).is_some_and(|process| {
            process.cancel();
            true
        })
    }

    /// Applies an event back to the host so terminal workers can be released.
    ///
    /// Product event loops should call this after receiving an event. Unknown events are ignored
    /// and return `false`, which also makes stale events safe during window teardown.
    pub fn handle_event(&mut self, event: &RemoteTunnelEvent) -> bool {
        if !self.processes.contains_key(&event.tunnel_id) {
            return false;
        }
        if event.update.is_terminal() {
            self.processes.remove(&event.tunnel_id);
        }
        true
    }
}

struct RemoteTunnelProcess {
    tunnel_id: RemoteTunnelId,
    cancelled: Arc<AtomicBool>,
    worker_thread: Thread,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl RemoteTunnelProcess {
    const fn tunnel_id(&self) -> RemoteTunnelId {
        self.tunnel_id
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.worker_thread.unpark();
    }
}

impl Drop for RemoteTunnelProcess {
    fn drop(&mut self) {
        self.cancel();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn spawn_remote_tunnel(
    target: RemoteTunnelTarget,
    remote_port: NonZeroU16,
    send: impl Fn(RemoteTunnelEvent) + Send + 'static,
) -> Result<RemoteTunnelProcess, String> {
    let tunnel_id = NEXT_TUNNEL_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .map(RemoteTunnelId::new)
        .map_err(|_| "SSH tunnel identity space is exhausted".to_owned())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = std::thread::Builder::new()
        .name(format!("ash-remote-tunnel-{}", tunnel_id.get()))
        .spawn(move || run_remote_tunnel(tunnel_id, target, remote_port, &worker_cancelled, &send))
        .map_err(|error| format!("could not start SSH tunnel supervisor: {error}"))?;
    let worker_thread = worker.thread().clone();
    Ok(RemoteTunnelProcess {
        tunnel_id,
        cancelled,
        worker_thread,
        worker: Some(worker),
    })
}

fn run_remote_tunnel(
    tunnel_id: RemoteTunnelId,
    target: RemoteTunnelTarget,
    remote_port: NonZeroU16,
    cancelled: &AtomicBool,
    send: &impl Fn(RemoteTunnelEvent),
) {
    let result = run_remote_tunnel_inner(tunnel_id, target, remote_port, cancelled, send);
    if let Err(error) = result {
        send(RemoteTunnelEvent {
            tunnel_id,
            remote_port,
            update: RemoteTunnelUpdate::Failed(error),
        });
    }
}

fn run_remote_tunnel_inner(
    tunnel_id: RemoteTunnelId,
    target: RemoteTunnelTarget,
    remote_port: NonZeroU16,
    cancelled: &AtomicBool,
    send: &impl Fn(RemoteTunnelEvent),
) -> Result<(), String> {
    let local_port = select_available_loopback_port().map_err(|error| error.to_string())?;
    let mut tunnel = match start_tunnel(&target, local_port, remote_port, cancelled)? {
        RemoteTunnelStartup::Ready(tunnel) => tunnel,
        RemoteTunnelStartup::Cancelled => {
            send_stopped(send, tunnel_id, remote_port);
            return Ok(());
        }
    };
    if cancelled.load(Ordering::Acquire) {
        tunnel.stop().map_err(|error| error.to_string())?;
        send_stopped(send, tunnel_id, remote_port);
        return Ok(());
    }
    send(RemoteTunnelEvent {
        tunnel_id,
        remote_port,
        update: RemoteTunnelUpdate::Ready { local_port },
    });
    loop {
        if cancelled.load(Ordering::Acquire) {
            tunnel.stop().map_err(|error| error.to_string())?;
            send_stopped(send, tunnel_id, remote_port);
            return Ok(());
        }
        let failure = match tunnel.try_wait() {
            Ok(Some(status)) => format!("SSH tunnel exited: {status}"),
            Err(error) => format!("could not inspect SSH tunnel: {error}"),
            Ok(None) => {
                wait_unless_cancelled(cancelled, PROCESS_POLL_INTERVAL);
                continue;
            }
        };
        drop(tunnel);
        let Some(recovered) = recover_tunnel(
            send,
            tunnel_id,
            &target,
            local_port,
            remote_port,
            cancelled,
            failure,
        )?
        else {
            return Ok(());
        };
        tunnel = recovered;
    }
}

fn start_tunnel(
    target: &RemoteTunnelTarget,
    local_port: NonZeroU16,
    remote_port: NonZeroU16,
    cancelled: &AtomicBool,
) -> Result<RemoteTunnelStartup, String> {
    let tunnel = SshTunnelOptions::new(target.host.clone(), local_port, remote_port)
        .with_ssh_executable(target.ssh_executable.clone())
        .start()
        .map_err(|error| error.to_string())?;
    wait_for_remote_tunnel(tunnel, || cancelled.load(Ordering::Acquire))
}

fn recover_tunnel(
    send: &impl Fn(RemoteTunnelEvent),
    tunnel_id: RemoteTunnelId,
    target: &RemoteTunnelTarget,
    local_port: NonZeroU16,
    remote_port: NonZeroU16,
    cancelled: &AtomicBool,
    mut last_failure: String,
) -> Result<Option<SshTunnel>, String> {
    let started = Instant::now();
    let mut attempts = 0_usize;
    loop {
        if cancelled.load(Ordering::Acquire) {
            send_stopped(send, tunnel_id, remote_port);
            return Ok(None);
        }
        let Some(delay) = recovery_delay_within_window(started.elapsed(), attempts) else {
            return Err(format!(
                "SSH tunnel did not recover within {} seconds after {attempts} attempts: {last_failure}",
                RECOVERY_WINDOW.as_secs()
            ));
        };
        attempts += 1;
        send(RemoteTunnelEvent {
            tunnel_id,
            remote_port,
            update: RemoteTunnelUpdate::Recovering {
                attempt: attempts as u32,
            },
        });
        if !wait_unless_cancelled(cancelled, delay) {
            send_stopped(send, tunnel_id, remote_port);
            return Ok(None);
        }
        match start_tunnel(target, local_port, remote_port, cancelled) {
            Ok(RemoteTunnelStartup::Ready(tunnel)) => {
                if cancelled.load(Ordering::Acquire) {
                    tunnel.stop().map_err(|error| error.to_string())?;
                    send_stopped(send, tunnel_id, remote_port);
                    return Ok(None);
                }
                send(RemoteTunnelEvent {
                    tunnel_id,
                    remote_port,
                    update: RemoteTunnelUpdate::Ready { local_port },
                });
                return Ok(Some(tunnel));
            }
            Ok(RemoteTunnelStartup::Cancelled) => {
                send_stopped(send, tunnel_id, remote_port);
                return Ok(None);
            }
            Err(error) => last_failure = error,
        }
    }
}

fn recovery_delay_within_window(elapsed: Duration, attempt: usize) -> Option<Duration> {
    let remaining = RECOVERY_WINDOW.checked_sub(elapsed)?;
    let delay = recovery_delay(attempt);
    (delay <= remaining).then_some(delay)
}

fn recovery_delay(attempt: usize) -> Duration {
    let multiplier = 1_u32 << (attempt.min(31) as u32);
    (INITIAL_RECOVERY_DELAY * multiplier).min(MAX_RECOVERY_DELAY)
}

fn wait_unless_cancelled(cancelled: &AtomicBool, delay: Duration) -> bool {
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Acquire) {
            return false;
        }
        let Some(remaining) = delay.checked_sub(started.elapsed()) else {
            return true;
        };
        std::thread::park_timeout(remaining);
    }
}

fn send_stopped(
    send: &impl Fn(RemoteTunnelEvent),
    tunnel_id: RemoteTunnelId,
    remote_port: NonZeroU16,
) {
    send(RemoteTunnelEvent {
        tunnel_id,
        remote_port,
        update: RemoteTunnelUpdate::Stopped,
    });
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::num::NonZeroU16;
    #[cfg(unix)]
    use std::path::Path;
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::sync::mpsc;
    #[cfg(unix)]
    use std::thread::JoinHandle;
    #[cfg(unix)]
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    #[cfg(unix)]
    use ash_remote::SshHost;
    #[cfg(unix)]
    use tempfile::TempDir;

    use super::RemoteTunnelId;
    #[cfg(unix)]
    use super::RemoteTunnelTarget;
    use super::RemoteTunnelUpdate;
    use super::recovery_delay;
    #[cfg(unix)]
    use super::spawn_remote_tunnel;

    #[cfg(unix)]
    const TEST_EVENT_TIMEOUT: Duration = Duration::from_secs(5);

    #[cfg(unix)]
    #[test]
    fn supervisor_reports_ready_arguments_and_stops_its_child() {
        let directory = TempDir::new().unwrap();
        let fake_ssh = directory.path().join("fake-ssh");
        let arguments_path = directory.path().join("arguments.txt");
        std::fs::write(
            &fake_ssh,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec sleep 60\n",
                arguments_path.display()
            ),
        )
        .unwrap();
        make_executable(&fake_ssh);
        let listener = FakeTunnelListener::start(arguments_path.clone());
        let (sender, receiver) = mpsc::channel();
        let process = spawn_remote_tunnel(
            RemoteTunnelTarget {
                host: SshHost::parse("build.example").unwrap(),
                ssh_executable: fake_ssh,
            },
            NonZeroU16::new(3_000).unwrap(),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();

        let ready = receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap();
        let local_port = match ready.update() {
            RemoteTunnelUpdate::Ready { local_port } => *local_port,
            update => panic!("unexpected startup update: {update:?}"),
        };
        let arguments = read_when_available(&arguments_path);
        assert_eq!(
            arguments,
            format!(
                "-N\n-T\n-o\nBatchMode=yes\n-o\nExitOnForwardFailure=yes\n-o\nConnectTimeout=10\n-L\n127.0.0.1:{local_port}:127.0.0.1:3000\nbuild.example\n"
            )
        );

        drop(process);
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Stopped
        );
        drop(listener);
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_does_not_publish_an_early_openssh_exit() {
        let (sender, receiver) = mpsc::channel();
        let _process = spawn_remote_tunnel(
            RemoteTunnelTarget {
                host: SshHost::parse("build.example").unwrap(),
                ssh_executable: "/usr/bin/false".into(),
            },
            NonZeroU16::new(3_000).unwrap(),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();

        let event = receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap();
        assert!(
            matches!(event.update(), RemoteTunnelUpdate::Failed(error) if error.contains("before it became ready"))
        );
    }

    #[test]
    fn tunnel_ids_preserve_numeric_identity_for_product_adapters() {
        let id = RemoteTunnelId::new(42);
        assert_eq!(id.get(), 42);
    }

    #[test]
    fn recovery_backoff_is_exponential_and_bounded() {
        assert_eq!(recovery_delay(0), std::time::Duration::from_millis(250));
        assert_eq!(recovery_delay(1), std::time::Duration::from_millis(500));
        assert_eq!(recovery_delay(2), std::time::Duration::from_secs(1));
        assert_eq!(recovery_delay(3), std::time::Duration::from_secs(2));
        assert_eq!(recovery_delay(30), std::time::Duration::from_secs(2));
    }

    #[test]
    fn terminal_updates_are_terminal() {
        assert!(RemoteTunnelUpdate::Stopped.is_terminal());
        assert!(RemoteTunnelUpdate::Failed("failure".into()).is_terminal());
        assert!(!RemoteTunnelUpdate::Recovering { attempt: 1 }.is_terminal());
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_recovers_on_the_same_local_port() {
        let directory = TempDir::new().unwrap();
        let fake_ssh = directory.path().join("fake-ssh");
        std::fs::write(
            &fake_ssh,
            "#!/bin/sh\n\
directory=$(dirname \"$0\")\n\
count_path=\"$directory/invocation-count\"\n\
count=0\n\
if [ -f \"$count_path\" ]; then count=$(cat \"$count_path\"); fi\n\
count=$((count + 1))\n\
printf '%s' \"$count\" > \"$count_path\"\n\
printf '%s\\n' \"$@\" > \"$directory/arguments-$count.txt\"\n\
if [ \"$count\" -eq 1 ]; then sleep 0.15; exit 17; fi\n\
exec sleep 60\n",
        )
        .unwrap();
        make_executable(&fake_ssh);
        let listener = FakeTunnelListener::start(directory.path().join("arguments-1.txt"));
        let (sender, receiver) = mpsc::channel();
        let process = spawn_remote_tunnel(
            RemoteTunnelTarget {
                host: SshHost::parse("build.example").unwrap(),
                ssh_executable: fake_ssh,
            },
            NonZeroU16::new(3_000).unwrap(),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();

        let first_ready = receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap();
        let local_port = match first_ready.update() {
            RemoteTunnelUpdate::Ready { local_port } => *local_port,
            update => panic!("unexpected first update: {update:?}"),
        };
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Recovering { attempt: 1 }
        );
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Ready { local_port }
        );

        let first_arguments = read_when_available(&directory.path().join("arguments-1.txt"));
        let second_arguments = read_when_available(&directory.path().join("arguments-2.txt"));
        let forward = format!("127.0.0.1:{local_port}:127.0.0.1:3000");
        assert!(first_arguments.lines().any(|argument| argument == forward));
        assert!(second_arguments.lines().any(|argument| argument == forward));

        drop(process);
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Stopped
        );
        drop(listener);
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_recovery_interrupts_the_backoff() {
        let directory = TempDir::new().unwrap();
        let fake_ssh = directory.path().join("fake-ssh");
        std::fs::write(
            &fake_ssh,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0%/*}/arguments.txt\"\nsleep 0.15\nexit 17\n",
        )
        .unwrap();
        make_executable(&fake_ssh);
        let listener = FakeTunnelListener::start(directory.path().join("arguments.txt"));
        let (sender, receiver) = mpsc::channel();
        let process = spawn_remote_tunnel(
            RemoteTunnelTarget {
                host: SshHost::parse("build.example").unwrap(),
                ssh_executable: fake_ssh,
            },
            NonZeroU16::new(3_000).unwrap(),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();

        assert!(matches!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            RemoteTunnelUpdate::Ready { .. }
        ));
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Recovering { attempt: 1 }
        );
        let started = Instant::now();
        drop(process);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(
            receiver.recv_timeout(TEST_EVENT_TIMEOUT).unwrap().update(),
            &RemoteTunnelUpdate::Stopped
        );
        drop(listener);
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(unix)]
    fn read_when_available(path: &Path) -> String {
        let deadline = Instant::now() + TEST_EVENT_TIMEOUT;
        loop {
            match std::fs::read_to_string(path) {
                Ok(contents) if !contents.is_empty() => return contents,
                Ok(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(contents) => return contents,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("could not read fake OpenSSH arguments: {error}"),
            }
        }
    }

    #[cfg(unix)]
    struct FakeTunnelListener {
        stop: mpsc::Sender<()>,
        worker: Option<JoinHandle<()>>,
    }

    #[cfg(unix)]
    impl FakeTunnelListener {
        fn start(arguments_path: PathBuf) -> Self {
            let (stop, receiver) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let arguments = read_when_available(&arguments_path);
                let local_port = forwarded_local_port(&arguments);
                let _listener = std::net::TcpListener::bind(("127.0.0.1", local_port)).unwrap();
                let _ = receiver.recv();
            });
            Self {
                stop,
                worker: Some(worker),
            }
        }
    }

    #[cfg(unix)]
    impl Drop for FakeTunnelListener {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                if std::thread::panicking() {
                    let _ = worker.join();
                } else {
                    worker.join().unwrap();
                }
            }
        }
    }

    #[cfg(unix)]
    fn forwarded_local_port(arguments: &str) -> u16 {
        let mut arguments = arguments.lines();
        while let Some(argument) = arguments.next() {
            if argument == "-L" {
                return arguments
                    .next()
                    .and_then(|forward| forward.split(':').nth(1))
                    .and_then(|port| port.parse().ok())
                    .expect("fake OpenSSH should receive a loopback forward");
            }
        }
        panic!("fake OpenSSH did not receive -L");
    }
}
