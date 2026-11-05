//! End-to-end network matrix through the platform SDK and the command executor.
#![cfg(any(target_os = "linux", target_os = "macos", windows))]
#[path = "../../network-proxy/tests/support/matrix.rs"]
mod matrix;

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use mxc_sandbox::MxcSandbox;
use std::time::Duration;

struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

#[test]
#[ignore = "requires ASH_NETWORK_MATRIX_PROBE, ASH_DNS_SERVER and the platform sandbox"]
fn dns_ipv6_and_host_routes_preserve_the_network_boundary() {
    #[cfg(windows)]
    for variable in ["ASH_WINDOWS_DNS_ENDPOINT", "ASH_WINDOWS_NETWORK_ENDPOINT"] {
        std::env::var(variable).unwrap_or_else(|_| panic!("provide {variable} outside the guest"));
    }
    let fixtures = matrix::Matrix::start();
    let source = std::env::var("ASH_NETWORK_MATRIX_PROBE").unwrap();
    fixtures.positive_control(std::path::Path::new(&source));
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    #[cfg(windows)]
    let probe = {
        let path = dir.canonical_path().join("matrix.exe");
        std::fs::copy(&source, &path).unwrap();
        path.to_str().unwrap().to_owned()
    };
    #[cfg(not(windows))]
    let probe = source;
    let executor = CommandExecutor::new(
        dir,
        MxcSandbox::new(ash_install_context::InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(60),
            max_output_bytes: 16384,
        },
    );
    // PSEC validates outbound traffic here. Older PSEC versions can bind
    // listeners even when outbound connections are denied.
    let cases = if cfg!(windows) {
        [
            ("psec-denied", NetworkAccess::Denied),
            ("allowed", NetworkAccess::Allowed),
        ]
    } else {
        [
            ("denied", NetworkAccess::Denied),
            ("managed", NetworkAccess::Managed),
        ]
    };
    for (mode, network) in cases {
        let policy = (network == NetworkAccess::Managed).then(|| fixtures.policy());
        let sandbox = SandboxPolicy::new(FileSystemAccess::ReadOnly, network);
        #[cfg(windows)]
        let sandbox = sandbox.with_host_acl_changes(ash_sandboxing::HostAclChanges::Scoped);
        let result = executor
            .execute_scoped_with_network(
                CommandRequest {
                    program: probe.clone(),
                    arguments: fixtures.arguments(mode),
                    working_directory: ".".into(),
                    input: CommandInput::Closed,
                    environment: Default::default(),
                },
                CommandExecutionAuthority::Sandboxed(sandbox),
                &CancellationSource::new().token(),
                None,
                policy.as_ref(),
            )
            .unwrap();
        let CommandExecutionOutcome::Completed(output) = result else {
            panic!("{result:?}");
        };
        assert_eq!(output.exit_code, Some(0), "{mode}: {output:?}");
        println!("{}", output.stdout);
        assert!(
            output.stdout.contains(&format!("matrix-{mode}-ok")),
            "{output:?}"
        );
        if network != NetworkAccess::Allowed {
            assert!(output.stdout.contains("matrix-descendant-ok"), "{output:?}");
            fixtures.assert_no_dns_escape();
        }
    }
    if !cfg!(windows) {
        fixtures.assert_policy_observed();
    }
}
