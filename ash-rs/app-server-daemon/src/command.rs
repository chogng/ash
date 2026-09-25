use std::path::Path;
use std::path::PathBuf;

use crate::ConnectionOptions;
use crate::GrantSource;
use crate::LifecycleCommand;
use ash_install_context::discovered_product_services_path;

/// Runs daemon connection and lifecycle commands using the explicit host environment.
pub fn run_command(
    arguments: impl IntoIterator<Item = String>,
    backend_executable: &Path,
) -> Result<(), String> {
    if !backend_executable.is_absolute() {
        return Err("daemon executable must be an absolute path".into());
    }
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let (command, product_services) = parse(&arguments)?;
    match std::env::var("ASH_APP_SERVER_SHA256") {
        Ok(expected) => validate_backend_digest(backend_executable, &expected)?,
        Err(std::env::VarError::NotPresent) => {}
        Err(_) => return Err("ASH_APP_SERVER_SHA256 must contain a SHA-256 digest".into()),
    }
    let grant_source = match std::env::var("ASH_DIR_GRANT_SOURCE").as_deref() {
        Ok("userConfig") => GrantSource::UserConfig,
        Ok("hostConfiguration") | Err(std::env::VarError::NotPresent) => {
            GrantSource::HostConfiguration
        }
        _ => return Err("ASH_DIR_GRANT_SOURCE must be userConfig or hostConfiguration".into()),
    };
    let options = ConnectionOptions::new(
        ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
        std::env::var_os("ASH_WORKSPACE_ROOT").map(PathBuf::from),
        grant_source,
        product_services.or_else(discovered_product_services_path),
    );
    match command {
        Command::Connect => crate::connect(options, backend_executable),
        Command::ConnectSelected => crate::connect_selected(options, backend_executable),
        Command::Lifecycle(command) => {
            let output = crate::run_lifecycle(command, options, backend_executable)?;
            println!(
                "{}",
                serde_json::to_string(&output).map_err(|error| error.to_string())?
            );
            Ok(())
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Connect,
    ConnectSelected,
    Lifecycle(LifecycleCommand),
}

fn parse(arguments: &[String]) -> Result<(Command, Option<PathBuf>), String> {
    let Some((command, remaining)) = arguments.split_first() else {
        return Err(usage().into());
    };
    let command = match command.as_str() {
        "connect" => Command::Connect,
        "connect-selected" => Command::ConnectSelected,
        "start" => Command::Lifecycle(LifecycleCommand::Start),
        "ensure-selected" => Command::Lifecycle(LifecycleCommand::EnsureSelected),
        "restart" => Command::Lifecycle(LifecycleCommand::Restart),
        "stop" => Command::Lifecycle(LifecycleCommand::Stop),
        "version" => Command::Lifecycle(LifecycleCommand::Version),
        _ => return Err(usage().into()),
    };
    let product_services = match remaining {
        [] => None,
        [flag, path] if flag == "--product-services" => Some(PathBuf::from(path)),
        _ => return Err(usage().into()),
    };
    Ok((command, product_services))
}

fn usage() -> &'static str {
    "usage: ash-app-server-daemon <connect|connect-selected|start|ensure-selected|restart|stop|version> [--product-services PATH]"
}

/// Resolves the App Server executable managed by this command adapter.
pub fn backend_executable_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(crate::APP_SERVER_PATH_ENV) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(format!(
                "{} must be an absolute path",
                crate::APP_SERVER_PATH_ENV
            ));
        }
        return Ok(path);
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or("daemon executable has no parent directory")?;
    Ok(directory.join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    }))
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;

fn validate_backend_digest(executable: &Path, expected: &str) -> Result<(), String> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("ASH_APP_SERVER_SHA256 must contain 64 lowercase hexadecimal digits".into());
    }
    if !crate::process::executable_identity(executable)?.matches_sha256(expected) {
        return Err("App Server executable does not match its signed package digest".into());
    }
    Ok(())
}
