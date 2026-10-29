//! A bounded activation-scoped broker. It admits only inherited terminal credentials
//! and launches through the bound SDK client; it never scans host processes.
use crate::invalid;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::client::DebugSessionOptions;
use globset::Glob;
use globset::GlobSet;
use globset::GlobSetBuilder;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

#[derive(Clone, Copy, Deserialize, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Mode {
    #[default]
    Disabled,
    Always,
    Smart,
    OnlyWithFlag,
}
impl Mode {
    pub fn setting(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Always => "always",
            Self::Smart => "smart",
            Self::OnlyWithFlag => "onlyWithFlag",
        }
    }
}
#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub(super) enum Suspension {
    #[default]
    Active,
    Paused,
}
#[derive(Default)]
struct Policy {
    mode: Mode,
    suspension: Suspension,
    patterns: Vec<String>,
    excluded: Option<GlobSet>,
    folders: Vec<String>,
}
#[derive(Clone)]
pub(super) struct Environment {
    address: SocketAddr,
    secret: String,
    resources: PathBuf,
    policy: Arc<Mutex<Policy>>,
    error: String,
    terminals: Arc<Mutex<BTreeMap<String, TerminalScope>>>,
}

#[derive(Clone)]
struct TerminalScope {
    parent: String,
    folder: String,
    properties: BTreeMap<String, Value>,
}

struct Admission {
    folder: String,
    parent: Option<String>,
    properties: BTreeMap<String, Value>,
}
impl Environment {
    /// A terminal lease is independent of global Auto Attach mode and suspension.
    pub fn terminal_scope(
        &self,
        parent: String,
        folder: String,
        properties: BTreeMap<String, Value>,
    ) -> Result<(String, BTreeMap<String, Option<String>>), ExtensionError> {
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let secret: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut terminals = self.terminals.lock().map_err(|_| invalid(&self.error))?;
        if terminals.len() >= 64 {
            return Err(invalid(&self.error));
        }
        let children = properties.get("autoAttachChildProcesses") != Some(&json!(false));
        terminals.insert(
            secret.clone(),
            TerminalScope {
                parent,
                folder,
                properties,
            },
        );
        let bootstrap = self.resources.join("src/auto-attach.cjs");
        let option = format!(
            " --require={} ",
            serde_json::to_string(&bootstrap.to_string_lossy())
                .map_err(|_| invalid(&self.error))?
        );
        Ok((
            secret.clone(),
            BTreeMap::from([
                ("NODE_OPTIONS".into(), Some(option)),
                ("VSCODE_INSPECTOR_OPTIONS".into(), None),
                (
                    "ASH_JS_DEBUG_ADDRESS".into(),
                    Some(self.address.to_string()),
                ),
                ("ASH_JS_DEBUG_TOKEN".into(), Some(secret)),
                (
                    "ASH_JS_DEBUG_HELPER".into(),
                    Some(
                        std::env::current_exe()
                            .map_err(|_| invalid(&self.error))?
                            .to_string_lossy()
                            .into_owned(),
                    ),
                ),
                ("ASH_JS_DEBUG_MODE".into(), Some("enabled".into())),
                (
                    "ASH_JS_DEBUG_CHILDREN".into(),
                    Some(if children { "1" } else { "0" }.into()),
                ),
            ]),
        ))
    }

