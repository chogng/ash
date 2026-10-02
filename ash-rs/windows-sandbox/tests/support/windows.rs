use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxPolicy;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::ExecutionLimits;
use std::time::Duration;
use windows_sandbox::WindowsSandbox;

pub(super) struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

pub(super) fn executor(dir: &Dir, timeout: Duration) -> CommandExecutor<Approved, WindowsSandbox> {
    let backend = WindowsSandbox::new(ash_install_context::InstallContext::current());
    assert_eq!(
        backend.kind(),
        SandboxKind::Restricted,
        "the adapter must prepare restricted execution"
    );
    assert!(backend.requires_shared_network_proxy());
    CommandExecutor::new(
        dir.clone(),
        backend,
        Approved,
        ExecutionLimits {
            timeout,
            max_output_bytes: 64 * 1024,
        },
    )
}

pub(super) fn sandbox_policy(files: FileSystemAccess, network: NetworkAccess) -> SandboxPolicy {
    SandboxPolicy::new(files, network)
        .with_host_acl_changes(ash_sandboxing::HostAclChanges::ScopedWithTraversal)
        .with_file_system_isolation(ash_sandboxing::FileSystemIsolation::WindowsAccount)
}
