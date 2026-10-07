use std::fs;
use std::path::Path;
use std::sync::Arc;

use crate::AcquireCapabilityRequest;
use crate::AvailableCapability;
use crate::CapabilityKind;
use crate::DownloadPackageRequest;
use crate::GetPackageRequest;
use crate::InstallPackageRequest;
use crate::ListInstalledRequest;
use crate::MarketplaceClientError;
use crate::OpenResourceRequest;
use crate::PackageDetails;
use crate::PackageRef;
use crate::PackageSummary;
use crate::PluginPackageCapability;
use crate::PluginPackagePayload;
use crate::PluginPackageService;
use crate::PluginProvider;
use crate::ReleaseCapabilityRequest;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::UninstallMode;
use crate::UninstallPackageRequest;
use crate::UpdatePackageRequest;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::Digest;
use sha2::Sha256;

use super::PluginsManager;

const SKILL_CONTENT: &[u8] = b"# Demo skill\n";
const MCP_DEFINITION: &[u8] = br#"{
  "schemaVersion": 1,
  "transport": "stdio",
  "command": "server/demo",
  "args": ["--stdio"]
}"#;
const MCP_EXECUTABLE: &[u8] = b"#!/bin/sh\n";

#[test]
fn local_manager_persists_the_full_installed_state() {
    let root = tempfile::tempdir().unwrap();
    let registry = Arc::new(FakeRegistry);
    let manager = PluginsManager::open(root.path(), providers(registry.clone())).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    assert_eq!(installed.capabilities.len(), 1);
    assert_eq!(
        manager.list_installed(ListInstalledRequest {}).unwrap(),
        vec![installed.clone()]
    );

    let reopened = PluginsManager::open(root.path(), providers(registry)).unwrap();
    assert_eq!(
        reopened.list_installed(ListInstalledRequest {}).unwrap(),
        vec![installed]
    );
}

#[test]
fn local_manager_updates_uninstalls_and_owns_resource_leases() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: installed.capabilities[0].reference.clone(),
        })
        .unwrap();
    let resource = match &acquired.spec {
        crate::ActivationSpec::Skill(skill) => skill.resource.clone(),
        _ => panic!("expected Skill activation"),
    };
    let content = manager
        .open_resource(OpenResourceRequest {
            lease_id: acquired.lease.id.clone(),
            resource,
        })
        .unwrap();
    assert_eq!(STANDARD.decode(content.data_base64).unwrap(), SKILL_CONTENT);
    let release = manager
        .release_capability(ReleaseCapabilityRequest {
            lease_id: acquired.lease.id,
        })
        .unwrap();
    assert!(!release.installation_changed);

    let updated = manager
        .update(UpdatePackageRequest {
            installation_id: installed.installation_id,
            version: Some("2.0.0".into()),
        })
        .unwrap();
    assert_eq!(updated.package.version, "2.0.0");
    assert_eq!(
        manager.list_installed(ListInstalledRequest {}).unwrap(),
        vec![updated.clone()]
    );
    manager
        .uninstall(UninstallPackageRequest {
            installation_id: updated.installation_id,
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
fn releasing_the_last_lease_reports_and_publishes_deferred_removal() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let changes = manager.subscribe().unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    assert_eq!(changes.recv().unwrap(), 2);
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: installed.capabilities[0].reference.clone(),
        })
        .unwrap();

    manager
        .uninstall(UninstallPackageRequest {
            installation_id: installed.installation_id,
            mode: UninstallMode::WhenUnused,
        })
        .unwrap();
    assert_eq!(changes.recv().unwrap(), 3);
    assert_eq!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .len(),
        1
    );

    let release = manager
        .release_capability(ReleaseCapabilityRequest {
            lease_id: acquired.lease.id,
        })
        .unwrap();
    assert!(release.installation_changed);
    assert_eq!(changes.recv().unwrap(), 4);
    assert!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .is_empty()
    );
}

#[test]
fn local_capability_sources_revalidate_the_immutable_artifact() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();

    let sources = manager
        .local_capability_sources(CapabilityKind::Skill)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].id(), "demo");
    assert_eq!(sources[0].runtime(), None);
    assert!(sources[0].language_ids().is_empty());
    assert_eq!(
        fs::read(sources[0].host_path().join("SKILL.md")).unwrap(),
        SKILL_CONTENT
    );

    fs::write(sources[0].host_path().join("SKILL.md"), b"tampered").unwrap();
    assert!(
        manager
            .local_capability_sources(CapabilityKind::Skill)
            .is_err()
    );
}

