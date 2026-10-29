//! Optional JS adapter policy. The existing Rust Debug domain remains the DAP owner.
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::debug::AdapterTracker;
use external_ext_sdk::debug::Configuration;
use external_ext_sdk::debug::ConfigurationProvider;
use external_ext_sdk::debug::ConfigurationProviderTriggerKind;
use external_ext_sdk::debug::ConfigurationRequest;
use external_ext_sdk::debug::Connection;
use external_ext_sdk::debug::Request;
use external_ext_sdk::debug::TrackerEvent;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

mod auto_attach;
mod auto_attach_controls;
mod terminal;
pub use auto_attach::helper as auto_attach_helper;

#[derive(Default)]
pub struct Extension {
    runtime: Option<Arc<Runtime>>,
    broker: Option<auto_attach::Broker>,
    terminals: Option<Arc<terminal::Terminals>>,
}
impl external_ext_sdk::Extension for Extension {
    fn id(&self) -> &str {
        "ash.debug-javascript"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let chinese = context
            .initialization()
            .and_then(|facts| facts.language.as_deref())
            .is_some_and(|language| language.starts_with("zh"));
        let messages: Value = serde_json::from_str(if chinese {
            include_str!("../package.nls.zh-CN.json")
        } else {
            include_str!("../package.nls.json")
        })
        .map_err(|_| invalid("Invalid product messages"))?;
        let runtime = Arc::new(Runtime {
            state: Mutex::new(State::default()),
            stopped: AtomicBool::new(false),
            error: messages["error.runtime"]
                .as_str()
                .unwrap_or_default()
                .into(),
        });
        self.runtime = Some(Arc::clone(&runtime));
        for kind in [
            "node",
            "pwa-node",
            "chrome",
            "pwa-chrome",
            "msedge",
            "pwa-msedge",
        ] {
            let adapter = Arc::clone(&runtime);
            context.debug.register_connection_factory(
                format!("{kind}.adapter"),
                kind,
                move |_, token| adapter.connection(&token),
            )?;
            let trackers = Arc::clone(&runtime);
            context.debug.register_tracker_factory(
                format!("{kind}.lifetime"),
                kind,
                move |session, token| {
                    token.check_cancelled()?;
                    trackers
                        .state
                        .lock()
                        .map_err(|_| invalid(&trackers.error))?
                        .sessions
                        .insert(session.id.clone());
                    Ok(Some(Arc::new(Lifetime {
                        runtime: Arc::clone(&trackers),
                        id: session.id,
                    })))
                },
            )?;
        }
        for kind in [
            "node",
            "pwa-node",
            "chrome",
            "pwa-chrome",
            "msedge",
            "pwa-msedge",
        ] {
            context.debug.register_configuration_provider(
                format!("{kind}.configuration"),
                kind,
                ConfigurationProviderTriggerKind::Initial,
                Configurations {
                    title: messages["configuration.launch"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    kind: kind.into(),
                },
            )?;
        }
        let background = BackgroundClient::new(context.services.clone());
        let mut broker = auto_attach::Broker::new(
            background,
            runtime.directory()?,
            messages["error.configuration"]
                .as_str()
                .unwrap_or_default()
                .into(),
            context
                .initialization()
                .map(|facts| {
                    facts
                        .workspace_folders
                        .iter()
                        .map(|folder| folder.uri.clone())
                        .collect()
                })
                .unwrap_or_default(),
        )?;
        auto_attach_controls::register(context, broker.environment(), &messages)?;
        let terminals = Arc::new(terminal::Terminals::new(
            BackgroundClient::new(context.services.clone()),
            broker.environment(),
            messages["error.configuration"]
                .as_str()
                .unwrap_or_default()
                .into(),
        ));
        let adapters = Arc::clone(&terminals);
        context.debug.register_connection_factory(
            "node-terminal.adapter",
            "node-terminal",
            move |request, token| adapters.connection(request, token),
        )?;
        self.terminals = Some(terminals);
        broker.start()?;
        self.broker = Some(broker);
        Ok(())
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        if let Some(terminals) = self.terminals.take() {
            terminals.stop();
        }
        if let Some(mut broker) = self.broker.take() {
            broker.stop();
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.stopped.store(true, Ordering::Release);
            runtime
                .state
                .lock()
                .map_err(|_| invalid(&runtime.error))?
                .server
                .take();
        }
        Ok(())
    }
}

struct Configurations {
    title: String,
    kind: String,
}
impl ConfigurationProvider for Configurations {
    fn resolve_configuration(
        &self,
        mut request: external_ext_sdk::debug::ResolveConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Option<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        request.configuration.debugger_type = match request.configuration.debugger_type.as_str() {
            "node" => "pwa-node".into(),
            "chrome" => "pwa-chrome".into(),
            "msedge" => "pwa-msedge".into(),
            value => value.into(),
        };
        request
            .configuration
            .properties
            .entry("sourceMaps".into())
            .or_insert(json!(true));
        request
            .configuration
            .properties
            .entry("pauseForSourceMap".into())
            .or_insert(json!(true));
        request
            .configuration
            .properties
            .entry("sourceMapRenames".into())
            .or_insert(json!(true));
        if request.configuration.debugger_type == "pwa-node"
            && request.configuration.request == Request::Launch
        {
            if let Some(program) = request
                .configuration
                .properties
                .get("program")
                .and_then(Value::as_str)
                .filter(|program| !program.is_empty())
                .map(str::to_owned)
            {
                // Standalone DAP startup must pause the entry script while its source map
                // binds already configured TS breakpoints; otherwise short scripts outrun it.
                request
                    .configuration
                    .properties
                    .entry("runtimeSourcemapPausePatterns".into())
                    .or_insert(json!([program]));
            }
            if !request
                .configuration
                .properties
                .contains_key("runtimeVersion")
            {
                if let Some(node) = std::env::var_os("ASH_DEBUG_NODE_PATH") {
                    request
                        .configuration
                        .properties
                        .entry("runtimeExecutable".into())
                        .or_insert(json!(node.to_string_lossy()));
                }
            }
            request
                .configuration
                .properties
                .entry("console".into())
                .or_insert(json!("internalConsole"));
        }
        Ok(Some(request.configuration))
    }