    pub fn retire_terminal(&self, secret: &str) {
        if let Ok(mut terminals) = self.terminals.lock() {
            terminals.remove(secret);
        }
    }
    pub fn collection(&self, settings: &Value) -> Result<Value, ExtensionError> {
        let mut policy = self.policy.lock().map_err(|_| invalid(&self.error))?;
        // A malformed edit must retire the previous attach policy, including
        // credentials still inherited by terminals created before the edit.
        let previous = policy.mode;
        policy.mode = Mode::Disabled;
        let mode: Mode = serde_json::from_value(
            settings
                .get("autoAttachFilter")
                .cloned()
                .unwrap_or(json!("disabled")),
        )
        .map_err(|_| invalid(&self.error))?;
        let patterns: Vec<String> = serde_json::from_value(
            settings
                .get("autoAttachSmartPattern")
                .cloned()
                .unwrap_or(json!(["**/node_modules/**"])),
        )
        .map_err(|_| invalid(&self.error))?;
        if patterns.len() > 128 || patterns.iter().any(|pattern| pattern.len() > 2048) {
            return Err(invalid(&self.error));
        }
        let mut excluded = GlobSetBuilder::new();
        for pattern in &patterns {
            excluded.add(Glob::new(pattern).map_err(|_| invalid(&self.error))?);
        }
        let excluded = excluded.build().map_err(|_| invalid(&self.error))?;
        // Terminal refreshes and unrelated configuration events must preserve a pause.
        // An actual auto-attach setting change starts a new policy in the active state.
        if previous != mode || policy.patterns != patterns {
            policy.suspension = Suspension::Active;
        }
        policy.mode = mode;
        policy.patterns = patterns;
        policy.excluded = Some(excluded);
        let mut map = Vec::new();
        if !matches!(mode, Mode::Disabled) {
            let helper = std::env::current_exe().map_err(|_| invalid(&self.error))?;
            let bootstrap = self.resources.join("src/auto-attach.cjs");
            // NODE_OPTIONS has its own double-quote grammar; JSON quoting preserves spaces.
            let option = format!(
                " --require={} ",
                serde_json::to_string(&bootstrap.to_string_lossy())
                    .map_err(|_| invalid(&self.error))?
            );
            for (key, value, mutation) in [
                ("NODE_OPTIONS", option, 2),
                ("ASH_JS_DEBUG_ADDRESS", self.address.to_string(), 1),
                ("ASH_JS_DEBUG_TOKEN", self.secret.clone(), 1),
                (
                    "ASH_JS_DEBUG_HELPER",
                    helper.to_string_lossy().into_owned(),
                    1,
                ),
                (
                    "ASH_JS_DEBUG_MODE",
                    if matches!(mode, Mode::OnlyWithFlag) {
                        "onlyWithFlag"
                    } else {
                        "enabled"
                    }
                    .into(),
                    1,
                ),
            ] {
                map.push(json!([key,{"variable":key,"value":value,"type":mutation,"options":{"applyAtProcessCreation":true,"applyAtShellIntegration":false}}]));
            }
        }
        Ok(json!({"persistent":false,"map":map,"descriptionMap":[]}))
    }
    pub fn state(&self) -> Result<(Mode, Suspension), ExtensionError> {
        let policy = self.policy.lock().map_err(|_| invalid(&self.error))?;
        Ok((policy.mode, policy.suspension))
    }
    pub fn suspend(&self, suspension: Suspension) -> Result<(), ExtensionError> {
        self.policy
            .lock()
            .map_err(|_| invalid(&self.error))?
            .suspension = suspension;
        Ok(())
    }
    pub fn workspace(&self, folders: Vec<String>) -> Result<(), ExtensionError> {
        self.policy
            .lock()
            .map_err(|_| invalid(&self.error))?
            .folders = folders;
        Ok(())
    }
    fn admit(&self, request: &Attach) -> Option<Admission> {
        if request.address != self.address.to_string()
            || request.pid == 0
            || request.script.len() > 32768
            || inspector_address(&request.inspector).is_none()
        {
            return None;
        }
        if let Some(scope) = self.terminals.lock().ok()?.get(&request.token).cloned() {
            let cwd = Path::new(&request.cwd).canonicalize().ok()?;
            let root = folder_path(&scope.folder)?.canonicalize().ok()?;
            if !cwd.starts_with(root) {
                return None;
            }
            return Some(Admission {
                folder: scope.folder,
                parent: Some(scope.parent),
                properties: scope.properties,
            });
        }
        if request.token != self.secret {
            return None;
        }
        let policy = self.policy.lock().ok()?;
        if policy.suspension == Suspension::Paused {
            return None;
        }
        match policy.mode {
            Mode::Disabled => return None,
            Mode::OnlyWithFlag if !request.flagged => return None,
            Mode::Smart
                if request.script.is_empty()
                    || policy
                        .excluded
                        .as_ref()
                        .is_some_and(|glob| glob.is_match(&request.script)) =>
            {
                return None;
            }
            Mode::Always | Mode::Smart | Mode::OnlyWithFlag => {}
        }
        let cwd = Path::new(&request.cwd).canonicalize().ok()?;
        policy
            .folders
            .iter()
            .find(|folder| {
                let Some(path) = folder_path(folder) else {
                    return false;
                };
                path.canonicalize().is_ok_and(|root| cwd.starts_with(root))
            })
            .cloned()
            .map(|folder| Admission {
                folder,
                parent: None,
                properties: BTreeMap::new(),
            })
    }
}
pub(super) fn folder_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() == "file" {
        url.to_file_path().ok()
    } else {
        url::Url::parse(&format!("file://{}", url.path()))
            .ok()?
            .to_file_path()
            .ok()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Attach {
    token: String,
    address: String,
    inspector: String,
    pid: u32,
    cwd: String,
    script: String,
    flagged: bool,
}

pub(super) struct Broker {
    environment: Environment,
    listener: Option<TcpListener>,
    client: BackgroundClient,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Broker {
    pub fn new(
        client: BackgroundClient,
        resources: PathBuf,
        error: String,
        folders: Vec<String>,
    ) -> Result<Self, ExtensionError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| invalid(&error))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| invalid(&error))?;
        let address = listener.local_addr().map_err(|_| invalid(&error))?;
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let secret = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            environment: Environment {
                address,
                secret,
                resources,
                policy: Arc::new(Mutex::new(Policy {
                    folders,
                    ..Policy::default()
                })),
                error,
                terminals: Arc::default(),
            },
            listener: Some(listener),
            client,
            stopped: Arc::new(AtomicBool::new(false)),
            thread: None,
        })
    }
    pub fn environment(&self) -> Environment {
        self.environment.clone()
    }
    pub fn start(&mut self) -> Result<(), ExtensionError> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| invalid(&self.environment.error))?;
        let stopped = Arc::clone(&self.stopped);
        let environment = self.environment.clone();
        let client = self.client.clone();
        self.thread = Some(std::thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            while !stopped.load(Ordering::Acquire) {
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
                match listener.accept() {
                    Ok((mut stream, _)) if workers.len() < 32 => {
                        let client = client.clone();
                        let environment = environment.clone();
                        let stopped = Arc::clone(&stopped);
                        workers.push(std::thread::spawn(move || {
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                            let mut payload = Vec::new();
                            let request = Read::by_ref(&mut stream).take(65536).read_to_end(&mut payload).ok().and_then(|_| serde_json::from_slice::<Attach>(&payload).ok());
                            let started = request.and_then(|request| {
                                let admission = environment.admit(&request)?;
                                if stopped.load(Ordering::Acquire) { return None; }
                                let (_, port) = inspector_address(&request.inspector)?;
                                let mut configuration = admission.properties;
                                configuration.entry("sourceMaps".into()).or_insert(json!(true));
                                configuration.entry("skipFiles".into()).or_insert(json!(["<node_internals>/**"]));
                                for key in ["command", "cwd", "env", "envFile", "preLaunchTask", "postDebugTask", "serverReadyAction"] { configuration.remove(key); }
                                configuration.extend(serde_json::from_value::<BTreeMap<String, Value>>(json!({
                                    "type":"node", "name":Path::new(&request.script).file_name().unwrap_or_default().to_string_lossy(),
                                    "request":"attach", "address":"127.0.0.1", "port":port,
                                    "continueOnAttach":true, "restart":false,
                                    "autoAttachChildProcesses":admission.parent.is_none()
                                })).ok()?);
                                let options = admission.parent.map(|parent_session_id| DebugSessionOptions { parent_session_id: Some(parent_session_id), lifecycle_managed_by_parent: Some(true), console_mode: Some(1), no_debug: None, suppress_save_before_start: Some(true) });
                                client.start_debugging(Some(admission.folder), json!(configuration), options).ok()
                            }).unwrap_or(false);
                            let _ = stream.write_all(if started { b"1" } else { b"0" });
                        }));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        }));
        Ok(())
    }
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.client.close();
        self.listener.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn inspector_address(uri: &str) -> Option<(url::Url, u16)> {
    if uri.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let port = url.port()?;
    Some((url, port))
}

