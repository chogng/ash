use std::num::NonZeroU64;
use std::path::PathBuf;

use crate::RemoteConnectionProfileRecord;
use crate::RemoteConnectionProfileStore;
use crate::RemoteRuntimeArtifact;
use crate::RemoteRuntimeArtifactIntegrity;
use crate::RemoteRuntimeCatalogRelease;
use crate::RemoteRuntimeDownloadCache;
use crate::RemoteRuntimeInstallRoot;
use crate::RemoteRuntimeVersion;
use crate::SshAppServerConnectionOptions;
use crate::SshRemoteRuntimeInstaller;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_remote::RemoteDirPath;
use ash_remote::RemotePlatform;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use serde::Serialize;

#[path = "command/connections.rs"]
mod connections_command;
#[path = "command/fetch.rs"]
mod fetch_command;
#[path = "command/install.rs"]
mod install_command;

use connections_command::RemoteConnectionsCommand;

const PROBE_USAGE: &str = "usage: ash-remote probe --host <ssh-host> [--ssh <openssh-path>]";
const INSTALL_USAGE: &str = concat!(
    "usage: ash-remote install --host <ssh-host> --archive <ash-package.tar.gz> ",
    "--version <version> --target <target> --archive-size <bytes> ",
    "--unpacked-size <bytes> --sha256 <digest> [--ssh <openssh-path>] ",
    "[--install-root <absolute-remote-path>] [--progress json-lines]"
);
const FETCH_USAGE: &str = concat!(
    "usage: ash-remote fetch-runtime --catalog-url <https-catalog.json> ",
    "--catalog-sha256 <digest> --target <target> --cache-root <absolute-local-path> ",
    "[--progress json-lines]"
);
const PROFILE_GET_USAGE: &str =
    "usage: ash-remote profile get --host <ssh-host> --dir <absolute-remote-path>";
const PROFILE_ACTIVATE_USAGE: &str = concat!(
    "usage: ash-remote profile activate --host <ssh-host> ",
    "--dir <absolute-remote-path> --runtime <verified-remote-runtime>"
);
const PROFILE_ROLLBACK_USAGE: &str = concat!(
    "usage: ash-remote profile rollback --host <ssh-host> ",
    "--dir <absolute-remote-path> [--ssh <openssh-path>]"
);

