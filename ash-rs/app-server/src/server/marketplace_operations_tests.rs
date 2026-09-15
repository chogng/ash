use std::sync::Arc;

use ash_core_plugins::PluginPackageService;
use serde_json::Value;
use serde_json::json;

use super::AppServer;
use crate::local::ProviderModelService;
use crate::server::ConnectionState;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;

#[test]
fn app_server_exposes_only_the_manager_business_contract() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let server = AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugin_package_service(Arc::new(FakePluginsManager));
    let mut connection = server.connection();
    let initialized = call(
        &server,
        &mut connection,
        1,
        "initialize",
        json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert_eq!(initialized["result"]["capabilities"]["marketplace"], true);

    let mut observer = server.connection();
    call(
        &server,
        &mut observer,
        21,
        "initialize",
        json!({
            "clientInfo": {"name": "observer", "version": "1"},
            "capabilities": {}
        }),
    );

    let found = call(
        &server,
        &mut connection,
        2,
        "marketplace/search",
        json!({"query": "github", "packageType": "plugin", "limit": 20}),
    );
    assert_eq!(found["result"]["packages"][0]["id"], "marketplace/github");

    let details = call(
        &server,
        &mut connection,
        20,
        "marketplace/get",
        json!({"packageId": "marketplace/docs-mcp", "version": "1.2.3"}),
    );
    assert_eq!(details["result"]["upstream"]["registry"], "officialMcp");
    assert_eq!(details["result"]["upstream"]["name"], "ac.example/docs-mcp");
    assert!(details.to_string().find("targetUrl").is_none());

    let installed = call(
        &server,
        &mut connection,
        3,
        "marketplace/install",
        json!({"packageId": "marketplace/github", "version": "1.1.0"}),
    );
    assert_eq!(installed["result"]["installationId"], "ins_opaque");
    assert_eq!(installed["result"]["capabilities"][0]["kind"], "skill");
    assert!(installed.to_string().find("path").is_none());

    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed["method"], "marketplace/changed");
    assert!(changed["params"]["instanceId"].as_str().is_some());
    assert_eq!(changed["params"]["generation"], 2);

    let installed_snapshot = call(
        &server,
        &mut observer,
        22,
        "marketplace/listInstalled",
        json!({}),
    );
    assert_eq!(
        installed_snapshot["result"]["instanceId"],
        changed["params"]["instanceId"]
    );
    assert_eq!(installed_snapshot["result"]["generation"], 2);
    assert_eq!(
        installed_snapshot["result"]["packages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let acquired = call(
        &server,
        &mut connection,
        4,
        "marketplace/acquireCapability",
        json!({"capability": {"id": "cap_opaque"}}),
    );
    assert_eq!(acquired["result"]["lease"]["id"], "lease_opaque");

    let mut other_connection = server.connection();
    call(
        &server,
        &mut other_connection,
        5,
        "initialize",
        json!({
            "clientInfo": {"name": "other", "version": "1"},
            "capabilities": {}
        }),
    );
    let rejected = call(
        &server,
        &mut other_connection,
        6,
        "marketplace/openResource",
        json!({"leaseId": "lease_opaque", "resource": {"id": "res_opaque"}}),
    );
    assert!(rejected["error"].is_object());

    let released = call(
        &server,
        &mut connection,
        7,
        "marketplace/releaseCapability",
        json!({"leaseId": "lease_opaque"}),
    );
    assert_eq!(released["result"], json!(null));
    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed_after_release: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed_after_release["method"], "marketplace/changed");
    assert_eq!(changed_after_release["params"]["generation"], 3);

    let mut disconnecting = server.connection();
    call(
        &server,
        &mut disconnecting,
        8,
        "initialize",
        json!({
            "clientInfo": {"name": "disconnecting", "version": "1"},
            "capabilities": {}
        }),
    );
    call(
        &server,
        &mut disconnecting,
        9,
        "marketplace/acquireCapability",
        json!({"capability": {"id": "cap_opaque"}}),
    );
    server.close_connection(disconnecting);
    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed_after_disconnect: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed_after_disconnect["method"], "marketplace/changed");
    assert_eq!(changed_after_disconnect["params"]["generation"], 4);
}

struct FakePluginsManager;

impl PluginPackageService for FakePluginsManager {
    fn search(
        &self,
        _: ash_core_plugins::SearchPackagesRequest,
    ) -> Result<ash_core_plugins::SearchPackagesResult, ash_core_plugins::MarketplaceClientError>
    {
        Ok(ash_core_plugins::SearchPackagesResult {
            packages: vec![ash_core_plugins::PackageSummary {
                id: "marketplace/github".to_owned(),
                version: "1.1.0".to_owned(),
                package_type: "plugin".to_owned(),
                display_name: "GitHub".to_owned(),
                description: "GitHub integration".to_owned(),
            }],
        })
    }

