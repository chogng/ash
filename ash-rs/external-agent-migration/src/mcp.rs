use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value as JsonValue;

use crate::ImportItemKind;
use crate::plan::ExternalMcpDefinition;
use crate::plan::ExternalMcpServer;
use crate::plan::McpServerUnsupported;
use crate::settings::parse_json;
use crate::source::Source;
use std::path::PathBuf;

pub(crate) const MCP_CONFIG_FILE: &str = ".mcp.json";
pub(crate) const CLAUDE_PROJECT_CONFIG_FILE: &str = ".claude.json";

pub(crate) struct McpCollection {
    pub(crate) servers: BTreeMap<String, JsonValue>,
    pub(crate) paths: Vec<PathBuf>,
}

/// Reads each checked source independently and retains the files used for precedence decisions.
pub(crate) fn collect_mcp_servers(source: &mut Source, home: Option<&mut Source>) -> McpCollection {
    let source_root = source.root().to_path_buf();
    let mut collected = McpCollection {
        servers: BTreeMap::new(),
        paths: Vec::new(),
    };
    for relative in [MCP_CONFIG_FILE, CLAUDE_PROJECT_CONFIG_FILE] {
        let Some(document) =
            source.read(Path::new(relative), ImportItemKind::McpServers, parse_json)
        else {
            continue;
        };
        append_mcp_servers_from_value(
            &document.value,
            &mut collected.servers,
            McpServerMerge::Overwrite,
        );
        if relative == CLAUDE_PROJECT_CONFIG_FILE {
            append_project_mcp_servers(
                &document.value,
                &source_root,
                &mut collected.servers,
                McpServerMerge::Overwrite,
            );
        }
        collected.paths.push(document.path);
    }
    if let Some(home) = home.filter(|home| home.root() != source_root)
        && let Some(document) = home.read(
            Path::new(CLAUDE_PROJECT_CONFIG_FILE),
            ImportItemKind::McpServers,
            parse_json,
        )
    {
        append_project_mcp_servers(
            &document.value,
            &source_root,
            &mut collected.servers,
            McpServerMerge::PreserveExisting,
        );
        collected.paths.push(document.path);
    }
    collected
}

fn append_project_mcp_servers(
    parsed: &JsonValue,
    source_root: &Path,
    servers: &mut BTreeMap<String, JsonValue>,
    merge: McpServerMerge,
) {
    let Some(projects) = parsed.get("projects").and_then(JsonValue::as_object) else {
        return;
    };
    for (project_path, project_config) in projects {
        if project_path_matches_source_root(project_path, source_root) {
            append_mcp_servers_from_value(project_config, servers, merge);
        }
    }
}

#[derive(Clone, Copy)]
enum McpServerMerge {
    Overwrite,
    PreserveExisting,
}

fn append_mcp_servers_from_value(
    value: &JsonValue,
    servers: &mut BTreeMap<String, JsonValue>,
    merge: McpServerMerge,
) {
    let Some(mcp_servers) = value.get("mcpServers").and_then(JsonValue::as_object) else {
        return;
    };
    for (server_name, server_config) in mcp_servers {
        match merge {
            McpServerMerge::Overwrite => {
                servers.insert(server_name.clone(), server_config.clone());
            }
            McpServerMerge::PreserveExisting => {
                servers
                    .entry(server_name.clone())
                    .or_insert_with(|| server_config.clone());
            }
        }
    }
}

fn project_path_matches_source_root(project_path: &str, source_root: &Path) -> bool {
    let project_path = Path::new(project_path);
    if project_path == source_root {
        return true;
    }
    let Ok(project_path) = project_path.canonicalize() else {
        return false;
    };
    source_root
        .canonicalize()
        .is_ok_and(|source_root| source_root == project_path)
}

