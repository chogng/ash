use ash_context_fragments::ContextFragment;

/// Placement and message role an extension can request for a context fragment.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PromptFragmentLayer {
    System,
    Product,
    Directory,
    Skill,
    /// Attributed agent content rendered as a message, never as an instruction.
    AgentMessage,
}

/// One bounded, model-facing contribution returned by an installed extension.
pub type PromptFragment = ContextFragment<PromptFragmentLayer>;