#[test]
fn packaged_stdio_mcp_uses_a_path_free_executable_resource() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(StdioRegistry))).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo-mcp@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let acquired = manager
        .acquire_capability(AcquireCapabilityRequest {
            capability: installed.capabilities[0].reference.clone(),
        })
        .unwrap();
    let executable = match &acquired.spec {
        crate::ActivationSpec::Mcp(spec) => match &spec.transport {
            crate::McpTransportSpec::Stdio { executable, args } => {
                assert_eq!(args, &["--stdio"]);
                executable.clone()
            }
            _ => panic!("expected stdio MCP activation"),
        },
        _ => panic!("expected MCP activation"),
    };
    let content = manager
        .open_resource(OpenResourceRequest {
            lease_id: acquired.lease.id.clone(),
            resource: executable,
        })
        .unwrap();
    assert_eq!(
        STANDARD.decode(content.data_base64).unwrap(),
        MCP_EXECUTABLE
    );
    manager
        .release_capability(ReleaseCapabilityRequest {
            lease_id: acquired.lease.id,
        })
        .unwrap();
}

struct FakeRegistry;

impl PluginProvider for FakeRegistry {
    fn search(
        &self,
        _: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        Ok(SearchPackagesResult {
            packages: vec![PackageSummary {
                id: "demo".into(),
                version: "2.0.0".into(),
                package_type: "skill".into(),
                display_name: "Demo".into(),
                description: "Demo skill".into(),
            }],
        })
    }

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
        let payload = FakePayload::new(request.version.as_deref().unwrap_or("2.0.0"));
        Ok(PackageDetails {
            package: payload.package.clone(),
            package_type: "skill".into(),
            display_name: "Demo".into(),
            description: "Demo skill".into(),
            license: "MIT".into(),
            source: crate::PackageSource::ThirdParty,
            upstream: None,
            capabilities: vec![AvailableCapability {
                kind: CapabilityKind::Skill,
                id: "demo".into(),
                contract_version: "1".into(),
                permissions: Vec::new(),
                authentication_provider: None,
            }],
        })
    }

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new(FakePayload::new(
            request.version.as_deref().unwrap_or("2.0.0"),
        )))
    }
}

struct StdioRegistry;

impl PluginProvider for StdioRegistry {
    fn search(
        &self,
        _: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        Ok(SearchPackagesResult {
            packages: Vec::new(),
        })
    }

    fn get(&self, _: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
        Err(MarketplaceClientError::storage())
    }

    fn download(
        &self,
        _: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new(StdioPayload::new()))
    }
}

struct StdioPayload {
    package: PackageRef,
    capabilities: Vec<PluginPackageCapability>,
}

impl StdioPayload {
    fn new() -> Self {
        Self {
            package: PackageRef {
                id: "demo-mcp".into(),
                version: "1.0.0".into(),
                digest: package_digest_files(&[
                    ("mcp/package.json", MCP_DEFINITION),
                    ("server/demo", MCP_EXECUTABLE),
                ]),
            },
            capabilities: vec![PluginPackageCapability {
                kind: CapabilityKind::Mcp,
                id: "demo".into(),
                path: "mcp/package.json".into(),
                runtime: None,
                language_ids: Vec::new(),
            }],
        }
    }
}

impl PluginPackagePayload for StdioPayload {
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
        (MCP_DEFINITION.len() + MCP_EXECUTABLE.len()) as u64
    }

    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError> {
        fs::create_dir(destination.join("mcp")).map_err(|_| MarketplaceClientError::storage())?;
        fs::create_dir(destination.join("server"))
            .map_err(|_| MarketplaceClientError::storage())?;
        fs::write(destination.join("mcp/package.json"), MCP_DEFINITION)
            .map_err(|_| MarketplaceClientError::storage())?;
        fs::write(destination.join("server/demo"), MCP_EXECUTABLE)
            .map_err(|_| MarketplaceClientError::storage())
    }
}

struct FakePayload {
    package: PackageRef,
    capabilities: Vec<PluginPackageCapability>,
    file_count: u64,
    size_bytes: u64,
    copy_barrier: Option<Arc<std::sync::Barrier>>,
}

