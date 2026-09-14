use crate::SkillRuntime;
use crate::catalog_prompt::catalog_prompt;
use crate::tool::SkillToolContributor;
use std::sync::Arc;
use ash_extension_api::ExtensionError;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::PromptFragment;
use ash_extension_api::PromptFragmentLayer;
use ash_extension_api::PromptFragmentRetention;
use ash_extension_api::PromptFragmentSource;
use ash_extension_api::SkillActivationContext;
use ash_extension_api::SkillActivationContributor;
use ash_extension_api::TurnInputContext;
use ash_extension_api::TurnInputContributor;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::SkillActivationReason;
use ash_protocol::UserInput;

/// Installs one Skill runtime into the generic agent extension registry.
pub fn install(builder: &mut ExtensionRegistryBuilder, runtime: Arc<SkillRuntime>) {
    builder.skill_activation_contributor(runtime.clone());
    builder.read_only_tool_contributor(
        "skills",
        Arc::new(SkillToolContributor::new(runtime.clone())),
    );
    builder.turn_input_contributor("skills", runtime);
}

impl SkillActivationContributor for SkillRuntime {
    fn contribute(
        &self,
        input: SkillActivationContext<'_>,
    ) -> Result<Vec<FrozenSkillActivation>, ExtensionError> {
        let mut activations = input
            .user_input()
            .iter()
            .filter_map(|item| match item {
                UserInput::Skill { skill } => Some(skill),
                UserInput::Text { .. }
                | UserInput::Context { .. }
                | UserInput::ImageAttachment { .. }
                | UserInput::Image { .. }
                | UserInput::LocalImage { .. }
                | UserInput::Mention { .. } => None,
                UserInput::Instruction { .. } => None,
            })
            .map(|selected| {
                input
                    .session_id()
                    .map_or_else(
                        || self.activate_explicit(selected),
                        |session_id| self.activate_explicit_for_session(session_id, selected),
                    )
                    .map(|skill| skill.activation().clone())
                    .map_err(ExtensionError::new)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let excluded = activations
            .iter()
            .map(|activation| activation.id.clone())
            .collect::<Vec<_>>();
        let automatic = input.session_id().map_or_else(
            || self.select_automatic(input.user_input(), &excluded),
            |session_id| {
                self.select_automatic_for_session(session_id, input.user_input(), &excluded)
            },
        );
        if let Some(selected) = automatic.map_err(ExtensionError::new)? {
            activations.push(selected.activation().clone());
        }
        Ok(activations)
    }
}

impl TurnInputContributor for SkillRuntime {
    fn contribute(
        &self,
        input: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError> {
        let snapshot = input
            .session_id()
            .map_or_else(
                || self.list(crate::SkillCatalogReload::Cached),
                |session_id| self.list_for_session(session_id),
            )
            .map_err(ExtensionError::new)?;
        let mut fragments = catalog_prompt(snapshot.as_ref())
            .into_iter()
            .collect::<Vec<_>>();
        let activated = input
            .activated_skills()
            .iter()
            .map(|frozen| {
                let activated = input.session_id().map_or_else(
                    || self.load_frozen(frozen),
                    |session_id| self.load_frozen_for_session(session_id, frozen),
                ).map_err(ExtensionError::new)?;
                let identity = format!("{}:{}", frozen.id.source, frozen.id.name);
                Ok(PromptFragment::new(
                    PromptFragmentSource::new(
                        "skill",
                        identity,
                        frozen.content_digest.as_str(),
                    ),
                    PromptFragmentLayer::Skill,
                    match frozen.reason {
                        SkillActivationReason::Explicit => PromptFragmentRetention::Required,
                        SkillActivationReason::Automatic => PromptFragmentRetention::BestEffort,
                    },
                    format!(
                        "<skill-instructions source=\"{}\" name=\"{}\" revision=\"{}\">\n{}\n</skill-instructions>",
                        escape_attribute(frozen.id.source.as_str()),
                        escape_attribute(frozen.id.name.as_str()),
                        escape_attribute(frozen.content_digest.as_str()),
                        activated.body().trim(),
                    ),
                ))
            })
            .collect::<Result<Vec<_>, ExtensionError>>()?;
        fragments.extend(activated);
        Ok(fragments)
    }
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
