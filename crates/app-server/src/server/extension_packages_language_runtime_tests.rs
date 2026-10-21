use std::fs;
use std::path::Path;
use std::sync::Arc;

use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::ActivationSpec;
use ash_core_plugins::AvailableCapability;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::DownloadPackageRequest;
use ash_core_plugins::ExtensionPackageCapability;
use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::ExtensionPackagePayload;
use ash_core_plugins::ExtensionPackageService;
use ash_core_plugins::ExtensionSource;
use ash_core_plugins::ExtensionsClientError;
use ash_core_plugins::GetPackageRequest;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::OpenResourceRequest;
use ash_core_plugins::PackageDetails;
use ash_core_plugins::PackageRef;
use ash_core_plugins::PackageSource;
use ash_core_plugins::PackageSummary;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::SearchPackagesResult;
use ash_core_plugins::UninstallMode;
use ash_core_plugins::UninstallPackageRequest;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::ExtensionPackages;
use ash_external_ext::packages::ExtensionPackagesReload;
use ash_external_ext::packages::ExtensionRootKind;
use ash_external_ext::packages::ExtensionSourceKind;
use ash_lsp_server_provider::LspServerLaunch;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::Digest;
use sha2::Sha256;

use super::UpdateBroker;
use super::extension_packages_extension_sources::ExtensionsExtensionSourceProvider;
use super::extension_packages_language_runtime::ExtensionsLanguageRuntime;
use super::extension_packages_runtime::ExtensionsChangeWatcher;
use super::notification_queue::NotificationQueue;

const LANGUAGE_MANIFEST: &[u8] = br#"{
  "name": "demo-language",
  "contributes": { "languages": [{ "id": "demo" }] }
}"#;
const SERVER_ENTRYPOINT: &[u8] = b"// demo language server\n";
const THEME_MANIFEST: &[u8] = br#"{
  "schemaVersion": 1,
  "themes": [{
    "id": "demo",
    "displayName": "Demo",
    "appearance": "dark",
    "path": "themes/demo.json"
  }]
}"#;
const THEME_DOCUMENT: &[u8] = br#"{"type":"dark","colors":{},"tokenColors":[]}"#;
const EDITOR_ASSET_MANIFEST: &[u8] = br#"{
  "name":"sample", "publisher":"ash", "version":"1.0.0",
  "engines":{"ash":">=0.1.0"}, "main":"./main.js", "browser":"./main.js",
  "contributes":{"languages":[{"id":"sample","extensions":[".sample"]}],
    "themes":[{"id":"sample","label":"Sample","uiTheme":"vs-dark","path":"./themes/sample.json"}],
    "debuggers":[{"type":"sample","label":"Unsafe adapter","debugAdapter":{"program":"node","arguments":["main.js"]}}]}
}"#;

#[test]
fn ash_editor_assets_enter_the_catalog_and_disappear_after_uninstall() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ExtensionPackageManager::open(root.path(), providers(Arc::new(LanguageRegistry))).unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "ash.sample@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        ExtensionsExtensionSourceProvider::new(manager.clone(), None),
    ));
    let snapshot = catalog.list(ExtensionPackagesReload::Refresh);
    assert!(
        snapshot.diagnostics.is_empty(),
        "{:?}",
        snapshot.diagnostics
    );
    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "test.ash.sample");
    let manifest: serde_json::Value =
        serde_json::from_str(&snapshot.extensions[0].manifest_json).unwrap();
    assert_eq!(manifest["contributes"]["languages"][0]["id"], "sample");
    assert_eq!(manifest["contributes"]["themes"][0]["label"], "Sample");
    assert!(manifest.get("main").is_none());
    assert!(manifest.get("browser").is_none());
    assert!(manifest["contributes"].get("debuggers").is_none());
    assert!(
        manager
            .acquire_capability(AcquireCapabilityRequest {
                capability: installed.capabilities[0].reference.clone(),
            })
            .is_err(),
        "storing a script does not admit an executable extension"
    );
    manager
        .uninstall(ash_core_plugins::UninstallPackageRequest {
            installation_id: installed.installation_id,
            mode: ash_core_plugins::UninstallMode::IfUnused,
        })
        .unwrap();
    assert!(
        catalog
            .list(ExtensionPackagesReload::Refresh)
            .extensions
            .is_empty()
    );
}

