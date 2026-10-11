use std::sync::Arc;

use ash_core_plugins::ExtensionPackageService;
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
    .with_plugin_package_service(Arc::new(FakeExtensionPackageManager));
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
    assert_eq!(
        initialized["result"]["capabilities"]["extensionManagement"],
        true
    );

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
        "extensions/search",
        json!({"query": "github", "packageType": "plugin", "capabilityKind": "skill", "languageId": "typescriptreact", "limit": 20}),
    );
    assert_eq!(found["result"]["packages"][0]["id"], "extensions/github");

    let details = call(
        &server,
        &mut connection,
        20,
        "extensions/get",
        json!({"packageId": "extensions/docs-mcp", "version": "1.2.3"}),
    );
    assert_eq!(details["result"]["upstream"]["registry"], "officialMcp");
    assert_eq!(details["result"]["upstream"]["name"], "ac.example/docs-mcp");
    assert!(details.to_string().find("targetUrl").is_none());

    let installed = call(
        &server,
        &mut connection,
        3,
        "extensions/install",
        json!({"packageId": "extensions/github", "version": "1.1.0"}),
    );
    assert_eq!(installed["result"]["installationId"], "ins_opaque");
    assert_eq!(installed["result"]["capabilities"][0]["kind"], "skill");
    assert!(installed.to_string().find("path").is_none());

    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed["method"], "extensions/changed");
    assert!(changed["params"]["instanceId"].as_str().is_some());
    assert_eq!(changed["params"]["generation"], 2);

    let installed_snapshot = call(
        &server,
        &mut observer,
        22,
        "extensions/listInstalled",
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
        "extensions/acquireCapability",
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
        "extensions/openResource",
        json!({"leaseId": "lease_opaque", "resource": {"id": "res_opaque"}}),
    );
    assert!(rejected["error"].is_object());

    let released = call(
        &server,
        &mut connection,
        7,
        "extensions/releaseCapability",
        json!({"leaseId": "lease_opaque"}),
    );
    assert_eq!(released["result"], json!(null));
    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed_after_release: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed_after_release["method"], "extensions/changed");
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
        "extensions/acquireCapability",
        json!({"capability": {"id": "cap_opaque"}}),
    );
    server.close_connection(disconnecting);
    let notifications = server.drain_notifications(&mut observer);
    assert_eq!(notifications.len(), 1);
    let changed_after_disconnect: Value = serde_json::from_str(&notifications[0]).unwrap();
    assert_eq!(changed_after_disconnect["method"], "extensions/changed");
    assert_eq!(changed_after_disconnect["params"]["generation"], 4);
}

struct FakeExtensionPackageManager;

