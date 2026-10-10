use std::path::Path;
use std::sync::Arc;

use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::DownloadPackageRequest;
use ash_core_plugins::EditorExtensionPolicy;
use ash_core_plugins::GetPackageRequest;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::MarketplaceClientError;
use ash_core_plugins::PackageDetails;
use ash_core_plugins::PackageRef;
use ash_core_plugins::PackageSource;
use ash_core_plugins::PluginPackageCapability;
use ash_core_plugins::PluginPackagePayload;
use ash_core_plugins::PluginPackageService;
use ash_core_plugins::PluginProvider;
use ash_core_plugins::PluginsManager;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::SearchPackagesResult;
use ash_core_plugins::UninstallMode;
use ash_core_plugins::UninstallPackageRequest;
use ash_model_provider::EchoModel;
use serde_json::json;

use crate::AppServer;
use crate::MarketplaceEditorExtensionAdmission;
use crate::local::ProviderModelService;
use crate::marketplace_editor_extensions::ProfileEditorExtensionAdmission;

struct WebRegistry(&'static str);
struct WebPackage {
    package: PackageRef,
    capabilities: Vec<PluginPackageCapability>,
    manifest: Vec<u8>,
    source_path: &'static str,
}
const SOURCE: &[u8] = b"exports.activate = context => context.subscriptions.push(require('vscode').commands.registerCommand('web.hello', () => {}));";
impl WebPackage {
    fn new(entry: &str) -> Self {
        let source_path = if entry == "./main.cjs" {
            "extension/main.cjs"
        } else {
            "extension/main.js"
        };
        let manifest = serde_json::to_vec(&json!({"name":"web", "publisher":"test", "version":"1.0.0", "browser":"missing.js", "main":entry, "contributes":{"commands":[{"command":"web.hello","title":"Hello"}]}})).unwrap();
        Self {
            package: PackageRef {
                id: "test.web".into(),
                version: "1.0.0".into(),
                digest: super::package_digest(&[
                    (source_path, SOURCE),
                    ("extension/package.json", &manifest),
                ]),
            },
            capabilities: vec![PluginPackageCapability {
                kind: CapabilityKind::EditorExtension,
                id: "test.web".into(),
                path: "extension".into(),
                runtime: None,
                language_ids: Vec::new(),
            }],
            manifest,
            source_path,
        }
    }
}
impl PluginPackagePayload for WebPackage {
    fn package(&self) -> &PackageRef {
        &self.package
    }
    fn capabilities(&self) -> &[PluginPackageCapability] {
        &self.capabilities
    }
    fn expected_file_count(&self) -> u64 {
        2
    }
    fn expected_size_bytes(&self) -> u64 {
        (SOURCE.len() + self.manifest.len()) as u64
    }
    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError> {
        std::fs::create_dir(destination.join("extension"))
            .map_err(|_| MarketplaceClientError::storage())?;
        std::fs::write(destination.join(self.source_path), SOURCE)
            .map_err(|_| MarketplaceClientError::storage())?;
        std::fs::write(destination.join("extension/package.json"), &self.manifest)
            .map_err(|_| MarketplaceClientError::storage())
    }
}
impl PluginProvider for WebRegistry {
    fn search(
        &self,
        _: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        Ok(SearchPackagesResult {
            packages: Vec::new(),
        })
    }
    fn get(&self, _: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
        Ok(PackageDetails {
            package: WebPackage::new(self.0).package,
            package_type: "editorExtension".into(),
            display_name: "Web".into(),
            description: "Web".into(),
            license: "MIT".into(),
            source: PackageSource::ThirdParty,
            upstream: None,
            capabilities: Vec::new(),
        })
    }
    fn download(
        &self,
        _: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new(WebPackage::new(self.0)))
    }
}