#[test]
fn extension_packages_manager_commit_watcher_broadcasts_the_authoritative_change() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(updates.allocate_connection_id(), false, &queue);
    let _watcher = ExtensionsChangeWatcher::start(&manager, Arc::clone(&updates)).unwrap();

    manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    for _ in 0..50 {
        if queue.len() > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "extensions/changed");
    assert_eq!(notifications[0]["params"]["generation"], 2);
}

#[test]
fn installed_language_package_projects_assets_and_packaged_server() {
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node");
    fs::write(&node, b"#!/bin/sh\n").unwrap();
    make_executable(&node);
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();

    let extension_snapshot = ExtensionsExtensionSourceProvider::new(manager.clone(), None)
        .snapshot()
        .unwrap();
    assert_eq!(extension_snapshot.packages.len(), 1);
    assert_eq!(
        extension_snapshot.packages[0].kind,
        ExtensionRootKind::Registry
    );
    assert!(
        extension_snapshot.packages[0]
            .path
            .join("package.json")
            .is_file()
    );

    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        ExtensionsExtensionSourceProvider::new(manager.clone(), None),
    ));
    let catalog = catalog.list(ExtensionPackagesReload::Refresh);
    assert!(catalog.diagnostics.is_empty(), "{:?}", catalog.diagnostics);
    assert_eq!(catalog.extensions.len(), 1);

    let mut runtime = ExtensionsLanguageRuntime::new(
        manager.clone(),
        Some(ManagedNodeRuntime::from_path(&node).unwrap()),
        LspServerProviders::new(),
    );
    let providers = runtime.providers().unwrap();
    assert!(providers.contains("demo-language-server"));
    assert!(providers.activation_enables("demo-language-server"));
    let definition = providers
        .definition(
            "demo-language-server",
            root.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    assert_eq!(definition.language_ids().collect::<Vec<_>>(), vec!["demo"]);
    let (_, command, _) = definition.into_launch_parts();
    assert_eq!(command.program(), node.canonicalize().unwrap().as_os_str());
    assert_eq!(command.arguments().last().unwrap(), "--stdio");

    let language = installed
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Language)
        .unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(root.path().join("editor-policy.json"))
            .unwrap(),
    );
    runtime.set_editor_extension_policy(policy.clone());
    let peer = Arc::new(std::sync::Mutex::new(
        super::language_runtime::AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default())),
    ));
    peer.lock()
        .unwrap()
        .set_server_providers(runtime.providers().unwrap());
    let _watcher = ExtensionsChangeWatcher::start_language_runtime(
        Some(&policy),
        runtime.clone(),
        peer.clone(),
    )
    .unwrap();
    let peer_servers = || {
        peer.lock()
            .unwrap()
            .definitions(root.path(), &ash_config::LanguageServersConfig::default())
            .unwrap()
            .len()
    };
    assert_eq!(peer_servers(), 1);
    policy
        .set(
            &installed.package,
            &language.reference,
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            policy.generation(),
        )
        .unwrap();
    assert!(
        !runtime
            .providers()
            .unwrap()
            .contains("demo-language-server")
    );
    for _ in 0..100 {
        if peer_servers() == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        peer_servers(),
        0,
        "another directory consumer retires its disabled provider"
    );
    policy
        .set(
            &installed.package,
            &language.reference,
            ash_core_plugins::EditorExtensionPolicyAction::Enable,
            policy.generation(),
        )
        .unwrap();
    assert!(
        runtime
            .providers()
            .unwrap()
            .contains("demo-language-server")
    );
    for _ in 0..100 {
        if peer_servers() == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(peer_servers(), 1);
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: language.reference.clone(),
        })
        .unwrap();
    let resource = match acquired.spec {
        ActivationSpec::Language(spec) => spec.manifest,
        _ => panic!("expected Language activation"),
    };
    let content = manager
        .open_resource(OpenResourceRequest {
            lease_id: acquired.lease.id,
            resource,
        })
        .unwrap();
    assert_eq!(
        STANDARD.decode(content.data_base64).unwrap(),
        LANGUAGE_MANIFEST
    );

    let executable = installed
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Executable)
        .unwrap();
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: executable.reference.clone(),
        })
        .unwrap();
    let resource = match acquired.spec {
        ActivationSpec::Executable(spec) => spec.entrypoint,
        _ => panic!("expected Executable activation"),
    };
    let content = manager
        .open_resource(OpenResourceRequest {
            lease_id: acquired.lease.id,
            resource,
        })
        .unwrap();
    assert_eq!(
        STANDARD.decode(content.data_base64).unwrap(),
        SERVER_ENTRYPOINT
    );
}

