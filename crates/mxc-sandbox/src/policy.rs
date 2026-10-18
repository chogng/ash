use crate::unavailable;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::HostReadScope;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use mxc_sdk::v1::FilesystemPolicy;
use std::path::Path;

pub(super) fn request(
    command: &SandboxCommand,
    policy: SandboxPolicy,
    scope: &SandboxScope,
) -> Result<crate::request::Request, SandboxError> {
    validate_paths(command.working_directory(), scope)?;
    #[cfg(target_os = "macos")]
    let resolved_filesystem =
        scope.resolve_filesystem_with_continuous_patterns(policy.file_system())?;
    #[cfg(not(target_os = "macos"))]
    let resolved_filesystem = scope.resolve_filesystem(policy.file_system())?;
    let filesystem = with_sensitive_ipc_paths(
        filesystem_from_resolved(&resolved_filesystem)?,
        command.working_directory(),
    );
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
        mxc_sdk::v1::CommandLineContext::WindowsCreateProcess
    } else {
        mxc_sdk::v1::CommandLineContext::PosixShell
    };
    let script = mxc_sdk::v1::cmdline_from_argv_for_context(&argv, context)
        .map_err(|error| unavailable(error.to_string()))?;
    let script = if cfg!(unix) {
        format!("exec {script}")
    } else {
        script
    };
    let proxy_port = command
        .network_proxy()
        .map(|proxy| {
            if proxy.ports()[0] != proxy.ports()[1] {
                return Err(unavailable(
                    "managed networking requires one execution-owned HTTP/SOCKS endpoint",
                ));
            }
            Ok(proxy.ports()[0])
        })
        .transpose()?;
    let mut request = crate::request::Request::new(
        script,
        text(command.working_directory())?,
        filesystem,
        policy.network(),
        proxy_port,
    )?;
    if resolved_filesystem.host_read() == HostReadScope::Host {
        #[cfg(windows)]
        let roots = crate::request::host_paths(command.working_directory())?;
        #[cfg(not(windows))]
        let roots = vec!["/".to_owned()];
        for root in roots {
            let files = &mut request;
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
    {
        // The host-read root adds a later read-only Seatbelt rule. Preserve the
        // baseline's exact character-device grants beneath that broad rule.
        for device in ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"] {
            if !request.readwrite_paths.iter().any(|path| path == device) {
                request.readwrite_paths.push(device.to_owned());
            }
        }
        request.set_seatbelt_rules(crate::seatbelt::rules(scope, &resolved_filesystem)?);
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
) -> Result<FilesystemPolicy, SandboxError> {
    let mut filesystem = FilesystemPolicy::default();
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
fn sensitive_ipc_candidates(
    cwd: &Path,
    environment: impl Fn(&str) -> Option<std::ffi::OsString>,
    uid: u32,
) -> Vec<std::path::PathBuf> {
    let directory = |key: &str| {
        environment(key)
            .filter(|value| !value.is_empty())
            .map(|value| cwd.join(value))
    };
    let mut paths = vec![
        std::path::PathBuf::from("/var/run/docker.sock"),
        std::path::PathBuf::from("/run/docker.sock"),
    ];
    if let Some(path) = directory("SSH_AUTH_SOCK") {
        paths.push(path);
    }
    if let Some(value) = environment("GPG_AGENT_INFO")
        && let Some(path) = value.to_str().and_then(|value| value.split(':').next())
        && !path.is_empty()
    {
        paths.push(cwd.join(path));
    }
    // GnuPG 2.1+ ignores GPG_AGENT_INFO. Protect both the default home and an
    // explicitly configured home without denying ordinary public-key files.
    let gpg_homes = directory("HOME")
        .map(|home| home.join(".gnupg"))
        .into_iter()
        .chain(directory("GNUPGHOME"));
    for home in gpg_homes {
        for name in [
            "S.gpg-agent",
            "S.gpg-agent.extra",
            "S.gpg-agent.browser",
            "S.gpg-agent.ssh",
        ] {
            paths.push(home.join(name));
        }
    }
    // Runtime gnupg directories contain IPC endpoints, including hashed
    // custom-home subdirectories. Never deny the surrounding user runtime dir.
    if let Some(runtime) = environment("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_absolute())
    {
        paths.push(runtime.join("gnupg"));
    }
    for runtime in ["/run/user", "/var/run/user"] {
        paths.push(
            std::path::PathBuf::from(runtime)
                .join(uid.to_string())
                .join("gnupg"),
        );
    }
    paths
}

#[cfg(unix)]
pub(super) fn sensitive_ipc_paths(
    cwd: &Path,
    environment: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<String> {
    let mut paths = sensitive_ipc_candidates(cwd, environment, rustix::process::geteuid().as_raw())
        .into_iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(unix)]
fn with_sensitive_ipc_paths(mut filesystem: FilesystemPolicy, cwd: &Path) -> FilesystemPolicy {
    filesystem
        .denied_paths
        .extend(sensitive_ipc_paths(cwd, |key| std::env::var_os(key)));
    filesystem
}

#[cfg(not(unix))]
fn with_sensitive_ipc_paths(filesystem: FilesystemPolicy, _: &Path) -> FilesystemPolicy {
    filesystem
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;

pub(super) fn sdk_request(
    request: &crate::request::Request,
) -> Result<mxc_sdk::v1::ContainerRequest, SandboxError> {
    use mxc_sdk::v1::ContainerRequest;
    use mxc_sdk::v1::NetworkAction;
    use mxc_sdk::v1::NetworkEgressPolicy;
    use mxc_sdk::v1::NetworkIngressPolicy;
    use mxc_sdk::v1::NetworkPolicy;
    use mxc_sdk::v1::NetworkRuntimeConfig;
    let (action, proxy_port): (NetworkAction, Option<u16>) = match request.network {
        crate::request::Network::Allowed => (NetworkAction::Allow, None),
        crate::request::Network::Denied => (NetworkAction::Deny, None),
        #[cfg(not(windows))]
        crate::request::Network::Managed(port) => (NetworkAction::Deny, Some(port.get())),
    };
    let mut sdk = ContainerRequest::new(request.command_line.clone());
    sdk.working_directory = Some(request.cwd.clone());
    sdk.environment = request
        .environment
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    entry
                        .split_once('=')
                        .map(|(key, value)| (key.to_owned(), value.to_owned()))
                        .ok_or_else(|| unavailable("invalid workload environment entry"))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    sdk.inherit_default_environment = Some(false);
    sdk.timeout_ms = Some(0);
    sdk.filesystem = Some(FilesystemPolicy {
        readwrite_paths: request.readwrite_paths.clone(),
        readonly_paths: request.readonly_paths.clone(),
        denied_paths: request.denied_paths.clone(),
        clear_policy_on_exit: Some(true),
    });
    sdk.network = Some(NetworkPolicy {
        egress: Some(NetworkEgressPolicy {
            default: Some(action),
            ..Default::default()
        }),
        ingress: Some(NetworkIngressPolicy {
            default: Some(action),
            host_loopback: Some(action),
        }),
        runtime_config: proxy_port.map(|port| NetworkRuntimeConfig {
            network_proxy: Some(format!("http://127.0.0.1:{port}")),
        }),
    });
    #[cfg(windows)]
    {
        use mxc_sdk::v1::configs::ProcessContainerConfig;
        use mxc_sdk::v1::configs::ProcessContainerUi;
        use mxc_sdk::v1::configs::ProcessContainerUiIsolation;
        let mut process_container = ProcessContainerConfig::default();
        process_container.capabilities = vec!["registryRead".into()];
        let mut ui = ProcessContainerUi::default();
        ui.isolation = ProcessContainerUiIsolation::Desktop;
        process_container.ui = Some(ui);
        sdk.containment = mxc_sdk::v1::Containment::ProcessContainer(process_container);
        let mut ui = mxc_sdk::v1::UiPolicy::default();
        ui.disable = false;
        sdk.ui = Some(ui);
    }
    Ok(sdk)
}

#[cfg(windows)]
pub(super) fn unsupported_managed_network() -> SandboxError {
    SandboxError::UnsupportedPolicy(
        "Windows PSEC cannot enforce the requested managed-proxy path while denying unapproved inbound private-network traffic".into(),
    )
}
