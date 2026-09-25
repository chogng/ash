use ash_prompts::PromptArtifact;
use ash_protocol::ContentDigest;
use ash_protocol::ModelId;
use ash_protocol::ModelInstructionSelection;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::LazyLock;

/// A code-owned instruction asset selected for one exact provider/model identity.
/// Selection does not imply that its quality or performance has been evaluated.
#[derive(Clone, Debug)]
pub struct ModelInstructionProfile {
    pub model: ModelRef,
    pub instructions: PromptArtifact,
}

/// Immutable, indexed model guidance. It does not load files, select models, or grant tools.
#[derive(Clone, Debug, Default)]
pub struct ModelInstructionCatalog {
    profiles: HashMap<ModelRef, ModelInstructionSelection>,
}

impl ModelInstructionCatalog {
    /// Returns the process-shared initial guidance registered for built-in model identities.
    /// `default()` remains an empty catalog for an explicit generic-only configuration.
    pub fn built_in() -> Arc<Self> {
        static CATALOG: LazyLock<Arc<ModelInstructionCatalog>> = LazyLock::new(|| {
            let profiles = BUILT_INS.iter().flat_map(|group| {
                group
                    .models
                    .iter()
                    .map(move |(provider, model)| ModelInstructionProfile {
                        model: ModelRef::new(
                            ProviderId::new(*provider).expect("built-in provider ID is valid"),
                            ModelId::new(*model).expect("built-in model ID is valid"),
                        ),
                        instructions: group.instructions,
                    })
            });
            Arc::new(
                ModelInstructionCatalog::new(profiles)
                    .expect("built-in model instruction profiles are valid"),
            )
        });
        Arc::clone(&CATALOG)
    }

    /// Validates and freezes profiles once, before they are used by Agent startup.
    pub fn new(
        profiles: impl IntoIterator<Item = ModelInstructionProfile>,
    ) -> Result<Self, ModelInstructionError> {
        let mut catalog = Self::default();
        for profile in profiles {
            let key = profile.model.clone();
            if profile.instructions.body().len() > 64 * 1024 {
                return Err(ModelInstructionError::InvalidProfile {
                    model: profile.model,
                    reason: "guidance exceeds 64 KiB".into(),
                });
            }
            let instructions = ash_protocol::TurnInstructions::new(
                profile.instructions.owner(),
                profile.instructions.id(),
                profile.instructions.revision(),
                profile.instructions.body(),
            )
            .map_err(|error| ModelInstructionError::InvalidProfile {
                model: profile.model.clone(),
                reason: error.to_string(),
            })?
            .as_text();
            let selection = ModelInstructionSelection::Specialized {
                model: profile.model,
                digest: ContentDigest::sha256(instructions.body.as_bytes()),
                instructions,
            };
            if catalog.profiles.insert(key.clone(), selection).is_some() {
                return Err(ModelInstructionError::DuplicateModel(key));
            }
        }
        Ok(catalog)
    }

    /// Records an exact specialization, or the normal shared behavior when none is registered.
    pub fn resolve(&self, model: Option<&ModelRef>) -> ModelInstructionSelection {
        if let Some(model) = model {
            if let Some(selection) = self.profiles.get(model) {
                return selection.clone();
            }
        }
        ModelInstructionSelection::Generic {
            model: model.cloned(),
        }
    }
}

/// A duplicate or invalid profile rejected before an Agent can select it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelInstructionError {
    DuplicateModel(ModelRef),
    InvalidProfile { model: ModelRef, reason: String },
}

impl fmt::Display for ModelInstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateModel(model) => write!(
                formatter,
                "duplicate model instructions for {}/{}",
                model.provider, model.model
            ),
            Self::InvalidProfile { model, reason } => write!(
                formatter,
                "invalid model instructions for {}/{}: {reason}",
                model.provider, model.model
            ),
        }
    }
}

impl std::error::Error for ModelInstructionError {}

struct InstructionGroup {
    instructions: PromptArtifact,
    models: &'static [(&'static str, &'static str)],
}

// These are exact registrations, not prefix or provider-wide matching rules.
// Keep model identities aligned with model-provider-config's static catalog.
const BUILT_INS: &[InstructionGroup] = &[
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/gpt",
            "gpt-guidance-v1",
            include_str!("../templates/instructions/gpt.md"),
        ),
        models: &[
            ("openai", "gpt-6-astra"),
            ("openai", "gpt-5.6"),
            ("openai", "gpt-5.6-sol"),
            ("openai", "gpt-5.6-terra"),
            ("openai", "gpt-5.6-luna"),
            ("openai", "gpt-5.5"),
        ],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/claude",
            "claude-guidance-v1",
            include_str!("../templates/instructions/claude.md"),
        ),
        models: &[("anthropic", "claude-sonnet-4-20250514")],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/gemini",
            "gemini-guidance-v1",
            include_str!("../templates/instructions/gemini.md"),
        ),
        models: &[("google", "gemini-3.6-flash")],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/function-calling",
            "function-calling-guidance-v1",
            include_str!("../templates/instructions/function_calling.md"),
        ),
        models: &[
            ("xai", "grok-4.5"),
            ("qwen", "qwen-plus"),
            ("kimi", "kimi-k2.6"),
            ("kimi", "kimi-k2.7-code"),
            ("deepseek", "deepseek-v4-pro"),
            ("zai", "glm-5.1"),
            ("minimax", "MiniMax-M3"),
            ("mimo", "mimo-v2.5-pro"),
        ],
    },
];

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