#[test]
fn installed_theme_enters_the_shared_declarative_extension_catalog() {
    let root = tempfile::tempdir().unwrap();
    let sources = ash_core_plugins::ExtensionSources::new(["test", "vendor"].map(|name| {
        (
            ash_utils_plugins::ExtensionSourceId::new(name).unwrap(),
            Arc::new(LanguageRegistry) as Arc<dyn ExtensionSource>,
        )
    }))
    .unwrap();
    let manager =
        Arc::new(ExtensionPackageManager::open(root.path().join("manager"), sources).unwrap());
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-theme@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let provider: Arc<dyn DynamicExtensionSourceProvider> = Arc::new(
        ExtensionsExtensionSourceProvider::new(Arc::clone(&manager), None),
    );
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(provider);
    let snapshot = catalog.list(ExtensionPackagesReload::Refresh);
    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "test.example.demo-theme");
    assert_eq!(
        snapshot.extensions[0].source_kind,
        ExtensionSourceKind::Registry
    );
    let normalized_manifest: serde_json::Value =
        serde_json::from_str(&snapshot.extensions[0].manifest_json).unwrap();
    assert_eq!(normalized_manifest["themes"][0]["appearance"], "dark");
    manager
        .install(InstallPackageRequest {
            package_id: "example.demo-theme@vendor".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let snapshot = catalog.list(ExtensionPackagesReload::Refresh);
    assert_eq!(
        snapshot
            .extensions
            .iter()
            .map(|extension| extension.id.as_str())
            .collect::<Vec<_>>(),
        ["test.example.demo-theme", "vendor.example.demo-theme"]
    );

    let theme = installed
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Theme)
        .unwrap();
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: theme.reference.clone(),
        })
        .unwrap();
    let resource = match acquired.spec {
        ActivationSpec::Theme(spec) => spec.manifest,
        _ => panic!("expected Theme activation"),
    };
    let content = manager
        .open_resource(OpenResourceRequest {
            lease_id: acquired.lease.id,
            resource,
        })
        .unwrap();
    assert_eq!(
        STANDARD.decode(content.data_base64).unwrap(),
        THEME_MANIFEST
    );
}

#[test]
fn a_corrupt_theme_does_not_remove_healthy_extension_packages_languages() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ExtensionPackageManager::open(root.path(), providers(Arc::new(LanguageRegistry))).unwrap(),
    );
    for package_id in ["example.demo-theme@test", "example.demo-language@test"] {
        manager
            .install(InstallPackageRequest {
                package_id: package_id.into(),
                version: Some("1.0.0".into()),
            })
            .unwrap();
    }
    let theme = manager
        .local_capability_sources(CapabilityKind::Theme)
        .unwrap()
        .remove(0);
    // A corrupt immutable artifact is retired without removing other capability families.
    fs::write(theme.host_path().join("package.json"), "invalid JSON").unwrap();
    let provider = Arc::new(ExtensionsExtensionSourceProvider::new(manager, None));
    let mut packages = ExtensionPackages::new(Vec::new()).with_dynamic_sources(provider);
    let snapshot = packages.list(ExtensionPackagesReload::Refresh);
    assert_eq!(
        snapshot
            .extensions
            .iter()
            .map(|extension| extension.id.as_str())
            .collect::<Vec<_>>(),
        ["test.example.demo-language"]
    );
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ash_external_ext::packages::ExtensionDiagnosticCode::SourceUnavailable
    );
    assert_eq!(packages.list(ExtensionPackagesReload::Cached), snapshot);
}

#[test]
fn disabling_an_editor_package_retires_its_declarative_catalog_and_restores_it_on_enable() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("packages"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "ash.sample@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap(),
    );
    let source = manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .unwrap()
        .remove(0);
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        ExtensionsExtensionSourceProvider::new(manager.clone(), Some(policy.clone())),
    ));
    let initial = catalog.list(ExtensionPackagesReload::Refresh);
    assert_eq!(initial.extensions.len(), 1);
    policy
        .set(
            source.package(),
            source.capability(),
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            1,
        )
        .unwrap();
    let disabled = catalog.list(ExtensionPackagesReload::Refresh);
    assert!(disabled.extensions.is_empty());
    assert!(disabled.generation > initial.generation);
    assert_eq!(
        manager
            .list_installed(ash_core_plugins::ListInstalledRequest {})
            .unwrap(),
        [installed]
    );
    policy
        .set(
            source.package(),
            source.capability(),
            ash_core_plugins::EditorExtensionPolicyAction::Enable,
            2,
        )
        .unwrap();
    let restored = catalog.list(ExtensionPackagesReload::Refresh);
    assert_eq!(restored.extensions.len(), 1);
    assert!(restored.generation > disabled.generation);
}

