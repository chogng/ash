use crate::unavailable;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::HostReadScope;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use mxc_sdk::mxc_common::models::ContainerPolicy;
use mxc_sdk::mxc_contract::published::v1_0_0 as contract;
use mxc_sdk::mxc_contract::published::v1_0_0::OptionalField;
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
        mxc_sdk::mxc_common::cmdline::CommandLineContext::WindowsCreateProcess
    } else {
        mxc_sdk::mxc_common::cmdline::CommandLineContext::PosixShell
    };
    let script = mxc_sdk::mxc_common::cmdline::cmdline_from_argv_for_context(&argv, context)
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
    let inner = sdk_request(
        script,
        text(command.working_directory())?,
        filesystem,
        policy.network(),
        proxy_port,
    )?;
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
    {
        // The host-read root adds a later read-only Seatbelt rule. Preserve the
        // baseline's exact character-device grants beneath that broad rule.
        for device in ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"] {
            if !request
                .inner
                .policy
                .readwrite_paths
                .iter()
                .any(|path| path == device)
            {
                request.inner.policy.readwrite_paths.push(device.to_owned());
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

pub(super) fn sdk_request(
    script: String,
    cwd: String,
    filesystem: ContainerPolicy,
    network: NetworkAccess,
    proxy_port: Option<u16>,
) -> Result<mxc_sdk::mxc_common::models::ExecutionRequest, SandboxError> {
    #[cfg(windows)]
    if network == NetworkAccess::Managed {
        return Err(SandboxError::UnsupportedPolicy(
            "Windows PSEC cannot enforce the requested managed-proxy path while denying unapproved inbound private-network traffic".into(),
        ));
    }
    let runtime_config = match (network, proxy_port) {
        (NetworkAccess::Managed, Some(port)) => OptionalField::present(contract::RuntimeConfig {
            network_proxy: OptionalField::present(format!("http://127.0.0.1:{}", port)),
        }),
        (NetworkAccess::Allowed | NetworkAccess::Denied, None) => OptionalField::default(),
        _ => {
            return Err(unavailable(
                "managed networking requires one execution-owned HTTP/SOCKS endpoint",
            ));
        }
    };
    let action = || match network {
        NetworkAccess::Allowed => contract::NetworkAction::Allow,
        NetworkAccess::Denied | NetworkAccess::Managed => contract::NetworkAction::Deny,
    };
    #[cfg(windows)]
    let (ui, process_container) = (
        OptionalField::present(contract::Ui {
            disable: OptionalField::present(false),
            clipboard: OptionalField::present(contract::UiClipboard::None),
            injection: OptionalField::present(false),
        }),
        OptionalField::present(contract::ProcessContainer {
            least_privilege: OptionalField::default(),
            learning_mode: OptionalField::default(),
            capabilities: OptionalField::present(vec![
                contract::ProcessContainerCapability::new("registryRead".into())
                    .map_err(unavailable)?,
            ]),
            capture_denials: OptionalField::default(),
            ui: OptionalField::present(contract::ProcessContainerUi {
                isolation: OptionalField::present(contract::ProcessContainerUiIsolation::Desktop),
                desktop_system_control: OptionalField::present(false),
                system_settings: OptionalField::present("none".into()),
                ime: OptionalField::present(false),
            }),
            filesystem: OptionalField::default(),
            network: OptionalField::default(),
        }),
    );
    #[cfg(not(windows))]
    let (ui, process_container) = (OptionalField::default(), OptionalField::default());
    let config = contract::OneShotRequest {
        schema: OptionalField::default(),
        comment: OptionalField::default(),
        version: contract::Version::V1_0_0,
        container_id: OptionalField::default(),
        containment: OptionalField::present(if cfg!(windows) {
            contract::OneShotContainment::ProcessContainer
        } else if cfg!(target_os = "linux") {
            contract::OneShotContainment::Bubblewrap
        } else {
            contract::OneShotContainment::Seatbelt
        }),
        process: contract::Process {
            command_line: contract::NonEmptyString::new(script).map_err(unavailable)?,
            cwd: OptionalField::present(cwd),
            env: OptionalField::default(),
            inherit_default_env: OptionalField::present(false),
            timeout: OptionalField::default(),
        },
        lifecycle: OptionalField::present(contract::Lifecycle {
            destroy_on_exit: OptionalField::present(true),
            preserve_policy: OptionalField::present(false),
        }),
        filesystem: OptionalField::present(contract::Filesystem {
            readwrite_paths: OptionalField::present(filesystem.readwrite_paths),
            readonly_paths: OptionalField::present(filesystem.readonly_paths),
            denied_paths: OptionalField::present(filesystem.denied_paths),
        }),
        network: OptionalField::present(contract::Network {
            egress: OptionalField::present(contract::NetworkEgress {
                default: OptionalField::present(action()),
                allow: OptionalField::default(),
                deny: OptionalField::default(),
            }),
            ingress: OptionalField::present(contract::NetworkIngress {
                default: OptionalField::present(action()),
                host_loopback: OptionalField::present(action()),
            }),
        }),
        // Ash selects the isolation model before launch. The SDK may not
        // authorize host ACL changes or choose a different implementation.
        fallback: OptionalField::present(contract::Fallback {
            allow_dacl_mutation: OptionalField::present(false),
        }),
        runtime_config,
        ui,
        process_container,
        seatbelt: OptionalField::default(),
        lxc: OptionalField::default(),
        wslc: OptionalField::default(),
        telemetry: OptionalField::default(),
    };
    let mut logger =
        mxc_sdk::mxc_common::logger::Logger::new(mxc_sdk::mxc_common::logger::Mode::Buffer);
    let inner = mxc_sdk::mxc_common::config_parser::load_one_shot_request_from_contract(
        mxc_sdk::mxc_common::config_parser::ExactOneShotContract::V1_0(Box::new(config)),
        &mut logger,
    )
    .map_err(|error| unavailable(error.to_string()))?;
    Ok(inner)
}
