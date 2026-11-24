#[test]
fn every_mode_has_distinct_instructions() {
    let templates = [
        super::AGENT,
        super::PLAN,
        super::DEBUG,
        super::SWARM,
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
    use protocol::TaskExecution;
    for (mode, id, revision, body) in [
        (TaskExecution::Agent, "agent", "agent-v5", super::AGENT),
        (TaskExecution::Plan, "plan", "plan-v8", super::PLAN),
        (TaskExecution::Debug, "debug", "debug-v5", super::DEBUG),
        (TaskExecution::Swarm, "swarm", "swarm-v4", super::SWARM),
        (TaskExecution::Ask, "ask", "ask-v7", super::ASK),
    ] {
        let frozen = super::instructions(mode);
        assert_eq!(frozen.owner(), "task-command-templates");
        assert_eq!(frozen.id(), format!("task-command/{id}"));
        assert_eq!(frozen.revision(), revision);
        let header = if mode.is_default() {
            "# Default task execution\n".to_owned()
        } else {
            format!("# Task command: /{id}\n")
        };
        assert!(frozen.body().starts_with(header.as_str()));
        if mode == TaskExecution::Plan {
            assert_eq!(frozen.body(), body);
        } else {
            assert!(frozen.body().starts_with(body.trim_end()));
            assert!(frozen.body().contains("#ash-followup"));
        }
        frozen.validate().unwrap();
    }
}