struct LanguageRegistry;

impl ExtensionSource for LanguageRegistry {
    fn search(
        &self,
        _: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError> {
        Ok(SearchPackagesResult {
            unavailable_sources: Vec::new(),
            packages: vec![PackageSummary {
                id: "example.demo-language".into(),
                version: "1.0.0".into(),
                package_type: "language".into(),
                display_name: "Demo Language".into(),
                description: "Demo language support".into(),
            }],
        })
    }

    fn get(&self, _: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError> {
        let payload = LanguagePayload::new();
        Ok(PackageDetails {
            package: payload.package,
            package_type: "language".into(),
            display_name: "Demo Language".into(),
            description: "Demo language support".into(),
            license: "MIT".into(),
            source: PackageSource::ThirdParty,
            upstream: None,
            capabilities: payload
                .capabilities
                .into_iter()
                .map(|capability| AvailableCapability {
                    kind: capability.kind,
                    id: capability.id,
                    contract_version: "1".into(),
                    permissions: Vec::new(),
                    authentication_provider: None,
                })
                .collect(),
        })
    }

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn ExtensionPackagePayload>, ExtensionsClientError> {
        match request.package_id.as_str() {
            "example.demo-language" => {
                let mut payload = LanguagePayload::new();
                if request.version.as_deref() == Some("2.0.0") {
                    payload.package.version = "2.0.0".into();
                    payload.entrypoint = b"// updated server contents\n";
                    payload.capabilities[1].language_ids = vec!["demo2".into()];
                    payload.package.digest = package_digest(&[
                        ("language/package.json", LANGUAGE_MANIFEST),
                        ("server/demo.js", payload.entrypoint),
                    ]);
                }
                Ok(Box::new(payload))
            }
            "example.broken-language" => {
                let mut payload = LanguagePayload::new();
                payload.package.id = "example.broken-language".into();
                payload.entrypoint = b"// independent package contents\n";
                payload.package.digest = package_digest(&[
                    ("language/package.json", LANGUAGE_MANIFEST),
                    ("server/demo.js", payload.entrypoint),
                ]);
                Ok(Box::new(payload))
            }
            "example.demo-theme" => Ok(Box::new(ThemePayload::new())),
            "ash.sample" => Ok(Box::new(AshEditorPayload)),
            _ => Err(ExtensionsClientError::storage()),
        }
    }
}

struct AshEditorPayload;

const EDITOR_ASSET_FILES: &[(&str, &[u8])] = &[
    ("editor/main.js", b"throw new Error('must not run');"),
    ("editor/package.json", EDITOR_ASSET_MANIFEST),
    ("editor/themes/sample.json", THEME_DOCUMENT),
];

impl ExtensionPackagePayload for AshEditorPayload {
    fn package(&self) -> &PackageRef {
        static PACKAGE: std::sync::OnceLock<PackageRef> = std::sync::OnceLock::new();
        PACKAGE.get_or_init(|| PackageRef {
            id: "ash.sample".into(),
            version: "1.0.0".into(),
            digest: package_digest(EDITOR_ASSET_FILES),
        })
    }
    fn capabilities(&self) -> &[ExtensionPackageCapability] {
        static CAPABILITIES: std::sync::OnceLock<Vec<ExtensionPackageCapability>> =
            std::sync::OnceLock::new();
        CAPABILITIES.get_or_init(|| {
            vec![ExtensionPackageCapability {
                kind: CapabilityKind::EditorExtension,
                id: "ash.sample".into(),
                path: "editor".into(),
                runtime: None,
                language_ids: Vec::new(),
            }]
        })
    }
    fn expected_file_count(&self) -> u64 {
        EDITOR_ASSET_FILES.len() as u64
    }
    fn expected_size_bytes(&self) -> u64 {
        EDITOR_ASSET_FILES
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum()
    }
    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError> {
        fs::create_dir_all(destination.join("editor/themes"))
            .map_err(|_| ExtensionsClientError::storage())?;
        for (path, bytes) in EDITOR_ASSET_FILES {
            fs::write(destination.join(path), bytes)
                .map_err(|_| ExtensionsClientError::storage())?;
        }
        Ok(())
    }
}

struct ThemePayload {
    package: PackageRef,
    capabilities: Vec<ExtensionPackageCapability>,
}

impl ThemePayload {
    fn new() -> Self {
        Self {
            package: PackageRef {
                id: "example.demo-theme".into(),
                version: "1.0.0".into(),
                digest: package_digest(&[
                    ("theme/package.json", THEME_MANIFEST),
                    ("theme/themes/demo.json", THEME_DOCUMENT),
                ]),
            },
            capabilities: vec![ExtensionPackageCapability {
                kind: CapabilityKind::Theme,
                id: "theme-assets".into(),
                path: "theme".into(),
                runtime: None,
                language_ids: Vec::new(),
            }],
        }
    }
}

impl ExtensionPackagePayload for ThemePayload {
    fn package(&self) -> &PackageRef {
        &self.package
    }

    fn capabilities(&self) -> &[ExtensionPackageCapability] {
        &self.capabilities
    }

    fn expected_file_count(&self) -> u64 {
        2
    }

    fn expected_size_bytes(&self) -> u64 {
        (THEME_DOCUMENT.len() + THEME_MANIFEST.len()) as u64
    }

    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError> {
        fs::create_dir(destination.join("theme")).map_err(|_| ExtensionsClientError::storage())?;
        fs::create_dir(destination.join("theme/themes"))
            .map_err(|_| ExtensionsClientError::storage())?;
        fs::write(destination.join("theme/themes/demo.json"), THEME_DOCUMENT)
            .map_err(|_| ExtensionsClientError::storage())?;
        fs::write(destination.join("theme/package.json"), THEME_MANIFEST)
            .map_err(|_| ExtensionsClientError::storage())
    }
}

struct LanguagePayload {
    package: PackageRef,
    capabilities: Vec<ExtensionPackageCapability>,
    entrypoint: &'static [u8],
}

impl LanguagePayload {
    fn new() -> Self {
        Self {
            entrypoint: SERVER_ENTRYPOINT,
            package: PackageRef {
                id: "example.demo-language".into(),
                version: "1.0.0".into(),
                digest: package_digest(&[
                    ("language/package.json", LANGUAGE_MANIFEST),
                    ("server/demo.js", SERVER_ENTRYPOINT),
                ]),
            },
            capabilities: vec![
                ExtensionPackageCapability {
                    kind: CapabilityKind::Language,
                    id: "language-assets".into(),
                    path: "language".into(),
                    runtime: None,
                    language_ids: Vec::new(),
                },
                ExtensionPackageCapability {
                    kind: CapabilityKind::Executable,
                    id: "demo-language-server".into(),
                    path: "server/demo.js".into(),
                    runtime: Some("node".into()),
                    language_ids: vec!["demo".into()],
                },
            ],
        }
    }
}

impl ExtensionPackagePayload for LanguagePayload {
    fn package(&self) -> &PackageRef {
        &self.package
    }

    fn capabilities(&self) -> &[ExtensionPackageCapability] {
        &self.capabilities
    }

    fn expected_file_count(&self) -> u64 {
        2
    }

    fn expected_size_bytes(&self) -> u64 {
        (LANGUAGE_MANIFEST.len() + self.entrypoint.len()) as u64
    }

    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError> {
        fs::create_dir(destination.join("language"))
            .map_err(|_| ExtensionsClientError::storage())?;
        fs::create_dir(destination.join("server")).map_err(|_| ExtensionsClientError::storage())?;
        fs::write(destination.join("language/package.json"), LANGUAGE_MANIFEST)
            .map_err(|_| ExtensionsClientError::storage())?;
        fs::write(destination.join("server/demo.js"), self.entrypoint)
            .map_err(|_| ExtensionsClientError::storage())
    }
}

fn package_digest(files: &[(&str, &[u8])]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"marketplace-package-v1\0");
    for (path, contents) in files {
        hasher.update((path.len() as u64).to_be_bytes());
        hasher.update(path.as_bytes());
        hasher.update((contents.len() as u64).to_be_bytes());
        hasher.update(contents);
    }
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_: &Path) {}

fn providers(provider: Arc<dyn ExtensionSource>) -> ash_core_plugins::ExtensionSources {
    ash_core_plugins::ExtensionSources::new([(
        ash_utils_plugins::ExtensionSourceId::new("test").unwrap(),
        provider,
    )])
    .unwrap()
}

#[test]
fn language_acquisition_only_admits_built_in_packages_and_rejects_conflicting_owners() {
    use super::extension_packages_language_runtime::language_server_contributions;
    use ash_external_ext::packages::ExtensionRoot;
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("rust");
    fs::create_dir(&package).unwrap();
    let manifest = include_str!("../../../../extensions/rust/package.json");
    fs::write(package.join("package.json"), manifest).unwrap();
    let mut user = ExtensionPackages::new(vec![ExtensionRoot::user(root.path())]);
    assert!(
        language_server_contributions(&user.list(ExtensionPackagesReload::Cached))
            .unwrap()
            .is_empty()
    );
    let mut builtin = ExtensionPackages::new(vec![ExtensionRoot::built_in(root.path())]);
    let snapshot = builtin.list(ExtensionPackagesReload::Cached);
    assert_eq!(
        language_server_contributions(&snapshot).unwrap()["vscode.rust"][0].id,
        "rust-analyzer"
    );
    let conflict = root.path().join("other");
    fs::create_dir(&conflict).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(manifest).unwrap();
    value["name"] = serde_json::json!("other");
    fs::write(
        conflict.join("package.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    assert!(
        language_server_contributions(&builtin.list(ExtensionPackagesReload::Refresh)).is_err()
    );
}

#[test]
fn language_definition_lease_defers_removal_until_the_last_runtime_owner_releases_it() {
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node");
    fs::write(&node, b"runtime").unwrap();
    make_executable(&node);
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: None,
        })
        .unwrap();
    let runtime = ExtensionsLanguageRuntime::new(
        manager.clone(),
        Some(ManagedNodeRuntime::from_path(node).unwrap()),
        LspServerProviders::new(),
    );
    let providers = runtime.providers().unwrap();
    let definition = providers
        .definition(
            "demo-language-server",
            root.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    let retained = definition.clone();
    assert!(
        manager
            .uninstall(UninstallPackageRequest {
                installation_id: installed.installation_id.clone(),
                mode: UninstallMode::IfUnused
            })
            .is_err()
    );
    manager
        .uninstall(UninstallPackageRequest {
            installation_id: installed.installation_id.clone(),
            mode: UninstallMode::WhenUnused,
        })
        .unwrap();
    assert!(runtime.providers().unwrap().is_empty());
    assert_eq!(
        manager.list_installed(ListInstalledRequest {}).unwrap()[0].state,
        ash_core_plugins::InstallationState::PendingRemoval
    );
    drop(definition);
    assert_eq!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .len(),
        1
    );
    drop(retained);
    assert!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .is_empty()
    );
}

