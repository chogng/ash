use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use super::codex_mcp_servers;
use super::normalize_mcp_servers;
use super::parse_env_placeholder;
use crate::AgentImportLocation;
use crate::plan::ExternalMcpDefinition;
use crate::plan::McpServerUnsupported;
use crate::source::Source;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn no_disabled() -> BTreeSet<String> {
    BTreeSet::new()
}

#[test]
fn parse_env_placeholder_accepts_valid_names_and_defaults() {
    assert_eq!(parse_env_placeholder("${TOKEN}").as_deref(), Some("TOKEN"));
    assert_eq!(
        parse_env_placeholder("${TOKEN:-fallback}").as_deref(),
        Some("TOKEN")
    );
    assert_eq!(parse_env_placeholder("${_A1}").as_deref(), Some("_A1"));
    assert_eq!(parse_env_placeholder("${1BAD}"), None);
    assert_eq!(parse_env_placeholder("${A B}"), None);
    assert_eq!(parse_env_placeholder("no placeholder"), None);
    assert_eq!(parse_env_placeholder("${A${B}}"), None);
}

#[test]
fn collect_reads_mcp_json_and_project_config_with_later_file_wins() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("repo");
    write(
        &root.join(".mcp.json"),
        r#"{"mcpServers": {"fs": {"command": "fs"}}}"#,
    );
    write(
        &root.join(".claude.json"),
        r#"{"mcpServers": {"fs": {"command": "ignored"}}}"#,
    );

    let servers = collected(&root, None);
    assert_eq!(servers.len(), 1);
    // The external layout reads `.mcp.json` first and `.claude.json` second, so the later
    // root-level entry overwrites the earlier one.
    assert_eq!(servers.get("fs").unwrap(), &json!({"command": "ignored"}));
}

#[test]
fn collect_resolves_matching_project_entry_by_canonical_path() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("repo");
    fs::create_dir_all(&root).unwrap();
    let canonical = root.canonicalize().unwrap();
    write(
        &root.join(".claude.json"),
        &format!(
            r#"{{"mcpServers": {{"root": {{"command": "root"}}}}, "projects": {{ "{}": {{"mcpServers": {{"proj": {{"command": "proj"}}}}}} }}}}"#,
            canonical.display()
        ),
    );

    let servers = collected(&root, None);
    assert!(servers.contains_key("proj"));
}

#[test]
fn collect_prefers_home_project_servers_only_for_missing_names() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let root = home.join("repo");
    fs::create_dir_all(&root).unwrap();
    let external_agent_home = home.join(".claude");
    let canonical = root.canonicalize().unwrap();
    write(
        &external_agent_home.parent().unwrap().join(".claude.json"),
        &format!(
            r#"{{"mcpServers": {{"home": {{"command": "home"}}}}, "projects": {{ "{}": {{"mcpServers": {{"shared": {{"command": "from-home"}}, "home-project": {{"command": "hp"}}}}}} }}}}"#,
            canonical.display()
        ),
    );
    write(
        &root.join(".mcp.json"),
        r#"{"mcpServers": {"shared": {"command": "from-root"}}}"#,
    );

    let servers = collected(&root, Some(&external_agent_home));
    // Root-level home servers are not part of project-scope detection; only the matching
    // project entry from the home config joins the source root servers.
    assert_eq!(
        servers.get("shared").unwrap(),
        &json!({"command": "from-root"})
    );
    assert!(servers.contains_key("home-project"));
    assert_eq!(servers.len(), 2);
}

#[test]
fn normalize_marks_disabled_servers() {
    let servers = BTreeMap::from([
        (
            "explicit".to_string(),
            json!({"command": "x", "disabled": true}),
        ),
        (
            "flag".to_string(),
            json!({"command": "x", "enabled": false}),
        ),
    ]);
    let normalized = normalize_mcp_servers(servers, &[], &no_disabled());
    assert!(
        normalized
            .iter()
            .all(|server| server.definition == Err(McpServerUnsupported::Disabled))
    );
}

#[test]
fn normalize_respects_enabled_allowlist() {
    let servers = BTreeMap::from([
        ("kept".to_string(), json!({"command": "a"})),
        ("dropped".to_string(), json!({"command": "b"})),
    ]);
    let normalized = normalize_mcp_servers(servers, &["kept".to_string()], &no_disabled());
    assert_eq!(normalized.len(), 2);
    let dropped = normalized
        .iter()
        .find(|server| server.name == "dropped")
        .unwrap();
    assert_eq!(dropped.definition, Err(McpServerUnsupported::Disabled));
}

