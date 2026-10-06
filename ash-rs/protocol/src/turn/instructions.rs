//! Versioned instruction assets and their immutable composition for an accepted Turn.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::error::Error;
use std::fmt;
use ts_rs::TS;

/// Immutable instructions selected before one Agent Turn is durably accepted.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnInstructions {
    owner: String,
    id: String,
    revision: String,
    body: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    shared: Vec<InstructionText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    model_guidance: Option<ModelInstructionSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    mode_instructions: Option<InstructionText>,
}

impl TurnInstructions {
    /// Creates and validates one frozen instruction snapshot.
    pub fn new(
        owner: impl Into<String>,
        id: impl Into<String>,
        revision: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<Self, InvalidTurnInstructions> {
        let instructions = Self {
            owner: owner.into(),
            id: id.into(),
            revision: revision.into(),
            body: body.into(),
            shared: Vec::new(),
            model_guidance: None,
            mode_instructions: None,
        };
        instructions.validate()?;
        Ok(instructions)
    }

    /// Validates values received through a serialized protocol boundary.
    pub fn validate(&self) -> Result<(), InvalidTurnInstructions> {
        if self.owner.trim().is_empty() {
            return Err(InvalidTurnInstructions("owner"));
        }
        if self.id.trim().is_empty() {
            return Err(InvalidTurnInstructions("id"));
        }
        if self.revision.trim().is_empty() {
            return Err(InvalidTurnInstructions("revision"));
        }
        if self.body.trim().is_empty() {
            return Err(InvalidTurnInstructions("body"));
        }
        for shared in &self.shared {
            shared.validate()?;
        }
        if let Some(mode) = &self.mode_instructions {
            mode.validate()?;
        }
        if let Some(ModelInstructionSelection::Specialized {
            instructions,
            digest,
            ..
        }) = &self.model_guidance
        {
            instructions.validate()?;
            if crate::ContentDigest::sha256(instructions.body.as_bytes()) != *digest {
                return Err(InvalidTurnInstructions("model guidance digest"));
            }
        }
        Ok(())
    }

    /// Includes a shared asset once, retaining its exact identity and revision.
    pub fn with_shared(mut self, shared: &Self) -> Self {
        for text in shared
            .shared
            .iter()
            .cloned()
            .chain(std::iter::once(shared.as_text()))
        {
            if text.id != self.id && !self.shared.iter().any(|existing| existing == &text) {
                self.shared.push(text);
            }
        }
        self
    }

    /// Records the model instruction decision made before this Turn was accepted.
    pub fn with_model_guidance(mut self, selection: ModelInstructionSelection) -> Self {
        self.model_guidance = Some(selection);
        self
    }

    /// Replaces only the approach for a delegated worker or an explicit mode change.
    /// Keeping it separate prevents copying a parent's coordinating approach into worker rules.
    pub fn with_mode(mut self, mode: &Self) -> Self {
        self.mode_instructions = Some(mode.as_text());
        self
    }

    pub fn mode_instructions(&self) -> Option<&InstructionText> {
        self.mode_instructions.as_ref()
    }

    /// Returns the frozen common assets preceding the primary instruction body.
    pub fn shared(&self) -> &[InstructionText] {
        &self.shared
    }

    pub fn model_guidance(&self) -> Option<&ModelInstructionSelection> {
        self.model_guidance.as_ref()
    }

    /// Copies one asset into the flat representation used by composed instructions.
    pub fn as_text(&self) -> InstructionText {
        InstructionText {
            owner: self.owner.clone(),
            id: self.id.clone(),
            revision: self.revision.clone(),
            body: self.body.clone(),
        }
    }

    /// Returns the capability crate that owns these instructions.
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Returns the stable logical prompt identifier.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the authored semantic revision.
    pub fn revision(&self) -> &str {
        &self.revision
    }

    /// Returns the exact model-facing instruction body.
    pub fn body(&self) -> &str {
        &self.body
    }
}

/// Identifies an invalid field in a frozen Turn instruction snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidTurnInstructions(&'static str);

impl fmt::Display for InvalidTurnInstructions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid Turn instructions field: {}", self.0)
    }
}

impl Error for InvalidTurnInstructions {}

/// One immutable asset in an instruction composition; it cannot contain nested compositions.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstructionText {
    pub owner: String,
    pub id: String,
    pub revision: String,
    pub body: String,
}

impl InstructionText {
    fn validate(&self) -> Result<(), InvalidTurnInstructions> {
        if self.owner.trim().is_empty()
            || self.id.trim().is_empty()
            || self.revision.trim().is_empty()
            || self.body.trim().is_empty()
        {
            return Err(InvalidTurnInstructions("shared asset"));
        }
        Ok(())
    }
}

/// The model guidance chosen for an invocation. Generic is an explicit supported choice.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModelInstructionSelection {
    Generic {
        model: Option<crate::ModelRef>,
    },
    Specialized {
        model: crate::ModelRef,
        instructions: InstructionText,
        digest: crate::ContentDigest,
    },
}

impl ModelInstructionSelection {
    /// The exact model selected before these instructions were frozen.
    pub fn model(&self) -> Option<&crate::ModelRef> {
        match self {
            Self::Generic { model } => model.as_ref(),
            Self::Specialized { model, .. } => Some(model),
        }
    }
}

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