#[test]
fn language_package_changes_retire_idle_peer_runtime_and_complete_deferred_uninstall() {
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node");
    fs::write(&node, b"runtime").unwrap();
    make_executable(&node);
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: None,
        })
        .unwrap();
    let runtime = ExtensionsLanguageRuntime::new(
        manager.clone(),
        Some(ManagedNodeRuntime::from_path(node).unwrap()),
        LspServerProviders::new(),
    );
    let providers = runtime.providers().unwrap();
    let definition = providers
        .definition(
            "demo-language-server",
            root.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    let peer = Arc::new(std::sync::Mutex::new(
        super::language_runtime::AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default())),
    ));
    peer.lock().unwrap().set_server_providers(providers);
    // A manager retains configured definitions before any document starts its process.
    peer.lock().unwrap().manager = Some(Arc::new(
        ash_lsp_manager::LspManager::start_with_events(
            ash_lsp_manager::LspManagerConfiguration::enabled(root.path(), vec![definition]),
            Arc::new(ash_lsp_manager::NoopLspManagerEventSink),
        )
        .unwrap(),
    ));
    let _watcher =
        ExtensionsChangeWatcher::start_language_runtime(None, runtime, peer.clone()).unwrap();
    assert!(
        manager
            .uninstall(UninstallPackageRequest {
                installation_id: installed.installation_id.clone(),
                mode: UninstallMode::IfUnused,
            })
            .is_err()
    );
    manager
        .uninstall(UninstallPackageRequest {
            installation_id: installed.installation_id,
            mode: UninstallMode::WhenUnused,
        })
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !manager
        .list_installed(ListInstalledRequest {})
        .unwrap()
        .is_empty()
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .is_empty(),
        "an idle peer must release its lease without a renderer request"
    );
    // The coordinator can survive with no routes; the retired definition must release its lease.
    assert!(
        peer.lock()
            .unwrap()
            .definitions(root.path(), &ash_config::LanguageServersConfig::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn damaged_executable_package_does_not_hide_a_healthy_server_or_prevent_its_disablement() {
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node");
    fs::write(&node, b"runtime").unwrap();
    make_executable(&node);
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let healthy = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: None,
        })
        .unwrap();
    let broken = manager
        .install(InstallPackageRequest {
            package_id: "example.broken-language@test".into(),
            version: None,
        })
        .unwrap();
    let sources = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap();
    let damaged = sources
        .iter()
        .find(|source| source.package() == &broken.package)
        .unwrap();
    fs::write(damaged.host_path(), "corrupt executable").unwrap();
    let snapshot = manager
        .local_capability_source_snapshot(CapabilityKind::Executable)
        .unwrap();
    assert_eq!(snapshot.sources.len(), 1);
    assert_eq!(snapshot.failures.len(), 1);
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap(),
    );
    let mut runtime = ExtensionsLanguageRuntime::new(
        manager,
        Some(ManagedNodeRuntime::from_path(node).unwrap()),
        LspServerProviders::new(),
    );
    runtime.set_editor_extension_policy(policy.clone());
    assert!(
        runtime
            .providers()
            .unwrap()
            .contains("demo-language-server")
    );
    let executable = healthy
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Executable)
        .unwrap();
    policy
        .set(
            &healthy.package,
            &executable.reference,
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            policy.generation(),
        )
        .unwrap();
    assert!(runtime.providers().unwrap().is_empty());
}