#[test]
fn normalize_stdio_server_with_env_placeholders() {
    let servers = BTreeMap::from([
        (
            "ok".to_string(),
            json!({"command": "srv", "args": ["--x"], "env": {"KEY": "value", "PASS": "${PASS}"}}),
        ),
        (
            "embedded".to_string(),
            json!({"command": "srv", "args": ["--token=${TOKEN}"]}),
        ),
    ]);
    let normalized = normalize_mcp_servers(servers, &[], &no_disabled());

    let ok = normalized
        .iter()
        .find(|server| server.name == "ok")
        .unwrap();
    assert_eq!(
        ok.definition,
        Ok(ExternalMcpDefinition::Stdio {
            command: "srv".to_string(),
            args: vec!["--x".to_string()],
            env: BTreeMap::from([("KEY".to_string(), "value".to_string())]),
            env_vars: vec!["PASS".to_string()],
        })
    );

    let embedded = normalized
        .iter()
        .find(|server| server.name == "embedded")
        .unwrap();
    assert_eq!(
        embedded.definition,
        Err(McpServerUnsupported::EnvPlaceholder)
    );
}

#[test]
fn normalize_http_server_with_headers() {
    let servers = BTreeMap::from([
        (
            "web".to_string(),
            json!({
                "type": "http",
                "url": "https://example.test",
                "headers": {
                    "Authorization": "Bearer ${TOKEN}",
                    "X-Env": "${HEADER_VAR}",
                    "X-Static": "v"
                }
            }),
        ),
        (
            "embedded".to_string(),
            json!({
                "type": "http",
                "url": "https://example.test",
                "headers": {"X-Bad": "prefix-${V}"}
            }),
        ),
    ]);
    let normalized = normalize_mcp_servers(servers, &[], &no_disabled());
    let web = normalized
        .iter()
        .find(|server| server.name == "web")
        .unwrap();
    assert_eq!(
        web.definition,
        Ok(ExternalMcpDefinition::Http {
            url: "https://example.test".to_string(),
            headers: BTreeMap::from([("X-Static".to_string(), "v".to_string())]),
            env_headers: BTreeMap::from([("X-Env".to_string(), "HEADER_VAR".to_string())]),
            bearer_token_env_var: Some("TOKEN".to_string()),
        })
    );
    let embedded = normalized
        .iter()
        .find(|server| server.name == "embedded")
        .unwrap();
    assert_eq!(
        embedded.definition,
        Err(McpServerUnsupported::EnvPlaceholder)
    );
}

#[test]
fn normalize_rejects_transport_mismatch_and_missing_endpoint() {
    let servers = BTreeMap::from([
        (
            "wrong-transport".to_string(),
            json!({"type": "sse", "url": "https://example.test"}),
        ),
        ("empty".to_string(), json!({"type": "stdio"})),
    ]);
    let normalized = normalize_mcp_servers(servers, &[], &no_disabled());
    // BTreeMap iteration is alphabetical: "empty" sorts before "wrong-transport".
    assert_eq!(
        normalized[0].definition,
        Err(McpServerUnsupported::MissingEndpoint)
    );
    assert_eq!(
        normalized[1].definition,
        Err(McpServerUnsupported::UnsupportedTransport)
    );
}

#[test]
fn codex_mcp_servers_reads_toml_table() {
    let config: toml::Value = toml::from_str(
        r#"
[mcp_servers.fs]
command = "fsrv"
args = ["--fast"]
env = { KEY = "value" }
env_vars = ["PASS"]

[mcp_servers.web]
url = "https://example.test"
bearer_token_env_var = "TOKEN"

[mcp_servers.broken]
startup_timeout_sec = 5
"#,
    )
    .unwrap();

    let servers = codex_mcp_servers(&config);
    assert_eq!(servers.len(), 3);
    let fs_server = servers.iter().find(|server| server.name == "fs").unwrap();
    assert_eq!(
        fs_server.definition,
        Ok(ExternalMcpDefinition::Stdio {
            command: "fsrv".to_string(),
            args: vec!["--fast".to_string()],
            env: BTreeMap::from([("KEY".to_string(), "value".to_string())]),
            env_vars: vec!["PASS".to_string()],
        })
    );
    let web = servers.iter().find(|server| server.name == "web").unwrap();
    assert_eq!(
        web.definition,
        Ok(ExternalMcpDefinition::Http {
            url: "https://example.test".to_string(),
            headers: BTreeMap::new(),
            env_headers: BTreeMap::new(),
            bearer_token_env_var: Some("TOKEN".to_string()),
        })
    );
    let broken = servers
        .iter()
        .find(|server| server.name == "broken")
        .unwrap();
    assert_eq!(
        broken.definition,
        Err(McpServerUnsupported::MissingEndpoint)
    );
}

fn collected(root: &Path, external_home: Option<&Path>) -> BTreeMap<String, serde_json::Value> {
    let mut source = Source::new(AgentImportLocation::claude_project(root)).unwrap();
    let mut home = external_home
        .map(|path| Source::new(AgentImportLocation::claude_user(path.parent().unwrap())).unwrap());
    super::collect_mcp_servers(&mut source, home.as_mut()).servers
}
