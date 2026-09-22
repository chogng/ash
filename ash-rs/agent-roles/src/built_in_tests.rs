use super::*;

#[test]
fn built_in_roles_are_packaged_as_validated_definitions() {
    let snapshot = built_in_roles();

    assert!(snapshot.diagnostics().is_empty());
    assert_eq!(snapshot.entries().len(), 12);
    let role = snapshot
        .entries()
        .iter()
        .find(|role| role.name() == "issue")
        .unwrap();
    assert_eq!(role.name(), "issue");
    assert_eq!(role.source(), &AgentRoleSource::BuiltIn);
    assert_eq!(role.version(), Some(3));
    assert_eq!(
        role.tools().unwrap(),
        [
            "search_tools",
            "call_mcp_tool",
            "spawn_agent",
            "send_agent_message",
            "wait_agent",
        ]
    );
    assert_eq!(
        role.required_tools(),
        [
            "search_tools",
            "call_mcp_tool",
            "spawn_agent",
            "send_agent_message",
            "wait_agent",
        ]
    );
    assert_eq!(role.delegation_tools(), None);
    assert!(role.disallowed_delegation_tools().is_empty());
    assert!(role.required_delegation_tools().is_empty());
    assert_eq!(role.skills(), None);
    assert_eq!(role.required_skills(), ["github"]);
    assert!(role.role_instructions().contains("[issue #"));
    assert!(role.content_digest().starts_with("sha256:"));
    assert!(
        snapshot
            .entries()
            .iter()
            .all(|role| role.name() != "general")
    );
}