impl ExtensionPackageService for FakeExtensionPackageManager {
    fn search(
        &self,
        request: ash_core_plugins::SearchPackagesRequest,
    ) -> Result<ash_core_plugins::SearchPackagesResult, ash_core_plugins::ExtensionsClientError>
    {
        assert_eq!(request.query, "github");
        assert_eq!(request.package_type.as_deref(), Some("plugin"));
        assert_eq!(
            request.capability_kind,
            Some(ash_core_plugins::CapabilityKind::Skill)
        );
        assert_eq!(request.language_id.as_deref(), Some("typescriptreact"));
        assert_eq!(request.limit, Some(20));
        Ok(ash_core_plugins::SearchPackagesResult {
            unavailable_sources: Vec::new(),
            packages: vec![ash_core_plugins::PackageSummary {
                id: "extensions/github".to_owned(),
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
    ) -> Result<ash_core_plugins::PackageDetails, ash_core_plugins::ExtensionsClientError> {
        Ok(ash_core_plugins::PackageDetails {
            package: ash_core_plugins::PackageRef {
                id: "extensions/docs-mcp".to_owned(),
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
    ) -> Result<ash_core_plugins::ArtifactHandle, ash_core_plugins::ExtensionsClientError> {
        unimplemented!()
    }

    fn install(
        &self,
        _: ash_core_plugins::InstallPackageRequest,
    ) -> Result<ash_core_plugins::InstalledPackage, ash_core_plugins::ExtensionsClientError> {
        Ok(ash_core_plugins::InstalledPackage {
            installation_id: "ins_opaque".to_owned(),
            package: ash_core_plugins::PackageRef {
                id: "extensions/github".to_owned(),
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
    ) -> Result<ash_core_plugins::InstalledPackage, ash_core_plugins::ExtensionsClientError> {
        unimplemented!()
    }

    fn uninstall(
        &self,
        _: ash_core_plugins::UninstallPackageRequest,
    ) -> Result<(), ash_core_plugins::ExtensionsClientError> {
        unimplemented!()
    }

    fn list_installed(
        &self,
        _: ash_core_plugins::ListInstalledRequest,
    ) -> Result<Vec<ash_core_plugins::InstalledPackage>, ash_core_plugins::ExtensionsClientError>
    {
        Ok(vec![ash_core_plugins::InstalledPackage {
            installation_id: "ins_opaque".to_owned(),
            package: ash_core_plugins::PackageRef {
                id: "extensions/github".to_owned(),
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
    ) -> Result<ash_core_plugins::AcquiredCapability, ash_core_plugins::ExtensionsClientError> {
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
    ) -> Result<ash_core_plugins::ReleaseCapabilityOutcome, ash_core_plugins::ExtensionsClientError>
    {
        Ok(ash_core_plugins::ReleaseCapabilityOutcome {
            installation_changed: true,
        })
    }

    fn open_resource(
        &self,
        _: ash_core_plugins::OpenResourceRequest,
    ) -> Result<ash_core_plugins::ResourceContent, ash_core_plugins::ExtensionsClientError> {
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

#[test]
fn extension_packages_source_mutations_share_authenticated_client_authority_and_persist_revisions()
{
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ash_core_plugins::ExtensionPackageManager::open(
            root.path(),
            ash_core_plugins::ExtensionSources::new([]).unwrap(),
        )
        .unwrap(),
    );
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let server = AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugins_manager(Arc::clone(&manager));
    let mut ordinary = server.connection();
    let mut owner = server.product_host_connection();
    let mut browser = server.browser_connection();
    for connection in [&mut ordinary, &mut owner, &mut browser] {
        call(
            &server,
            connection,
            1,
            "initialize",
            json!({
                "clientInfo": {"name": "extensions-test", "version": "1"}, "capabilities": {}
            }),
        );
    }
    let request = json!({
        "sourceId": "vendor",
        "metadataBaseUrl": "https://vendor.example/metadata/",
        "targetsBaseUrl": "https://vendor.example/targets/",
        "trustedRootJson": include_str!("../../../../resources/product-services/extensions-root.json"),
        "expectedRevision": 0
    });
    let denied = call(
        &server,
        &mut ordinary,
        2,
        "extensions/sources/add",
        request.clone(),
    );
    assert_eq!(denied["error"]["message"], "ResourceNotOwner");
    assert_eq!(manager.sources().unwrap().revision, 0);
    let added = call(&server, &mut browser, 3, "extensions/sources/add", request);
    assert_eq!(added["result"]["revision"], 1);
    assert_eq!(
        added["result"]["sources"],
        json!([{
            "id": "vendor", "kind": "ash", "enabled": true, "productOwned": false
        }])
    );
    let stale = call(
        &server,
        &mut browser,
        4,
        "extensions/sources/setEnabled",
        json!({
            "sourceId": "vendor", "enabled": false, "expectedRevision": 0
        }),
    );
    assert!(stale.get("error").is_some());
    let paused = call(
        &server,
        &mut owner,
        5,
        "extensions/sources/setEnabled",
        json!({
            "sourceId": "vendor", "enabled": false, "expectedRevision": 1
        }),
    );
    assert_eq!(paused["result"]["revision"], 2);
    assert_eq!(paused["result"]["sources"][0]["enabled"], false);
    let denied = call(
        &server,
        &mut ordinary,
        5,
        "extensions/sources/setEnabled",
        json!({
            "sourceId": "vendor", "enabled": true, "expectedRevision": 2
        }),
    );
    assert_eq!(denied["error"]["message"], "ResourceNotOwner");
    let listed = call(
        &server,
        &mut ordinary,
        6,
        "extensions/sources/list",
        json!({}),
    );
    assert_eq!(listed["result"], paused["result"]);
    drop(server);
    drop(manager);
    let reopened = ash_core_plugins::ExtensionPackageManager::open(
        root.path(),
        ash_core_plugins::ExtensionSources::new([]).unwrap(),
    )
    .unwrap();
    assert_eq!(reopened.sources().unwrap().revision, 2);
    assert!(!reopened.sources().unwrap().sources[0].enabled);
}

#[test]
fn built_in_provider_policy_checks_authority_revision_and_change_notifications() {
    use ash_core_plugins::EditorExtensionPolicy;
    use ash_external_ext::BuiltInExtensionRuntime;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    struct Runtime {
        policy: Arc<EditorExtensionPolicy>,
        running: AtomicBool,
    }
    impl BuiltInExtensionRuntime for Runtime {
        fn id(&self) -> &str {
            "ash.github-authentication"
        }
        fn is_running(&self) -> bool {
            self.running.load(Ordering::Acquire)
        }
        fn reconcile_enablement(&self) -> Result<(), ash_external_ext::ExtensionHostError> {
            self.running.store(
                self.policy.is_extension_enabled(self.id()),
                Ordering::Release,
            );
            Ok(())
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let policy = Arc::new(EditorExtensionPolicy::open(path.clone()).unwrap());
    let runtime = Arc::new(Runtime {
        policy: policy.clone(),
        running: AtomicBool::new(true),
    });
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_editor_extension_policy(policy.clone())
    .with_built_in_extension_runtime(runtime);
    let mut owner = server.product_host_connection();
    let mut ordinary = server.connection();
    let mut browser = server.browser_connection();
    for connection in [&mut owner, &mut ordinary, &mut browser] {
        call(
            &server,
            connection,
            1,
            "initialize",
            json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
        );
    }
    let request = json!({"id":"ash.github-authentication", "enabled":false, "expectedRevision":1});
    for connection in [&mut ordinary, &mut browser] {
        assert!(
            call(
                &server,
                connection,
                2,
                "extensions/setBuiltInProviderEnablement",
                request.clone()
            )
            .get("error")
            .is_some()
        );
    }
    let generation = server.updates.extension_packages_generation();
    let result = call(
        &server,
        &mut owner,
        3,
        "extensions/setBuiltInProviderEnablement",
        request.clone(),
    );
    assert_eq!(
        result["result"]["providers"][0],
        json!({"id":"ash.github-authentication","enabled":false,"running":false})
    );
    assert_eq!(result["result"]["revision"], 2);
    assert!(server.updates.extension_packages_generation() > generation);
    assert!(
        !EditorExtensionPolicy::open(path)
            .unwrap()
            .is_extension_enabled("ash.github-authentication")
    );
    assert!(
        call(
            &server,
            &mut owner,
            4,
            "extensions/setBuiltInProviderEnablement",
            request
        )
        .get("error")
        .is_some()
    );
    assert!(
        call(
            &server,
            &mut owner,
            5,
            "extensions/setBuiltInProviderEnablement",
            json!({"id":"ash.unknown","enabled":true,"expectedRevision":2})
        )
        .get("error")
        .is_some()
    );
    assert_eq!(policy.generation(), 2);
    let enabled = call(
        &server,
        &mut owner,
        6,
        "extensions/setBuiltInProviderEnablement",
        json!({"id":"ash.github-authentication","enabled":true,"expectedRevision":2}),
    );
    assert_eq!(enabled["result"]["providers"][0]["enabled"], true);
}
