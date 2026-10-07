use crate::CliError;
use crate::InterruptSignal;
use crate::configured_dir;
use crate::nls;
use crate::nls::Message;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_exec::DiscardExecEventSink;
use ash_exec::ExecEntry;
use ash_exec::ExecError;
use ash_exec::ExecFailure;
use ash_exec::ExecOutcome;
use ash_exec::ExecRunRequest;
use ash_exec::ExecRunner;
use ash_exec::ExecRunnerOptions;
use ash_exec::HeadlessApprovalMode;
use ash_exec::JsonLinesExecEventSink;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use std::path::PathBuf;
use std::time::Duration;

pub(super) fn ask(prompt: String) -> Result<(), CliError> {
    if prompt.trim().is_empty() {
        return Err(CliError::usage("ask requires a prompt"));
    }
    run_headless(HeadlessCliOptions {
        entry: HeadlessEntry::New,
        title: "CLI conversation".into(),
        prompt,
        output: ExecOutputMode::Human,
        approval: HeadlessApprovalMode::DenyInteractiveRequests,
        model: None,
        timeout_seconds: 60,
        trace_output: None,
        changes_output: None,
    })
}

#[derive(clap::Args)]
pub(super) struct Options {
    /// Emit execution events as JSON Lines.
    #[arg(long)]
    jsonl: bool,
    /// Review approval requests automatically.
    #[arg(long, conflicts_with = "dangerously_bypass_permissions")]
    auto_review: bool,
    /// Bypass permission checks for this run.
    #[arg(long)]
    dangerously_bypass_permissions: bool,
    #[arg(long, default_value = "CLI execution")]
    title: String,
    /// Continue the exact saved session and thread.
    #[arg(long, num_args = 2, value_names = ["SESSION_ID", "THREAD_ID"], conflicts_with = "fork")]
    resume: Option<Vec<String>>,
    /// Fork the selected thread before executing the prompt.
    #[arg(long, num_args = 2, value_names = ["SESSION_ID", "PARENT_THREAD_ID"])]
    fork: Option<Vec<String>>,
    #[arg(long, value_name = "PROVIDER/MODEL", value_parser = parse_model, help = nls::text(Message::ExecModelHelp))]
    model: Option<ash_protocol::ModelRef>,
    #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u64).range(1..), help = nls::text(Message::ExecTimeoutHelp))]
    timeout_seconds: u64,
    #[arg(long, value_name = "PATH", help = nls::text(Message::ExecTraceHelp))]
    trace_output: Option<PathBuf>,
    #[arg(long, value_name = "PATH", help = nls::text(Message::ExecChangesHelp))]
    changes_output: Option<PathBuf>,
    #[arg(required = true, num_args = 1..)]
    prompt: Vec<String>,
}

impl Options {
    fn into_headless(self) -> Result<HeadlessCliOptions, CliError> {
        let entry = if let Some(ids) = self.resume {
            HeadlessEntry::Resume {
                session_id: parse_session_id(&ids[0])?,
                thread_id: parse_thread_id(&ids[1])?,
            }
        } else if let Some(ids) = self.fork {
            HeadlessEntry::Fork {
                session_id: parse_session_id(&ids[0])?,
                parent_thread_id: parse_thread_id(&ids[1])?,
            }
        } else {
            HeadlessEntry::New
        };
        let prompt = self.prompt.join(" ");
        if prompt.trim().is_empty() {
            return Err(CliError::usage("exec requires a prompt"));
        }
        Ok(HeadlessCliOptions {
            entry,
            title: self.title,
            prompt,
            model: self.model,
            timeout_seconds: self.timeout_seconds,
            trace_output: self.trace_output,
            changes_output: self.changes_output,
            output: if self.jsonl {
                ExecOutputMode::JsonLines
            } else {
                ExecOutputMode::Human
            },
            approval: if self.auto_review {
                HeadlessApprovalMode::AutomaticReview
            } else if self.dangerously_bypass_permissions {
                HeadlessApprovalMode::BypassPermissions
            } else {
                HeadlessApprovalMode::DenyInteractiveRequests
            },
        })
    }
}

pub(super) fn execute(options: Options) -> Result<(), CliError> {
    run_headless(options.into_headless()?)
}