#[test]
fn exact_language_provider_identity_survives_unrelated_packages_and_changes_on_update_or_reenable()
{
    let root = tempfile::tempdir().unwrap();
    let node = root.path().join("node");
    fs::write(&node, b"runtime").unwrap();
    make_executable(&node);
    let manager = Arc::new(
        ExtensionPackageManager::open(
            root.path().join("manager"),
            providers(Arc::new(LanguageRegistry)),
        )
        .unwrap(),
    );
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "example.demo-language@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let policy = Arc::new(
        ash_core_plugins::EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap(),
    );
    let mut runtime = ExtensionsLanguageRuntime::new(
        manager.clone(),
        Some(ManagedNodeRuntime::from_path(node).unwrap()),
        LspServerProviders::new(),
    );
    runtime.set_editor_extension_policy(policy.clone());
    let first = runtime.providers().unwrap();
    manager
        .install(InstallPackageRequest {
            package_id: "example.demo-theme@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    assert!(
        first.ptr_eq(&runtime.clone().providers().unwrap()),
        "installing a theme cannot replace a language provider"
    );
    let executable = installed
        .capabilities
        .iter()
        .find(|capability| capability.kind == CapabilityKind::Executable)
        .unwrap();
    policy
        .set(
            &installed.package,
            &executable.reference,
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            policy.generation(),
        )
        .unwrap();
    assert!(runtime.providers().unwrap().is_empty());
    policy
        .set(
            &installed.package,
            &executable.reference,
            ash_core_plugins::EditorExtensionPolicyAction::Enable,
            policy.generation(),
        )
        .unwrap();
    let restored = runtime.providers().unwrap();
    assert!(
        !first.same_provider(&restored, "demo-language-server"),
        "reenabling must not reuse a retired provider instance"
    );
    manager
        .update(ash_core_plugins::UpdatePackageRequest {
            installation_id: installed.installation_id,
            version: Some("2.0.0".into()),
        })
        .unwrap();
    let updated = runtime.providers().unwrap();
    assert!(
        !restored.same_provider(&updated, "demo-language-server"),
        "a stable server ID cannot hide a new version, digest or route"
    );
    let definition = updated
        .definition(
            "demo-language-server",
            root.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    assert_eq!(definition.language_ids().collect::<Vec<_>>(), ["demo2"]);
}
