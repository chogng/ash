//! Command parsing and product composition for the shared Ash command.

mod doctor;
mod exec;
mod local_tui;
mod login;
mod management;
mod reconnect;
mod remote;
mod update;

use clap::Args;
use clap::Parser;
use clap::Subcommand;
use signal_hook::SigId;
use signal_hook::consts::SIGINT;
use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

#[derive(Parser)]
#[command(name = "ash", bin_name = "ash", version = build_info::VERSION)]
#[command(about = "Ash command-line tools. Run without a command to open the TUI.")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run a prompt non-interactively and print the final answer.
    Ask {
        #[arg(required = true, num_args = 1..)]
        prompt: Vec<String>,
    },
    /// Run a task non-interactively.
    Exec(exec::Options),
    /// Resume a saved interactive session and thread.
    Resume {
        session_id: String,
        thread_id: String,
    },
    /// List saved sessions as JSON.
    Sessions,
    /// Copy a thread into an independent session and print its identity as JSON.
    Fork {
        session_id: String,
        thread_id: String,
        #[arg(long, default_value = "Forked session")]
        title: String,
    },
    /// Archive a saved session.
    Archive { session_id: String },
    /// Restore an archived session.
    Unarchive { session_id: String },
    /// Sign in, inspect accounts, or store an API key from stdin.
    Login(login::Options),
    /// Sign out of the selected provider.
    Logout { provider: String },
    /// Manage standalone MCP server declarations.
    #[command(after_help = "Server IDs use user:mcp:NAME, for example user:mcp:docs.")]
    Mcp {
        #[command(subcommand)]
        command: management::McpCommand,
    },
    /// Manage installed plugins and their permissions.
    Plugin {
        #[command(subcommand)]
        command: management::PluginCommand,
    },
    /// Check the installation, local App Server, configuration, and accounts.
    Doctor(doctor::Options),
    /// Run the App Server or manage its daemon.
    #[command(
        after_help = "Examples:\n  ash app-server --listen stdio://\n  ash app-server connect\n  ash app-server daemon start|restart|stop|version"
    )]
    AppServer(ForwardArgs),
    /// Connect to or manage a remote installation.
    #[command(after_help = "Commands: connect, probe, install, fetch-runtime, profile")]
    Remote(ForwardArgs),
    /// Update Ash or inspect the current update status.
    Update {
        #[arg(long, value_parser = ["latest", "stable"], conflicts_with = "status")]
        channel: Option<String>,
        #[arg(long)]
        status: bool,
    },
}

#[derive(Args)]
struct ForwardArgs {
    #[arg(num_args = 0.., allow_hyphen_values = true, trailing_var_arg = true)]
    arguments: Vec<String>,
}

/// Runs arguments including the executable name and returns the process exit code.
///
/// The executable owns process hardening and internal helper dispatch before this entry.
/// Help and version output do not start an App Server or access user configuration.
pub fn run(arguments: impl IntoIterator<Item = impl Into<OsString> + Clone>) -> i32 {
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            let code = error.exit_code();
            return if error.print().is_ok() { code } else { 1 };
        }
    };
    match dispatch(cli) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("ash: {}", error.message);
            error.exit_code
        }
    }
}

fn dispatch(cli: Cli) -> Result<i32, CliError> {
    let result = match cli.command {
        None => local_tui::run(configured_dir()?, profile_root()?).map_err(CliError::failure),
        Some(Command::Ask { prompt }) => exec::ask(prompt.join(" ")),
        Some(Command::Exec(options)) => exec::execute(options),
        Some(Command::Resume {
            session_id,
            thread_id,
        }) => {
            let recovery = ash_tui::TuiRecoveryState::new(
                ash_protocol::SessionId::new(session_id).map_err(CliError::usage)?,
                ash_protocol::ThreadId::new(thread_id).map_err(CliError::usage)?,
            );
            local_tui::resume(configured_dir()?, profile_root()?, recovery)
                .map_err(CliError::failure)
        }
        Some(Command::Sessions) => {
            management::with_client(|client| print_json(&client.list_sessions()?))
        }
        Some(Command::Fork {
            session_id,
            thread_id,
            title,
        }) => management::fork(session_id, thread_id, title),
        Some(Command::Archive { session_id }) => management::session_request(
            session_id,
            ash_app_server_protocol::protocol::session::SessionRequest::Archive,
        ),
        Some(Command::Unarchive { session_id }) => management::session_request(
            session_id,
            ash_app_server_protocol::protocol::session::SessionRequest::Restore,
        ),
        Some(Command::Login(options)) => login::run(options),
        Some(Command::Logout { provider }) => login::logout(provider),
        Some(Command::Mcp { command }) => management::mcp(command),
        Some(Command::Plugin { command }) => management::plugin(command),
        Some(Command::Doctor(options)) => doctor::run(options),
        Some(Command::AppServer(arguments)) => return run_app_server(arguments.arguments),
        Some(Command::Remote(arguments)) => {
            remote::run(arguments.arguments).map_err(CliError::failure)
        }
        Some(Command::Update { channel, status }) => {
            let arguments = if status {
                vec!["--status".into()]
            } else if let Some(channel) = channel {
                vec!["--channel".into(), channel]
            } else {
                Vec::new()
            };
            update::run_manual(arguments).map_err(CliError::failure)
        }
    };
    result.map(|()| 0)
}

fn run_app_server(arguments: Vec<String>) -> Result<i32, CliError> {
    match arguments.first().map(String::as_str) {
        Some("connect") => {
            ash_app_server_daemon::run_command(
                arguments,
                &ash_app_server_daemon::backend_executable_path()?,
            )
            .map_err(CliError::failure)?;
            Ok(0)
        }
        Some("daemon") => {
            ash_app_server_daemon::run_command(
                arguments.into_iter().skip(1),
                &ash_app_server_daemon::backend_executable_path()?,
            )
            .map_err(CliError::failure)?;
            Ok(0)
        }
        _ => {
            // The App Server ships beside the CLI; launching that program keeps its service graph
            // out of the interactive CLI and TUI build while preserving stdio and exit status.
            let backend = ash_app_server_daemon::backend_executable_path()?;
            let status = std::process::Command::new(backend)
                .args(arguments)
                .status()
                .map_err(CliError::failure)?;
            status
                .code()
                .ok_or_else(|| CliError::failure(format!("App Server terminated: {status}")))
        }
    }
}

fn configured_dir() -> Result<PathBuf, String> {
    env::var_os("ASH_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            env::current_dir()
                .map_err(|error| format!("could not resolve current directory: {error}"))
        })
}

fn profile_root() -> Result<PathBuf, CliError> {
    ash_utils_home_dir::find_ash_home().map_err(CliError::failure)
}

fn print_json(value: &impl serde::Serialize) -> Result<(), CliError> {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, value).map_err(CliError::failure)?;
    writeln!(stdout).map_err(CliError::failure)
}

#[derive(Debug)]
struct CliError {
    message: String,
    exit_code: i32,
}

impl CliError {
    fn failure(message: impl std::fmt::Display) -> Self {
        Self {
            message: message.to_string(),
            exit_code: 1,
        }
    }

    fn usage(message: impl std::fmt::Display) -> Self {
        Self {
            message: message.to_string(),
            exit_code: 2,
        }
    }
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        Self::failure(message)
    }
}

impl From<ash_app_server_client::ClientError> for CliError {
    fn from(error: ash_app_server_client::ClientError) -> Self {
        Self::failure(error)
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
#[path = "cli_tests.rs"]
mod tests;