    fn get(
        &self,
        _: ash_core_plugins::GetPackageRequest,
    ) -> Result<ash_core_plugins::PackageDetails, ash_core_plugins::MarketplaceClientError> {
        Ok(ash_core_plugins::PackageDetails {
            package: ash_core_plugins::PackageRef {
                id: "marketplace/docs-mcp".to_owned(),
                version: "1.2.3".to_owned(),
                digest: format!("sha256:{}", "b".repeat(64)),
            },
            package_type: "mcp".to_owned(),
            display_name: "Docs MCP".to_owned(),
            description: "Search documentation".to_owned(),
            license: "MIT".to_owned(),
            source: ash_core_plugins::PackageSource::ThirdParty,
            upstream: Some(ash_core_plugins::UpstreamReference {
                registry: ash_core_plugins::UpstreamRegistry::OfficialMcp,
                name: "ac.example/docs-mcp".to_owned(),
                version: "1.2.3".to_owned(),
                record_url: "https://registry.modelcontextprotocol.io/v0.1/servers/ac.example%2Fdocs-mcp/versions/1.2.3".to_owned(),
                repository_url: Some("https://github.com/example/docs-mcp".to_owned()),
            }),
            capabilities: Vec::new(),
        })
    }

    fn download(
        &self,
        _: ash_core_plugins::DownloadPackageRequest,
    ) -> Result<ash_core_plugins::ArtifactHandle, ash_core_plugins::MarketplaceClientError> {
        unimplemented!()
    }

    fn install(
        &self,
        _: ash_core_plugins::InstallPackageRequest,
    ) -> Result<ash_core_plugins::InstalledPackage, ash_core_plugins::MarketplaceClientError> {
        Ok(ash_core_plugins::InstalledPackage {
            installation_id: "ins_opaque".to_owned(),
            package: ash_core_plugins::PackageRef {
                id: "marketplace/github".to_owned(),
                version: "1.1.0".to_owned(),
                digest: format!("sha256:{}", "a".repeat(64)),
            },
            state: ash_core_plugins::InstallationState::Installed,
            capabilities: vec![ash_core_plugins::CapabilityDescriptor {
                reference: ash_core_plugins::CapabilityRef {
                    id: "cap_opaque".to_owned(),
                },
                kind: ash_core_plugins::CapabilityKind::Skill,
                id: "github".to_owned(),
                contract_version: "1".to_owned(),
                permissions: Vec::new(),
                authentication_provider: None,
            }],
        })
    }

    fn update(
        &self,
        _: ash_core_plugins::UpdatePackageRequest,
    ) -> Result<ash_core_plugins::InstalledPackage, ash_core_plugins::MarketplaceClientError> {
        unimplemented!()
    }

    fn uninstall(
        &self,
        _: ash_core_plugins::UninstallPackageRequest,
    ) -> Result<(), ash_core_plugins::MarketplaceClientError> {
        unimplemented!()
    }

    fn list_installed(
        &self,
        _: ash_core_plugins::ListInstalledRequest,
    ) -> Result<Vec<ash_core_plugins::InstalledPackage>, ash_core_plugins::MarketplaceClientError>
    {
        Ok(vec![ash_core_plugins::InstalledPackage {
            installation_id: "ins_opaque".to_owned(),
            package: ash_core_plugins::PackageRef {
                id: "marketplace/github".to_owned(),
                version: "1.1.0".to_owned(),
                digest: format!("sha256:{}", "a".repeat(64)),
            },
            state: ash_core_plugins::InstallationState::Installed,
            capabilities: Vec::new(),
        }])
    }

    fn acquire_capability(
        &self,
        _: ash_core_plugins::AcquireCapabilityRequest,
    ) -> Result<ash_core_plugins::AcquiredCapability, ash_core_plugins::MarketplaceClientError>
    {
        Ok(ash_core_plugins::AcquiredCapability {
            lease: ash_core_plugins::CapabilityLease {
                id: "lease_opaque".to_owned(),
                capability: ash_core_plugins::CapabilityRef {
                    id: "cap_opaque".to_owned(),
                },
                installation_id: "ins_opaque".to_owned(),
            },
            spec: ash_core_plugins::ActivationSpec::Skill(ash_core_plugins::SkillActivationSpec {
                contract_version: "1".to_owned(),
                resource: ash_core_plugins::ResourceRef {
                    id: "res_opaque".to_owned(),
                },
            }),
        })
    }

    fn release_capability(
        &self,
        _: ash_core_plugins::ReleaseCapabilityRequest,
    ) -> Result<ash_core_plugins::ReleaseCapabilityOutcome, ash_core_plugins::MarketplaceClientError>
    {
        Ok(ash_core_plugins::ReleaseCapabilityOutcome {
            installation_changed: true,
        })
    }

    fn open_resource(
        &self,
        _: ash_core_plugins::OpenResourceRequest,
    ) -> Result<ash_core_plugins::ResourceContent, ash_core_plugins::MarketplaceClientError> {
        unimplemented!()
    }
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}
