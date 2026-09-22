use std::collections::BTreeSet;

use agent_roles::AgentRole;
use agent_roles::AgentRoleCatalogSnapshot;
use core_api::CoreError;
use instructions::InstructionCatalogSnapshot;
use protocol::AgentCapabilityScope;
use protocol::AgentDefinitionSelectionReason;
use protocol::AgentRoleSnapshot;
use protocol::AgentRoleSource;
use protocol::ContentDigest;
use protocol::FrozenAgentDefinitionRef;
use protocol::FrozenSkillActivation;
use protocol::ModelId;
use protocol::ModelRef;
use protocol::ProviderId;
use protocol::SkillActivationReason;
use protocol::ToolName;

pub struct ResolvedAgentSelection {
    pub role: Option<AgentRoleSnapshot>,
    pub capability_scope: AgentCapabilityScope,
}

/// Trusted entry point for role selection, supplied by the host rather than model arguments.
pub enum AgentLaunch<'a> {
    Session,
    Workflow,
    Delegation(Option<&'a AgentRoleSnapshot>),
}

pub fn resolve_agent_selection(
    requested: &protocol::AgentRoleSelection,
    current_model: Option<&ModelRef>,
    tool_ceiling: Vec<ToolName>,
    active_skills: &[FrozenSkillActivation],
    agents: &[std::sync::Arc<AgentRoleCatalogSnapshot>],
    instructions: &[std::sync::Arc<InstructionCatalogSnapshot>],
) -> Result<ResolvedAgentSelection, CoreError> {
    resolve_launched_agent(
        requested,
        current_model,
        tool_ceiling,
        active_skills,
        agents,
        instructions,
        AgentLaunch::Session,
    )
}

pub fn resolve_launched_agent(
    requested: &protocol::AgentRoleSelection,
    current_model: Option<&ModelRef>,
    tool_ceiling: Vec<ToolName>,
    active_skills: &[FrozenSkillActivation],
    agents: &[std::sync::Arc<AgentRoleCatalogSnapshot>],
    instructions: &[std::sync::Arc<InstructionCatalogSnapshot>],
    launch: AgentLaunch<'_>,
) -> Result<ResolvedAgentSelection, CoreError> {
    validate_launch(requested, &launch, agents)?;
    let Some((definition, catalog_generation)) = select_definition(requested, agents)? else {
        return Ok(ResolvedAgentSelection {
            role: None,
            capability_scope: protocol::AgentCapabilityScope {
                tools: tool_ceiling.clone(),
                delegation_tools: tool_ceiling,
                skills: active_skills.to_vec(),
            },
        });
    };
    let tools = resolve_tools(definition, &tool_ceiling, AgentToolScope::Own)?;
    let delegation_tools = resolve_tools(definition, &tool_ceiling, AgentToolScope::Delegation)?;
    let skills = resolve_skills(definition, active_skills)?;
    let role_instructions = resolve_role_instructions(definition, instructions)?;
    let model = definition
        .model()
        .map(parse_model_ref)
        .transpose()?
        .or_else(|| current_model.cloned());
    let content_digest = ContentDigest::new(definition.content_digest())
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let frozen = FrozenAgentDefinitionRef {
        name: definition.name().into(),
        source: match definition.source() {
            agent_roles::AgentRoleSource::BuiltIn => AgentRoleSource::BuiltIn,
            agent_roles::AgentRoleSource::Directory { id } => {
                AgentRoleSource::Directory { id: id.clone() }
            }
        },
        version: definition.version(),
        catalog_generation,
        content_digest,
        selection_reason: AgentDefinitionSelectionReason::Explicit,
    };
    Ok(ResolvedAgentSelection {
        role: Some(AgentRoleSnapshot {
            name: definition.name().into(),
            instructions: role_instructions,
            model,
            definition: Some(frozen),
        }),
        capability_scope: AgentCapabilityScope {
            tools,
            delegation_tools,
            skills,
        },
    })
}