/// Runs outside the provider so even an unavailable or retired broker cannot strand Node.
pub fn helper() {
    let payload = match std::env::var("ASH_JS_DEBUG_REQUEST") {
        Ok(payload) if payload.len() <= 65536 => payload.into_bytes(),
        Ok(_) => return,
        Err(_) => {
            let mut payload = Vec::new();
            if std::io::stdin()
                .take(65536)
                .read_to_end(&mut payload)
                .is_err()
            {
                return;
            }
            payload
        }
    };
    let Ok(request) = serde_json::from_slice::<Attach>(&payload) else {
        return;
    };
    let Some((url, port)) = inspector_address(&request.inspector) else {
        return;
    };
    let started = (|| {
        let address: SocketAddr = request.address.parse().ok()?;
        if !address.ip().is_loopback() {
            return None;
        }
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(35)))
            .ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .ok()?;
        stream.write_all(&payload).ok()?;
        stream.shutdown(std::net::Shutdown::Write).ok()?;
        let mut reply = [0u8; 1];
        stream.read_exact(&mut reply).ok()?;
        Some(reply[0] == b'1')
    })()
    .unwrap_or(false);
    if !started {
        // Resume through Inspector itself. A timer in the blocked JS thread cannot do this.
        if let Ok(stream) = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_secs(2),
        ) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            if let Ok((mut socket, _)) = tungstenite::client(url.as_str(), stream) {
                let _ = socket.send(tungstenite::Message::Text(
                    json!({"id":1,"method":"Runtime.runIfWaitingForDebugger"})
                        .to_string()
                        .into(),
                ));
                // Wait for acknowledgement before closing the only Inspector connection.
                let _ = socket.read();
                let _ = socket.close(None);
            }
        }
    }
}

#[cfg(test)]
#[path = "auto_attach_tests.rs"]
mod tests;
