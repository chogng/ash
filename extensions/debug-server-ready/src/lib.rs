//! Session-scoped output matching. DAP state and child lifecycles remain with Debug.
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::client::DebugSessionOptions;
use external_ext_sdk::client::MessageSeverity;
use external_ext_sdk::debug::AdapterTracker;
use external_ext_sdk::debug::TrackerEvent;
use external_ext_sdk::debug::TrackerSession;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Default)]
pub struct Extension {
    workflow: Option<Workflow>,
}
impl external_ext_sdk::Extension for Extension {
    fn id(&self) -> &str {
        "ash.debug-server-ready"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let workflow = Workflow::new(BackgroundClient::new(context.services.clone()));
        let jobs = workflow.jobs.clone();
        self.workflow = Some(workflow);
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
        let error = messages["error.configuration"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let trackers = Arc::new(Mutex::new(
            BTreeMap::<String, std::sync::Weak<Tracker>>::new(),
        ));
        let output = Arc::clone(&trackers);
        context
            .debug
            .register_tracker_factory("server-ready", "*", move |session, token| {
                token.check_cancelled()?;
                let key = session.id.clone();
                let (action, state, owner, owns_action) = if let Some(value) =
                    session.configuration.properties.get("serverReadyAction")
                {
                    let action = match Action::parse(value, &error) {
                        Ok(action) => action,
                        Err(failure) => {
                            // Optional tracker factory failures are logged by the
                            // host. Surface configuration mistakes to the user
                            // through the existing notification owner as well.
                            jobs.try_send(Work::Report(failure.message))
                                .map_err(|_| invalid(&error))?;
                            return Ok(None);
                        }
                    };
                    (
                        Arc::new(action),
                        Arc::new(Mutex::new(State::default())),
                        session,
                        true,
                    )
                } else {
                    let parent = session.parent_session_id.as_ref().and_then(|id| {
                        trackers
                            .lock()
                            .ok()?
                            .get(id)
                            .and_then(std::sync::Weak::upgrade)
                    });
                    let Some(parent) = parent else {
                        return Ok(None);
                    };
                    (
                        Arc::clone(&parent.action),
                        Arc::clone(&parent.state),
                        parent.session.clone(),
                        false,
                    )
                };
                let tracker = Arc::new(Tracker {
                    jobs: jobs.clone(),
                    session: owner,
                    action,
                    state,
                    owns_action,
                });
                let mut handles = trackers.lock().map_err(|_| invalid(&error))?;
                handles.retain(|_, tracker| tracker.strong_count() != 0);
                handles.insert(key, Arc::downgrade(&tracker));
                Ok(Some(tracker))
            })?;
        context
            .debug
            .observe_events("server-ready.terminal", move |event, token| {
                if event["type"] != "terminalOutput" {
                    return Ok(());
                }
                let (Some(id), Some(text)) =
                    (event["sessionId"].as_str(), event["output"].as_str())
                else {
                    return Err(invalid("Invalid terminal output event"));
                };
                let tracker = output
                    .lock()
                    .map_err(|_| invalid("Debug observer failed"))?
                    .get(id)
                    .and_then(std::sync::Weak::upgrade);
                if let Some(tracker) = tracker {
                    tracker.output("terminal", text, &token)?;
                }
                Ok(())
            })
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        if let Some(mut workflow) = self.workflow.take() {
            workflow.stop();
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    OpenExternally,
    StartDebugging,
    DebugWithChrome,
    DebugWithEdge,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    action: Kind,
    pattern: Option<String>,
    uri_format: Option<String>,
    name: Option<String>,
    config: Option<Value>,
    web_root: Option<String>,
    #[serde(default)]
    kill_on_server_stop: bool,
}
struct Action {
    settings: Settings,
    pattern: Regex,
    error: String,
}
impl Action {
    fn parse(value: &Value, error: &str) -> Result<Self, ExtensionError> {
        let settings: Settings =
            serde_json::from_value(value.clone()).map_err(|_| invalid(error))?;
        let pattern = settings
            .pattern
            .as_deref()
            .unwrap_or(r"(?i)listening on.*?\b(https?://[^\s]+|[0-9]+)");
        if pattern.len() > 4096
            || settings
                .uri_format
                .as_ref()
                .is_some_and(|format| format.len() > 8192 || format.matches("%s").count() != 1)
            || settings
                .name
                .as_ref()
                .is_some_and(|name| name.is_empty() || name.len() > 4096)
            || settings
                .config
                .as_ref()
                .is_some_and(|config| !config.is_object())
            || matches!(settings.action, Kind::StartDebugging)
                && (settings.name.is_some() == settings.config.is_some())
        {
            return Err(invalid(error));
        }
        let regex = regex::RegexBuilder::new(pattern)
            .size_limit(1024 * 1024)
            .build()
            .map_err(|_| invalid(error))?;
        if regex.captures_len() < 2 {
            return Err(invalid(error));
        }
        Ok(Self {
            settings,
            pattern: regex,
            error: error.into(),
        })
    }
    fn uri(&self, capture: &str) -> Result<String, ExtensionError> {
        let uri = match self.settings.uri_format.as_deref() {
            Some(format) => format.replacen("%s", capture, 1),
            None if capture.bytes().all(|byte| byte.is_ascii_digit()) => {
                format!("http://localhost:{capture}")
            }
            None => capture.into(),
        };
        let parsed = url::Url::parse(&uri).map_err(|_| invalid(&self.error))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || uri.len() > 8192
        {
            return Err(invalid(&self.error));
        }
        Ok(uri)
    }
}

#[derive(Default)]
struct State {
    output: BTreeMap<String, String>,
    fired: bool,
    disposed: bool,
    generation: u64,
}
struct Tracker {
    jobs: mpsc::SyncSender<Work>,
    owns_action: bool,
    session: TrackerSession,
    action: Arc<Action>,
    state: Arc<Mutex<State>>,
}
impl Tracker {
    fn output(
        &self,
        category: &str,
        text: &str,
        token: &CancellationToken,
    ) -> Result<(), ExtensionError> {
        static ANSI: OnceLock<Regex> = OnceLock::new();
        let capture = {
            let mut state = self.state.lock().map_err(|_| invalid(&self.action.error))?;
            if state.disposed
                || state.fired
                || !matches!(category, "stdout" | "stderr" | "console" | "terminal")
            {
                return Ok(());
            }
            let buffer = state.output.entry(category.into()).or_default();
            // A bounded raw buffer preserves escape sequences and UTF-8 across output chunks.
            buffer.push_str(text);
            if buffer.len() > 32768 {
                let mut start = buffer.len() - 32768;
                while !buffer.is_char_boundary(start) {
                    start += 1;
                }
                buffer.drain(..start);
            }
            let plain = ANSI
                .get_or_init(|| {
                    Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
                        .expect("constant ANSI expression")
                })
                .replace_all(buffer, "");
            let capture = self
                .action
                .pattern
                .captures(&plain)
                .and_then(|captures| captures.get(1))
                .map(|capture| capture.as_str().to_owned());
            if capture.is_some() {
                state.fired = true;
                state.output.clear();
            }
            capture
        };
        let Some(capture) = capture else {
            return Ok(());
        };
        token.check_cancelled()?;
        let generation = self
            .state
            .lock()
            .map_err(|_| invalid(&self.action.error))?
            .generation;
        self.jobs
            .try_send(Work::Execute(Job {
                session: self.session.clone(),
                action: Arc::clone(&self.action),
                capture,
                state: Arc::clone(&self.state),
                generation,
            }))
            .map_err(|_| invalid(&self.action.error))?;
        Ok(())
    }
}
impl AdapterTracker for Tracker {
    fn event(&self, event: TrackerEvent, token: CancellationToken) -> Result<(), ExtensionError> {
        match event {
            TrackerEvent::Send { message }
                if message["type"] == "event" && message["event"] == "output" =>
            {
                if let Some(text) = message["body"]["output"].as_str() {
                    self.output(
                        message["body"]["category"].as_str().unwrap_or("console"),
                        text,
                        &token,
                    )?;
                }
            }
            TrackerEvent::Receive { message }
                if message["type"] == "request" && message["command"] == "restart" =>
            {
                let mut state = self.state.lock().map_err(|_| invalid(&self.action.error))?;
                let generation = state.generation.wrapping_add(1);
                *state = State {
                    generation,
                    ..State::default()
                };
            }
            TrackerEvent::Dispose | TrackerEvent::Exit { .. } | TrackerEvent::Stop
                if self.owns_action =>
            {
                let mut state = self.state.lock().map_err(|_| invalid(&self.action.error))?;
                state.disposed = true;
                state.output.clear();
            }
            TrackerEvent::Start
            | TrackerEvent::Receive { .. }
            | TrackerEvent::Send { .. }
            | TrackerEvent::Error { .. }
            | TrackerEvent::Exit { .. }
            | TrackerEvent::Dispose
            | TrackerEvent::Stop => {}
        }
        Ok(())
    }
}
fn invalid(message: &str) -> ExtensionError {
    ExtensionError::new(HostErrorCode::InvalidRequest, message)
}

struct Job {
    session: TrackerSession,
    action: Arc<Action>,
    capture: String,
    state: Arc<Mutex<State>>,
    generation: u64,
}
enum Work {
    Execute(Job),
    Report(String),
}
struct Workflow {
    jobs: mpsc::SyncSender<Work>,
    stopped: Arc<AtomicBool>,
    client: BackgroundClient,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Workflow {
    fn new(client: BackgroundClient) -> Self {
        let (jobs, receive) = mpsc::sync_channel::<Work>(64);
        let stopped = Arc::new(AtomicBool::new(false));
        let retiring = Arc::clone(&stopped);
        let calls = client.clone();
        let worker = std::thread::spawn(move || {
            while !retiring.load(Ordering::Acquire) {
                match receive.recv_timeout(Duration::from_millis(25)) {
                    Ok(Work::Execute(job)) => {
                        let current = job.state.lock().is_ok_and(|state| {
                            !state.disposed && state.generation == job.generation
                        });
                        if !current || retiring.load(Ordering::Acquire) {
                            continue;
                        }
                        if let Err(error) = execute(&calls, job) {
                            let _ = calls.show_message(MessageSeverity::Error, error.message);
                        }
                    }
                    Ok(Work::Report(message)) => {
                        let _ = calls.show_message(MessageSeverity::Error, message);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Self {
            jobs,
            stopped,
            client,
            worker: Some(worker),
        }
    }
    fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.client.close();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Workflow {
    fn drop(&mut self) {
        self.stop();
    }
}
fn execute(client: &BackgroundClient, job: Job) -> Result<(), ExtensionError> {
    let capture = job.capture;
    if matches!(job.action.settings.action, Kind::OpenExternally) {
        client
            .editor_operation(json!({"method":"openExternal","uri":job.action.uri(&capture)?}))?;
    } else {
        let configuration = match job.action.settings.action {
            Kind::StartDebugging => job
                .action
                .settings
                .config
                .clone()
                .unwrap_or_else(|| json!(job.action.settings.name)),
            Kind::DebugWithChrome | Kind::DebugWithEdge => json!({
                "name":job.session.name, "type":if matches!(job.action.settings.action, Kind::DebugWithEdge) {"msedge"} else {"chrome"},
                "request":"launch", "url":job.action.uri(&capture)?,
                "webRoot":job.action.settings.web_root.as_deref().unwrap_or("${workspaceFolder}")
            }),
            Kind::OpenExternally => unreachable!(),
        };
        let options = job
            .action
            .settings
            .kill_on_server_stop
            .then(|| DebugSessionOptions {
                parent_session_id: Some(job.session.id.clone()),
                lifecycle_managed_by_parent: Some(true),
                console_mode: None,
                no_debug: None,
                suppress_save_before_start: Some(true),
            });
        client.start_debugging(
            job.session
                .workspace_folder
                .as_ref()
                .map(|folder| folder.uri.clone()),
            configuration,
            options,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