fn validate_launch(
    requested: &protocol::AgentRoleSelection,
    launch: &AgentLaunch<'_>,
    catalogs: &[std::sync::Arc<AgentRoleCatalogSnapshot>],
) -> Result<(), CoreError> {
    let parent = match launch {
        AgentLaunch::Delegation(Some(parent)) => parent.definition.as_ref(),
        _ => None,
    };
    let parent_role = parent
        .filter(|parent| parent.source == AgentRoleSource::BuiltIn)
        .map(|parent| {
            let selection = protocol::AgentRoleSelection::Exact {
                source: parent.source.clone(),
                name: parent.name.clone(),
            };
            let (role, _) = select_definition(&selection, catalogs)?
                .ok_or_else(|| CoreError::Policy("Parent role is unavailable".into()))?;
            if role.content_digest() != parent.content_digest.as_str() {
                return Err(CoreError::Policy(
                    "Parent role changed; start a new Agent before delegating".into(),
                ));
            }
            Ok(role)
        })
        .transpose()?;
    if let Some(delegates) = parent_role.and_then(AgentRole::delegates) {
        if !matches!(requested, protocol::AgentRoleSelection::Exact { source: AgentRoleSource::BuiltIn, name } if delegates.contains(name))
        {
            return Err(CoreError::Policy(
                "The parent role cannot launch this Agent".into(),
            ));
        }
    }
    let Some((role, _)) = select_definition(requested, catalogs)? else {
        return Ok(());
    };
    let caller_allowed =
        parent_role.is_some_and(|parent| role.callers().iter().any(|name| name == parent.name()));
    let allowed = match role.launch() {
        agent_roles::RoleLaunch::Any => true,
        agent_roles::RoleLaunch::Workflow => {
            matches!(launch, AgentLaunch::Workflow) || caller_allowed
        }
        agent_roles::RoleLaunch::Delegation => {
            matches!(launch, AgentLaunch::Delegation(_))
                && (role.callers().is_empty() || caller_allowed)
        }
    };
    if !allowed {
        return Err(CoreError::Policy(format!(
            "Agent '{}' is unavailable from this launch entry point",
            role.name()
        )));
    }
    Ok(())
}

fn resolve_tools(
    definition: &AgentRole,
    tool_ceiling: &[ToolName],
    scope: AgentToolScope,
) -> Result<Vec<ToolName>, CoreError> {
    let available = tool_ceiling.iter().cloned().collect::<BTreeSet<_>>();
    resolve_required_tools(definition, &available, scope)?;
    let mut resolved = match scope.tools(definition) {
        Some(tools) => tools
            .iter()
            .map(|reference| resolve_available_tool(definition, reference, &available))
            .collect::<Result<Vec<_>, _>>()?,
        None => tool_ceiling.to_vec(),
    };
    if !scope.disallowed_tools(definition).is_empty() {
        let disallowed = scope
            .disallowed_tools(definition)
            .iter()
            .map(|reference| {
                ToolName::new(reference.clone())
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        resolved.retain(|tool| !disallowed.contains(tool));
    }
    Ok(resolved)
}

fn resolve_required_tools(
    definition: &AgentRole,
    available: &BTreeSet<ToolName>,
    scope: AgentToolScope,
) -> Result<(), CoreError> {
    scope
        .required_tools(definition)
        .iter()
        .try_for_each(|reference| {
            resolve_available_tool(definition, reference, available).map(|_| ())
        })
}

#[derive(Clone, Copy)]
enum AgentToolScope {
    Own,
    Delegation,
}

impl AgentToolScope {
    fn tools(self, definition: &AgentRole) -> Option<&[String]> {
        match self {
            Self::Own => definition.tools(),
            Self::Delegation => definition.delegation_tools(),
        }
    }

    fn disallowed_tools(self, definition: &AgentRole) -> &[String] {
        match self {
            Self::Own => definition.disallowed_tools(),
            Self::Delegation => definition.disallowed_delegation_tools(),
        }
    }

    fn required_tools(self, definition: &AgentRole) -> &[String] {
        match self {
            Self::Own => definition.required_tools(),
            Self::Delegation => definition.required_delegation_tools(),
        }
    }
}

fn resolve_available_tool(
    definition: &AgentRole,
    reference: &str,
    available: &BTreeSet<ToolName>,
) -> Result<ToolName, CoreError> {
    let name = ToolName::new(reference.to_owned())
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    available.contains(&name).then_some(name).ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "Agent definition '{}' requires unavailable tool '{reference}'",
            definition.name()
        ))
    })
}

