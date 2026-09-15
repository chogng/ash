use crate::unavailable;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::HostAclChanges;
use ash_sandboxing::HostReadScope;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use mxc_sdk::NetworkAction;
use mxc_sdk::NetworkEgressSection;
use mxc_sdk::NetworkIngressSection;
#[cfg(target_os = "windows")]
use mxc_sdk::configs::ProcessContainer;
#[cfg(target_os = "windows")]
use mxc_sdk::configs::ProcessContainerUi;
#[cfg(target_os = "windows")]
use mxc_sdk::configs::ProcessContainerUiIsolation;
#[cfg(target_os = "windows")]
use mxc_sdk::policy::ClipboardPolicy;
#[cfg(target_os = "windows")]
use mxc_sdk::policy::Containment;
use mxc_sdk::policy::FilesystemSection;
use mxc_sdk::policy::HostFilesystemAccess;
use mxc_sdk::policy::NetworkSection;
#[cfg(target_os = "windows")]
use mxc_sdk::policy::UiSection;
use std::path::Path;

pub(super) fn request(
    command: &SandboxCommand,
    policy: SandboxPolicy,
    scope: &SandboxScope,
) -> Result<mxc_sdk::SandboxRequest, SandboxError> {
    validate_paths(command.working_directory(), scope)?;
    let resolved_filesystem = scope.resolve_filesystem(policy.file_system())?;
    let filesystem = with_sensitive_ipc_paths(filesystem_from_resolved(&resolved_filesystem)?);
    let action = if policy.network() == NetworkAccess::Allowed {
        NetworkAction::Allow
    } else {
        NetworkAction::Deny
    };
    let mut egress = NetworkEgressSection::default();
    egress.default = Some(action);
    let mut ingress = NetworkIngressSection::default();
    ingress.default = Some(action);
    ingress.host_loopback = Some(action);
    let mut network = NetworkSection::default();
    network.egress = Some(egress);
    network.ingress = Some(ingress);
    match (policy.network(), command.network_proxy()) {
        (NetworkAccess::Managed, Some(proxy)) if proxy.ports()[0] == proxy.ports()[1] => {
            network = NetworkSection::managed_proxy(
                proxy.ports()[0]
                    .try_into()
                    .map_err(|_| unavailable("proxy port must be nonzero"))?,
            );
        }
        (NetworkAccess::Allowed | NetworkAccess::Denied, None) => {}
        _ => {
            return Err(unavailable(
                "managed networking requires one execution-owned HTTP/SOCKS endpoint",
            ));
        }
    }
    let policy_input = mxc_sdk::SandboxPolicy {
        version: "0.8.0-alpha".into(),
        filesystem: Some(filesystem),
        network: Some(network),
        ui: windows_ui(),
        timeout_ms: None,
    };
    let mut request = build_request(&policy_input)?;
    if resolved_filesystem.host_read() == HostReadScope::Host {
        request
            .set_host_filesystem(if policy.file_system() == FileSystemAccess::FullAccess {
                HostFilesystemAccess::ReadWrite
            } else {
                HostFilesystemAccess::ReadOnly
            })
            .map_err(|error| unavailable(error.to_string()))?;
    }
    #[cfg(target_os = "windows")]
    request.require_process_security_environment();
    match policy.host_acl_changes() {
        HostAclChanges::Denied => {
            request.forbid_host_acl_changes();
        }
        HostAclChanges::Scoped | HostAclChanges::ScopedWithTraversal => {
            let roots = scope
                .grants()
                .iter()
                .map(|grant| grant.dir().canonical_path().to_owned())
                .chain(
                    scope
                        .hidden_dirs()
                        .iter()
                        .map(|dir| dir.canonical_path().to_owned()),
                )
                .collect::<Vec<_>>();
            request
                .permit_host_acl_changes(&roots)
                .map_err(|error| unavailable(error.to_string()))?;
        }
    }
    #[cfg(target_os = "macos")]
    request.restrict_seatbelt_unix_sockets(
        scope
            .private_ipc_dirs()
            .iter()
            .map(|dir| text(dir.canonical_path()))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let argv = std::iter::once(command.program())
        .chain(command.arguments().iter().map(|arg| arg.as_os_str()))
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(|| unavailable("MXC requires Unicode command arguments"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    request
        .set_command(&argv)
        .map_err(|error| unavailable(error.to_string()))?;
    request.set_working_directory(text(command.working_directory())?);
    Ok(request)
}

#[cfg(target_os = "windows")]
fn windows_ui() -> Option<UiSection> {
    Some(UiSection {
        allow_windows: true,
        clipboard: ClipboardPolicy::None,
        allow_input_injection: false,
    })
}

#[cfg(not(target_os = "windows"))]
fn windows_ui() -> Option<mxc_sdk::policy::UiSection> {
    None
}

#[cfg(target_os = "windows")]
fn build_request(policy: &mxc_sdk::SandboxPolicy) -> Result<mxc_sdk::SandboxRequest, SandboxError> {
    let containment = Containment::ProcessContainer(windows_process_container());
    mxc_sdk::build_request_with_containment(policy, &containment, None)
        .map_err(|error| unavailable(error.to_string()))
}

#[cfg(target_os = "windows")]
fn windows_process_container() -> ProcessContainer {
    let ui = ProcessContainerUi::default().with_isolation(ProcessContainerUiIsolation::Desktop);
    ProcessContainer::default().with_ui(ui)
}

#[cfg(not(target_os = "windows"))]
fn build_request(policy: &mxc_sdk::SandboxPolicy) -> Result<mxc_sdk::SandboxRequest, SandboxError> {
    mxc_sdk::build_request(policy, None).map_err(|error| unavailable(error.to_string()))
}

fn filesystem_from_resolved(
    resolved: &ash_sandboxing::ResolvedFileSystem,
) -> Result<FilesystemSection, SandboxError> {
    let mut filesystem = FilesystemSection::default();
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
    filesystem.clear_policy_on_exit = Some(true);
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
fn with_sensitive_ipc_paths(mut filesystem: FilesystemSection) -> FilesystemSection {
    filesystem.denied_paths.extend(sensitive_ipc_paths());
    filesystem
}

#[cfg(not(unix))]
fn with_sensitive_ipc_paths(filesystem: FilesystemSection) -> FilesystemSection {
    filesystem
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
