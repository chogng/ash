use crate::unavailable;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::HostReadScope;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use std::path::Path;
use wxc_common::models::ContainerPolicy;

pub(super) fn request(
    command: &SandboxCommand,
    policy: SandboxPolicy,
    scope: &SandboxScope,
) -> Result<crate::request::Request, SandboxError> {
    validate_paths(command.working_directory(), scope)?;
    let resolved_filesystem = scope.resolve_filesystem(policy.file_system())?;
    let filesystem = with_sensitive_ipc_paths(filesystem_from_resolved(&resolved_filesystem)?);
    let argv = std::iter::once(command.program())
        .chain(command.arguments().iter().map(|arg| arg.as_os_str()))
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(|| unavailable("MXC requires Unicode command arguments"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if argv.iter().any(|arg| arg.contains('\0')) || argv[0].is_empty() {
        return Err(unavailable("invalid command arguments"));
    }
    let context = if cfg!(windows) {
        wxc_common::cmdline::CommandLineContext::WindowsCreateProcess
    } else {
        wxc_common::cmdline::CommandLineContext::PosixShell
    };
    let script = wxc_common::cmdline::cmdline_from_argv_for_context(&argv, context)
        .map_err(|error| unavailable(error.to_string()))?;
    let script = if cfg!(unix) {
        format!("exec {script}")
    } else {
        script
    };
    let action = if policy.network() == NetworkAccess::Allowed {
        "allow"
    } else {
        "deny"
    };
    let mut config = serde_json::json!({
        "version": "0.8.0-alpha",
        "containment": if cfg!(windows) { "processcontainer" } else if cfg!(target_os = "linux") { "bubblewrap" } else { "seatbelt" },
        "process": { "commandLine": script, "cwd": text(command.working_directory())? },
        "lifecycle": { "destroyOnExit": true, "preservePolicy": false },
        "filesystem": {
            "readwritePaths": filesystem.readwrite_paths,
            "readonlyPaths": filesystem.readonly_paths,
            "deniedPaths": filesystem.denied_paths,
        },
        "network": { "egress": { "default": action }, "ingress": { "default": action, "hostLoopback": action } },
        "fallback": { "allowDaclMutation": false },
    });
    match (policy.network(), command.network_proxy()) {
        (NetworkAccess::Managed, Some(proxy)) if proxy.ports()[0] == proxy.ports()[1] => {
            #[cfg(windows)]
            return Err(SandboxError::UnsupportedPolicy(
                "Windows PSEC cannot enforce the requested managed-proxy path while denying unapproved inbound private-network traffic".into(),
            ));
            #[cfg(not(windows))]
            {
                config["runtimeConfig"] = serde_json::json!({"networkProxy": format!("http://127.0.0.1:{}", proxy.ports()[0])});
            }
        }
        (NetworkAccess::Allowed | NetworkAccess::Denied, None) => {}
        _ => {
            return Err(unavailable(
                "managed networking requires one execution-owned HTTP/SOCKS endpoint",
            ));
        }
    }
    #[cfg(windows)]
    {
        config["ui"] =
            serde_json::json!({"disable": false, "clipboard": "none", "injection": false});
        config["processContainer"] = serde_json::json!({
            "capabilities": ["registryRead"],
            "ui": {"isolation": "desktop", "desktopSystemControl": false, "systemSettings": "none", "ime": false}
        });
    }
    let mut logger = wxc_common::logger::Logger::new(wxc_common::logger::Mode::Buffer);
    let parsed =
        wxc_common::config_parser::load_mxc_request_from_json(&config.to_string(), &mut logger)
            .map_err(|error| {
                use wxc_common::config_parser::ParseError;
                match error {
                    ParseError::Decode(error)
                    | ParseError::Version(error)
                    | ParseError::OneShot(error)
                    | ParseError::OneShotMalformed(error) => unavailable(error.to_string()),
                    ParseError::StateAware(error) => unavailable(error.to_string()),
                }
            })?;
    let wxc_common::state_aware_request::MxcRequest::OneShot(inner) = parsed else {
        return Err(unavailable("expected a process execution request"));
    };
    let mut request = crate::request::Request::new(inner)?;
    if resolved_filesystem.host_read() == HostReadScope::Host {
        #[cfg(windows)]
        let roots = crate::request::host_paths(command.working_directory())?;
        #[cfg(not(windows))]
        let roots = vec!["/".to_owned()];
        for root in roots {
            let files = &mut request.inner.policy;
            if !files.readwrite_paths.contains(&root)
                && !files.readonly_paths.contains(&root)
                && !files.denied_paths.contains(&root)
            {
                if policy.file_system() == FileSystemAccess::FullAccess {
                    files.readwrite_paths.push(root);
                } else {
                    files.readonly_paths.push(root);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    request.set_private_ipc(
        scope
            .private_ipc_dirs()
            .iter()
            .map(|dir| text(dir.canonical_path()))
            .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(request)
}

fn filesystem_from_resolved(
    resolved: &ash_sandboxing::ResolvedFileSystem,
) -> Result<ContainerPolicy, SandboxError> {
    let mut filesystem = ContainerPolicy::default();
    filesystem.readwrite_paths = resolved
        .readwrite_paths()
        .iter()
        .map(|path| text(path))
        .collect::<Result<_, _>>()?;
    filesystem.readonly_paths = resolved
        .readonly_paths()
        .iter()
        .map(|path| text(path))
        .collect::<Result<_, _>>()?;
    filesystem.denied_paths = resolved
        .denied_paths()
        .iter()
        .map(|path| text(path))
        .collect::<Result<_, _>>()?;
    Ok(filesystem)
}

pub(super) fn validate_paths(cwd: &Path, scope: &SandboxScope) -> Result<(), SandboxError> {
    for path in std::iter::once(cwd)
        .chain(
            scope
                .grants()
                .iter()
                .map(|grant| grant.dir().canonical_path()),
        )
        .chain(scope.hidden_dirs().iter().map(|dir| dir.canonical_path()))
    {
        if dunce::canonicalize(path).map_err(|error| unavailable(error.to_string()))? != path {
            return Err(unavailable("sandbox directory changed since preparation"));
        }
    }
    Ok(())
}
fn text(path: &Path) -> Result<String, SandboxError> {
    path.to_str()
        .filter(|value| !value.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| unavailable("MXC requires Unicode filesystem paths without NUL"))
}

#[cfg(unix)]
fn sensitive_ipc_paths() -> Vec<String> {
    let mut paths = vec![
        std::path::PathBuf::from("/var/run/docker.sock"),
        std::path::PathBuf::from("/run/docker.sock"),
    ];
    if let Some(path) = std::env::var_os("SSH_AUTH_SOCK") {
        paths.push(path.into());
    }
    if let Ok(value) = std::env::var("GPG_AGENT_INFO")
        && let Some(path) = value.split(':').next()
        && !path.is_empty()
    {
        paths.push(path.into());
    }
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|path| path.exists())
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect()
}

#[cfg(unix)]
fn with_sensitive_ipc_paths(mut filesystem: ContainerPolicy) -> ContainerPolicy {
    filesystem.denied_paths.extend(sensitive_ipc_paths());
    filesystem
}

#[cfg(not(unix))]
fn with_sensitive_ipc_paths(filesystem: ContainerPolicy) -> ContainerPolicy {
    filesystem
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
