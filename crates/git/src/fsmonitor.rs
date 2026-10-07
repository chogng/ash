use std::ffi::OsString;

use crate::GitClient;
use crate::GitRepository;
use crate::client::FsmonitorOverride;

pub(crate) async fn detect_fsmonitor_override(
    client: &GitClient,
    repository: &GitRepository,
) -> FsmonitorOverride {
    let Ok(config) = client
        .run_configuration_probe(
            repository.worktree_root(),
            ["config", "--null", "--get", "core.fsmonitor"],
        )
        .await
    else {
        return FsmonitorOverride::Disabled;
    };
    if !config.status.success() {
        return FsmonitorOverride::Disabled;
    }
    let Some(config) = parse_single_null_value(&config.stdout) else {
        return FsmonitorOverride::Disabled;
    };
    let configured = match parse_known_git_bool(config) {
        Some(configured) => configured,
        None => {
            let args = [
                OsString::from("config"),
                OsString::from("--null"),
                OsString::from("--type=bool"),
                OsString::from("--fixed-value"),
                OsString::from("--get"),
                OsString::from("core.fsmonitor"),
                OsString::from(config),
            ];
            matches!(
                client
                    .run_configuration_probe(repository.worktree_root(), args)
                    .await,
                Ok(output) if output.status.success() && output.stdout == b"true\0"
            )
        }
    };
    if !configured {
        return FsmonitorOverride::Disabled;
    }

    let Ok(build_options) = client
        .run_configuration_probe(repository.worktree_root(), ["version", "--build-options"])
        .await
    else {
        return FsmonitorOverride::Disabled;
    };
    if !build_options.status.success() {
        return FsmonitorOverride::Disabled;
    }
    if build_options
        .stdout
        .split(|byte| *byte == b'\n')
        .any(|line| trim_ascii(line) == b"feature: fsmonitor--daemon")
    {
        FsmonitorOverride::BuiltIn
    } else {
        FsmonitorOverride::Disabled
    }
}

fn parse_single_null_value(bytes: &[u8]) -> Option<&str> {
    let value = bytes.strip_suffix(b"\0")?;
    if value.contains(&0) {
        return None;
    }
    std::str::from_utf8(value).ok()
}

fn parse_known_git_bool(value: &str) -> Option<bool> {
    if ["true", "yes", "on"]
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return Some(true);
    }
    if ["false", "no", "off"]
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
    {
        return Some(false);
    }
    None
}

fn trim_ascii(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

#[cfg(test)]
#[path = "fsmonitor_tests.rs"]
mod tests;
