use std::fs;

use agent_roles::AgentRoleCatalog;
use instructions::InstructionCatalog;
use protocol::AgentDefinitionSelectionReason;
use protocol::AgentRoleSource;
use protocol::ContentDigest;
use protocol::FrozenSkillActivation;
use protocol::SkillActivationReason;
use protocol::SkillId;
use protocol::SkillName;
use protocol::SkillSourceId;
use protocol::ToolName;

use super::resolve_agent_selection;

#[test]
fn workflow_roles_and_private_investigators_require_their_trusted_launchers() {
    use super::AgentLaunch;
    use super::resolve_launched_agent;
    let catalogs = [agent_roles::built_in_roles()];
    let tools = [
        "read_file",
        "grep",
        "glob",
        "write_file",
        "shell-command",
        "board_read",
        "board_write",
        "spawn_agent",
        "send_agent_message",
        "wait_agent",
        "web_search",
        "create_goal",
        "update_goal",
    ]
    .into_iter()
    .map(|name| ToolName::new(name).unwrap())
    .collect::<Vec<_>>();
    let selection = |name: &str| protocol::AgentRoleSelection::Exact {
        source: AgentRoleSource::BuiltIn,
        name: name.into(),
    };
    for name in [
        "advisor",
        "reviewer",
        "team/coordinator",
        "team/implementer",
        "team/reviewer",
        "develop/intent",
        "develop/spec",
        "develop/plan",
        "develop/implementer",
        "develop/acceptance",
        "develop/investigator",
        "develop/researcher",
        "develop/conflict-reviewer",
    ] {
        assert!(
            resolve_agent_selection(&selection(name), None, tools.clone(), &[], &catalogs, &[])
                .is_err(),
            "{name}"
        );
        assert!(
            resolve_launched_agent(
                &selection(name),
                None,
                tools.clone(),
                &[],
                &catalogs,
                &[],
                AgentLaunch::Delegation(None)
            )
            .is_err(),
            "{name}"
        );
    }
    let intent = resolve_launched_agent(
        &selection("develop/intent"),
        None,
        tools.clone(),
        &[],
        &catalogs,
        &[],
        AgentLaunch::Workflow,
    )
    .unwrap();
    for name in [
        "develop/investigator",
        "develop/researcher",
        "develop/conflict-reviewer",
    ] {
        let investigator = resolve_launched_agent(
            &selection(name),
            None,
            tools.clone(),
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(intent.role.as_ref()),
        )
        .unwrap();
        assert!(investigator.capability_scope.delegation_tools.is_empty());
        assert!(
            !investigator
                .capability_scope
                .tools
                .iter()
                .any(|tool| matches!(
                    tool.as_str(),
                    "write_file" | "shell-command" | "spawn_agent"
                ))
        );
    }
    assert!(
        resolve_launched_agent(
            &protocol::AgentRoleSelection::Default,
            None,
            tools.clone(),
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(intent.role.as_ref())
        )
        .is_err()
    );
    assert!(
        resolve_launched_agent(
            &selection("develop/implementer"),
            None,
            tools.clone(),
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(intent.role.as_ref())
        )
        .is_err()
    );
    let mut spoof = intent.role.unwrap();
    spoof.definition.as_mut().unwrap().source = AgentRoleSource::Directory {
        id: "same-name".into(),
    };
    assert!(
        resolve_launched_agent(
            &selection("develop/researcher"),
            None,
            tools.clone(),
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(Some(&spoof))
        )
        .is_err()
    );
    let implementer = resolve_launched_agent(
        &selection("develop/implementer"),
        None,
        tools.clone(),
        &[],
        &catalogs,
        &[],
        AgentLaunch::Workflow,
    )
    .unwrap();
    let team = resolve_launched_agent(
        &selection("team/coordinator"),
        None,
        tools.clone(),
        &[],
        &catalogs,
        &[],
        AgentLaunch::Delegation(implementer.role.as_ref()),
    )
    .unwrap();
    let worker = resolve_launched_agent(
        &selection("team/implementer"),
        None,
        tools.clone(),
        &[],
        &catalogs,
        &[],
        AgentLaunch::Delegation(team.role.as_ref()),
    )
    .unwrap();
    for agent in [&implementer, &worker] {
        assert!(
            !agent
                .capability_scope
                .tools
                .iter()
                .any(|tool| matches!(tool.as_str(), "create_goal" | "update_goal"))
        );
    }
    assert!(
        resolve_launched_agent(
            &selection("team/reviewer"),
            None,
            tools.clone(),
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(team.role.as_ref())
        )
        .is_ok()
    );
    assert!(
        resolve_launched_agent(
            &selection("develop/researcher"),
            None,
            tools,
            &[],
            &catalogs,
            &[],
            AgentLaunch::Delegation(team.role.as_ref())
        )
        .is_err()
    );
}