/// Normalizes collected external MCP servers into typed plan fragments.
///
/// `enabled_servers` mirrors the external `enabledMcpjsonServers` allowlist; an empty allowlist
/// enables everything not explicitly disabled.
pub(crate) fn normalize_mcp_servers(
    servers: BTreeMap<String, JsonValue>,
    enabled_servers: &[String],
    disabled_servers: &BTreeSet<String>,
) -> Vec<ExternalMcpServer> {
    servers
        .into_iter()
        .map(|(name, config)| ExternalMcpServer {
            definition: normalize_mcp_server(&name, &config, enabled_servers, disabled_servers),
            name,
        })
        .collect()
}

fn normalize_mcp_server(
    server_name: &str,
    server_config: &JsonValue,
    enabled_servers: &[String],
    disabled_servers: &BTreeSet<String>,
) -> Result<ExternalMcpDefinition, McpServerUnsupported> {
    let Some(server_config) = server_config.as_object() else {
        return Err(McpServerUnsupported::MissingEndpoint);
    };
    if mcp_server_is_disabled(
        server_name,
        server_config,
        enabled_servers,
        disabled_servers,
    ) {
        return Err(McpServerUnsupported::Disabled);
    }
    let transport_type = server_config.get("type").and_then(JsonValue::as_str);

    if let Some(command) = server_config.get("command").and_then(json_string) {
        if !matches!(transport_type, None | Some("stdio")) {
            return Err(McpServerUnsupported::UnsupportedTransport);
        }
        if contains_env_placeholder(&command) {
            return Err(McpServerUnsupported::EnvPlaceholder);
        }
        let mut args = Vec::new();
        if let Some(raw_args) = server_config.get("args") {
            args = json_string_vec(raw_args);
            if args.iter().any(|arg| contains_env_placeholder(arg)) {
                return Err(McpServerUnsupported::EnvPlaceholder);
            }
        }
        let mut env = BTreeMap::new();
        let mut env_vars = Vec::new();
        if let Some(raw_env) = server_config.get("env").and_then(JsonValue::as_object) {
            collect_env_config(raw_env, &mut env, &mut env_vars)
                .map_err(|_| McpServerUnsupported::EnvPlaceholder)?;
        }
        return Ok(ExternalMcpDefinition::Stdio {
            command,
            args,
            env,
            env_vars,
        });
    }

    if let Some(url) = server_config.get("url").and_then(json_string) {
        if !matches!(
            transport_type,
            None | Some("http") | Some("streamable_http")
        ) {
            return Err(McpServerUnsupported::UnsupportedTransport);
        }
        if contains_env_placeholder(&url) {
            return Err(McpServerUnsupported::EnvPlaceholder);
        }
        let mut headers = BTreeMap::new();
        let mut env_headers = BTreeMap::new();
        let mut bearer_token_env_var = None;
        if let Some(raw_headers) = server_config.get("headers").and_then(JsonValue::as_object) {
            collect_header_config(
                raw_headers,
                &mut headers,
                &mut env_headers,
                &mut bearer_token_env_var,
            )
            .map_err(|_| McpServerUnsupported::EnvPlaceholder)?;
        }
        return Ok(ExternalMcpDefinition::Http {
            url,
            headers,
            env_headers,
            bearer_token_env_var,
        });
    }

    Err(McpServerUnsupported::MissingEndpoint)
}

fn mcp_server_is_disabled(
    server_name: &str,
    server_config: &serde_json::Map<String, JsonValue>,
    enabled_servers: &[String],
    disabled_servers: &BTreeSet<String>,
) -> bool {
    server_config
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .is_some_and(|enabled| !enabled)
        || server_config
            .get("disabled")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
        || (!enabled_servers.is_empty() && !enabled_servers.iter().any(|name| name == server_name))
        || disabled_servers.contains(server_name)
}

