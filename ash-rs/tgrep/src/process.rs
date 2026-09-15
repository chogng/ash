use super::Error;
use super::Executable;
use super::TIMEOUT;
use super::VERSION;
use super::check;
use super::failed;
use ash_async_utils::CancellationToken;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Once;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const POLL: Duration = Duration::from_millis(25);
const MAX_RESPONSE: usize = 64 * 1024 * 1024;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

type SharedChild = Arc<Mutex<OwnedChild>>;
static CHILDREN: OnceLock<Mutex<Vec<Weak<Mutex<OwnedChild>>>>> = OnceLock::new();

fn register(child: &SharedChild) {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| process_hardening::register_exit_cleanup(stop_owned_servers_at_exit));
    let mut children = CHILDREN
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    children.retain(|child| child.strong_count() != 0);
    children.push(Arc::downgrade(child));
}

// Hosts may use process::exit or retain background runtime Arcs until process termination.
// A normal process exit must still release every owned server and its index lock.
fn stop_owned_servers_at_exit() {
    if let Some(children) = CHILDREN.get() {
        for child in children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(Weak::upgrade)
        {
            let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.0.kill();
            let _ = child.0.wait();
        }
    }
}

pub(super) struct Server {
    child: SharedChild,
    address: SocketAddr,
    index: PathBuf,
}
#[derive(Deserialize)]
struct Discovery {
    pid: u32,
    port: u16,
}
impl Server {
    pub(super) fn start(
        executable: &Executable,
        root: &Path,
        index: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        let deadline = Instant::now() + TIMEOUT;
        let mut version = Command::new(&executable.0);
        version.arg("--version");
        let lines = capture(version, cancellation, deadline, 1)?;
        if lines.first().map(String::as_str) != Some(&format!("tgrep {VERSION}")) {
            return Err(failed(format!("expected packaged tgrep {VERSION}")));
        }
        std::fs::create_dir_all(index)?;
        let child = Arc::new(Mutex::new(OwnedChild(
            Command::new(&executable.0)
                .arg("serve")
                .arg(root)
                .arg("--index-path")
                .arg(index)
                .arg("--no-require-git")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        )));
        register(&child);
        let address = loop {
            check(cancellation, deadline)?;
            if let Some(status) = child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .0
                .try_wait()?
            {
                return Err(failed(format!(
                    "tgrep server exited during startup: {status}"
                )));
            }
            if let Ok(bytes) = std::fs::read(index.join("serve.json")) {
                if bytes.len() <= 4096 {
                    if let Ok(info) = serde_json::from_slice::<Discovery>(&bytes) {
                        if info.pid == child.lock().unwrap_or_else(|e| e.into_inner()).0.id()
                            && info.port != 0
                        {
                            break SocketAddr::from((Ipv4Addr::LOCALHOST, info.port));
                        }
                    }
                }
            }
            thread::sleep(POLL);
        };
        let server = Self {
            child,
            address,
            index: index.into(),
        };
        server.rpc("status", Value::Null, cancellation, deadline)?;
        Ok(server)
    }
    pub(super) fn index(&self) -> &Path {
        &self.index
    }
    pub(super) fn rpc(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Value, Error> {
        check(cancellation, deadline)?;
        if let Some(status) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .try_wait()?
        {
            return Err(failed(format!("tgrep server exited: {status}")));
        }
        let mut socket = TcpStream::connect_timeout(&self.address, Duration::from_secs(1))?;
        socket.set_read_timeout(Some(POLL))?;
        socket.set_write_timeout(Some(Duration::from_secs(1)))?;
        let mut request =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))?;
        request.push(b'\n');
        socket.write_all(&request)?;
        let mut response = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            check(cancellation, deadline)?;
            match socket.read(&mut buffer) {
                Ok(0) => return Err(failed("tgrep closed the connection without a response")),
                Ok(count) => {
                    if response.len() + count > MAX_RESPONSE {
                        return Err(failed("tgrep response exceeds 64 MiB"));
                    }
                    response.extend_from_slice(&buffer[..count]);
                    if response.last() == Some(&b'\n') {
                        break;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
        let mut response: Value = serde_json::from_slice(&response)?;
        if response["jsonrpc"] != "2.0" || response["id"] != 1 {
            return Err(failed("invalid tgrep response identity"));
        }
        if let Some(error) = response.get("error") {
            return Err(failed(format!(
                "tgrep: {}",
                error["message"].as_str().unwrap_or("request failed")
            )));
        }
        response
            .as_object_mut()
            .and_then(|v| v.remove("result"))
            .ok_or_else(|| failed("missing tgrep result"))
    }
}

/// Drain both pipes while polling cancellation. A bounded channel prevents output buffering
/// from growing with repository size; reaching the global row limit reaps the CLI child.
pub(super) fn scan(
    command: Command,
    limit: usize,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<Vec<Value>, Error> {
    let lines = capture(command, cancellation, deadline, limit)?;
    lines
        .into_iter()
        .map(|line| serde_json::from_str(&line).map_err(Into::into))
        .collect()
}
fn capture(
    mut command: Command,
    cancellation: &CancellationToken,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<String>, Error> {
    check(cancellation, deadline)?;
    let mut child = OwnedChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let stdout = child.0.stdout.take().expect("piped stdout");
    let stderr = child.0.stderr.take().expect("piped stderr");
    thread::scope(|scope| {
        let (sender, receiver) = mpsc::sync_channel(8);
        let output_reader = scope.spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let read = reader
                    .by_ref()
                    .take(MAX_RESPONSE as u64 + 1)
                    .read_until(b'\n', &mut bytes);
                let value = match read {
                    Ok(0) => break,
                    Ok(_) if bytes.len() <= MAX_RESPONSE => {
                        String::from_utf8(bytes).map_err(|e| failed(e.to_string()))
                    }
                    Ok(_) => Err(failed("tgrep output line exceeds 64 MiB")),
                    Err(e) => Err(e.into()),
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        let errors = scope.spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut retained = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let keep = n.min(65536usize.saturating_sub(retained.len()));
                retained.extend_from_slice(&buffer[..keep]);
            }
            String::from_utf8_lossy(&retained).into_owned()
        });
        let result = (|| {
            let mut output = Vec::new();
            let mut output_bytes = 0usize;
            loop {
                check(cancellation, deadline)?;
                match receiver.recv_timeout(POLL) {
                    Ok(line) => {
                        let line = line?;
                        output_bytes = output_bytes.saturating_add(line.len());
                        if output_bytes > MAX_RESPONSE {
                            return Err(failed("tgrep output exceeds 64 MiB"));
                        }
                        let line = line.trim_end_matches(['\r', '\n']).to_owned();
                        if limit == 1
                            || serde_json::from_str::<Value>(&line)
                                .is_ok_and(|v| v["type"] == "match")
                        {
                            output.push(line);
                            if output.len() == limit {
                                return Ok((output, true));
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            loop {
                check(cancellation, deadline)?;
                if let Some(status) = child.0.try_wait()? {
                    if !matches!(status.code(), Some(0 | 1)) {
                        return Err(failed(format!("tgrep exited with {status}")));
                    }
                    return Ok((output, false));
                }
                thread::sleep(POLL);
            }
        })();
        let _ = child.0.kill();
        let _ = child.0.wait();
        drop(receiver);
        let _ = output_reader.join();
        let stderr = errors.join().unwrap_or_default();
        result.map(|(lines, _)| lines).map_err(|error| match error {
            Error::Failed(message) if !stderr.trim().is_empty() => {
                failed(format!("{message}: {}", stderr.trim()))
            }
            other => other,
        })
    })
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