fn run_headless(options: HeadlessCliOptions) -> Result<(), CliError> {
    let entry = match options.entry {
        HeadlessEntry::New => ExecEntry::New {
            title: options.title,
            input: prompt_input(options.prompt),
        },
        HeadlessEntry::Resume {
            session_id,
            thread_id,
        } => ExecEntry::Resume {
            session_id,
            thread_id,
            input: prompt_input(options.prompt),
        },
        HeadlessEntry::Fork {
            session_id,
            parent_thread_id,
        } => ExecEntry::Fork {
            session_id,
            parent_thread_id,
            title: options.title,
            input: prompt_input(options.prompt),
        },
    };
    let mut request = ExecRunRequest::new(entry).with_approval_mode(options.approval);
    if let Some(model) = options.model {
        request = request.with_model(model);
    }
    let runner = headless_runner()?.with_options(
        ExecRunnerOptions::new().with_turn_timeout(Duration::from_secs(options.timeout_seconds)),
    );
    let interrupt = InterruptSignal::register()?;
    let outcome = match options.output {
        ExecOutputMode::Human => {
            runner.run(request, DiscardExecEventSink, interrupt.cancellation())
        }
        ExecOutputMode::JsonLines => {
            let stdout = std::io::stdout();
            let sink = JsonLinesExecEventSink::new(stdout.lock());
            runner.run(request, sink, interrupt.cancellation())
        }
    }
    .map_err(exec_error)?;
    if let Some(path) = options.trace_output {
        save_trace(&outcome, path)?;
    }
    if let Some(path) = options.changes_output {
        save_changes(&outcome, path)?;
    }
    finish_headless_outcome(outcome, options.output)
}

fn headless_runner() -> Result<ExecRunner, CliError> {
    let (command, execution_root) = headless_command()?;
    Ok(ExecRunner::new(command, exec_client_info(), execution_root))
}

fn exec_client_info() -> ClientInfo {
    ClientInfo {
        name: "ash-cli-exec".into(),
        version: build_info::VERSION.into(),
    }
}

fn headless_command() -> Result<(StdioAppServerCommand, PathBuf), CliError> {
    let executable = std::env::current_exe().map_err(CliError::failure)?;
    let execution_root = configured_dir().map_err(CliError::failure)?;
    let command = StdioAppServerCommand::new(executable)
        .with_argument("app-server")
        .with_argument("connect")
        .with_environment_variable("ASH_HOME", crate::profile_root()?.into_os_string())
        .with_environment_variable(
            "ASH_WORKSPACE_ROOT",
            execution_root.clone().into_os_string(),
        );
    Ok((command, execution_root))
}

fn save_trace(outcome: &ExecOutcome, path: PathBuf) -> Result<(), CliError> {
    let session_id = match outcome {
        ExecOutcome::Completed { session_id, .. }
        | ExecOutcome::Failed { session_id, .. }
        | ExecOutcome::Interrupted { session_id, .. }
        | ExecOutcome::RequiresInteraction { session_id, .. }
        | ExecOutcome::OutcomeUnknown { session_id, .. } => session_id.clone(),
    };
    let (command, _) = headless_command()?;
    let session =
        AppServerSession::start_stdio(command, exec_client_info(), ClientCapabilities::default())
            .map_err(CliError::failure)?;
    let captured = (|| -> Result<(), CliError> {
        let mut client = session.client();
        let mut after = std::collections::BTreeMap::new();
        let mut captured: Option<serde_json::Value> = None;
        loop {
            let page = client
                .read_session_trace(
                    ash_app_server_protocol::protocol::session::SessionTraceReadParams {
                        session_id: session_id.clone(),
                        after,
                        limit: 500,
                    },
                )
                .map_err(CliError::failure)?;
            if let Some(trace) = &mut captured {
                merge_trace_page(trace, &page.trace)?;
            } else {
                captured = Some(page.trace);
            }
            after = page.cursors;
            if !page.has_more {
                break;
            }
        }
        let mut trace = captured.unwrap();
        let mut after = 0;
        let mut diagnostics: Option<serde_json::Value> = None;
        loop {
            let page = client
                .read_trace_diagnostics(
                    ash_app_server_protocol::protocol::session::SessionTraceDiagnosticsReadParams {
                        session_id: session_id.clone(),
                        after,
                        limit: 500,
                    },
                )
                .map_err(CliError::failure)?;
            if let Some(captured) = &mut diagnostics {
                let mut events = captured["events"]
                    .as_array()
                    .cloned()
                    .ok_or_else(|| CliError::failure(nls::text(Message::ExecInvalidTrace)))?;
                events.extend(
                    page.diagnostics["events"]
                        .as_array()
                        .ok_or_else(|| CliError::failure(nls::text(Message::ExecInvalidTrace)))?
                        .iter()
                        .cloned(),
                );
                *captured = page.diagnostics;
                captured["events"] = events.into();
            } else {
                diagnostics = Some(page.diagnostics);
            }
            after = page.cursor;
            if !page.has_more {
                break;
            }
        }
        let mut diagnostics = diagnostics.unwrap();
        let mut payloads = serde_json::Map::new();
        let mut incomplete = false;
        if let Some(capture_id) = diagnostics["captureId"].as_str() {
            for record in diagnostics["events"].as_array().into_iter().flatten() {
                let event = &record["event"];
                for field in ["requestPayload", "responsePayload", "partialOutput"] {
                    let reference = &event[field];
                    if reference["status"] != "saved" {
                        continue;
                    }
                    if let Some(id) = reference["payloadId"].as_str() {
                        // Missing optional evidence must not erase an otherwise usable capture.
                        if let Ok(result) = client.read_trace_payload(ash_app_server_protocol::protocol::session::SessionTracePayloadReadParams { session_id: session_id.clone(), capture_id: capture_id.into(), payload_id: id.into() }) { payloads.insert(id.into(), result.payload); }
                        else { incomplete = true; }
                    }
                }
            }
        }
        if incomplete {
            diagnostics["recordingStatus"] = "incomplete".into();
        }
        diagnostics["payloads"] = payloads.into();
        trace["diagnostics"] = diagnostics;
        trace["graph"] = client
            .read_trace_graph(
                ash_app_server_protocol::protocol::session::SessionReadParams { session_id },
            )
            .map_err(CliError::failure)?
            .graph;
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&trace).map_err(CliError::failure)?,
        )
        .map_err(CliError::failure)
    })();
    let shutdown = session.shutdown().map_err(CliError::failure);
    captured
        .and(shutdown)
        .map_err(|error| CliError::failure(nls::format(Message::ExecTraceFailed, error.message)))
}

