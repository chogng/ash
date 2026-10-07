use crate::ConnectorAccount;
use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionUpdate;
use crate::ConnectorCredentialRef;
use crate::ConnectorSnapshotGeneration;
use ash_plugin::PluginManifest;
use ash_tools::DiscoverableCapability;
use ash_tools::DiscoveryAction;

use crate::ConnectorCatalog;

fn manifest() -> PluginManifest {
    PluginManifest::from_json(
        br#"{
          "schemaVersion": 1,
          "id": "acme/github",
          "version": "1.0.0",
          "displayName": "GitHub",
          "compatibility": {"ash": ">=0.1.0"},
          "contributions": {
            "mcpServers": [{"id": "github", "definition": "mcp/github.json"}],
            "connectors": [{
              "id": "account",
              "displayName": "GitHub account",
              "description": "Connect one GitHub account.",
              "mcpServer": "github"
            }]
          }
        }"#,
    )
    .unwrap()
}

#[test]
fn disconnected_connector_is_discoverable_but_not_runtime_ready() {
    let manifest = manifest();
    let catalog =
        ConnectorCatalog::from_manifests(ConnectorSnapshotGeneration::new(7), [&manifest]).unwrap();
    let snapshot = catalog.discovery_snapshot().unwrap();

    assert!(catalog.ready_mcp_server_ids().is_empty());
    assert_eq!(snapshot.generation(), 7);
    assert!(matches!(
        &snapshot.candidates()[0],
        DiscoverableCapability::Connector(info) if info.action == DiscoveryAction::Connect
    ));
}

#[test]
fn connected_account_gates_its_mcp_binding_out_of_discovery() {
    let manifest = manifest();
    let catalog =
        ConnectorCatalog::from_manifests(ConnectorSnapshotGeneration::new(8), [&manifest]).unwrap();
    let id = catalog.snapshot().entries()[0].definition().id().clone();
    let connection_generation = ConnectorConnectionGeneration::new(1);
    let catalog = catalog
        .with_connection_update(
            ConnectorSnapshotGeneration::new(9),
            &id,
            ConnectorConnectionUpdate::Begin {
                generation: connection_generation,
            },
        )
        .unwrap()
        .with_connection_update(
            ConnectorSnapshotGeneration::new(10),
            &id,
            ConnectorConnectionUpdate::Connected {
                account: ConnectorAccount::new(
                    ConnectorAccountId::new("octocat").unwrap(),
                    "Octocat",
                    ConnectorCredentialRef::new("secret:github-octocat").unwrap(),
                    connection_generation,
                )
                .unwrap(),
            },
        )
        .unwrap();

    assert_eq!(
        catalog
            .ready_mcp_server_ids()
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["plugin:acme/github:mcp:github"]
    );
    assert!(
        catalog
            .discovery_snapshot()
            .unwrap()
            .candidates()
            .is_empty()
    );
}
