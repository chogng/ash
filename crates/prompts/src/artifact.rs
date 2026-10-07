/// One immutable, compile-time embedded prompt asset.
///
/// The owning crate supplies an owner, identity, revision, and body. This shared type does not
/// decide which prompts exist, when an asset is injected, or which model message role receives it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PromptArtifact {
    owner: &'static str,
    id: &'static str,
    revision: &'static str,
    body: &'static str,
}

impl PromptArtifact {
    /// Creates a compile-time prompt asset owned by one feature or capability crate.
    ///
    /// # Panics
    ///
    /// Panics when the owner, identity, revision, or authored body is empty.
    pub const fn new(
        owner: &'static str,
        id: &'static str,
        revision: &'static str,
        body: &'static str,
    ) -> Self {
        assert!(!owner.is_empty(), "prompt owner must not be empty");
        assert!(!id.is_empty(), "prompt identity must not be empty");
        assert!(!revision.is_empty(), "prompt revision must not be empty");
        assert!(!body.is_empty(), "prompt body must not be empty");
        Self {
            owner,
            id,
            revision,
            body,
        }
    }

    /// Returns the crate or feature that owns this asset's semantics.
    pub const fn owner(&self) -> &'static str {
        self.owner
    }

    /// Returns the stable logical identifier for this asset.
    pub const fn id(&self) -> &'static str {
        self.id
    }

    /// Returns the revision that must change when prompt semantics change.
    pub const fn revision(&self) -> &'static str {
        self.revision
    }

    /// Returns the exact embedded prompt body, including its authored line ending.
    pub const fn body(&self) -> &'static str {
        self.body
    }

    /// Freezes this embedded asset into the durable instructions for one Agent Turn.
    pub fn freeze(self) -> ash_protocol::TurnInstructions {
        ash_protocol::TurnInstructions::new(self.owner, self.id, self.revision, self.body)
            .expect("PromptArtifact constructor guarantees valid Turn instructions")
    }

    /// Binds a rendered body to this asset's stable identity and revision.
    pub fn render(self, body: String) -> RenderedPrompt {
        RenderedPrompt { source: self, body }
    }
}

/// A rendered prompt body that remains bound to its source asset and revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedPrompt {
    source: PromptArtifact,
    body: String,
}

impl RenderedPrompt {
    /// Returns the embedded asset from which this body was rendered.
    pub const fn source(&self) -> PromptArtifact {
        self.source
    }

    /// Returns the rendered prompt body.
    pub fn body(&self) -> &str {
        &self.body
    }
}
