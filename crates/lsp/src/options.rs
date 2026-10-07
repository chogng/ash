use std::sync::Arc;
use std::time::Duration;

use lsp_types::{
    CallHierarchyClientCapabilities, ClientCapabilities, ClientInfo,
    CodeActionCapabilityResolveSupport, CodeActionClientCapabilities, CodeLensClientCapabilities,
    CompletionClientCapabilities, CompletionItemCapability, CompletionItemCapabilityResolveSupport,
    DiagnosticClientCapabilities, DiagnosticWorkspaceClientCapabilities,
    DocumentColorClientCapabilities, DocumentFormattingClientCapabilities,
    DocumentLinkClientCapabilities, DocumentRangeFormattingClientCapabilities,
    DocumentSymbolClientCapabilities, DynamicRegistrationClientCapabilities,
    ExecuteCommandClientCapabilities, FailureHandlingKind, FoldingRangeClientCapabilities,
    GeneralClientCapabilities, GotoCapability, HoverClientCapabilities,
    InlayHintClientCapabilities, LinkedEditingRangeClientCapabilities, MarkupKind,
    ParameterInformationSettings, PositionEncodingKind, PublishDiagnosticsClientCapabilities,
    ReferenceClientCapabilities, RenameClientCapabilities, ResourceOperationKind,
    SemanticTokenModifier, SemanticTokenType, SemanticTokensClientCapabilities,
    SemanticTokensClientCapabilitiesRequests, SemanticTokensFullOptions,
    SignatureHelpClientCapabilities, SignatureInformationSettings, TextDocumentClientCapabilities,
    TextDocumentSyncClientCapabilities, TokenFormat, TypeHierarchyClientCapabilities, Uri,
    WindowClientCapabilities, WorkspaceClientCapabilities, WorkspaceEditClientCapabilities,
    WorkspaceFolder, WorkspaceSymbolClientCapabilities,
};
use serde_json::Value;

use crate::{LanguageServerHost, NoopLanguageServerHost};

/// Deadlines applied independently to initialization, normal requests, and shutdown.
#[derive(Clone, Copy, Debug)]
pub struct LanguageServerTimeouts {
    pub initialize: Duration,
    pub request: Duration,
    pub shutdown: Duration,
}

impl Default for LanguageServerTimeouts {
    fn default() -> Self {
        Self {
            initialize: Duration::from_secs(10),
            request: Duration::from_secs(30),
            shutdown: Duration::from_secs(5),
        }
    }
}

/// Client identity, workspace context, capabilities, callbacks, and deadlines for one server.
#[derive(Clone)]
pub struct LanguageServerOptions {
    pub(crate) client_info: ClientInfo,
    pub(crate) root_uri: Option<Uri>,
    pub(crate) workspace_folders: Option<Vec<WorkspaceFolder>>,
    pub(crate) initialization_options: Option<Value>,
    pub(crate) capabilities: ClientCapabilities,
    pub(crate) locale: Option<String>,
    pub(crate) host: Arc<dyn LanguageServerHost>,
    pub(crate) timeouts: LanguageServerTimeouts,
}

impl std::fmt::Debug for LanguageServerOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LanguageServerOptions")
            .field("client_info", &self.client_info)
            .field("root_uri", &self.root_uri)
            .field("workspace_folders", &self.workspace_folders)
            .field("initialization_options", &self.initialization_options)
            .field("capabilities", &self.capabilities)
            .field("locale", &self.locale)
            .field("host", &"<dyn LanguageServerHost>")
            .field("timeouts", &self.timeouts)
            .finish()
    }
}

impl LanguageServerOptions {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            client_info: ClientInfo {
                name: name.into(),
                version: Some(version.into()),
            },
            root_uri: None,
            workspace_folders: None,
            initialization_options: None,
            capabilities: default_client_capabilities(),
            locale: None,
            host: Arc::new(NoopLanguageServerHost),
            timeouts: LanguageServerTimeouts::default(),
        }
    }

    pub fn with_root_uri(mut self, root_uri: Uri) -> Self {
        self.root_uri = Some(root_uri);
        self
    }

    pub fn with_workspace_folders(mut self, workspace_folders: Vec<WorkspaceFolder>) -> Self {
        self.workspace_folders = Some(workspace_folders);
        self
    }

    pub fn with_initialization_options(mut self, initialization_options: Value) -> Self {
        self.initialization_options = Some(initialization_options);
        self
    }

    pub fn with_capabilities(mut self, capabilities: ClientCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    pub fn with_locale(mut self, locale: impl Into<String>) -> Self {
        self.locale = Some(locale.into());
        self
    }

    pub fn with_host(mut self, host: Arc<dyn LanguageServerHost>) -> Self {
        self.host = host;
        self
    }

    pub fn with_timeouts(mut self, timeouts: LanguageServerTimeouts) -> Self {
        self.timeouts = timeouts;
        self
    }
}

