use std::collections::BTreeMap;
use std::path::Path;

use ash_app_server_protocol::protocol::config::{
    AgentGrepBackendDto, ApprovalReviewModelSelectionDto, CodebaseAutomaticContextDto,
    CodebaseConfigDto, ConfigReadResult, FrontendConfigDto, LanguageServerConfigDto,
    LanguageServerModeDto, ToolSearchConfigDto, ToolSearchEmbeddingStatusDto, ToolSearchModeDto,
};
use ash_lsp_server_provider::{LanguageServerCatalogState, LanguageServerExecutionPolicy};
use ash_text_file::{TextFileAccess, TextFileDiskVersion, TextFileModifiedAt, TextFileSnapshot};

use super::{catalog_from_configuration, editor_diagnostic, language_document, language_id};
use crate::FileEditorHost;

#[test]
fn desktop_adapter_maps_editor_language_revision_and_path_without_lsp_types() {
    let mut host = FileEditorHost::default();
    host.open(TextFileSnapshot::new(
        "src/main.rs".into(),
        "fn main() {}".into(),
        TextFileDiskVersion::new(
            12,
            TextFileModifiedAt::KnownMillis(1),
            TextFileAccess::Writable,
        ),
    ));

    let document =
        language_document(Path::new("/dir"), host.active().unwrap()).expect("language document");

    assert_eq!(document.path(), Path::new("/dir/src/main.rs"));
    assert_eq!(document.language_id(), "rust");
    assert_eq!(document.revision().value(), 1);
    assert_eq!(document.text(), "fn main() {}");
    assert_eq!(language_id(ash_editor::CodeEditorLanguage::Jsonc), "jsonc");
}

#[test]
fn desktop_configuration_maps_persisted_mode_into_catalog_policy() {
    let mut language_servers = BTreeMap::new();
    language_servers.insert(
        "rust-analyzer".into(),
        LanguageServerConfigDto {
            mode: LanguageServerModeDto::Disabled,
            executable: None,
        },
    );
    let configuration = ConfigReadResult {
        time_context: Default::default(),
        model_reasoning_effort: None,
        features: vec![],
        revision: 4,
        generation: 7,
        model: None,
        approval_review_model: ApprovalReviewModelSelectionDto::Automatic,
        commit_message_model: None,
        commit_message_active_dir_authorized: false,
        issues: ash_app_server_protocol::protocol::issues::IssueConfigDto {
            auto_refresh_minutes: 10,
        },
        tool_mode: Default::default(),
        agent_grep_backend: AgentGrepBackendDto::Ripgrep,
        gui: FrontendConfigDto::default(),
        providers: BTreeMap::new(),
        mcp_servers: BTreeMap::new(),
        skill_sources: BTreeMap::new(),
        plugin_requests: BTreeMap::new(),
        hooks: BTreeMap::new(),
        language_servers,
        tool_search: ToolSearchConfigDto {
            mode: ToolSearchModeDto::Lexical,
            embedding_model: None,
            embedding_status: ToolSearchEmbeddingStatusDto::Disabled,
        },
        codebase: CodebaseConfigDto {
            models: None,
            automatic_context: CodebaseAutomaticContextDto::Off,
        },
        exec_policy_rules: Vec::new(),
        tui: FrontendConfigDto::default(),
    };

    let catalog = catalog_from_configuration(&configuration);
    let resolution = catalog
        .resolve(
            &ash_install_context::InstallContext::current(),
            LanguageServerExecutionPolicy::Allowed,
            Path::new("/dir"),
        )
        .expect("catalog");

    assert!(resolution.definitions().is_empty());
    assert_eq!(
        resolution.entries()[0].state(),
        &LanguageServerCatalogState::Disabled
    );
}

#[test]
fn desktop_configuration_does_not_start_unconfigured_language_servers() {
    let configuration = ConfigReadResult {
        time_context: Default::default(),
        model_reasoning_effort: None,
        features: vec![],
        revision: 1,
        generation: 1,
        model: None,
        approval_review_model: ApprovalReviewModelSelectionDto::Automatic,
        commit_message_model: None,
        commit_message_active_dir_authorized: false,
        issues: ash_app_server_protocol::protocol::issues::IssueConfigDto {
            auto_refresh_minutes: 10,
        },
        tool_mode: Default::default(),
        agent_grep_backend: AgentGrepBackendDto::Ripgrep,
        gui: FrontendConfigDto::default(),
        providers: BTreeMap::new(),
        mcp_servers: BTreeMap::new(),
        skill_sources: BTreeMap::new(),
        plugin_requests: BTreeMap::new(),
        hooks: BTreeMap::new(),
        language_servers: BTreeMap::new(),
        tool_search: ToolSearchConfigDto {
            mode: ToolSearchModeDto::Lexical,
            embedding_model: None,
            embedding_status: ToolSearchEmbeddingStatusDto::Disabled,
        },
        codebase: CodebaseConfigDto {
            models: None,
            automatic_context: CodebaseAutomaticContextDto::Off,
        },
        exec_policy_rules: Vec::new(),
        tui: FrontendConfigDto::default(),
    };

    let catalog = catalog_from_configuration(&configuration);
    let resolution = catalog
        .resolve(
            &ash_install_context::InstallContext::current(),
            LanguageServerExecutionPolicy::Allowed,
            Path::new("/dir"),
        )
        .expect("catalog");

    assert!(resolution.definitions().is_empty());
    assert!(
        resolution
            .entries()
            .iter()
            .all(|entry| entry.state() == &LanguageServerCatalogState::Disabled)
    );
}

#[test]
fn desktop_adapter_projects_language_diagnostics_without_lsp_presentation_types() {
    let diagnostic = ash_lsp_manager::LanguageDiagnostic {
        range: ash_lsp_manager::LanguageTextRange::new(4..9),
        severity: ash_lsp_manager::LanguageDiagnosticSeverity::Warning,
        message: "unused value".into(),
        source: Some("rustc".into()),
        code: Some("unused_variables".into()),
    };

    let projected = editor_diagnostic(&diagnostic);

    assert_eq!(projected.range(), 4..9);
    assert_eq!(
        projected.severity(),
        ash_editor::CodeEditorDiagnosticSeverity::Warning
    );
    assert_eq!(projected.message(), "unused value");
    assert_eq!(projected.source(), Some("rustc"));
    assert_eq!(projected.code(), Some("unused_variables"));
}
