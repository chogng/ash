/// Product-neutral language features available from one server incarnation.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum LanguageServerFeature {
    Hover,
    Completion,
    CompletionResolve,
    ExecuteCommand,
    Declaration,
    Definition,
    Implementation,
    TypeDefinition,
    References,
    CallHierarchy,
    TypeHierarchy,
    WorkspaceSymbols,
    Rename,
    RenamePrepare,
    CodeActions,
    CodeActionResolve,
    DocumentFormatting,
    RangeFormatting,
    OnTypeFormatting,
    SignatureHelp,
    InlayHints,
    LinkedEditingRanges,
    SemanticTokens,
    DocumentSymbols,
    CodeLens,
    CodeLensResolve,
    DocumentLinks,
    DocumentLinkResolve,
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
    pub completion_trigger_characters: Vec<String>,
    pub on_type_formatting_trigger_characters: Vec<String>,
    pub signature_help_trigger_characters: Vec<String>,
    pub signature_help_retrigger_characters: Vec<String>,
}
