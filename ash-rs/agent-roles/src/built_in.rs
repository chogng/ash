use crate::model::AgentRole;
use crate::model::AgentRoleCatalogSnapshot;
use crate::model::AgentRoleFields;
use crate::model::AgentRoleSource;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;

const ISSUE_PATH: &str = "issue.toml";
const ISSUE: &str = include_str!("../assets/builtins/issue.toml");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltInRole {
    #[serde(default)]
    launch: crate::RoleLaunch,
    #[serde(default)]
    callers: Vec<String>,
    delegates: Option<Vec<String>>,
    name: String,
    version: u64,
    description: String,
    model: Option<String>,
    tools: Option<Vec<String>>,
    #[serde(default)]
    disallowed_tools: Vec<String>,
    #[serde(default)]
    required_tools: Vec<String>,
    delegation_tools: Option<Vec<String>>,
    #[serde(default)]
    disallowed_delegation_tools: Vec<String>,
    #[serde(default)]
    required_delegation_tools: Vec<String>,
    skills: Option<Vec<String>>,
    #[serde(default)]
    required_skills: Vec<String>,
    #[serde(default)]
    instructions: Vec<String>,
    developer_instructions: String,
}

/// Returns the immutable Agent roles packaged with Ash.
pub fn built_in_roles() -> Arc<AgentRoleCatalogSnapshot> {
    static ROLES: LazyLock<Arc<AgentRoleCatalogSnapshot>> = LazyLock::new(|| {
        Arc::new(AgentRoleCatalogSnapshot::new(
            1,
            vec![
                parse(ISSUE_PATH, ISSUE),
                parse(
                    "team-coordinator.toml",
                    include_str!("../assets/builtins/team-coordinator.toml"),
                ),
                parse(
                    "team-implementer.toml",
                    include_str!("../assets/builtins/team-implementer.toml"),
                ),
                parse(
                    "team-reviewer.toml",
                    include_str!("../assets/builtins/team-reviewer.toml"),
                ),
                parse(
                    "develop-intent.toml",
                    include_str!("../assets/builtins/develop-intent.toml"),
                ),
                parse(
                    "develop-spec.toml",
                    include_str!("../assets/builtins/develop-spec.toml"),
                ),
                parse(
                    "develop-plan.toml",
                    include_str!("../assets/builtins/develop-plan.toml"),
                ),
                parse(
                    "develop-implementer.toml",
                    include_str!("../assets/builtins/develop-implementer.toml"),
                ),
                parse(
                    "develop-acceptance.toml",
                    include_str!("../assets/builtins/develop-acceptance.toml"),
                ),
                parse(
                    "intent-project-investigator.toml",
                    include_str!("../assets/builtins/intent-project-investigator.toml"),
                ),
                parse(
                    "intent-researcher.toml",
                    include_str!("../assets/builtins/intent-researcher.toml"),
                ),
                parse(
                    "intent-conflict-reviewer.toml",
                    include_str!("../assets/builtins/intent-conflict-reviewer.toml"),
                ),
            ],
            Vec::new(),
        ))
    });
    Arc::clone(&ROLES)
}

fn parse(path: &str, contents: &str) -> AgentRole {
    let role: BuiltInRole = toml::from_str(contents)
        .unwrap_or_else(|error| panic!("invalid built-in Agent role {path}: {error}"));
    assert!(super::catalog::valid_name(&role.name));
    assert!(!role.description.trim().is_empty());
    assert!(!role.developer_instructions.trim().is_empty());
    assert!(role.version > 0);
    assert!(valid_references(&role.callers));
    assert!(role.delegates.as_deref().is_none_or(valid_references));
    assert!(
        role.model
            .as_deref()
            .is_none_or(super::catalog::valid_reference)
    );
    assert!(role.tools.as_deref().is_none_or(valid_references));
    assert!(valid_references(&role.disallowed_tools));
    assert!(valid_references(&role.required_tools));
    assert!(
        role.delegation_tools
            .as_deref()
            .is_none_or(valid_references)
    );
    assert!(valid_references(&role.disallowed_delegation_tools));
    assert!(valid_references(&role.required_delegation_tools));
    assert!(role.skills.as_deref().is_none_or(valid_references));
    assert!(valid_references(&role.required_skills));
    assert!(valid_references(&role.instructions));
    assert!(
        !role
            .required_tools
            .iter()
            .any(|required| role.disallowed_tools.contains(required))
    );
    assert!(role.tools.as_ref().is_none_or(|tools| {
        role.required_tools
            .iter()
            .all(|required| tools.contains(required))
    }));
    assert!(
        !role
            .required_delegation_tools
            .iter()
            .any(|required| role.disallowed_delegation_tools.contains(required))
    );
    assert!(role.delegation_tools.as_ref().is_none_or(|tools| {
        role.required_delegation_tools
            .iter()
            .all(|required| tools.contains(required))
    }));
    assert!(role.skills.as_ref().is_none_or(|skills| {
        role.required_skills
            .iter()
            .all(|required| skills.contains(required))
    }));
    AgentRole::new(AgentRoleFields {
        launch: role.launch,
        callers: role.callers,
        delegates: role.delegates,
        name: role.name,
        description: role.description.trim().to_owned(),
        source: AgentRoleSource::BuiltIn,
        version: Some(role.version),
        content_digest: format!("sha256:{:x}", Sha256::digest(contents.as_bytes())),
        relative_path: PathBuf::from(path),
        model: role.model,
        tools: role.tools,
        disallowed_tools: role.disallowed_tools,
        required_tools: role.required_tools,
        delegation_tools: role.delegation_tools,
        disallowed_delegation_tools: role.disallowed_delegation_tools,
        required_delegation_tools: role.required_delegation_tools,
        skills: role.skills,
        required_skills: role.required_skills,
        instructions: role.instructions,
        role_instructions: role.developer_instructions.trim().to_owned(),
    })
}

fn valid_references(references: &[String]) -> bool {
    references
        .iter()
        .all(|reference| super::catalog::valid_reference(reference))
        && references
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == references.len()
}

#[cfg(test)]
#[path = "built_in_tests.rs"]
mod tests;