fn collect_header_config(
    headers: &serde_json::Map<String, JsonValue>,
    static_headers: &mut BTreeMap<String, String>,
    env_headers: &mut BTreeMap<String, String>,
    bearer_token_env_var: &mut Option<String>,
) -> Result<(), ()> {
    for (key, value) in headers {
        let header_value = json_string(value).unwrap_or_else(|| value.to_string());
        if key.eq_ignore_ascii_case("authorization")
            && let Some(token_env) = header_value
                .strip_prefix("Bearer ")
                .and_then(parse_env_placeholder)
        {
            *bearer_token_env_var = Some(token_env);
            continue;
        }

        if let Some(env_var) = parse_env_placeholder(&header_value) {
            env_headers.insert(key.clone(), env_var);
        } else if contains_env_placeholder(&header_value) {
            return Err(());
        } else {
            static_headers.insert(key.clone(), header_value);
        }
    }
    Ok(())
}

fn collect_env_config(
    env: &serde_json::Map<String, JsonValue>,
    static_env: &mut BTreeMap<String, String>,
    env_vars: &mut Vec<String>,
) -> Result<(), ()> {
    for (key, value) in env {
        let env_value = json_string(value).unwrap_or_else(|| value.to_string());
        if parse_env_placeholder(&env_value).as_deref() == Some(key.as_str()) {
            env_vars.push(key.clone());
        } else if contains_env_placeholder(&env_value) {
            return Err(());
        } else {
            static_env.insert(key.clone(), env_value);
        }
    }
    Ok(())
}

/// Parses the `mcp_servers` table of one Codex `config.toml` source document.
pub(crate) fn codex_mcp_servers(config: &toml::Value) -> Vec<ExternalMcpServer> {
    let Some(mcp_servers) = config.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    mcp_servers
        .iter()
        .map(|(name, server)| ExternalMcpServer {
            name: name.clone(),
            definition: codex_mcp_server(server),
        })
        .collect()
}

fn codex_mcp_server(server: &toml::Value) -> Result<ExternalMcpDefinition, McpServerUnsupported> {
    let Some(table) = server.as_table() else {
        return Err(McpServerUnsupported::MissingEndpoint);
    };
    if table.get("enabled").and_then(toml::Value::as_bool) == Some(false) {
        return Err(McpServerUnsupported::Disabled);
    }
    if let Some(command) = table.get("command").and_then(toml::Value::as_str) {
        let args = table
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let env = toml_string_table(table.get("env"));
        let env_vars = toml_string_array(table.get("env_vars"));
        return Ok(ExternalMcpDefinition::Stdio {
            command: command.to_owned(),
            args,
            env,
            env_vars,
        });
    }
    if let Some(url) = table.get("url").and_then(toml::Value::as_str) {
        return Ok(ExternalMcpDefinition::Http {
            url: url.to_owned(),
            headers: toml_string_table(table.get("http_headers")),
            env_headers: toml_string_table(table.get("env_http_headers")),
            bearer_token_env_var: table
                .get("bearer_token_env_var")
                .and_then(toml::Value::as_str)
                .map(ToOwned::to_owned),
        });
    }
    Err(McpServerUnsupported::MissingEndpoint)
}

fn toml_string_table(value: Option<&toml::Value>) -> BTreeMap<String, String> {
    value
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn toml_string_array(value: Option<&toml::Value>) -> Vec<String> {
    value
        .and_then(toml::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(toml::Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_env_placeholder(value: &str) -> Option<String> {
    let inner = value.strip_prefix("${")?.strip_suffix('}')?;
    let name = inner
        .split_once(":-")
        .map_or(inner, |(name, _default)| name);
    let mut chars = name.chars();
    let first = chars.next()?;
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return None;
    }
    if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return None;
    }
    Some(name.to_string())
}

fn contains_env_placeholder(value: &str) -> bool {
    value.contains("${")
}

fn json_string_vec(value: &JsonValue) -> Vec<String> {
    match value {
        JsonValue::Array(values) => values.iter().filter_map(json_string).collect(),
        _ => json_string(value).into_iter().collect(),
    }
}

fn json_string(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::Null => None,
        JsonValue::String(value) => Some(value.clone()),
        JsonValue::Bool(value) => Some(value.to_string()),
        JsonValue::Number(value) => Some(value.to_string()),
        JsonValue::Array(_) | JsonValue::Object(_) => None,
    }
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
