use std::path::Path;
use std::path::PathBuf;

use crate::ConnectionOptions;
use crate::GrantSource;
use crate::LifecycleCommand;
use crate::process::PackageDigest;
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
    if matches!(
        arguments.first().map(String::as_str),
        Some("diagnostic-target" | "profile-process")
    ) {
        let profile = ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?;
        let target = crate::client::diagnostic_target(&profile)?;
        return match arguments.as_slice() {
            [command] if command == "diagnostic-target" => {
                println!(
                    "{}",
                    serde_json::json!({ "pid": target.pid, "instanceId": target.instance_id })
                );
                Ok(())
            }
            [command, profiler, output] if command == "profile-process" => {
                crate::profiling::record(&target, Path::new(profiler), Path::new(output))
            }
            _ => Err(usage().into()),
        };
    }
    if let [command, generation_file] = arguments.as_slice()
        && command == "lease-development"
    {
        return crate::development::hold_runtime_lease(Path::new(generation_file));
    }
    if let [command, profile_flag, profile, electron_flag, electron] = arguments.as_slice()
        && command == "prepare-desktop"
        && profile_flag == "--profile"
        && electron_flag == "--electron"
    {
        if !Path::new(electron).is_absolute() {
            return Err("Desktop must provide an absolute Electron executable".into());
        }
        return crate::installation::prepare_desktop_backend(
            Path::new(profile),
            backend_executable,
            Path::new(electron),
        );
    }
    let (command, product_services) = parse(&arguments)?;
    let _trace = crate::startup_trace::StartupTrace::enter(
        crate::startup_trace::StartupTrace::from_environment(),
    );
    let expected_digest = match std::env::var("ASH_APP_SERVER_SHA256") {
        Ok(expected) => Some(expected),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("ASH_APP_SERVER_SHA256 must contain a SHA-256 digest".into()),
    };
    // Connection commands verify the package at the point where they select its executable.
    let package_digest = expected_digest
        .as_deref()
        .map(PackageDigest::parse)
        .transpose()?
        .unwrap_or(PackageDigest::NotProvided);
    if !matches!(command, Command::Connect | Command::ConnectSelected) {
        package_digest.verify(backend_executable)?;
    }
    let grant_source = match std::env::var("ASH_DIR_GRANT_SOURCE").as_deref() {
        Ok("userConfig") => GrantSource::UserConfig,
        Ok("hostConfiguration") | Err(std::env::VarError::NotPresent) => {
            GrantSource::HostConfiguration
        }
        _ => return Err("ASH_DIR_GRANT_SOURCE must be userConfig or hostConfiguration".into()),
    };
    let role = match std::env::var("ASH_APP_SERVER_CONNECTION_ROLE").as_deref() {
        Ok("agents") => crate::ConnectionRole::Agents,
        Ok("credentials") => crate::ConnectionRole::Credentials,
        Ok("credentials-codex") => crate::ConnectionRole::CredentialsCodex,
        Err(std::env::VarError::NotPresent) => crate::ConnectionRole::Workbench,
        _ => {
            return Err(
                "ASH_APP_SERVER_CONNECTION_ROLE must be agents, credentials, or credentials-codex when set".into(),
            );
        }
    };
    let mut options = ConnectionOptions::new(
        ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
        std::env::var_os("ASH_WORKSPACE_ROOT").map(PathBuf::from),
        grant_source,
        product_services.or_else(discovered_product_services_path),
    )
    .with_role(role);
    let host = optional_environment("ASH_REMOTE_HOST")?;
    let root = optional_environment("ASH_REMOTE_ROOT")?;
    let runtime = optional_environment("ASH_REMOTE_RUNTIME")?;
    match (host, root, runtime) {
        (None, None, None) => {}
        (Some(host), root, Some(runtime)) => {
            options = options.with_ssh(crate::SshConnectionOptions::new(
                &host,
                root.as_deref(),
                &runtime,
            )?)?;
        }
        _ => return Err("SSH connection requires ASH_REMOTE_HOST and ASH_REMOTE_RUNTIME".into()),
    }
    match command {
        Command::Connect => {
            crate::client::connect_with_digest(options, backend_executable, package_digest)
                .map_err(Into::into)
        }
        Command::ConnectSelected => {
            crate::client::connect_selected_with_digest(options, backend_executable, package_digest)
                .map_err(Into::into)
        }
        Command::Update => {
            let output = crate::update::install_stable(options.profile_root(), backend_executable)?;
            println!(
                "{}",
                serde_json::to_string(&output).map_err(|error| error.to_string())?
            );
            Ok(())
        }
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

fn optional_environment(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be UTF-8")),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Connect,
    ConnectSelected,
    Update,
    Lifecycle(LifecycleCommand),
}

fn parse(arguments: &[String]) -> Result<(Command, Option<PathBuf>), String> {
    let Some((command, remaining)) = arguments.split_first() else {
        return Err(usage().into());
    };
    let command = match command.as_str() {
        "connect" => Command::Connect,
        "connect-selected" => Command::ConnectSelected,
        "update" => Command::Update,
        "start" => Command::Lifecycle(LifecycleCommand::Start),
        "ensure-selected" => Command::Lifecycle(LifecycleCommand::EnsureSelected),
        "restart" => Command::Lifecycle(LifecycleCommand::Restart),
        "restart-selected" => Command::Lifecycle(LifecycleCommand::RestartSelected),
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
    "usage: ash-app-server-daemon <connect|connect-selected|update|start|ensure-selected|restart|restart-selected|stop|version|diagnostic-target> [--product-services PATH]\n       ash-app-server-daemon profile-process <profiler> <output>"
}

/// Runs the daemon executable's command, selecting the bundled backend for Setup.
pub fn run_installed_command(arguments: Vec<String>) -> Result<(), String> {
    // Setup owns the adjacent package. A development override inherited from
    // the launching shell must not select a different profile backend.
    let executable = if arguments
        .first()
        .is_some_and(|command| command == "prepare-desktop")
    {
        bundled_backend_executable_path()?
    } else {
        backend_executable_path()?
    };
    run_command(arguments, &executable)
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
    bundled_backend_executable_path()
}

fn bundled_backend_executable_path() -> Result<PathBuf, String> {
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
