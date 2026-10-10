use super::*;
use ash_async_utils::CancellationSource;
use ash_config::HookEnablement;
use ash_config::HookId;
use ash_protocol::HookEvent;

#[test]
fn real_process_hooks_execute_inside_the_bound_directory() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let hook = HookConfig {
        id: HookId::new("user:hook:process-test").unwrap(),
        event: HookEvent::Setup,
        matcher: Default::default(),
        enablement: HookEnablement::Enabled,
        action: HookAction::Process {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "pwd > hook-cwd".into()],
        },
    };
    let cancellation = CancellationSource::new();
    let output = LocalHookProcessExecutor::execute_process(
        dir.clone(),
        &hook,
        CommandExecutionAuthority::Unrestricted,
        Duration::from_secs(2),
        &cancellation.token(),
    )
    .unwrap();
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-cwd"))
            .unwrap()
            .trim(),
        dir.canonical_path().to_str().unwrap()
    );
    std::fs::remove_file(root.path().join("hook-cwd")).unwrap();
    LocalHookProcessExecutor::new(dir.clone())
        .execute(
            &hook,
            Vec::new(),
            CommandExecutionAuthority::Unrestricted,
            &cancellation.token(),
            &mut core_api::HookRunEvidence {
                program: "/bin/sh".into(),
                arguments: Vec::new(),
                directory: root.path().into(),
                input: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                stdout_truncated: false,
                stderr_truncated: false,
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-cwd"))
            .unwrap()
            .trim(),
        dir.canonical_path().to_str().unwrap()
    );
}
