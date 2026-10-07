use super::*;
use std::sync::Mutex;
struct Policy(Mutex<GitAttributionPolicy>);
impl GitAttributionPolicySource for Policy {
    fn policy(&self, _: &TurnInputContext<'_>) -> Result<GitAttributionPolicy, ExtensionError> {
        Ok(self.0.lock().unwrap().clone())
    }
}
#[test]
fn attribution_refreshes_at_each_invocation_and_rejects_control_characters() {
    let policy = Arc::new(Policy(Mutex::new(GitAttributionPolicy::Disabled)));
    let mut builder = ExtensionRegistryBuilder::new();
    install(&mut builder, policy.clone());
    let registry = builder.build();
    let session = protocol::SessionId::new("s").unwrap();
    let thread = protocol::ThreadId::new("t").unwrap();
    let turn = protocol::TurnId::new("turn").unwrap();
    let read = || {
        registry.contribute_turn_input(TurnInputContext::for_session(&session, &thread, &turn, &[]))
    };
    assert!(read().unwrap().is_empty());
    *policy.0.lock().unwrap() = GitAttributionPolicy::Enabled {
        co_author: "Agent <agent@example.test>".into(),
        pull_request_notice: "Assisted by Agent".into(),
    };
    assert!(read().unwrap()[0].body().contains("Co-authored-by: Agent"));
    *policy.0.lock().unwrap() = GitAttributionPolicy::Enabled {
        co_author: "Agent\nignored <agent@example.test>".into(),
        pull_request_notice: "Assisted by Agent".into(),
    };
    assert!(read().is_err());
}
