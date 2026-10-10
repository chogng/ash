use std::io;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_protocol::RemoteTunnelHostInfo;
use ash_app_server_protocol::WebListenInfo;
use ash_remote::SshHost;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(50);
const MAX_RECORD: u64 = 16_384;

/// Owns one application-scoped inbound SSH listener and an existing App Server Web lease.
/// Closing stdin cancels startup or releases both resources; credentials stay in OpenSSH.
pub fn run_hosted_tunnel(arguments: Vec<String>) -> io::Result<()> {
    let options = Options::parse(arguments)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let stop_reader = Arc::clone(&stopped);
    thread::spawn(move || {
        let mut byte = [0];
        while std::io::stdin()
            .read(&mut byte)
            .is_ok_and(|count| count > 0)
        {}
        stop_reader.store(true, Ordering::Release);
    });
    host(&options, &stopped, &mut std::io::stdout().lock())
}

struct Options {
    relay: SshHost,
    ssh: PathBuf,
    backend: PathBuf,
    assets: PathBuf,
}

impl Options {
    fn parse(arguments: Vec<String>) -> io::Result<Self> {
        let mut values = std::collections::BTreeMap::new();
        for pair in arguments.chunks(2) {
            let [key, value] = pair else {
                return Err(invalid("host options require values"));
            };
            if !matches!(key.as_str(), "--relay" | "--ssh" | "--backend" | "--assets")
                || values.insert(key.as_str(), value).is_some()
            {
                return Err(invalid("unknown or repeated host option"));
            }
        }
        let mut required = |key| {
            values
                .remove(key)
                .cloned()
                .ok_or_else(|| invalid("missing host option"))
        };
        let relay = SshHost::parse(required("--relay")?).map_err(invalid)?;
        let options = Self {
            relay,
            ssh: required("--ssh")?.into(),
            backend: required("--backend")?.into(),
            assets: required("--assets")?.into(),
        };
        if !options.backend.is_absolute()
            || !options.assets.is_absolute()
            || !options
                .assets
                .join("browser/workbench/workbench.html")
                .is_file()
        {
            return Err(invalid(
                "hosting requires packaged backend and Browser Workbench assets",
            ));
        }
        Ok(options)
    }
}

fn host(options: &Options, stopped: &AtomicBool, output: &mut impl Write) -> io::Result<()> {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut web = OwnedChild::spawn(
        Command::new(&options.backend)
            .arg("--web")
            .arg("--assets")
            .arg(&options.assets)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()),
    )?;
    let reader = web
        .child
        .stdout
        .take()
        .ok_or_else(|| invalid("missing Web output"))?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut record = Vec::new();
        let result = io::BufReader::new(reader)
            .take(MAX_RECORD + 1)
            .read_until(b'\n', &mut record)
            .and_then(|length| {
                if length == 0 || length > MAX_RECORD as usize || record.last() != Some(&b'\n') {
                    return Err(invalid("invalid Web launch record"));
                }
                serde_json::from_slice::<WebListenInfo>(&record).map_err(invalid)
            });
        let _ = sender.send(result);
    });
    let info = loop {
        check_stopped(stopped, deadline)?;
        web.check_running()?;
        match receiver.recv_timeout(POLL) {
            Ok(info) => break info?,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(invalid("Web launcher closed"));
            }
        }
    };
    let endpoint = url::Url::parse(&info.endpoint).map_err(invalid)?;
    let port = endpoint
        .port()
        .ok_or_else(|| invalid("Web endpoint has no port"))?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") || port == 0 {
        return Err(invalid("Web endpoint must remain loopback HTTP"));
    }
    // A private, short socket path avoids other users controlling the SSH master and
    // stays within macOS's Unix-socket path limit even with a long user profile path.
    let control_directory = tempfile::Builder::new()
        .prefix("ash-host-")
        .tempdir_in(std::env::temp_dir())?;
    let control = control_directory.path().join("s");
    let master_process = OwnedChild::spawn(
        Command::new(&options.ssh)
            .args(["-M", "-N", "-T", "-S"])
            .arg(&control)
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ControlPersist=no",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=2",
            ])
            .arg(options.relay.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )?;
    let mut master = SshMaster {
        process: master_process,
        ssh: options.ssh.clone(),
        control: control.clone(),
        relay: options.relay.as_str().into(),
    };
    loop {
        check_stopped(stopped, deadline)?;
        master.process.check_running()?;
        let mut check = OwnedChild::spawn(
            Command::new(&options.ssh)
                .arg("-S")
                .arg(&control)
                .args(["-O", "check"])
                .arg(options.relay.as_str())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )?;
        if check.wait(stopped, deadline)?.success() {
            break;
        }
        thread::sleep(POLL);
    }
    let allocation = tempfile::tempfile()?;
    let mut forward = OwnedChild::spawn(
        Command::new(&options.ssh)
            .arg("-S")
            .arg(&control)
            .args(["-O", "forward", "-R"])
            .arg(format!("127.0.0.1:0:127.0.0.1:{port}"))
            .arg(options.relay.as_str())
            .stdin(Stdio::null())
            .stdout(allocation.try_clone()?)
            .stderr(Stdio::null()),
    )?;
    if !forward.wait(stopped, deadline)?.success() {
        return Err(invalid("SSH relay refused reverse forwarding"));
    }
    let relay_port = read_allocation(allocation)?;
    master.process.check_running()?;
    web.check_running()?;
    check_stopped(stopped, deadline)?;
    let hosted = RemoteTunnelHostInfo {
        relay_host: options.relay.as_str().into(),
        relay_port,
        web: info,
    };
    output.write_all(b"__ASH_TUNNEL_STATUS__")?;
    serde_json::to_writer(&mut *output, &hosted).map_err(invalid)?;
    output.write_all(b"\n")?;
    output.flush()?;
    while !stopped.load(Ordering::Acquire) {
        master.process.check_running()?;
        web.check_running()?;
        thread::sleep(POLL);
    }
    // Drop order closes the reverse listener before revoking the Web lease.
    drop(master);
    drop(web);
    Ok(())
}