fn save_changes(outcome: &ExecOutcome, path: PathBuf) -> Result<(), CliError> {
    use ash_app_server_protocol::protocol::turn_changes::TurnChangeCaptureStateDto;
    use ash_app_server_protocol::protocol::turn_changes::TurnChangesListParams;
    use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadFileParams;
    use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadParams;

    let (session_id, thread_id, turn_id) = match outcome {
        ExecOutcome::Completed {
            session_id,
            thread_id,
            turn_id,
            ..
        }
        | ExecOutcome::Failed {
            session_id,
            thread_id,
            turn_id,
            ..
        }
        | ExecOutcome::Interrupted {
            session_id,
            thread_id,
            turn_id,
            ..
        }
        | ExecOutcome::RequiresInteraction {
            session_id,
            thread_id,
            turn_id,
            ..
        }
        | ExecOutcome::OutcomeUnknown {
            session_id,
            thread_id,
            turn_id,
            ..
        } => (session_id.clone(), thread_id.clone(), turn_id.clone()),
    };
    let (command, _) = headless_command()?;
    let session =
        AppServerSession::start_stdio(command, exec_client_info(), ClientCapabilities::default())
            .map_err(CliError::failure)?;
    let captured = (|| -> Result<(), CliError> {
        let mut client = session.client();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        // Turn termination precedes asynchronous change sealing. Read its immutable result rather
        // than the source checkout or the private managed directory, which may already be gone.
        let records = loop {
            let records = client
                .list_turn_changes(TurnChangesListParams {
                    session_id: session_id.clone(),
                    thread_id: thread_id.clone(),
                })
                .map_err(CliError::failure)?
                .change_sets
                .into_iter()
                .filter(|record| record.turn_id == turn_id)
                .collect::<Vec<_>>();
            if !records.is_empty()
                && records
                    .iter()
                    .all(|record| record.capture_state != TurnChangeCaptureStateDto::Open)
            {
                break records;
            }
            if std::time::Instant::now() >= deadline {
                return Err(CliError::failure(nls::text(
                    Message::ExecChangesUnavailable,
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut change_sets = Vec::new();
        for record in records {
            let changes = client
                .read_turn_changes(TurnChangesReadParams {
                    session_id: session_id.clone(),
                    thread_id: thread_id.clone(),
                    change_set_id: record.change_set_id.clone(),
                })
                .map_err(CliError::failure)?;
            let mut files = Vec::new();
            for file in changes.files {
                let content = client
                    .read_turn_changes_file(TurnChangesReadFileParams {
                        session_id: session_id.clone(),
                        thread_id: thread_id.clone(),
                        change_set_id: record.change_set_id.clone(),
                        path: file.path.clone(),
                    })
                    .map_err(CliError::failure)?;
                files.push(serde_json::json!({ "file": file, "content": content }));
            }
            change_sets.push(serde_json::json!({ "summary": changes.summary, "files": files }));
        }
        let artifact = serde_json::json!({ "formatVersion": 1, "sessionId": session_id, "threadId": thread_id, "turnId": turn_id, "changeSets": change_sets });
        std::fs::write(
            path,
            serde_json::to_vec_pretty(&artifact).map_err(CliError::failure)?,
        )
        .map_err(CliError::failure)
    })();
    let shutdown = session.shutdown().map_err(CliError::failure);
    captured
        .and(shutdown)
        .map_err(|error| CliError::failure(nls::format(Message::ExecChangesFailed, error.message)))
}

fn merge_trace_page(
    trace: &mut serde_json::Value,
    page: &serde_json::Value,
) -> Result<(), CliError> {
    let invalid = || CliError::failure(nls::text(Message::ExecInvalidTrace));
    let threads = trace["threads"].as_array_mut().ok_or_else(invalid)?;
    for thread in page["threads"].as_array().ok_or_else(invalid)? {
        if let Some(existing) = threads
            .iter_mut()
            .find(|existing| existing["threadId"] == thread["threadId"])
        {
            existing["events"]
                .as_array_mut()
                .ok_or_else(invalid)?
                .extend(
                    thread["events"]
                        .as_array()
                        .ok_or_else(invalid)?
                        .iter()
                        .cloned(),
                );
        } else {
            threads.push(thread.clone());
        }
    }
    let prefixes = trace["historyPrefixes"]
        .as_array_mut()
        .ok_or_else(invalid)?;
    for prefix in page["historyPrefixes"].as_array().ok_or_else(invalid)? {
        if !prefixes.contains(prefix) {
            prefixes.push(prefix.clone());
        }
    }
    Ok(())
}

fn parse_model(value: &str) -> Result<ash_protocol::ModelRef, String> {
    let invalid = || nls::text(Message::ExecInvalidModel).to_owned();
    let (provider, model) = value.split_once('/').ok_or_else(invalid)?;
    if provider.trim() != provider || model.trim() != model {
        return Err(invalid());
    }
    Ok(ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new(provider).map_err(|_| invalid())?,
        ash_protocol::ModelId::new(model).map_err(|_| invalid())?,
    ))
}

fn finish_headless_outcome(outcome: ExecOutcome, output: ExecOutputMode) -> Result<(), CliError> {
    if let ExecOutcome::Completed { .. } = &outcome {
        if output == ExecOutputMode::Human
            && let Some(message) = outcome.final_message()
        {
            println!("{message}");
        }
        return Ok(());
    }
    Err(CliError {
        message: outcome_message(&outcome),
        exit_code: outcome.exit_code().get(),
    })
}

fn outcome_message(outcome: &ExecOutcome) -> String {
    match outcome {
        ExecOutcome::Completed { .. } => "headless run completed".into(),
        ExecOutcome::Failed {
            failure: ExecFailure::Reported { error },
            ..
        } => format!("Turn failed: {}", error.message),
        ExecOutcome::Failed {
            failure: ExecFailure::Unspecified,
            ..
        } => "Turn failed without a stable error".into(),
        ExecOutcome::Interrupted { reason, .. } => {
            format!("Turn was interrupted: {reason:?}")
        }
        ExecOutcome::RequiresInteraction { interaction, .. } => format!(
            "headless run requires an unsupported {:?} interaction",
            interaction.kind
        ),
        ExecOutcome::OutcomeUnknown { reason, .. } => {
            format!("Turn outcome is unknown: {reason:?}")
        }
    }
}

fn exec_error(error: ExecError) -> CliError {
    let exit_code = if matches!(error, ExecError::CancelledBeforeStart) {
        130
    } else {
        1
    };
    CliError {
        message: error.to_string(),
        exit_code,
    }
}

fn prompt_input(prompt: String) -> Vec<InputItem> {
    vec![InputItem::Text { text: prompt }]
}

fn parse_session_id(value: &str) -> Result<SessionId, CliError> {
    SessionId::new(value).map_err(|error| CliError::usage(error.to_string()))
}

fn parse_thread_id(value: &str) -> Result<ThreadId, CliError> {
    ThreadId::new(value).map_err(|error| CliError::usage(error.to_string()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HeadlessEntry {
    New,
    Resume {
        session_id: SessionId,
        thread_id: ThreadId,
    },
    Fork {
        session_id: SessionId,
        parent_thread_id: ThreadId,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExecOutputMode {
    Human,
    JsonLines,
}

struct HeadlessCliOptions {
    entry: HeadlessEntry,
    title: String,
    prompt: String,
    output: ExecOutputMode,
    approval: HeadlessApprovalMode,
    model: Option<ash_protocol::ModelRef>,
    timeout_seconds: u64,
    trace_output: Option<PathBuf>,
    changes_output: Option<PathBuf>,
}

#[cfg(test)]
#[path = "exec_tests.rs"]
mod tests;
