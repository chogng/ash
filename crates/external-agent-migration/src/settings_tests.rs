use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use super::claude_effective_settings;
use super::parse_json;
use super::parse_toml;
use crate::AgentImportDiagnosticCode;
use crate::AgentImportLocation;
use crate::source::Source;

fn write(home: &Path, name: &str, text: &str) {
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::write(home.join(".claude").join(name), text).unwrap();
}

#[test]
fn missing_settings_yield_none() {
    let temp = TempDir::new().unwrap();
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    assert!(claude_effective_settings(&mut source).is_none());
    assert!(source.diagnostics.is_empty());
}

#[test]
fn malformed_json_is_invalid_content() {
    assert_eq!(
        parse_json("{not json"),
        Err(AgentImportDiagnosticCode::InvalidContent)
    );
}

#[test]
fn parses_codex_config() {
    let value = parse_toml("model = \"o4\"\n").unwrap();
    assert_eq!(value.get("model").and_then(toml::Value::as_str), Some("o4"));
}

#[test]
fn merges_local_overlay_and_retains_both_source_documents() {
    let temp = TempDir::new().unwrap();
    write(
        temp.path(),
        "settings.json",
        r#"{"env":{"A":"1"},"model":"base"}"#,
    );
    write(
        temp.path(),
        "settings.local.json",
        r#"{"env":{"B":"2"},"model":"local"}"#,
    );
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    let settings = claude_effective_settings(&mut source).unwrap();
    assert_eq!(
        settings.effective,
        json!({"env":{"A":"1","B":"2"},"model":"local"})
    );
    assert_eq!(settings.documents.len(), 2);
    assert_eq!(settings.documents[0].value["model"], "base");
    assert_eq!(
        settings.paths(),
        [
            temp.path()
                .join(".claude/settings.json")
                .canonicalize()
                .unwrap(),
            temp.path()
                .join(".claude/settings.local.json")
                .canonicalize()
                .unwrap()
        ]
    );
}

#[test]
fn local_overlay_without_base_becomes_effective() {
    let temp = TempDir::new().unwrap();
    write(temp.path(), "settings.local.json", r#"{"model":"local"}"#);
    let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
    let settings = claude_effective_settings(&mut source).unwrap();
    assert_eq!(settings.effective, json!({"model":"local"}));
    assert_eq!(
        settings.paths(),
        [temp
            .path()
            .join(".claude/settings.local.json")
            .canonicalize()
            .unwrap()]
    );
}

#[test]
fn invalid_file_is_diagnosed_without_discarding_the_valid_sibling() {
    for invalid_name in ["settings.json", "settings.local.json"] {
        let temp = TempDir::new().unwrap();
        for name in ["settings.json", "settings.local.json"] {
            write(
                temp.path(),
                name,
                if name == invalid_name {
                    "{broken"
                } else {
                    r#"{"model":"valid"}"#
                },
            );
        }
        let mut source = Source::new(AgentImportLocation::claude_user(temp.path())).unwrap();
        let settings = claude_effective_settings(&mut source).unwrap();
        assert_eq!(settings.effective, json!({"model":"valid"}));
        assert_eq!(settings.documents.len(), 1);
        assert_eq!(source.diagnostics.len(), 1);
        assert_eq!(
            source.diagnostics[0].relative_path(),
            Path::new(".claude").join(invalid_name)
        );
        assert_eq!(
            source.diagnostics[0].code(),
            AgentImportDiagnosticCode::InvalidContent
        );
    }
}

#[test]
fn nested_json_and_toml_documents_are_bounded() {
    let depth = crate::source::MAX_DOCUMENT_DEPTH + 2;
    let json = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
    assert_eq!(
        parse_json(&json),
        Err(AgentImportDiagnosticCode::LimitExceeded)
    );
    let toml = format!("[{}]\nvalue=1\n", vec!["a"; depth].join("."));
    assert_eq!(
        parse_toml(&toml),
        Err(AgentImportDiagnosticCode::LimitExceeded)
    );
}

#[test]
fn document_node_count_is_bounded() {
    let values = vec!["0"; crate::source::MAX_DOCUMENT_NODES].join(",");
    assert_eq!(
        parse_json(&format!("[{values}]")),
        Err(AgentImportDiagnosticCode::LimitExceeded)
    );
    assert_eq!(
        parse_toml(&format!("values=[{values}]")),
        Err(AgentImportDiagnosticCode::LimitExceeded)
    );
}
