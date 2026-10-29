//! Terminal debug policy. Workbench owns the terminal; Debug owns the parent and
//! attached child sessions. This adapter only binds their existing lifetimes.
use crate::auto_attach::Environment;
use crate::invalid;
use ash_debug_adapter::encode_message;
use ash_debug_adapter::read_message;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::debug::AdapterRequest;
use external_ext_sdk::debug::Connection;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::net::Shutdown;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

pub(super) struct Terminals {
    client: BackgroundClient,
    environment: Environment,
    workers: Mutex<Vec<Worker>>,
    error: String,
}
struct Worker {
    stopped: Arc<AtomicBool>,
    socket: Arc<Mutex<Option<TcpStream>>>,
    thread: Option<JoinHandle<()>>,
}
impl Terminals {
    pub fn new(client: BackgroundClient, environment: Environment, error: String) -> Self {
        Self {
            client,
            environment,
            workers: Mutex::default(),
            error,
        }
    }
    pub fn connection(
        &self,
        request: AdapterRequest,
        token: CancellationToken,
    ) -> Result<Connection, ExtensionError> {
        token.check_cancelled()?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| invalid(&self.error))?;
        listener
            .set_nonblocking(true)
            .map_err(|_| invalid(&self.error))?;
        let port = listener
            .local_addr()
            .map_err(|_| invalid(&self.error))?
            .port();
        let mut workers = self.workers.lock().map_err(|_| invalid(&self.error))?;
        let mut index = 0;
        while index < workers.len() {
            if workers[index]
                .thread
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
            {
                workers.swap_remove(index).stop();
            } else {
                index += 1;
            }
        }
        if workers.len() >= 64 {
            return Err(invalid(&self.error));
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let socket = Arc::new(Mutex::new(None));
        let client = self.client.clone();
        let environment = self.environment.clone();
        let stop = Arc::clone(&stopped);
        let connection = Arc::clone(&socket);
        let error = self.error.clone();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if let Ok(clone) = stream.try_clone() {
                            if let Ok(mut slot) = connection.lock() {
                                *slot = Some(clone);
                            }
                        }
                        let _ = serve(stream, request, client, environment, &stop, &error);
                        if let Ok(mut socket) = connection.lock() {
                            socket.take();
                        }
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        });
        workers.push(Worker {
            stopped,
            socket,
            thread: Some(thread),
        });
        Ok(Connection::Server {
            host: "127.0.0.1".into(),
            port,
        })
    }
    pub fn stop(&self) {
        // Deactivation runs on the SDK reader. Cancel service calls before joining
        // workers, since their replies cannot be read while this callback runs.
        self.client.close();
        if let Ok(mut workers) = self.workers.lock() {
            for mut worker in workers.drain(..) {
                worker.stop();
            }
        }
    }
}
impl Worker {
    fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut socket) = self.socket.lock() {
            if let Some(socket) = socket.take() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.stop();
    }
}

struct TerminalLease {
    id: String,
    secret: Option<String>,
    client: BackgroundClient,
    environment: Environment,
}
impl Drop for TerminalLease {
    fn drop(&mut self) {
        if let Some(secret) = &self.secret {
            self.environment.retire_terminal(secret);
        }
        let _ = self.client.dispose_terminal(self.id.clone());
    }
}

fn launch(
    request: &AdapterRequest,
    client: &BackgroundClient,
    environment: &Environment,
    no_debug: bool,
    error: &str,
) -> Result<TerminalLease, ExtensionError> {
    let properties = &request.configuration.properties;
    let cwd = properties
        .get("cwd")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| {
            request
                .session
                .workspace_folder
                .as_ref()
                .and_then(|folder| crate::auto_attach::folder_path(&folder.uri))
                .map(|path| path.to_string_lossy().into_owned())
        });
    let folder = request
        .session
        .workspace_folder
        .as_ref()
        .map(|folder| folder.uri.clone())
        .or_else(|| {
            cwd.as_ref()
                .and_then(|cwd| url::Url::from_directory_path(cwd).ok())
                .map(String::from)
        })
        .ok_or_else(|| invalid(error))?;
    let mut env: BTreeMap<String, Option<String>> = properties
        .get("env")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid(error))?
        .unwrap_or_default();
    let mut secret = None;
    let mut append_env = BTreeMap::new();
    if no_debug {
        env.insert("ASH_JS_DEBUG_TOKEN".into(), None);
        env.insert("VSCODE_INSPECTOR_OPTIONS".into(), None);
    }
    if !no_debug {
        let (token, variables) =
            environment.terminal_scope(request.session.id.clone(), folder, properties.clone())?;
        for (key, value) in variables {
            if key == "NODE_OPTIONS" {
                if let Some(value) = value {
                    append_env.insert(key, value);
                }
                continue;
            }
            env.insert(key, value);
        }
        secret = Some(token);
    }
    let command = match properties.get("command") {
        None | Some(Value::Null) => None,
        Some(Value::String(command)) => Some(command.clone()),
        Some(_) => {
            if let Some(secret) = secret {
                environment.retire_terminal(&secret);
            }
            return Err(invalid(error));
        }
    };
    match client.create_terminal(
        request.configuration.name.clone(),
        cwd,
        env,
        append_env,
        command,
    ) {
        Ok(terminal) => Ok(TerminalLease {
            id: terminal.id,
            secret,
            client: client.clone(),
            environment: environment.clone(),
        }),
        Err(error) => {
            if let Some(secret) = secret {
                environment.retire_terminal(&secret);
            }
            Err(error)
        }
    }
}

