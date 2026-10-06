#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
use ash_app_server_protocol::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR;
#[cfg(unix)]
use serde_json::json;

#[cfg(unix)]
pub(crate) fn initialize_response(server_schema_hash: &str) -> String {
    initialize_response_with_protocol(server_schema_hash, APP_SERVER_PROTOCOL_MAJOR)
}

#[cfg(unix)]
pub(crate) fn incompatible_initialize_response(server_schema_hash: &str) -> String {
    initialize_response_with_protocol(server_schema_hash, APP_SERVER_PROTOCOL_MAJOR + 1)
}

#[cfg(unix)]
fn initialize_response_with_protocol(server_schema_hash: &str, protocol_major: u32) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "serverInfo": { "name": "fake-remote", "version": "1" },
            "protocolVersion": {
                "major": protocol_major,
            },
            "schemaHash": server_schema_hash,
            "capabilities": {
                "agentInteractions": false,
                "documentCollaboration": false,
                "sessions": true,
                "threads": true,
                "turns": true,
                "projects": false,
                "memories": false,
                "approvalEnvironment": false,
                "resources": false,
                "attachments": false,
                "fileSystem": false,
                "git": false,
                "github": false,
                "contentSearch": false,
                "codebase": false,
                "cloudCodebase": false,
                "terminal": false,
                "debugAdapter": false,
                "typst": false,
                "updateReplay": false,
                "extensions": false,
                "extensionHost": false,
                "connectors": false,
                "plugins": false,
                "marketplace": false,
                "mcp": false,
                "mcpOAuth": false,
                "contracts": {}
            },
            "slashCommands": []
        }
    })
    .to_string()
}

#[cfg(unix)]
pub(crate) fn make_executable(path: &Path) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}
