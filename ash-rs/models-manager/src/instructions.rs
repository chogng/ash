use ash_protocol::ContentDigest;
use ash_protocol::InstructionText;
use ash_protocol::ModelInstructionSelection;
use ash_protocol::ModelRef;
use ash_protocol::TurnInstructions;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::LazyLock;

/// Complete base instructions selected for one exact provider/model identity.
/// Selection does not imply that its quality or performance has been evaluated.
#[derive(Clone, Debug)]
pub struct ModelInstructionProfile {
    pub model: ModelRef,
    pub instructions: InstructionText,
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
            let profiles = model_provider_info::STATIC_MODEL_CATALOG
                .iter()
                .map(|spec| ModelInstructionProfile {
                    model: spec.model_ref(),
                    instructions: InstructionText {
                        owner: "models-manager".into(),
                        id: format!("model/{}/{}", spec.provider_id, spec.model_id),
                        revision: spec.instructions.revision.clone(),
                        body: spec.instructions.body.clone(),
                    },
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
            if profile.instructions.body.len() > 64 * 1024 {
                return Err(ModelInstructionError::InvalidProfile {
                    model: profile.model,
                    reason: "guidance exceeds 64 KiB".into(),
                });
            }
            let instructions = ash_protocol::TurnInstructions::new(
                profile.instructions.owner,
                profile.instructions.id,
                profile.instructions.revision,
                profile.instructions.body,
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

    /// Selects the complete base before a new Turn is frozen. Host-defined bases take precedence;
    /// product tasks keep their own primary text and replace only their shared Agent base.
    pub fn for_turn(&self, base: TurnInstructions, model: Option<&ModelRef>) -> TurnInstructions {
        let selection = self.resolve(model);
        let primary = base.as_text();
        let previous = match base.model_guidance() {
            Some(ModelInstructionSelection::Specialized { instructions, .. }) => Some(instructions),
            Some(ModelInstructionSelection::Generic { .. }) | None => None,
        };
        let is_base = |asset: &InstructionText| {
            (asset.owner == ash_prompts::AGENT_INSTRUCTIONS.owner()
                && asset.id == ash_prompts::AGENT_INSTRUCTIONS.id())
                || previous == Some(asset)
        };
        if !base
            .shared()
            .iter()
            .chain(std::iter::once(&primary))
            .any(is_base)
        {
            return base.with_model_guidance(ModelInstructionSelection::Generic {
                model: model.cloned(),
            });
        }
        let chosen = match &selection {
            ModelInstructionSelection::Specialized { instructions, .. } => instructions.clone(),
            ModelInstructionSelection::Generic { .. } => {
                ash_prompts::AGENT_INSTRUCTIONS.freeze().as_text()
            }
        };
        let freeze = |asset: &InstructionText| {
            TurnInstructions::new(&asset.owner, &asset.id, &asset.revision, &asset.body)
                .expect("selected instruction assets are validated")
        };
        let selected =
            |asset: &InstructionText| freeze(if is_base(asset) { &chosen } else { asset });
        let mut frozen = selected(&primary);
        for asset in base.shared() {
            frozen = frozen.with_shared(&selected(asset));
        }
        if let Some(mode) = base.mode_instructions() {
            frozen = frozen.with_mode(&freeze(mode));
        }
        frozen.with_model_guidance(selection)
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

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