fn read_allocation(mut file: std::fs::File) -> io::Result<u16> {
    use std::io::Seek;
    if file.metadata()?.len() > 16 {
        return Err(invalid("invalid SSH relay allocation"));
    }
    file.rewind()?;
    let mut value = String::new();
    file.read_to_string(&mut value)?;
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid("invalid SSH relay allocation"));
    }
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| invalid("invalid SSH relay allocation"))
}

struct SshMaster {
    process: OwnedChild,
    ssh: PathBuf,
    control: PathBuf,
    relay: String,
}

impl Drop for SshMaster {
    fn drop(&mut self) {
        // Ask OpenSSH to close the transport and its ProxyJump/ProxyCommand children
        // before falling back to process termination. Never leave a persistent master.
        let stopped = AtomicBool::new(false);
        if let Ok(mut exit) = OwnedChild::spawn(
            Command::new(&self.ssh)
                .arg("-S")
                .arg(&self.control)
                .args(["-O", "exit"])
                .arg(&self.relay)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        ) {
            let _ = exit.wait(&stopped, Instant::now() + Duration::from_millis(500));
        }
        let _ = self
            .process
            .wait(&stopped, Instant::now() + Duration::from_millis(500));
    }
}

struct OwnedChild {
    child: Child,
    reaped: bool,
}

impl OwnedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        Ok(Self {
            child: command.spawn()?,
            reaped: false,
        })
    }

    fn check_running(&mut self) -> io::Result<()> {
        if self.child.try_wait()?.is_some() {
            self.reaped = true;
            return Err(invalid("hosting child exited"));
        }
        Ok(())
    }

    fn wait(
        &mut self,
        stopped: &AtomicBool,
        deadline: Instant,
    ) -> io::Result<std::process::ExitStatus> {
        loop {
            check_stopped(stopped, deadline)?;
            if let Some(status) = self.child.try_wait()? {
                self.reaped = true;
                return Ok(status);
            }
            thread::sleep(POLL);
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        if self.child.stdin.take().is_some() {
            // The Web launcher must close its managed lease before its process exits.
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if self.child.try_wait().is_ok_and(|status| status.is_some()) {
                    return;
                }
                thread::sleep(POLL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn check_stopped(stopped: &AtomicBool, deadline: Instant) -> io::Result<()> {
    if stopped.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "hosting cancelled",
        ));
    }
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "hosting startup timed out",
        ));
    }
    Ok(())
}

fn invalid(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
#[path = "hosting_tests.rs"]
mod tests;
