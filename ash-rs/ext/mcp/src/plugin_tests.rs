use std::fs;

use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginActivationSnapshot;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_mcp::McpServerTransport;
use ash_plugin::LocalPluginPackage;
use ash_secrets::SecretValue;
use connectors::ConnectorCatalog;
use connectors::ConnectorDefinition;
use tempfile::tempdir;

use super::ConnectorMcpRuntimeProvider;
use super::PluginConnectorMcpRuntimeProvider;

fn package(root: &std::path::Path, executable_permission: &str) -> LocalPluginPackage {
    for directory in [".ash-plugin", "mcp", "bin"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        format!(
            r#"{{
                "schemaVersion": 1,
                "id": "acme/review",
                "version": "1.0.0",
                "displayName": "Review",
                "compatibility": {{"ash": ">=0.1.0"}},
                "contributions": {{
                    "mcpServers": [{{"id": "review", "definition": "mcp/review.json"}}],
                    "connectors": [{{
                        "id": "account",
                        "displayName": "Review account",
                        "description": "Connect a Review account.",
                        "mcpServer": "review"
                    }}]
                }},
                "permissions": [{{"type": "process", "executable": "{executable_permission}"}}],
                "credentialSlots": [{{
                    "name": "token",
                    "kind": "secretText",
                    "requiredFor": ["connector:account", "mcp:review"]
                }}]
            }}"#
        ),
    )
    .unwrap();
    fs::write(
        root.join("mcp/review.json"),
        r#"{
            "transport": {
                "type": "stdio",
                "executable": "bin/review-server",
                "args": ["serve"],
                "credentialEnv": "REVIEW_TOKEN"
            }
        }"#,
    )
    .unwrap();
    fs::write(root.join("bin/review-server"), "binary").unwrap();
    fs::write(root.join("bin/other"), "binary").unwrap();
    LocalPluginPackage::load(root).unwrap()
}

fn standalone_package(root: &std::path::Path) -> LocalPluginPackage {
    for directory in [".ash-plugin", "mcp", "bin"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "acme/local-tools",
            "version": "1.0.0",
            "displayName": "Local tools",
            "compatibility": {"ash": ">=0.1.0"},
            "contributions": {
                "mcpServers": [{"id": "local", "definition": "mcp/local.json"}]
            },
            "permissions": [{"type": "process", "executable": "bin/local-server"}]
        }"#,
    )
    .unwrap();
    fs::write(
        root.join("mcp/local.json"),
        r#"{
            "transport": {
                "type": "stdio",
                "executable": "bin/local-server",
                "args": ["serve"]
            }
        }"#,
    )
    .unwrap();
    fs::write(root.join("bin/local-server"), "binary").unwrap();
    LocalPluginPackage::load(root).unwrap()
}

fn activation(package: LocalPluginPackage) -> PluginActivationSnapshot {
    let store_root = tempdir().unwrap().keep();
    let store = PluginPackageStore::open(&store_root).unwrap();
    let installed = store.install_local(&package).unwrap();
    PluginActivationSnapshot::resolve(1, &store, [installed]).unwrap()
}

fn enabled_authority(package: LocalPluginPackage) -> PluginActivationAuthority {
    let store_root = tempdir().unwrap().keep();
    let store = PluginPackageStore::open(&store_root).unwrap();
    let installed = store.install_local(&package).unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new("install").unwrap(),
            expected_revision: 0,
            command: PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        })
        .unwrap();
    authority
        .apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new("grant").unwrap(),
            expected_revision: 1,
            command: PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        })
        .unwrap();
    authority
        .apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new("enable").unwrap(),
            expected_revision: 2,
            command: PluginAuthorityCommand::Enable { package: installed },
        })
        .unwrap();
    authority
}

fn connector(activation: &PluginActivationSnapshot) -> ConnectorDefinition {
    ConnectorCatalog::from_activation(activation)
        .unwrap()
        .snapshot()
        .entries()[0]
        .definition()
        .clone()
}

#[test]
fn activation_materializes_package_rooted_stdio_with_exact_permission() {
    let source = tempdir().unwrap();
    let activation = activation(package(source.path(), "bin/review-server"));
    let connector = connector(&activation);
    let provider = PluginConnectorMcpRuntimeProvider::from_activation(&activation).unwrap();

    let transport = provider
        .materialize(&connector, SecretValue::new(b"secret-token".to_vec()))
        .unwrap();
    let McpServerTransport::Stdio(command) = transport else {
        panic!("expected stdio transport");
    };
    assert!(std::path::Path::new(command.program()).is_absolute());
    assert!(
        std::path::Path::new(command.program())
            .ends_with(std::path::Path::new("bin").join("review-server"))
    );
}

#[test]
fn activation_rejects_an_executable_outside_the_manifest_permission() {
    let source = tempdir().unwrap();
    let activation = activation(package(source.path(), "bin/other"));

    assert!(PluginConnectorMcpRuntimeProvider::from_activation(&activation).is_err());
}

#[test]
fn activation_materializes_connector_free_plugin_mcp_as_standalone() {
    let source = tempdir().unwrap();
    let activation = activation(standalone_package(source.path()));
    let provider = PluginConnectorMcpRuntimeProvider::from_activation(&activation).unwrap();

    let servers = provider.standalone_servers().unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(
        servers[0].definition().id().as_str(),
        "plugin:acme/local-tools:mcp:local"
    );
    let McpServerTransport::Stdio(command) = servers[0].definition().transport() else {
        panic!("expected stdio transport");
    };
    assert!(
        std::path::Path::new(command.program())
            .ends_with(std::path::Path::new("bin").join("local-server"))
    );
}

#[test]
fn live_authority_fences_old_connector_runtime_after_disable() {
    let source = tempdir().unwrap();
    let authority = enabled_authority(package(source.path(), "bin/review-server"));
    let snapshot = authority.snapshot();
    let connector = connector(snapshot.activation());
    let provider = PluginConnectorMcpRuntimeProvider::from_authority(&authority).unwrap();
    let fence = provider.invocation_fence(&connector).unwrap();
    assert!(fence.authorizes());

    authority
        .apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new("disable").unwrap(),
            expected_revision: snapshot.revision(),
            command: PluginAuthorityCommand::Disable {
                package: snapshot.enabled()[0].clone(),
            },
        })
        .unwrap();
    assert!(!fence.authorizes());
    assert!(fence.acquire().is_none());
}