    fn provide_configurations(
        &self,
        _: ConfigurationRequest,
        token: CancellationToken,
    ) -> Result<Vec<Configuration>, ExtensionError> {
        token.check_cancelled()?;
        if self.kind != "node" {
            return Ok(Vec::new());
        }
        Ok(vec![Configuration {
            name: self.title.clone(),
            debugger_type: "node".into(),
            request: Request::Launch,
            properties: BTreeMap::from([
                ("program".into(), json!("${file}")),
                ("cwd".into(), json!("${workspaceFolder}")),
                ("console".into(), json!("internalConsole")),
                ("sourceMaps".into(), json!(true)),
            ]),
        }])
    }
}
#[derive(Default)]
struct State {
    server: Option<Server>,
    sessions: BTreeSet<String>,
}
struct Runtime {
    state: Mutex<State>,
    stopped: AtomicBool,
    error: String,
}
impl Runtime {
    fn directory(&self) -> Result<PathBuf, ExtensionError> {
        let executable = std::env::current_exe().map_err(|_| invalid(&self.error))?;
        executable
            .parent()
            .and_then(|path| path.parent())
            .map(|path| path.join("ash-resources/extensions/debug-javascript"))
            .ok_or_else(|| invalid(&self.error))
    }
    fn connection(&self, token: &CancellationToken) -> Result<Connection, ExtensionError> {
        token.check_cancelled()?;
        let mut state = self.state.lock().map_err(|_| invalid(&self.error))?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(invalid(&self.error));
        }
        if state
            .server
            .as_mut()
            .is_some_and(|server| server.child.try_wait().ok().flatten().is_some())
        {
            state.server.take();
        }
        if state.server.is_none() {
            state.server = Some(Server::start(self.directory()?, token, &self.error)?);
        }
        let connection = Connection::NamedPipe {
            path: state.server.as_ref().expect("server exists").socket.clone(),
        };
        token.check_cancelled()?;
        Ok(connection)
    }
}
struct Lifetime {
    runtime: Arc<Runtime>,
    id: String,
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        // A canceled factory may never publish a tracker handle. Rust ownership
        // still retires its session lease without waiting for a dispose callback.
        if let Ok(mut state) = self.runtime.state.lock() {
            state.sessions.remove(&self.id);
            if state.sessions.is_empty() {
                state.server.take();
            }
        }
    }
}
impl AdapterTracker for Lifetime {
    fn event(&self, event: TrackerEvent, _: CancellationToken) -> Result<(), ExtensionError> {
        if matches!(event, TrackerEvent::Dispose) {
            let mut state = self
                .runtime
                .state
                .lock()
                .map_err(|_| invalid(&self.runtime.error))?;
            state.sessions.remove(&self.id);
            if state.sessions.is_empty() {
                state.server.take();
            }
        }
        Ok(())
    }
}
struct Server {
    child: ash_sandboxing::ProcessHandle,
    stdin: Option<Box<dyn Write + Send>>,
    socket: String,
    _directory: tempfile::TempDir,
    readers: Vec<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(
        resources: PathBuf,
        token: &CancellationToken,
        error: &str,
    ) -> Result<Self, ExtensionError> {
        let directory = tempfile::Builder::new()
            .prefix("ash-js-")
            .tempdir()
            .map_err(|_| invalid(error))?;
        let socket = if cfg!(windows) {
            format!(
                r"\\.\pipe\{}",
                directory
                    .path()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )
        } else {
            directory.path().join("dap").to_string_lossy().into_owned()
        };
        let node = std::env::var_os("ASH_DEBUG_NODE_PATH")
            .map(PathBuf::from)
            .ok_or_else(|| invalid(error))?;
        let command = ash_sandboxing::SandboxCommand::new(
            node,
            [
                resources.join("src/adapter-runtime.cjs").into_os_string(),
                resources
                    .join("runtime/src/dapDebugServer.js")
                    .into_os_string(),
                socket.clone().into(),
            ],
            &resources,
        );
        let mut environment: BTreeMap<String, String> = std::env::vars()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "NODE_OPTIONS" | "VSCODE_INSPECTOR_OPTIONS" | "ASH_JS_DEBUG_REQUEST"
                )
            })
            .collect();
        if std::env::var_os("ASH_DEBUG_ELECTRON").is_some() {
            environment.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
        }
        let mut child = ash_sandboxing::PreparedCommand::unrestricted(&command)
            .spawn(&environment.into_iter().collect::<Vec<_>>())
            .map_err(|_| invalid(error))?;
        let stdin = child.take_stdin().ok_or_else(|| invalid(error))?;
        let stdout = child.take_stdout().ok_or_else(|| invalid(error))?;
        let mut stderr = child.take_stderr().ok_or_else(|| invalid(error))?;
        let errors = std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::stderr());
        });
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            let mut line = Vec::new();
            let result = output
                .by_ref()
                .take(2048)
                .read_until(b'\n', &mut line)
                .map(|_| line.starts_with(b"Debug server listening at "));
            let _ = send.send(result.unwrap_or(false));
            let _ = std::io::copy(&mut output, &mut std::io::sink());
        });
        let server = Self {
            child,
            socket,
            _directory: directory,
            stdin: Some(stdin),
            readers: vec![reader, errors],
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            token.check_cancelled()?;
            match receive.recv_timeout(Duration::from_millis(25)) {
                Ok(true) => return Ok(server),
                Ok(false) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(invalid(error));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(invalid(error)),
            }
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.close();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}
fn invalid(message: &str) -> ExtensionError {
    ExtensionError::new(HostErrorCode::InvalidRequest, message)
}
