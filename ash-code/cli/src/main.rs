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
use signal_hook::SigId;
use signal_hook::consts::SIGINT;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

mod local_tui;
mod reconnect;
mod remote;
mod update;

fn main() {
    if let Err(error) = process_hardening::initialize() {
        eprintln!("process hardening failed: {error}");
        std::process::exit(1);
    }

    if let Some(result) = arg0::dispatch(env::args_os().skip(1)) {
        if let Err(error) = result {
            eprintln!("ash: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut arguments = env::args().skip(1);
    let outcome = match arguments.next() {
        None => interactive().map_err(CliError::failure),
        Some(command) => match command.as_str() {
            "--version" | "-V" => {
                println!("ash {}", build_info::VERSION);
                Ok(())
            }
            "ask" => ask(arguments.collect::<Vec<_>>().join(" ")),
            "exec" => execute(arguments.collect()),
            "resume" => resume(arguments.collect()),
            "app-server" => app_server_command(arguments.collect()).map_err(CliError::failure),
            "remote" => remote::run(arguments.collect()).map_err(CliError::failure),
            "update" => update::run_manual(arguments.collect()).map_err(CliError::failure),
            _ => Err(CliError::usage(format!("unknown command: {command}"))),
        },
    };
    if let Err(error) = outcome {
        eprintln!("ash: {}", error.message);
        std::process::exit(error.exit_code);
    }
}

fn ask(prompt: String) -> Result<(), CliError> {
    if prompt.is_empty() {
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

fn interactive() -> Result<(), String> {
    local_tui::run(
        configured_dir()?,
        ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
    )
}

fn resume(arguments: Vec<String>) -> Result<(), CliError> {
    let recovery = parse_resume_arguments(arguments)?;
    let dir_root = configured_dir().map_err(CliError::failure)?;
    local_tui::resume(
        dir_root,
        ash_utils_home_dir::find_ash_home()
            .map_err(|error| CliError::failure(error.to_string()))?,
        recovery,
    )
    .map_err(CliError::failure)
}

fn parse_resume_arguments(arguments: Vec<String>) -> Result<ash_tui::TuiRecoveryState, CliError> {
    let [session_id, thread_id] = arguments.as_slice() else {
        return Err(CliError::usage("usage: ash resume SESSION_ID THREAD_ID"));
    };
    Ok(ash_tui::TuiRecoveryState::new(
        parse_session_id(session_id)?,
        parse_thread_id(thread_id)?,
    ))
}

fn run_app_server(arguments: Vec<String>) -> Result<(), String> {
    match arguments.first().map(String::as_str) {
        Some("connect") => ash_app_server_daemon::run_command(
            arguments,
            &ash_app_server_daemon::backend_executable_path()?,
        ),
        Some("daemon") => ash_app_server_daemon::run_command(
            arguments.into_iter().skip(1),
            &ash_app_server_daemon::backend_executable_path()?,
        ),
        _ => ash_app_server::run(arguments),
    }
}

fn app_server_command(arguments: Vec<String>) -> Result<(), String> {
    run_app_server(arguments)
}

fn current_dir() -> Result<PathBuf, String> {
    env::current_dir().map_err(|error| format!("could not resolve current directory: {error}"))
}

fn configured_dir() -> Result<PathBuf, String> {
    env::var_os("ASH_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(current_dir)
}

fn execute(arguments: Vec<String>) -> Result<(), CliError> {
    run_headless(parse_exec_arguments(arguments)?)
}

fn parse_exec_arguments(arguments: Vec<String>) -> Result<HeadlessCliOptions, CliError> {
    let mut index = 0;
    let mut output = ExecOutputMode::Human;
    let mut approval = None;
    let mut entry = None;
    let mut title = "CLI execution".to_string();
    let mut prompt = Vec::new();
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--" => {
                prompt.extend(arguments[index + 1..].iter().cloned());
                break;
            }
            "--jsonl" => output = ExecOutputMode::JsonLines,
            "--auto-review" => {
                select_approval(&mut approval, HeadlessApprovalMode::AutomaticReview)?
            }
            "--dangerously-bypass-permissions" => {
                select_approval(&mut approval, HeadlessApprovalMode::BypassPermissions)?
            }
            "--title" => {
                index += 1;
                title = required_argument(&arguments, index, "--title")?.clone();
            }
            "--resume" => {
                index += 1;
                let session_id = parse_session_id(required_argument(
                    &arguments,
                    index,
                    "--resume SESSION_ID THREAD_ID",
                )?)?;
                index += 1;
                let thread_id = parse_thread_id(required_argument(
                    &arguments,
                    index,
                    "--resume SESSION_ID THREAD_ID",
                )?)?;
                select_entry(
                    &mut entry,
                    HeadlessEntry::Resume {
                        session_id,
                        thread_id,
                    },
                )?;
            }
            "--fork" => {
                index += 1;
                let session_id = parse_session_id(required_argument(
                    &arguments,
                    index,
                    "--fork SESSION_ID PARENT_THREAD_ID",
                )?)?;
                index += 1;
                let parent_thread_id = parse_thread_id(required_argument(
                    &arguments,
                    index,
                    "--fork SESSION_ID PARENT_THREAD_ID",
                )?)?;
                select_entry(
                    &mut entry,
                    HeadlessEntry::Fork {
                        session_id,
                        parent_thread_id,
                    },
                )?;
            }
            argument if argument.starts_with("--") => {
                return Err(CliError::usage(format!("unknown exec option: {argument}")));
            }
            _ => prompt.push(arguments[index].clone()),
        }
        index += 1;
    }
    let prompt = prompt.join(" ");
    if prompt.trim().is_empty() {
        return Err(CliError::usage("exec requires a prompt"));
    }
    Ok(HeadlessCliOptions {
        entry: entry.unwrap_or(HeadlessEntry::New),
        title,
        prompt,
        output,
        approval: approval.unwrap_or(HeadlessApprovalMode::DenyInteractiveRequests),
    })
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

fn select_approval(
    selected: &mut Option<HeadlessApprovalMode>,
    approval: HeadlessApprovalMode,
) -> Result<(), CliError> {
    if selected.replace(approval).is_some() {
        return Err(CliError::usage("select only one headless approval option"));
    }
    Ok(())
}

fn select_entry(
    selected: &mut Option<HeadlessEntry>,
    entry: HeadlessEntry,
) -> Result<(), CliError> {
    if selected.replace(entry).is_some() {
        return Err(CliError::usage("select only one of --resume or --fork"));
    }
    Ok(())
}

fn required_argument<'a>(
    arguments: &'a [String],
    index: usize,
    option: &str,
) -> Result<&'a String, CliError> {
    arguments
        .get(index)
        .ok_or_else(|| CliError::usage(format!("{option} requires another argument")))
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

#[derive(Debug)]
struct CliError {
    message: String,
    exit_code: i32,
}

impl CliError {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 1,
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 2,
        }
    }
}

struct InterruptSignal {
    requested: Arc<AtomicBool>,
    registration: SigId,
}

impl InterruptSignal {
    fn register() -> Result<Self, CliError> {
        let requested = Arc::new(AtomicBool::new(false));
        let registration = signal_hook::flag::register(SIGINT, Arc::clone(&requested))
            .map_err(|error| CliError::failure(format!("could not register Ctrl-C: {error}")))?;
        Ok(Self {
            requested,
            registration,
        })
    }

    fn cancellation(&self) -> &Arc<AtomicBool> {
        &self.requested
    }
}

impl Drop for InterruptSignal {
    fn drop(&mut self) {
        signal_hook::low_level::unregister(self.registration);
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