impl FakePayload {
    fn new(version: &str) -> Self {
        Self {
            file_count: 1,
            size_bytes: SKILL_CONTENT.len() as u64,
            copy_barrier: None,
            package: PackageRef {
                id: "demo".into(),
                version: version.into(),
                digest: package_digest("skill/SKILL.md", SKILL_CONTENT),
            },
            capabilities: vec![PluginPackageCapability {
                kind: CapabilityKind::Skill,
                id: "demo".into(),
                path: "skill".into(),
                runtime: None,
                language_ids: Vec::new(),
            }],
        }
    }
}

impl PluginPackagePayload for FakePayload {
    fn package(&self) -> &PackageRef {
        &self.package
    }

    fn capabilities(&self) -> &[PluginPackageCapability] {
        &self.capabilities
    }

    fn expected_file_count(&self) -> u64 {
        self.file_count
    }

    fn expected_size_bytes(&self) -> u64 {
        self.size_bytes
    }

    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError> {
        let skill = destination.join("skill");
        fs::create_dir(&skill).map_err(|_| MarketplaceClientError::storage())?;
        fs::write(skill.join("SKILL.md"), SKILL_CONTENT)
            .map_err(|_| MarketplaceClientError::storage())?;
        if let Some(barrier) = &self.copy_barrier {
            barrier.wait();
        }
        Ok(())
    }
}

fn package_digest(path: &str, contents: &[u8]) -> String {
    package_digest_files(&[(path, contents)])
}

fn package_digest_files(files: &[(&str, &[u8])]) -> String {
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

fn providers(provider: Arc<dyn PluginProvider>) -> crate::PluginProviders {
    crate::PluginProviders::new([(ash_plugin::MarketplaceName::new("test").unwrap(), provider)])
        .unwrap()
}

struct VersionProvider(&'static str);

impl PluginProvider for VersionProvider {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        let mut result = FakeRegistry.search(request)?;
        for package in &mut result.packages {
            package.version = self.0.into();
        }
        Ok(result)
    }

    fn get(
        &self,
        mut request: GetPackageRequest,
    ) -> Result<PackageDetails, MarketplaceClientError> {
        request.version = Some(self.0.into());
        FakeRegistry.get(request)
    }

    fn download(
        &self,
        _: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new(FakePayload::new(self.0)))
    }
}

fn named_providers() -> crate::PluginProviders {
    crate::PluginProviders::new([
        (
            ash_plugin::MarketplaceName::new("team").unwrap(),
            Arc::new(VersionProvider("1.0.0")) as Arc<dyn PluginProvider>,
        ),
        (
            ash_plugin::MarketplaceName::new("third-party").unwrap(),
            Arc::new(VersionProvider("2.0.0")) as Arc<dyn PluginProvider>,
        ),
    ])
    .unwrap()
}

#[test]
fn same_name_from_two_providers_retains_its_source_through_install_restart_and_update() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), named_providers()).unwrap();
    let found = manager.search(SearchPackagesRequest::default()).unwrap();
    assert_eq!(
        found
            .packages
            .iter()
            .map(|package| (package.id.as_str(), package.version.as_str()))
            .collect::<Vec<_>>(),
        vec![("demo@team", "1.0.0"), ("demo@third-party", "2.0.0")]
    );
    let team = manager
        .install(InstallPackageRequest {
            package_id: "demo@team".into(),
            version: None,
        })
        .unwrap();
    let third_party = manager
        .install(InstallPackageRequest {
            package_id: "demo@third-party".into(),
            version: None,
        })
        .unwrap();
    assert_ne!(team.installation_id, third_party.installation_id);
    assert_ne!(
        team.capabilities[0].reference,
        third_party.capabilities[0].reference
    );
    let details = manager
        .get(GetPackageRequest {
            package_id: "demo@third-party".into(),
            version: None,
        })
        .unwrap();
    assert_eq!(details.package, third_party.package);
    drop(manager);
    let reopened = PluginsManager::open(root.path(), named_providers()).unwrap();
    let updated = reopened
        .update(UpdatePackageRequest {
            installation_id: team.installation_id.clone(),
            version: None,
        })
        .unwrap();
    assert_eq!(updated, team);
    assert_eq!(
        reopened
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .len(),
        2
    );
    reopened
        .uninstall(UninstallPackageRequest {
            installation_id: team.installation_id,
            mode: UninstallMode::IfUnused,
        })
        .unwrap();
    assert_eq!(
        reopened.list_installed(ListInstalledRequest {}).unwrap(),
        vec![third_party]
    );
}

