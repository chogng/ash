//! End-to-end network matrix through the Linux SDK and the command executor.
#![cfg(target_os = "linux")]
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
#[ignore = "requires Bubblewrap, ASH_NETWORK_MATRIX_PROBE and a reachable ASH_DNS_SERVER"]
fn dns_ipv6_and_host_routes_preserve_the_network_boundary() {
    let fixtures = matrix::Matrix::start();
    let probe = std::env::var("ASH_NETWORK_MATRIX_PROBE").unwrap();
    fixtures.positive_control(std::path::Path::new(&probe));
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let executor = CommandExecutor::new(
        dir,
        MxcSandbox::new(ash_install_context::InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(60),
            max_output_bytes: 16384,
        },
    );
    for (mode, network) in [
        ("denied", NetworkAccess::Denied),
        ("managed", NetworkAccess::Managed),
    ] {
        let policy = (network == NetworkAccess::Managed).then(|| fixtures.policy());
        let result = executor
            .execute_scoped_with_network(
                CommandRequest {
                    program: probe.clone(),
                    arguments: fixtures.arguments(mode),
                    working_directory: ".".into(),
                    input: CommandInput::Closed,
                },
                CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                    FileSystemAccess::ReadOnly,
                    network,
                )),
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
        assert!(output.stdout.contains("matrix-descendant-ok"), "{output:?}");
        fixtures.assert_no_dns_escape();
    }
    fixtures.assert_policy_observed();
}