fn resolve_skills(
    definition: &AgentRole,
    active: &[FrozenSkillActivation],
) -> Result<Vec<FrozenSkillActivation>, CoreError> {
    for reference in definition.required_skills() {
        resolve_active_skill(definition, reference, active)?;
    }
    match definition.skills() {
        Some(skills) => skills
            .iter()
            .map(|reference| resolve_active_skill(definition, reference, active))
            .collect(),
        None => Ok(active.iter().cloned().map(as_automatic).collect()),
    }
}

fn resolve_active_skill(
    definition: &AgentRole,
    reference: &str,
    active: &[FrozenSkillActivation],
) -> Result<FrozenSkillActivation, CoreError> {
    let matches = active
        .iter()
        .filter(|activation| skill_matches(reference, activation))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [matched] => Ok(as_automatic((*matched).clone())),
        [] => Err(CoreError::InvalidInput(format!(
            "Agent definition '{}' requires inactive Skill '{reference}'",
            definition.name()
        ))),
        _ => Err(CoreError::InvalidInput(format!(
            "Agent definition '{}' has ambiguous Skill reference '{reference}'",
            definition.name()
        ))),
    }
}

fn skill_matches(reference: &str, activation: &FrozenSkillActivation) -> bool {
    reference == activation.id.name.as_str()
        || reference
            == format!(
                "{}/{}",
                activation.id.source.as_str(),
                activation.id.name.as_str()
            )
}

fn as_automatic(mut activation: FrozenSkillActivation) -> FrozenSkillActivation {
    activation.reason = SkillActivationReason::Automatic;
    activation
}

fn resolve_role_instructions(
    definition: &AgentRole,
    instructions: &[std::sync::Arc<InstructionCatalogSnapshot>],
) -> Result<String, CoreError> {
    let mut body = definition.role_instructions().to_owned();
    for reference in definition.instructions() {
        let matches = instructions
            .iter()
            .flat_map(|snapshot| {
                snapshot
                    .entries()
                    .iter()
                    .filter(|artifact| artifact.name() == reference)
            })
            .collect::<Vec<_>>();
        let artifact = match matches.as_slice() {
            [artifact] => *artifact,
            [] => {
                return Err(CoreError::InvalidInput(format!(
                    "Agent definition '{}' requires unavailable Instruction '{reference}'",
                    definition.name()
                )));
            }
            _ => {
                return Err(CoreError::InvalidInput(format!(
                    "Agent definition '{}' has ambiguous Instruction reference '{reference}'",
                    definition.name()
                )));
            }
        };
        body.push_str(&format!(
            "\n\n<agent-instruction name=\"{}\">\n{}\n</agent-instruction>",
            artifact.name(),
            artifact.body()
        ));
    }
    Ok(body)
}

fn parse_model_ref(reference: &str) -> Result<ModelRef, CoreError> {
    let (provider, model) = reference.split_once('/').ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "Agent model reference '{reference}' must use provider/model"
        ))
    })?;
    Ok(ModelRef::new(
        ProviderId::new(provider).map_err(|error| CoreError::InvalidInput(error.to_string()))?,
        ModelId::new(model).map_err(|error| CoreError::InvalidInput(error.to_string()))?,
    ))
}

