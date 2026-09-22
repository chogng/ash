use super::*;

#[test]
fn built_in_roles_are_packaged_as_validated_definitions() {
    let snapshot = built_in_roles();

    assert!(snapshot.diagnostics().is_empty());
    assert_eq!(snapshot.entries().len(), 14);
    let role = snapshot
        .entries()
        .iter()
        .find(|role| role.name() == "issue")
        .unwrap();
    assert_eq!(role.name(), "issue");
    assert_eq!(role.source(), &AgentRoleSource::BuiltIn);
    assert_eq!(role.version(), Some(4));
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

#[test]
fn host_roles_keep_consultation_and_code_review_instructions_in_the_catalog() {
    let roles = built_in_roles();
    let advisor = roles.get("advisor").unwrap();
    assert_eq!(advisor.launch(), crate::RoleLaunch::Host);
    assert_eq!(advisor.tools(), Some([].as_slice()));
    assert_eq!(advisor.delegation_tools(), Some([].as_slice()));
    assert!(advisor.role_instructions().contains("You have no tools"));
    let reviewer = roles.get("reviewer").unwrap();
    assert_eq!(reviewer.launch(), crate::RoleLaunch::Host);
    assert!(reviewer.role_instructions().contains("overall_correctness"));
    assert!(reviewer.role_instructions().contains("Do not modify"));
}

#[test]
fn scoped_ids_distinguish_the_two_implementation_roles() {
    let roles = built_in_roles();
    let team = roles.get("team/implementer").unwrap();
    let develop = roles.get("develop/implementer").unwrap();
    assert_eq!(team.relative_path(), Path::new("team/implementer.md"));
    assert_eq!(develop.relative_path(), Path::new("develop/implementer.md"));
    assert!(team.delegates().unwrap().is_empty());
    assert_eq!(develop.delegates().unwrap(), ["team/coordinator"]);
    assert!(roles.get("implementer").is_none());
}
