//! The executable's small Git helpers use an activation-bound loopback connection. No token
//! or password is written to argv, configuration, logs or the renderer's backend RPC.
use crate::GitRuntime;
use crate::api::invalid;
use crate::model::Configuration;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::services::CoreServiceRequest;
use external_ext_sdk::services::CoreServiceResponse;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io;
use std::io::BufRead;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

const MAX_REQUEST: u64 = 384 * 1024;
#[derive(Clone)]
pub(crate) struct Scope {
    pub configuration: Configuration,
    pub token: CancellationToken,
    pub hosts: Vec<String>,
    pub credential_account_id: Option<String>,
}
#[derive(Clone)]
pub(crate) struct Connection {
    pub address: SocketAddr,
    pub token: String,
    pub scopes: Arc<Mutex<BTreeMap<String, Scope>>>,
}
pub(crate) struct ScopeLease {
    pub connection: Connection,
    pub id: String,
}
impl Drop for ScopeLease {
    fn drop(&mut self) {
        if let Ok(mut scopes) = self.connection.scopes.lock() {
            scopes.remove(&self.id);
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    token: String,
    scope: String,
    cwd: PathBuf,
    operation: Operation,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
enum Operation {
    AskPass { prompt: String },
    Editor { path: PathBuf, contents: String },
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Response {
    result: Option<String>,
}

pub(crate) struct Broker {
    pub connection: Connection,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Broker {
    pub fn start(runtime: Weak<GitRuntime>) -> io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let connection = Connection {
            address: listener.local_addr()?,
            token: crate::commands::random_id().map_err(io::Error::other)?
                + &crate::commands::random_id().map_err(io::Error::other)?,
            scopes: Arc::new(Mutex::new(BTreeMap::new())),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let binding = connection.clone();
        let worker = std::thread::Builder::new()
            .name("git-interaction-broker".into())
            .spawn(move || {
                let mut requests: Vec<JoinHandle<()>> = Vec::new();
                while !stopping.load(Ordering::Acquire) {
                    requests.retain(|request| if request.is_finished() { false } else { true });
                    match listener.accept() {
                        Ok((stream, address))
                            if address.ip().is_loopback() && requests.len() < 8 =>
                        {
                            let runtime = runtime.clone();
                            let binding = binding.clone();
                            requests.push(std::thread::spawn(move || {
                                let _ = serve(stream, &binding, runtime);
                            }));
                        }
                        Ok(_) => {}
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(50))
                        }
                        Err(_) => break,
                    }
                }
                for request in requests {
                    let _ = request.join();
                }
            })?;
        Ok(Self {
            connection,
            stop,
            worker: Some(worker),
        })
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve(mut stream: TcpStream, binding: &Connection, runtime: Weak<GitRuntime>) -> io::Result<()> {
    // Accepted sockets inherit nonblocking mode on some hosts. Git writes a frame in
    // several chunks, so reading before its newline must wait rather than retire the helper.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut line = String::new();
    io::BufReader::new((&stream).take(MAX_REQUEST + 1)).read_line(&mut line)?;
    if line.len() as u64 > MAX_REQUEST || !line.ends_with('\n') {
        return Err(io::Error::other("invalid Git helper frame"));
    }
    let request: Request = serde_json::from_str(&line).map_err(io::Error::other)?;
    if request.token.len() != binding.token.len()
        || request
            .token
            .bytes()
            .zip(binding.token.bytes())
            .fold(0u8, |sum, (a, b)| sum | (a ^ b))
            != 0
    {
        return Err(io::Error::other("Git helper is not authorized"));
    }
    let runtime = runtime
        .upgrade()
        .ok_or_else(|| io::Error::other("Git extension is retired"))?;
    stream.set_read_timeout(Some(Duration::from_millis(1)))?;
    let result = runtime.interact(binding, request, &stream).ok().flatten();
    serde_json::to_writer(&mut stream, &Response { result }).map_err(io::Error::other)?;
    stream.write_all(b"\n")?;
    Ok(())
}

impl GitRuntime {
    fn interact(
        &self,
        binding: &Connection,
        request: Request,
        stream: &TcpStream,
    ) -> Result<Option<String>, ExtensionError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(invalid("Git extension is retired"));
        }
        let scope = if request.scope.is_empty() {
            None
        } else {
            Some(
                binding
                    .scopes
                    .lock()
                    .map_err(|_| invalid("Git scope failed"))?
                    .get(&request.scope)
                    .cloned()
                    .ok_or_else(|| invalid("Git operation was retired"))?,
            )
        };
        let (configuration, token, hosts, credential_account_id) = if let Some(scope) = scope {
            (
                scope.configuration,
                Some(scope.token),
                scope.hosts,
                scope.credential_account_id,
            )
        } else {
            let cwd = std::fs::canonicalize(&request.cwd)
                .map_err(|_| invalid("Git terminal directory is unavailable"))?;
            let repository = self
                .lock()
                .repositories
                .values()
                .filter(|repository| {
                    repository
                        .root_uri
                        .to_host_path()
                        .ok()
                        .and_then(|root| std::fs::canonicalize(root).ok())
                        .is_some_and(|root| cwd.starts_with(root))
                })
                .max_by_key(|repository| repository.root_uri.lexical_depth().unwrap_or(0))
                .cloned()
                .ok_or_else(|| invalid("Git terminal is outside the active workspace"))?;
            let config = self
                .api
                .configuration(Some(repository.root_uri.to_string()), None)?;
            let refs = self
                .api
                .history_refs(&repository, None)
                .map(|refs| json!(refs))
                .unwrap_or(Value::Null);
            let hosts = refs["remotes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|remote| remote["identity"]["host"].as_str().map(str::to_owned))
                .collect();
            (config, None, hosts, None)
        };
        if let Some(token) = &token {
            token.check_cancelled()?;
        }
        if !configuration.boolean("enabled", true) {
            return Ok(None);
        }
        match request.operation {
            Operation::AskPass { prompt } => {
                if prompt.is_empty()
                    || prompt.len() > 8192
                    || prompt.contains('\0')
                    || !configuration.boolean("useIntegratedAskPass", true)
                    || token.is_none() && !configuration.boolean("terminalAuthentication", true)
                {
                    return Ok(None);
                }
                if let Some(host) = prompt_host(&prompt).filter(|host| hosts.contains(host)) {
                    let github = self.api.background.get_configuration("github", None)?;
                    if github["gitAuthentication"]
                        .as_bool()
                        .unwrap_or(configuration.boolean("githubAuthentication", true))
                    {
                        if let Ok(CoreServiceResponse::Credential { username, password }) =
                            self.api.services.call(CoreServiceRequest::CredentialGet {
                                provider_id: "github".into(),
                                host,
                                account_id: credential_account_id.clone(),
                            })
                        {
                            if prompt.starts_with("Username") {
                                return Ok(Some(username));
                            }
                            if prompt.starts_with("Password") {
                                return Ok(String::from_utf8(password).ok());
                            }
                        }
                    }
                }
                let value=self.api.editor(json!({"method":"input","title":self.api.text("git.authenticationPrompt",&[]),"placeHolder":prompt,"password":!prompt.starts_with("Username")}),token.as_ref())?;
                Ok(value.as_str().map(str::to_owned))
            }
            Operation::Editor { path, contents } => {
                if token.is_some()
                    || !configuration.boolean("terminalGitEditor", false)
                    || contents.len() > 256 * 1024
                    || !is_message_path(&path)
                {
                    return Ok(None);
                }
                let id = crate::commands::random_id()?;
                let uri = format!("untitled:git-terminal-{id}");
                let (sender, receiver) = mpsc::sync_channel(1);
                self.terminal_edits
                    .lock()
                    .map_err(|_| invalid("Git message editor failed"))?
                    .insert(uri.clone(), sender);
                self.api.editor(json!({"method":"openEditorDocument","uri":uri,"label":self.api.text("git.terminalEditorTitle",&[]),"text":contents}),None)?;
                self.api
                    .warning("git.terminalEditorInstructions", &[], None)?;
                let started = std::time::Instant::now();
                let result = loop {
                    if started.elapsed() > Duration::from_secs(300)
                        || matches!(stream.peek(&mut [0u8; 1]), Ok(0))
                    {
                        break None;
                    }
                    if self.stopped.load(Ordering::Acquire) {
                        break None;
                    }
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Ok(value) => break value,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    // A helper killed by terminal cancellation cannot leave an invisible editor job.
                    // The main activation shutdown also closes all outstanding requests.
                    if !self
                        .terminal_edits
                        .lock()
                        .map_err(|_| invalid("Git message editor failed"))?
                        .contains_key(&uri)
                    {
                        break None;
                    }
                };
                self.terminal_edits
                    .lock()
                    .map_err(|_| invalid("Git message editor failed"))?
                    .remove(&uri);
                Ok(result)
            }
        }
    }
    pub(crate) fn finish_terminal_edit(
        &self,
        cancel: bool,
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        let active = self
            .api
            .editor(json!({"method":"activeEditor"}), Some(token))?;
        let Some(uri) = active["input"]["resource"].as_str() else {
            return Ok(false);
        };
        let sender = self
            .terminal_edits
            .lock()
            .map_err(|_| invalid("Git message editor failed"))?
            .remove(uri);
        let Some(sender) = sender else {
            return Ok(false);
        };
        let document = self.api.editor(
            json!({"method":"readEditorDocument","uri":uri}),
            Some(token),
        )?;
        let text = document["text"].as_str().map(str::to_owned);
        let _ = sender.send(if cancel { None } else { text.clone() });
        self.api.editor(
            json!({"method":"closeEditorDocument","uri":uri,"expectedText":text}),
            Some(token),
        )?;
        Ok(true)
    }
    pub(crate) fn terminal_environment(
        &self,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        let config = self.api.configuration(None, Some(token))?;
        let broker = self
            .broker
            .lock()
            .map_err(|_| invalid("Git broker failed"))?;
        let mut map = Vec::new();
        if let Some(broker) = &*broker {
            let auth = config.boolean("enabled", true)
                && config.boolean("useIntegratedAskPass", true)
                && config.boolean("terminalAuthentication", true);
            let editor =
                config.boolean("enabled", true) && config.boolean("terminalGitEditor", false);
            if auth || editor {
                let executable =
                    std::env::current_exe().map_err(|_| invalid("Git helper is unavailable"))?;
                let helper = format!("'{}'", executable.to_string_lossy().replace('\'', "'\\''"));
                let mut values = vec![
                    (
                        "ASH_GIT_BRIDGE_ADDRESS",
                        broker.connection.address.to_string(),
                    ),
                    ("ASH_GIT_BRIDGE_TOKEN", broker.connection.token.clone()),
                    ("ASH_GIT_BRIDGE_SCOPE", String::new()),
                ];
                if auth {
                    values.push(("GIT_ASKPASS", format!("{helper} --askpass")));
                    values.push(("SSH_ASKPASS", executable.to_string_lossy().to_string()));
                }
                if editor {
                    values.push(("GIT_EDITOR", format!("{helper} --editor")));
                    values.push(("GIT_SEQUENCE_EDITOR", format!("{helper} --editor")));
                }
                for (key, value) in values {
                    map.push(json!([key,{"variable":key,"type":1,"value":value,"options":{"applyAtProcessCreation":true,"applyAtShellIntegration":false}}]));
                }
            }
        }
        Ok(json!({"persistent":false,"map":map,"descriptionMap":[]}))
    }
}

fn prompt_host(prompt: &str) -> Option<String> {
    let value = prompt.split('\'').nth(1)?;
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.port().is_some_and(|port| port != 443)
        || url.password().is_some()
    {
        return None;
    }
    url.host_str().map(str::to_owned)
}
fn is_message_path(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(
            "COMMIT_EDITMSG"
                | "MERGE_MSG"
                | "SQUASH_MSG"
                | "TAG_EDITMSG"
                | "NOTES_EDITMSG"
                | "git-rebase-todo"
        )
    )
}

/// Runs only when Git explicitly invokes this executable as its configured helper.
pub fn run_helper() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    let first = args.next()?;
    let (mode, prompt) = if first == "--askpass" || first == "--editor" {
        (first, None)
    } else if std::env::var_os("ASH_GIT_BRIDGE_ADDRESS").is_some() {
        ("--askpass".into(), Some(first))
    } else {
        return None;
    };
    Some(
        (|| -> io::Result<()> {
            let argument = prompt
                .or_else(|| args.next())
                .ok_or_else(|| io::Error::other("missing Git helper argument"))?;
            if args.next().is_some() {
                return Err(io::Error::other("unexpected Git helper argument"));
            }
            let address: SocketAddr = std::env::var("ASH_GIT_BRIDGE_ADDRESS")
                .map_err(io::Error::other)?
                .parse()
                .map_err(io::Error::other)?;
            if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) {
                return Err(io::Error::other("Git broker must be local"));
            }
            let cwd = std::env::current_dir()?;
            let mut original = None;
            let operation = if mode == "--askpass" {
                Operation::AskPass { prompt: argument }
            } else {
                let path = PathBuf::from(argument);
                let path = if path.is_absolute() {
                    path
                } else {
                    cwd.join(path)
                };
                if !is_message_path(&path) {
                    return Err(io::Error::other("not a Git message file"));
                }
                let mut file = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)?;
                if std::fs::symlink_metadata(&path)?.is_symlink() {
                    return Err(io::Error::other("Git message must not be a symbolic link"));
                }
                if !file.metadata()?.is_file() {
                    return Err(io::Error::other("not a regular Git message file"));
                }
                let mut contents = String::new();
                (&mut file)
                    .take(256 * 1024 + 1)
                    .read_to_string(&mut contents)?;
                if contents.len() > 256 * 1024 {
                    return Err(io::Error::other("Git message exceeds editor limit"));
                }
                let identity = ash_file_identity::FileInformation::from_file(&file)?;
                original = Some((path.clone(), contents.clone(), file, identity));
                Operation::Editor { path, contents }
            };
            let request = Request {
                token: std::env::var("ASH_GIT_BRIDGE_TOKEN").map_err(io::Error::other)?,
                scope: std::env::var("ASH_GIT_BRIDGE_SCOPE").unwrap_or_default(),
                cwd,
                operation,
            };
            let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
            stream.set_read_timeout(Some(Duration::from_secs(300)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            serde_json::to_writer(&mut stream, &request).map_err(io::Error::other)?;
            stream.write_all(b"\n")?;
            let mut line = String::new();
            io::BufReader::new((&stream).take(MAX_REQUEST + 1)).read_line(&mut line)?;
            if line.len() as u64 > MAX_REQUEST {
                return Err(io::Error::other("invalid Git broker reply"));
            }
            let response: Response = serde_json::from_str(&line).map_err(io::Error::other)?;
            let result = response
                .result
                .ok_or_else(|| io::Error::other("Git interaction cancelled"))?;
            if let Some((path, contents, mut file, identity)) = original {
                if std::fs::symlink_metadata(&path)?.is_symlink()
                    || !identity.same_file_as(ash_file_identity::FileInformation::from_path(&path)?)
                {
                    return Err(io::Error::other("Git message was replaced while editing"));
                }
                file.seek(SeekFrom::Start(0))?;
                let mut current = String::new();
                (&mut file)
                    .take(256 * 1024 + 1)
                    .read_to_string(&mut current)?;
                if current != contents {
                    return Err(io::Error::other("Git message changed while editing"));
                }
                // Keep the reviewed handle: a later path replacement cannot redirect this write.
                file.seek(SeekFrom::Start(0))?;
                file.set_len(0)?;
                file.write_all(result.as_bytes())?;
                file.sync_all()?;
            } else {
                io::stdout().write_all(result.as_bytes())?;
                io::stdout().write_all(b"\n")?;
            }
            Ok(())
        })()
        .map_or_else(
            |error| {
                eprintln!("Git helper failed: {error}");
                1
            },
            |()| 0,
        ),
    )
}
