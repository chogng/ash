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
    use protocol::CollaborationMode;
    for (mode, id, body) in [
        (CollaborationMode::Agent, "agent", super::AGENT),
        (CollaborationMode::Plan, "plan", super::PLAN),
        (CollaborationMode::Debug, "debug", super::DEBUG),
        (CollaborationMode::Multitask, "multitask", super::MULTITASK),
        (CollaborationMode::Ask, "ask", super::ASK),
    ] {
        let frozen = super::instructions(mode);
        assert_eq!(frozen.id(), format!("collaboration-mode/{id}"));
        assert_eq!(frozen.revision(), format!("{id}-v2"));
        assert_eq!(frozen.body(), body);
        frozen.validate().unwrap();
    }
}
