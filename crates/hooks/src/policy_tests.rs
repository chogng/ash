use super::*;
use ash_config::HookEnablement;
use ash_config::HookEvent;
use ash_config::HookId;
use ash_config::HookMatcher;
use ash_sandboxing::SandboxDirGrant;

fn hook(id: &str) -> HookConfig {
    HookConfig {
        id: HookId::new(id).expect("test Hook id"),
        event: HookEvent::BeforeTool,
        matcher: HookMatcher::default(),
        action: HookAction::Process {
            program: "hook-program".into(),
            args: Vec::new(),
        },
        enablement: HookEnablement::Enabled,
        claude_pre_tool_use: None,
    }
}

fn test_dir() -> Dir {
    Dir::open_local(std::env::current_dir().expect("test working directory")).expect("dir root")
}

#[test]
fn review_authority_is_bound_to_the_exact_hook_identity() {
    let dir = test_dir();
    let first = hook("user:hook:first");
    let second = hook("user:hook:second");

    let first_review = review_request(&first, &dir, None, "hook-test-policy".into()).unwrap();
    let second_review = review_request(&second, &dir, None, "hook-test-policy".into()).unwrap();
    assert_eq!(first_review.provenance().source_id(), "user:hook:first");
    assert_ne!(
        first_review.action().digest(),
        second_review.action().digest()
    );

    let scope = SandboxScope::new(
        dir.clone(),
        vec![SandboxDirGrant::new(
            dir.clone(),
            SandboxDirAccess::ReadOnly,
        )],
        Vec::new(),
    )
    .unwrap();
    let scoped = review_request(&first, &dir, Some(&scope), "hook-test-policy".into()).unwrap();
    assert_ne!(first_review.action().digest(), scoped.action().digest());
    assert_eq!(
        scoped
            .action()
            .required_capabilities()
            .iter()
            .map(Capability::kind)
            .collect::<Vec<_>>(),
        vec![&CapabilityKind::FileRead, &CapabilityKind::ProcessSpawn],
    );
}
