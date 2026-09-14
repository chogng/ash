use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::InstructionCompletionItem;
use crate::thread::composer::MentionPluginItem;
use crate::thread::composer::SkillCompletionItem;
use crate::thread::composer::SlashCommandCatalog;
use crate::thread::composer::built_in_slash_command_definitions;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::instructions::InstructionListResult;
use ash_app_server_protocol::protocol::instructions::InstructionLoadPolicyDto;
use ash_app_server_protocol::protocol::plugins::PluginPackageDto;
use ash_app_server_protocol::protocol::skills::SkillCompatibilityDto;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_app_server_protocol::protocol::skills::SkillListResult;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;
use ash_protocol::SkillRef;
use std::collections::BTreeMap;

pub(crate) fn slash_command_registry(
    definitions: &[SlashCommandDefinition],
) -> Result<SlashCommandCatalog, ClientError> {
    SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        definitions.iter().cloned(),
    )
    .map_err(|error| {
        ClientError::Protocol(format!(
            "App Server advertised an invalid slash command snapshot: {error}"
        ))
    })
}

pub(crate) fn chat_input_catalog_snapshot(
    definitions: &[SlashCommandDefinition],
    skills: &SkillListResult,
    plugins: &[PluginPackageDto],
    instructions: &InstructionListResult,
) -> Result<ChatInputCatalog, ClientError> {
    let mut name_counts = BTreeMap::new();
    for skill in skills.skills.iter().filter(|skill| {
        skill.enablement == SkillEnablementDto::Enabled
            && matches!(skill.compatibility, SkillCompatibilityDto::Compatible)
    }) {
        *name_counts
            .entry(skill.id.name.as_str().to_owned())
            .or_insert(0usize) += 1;
    }
    let mut completion_items = Vec::new();
    for skill in &skills.skills {
        if skill.enablement != SkillEnablementDto::Enabled
            || !matches!(skill.compatibility, SkillCompatibilityDto::Compatible)
            || name_counts.get(skill.id.name.as_str()) != Some(&1)
        {
            continue;
        }
        let name = skill.id.name.as_str().to_owned();
        completion_items.push(SkillCompletionItem::new(
            name,
            skill.description.clone(),
            SkillRef::pinned(skill.id.clone(), skill.content_digest.clone()),
        ));
    }
    Ok(ChatInputCatalog::new(
        slash_command_registry(definitions)?,
        completion_items,
        plugins
            .iter()
            .filter(|plugin| plugin.effective)
            .map(|plugin| MentionPluginItem::new(plugin.id.clone()))
            .collect(),
        instructions
            .instructions
            .iter()
            .filter(|entry| entry.load_policy == InstructionLoadPolicyDto::OnDemand)
            .map(|entry| {
                InstructionCompletionItem::new(
                    entry.name.clone(),
                    entry.path.display().to_string(),
                    entry.reference.clone(),
                )
            })
            .collect(),
    ))
}
