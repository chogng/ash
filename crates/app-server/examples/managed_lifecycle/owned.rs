//! Real product executable launcher with synthetic port-owning extension processes.

use ash_external_ext::ExtensionHostLauncher;
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

const DIRECTORY_ENV: &str = "ASH_TEST_MANAGED_OWNED_PROCESSES";
const ROLE: &str = "--test-owned-port";

pub(super) fn dispatch(arguments: &[String]) -> Option<Result<(), String>> {
    if arguments.first().map(String::as_str) != Some(ROLE) {
        return None;
    }
    Some(run_port(arguments.get(1).map(String::as_str)))
}

pub(super) fn spawn() -> Result<Option<Arc<dyn ash_external_ext::ExtensionHostProcess>>, String> {
    let Some(directory) = std::env::var_os(DIRECTORY_ENV) else {
        return Ok(None);
    };
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = PathBuf::from(directory);
    let command = ash_external_ext::ExtensionLaunchCommand::new(
        &executable,
        [ROLE, "leader"],
        &directory,
        BTreeMap::from([(DIRECTORY_ENV.into(), directory.as_os_str().to_owned())]),
    )
    .map_err(|error| error.to_string())?;
    let limits = ash_external_ext::ExtensionHostLimits {
        isolation: ash_external_ext::ProcessIsolationPolicy::AuthorizedProduct,
        ..Default::default()
    };
    ash_external_ext::ProductExecutableLauncher::new(executable)
        .and_then(|launcher| launcher.spawn(&command, &limits))
        .map(Some)
        .map_err(|error| error.to_string())
}

fn run_port(role: Option<&str>) -> Result<(), String> {
    let name = match role {
        Some("leader") => "leader",
        Some("descendant") => "descendant",
        _ => return Err("invalid owned-port test role".into()),
    };
    let directory =
        PathBuf::from(std::env::var_os(DIRECTORY_ENV).ok_or("missing fixture directory")?);
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let temporary = directory.join(format!("{name}.tmp"));
    std::fs::write(
        &temporary,
        format!("{} {}", std::process::id(), listener.local_addr().unwrap()),
    )
    .and_then(|_| std::fs::rename(temporary, directory.join(name)))
    .map_err(|error| error.to_string())?;
    if name == "leader" {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args([ROLE, "descendant"]);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let _child = command.spawn().map_err(|error| error.to_string())?;
    }
    loop {
        std::thread::park();
    }
}