#[test]
fn provider_routing_rejects_unknown_sources_and_mismatched_identity_or_version_before_installing() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), named_providers()).unwrap();
    for (id, version) in [
        ("demo", None),
        ("demo@unknown", None),
        ("wrong@team", None),
        ("demo@team", Some("2.0.0")),
    ] {
        assert!(
            manager
                .install(InstallPackageRequest {
                    package_id: id.into(),
                    version: version.map(str::to_owned)
                })
                .is_err()
        );
        assert!(
            manager
                .get(GetPackageRequest {
                    package_id: id.into(),
                    version: version.map(str::to_owned)
                })
                .is_err()
        );
    }
    assert!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_dir(root.path().join("artifacts")).unwrap().count(),
        0
    );
}

#[test]
fn duplicate_provider_names_are_rejected_and_search_limit_applies_across_sources() {
    let name = ash_plugin::MarketplaceName::new("team").unwrap();
    assert!(
        crate::PluginProviders::new([
            (
                name.clone(),
                Arc::new(FakeRegistry) as Arc<dyn PluginProvider>
            ),
            (name, Arc::new(FakeRegistry) as Arc<dyn PluginProvider>),
        ])
        .is_err()
    );
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), named_providers()).unwrap();
    let found = manager
        .search(SearchPackagesRequest {
            limit: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.packages.len(), 1);
    assert_eq!(found.packages[0].id, "demo@team");
}

#[test]
fn legacy_installations_are_bound_once_without_guessing_between_multiple_sources() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    drop(manager);
    let state_path = root.path().join("manager-state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let mut record = state["installations"]
        .as_object_mut()
        .unwrap()
        .remove(&installed.installation_id)
        .unwrap();
    record["package"]["id"] = "example/demo".into();
    let legacy_id = crate::marketplace_store::opaque_id(
        "ins",
        &[
            "example/demo",
            &installed.package.version,
            &installed.package.digest,
        ],
    );
    record["installationId"] = legacy_id.clone().into();
    state["installations"]
        .as_object_mut()
        .unwrap()
        .insert(legacy_id, record);
    fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let before = fs::read(&state_path).unwrap();
    assert!(PluginsManager::open(root.path(), named_providers()).is_err());
    assert_eq!(fs::read(&state_path).unwrap(), before);
    let migrated = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let packages = migrated.list_installed(ListInstalledRequest {}).unwrap();
    assert_eq!(packages[0].package.id, "example.demo@test");
    assert_eq!(
        migrated
            .local_capability_sources(CapabilityKind::Skill)
            .unwrap()
            .len(),
        1
    );
    drop(migrated);
    let reopened = PluginsManager::open(root.path(), named_providers()).unwrap();
    assert_eq!(
        reopened.list_installed(ListInstalledRequest {}).unwrap(),
        packages
    );
}

#[test]
fn installed_packages_remain_manageable_after_their_provider_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    drop(manager);
    let manager =
        PluginsManager::open(root.path(), crate::PluginProviders::new([]).unwrap()).unwrap();
    assert_eq!(
        manager.list_installed(ListInstalledRequest {}).unwrap(),
        vec![installed.clone()]
    );
    assert!(
        manager
            .update(UpdatePackageRequest {
                installation_id: installed.installation_id.clone(),
                version: None
            })
            .is_err()
    );
    manager
        .uninstall(UninstallPackageRequest {
            installation_id: installed.installation_id,
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

struct PayloadProvider(Arc<dyn Fn() -> FakePayload + Send + Sync>);

impl PluginProvider for PayloadProvider {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        FakeRegistry.search(request)
    }
    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
        FakeRegistry.get(request)
    }
    fn download(
        &self,
        _: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new((self.0)()))
    }
}

