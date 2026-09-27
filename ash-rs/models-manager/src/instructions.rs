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
            ("openai", "gpt-6-sol"),
            ("openai", "gpt-6-luna"),
            ("openai", "gpt-5.6-sol"),
            ("openai", "gpt-5.6-terra"),
            ("openai", "gpt-5.6-luna"),
            ("openai", "gpt-5.6"),
            ("openai", "gpt-5.5"),
            ("openai", "gpt-5.4"),
            ("openai", "gpt-5.4-mini"),
            ("openai", "gpt-5.4-nano"),
            ("openai", "gpt-5.3-codex"),
            ("openai", "gpt-5.2"),
            ("openai", "gpt-5.1"),
            ("openai", "gpt-5"),
            ("openai", "gpt-5-mini"),
            ("openai", "gpt-5-nano"),
            ("openai", "gpt-4.1"),
            ("openai", "gpt-4.1-mini"),
            ("openai", "gpt-4o"),
            ("openai", "gpt-4o-mini"),
            ("openai", "o3"),
        ],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/claude",
            "claude-guidance-v1",
            include_str!("../templates/instructions/claude.md"),
        ),
        models: &[
            ("anthropic", "claude-sonnet-4-20250514"),
            ("anthropic", "claude-fable-5-1"),
            ("anthropic", "claude-opus-5-5"),
            ("anthropic", "claude-sonnet-5"),
            ("anthropic", "claude-haiku-4-5-20251001"),
            ("anthropic", "claude-opus-4-8"),
            ("anthropic", "claude-opus-4-7"),
            ("anthropic", "claude-opus-4-6"),
            ("anthropic", "claude-sonnet-4-6"),
            ("anthropic", "claude-sonnet-4-5-20250929"),
        ],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/gemini",
            "gemini-guidance-v1",
            include_str!("../templates/instructions/gemini.md"),
        ),
        models: &[
            ("google", "gemini-3.8-flash"),
            ("google", "gemini-3.7-flash"),
            ("google", "gemini-3.6-flash"),
            ("google", "gemini-3.5-flash"),
            ("google", "gemini-3.5-flash-lite"),
            ("google", "gemini-3.1-flash-lite"),
            ("google", "gemini-3.1-pro-preview"),
            ("google", "gemini-3-flash-preview"),
        ],
    },
    InstructionGroup {
        instructions: PromptArtifact::new(
            "models-manager",
            "model/function-calling",
            "function-calling-guidance-v1",
            include_str!("../templates/instructions/function_calling.md"),
        ),
        models: &[
            ("xai", "grok-4.7"),
            ("xai", "grok-4.6"),
            ("xai", "grok-4.5"),
            ("qwen", "qwen3.8-max"),
            ("qwen", "qwen3.8-flash"),
            ("qwen", "qwen3.7-max"),
            ("qwen", "qwen3.7-plus"),
            ("qwen", "qwen3.7-flash"),
            ("qwen", "qwen3.6-plus"),
            ("qwen", "qwen3.6-flash"),
            ("qwen", "qwen3.5-plus"),
            ("qwen", "qwen3.5-flash"),
            ("qwen", "qwen3-max"),
            ("qwen", "qwen3-coder-next"),
            ("qwen", "qwen3-coder-plus"),
            ("qwen", "qwen3-coder-flash"),
            ("qwen", "qwen-plus"),
            ("kimi", "kimi-k3"),
            ("kimi", "kimi-k2.7-code"),
            ("kimi", "kimi-k2.6"),
            ("kimi", "kimi-k2.5"),
            ("deepseek", "deepseek-flash"),
            ("deepseek", "deepseek-v4-pro"),
            ("zai", "glm-5.3"),
            ("zai", "glm-5.3-flash"),
            ("zai", "glm-5.3-flashx"),
            ("zai", "glm-5.2"),
            ("zai", "glm-5.1"),
            ("zai", "glm-5-turbo"),
            ("minimax", "MiniMax-M3"),
            ("minimax", "MiniMax-M2.7"),
            ("minimax", "MiniMax-M2.7-highspeed"),
            ("minimax", "MiniMax-M2.5"),
            ("minimax", "MiniMax-M2.5-highspeed"),
            ("minimax", "MiniMax-M2.1"),
            ("minimax", "MiniMax-M2.1-highspeed"),
            ("minimax", "MiniMax-M2"),
            ("mimo", "mimo-v2.6-pro"),
            ("mimo", "mimo-v2.6-flash"),
            ("mimo", "mimo-v2.5-pro"),
        ],
    },
];

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
