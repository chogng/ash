use std::path::PathBuf;
use std::process::Command;

use crate::CliError;

/// The package owns the connector; internal clients never re-enter the CLI parser.
pub(super) fn daemon_executable() -> std::io::Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name(format!(
        "ash-app-server-daemon{}",
        std::env::consts::EXE_SUFFIX
    )))
}

pub(super) fn backend_executable() -> Result<PathBuf, CliError> {
    if let Some(path) = std::env::var_os("ASH_APP_SERVER_PATH") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(CliError::failure(
                "ASH_APP_SERVER_PATH must be an absolute path",
            ));
        }
        return Ok(path);
    }
    Ok(std::env::current_exe()
        .map_err(CliError::failure)?
        .with_file_name(format!("ash-app-server{}", std::env::consts::EXE_SUFFIX)))
}

pub(super) fn run(mut arguments: Vec<String>) -> Result<i32, CliError> {
    let executable = match arguments.first().map(String::as_str) {
        Some("connect") => daemon_executable().map_err(CliError::failure)?,
        Some("daemon") => {
            arguments.remove(0);
            daemon_executable().map_err(CliError::failure)?
        }
        _ => backend_executable()?,
    };
    let mut command = Command::new(executable);
    command.args(arguments);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace this adapter so signals, PID and exit status belong to the selected runtime.
        Err(CliError::failure(command.exec()))
    }
    #[cfg(windows)]
    {
        let status = command.status().map_err(CliError::failure)?;
        status
            .code()
            .ok_or_else(|| CliError::failure(format!("App Server terminated: {status}")))
    }
}