#[test]
fn cached_artifacts_still_require_each_providers_signed_file_statistics() {
    let root = tempfile::tempdir().unwrap();
    let mut sources = vec![(
        ash_plugin::MarketplaceName::new("original").unwrap(),
        Arc::new(FakeRegistry) as Arc<dyn PluginProvider>,
    )];
    for (name, files, bytes) in [
        ("wrong-count", 2, SKILL_CONTENT.len() as u64),
        ("wrong-size", 1, 0),
    ] {
        sources.push((
            ash_plugin::MarketplaceName::new(name).unwrap(),
            Arc::new(PayloadProvider(Arc::new(move || {
                let mut payload = FakePayload::new("1.0.0");
                payload.file_count = files;
                payload.size_bytes = bytes;
                payload
            }))),
        ));
    }
    let manager =
        PluginsManager::open(root.path(), crate::PluginProviders::new(sources).unwrap()).unwrap();
    let original = manager
        .install(InstallPackageRequest {
            package_id: "demo@original".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    for id in ["demo@wrong-count", "demo@wrong-size"] {
        let error = manager
            .install(InstallPackageRequest {
                package_id: id.into(),
                version: Some("1.0.0".into()),
            })
            .unwrap_err();
        assert_eq!(
            error.kind(),
            crate::MarketplaceClientErrorKind::Remote(
                crate::MarketplaceErrorCode::PackageUntrusted
            ),
        );
    }
    assert_eq!(
        manager.list_installed(ListInstalledRequest {}).unwrap(),
        vec![original]
    );
}

#[test]
fn concurrent_sources_share_one_artifact_and_keep_independent_installations() {
    let root = tempfile::tempdir().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let provider: Arc<dyn PluginProvider> = Arc::new(PayloadProvider(Arc::new(move || {
        let mut payload = FakePayload::new("1.0.0");
        payload.copy_barrier = Some(Arc::clone(&barrier));
        payload
    })));
    let sources = crate::PluginProviders::new(["first", "second"].map(|name| {
        (
            ash_plugin::MarketplaceName::new(name).unwrap(),
            Arc::clone(&provider),
        )
    }))
    .unwrap();
    let manager = Arc::new(PluginsManager::open(root.path(), sources).unwrap());
    let threads = ["demo@first", "demo@second"].map(|id| {
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            manager
                .install(InstallPackageRequest {
                    package_id: id.into(),
                    version: Some("1.0.0".into()),
                })
                .unwrap()
        })
    });
    let [first, second] = threads.map(|thread| thread.join().unwrap());
    assert_ne!(first.installation_id, second.installation_id);
    assert_eq!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fs::read_dir(root.path().join("artifacts")).unwrap().count(),
        1,
        "failed staging directories must also be removed"
    );
}

#[test]
fn invalid_versions_are_rejected_before_provider_io_and_invalid_search_results_are_rejected() {
    struct NoIo;
    impl PluginProvider for NoIo {
        fn search(
            &self,
            request: SearchPackagesRequest,
        ) -> Result<SearchPackagesResult, MarketplaceClientError> {
            let mut result = FakeRegistry.search(request)?;
            result.packages[0].version = "latest".into();
            Ok(result)
        }
        fn get(&self, _: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
            panic!("invalid request reached provider")
        }
        fn download(
            &self,
            _: DownloadPackageRequest,
        ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
            panic!("invalid request reached provider")
        }
    }
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(NoIo))).unwrap();
    assert!(manager.search(SearchPackagesRequest::default()).is_err());
    assert!(
        manager
            .get(GetPackageRequest {
                package_id: "demo@test".into(),
                version: Some("latest".into())
            })
            .is_err()
    );
    assert!(
        manager
            .install(InstallPackageRequest {
                package_id: "demo@test".into(),
                version: Some("latest".into())
            })
            .is_err()
    );
}

#[test]
fn reopening_rejects_corrupted_installation_references_without_rewriting_them() {
    let root = tempfile::tempdir().unwrap();
    let manager = PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).unwrap();
    let installed = manager
        .install(InstallPackageRequest {
            package_id: "demo@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    drop(manager);
    let path = root.path().join("manager-state.json");
    let original: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("id", "other@test"),
        ("version", "latest"),
        ("digest", "invalid"),
    ] {
        let mut state = original.clone();
        state["installations"][&installed.installation_id]["package"][field] = value.into();
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    let mut state = original;
    let record = state["installations"]
        .as_object_mut()
        .unwrap()
        .remove(&installed.installation_id)
        .unwrap();
    state["installations"]
        .as_object_mut()
        .unwrap()
        .insert("wrong-key".into(), record);
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(PluginsManager::open(root.path(), providers(Arc::new(FakeRegistry))).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