fn select_definition<'a>(
    requested: &protocol::AgentRoleSelection,
    snapshots: &'a [std::sync::Arc<AgentRoleCatalogSnapshot>],
) -> Result<Option<(&'a AgentRole, u64)>, CoreError> {
    let protocol::AgentRoleSelection::Exact { source, name } = requested else {
        return Ok(None);
    };
    if name.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "Agent role name must not be empty".into(),
        ));
    }
    let matches = snapshots
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .entries()
                .iter()
                .filter(|role| {
                    role.name() == name
                        && match (role.source(), source) {
                            (agent_roles::AgentRoleSource::BuiltIn, AgentRoleSource::BuiltIn) => {
                                true
                            }
                            (
                                agent_roles::AgentRoleSource::Directory { id: left },
                                AgentRoleSource::Directory { id: right },
                            ) => left == right,
                            _ => false,
                        }
                })
                .map(|role| (role, snapshot.generation()))
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [matched] => Ok(Some(*matched)),
        [] => Err(CoreError::InvalidInput(format!(
            "Agent role '{name}' is not available from the requested source"
        ))),
        _ => Err(CoreError::InvalidInput(format!(
            "Agent role '{name}' is duplicated in the requested source"
        ))),
    }
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

/// Resolves a root Agent from host-authorized catalogs and the current tool ceiling.
pub fn resolve_root_agent(
    selection: &protocol::AgentRoleSelection,
    model: Option<protocol::ModelRef>,
    tools: Vec<ToolName>,
    roles: &[std::sync::Arc<AgentRoleCatalogSnapshot>],
    instructions: &[std::sync::Arc<InstructionCatalogSnapshot>],
    skills_runtime: Option<&skills_extension::SkillRuntime>,
    model_instructions: &models_manager::ModelInstructionCatalog,
) -> Result<Option<protocol::AgentConfiguration>, CoreError> {
    if matches!(selection, protocol::AgentRoleSelection::Default) {
        return Ok(None);
    }
    let Some((definition, _)) = select_definition(selection, roles)? else {
        unreachable!("default selection returned above");
    };
    let references = definition
        .required_skills()
        .iter()
        .chain(definition.skills().unwrap_or_default())
        .collect::<BTreeSet<_>>();
    let mut skills = Vec::new();
    if !references.is_empty() {
        let runtime = skills_runtime.ok_or_else(|| {
            CoreError::InvalidInput("Agent requires a configured Skill runtime".into())
        })?;
        let catalog = runtime
            .list(skills_extension::SkillCatalogReload::Cached)
            .map_err(CoreError::InvalidInput)?;
        for reference in references {
            let matches = catalog
                .entries
                .iter()
                .filter(|entry| {
                    let id = entry.catalog_entry.id();
                    reference == id.name.as_str()
                        || reference == &format!("{}/{}", id.source, id.name)
                })
                .collect::<Vec<_>>();
            let entry = match matches.as_slice() {
                [entry] => *entry,
                [] => {
                    return Err(CoreError::InvalidInput(format!(
                        "Agent requires unavailable Skill '{reference}'"
                    )));
                }
                _ => {
                    return Err(CoreError::InvalidInput(format!(
                        "Agent Skill '{reference}' requires an exact source"
                    )));
                }
            };
            let activated = runtime
                .activate_explicit(&protocol::SkillRef::follow_latest(
                    entry.catalog_entry.id().clone(),
                ))
                .map_err(CoreError::InvalidInput)?;
            skills.push(activated.activation().clone());
        }
    }
    let selected = resolve_agent_selection(
        selection,
        model.as_ref(),
        tools,
        &skills,
        roles,
        instructions,
    )?;
    let selected_model = selected
        .role
        .as_ref()
        .and_then(|role| role.model.as_ref())
        .or(model.as_ref());
    let instructions = prompts::AGENT_INSTRUCTIONS
        .freeze()
        .with_model_guidance(model_instructions.resolve(selected_model));
    let agent = protocol::AgentConfiguration {
        role: selected.role,
        capability_scope: selected.capability_scope,
        base_instructions: Some(instructions),
    };
    agent
        .validate()
        .map_err(|error| CoreError::InvalidInput(error.into()))?;
    Ok(Some(agent))
}