/// Runs local Remote management commands without depending on a product CLI.
pub fn run_command(arguments: Vec<String>) -> Result<(), String> {
    match parse(arguments)? {
        RemoteCommand::Probe(options) => {
            let mut installer = SshRemoteRuntimeInstaller::new(options.host);
            if let Some(ssh_executable) = options.ssh_executable {
                installer = installer.with_ssh_executable(ssh_executable);
            }
            let platform = installer
                .probe_platform()
                .map_err(|error| error.to_string())?;
            println!("{}", platform.target_triple());
            Ok(())
        }
        RemoteCommand::Fetch(options) => fetch_command::run(options),
        RemoteCommand::Install(options) => install_command::run(options),
        RemoteCommand::Profile(command) => run_profile(command),
        RemoteCommand::Connections(command) => connections_command::run(command),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RemoteCommand {
    Probe(RemoteProbeOptions),
    Fetch(RemoteFetchOptions),
    Install(RemoteInstallOptions),
    Profile(RemoteProfileCommand),
    Connections(RemoteConnectionsCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteProfileCommand {
    Get(RemoteProfileTargetOptions),
    Activate(RemoteProfileActivateOptions),
    Rollback(RemoteProfileRollbackOptions),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteProfileTargetOptions {
    pub(crate) target: SshTarget,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteProfileActivateOptions {
    pub(crate) profile: RemoteProfile,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteProfileRollbackOptions {
    pub(crate) target: SshTarget,
    pub(crate) ssh_executable: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteProbeOptions {
    pub(crate) host: SshHost,
    pub(crate) ssh_executable: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteFetchOptions {
    pub(crate) release: RemoteRuntimeCatalogRelease,
    pub(crate) cache: RemoteRuntimeDownloadCache,
    pub(crate) platform: RemotePlatform,
    pub(crate) progress: RemoteFetchProgressFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoteFetchProgressFormat {
    ArtifactOnly,
    JsonLines,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteInstallOptions {
    pub(crate) host: SshHost,
    pub(crate) ssh_executable: Option<PathBuf>,
    pub(crate) install_root: Option<RemoteRuntimeInstallRoot>,
    pub(crate) artifact: RemoteRuntimeArtifact,
    pub(crate) progress: RemoteInstallProgressFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoteInstallProgressFormat {
    ExecutableOnly,
    JsonLines,
}

fn parse(arguments: Vec<String>) -> Result<RemoteCommand, String> {
    let Some((command, arguments)) = arguments.split_first() else {
        return Err(remote_usage());
    };
    match command.as_str() {
        "probe" => parse_probe(arguments),
        "fetch-runtime" => parse_fetch(arguments),
        "install" => parse_install(arguments),
        "profile" => parse_profile(arguments),
        "connections" => connections_command::parse(arguments).map(RemoteCommand::Connections),
        _ => Err(format!(
            "unknown remote command: {command}\n\n{}",
            remote_usage()
        )),
    }
}

fn parse_fetch(arguments: &[String]) -> Result<RemoteCommand, String> {
    let mut catalog_url = None;
    let mut catalog_sha256 = None;
    let mut platform = None;
    let mut cache_root = None;
    let mut progress = None;
    parse_options(arguments, |name, value| match name {
        "--catalog-url" => assign_once(&mut catalog_url, value.to_owned(), name),
        "--catalog-sha256" => assign_once(&mut catalog_sha256, value.to_owned(), name),
        "--target" => assign_once(
            &mut platform,
            RemotePlatform::from_target_triple(value)
                .ok_or_else(|| format!("unsupported POSIX Remote target: {value}"))?,
            name,
        ),
        "--cache-root" => assign_once(&mut cache_root, PathBuf::from(value), name),
        "--progress" => assign_once(
            &mut progress,
            match value {
                "json-lines" => RemoteFetchProgressFormat::JsonLines,
                _ => return Err("--progress supports only `json-lines`".into()),
            },
            name,
        ),
        _ => Err(format!(
            "unknown remote fetch-runtime option: {name}\n\n{FETCH_USAGE}"
        )),
    })?;
    let release = RemoteRuntimeCatalogRelease::new(
        catalog_url.ok_or_else(|| required_for("--catalog-url", FETCH_USAGE))?,
        catalog_sha256.ok_or_else(|| required_for("--catalog-sha256", FETCH_USAGE))?,
    )
    .map_err(string_error)?;
    let cache = RemoteRuntimeDownloadCache::new(
        cache_root.ok_or_else(|| required_for("--cache-root", FETCH_USAGE))?,
    )
    .map_err(string_error)?;
    Ok(RemoteCommand::Fetch(RemoteFetchOptions {
        release,
        cache,
        platform: platform.ok_or_else(|| required_for("--target", FETCH_USAGE))?,
        progress: progress.unwrap_or(RemoteFetchProgressFormat::ArtifactOnly),
    }))
}

fn parse_profile(arguments: &[String]) -> Result<RemoteCommand, String> {
    let Some((command, arguments)) = arguments.split_first() else {
        return Err(profile_usage());
    };
    let command = match command.as_str() {
        "get" => RemoteProfileCommand::Get(parse_profile_target(arguments, PROFILE_GET_USAGE)?),
        "activate" => RemoteProfileCommand::Activate(parse_profile_activation(arguments)?),
        "rollback" => RemoteProfileCommand::Rollback(parse_profile_rollback(arguments)?),
        _ => {
            return Err(format!(
                "unknown remote profile command: {command}\n\n{}",
                profile_usage()
            ));
        }
    };
    Ok(RemoteCommand::Profile(command))
}

fn parse_profile_rollback(arguments: &[String]) -> Result<RemoteProfileRollbackOptions, String> {
    let mut host = None;
    let mut dir = None;
    let mut ssh_executable = None;
    parse_options(arguments, |name, value| match name {
        "--host" => assign_once(
            &mut host,
            SshHost::parse(value).map_err(string_error)?,
            name,
        ),
        "--dir" => assign_once(
            &mut dir,
            RemoteDirPath::parse(value).map_err(string_error)?,
            name,
        ),
        "--ssh" => assign_once(&mut ssh_executable, PathBuf::from(value), name),
        _ => Err(format!(
            "unknown remote profile rollback option: {name}\n\n{PROFILE_ROLLBACK_USAGE}"
        )),
    })?;
    Ok(RemoteProfileRollbackOptions {
        target: SshTarget::new(
            host.ok_or_else(|| required_for("--host", PROFILE_ROLLBACK_USAGE))?,
            dir.ok_or_else(|| required_for("--dir", PROFILE_ROLLBACK_USAGE))?,
        ),
        ssh_executable,
    })
}

fn parse_profile_target(
    arguments: &[String],
    usage: &'static str,
) -> Result<RemoteProfileTargetOptions, String> {
    let mut host = None;
    let mut dir = None;
    parse_options(arguments, |name, value| match name {
        "--host" => assign_once(
            &mut host,
            SshHost::parse(value).map_err(string_error)?,
            name,
        ),
        "--dir" => assign_once(
            &mut dir,
            RemoteDirPath::parse(value).map_err(string_error)?,
            name,
        ),
        _ => Err(format!("unknown remote profile option: {name}\n\n{usage}")),
    })?;
    Ok(RemoteProfileTargetOptions {
        target: SshTarget::new(
            host.ok_or_else(|| required_for("--host", usage))?,
            dir.ok_or_else(|| required_for("--dir", usage))?,
        ),
    })
}

fn parse_profile_activation(arguments: &[String]) -> Result<RemoteProfileActivateOptions, String> {
    let mut host = None;
    let mut dir = None;
    let mut runtime = None;
    parse_options(arguments, |name, value| match name {
        "--host" => assign_once(
            &mut host,
            SshHost::parse(value).map_err(string_error)?,
            name,
        ),
        "--dir" => assign_once(
            &mut dir,
            RemoteDirPath::parse(value).map_err(string_error)?,
            name,
        ),
        "--runtime" => assign_once(
            &mut runtime,
            RemoteRuntime::new_exact_executable(value).map_err(string_error)?,
            name,
        ),
        _ => Err(format!(
            "unknown remote profile activate option: {name}\n\n{PROFILE_ACTIVATE_USAGE}"
        )),
    })?;
    let target = SshTarget::new(
        host.ok_or_else(|| required_for("--host", PROFILE_ACTIVATE_USAGE))?,
        dir.ok_or_else(|| required_for("--dir", PROFILE_ACTIVATE_USAGE))?,
    );
    Ok(RemoteProfileActivateOptions {
        profile: RemoteProfile::new(
            target,
            runtime.ok_or_else(|| required_for("--runtime", PROFILE_ACTIVATE_USAGE))?,
        ),
    })
}

fn parse_probe(arguments: &[String]) -> Result<RemoteCommand, String> {
    let mut host = None;
    let mut ssh_executable = None;
    parse_options(arguments, |name, value| match name {
        "--host" => assign_once(
            &mut host,
            SshHost::parse(value).map_err(string_error)?,
            name,
        ),
        "--ssh" => assign_once(&mut ssh_executable, PathBuf::from(value), name),
        _ => Err(format!(
            "unknown remote probe option: {name}\n\n{PROBE_USAGE}"
        )),
    })?;
    Ok(RemoteCommand::Probe(RemoteProbeOptions {
        host: host.ok_or_else(|| format!("--host is required\n\n{PROBE_USAGE}"))?,
        ssh_executable,
    }))
}

fn parse_install(arguments: &[String]) -> Result<RemoteCommand, String> {
    let mut host = None;
    let mut ssh_executable = None;
    let mut install_root = None;
    let mut archive = None;
    let mut version = None;
    let mut platform = None;
    let mut archive_size = None;
    let mut unpacked_size = None;
    let mut sha256 = None;
    let mut progress = None;
    parse_options(arguments, |name, value| match name {
        "--host" => assign_once(
            &mut host,
            SshHost::parse(value).map_err(string_error)?,
            name,
        ),
        "--ssh" => assign_once(&mut ssh_executable, PathBuf::from(value), name),
        "--install-root" => assign_once(
            &mut install_root,
            RemoteRuntimeInstallRoot::parse(value).map_err(string_error)?,
            name,
        ),
        "--archive" => assign_once(&mut archive, PathBuf::from(value), name),
        "--version" => assign_once(
            &mut version,
            RemoteRuntimeVersion::parse(value).map_err(string_error)?,
            name,
        ),
        "--target" => assign_once(
            &mut platform,
            RemotePlatform::from_target_triple(value)
                .ok_or_else(|| format!("unsupported POSIX Remote target: {value}"))?,
            name,
        ),
        "--archive-size" => assign_once(&mut archive_size, parse_size(value, name)?, name),
        "--unpacked-size" => assign_once(&mut unpacked_size, parse_size(value, name)?, name),
        "--sha256" => assign_once(&mut sha256, value.to_owned(), name),
        "--progress" => assign_once(
            &mut progress,
            match value {
                "json-lines" => RemoteInstallProgressFormat::JsonLines,
                _ => return Err("--progress supports only `json-lines`".into()),
            },
            name,
        ),
        _ => Err(format!(
            "unknown remote install option: {name}\n\n{INSTALL_USAGE}"
        )),
    })?;
    let integrity = RemoteRuntimeArtifactIntegrity::new(
        archive_size.ok_or_else(|| required("--archive-size"))?,
        unpacked_size.ok_or_else(|| required("--unpacked-size"))?,
        sha256.ok_or_else(|| required("--sha256"))?,
    )
    .map_err(string_error)?;
    let artifact = RemoteRuntimeArtifact::new(
        archive.ok_or_else(|| required("--archive"))?,
        version.ok_or_else(|| required("--version"))?,
        platform.ok_or_else(|| required("--target"))?,
        integrity,
    );
    Ok(RemoteCommand::Install(RemoteInstallOptions {
        host: host.ok_or_else(|| required("--host"))?,
        ssh_executable,
        install_root,
        artifact,
        progress: progress.unwrap_or(RemoteInstallProgressFormat::ExecutableOnly),
    }))
}

fn parse_options(
    arguments: &[String],
    mut parse: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let mut index = 0;
    while index < arguments.len() {
        let name = &arguments[index];
        if !name.starts_with("--") {
            return Err(format!("unexpected Remote argument: {name}"));
        }
        index += 1;
        let value = arguments
            .get(index)
            .ok_or_else(|| format!("{name} requires a value"))?;
        parse(name, value)?;
        index += 1;
    }
    Ok(())
}

fn assign_once<T>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        return Err(format!("{name} may be specified only once"));
    }
    Ok(())
}

fn parse_size(value: &str, name: &str) -> Result<NonZeroU64, String> {
    value
        .parse::<u64>()
        .ok()
        .and_then(NonZeroU64::new)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn required(name: &str) -> String {
    format!("{name} is required\n\n{INSTALL_USAGE}")
}

fn required_for(name: &str, usage: &str) -> String {
    format!("{name} is required\n\n{usage}")
}

fn remote_usage() -> String {
    format!(
        "{PROBE_USAGE}\n{FETCH_USAGE}\n{INSTALL_USAGE}\n{}\n{}",
        profile_usage(),
        connections_command::usage()
    )
}

fn profile_usage() -> String {
    format!("{PROFILE_GET_USAGE}\n{PROFILE_ACTIVATE_USAGE}\n{PROFILE_ROLLBACK_USAGE}")
}

fn run_profile(command: RemoteProfileCommand) -> Result<(), String> {
    let store = RemoteConnectionProfileStore::from_profile_root(
        ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
    );
    let record = match command {
        RemoteProfileCommand::Get(options) => store
            .connection(&options.target)
            .map_err(|error| error.to_string())?,
        RemoteProfileCommand::Activate(options) => Some(
            store
                .activate(&options.profile)
                .map_err(|error| error.to_string())?,
        ),
        RemoteProfileCommand::Rollback(options) => Some(rollback_profile(&store, options)?),
    };
    println!(
        "{}",
        serde_json::to_string(&record.as_ref().map(RemoteProfileOutput::from))
            .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn rollback_profile(
    store: &RemoteConnectionProfileStore,
    options: RemoteProfileRollbackOptions,
) -> Result<RemoteConnectionProfileRecord, String> {
    let stored = store
        .connection(&options.target)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "Remote connection profile has no runtime generation to roll back".to_owned()
        })?;
    let previous = stored
        .previous_profile()
        .ok_or_else(|| "Remote connection profile has no previous runtime generation".to_owned())?;
    let mut connection = SshAppServerConnectionOptions::new(previous.clone());
    if let Some(ssh_executable) = options.ssh_executable.as_deref() {
        connection = connection.with_ssh_executable(ssh_executable);
    }
    let probe = connection
        .probe_runtime()
        .map_err(|error| format!("previous Remote runtime failed its readiness check: {error}"))?;
    let verified = RemoteProfile::new(previous.target().clone(), probe.resolved_runtime().clone());
    let mut compatibility = SshAppServerConnectionOptions::new(verified.clone());
    if let Some(ssh_executable) = options.ssh_executable.as_deref() {
        compatibility = compatibility.with_ssh_executable(ssh_executable);
    }
    compatibility
        .probe_compatibility(
            ClientInfo {
                name: "ash-remote-profile-rollback".into(),
                version: build_info::VERSION.into(),
            },
            ClientCapabilities::default(),
        )
        .map_err(|error| {
            format!("previous Remote runtime failed its compatibility check: {error}")
        })?;
    store
        .rollback_to_verified(&previous, &verified)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "Remote runtime generations changed while rollback was being verified; retry rollback"
                .to_owned()
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProfileOutput {
    active_runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_runtime: Option<String>,
}

impl From<&RemoteConnectionProfileRecord> for RemoteProfileOutput {
    fn from(record: &RemoteConnectionProfileRecord) -> Self {
        Self {
            active_runtime: record.active_runtime().executable().into(),
            previous_runtime: record
                .previous_runtime()
                .map(|runtime| runtime.executable().into()),
        }
    }
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