#[test]
fn exact_selection_freezes_definition_and_resolves_capability_references() {
    let dir = tempfile::tempdir().unwrap();
    let agent_root = dir.path().join(".ash/agents");
    let instruction_root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&agent_root).unwrap();
    fs::create_dir_all(&instruction_root).unwrap();
    fs::write(
        agent_root.join("reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code changes for correctness and regressions.\ntools:\n  - read_file\ninstructions:\n  - review-policy\n---\n\nReport only actionable findings.\n",
    )
    .unwrap();
    fs::write(
        instruction_root.join("review-policy.md"),
        "---\nload: on-demand\n---\n\nPrioritize correctness over style.\n",
    )
    .unwrap();
    let agents = AgentRoleCatalog::discover("test", dir.path()).snapshot();
    let instructions = InstructionCatalog::discover(dir.path()).snapshot();

    let selected = resolve_agent_selection(
        &exact("reviewer"),
        None,
        vec![
            ToolName::new("read_file").unwrap(),
            ToolName::new("shell").unwrap(),
        ],
        &[],
        &[agents],
        &[instructions],
    )
    .unwrap();

    let frozen = selected.role.as_ref().unwrap().definition.clone().unwrap();
    assert_eq!(frozen.name, "reviewer");
    assert_eq!(frozen.catalog_generation, 1);
    assert_eq!(
        frozen.source,
        AgentRoleSource::Directory { id: "test".into() }
    );
    assert_eq!(frozen.version, None);
    assert_eq!(
        frozen.selection_reason,
        AgentDefinitionSelectionReason::Explicit
    );
    assert_eq!(selected.capability_scope.tools.len(), 1);
    assert_eq!(selected.capability_scope.tools[0].as_str(), "read_file");
    assert_eq!(
        selected.capability_scope.delegation_tools,
        [
            ToolName::new("read_file").unwrap(),
            ToolName::new("shell").unwrap()
        ]
    );
    assert!(
        selected
            .role
            .as_ref()
            .unwrap()
            .instructions
            .contains("Prioritize correctness over style")
    );
}

#[test]
fn selected_definition_cannot_expand_the_parent_tool_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let agent_root = dir.path().join(".ash/agents");
    fs::create_dir_all(&agent_root).unwrap();
    fs::write(
        agent_root.join("publisher.md"),
        "---\nname: publisher\ndescription: Publishes releases.\ntools:\n  - external_publish\n---\n\nPublish the release.\n",
    )
    .unwrap();
    let agents = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    let error = resolve_agent_selection(
        &exact("publisher"),
        None,
        vec![ToolName::new("read_file").unwrap()],
        &[],
        &[agents],
        &[],
    )
    .err()
    .expect("definition must not add a parent tool");

    assert!(error.to_string().contains("unavailable tool"));
}

#[test]
fn omitted_tools_inherit_parent_then_apply_denials() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("reader.md"),
        "---\nname: reader\ndescription: Reads code without editing.\nrequiredTools:\n  - read_file\ndisallowedTools:\n  - write_file\n---\n\nRead the requested code.\n",
    )
    .unwrap();
    let roles = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    let selected = resolve_agent_selection(
        &exact("reader"),
        None,
        vec![
            ToolName::new("read_file").unwrap(),
            ToolName::new("write_file").unwrap(),
        ],
        &[],
        &[roles],
        &[],
    )
    .unwrap();

    assert_eq!(
        selected.capability_scope.tools,
        [ToolName::new("read_file").unwrap()]
    );
}

#[test]
fn explicit_empty_tool_list_creates_a_no_tool_role() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("advisor.md"),
        "---\nname: advisor\ndescription: Answers from supplied context only.\ntools: []\n---\n\nAnswer without calling tools.\n",
    )
    .unwrap();
    let roles = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    let selected = resolve_agent_selection(
        &exact("advisor"),
        None,
        vec![ToolName::new("read_file").unwrap()],
        &[],
        &[roles],
        &[],
    )
    .unwrap();

    assert!(selected.capability_scope.tools.is_empty());
    assert_eq!(
        selected.capability_scope.delegation_tools,
        [ToolName::new("read_file").unwrap()]
    );
}

#[test]
fn own_and_delegation_tool_scopes_resolve_independently() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("coordinator.md"),
        "---\nname: coordinator\ndescription: Coordinates implementation.\ntools:\n  - read_file\ndelegationTools:\n  - write_file\n  - shell\nrequiredDelegationTools:\n  - write_file\ndisallowedDelegationTools:\n  - shell\n---\n\nCoordinate the task.\n",
    )
    .unwrap();
    let roles = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    let selected = resolve_agent_selection(
        &exact("coordinator"),
        None,
        vec![
            ToolName::new("read_file").unwrap(),
            ToolName::new("write_file").unwrap(),
            ToolName::new("shell").unwrap(),
        ],
        &[],
        &[roles],
        &[],
    )
    .unwrap();

    assert_eq!(
        selected.capability_scope.tools,
        [ToolName::new("read_file").unwrap()]
    );
    assert_eq!(
        selected.capability_scope.delegation_tools,
        [ToolName::new("write_file").unwrap()]
    );
}

