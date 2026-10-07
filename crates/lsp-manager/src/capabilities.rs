/// Product-neutral language features available from one server incarnation.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum LanguageServerFeature {
    Hover,
    Completion,
    Declaration,
    Definition,
    Implementation,
    TypeDefinition,
    References,
    CallHierarchy,
    TypeHierarchy,
    WorkspaceSymbols,
    Rename,
    CodeActions,
    DocumentFormatting,
    RangeFormatting,
    SignatureHelp,
    InlayHints,
    LinkedEditingRanges,
    SemanticTokens,
    DocumentSymbols,
    CodeLens,
    DocumentLinks,
    DocumentColors,
    FoldingRanges,
    PullDiagnostics,
    WorkspaceDiagnostics,
}

/// Canonical feature snapshot for one server process incarnation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerCapabilities {
    pub incarnation: u64,
    pub dynamic_revision: u64,
    pub features: Vec<LanguageServerFeature>,
}
