//! End-to-end network matrix through the Windows account backend and service.
#![cfg(windows)]
#[path = "../../network-proxy/tests/support/matrix.rs"]
mod matrix;
#[path = "support/windows.rs"]
mod support;

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use std::time::Duration;

#[test]
#[ignore = "requires provisioned Windows sandbox, ASH_NETWORK_MATRIX_PROBE and ASH_DNS_SERVER"]
fn dns_ipv6_and_host_routes_preserve_the_network_boundary() {
    let fixtures = matrix::Matrix::start();
    let source = std::env::var("ASH_NETWORK_MATRIX_PROBE").unwrap();
    fixtures.positive_control(std::path::Path::new(&source));
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let probe = dir.canonical_path().join("matrix.exe");
    std::fs::copy(source, &probe).unwrap();
    for (mode, network) in [
        ("denied", NetworkAccess::Denied),
        ("managed", NetworkAccess::Managed),
        ("allowed", NetworkAccess::Allowed),
    ] {
        let policy = (network == NetworkAccess::Managed).then(|| fixtures.policy());
        let result = support::executor(&dir, Duration::from_secs(60))
            .execute_scoped_with_network(
                CommandRequest {
                    program: probe.to_str().unwrap().into(),
                    arguments: fixtures.arguments(mode),
                    working_directory: ".".into(),
                    input: CommandInput::Closed,
                },
                CommandExecutionAuthority::Sandboxed(support::sandbox_policy(
                    FileSystemAccess::DirectoryWrite,
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
        if network != NetworkAccess::Allowed {
            assert!(output.stdout.contains("matrix-descendant-ok"), "{output:?}");
            fixtures.assert_no_dns_escape();
        }
    }
    fixtures.assert_policy_observed();
}