#[test]
fn missing_required_delegation_tool_rejects_the_role_before_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("coordinator.md"),
        "---\nname: coordinator\ndescription: Coordinates implementation.\nrequiredDelegationTools:\n  - write_file\n---\n\nCoordinate the task.\n",
    )
    .unwrap();
    let roles = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    let error = resolve_agent_selection(
        &exact("coordinator"),
        None,
        vec![ToolName::new("read_file").unwrap()],
        &[],
        &[roles],
        &[],
    )
    .err()
    .expect("missing required delegation tool must reject the role");

    assert!(error.to_string().contains("unavailable tool 'write_file'"));
}

#[test]
fn missing_required_tool_rejects_the_role_before_spawn() {
    let error = resolve_agent_selection(
        &exact("issue"),
        None,
        vec![ToolName::new("spawn_agent").unwrap()],
        &[],
        &[agent_roles::built_in_roles()],
        &[],
    )
    .err()
    .expect("Issue role must require its coordination and GitHub tools");

    assert!(error.to_string().contains("requires unavailable tool"));
}

#[test]
fn built_in_issue_role_freezes_github_and_coordination_capabilities() {
    let tools = [
        "read_file",
        "search_tools",
        "call_mcp_tool",
        "spawn_agent",
        "send_agent_message",
        "wait_agent",
    ]
    .into_iter()
    .map(|name| ToolName::new(name).unwrap())
    .collect();
    let github = FrozenSkillActivation {
        id: SkillId::new(
            SkillSourceId::new("plugin:skill-source:github").unwrap(),
            SkillName::new("github").unwrap(),
        ),
        content_digest: ContentDigest::sha256(b"github skill"),
        catalog_generation: 1,
        reason: SkillActivationReason::Explicit,
    };
    let rust = FrozenSkillActivation {
        id: SkillId::new(
            SkillSourceId::new("directory:skill-source:rust").unwrap(),
            SkillName::new("rust").unwrap(),
        ),
        content_digest: ContentDigest::sha256(b"rust skill"),
        catalog_generation: 2,
        reason: SkillActivationReason::Explicit,
    };

    let selected = resolve_agent_selection(
        &exact("issue"),
        None,
        tools,
        &[github, rust],
        &[agent_roles::built_in_roles()],
        &[],
    )
    .unwrap();

    assert_eq!(selected.role.as_ref().unwrap().name, "issue");
    let frozen = selected.role.as_ref().unwrap().definition.clone().unwrap();
    assert_eq!(frozen.name, "issue");
    assert_eq!(frozen.source, AgentRoleSource::BuiltIn);
    assert_eq!(frozen.version, Some(4));
    assert_eq!(selected.capability_scope.tools.len(), 5);
    assert!(
        selected
            .capability_scope
            .tools
            .iter()
            .all(|tool| tool.as_str() != "read_file")
    );
    assert_eq!(selected.capability_scope.delegation_tools.len(), 6);
    assert!(
        selected
            .capability_scope
            .delegation_tools
            .iter()
            .any(|tool| tool.as_str() == "read_file")
    );
    assert_eq!(selected.capability_scope.skills.len(), 2);
    assert!(
        selected
            .role
            .as_ref()
            .unwrap()
            .instructions
            .contains("Issue coordinator")
    );
}

#[test]
fn built_in_issue_role_does_not_capture_unrelated_delegation() {
    let selected = resolve_agent_selection(
        &protocol::AgentRoleSelection::Default,
        None,
        vec![ToolName::new("read_file").unwrap()],
        &[],
        &[agent_roles::built_in_roles()],
        &[],
    )
    .unwrap();

    assert!(selected.role.is_none());
    assert_eq!(
        selected.capability_scope.tools,
        [ToolName::new("read_file").unwrap()]
    );
}

#[test]
fn built_in_issue_role_requires_the_github_skill() {
    let tools = [
        "search_tools",
        "call_mcp_tool",
        "spawn_agent",
        "send_agent_message",
        "wait_agent",
    ]
    .into_iter()
    .map(|name| ToolName::new(name).unwrap())
    .collect();

    let error = resolve_agent_selection(
        &exact("issue"),
        None,
        tools,
        &[],
        &[agent_roles::built_in_roles()],
        &[],
    )
    .err()
    .expect("Issue role must require GitHub");

    assert!(
        error
            .to_string()
            .contains("requires inactive Skill 'github'")
    );
}

fn exact(name: &str) -> protocol::AgentRoleSelection {
    protocol::AgentRoleSelection::Exact {
        name: name.into(),
        source: if name == "issue" {
            AgentRoleSource::BuiltIn
        } else {
            AgentRoleSource::Directory { id: "test".into() }
        },
    }
}
