use super::*;
use ash_config::HookEnablement;
use ash_config::HookEvent;
use ash_config::HookId;
use ash_config::HookMatcher;

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

    let first_review = review_request(&first, &dir, "hook-test-policy".into()).unwrap();
    let second_review = review_request(&second, &dir, "hook-test-policy".into()).unwrap();
    assert_eq!(first_review.provenance().source_id(), "user:hook:first");
    assert_ne!(
        first_review.action().digest(),
        second_review.action().digest()
    );
}
