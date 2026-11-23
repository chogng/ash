#[test]
fn every_mode_has_distinct_instructions() {
    let templates = [
        super::AGENT,
        super::PLAN,
        super::DEBUG,
        super::MULTITASK,
        super::ASK,
    ];
    for template in templates {
        assert!(!template.trim().is_empty());
    }
    for (index, template) in templates.iter().enumerate() {
        assert!(!templates[..index].contains(template));
    }
}

#[test]
fn every_mode_freezes_its_authored_asset() {
    use protocol::AgentMode;
    for (mode, id, revision, body) in [
        (AgentMode::Agent, "agent", "agent-v3", super::AGENT),
        (AgentMode::Plan, "plan", "plan-v4", super::PLAN),
        (AgentMode::Debug, "debug", "debug-v3", super::DEBUG),
        (
            AgentMode::Multitask,
            "multitask",
            "multitask-v3",
            super::MULTITASK,
        ),
        (AgentMode::Ask, "ask", "ask-v4", super::ASK),
    ] {
        let frozen = super::instructions(mode);
        assert_eq!(frozen.id(), format!("collaboration-mode/{id}"));
        assert_eq!(frozen.revision(), revision);
        if mode == AgentMode::Plan {
            assert_eq!(frozen.body(), body);
        } else {
            assert!(frozen.body().starts_with(body.trim_end()));
            assert!(frozen.body().contains("#ash-followup"));
        }
        frozen.validate().unwrap();
    }
}