#[test]
fn marketplace_web_execution_requires_exact_persistent_consent_and_pins_the_package() {
    let profile = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        PluginsManager::open(
            profile.path().join("manager"),
            super::providers(Arc::new(WebRegistry("./main"))),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "test.web@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let path = profile.path().join("editor-policy.json");
    let policy = Arc::new(EditorExtensionPolicy::open(path.clone()).unwrap());
    let admission: Arc<dyn MarketplaceEditorExtensionAdmission> =
        Arc::new(ProfileEditorExtensionAdmission(Arc::clone(&policy)));
    let deployment = super::super::deployments(&manager, &admission)
        .unwrap()
        .remove(0);
    assert!(deployment.command.is_vscode());
    let plan = deployment.activation.as_ref().unwrap();
    assert_eq!(plan.events, ["onCommand:web.hello"]);
    assert_eq!(plan.commands, [("web.hello".into(), "Hello".into())]);
    assert_eq!(deployment.params.package.entrypoint, "main.js");
    assert!(!deployment.authority.authorizes());
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugins_manager(Arc::clone(&manager))
    .with_editor_extension_policy(Arc::clone(&policy));
    let mut untrusted = server.connection();
    server.handle_json(&mut untrusted, &json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"test","version":"1"}, "capabilities":{}}}).to_string());
    for (id, method, params) in [
        (2, "marketplace/editorExtensions", json!({})),
        (
            4,
            "extensionHost/activate",
            json!({"extensionId":"lazy","activationGeneration":1,"event":{"type":"command","command":"lazy.run"}}),
        ),
        (
            3,
            "marketplace/setEditorExtensionPolicy",
            json!({"installationId":installed.installation_id,"packageDigest":installed.package.digest,"expectedRevision":1,"action":"grant"}),
        ),
    ] {
        let denied: serde_json::Value = serde_json::from_str(&server.handle_json(
            &mut untrusted,
            &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string(),
        ))
        .unwrap();
        assert_eq!(denied["error"]["message"], "ResourceNotOwner");
    }
    assert_eq!(policy.generation(), 1);
    let mut connection = server.product_host_connection();
    let mut sequence = 0;
    let mut call = |method: &str, params: serde_json::Value| {
        sequence += 1;
        serde_json::from_str::<serde_json::Value>(&server.handle_json(
            &mut connection,
            &json!({"jsonrpc":"2.0", "id":sequence, "method":method, "params":params}).to_string(),
        ))
        .unwrap()
    };
    call(
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"}, "capabilities":{}}),
    );
    let invalid_activation = call(
        "extensionHost/activate",
        json!({"extensionId":"lazy","activationGeneration":1,"event":{"type":"language","languageId":""}}),
    );
    assert_eq!(invalid_activation["error"]["code"], -32602);
    let listing = call("marketplace/editorExtensions", json!({}));
    assert_eq!(listing["result"]["extensions"][0]["entrypoint"], "main.js");
    let params = |action: &str, revision: u64, digest: &str| json!({"installationId":installed.installation_id,"packageDigest":digest,"expectedRevision":revision,"action":action});
    let enabled = call(
        "marketplace/setEditorExtensionPolicy",
        params("enable", 1, &installed.package.digest),
    );
    assert_eq!(enabled["result"]["extensions"][0]["granted"], false);
    assert!(!deployment.authority.authorizes());
    let conflict = call(
        "marketplace/setEditorExtensionPolicy",
        params("grant", 1, &installed.package.digest),
    );
    assert_eq!(conflict["error"]["code"], -32041);
    let mismatch = call(
        "marketplace/setEditorExtensionPolicy",
        params("grant", 2, "wrong-digest"),
    );
    assert_eq!(mismatch["error"]["code"], -32602);
    let granted = call(
        "marketplace/setEditorExtensionPolicy",
        params("grant", 2, &installed.package.digest),
    );
    assert_eq!(granted["result"]["revision"], 3);
    assert!(deployment.authority.authorizes());
    let source = manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .unwrap()
        .remove(0);
    assert!(
        EditorExtensionPolicy::open(path)
            .unwrap()
            .snapshot(source.package(), source.capability())
            .granted
    );
    let lease = deployment.authority.acquire().unwrap();
    assert!(
        manager
            .uninstall(UninstallPackageRequest {
                installation_id: installed.installation_id.clone(),
                mode: UninstallMode::IfUnused
            })
            .is_err()
    );
    call(
        "marketplace/setEditorExtensionPolicy",
        params("revoke", 3, &installed.package.digest),
    );
    assert!(!deployment.authority.authorizes());
    assert!(deployment.authority.acquire().is_none());
    drop(lease);
    manager
        .uninstall(UninstallPackageRequest {
            installation_id: installed.installation_id.clone(),
            mode: UninstallMode::IfUnused,
        })
        .unwrap();
    assert!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .is_empty()
    );
}

#[test]
fn marketplace_commonjs_entry_reaches_the_installed_package_deployment() {
    let profile = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        PluginsManager::open(
            profile.path().join("manager"),
            super::providers(Arc::new(WebRegistry("./main.cjs"))),
        )
        .unwrap(),
    );
    manager
        .install(InstallPackageRequest {
            package_id: "test.web@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let admission: Arc<dyn MarketplaceEditorExtensionAdmission> =
        Arc::new(ProfileEditorExtensionAdmission(Arc::new(
            EditorExtensionPolicy::open(profile.path().join("editor-policy.json")).unwrap(),
        )));
    let deployment = super::super::deployments(&manager, &admission)
        .unwrap()
        .remove(0);
    assert!(deployment.command.is_vscode());
    assert_eq!(deployment.params.package.entrypoint, "main.cjs");
    assert_eq!(
        deployment.activation.unwrap().events,
        ["onCommand:web.hello"]
    );
    assert!(!deployment.authority.authorizes());
}

#[test]
fn marketplace_web_entry_cannot_escape_the_verified_extension_directory() {
    let profile = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        PluginsManager::open(
            profile.path().join("manager"),
            super::providers(Arc::new(WebRegistry("../../outside.js"))),
        )
        .unwrap(),
    );
    manager
        .install(InstallPackageRequest {
            package_id: "test.web@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let source = manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .unwrap()
        .remove(0);
    assert!(super::super::javascript_entrypoint(&source).is_err());
}