fn default_client_capabilities() -> ClientCapabilities {
    ClientCapabilities {
        workspace: Some(WorkspaceClientCapabilities {
            configuration: Some(true),
            workspace_folders: Some(true),
            symbol: Some(WorkspaceSymbolClientCapabilities {
                dynamic_registration: Some(true),
                ..Default::default()
            }),
            execute_command: Some(ExecuteCommandClientCapabilities {
                dynamic_registration: Some(true),
            }),
            diagnostic: Some(DiagnosticWorkspaceClientCapabilities {
                refresh_support: Some(false),
            }),
            workspace_edit: Some(WorkspaceEditClientCapabilities {
                document_changes: Some(true),
                resource_operations: Some(vec![
                    ResourceOperationKind::Create,
                    ResourceOperationKind::Rename,
                    ResourceOperationKind::Delete,
                ]),
                failure_handling: Some(FailureHandlingKind::Undo),
                normalizes_line_endings: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        }),
        text_document: Some(TextDocumentClientCapabilities {
            synchronization: Some(TextDocumentSyncClientCapabilities {
                dynamic_registration: Some(false),
                will_save: Some(false),
                will_save_wait_until: Some(false),
                did_save: Some(true),
            }),
            publish_diagnostics: Some(PublishDiagnosticsClientCapabilities::default()),
            diagnostic: Some(DiagnosticClientCapabilities {
                dynamic_registration: Some(true),
                related_document_support: Some(false),
            }),
            completion: Some(CompletionClientCapabilities {
                dynamic_registration: Some(true),
                completion_item: Some(CompletionItemCapability {
                    snippet_support: Some(true),
                    commit_characters_support: Some(true),
                    documentation_format: Some(vec![MarkupKind::Markdown, MarkupKind::PlainText]),
                    preselect_support: Some(true),
                    insert_replace_support: Some(true),
                    resolve_support: Some(CompletionItemCapabilityResolveSupport {
                        properties: vec!["detail".into(), "documentation".into()],
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            hover: Some(HoverClientCapabilities {
                dynamic_registration: Some(true),
                content_format: Some(vec![MarkupKind::Markdown, MarkupKind::PlainText]),
            }),
            references: Some(ReferenceClientCapabilities {
                dynamic_registration: Some(true),
            }),
            document_symbol: Some(DocumentSymbolClientCapabilities {
                dynamic_registration: Some(true),
                hierarchical_document_symbol_support: Some(true),
                ..Default::default()
            }),
            code_lens: Some(CodeLensClientCapabilities {
                dynamic_registration: Some(true),
            }),
            document_link: Some(DocumentLinkClientCapabilities {
                dynamic_registration: Some(true),
                tooltip_support: Some(true),
            }),
            color_provider: Some(DocumentColorClientCapabilities {
                dynamic_registration: Some(true),
            }),
            folding_range: Some(FoldingRangeClientCapabilities {
                dynamic_registration: Some(true),
                range_limit: Some(5_000),
                line_folding_only: Some(true),
                ..Default::default()
            }),
            formatting: Some(DocumentFormattingClientCapabilities {
                dynamic_registration: Some(true),
            }),
            range_formatting: Some(DocumentRangeFormattingClientCapabilities {
                dynamic_registration: Some(true),
            }),
            declaration: Some(GotoCapability {
                dynamic_registration: Some(true),
                link_support: Some(true),
            }),
            definition: Some(GotoCapability {
                dynamic_registration: Some(true),
                link_support: Some(true),
            }),
            type_definition: Some(GotoCapability {
                dynamic_registration: Some(true),
                link_support: Some(true),
            }),
            implementation: Some(GotoCapability {
                dynamic_registration: Some(true),
                link_support: Some(true),
            }),
            signature_help: Some(SignatureHelpClientCapabilities {
                dynamic_registration: Some(true),
                signature_information: Some(SignatureInformationSettings {
                    documentation_format: Some(vec![MarkupKind::Markdown, MarkupKind::PlainText]),
                    parameter_information: Some(ParameterInformationSettings {
                        label_offset_support: Some(true),
                    }),
                    active_parameter_support: Some(true),
                }),
                context_support: Some(true),
            }),
            inlay_hint: Some(InlayHintClientCapabilities {
                dynamic_registration: Some(true),
                resolve_support: None,
            }),
            linked_editing_range: Some(LinkedEditingRangeClientCapabilities {
                dynamic_registration: Some(true),
            }),
            call_hierarchy: Some(CallHierarchyClientCapabilities {
                dynamic_registration: Some(true),
            }),
            type_hierarchy: Some(TypeHierarchyClientCapabilities {
                dynamic_registration: Some(true),
            }),
            rename: Some(RenameClientCapabilities {
                dynamic_registration: Some(true),
                prepare_support: Some(true),
                honors_change_annotations: Some(false),
                ..Default::default()
            }),
            code_action: Some(CodeActionClientCapabilities {
                dynamic_registration: Some(true),
                is_preferred_support: Some(true),
                disabled_support: Some(true),
                data_support: Some(true),
                resolve_support: Some(CodeActionCapabilityResolveSupport {
                    properties: vec!["edit".into()],
                }),
                honors_change_annotations: Some(false),
                ..Default::default()
            }),
            semantic_tokens: Some(SemanticTokensClientCapabilities {
                dynamic_registration: Some(true),
                requests: SemanticTokensClientCapabilitiesRequests {
                    range: Some(false),
                    full: Some(SemanticTokensFullOptions::Bool(true)),
                },
                token_types: semantic_token_types(),
                token_modifiers: semantic_token_modifiers(),
                formats: vec![TokenFormat::RELATIVE],
                overlapping_token_support: Some(false),
                multiline_token_support: Some(false),
                server_cancel_support: Some(true),
                augments_syntax_tokens: Some(true),
            }),
            document_highlight: Some(DynamicRegistrationClientCapabilities {
                dynamic_registration: Some(false),
            }),
            ..Default::default()
        }),
        general: Some(GeneralClientCapabilities {
            position_encodings: Some(vec![
                PositionEncodingKind::UTF8,
                PositionEncodingKind::UTF16,
            ]),
            ..Default::default()
        }),
        window: Some(WindowClientCapabilities {
            work_done_progress: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn semantic_token_types() -> Vec<SemanticTokenType> {
    vec![
        SemanticTokenType::NAMESPACE,
        SemanticTokenType::TYPE,
        SemanticTokenType::CLASS,
        SemanticTokenType::ENUM,
        SemanticTokenType::INTERFACE,
        SemanticTokenType::STRUCT,
        SemanticTokenType::TYPE_PARAMETER,
        SemanticTokenType::PARAMETER,
        SemanticTokenType::VARIABLE,
        SemanticTokenType::PROPERTY,
        SemanticTokenType::ENUM_MEMBER,
        SemanticTokenType::EVENT,
        SemanticTokenType::FUNCTION,
        SemanticTokenType::METHOD,
        SemanticTokenType::MACRO,
        SemanticTokenType::KEYWORD,
        SemanticTokenType::MODIFIER,
        SemanticTokenType::COMMENT,
        SemanticTokenType::STRING,
        SemanticTokenType::NUMBER,
        SemanticTokenType::REGEXP,
        SemanticTokenType::OPERATOR,
        SemanticTokenType::DECORATOR,
    ]
}

fn semantic_token_modifiers() -> Vec<SemanticTokenModifier> {
    vec![
        SemanticTokenModifier::DECLARATION,
        SemanticTokenModifier::DEFINITION,
        SemanticTokenModifier::READONLY,
        SemanticTokenModifier::STATIC,
        SemanticTokenModifier::DEPRECATED,
        SemanticTokenModifier::ABSTRACT,
        SemanticTokenModifier::ASYNC,
        SemanticTokenModifier::MODIFICATION,
        SemanticTokenModifier::DOCUMENTATION,
        SemanticTokenModifier::DEFAULT_LIBRARY,
    ]
}
