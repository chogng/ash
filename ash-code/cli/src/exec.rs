use crate::CliError;
use crate::InterruptSignal;
use crate::configured_dir;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_exec::AppServerTarget;
use ash_exec::DiscardExecEventSink;
use ash_exec::EmbeddedAppServerOptions;
use ash_exec::ExecEntry;
use ash_exec::ExecError;
use ash_exec::ExecFailure;
use ash_exec::ExecOutcome;
use ash_exec::ExecRunRequest;
use ash_exec::ExecRunner;
use ash_exec::HeadlessApprovalMode;
use ash_exec::JsonLinesExecEventSink;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

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
    let request = ExecRunRequest::new(entry).with_approval_mode(options.approval);
    let runner = headless_runner()?;
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
    finish_headless_outcome(outcome, options.output)
}

fn headless_runner() -> Result<ExecRunner, CliError> {
    let target = AppServerTarget::Embedded(
        EmbeddedAppServerOptions::new(
            ash_utils_home_dir::find_ash_home()
                .map_err(|error| CliError::failure(error.to_string()))?,
            ClientInfo {
                name: "ash-cli-exec".into(),
                version: build_info::VERSION.into(),
            },
        )
        .with_dir_root(configured_dir().map_err(CliError::failure)?),
    );
    Ok(ExecRunner::new(target))
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
}

#[cfg(test)]
#[path = "exec_tests.rs"]
mod tests;
