//! Launches the installed desktop host without starting terminal or backend services.

use crate::CliError;
use crate::nls;
use crate::nls::Message;
use clap::Args;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

#[derive(Args)]
pub(crate) struct Options {
    #[arg(value_name = "PATH", default_value = ".", help = nls::text(Message::Workspace))]
    pub(crate) path: PathBuf,
    #[arg(long, value_name = "PATH", help = nls::text(Message::AppPath))]
    pub(crate) app_path: Option<PathBuf>,
}

pub(crate) fn run(options: Options) -> Result<(), CliError> {
    let workspace = resolve_existing_path(&options.path).map_err(|error| {
        CliError::failure(nls::format(
            Message::InvalidWorkspace,
            format!("{}: {error}", options.path.display()),
        ))
    })?;
    let app = match options.app_path {
        Some(path) => resolve_existing_path(&path).map_err(|error| {
            CliError::failure(nls::format(
                Message::InvalidApp,
                format!("{}: {error}", path.display()),
            ))
        })?,
        None => installed_application()
            .ok_or_else(|| CliError::failure(nls::text(Message::AppMissing)))?,
    };
    let mut command = launch_command(&app, &workspace)?;
    command.env_remove("ELECTRON_RUN_AS_NODE");
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());

    #[cfg(target_os = "macos")]
    if app.extension().is_some_and(|extension| extension == "app") {
        // LaunchServices reports launch failure before returning; -n forwards arguments even
        // when Ash is already open, and Ash's existing instance handler selects the window.
        let status = command.status().map_err(launch_error)?;
        return if status.success() {
            Ok(())
        } else {
            Err(launch_error(status))
        };
    }

    // The GUI owns its lifetime after this short-lived CLI exits. Isolate it from terminal
    // interrupts and inherited pipes so callers can capture CLI output without waiting for it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map_err(launch_error)?;
    Ok(())
}

fn resolve_existing_path(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    {
        // canonicalize adds a verbatim \\?\ prefix. Keep ordinary Windows paths at the
        // Electron argument boundary while still rejecting missing targets before launch.
        std::fs::metadata(path)?;
        std::path::absolute(path)
    }
    #[cfg(not(windows))]
    {
        path.canonicalize()
    }
}

fn launch_error(error: impl std::fmt::Display) -> CliError {
    CliError::failure(nls::format(Message::LaunchFailed, error.to_string()))
}

fn installed_application() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let mut candidates = std::iter::once(PathBuf::from("/Applications/Ash.app")).chain(
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications/Ash.app")),
    );
    #[cfg(target_os = "windows")]
    let mut candidates = std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("Programs/Ash/Ash.exe"))
        .into_iter()
        .chain(
            ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
                .into_iter()
                .filter_map(|key| {
                    std::env::var_os(key).map(|root| PathBuf::from(root).join("Ash/Ash.exe"))
                }),
        );
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut candidates = std::iter::empty::<PathBuf>();
    candidates.find(|path| application_executable(path).is_file())
}

fn application_executable(app: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    if app.extension().is_some_and(|extension| extension == "app") {
        return app.join("Contents/MacOS/Ash");
    }
    app.to_owned()
}

fn launch_command(app: &Path, workspace: &Path) -> Result<Command, CliError> {
    if !application_executable(app).is_file() {
        return Err(CliError::failure(nls::format(
            Message::InvalidApp,
            app.display().to_string(),
        )));
    }
    #[cfg(target_os = "macos")]
    if app.extension().is_some_and(|extension| extension == "app") {
        let mut command = Command::new("/usr/bin/open");
        command.args(["-n", "-a"]).arg(app).arg("--args");
        command.arg("--").arg(workspace);
        return Ok(command);
    }
    let mut command = Command::new(app);
    // An absolute positional target lets the desktop host distinguish folders, files and
    // workspace files; -- keeps user paths out of its option parser.
    command.arg("--").arg(workspace);
    Ok(command)
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
