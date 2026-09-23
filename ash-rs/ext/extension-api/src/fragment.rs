/// Placement and message role for one extension context fragment.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PromptFragmentLayer {
    System,
    Product,
    Directory,
    Skill,
    /// Attributed agent content rendered as a message, never as an instruction.
    AgentMessage,
}

/// Whether Core may omit one extension fragment under context budget pressure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptFragmentRetention {
    Required,
    BestEffort,
}

/// Stable provenance used for ordering, diagnostics, and context reproducibility.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptFragmentSource {
    kind: String,
    identity: String,
    revision: String,
}

impl PromptFragmentSource {
    pub fn new(
        kind: impl Into<String>,
        identity: impl Into<String>,
        revision: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            identity: identity.into(),
            revision: revision.into(),
        }
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

/// One bounded, model-facing contribution returned by an installed extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptFragment {
    source: PromptFragmentSource,
    layer: PromptFragmentLayer,
    retention: PromptFragmentRetention,
    body: String,
}

impl PromptFragment {
    pub fn new(
        source: PromptFragmentSource,
        layer: PromptFragmentLayer,
        retention: PromptFragmentRetention,
        body: impl Into<String>,
    ) -> Self {
        Self {
            source,
            layer,
            retention,
            body: body.into(),
        }
    }

    pub fn source(&self) -> &PromptFragmentSource {
        &self.source
    }

    pub const fn layer(&self) -> PromptFragmentLayer {
        self.layer
    }

    pub const fn retention(&self) -> PromptFragmentRetention {
        self.retention
    }

    pub fn body(&self) -> &str {
        &self.body
    }
}