fn serve(
    mut stream: TcpStream,
    request: AdapterRequest,
    client: BackgroundClient,
    environment: Environment,
    stopped: &AtomicBool,
    error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let input = stream.try_clone()?;
    let (send, receive) = mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(runtime) = runtime {
            runtime.block_on(async move {
                let _ = input.set_nonblocking(true);
                if let Ok(input) = tokio::net::TcpStream::from_std(input) {
                    let mut input = tokio::io::BufReader::new(input);
                    while let Ok(Some(message)) = read_message(&mut input).await {
                        if send.send(message).is_err() {
                            break;
                        }
                    }
                }
            });
        }
    });
    let mut sequence = 0;
    let mut write = |mut message: Value| -> Result<(), Box<dyn std::error::Error>> {
        sequence += 1;
        message["seq"] = json!(sequence);
        stream.write_all(&encode_message(&message)?)?;
        Ok(())
    };
    let mut terminal: Option<TerminalLease> = None;
    let mut cursor = 0;
    let mut pending_launch = None;
    let mut no_debug = false;
    let mut ended = false;
    let outcome = (|| -> Result<(), Box<dyn std::error::Error>> {
        while !stopped.load(Ordering::Acquire) {
            match receive.recv_timeout(Duration::from_millis(100)) {
                Ok(message) => {
                    if message["type"] != "request" {
                        continue;
                    }
                    let command = message["command"].as_str().unwrap_or_default();
                    let response = |body| json!({"type":"response","request_seq":message["seq"],"command":command,"success":true,"body":body});
                    match command {
                        "initialize" => write(response(
                            json!({"supportsConfigurationDoneRequest":true,"supportsTerminateRequest":true}),
                        ))?,
                        "launch" => {
                            pending_launch = Some(message["seq"].clone());
                            no_debug = message["arguments"]["noDebug"] == true;
                            write(json!({"type":"event","event":"initialized"}))?;
                        }
                        "configurationDone" => {
                            match launch(&request, &client, &environment, no_debug, error) {
                                Ok(created) => {
                                    terminal = Some(created);
                                    write(response(json!({})))?;
                                    write(
                                        json!({"type":"response","request_seq":pending_launch.take(),"command":"launch","success":true,"body":{}}),
                                    )?;
                                }
                                Err(error) => {
                                    write(response(json!({})))?;
                                    write(
                                        json!({"type":"response","request_seq":pending_launch.take(),"command":"launch","success":false,"message":error.to_string()}),
                                    )?;
                                    break;
                                }
                            }
                        }
                        "disconnect" | "terminate" => {
                            terminal.take();
                            write(response(json!({})))?;
                            if !ended {
                                write(json!({"type":"event","event":"terminated"}))?;
                                ended = true;
                            }
                            if command == "disconnect" {
                                break;
                            }
                        }
                        "threads" => write(response(json!({"threads":[]})))?,
                        "setBreakpoints" => write(response(json!({"breakpoints":[]})))?,
                        "setExceptionBreakpoints" | "setFunctionBreakpoints" => {
                            write(response(json!({})))?
                        }
                        _ => write(
                            json!({"type":"response","request_seq":message["seq"],"command":command,"success":false,"message":error}),
                        )?,
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if !ended && let Some(terminal) = &terminal {
                let output = client.read_terminal(terminal.id.clone(), cursor)?;
                cursor = output.next_sequence;
                if !output.output.is_empty() {
                    write(
                        json!({"type":"event","event":"output","body":{"category":"stdout","output":output.output}}),
                    )?;
                }
                if output.closed {
                    ended = true;
                    if let Some(secret) = &terminal.secret {
                        environment.retire_terminal(secret);
                    }
                    write(json!({"type":"event","event":"terminated"}))?;
                }
            }
        }
        Ok(())
    })();
    terminal.take();
    let _ = stream.shutdown(Shutdown::Both);
    drop(receive);
    let _ = reader.join();
    outcome
}
