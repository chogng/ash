use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use ash_core_plugins::AvailableCapability;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::DownloadPackageRequest;
use ash_core_plugins::EditorExtensionPolicy;
use ash_core_plugins::EditorExtensionPolicyAction;
use ash_core_plugins::ExtensionPackageCapability;
use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::ExtensionPackagePayload;
use ash_core_plugins::ExtensionPackageService;
use ash_core_plugins::ExtensionSource;
use ash_core_plugins::ExtensionsClientError;
use ash_core_plugins::GetPackageRequest;
use ash_core_plugins::InstallPackageRequest;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::PackageDetails;
use ash_core_plugins::PackageRef;
use ash_core_plugins::PackageSource;
use ash_core_plugins::SearchPackagesRequest;
use ash_core_plugins::SearchPackagesResult;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_external_ext::packages::ExtensionPackages;
use ash_external_ext::packages::ExtensionPackagesReload;
use sha2::Digest;
use sha2::Sha256;

use super::ExtensionsExtensionSourceProvider;

#[test]
fn installed_product_client_requires_exact_grant_and_preserves_routes_after_revocation() {
    let root = tempfile::tempdir().unwrap();
    let manager = installed_manager(root.path(), SourceAuthority::Product, manifest());
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    let source = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap()
        .remove(0);
    let provider = Arc::new(ExtensionsExtensionSourceProvider::new(
        manager,
        Some(policy.clone()),
    ));
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(provider);

    let declarations = catalog.list(ExtensionPackagesReload::Refresh);
    assert!(
        declarations.diagnostics.is_empty(),
        "{:?}",
        declarations.diagnostics
    );
    assert_eq!(declarations.extensions.len(), 1);
    let extension = &declarations.extensions[0];
    assert_eq!(extension.id, "ash.academy");
    assert_eq!(extension.package_sha256, source.package().digest);
    assert!(extension.renderer_client.is_none());
    let declaration: serde_json::Value = serde_json::from_str(&extension.manifest_json).unwrap();
    assert_eq!(
        declaration["contributes"]["customEditors"][0]["viewType"],
        "academy.test"
    );
    assert_eq!(
        declaration["ashRuntime"]["client"]["entry"],
        "dist/editor.js"
    );

    let mut revision = policy
        .snapshot(source.package(), source.capability())
        .revision;
    revision = policy
        .set(
            source.package(),
            source.capability(),
            EditorExtensionPolicyAction::Grant,
            revision,
        )
        .unwrap()
        .revision;
    let granted = catalog.list(ExtensionPackagesReload::Cached);
    assert!(granted.generation > declarations.generation);
    let client = granted.extensions[0].renderer_client.as_ref().unwrap();
    assert_eq!(client.runtime_id, "ash.academy");
    assert_eq!(client.api_version, 1);
    assert_eq!(client.digest, sha256(b"export {};"));
    assert_eq!(client.style_digest, sha256(b".academy {}"));
    assert_eq!(
        catalog
            .open_resource(granted.generation, "ash.academy", &client.entry)
            .unwrap()
            .bytes,
        b"export {};"
    );

    for action in [
        EditorExtensionPolicyAction::Disable,
        EditorExtensionPolicyAction::Enable,
        EditorExtensionPolicyAction::Revoke,
    ] {
        revision = policy
            .set(source.package(), source.capability(), action, revision)
            .unwrap()
            .revision;
        let snapshot = catalog.list(ExtensionPackagesReload::Cached);
        assert_eq!(
            snapshot.extensions.len(),
            1,
            "document routes survive {action:?}"
        );
        assert_eq!(
            snapshot.extensions[0].manifest_json,
            granted.extensions[0].manifest_json
        );
        assert_eq!(
            snapshot.extensions[0].package_sha256,
            source.package().digest
        );
        assert_eq!(
            snapshot.extensions[0].renderer_client.is_some(),
            action == EditorExtensionPolicyAction::Enable
        );
        assert!(snapshot.generation > granted.generation);
    }
}

#[test]
fn another_artifact_grant_cannot_authorize_an_installed_product_client() {
    let root = tempfile::tempdir().unwrap();
    let manager = installed_manager(root.path(), SourceAuthority::Product, manifest());
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    let source = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap()
        .remove(0);
    let revision = policy
        .snapshot(source.package(), source.capability())
        .revision;
    let mut other_artifact = source.package().clone();
    other_artifact.digest = sha256(b"another package artifact");
    policy
        .set(
            &other_artifact,
            source.capability(),
            EditorExtensionPolicyAction::Grant,
            revision,
        )
        .unwrap();
    let snapshot = ExtensionsExtensionSourceProvider::new(manager, Some(policy))
        .snapshot()
        .unwrap();
    assert_eq!(snapshot.packages.len(), 1);
    assert!(snapshot.packages[0].renderer_client.is_none());
}

#[test]
fn manifest_self_declaration_and_policy_grant_cannot_authorize_a_registry_client() {
    let root = tempfile::tempdir().unwrap();
    let mut declaration = manifest();
    let keybindings = serde_json::json!([{"key":"ctrl+shift+d","command":"editor.action.copyLinesDownAction","when":"editorTextFocus && !editorReadonly"}]);
    declaration["contributes"]["keybindings"] = keybindings.clone();
    declaration["contributes"]["debuggers"] =
        serde_json::json!([{"type":"blocked","program":"bin/adapter"}]);
    declaration["main"] = "extension.js".into();
    declaration["browser"] = "browser.js".into();
    let manager = installed_manager(root.path(), SourceAuthority::Registry, declaration);
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    let source = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap()
        .remove(0);
    let revision = policy
        .snapshot(source.package(), source.capability())
        .revision;
    policy
        .set(
            source.package(),
            source.capability(),
            EditorExtensionPolicyAction::Grant,
            revision,
        )
        .unwrap();
    let snapshot = ExtensionsExtensionSourceProvider::new(manager, Some(policy))
        .snapshot()
        .unwrap();
    assert_eq!(snapshot.packages.len(), 1);
    assert!(snapshot.packages[0].renderer_client.is_none());
    let normalized: serde_json::Value = serde_json::from_str(
        snapshot.packages[0]
            .normalized_manifest_json
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert!(normalized.get("ashRuntime").is_none());
    assert!(normalized["contributes"].get("customEditors").is_none());
    assert_eq!(normalized["contributes"]["keybindings"], keybindings);
    assert!(normalized.get("main").is_none());
    assert!(normalized.get("browser").is_none());
    assert!(normalized["contributes"].get("debuggers").is_none());
}

#[test]
fn trusted_package_cannot_claim_another_manifest_identity() {
    let root = tempfile::tempdir().unwrap();
    let mut declaration = manifest();
    declaration["publisher"] = "another-publisher".into();
    let manager = installed_manager(root.path(), SourceAuthority::Product, declaration);
    let snapshot = ExtensionsExtensionSourceProvider::new(manager, None)
        .snapshot()
        .unwrap();
    assert!(snapshot.packages.is_empty());
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert!(snapshot.diagnostics[0].message.contains("identity"));
}

#[test]
fn corrupt_unrelated_executable_does_not_remove_a_healthy_product_editor_or_its_runtime() {
    let root = tempfile::tempdir().unwrap();
    let manager = installed_manager(root.path(), SourceAuthority::Product, manifest());
    manager
        .install(InstallPackageRequest {
            package_id: "ash.unrelated@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let sources = manager
        .local_capability_sources(CapabilityKind::Executable)
        .unwrap();
    let healthy = sources
        .iter()
        .find(|source| source.package().id == "ash.academy@test")
        .unwrap();
    let broken = sources
        .iter()
        .find(|source| source.package().id == "ash.unrelated@test")
        .unwrap();
    fs::write(broken.host_path(), b"corrupted unrelated executable").unwrap();
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    let revision = policy
        .snapshot(healthy.package(), healthy.capability())
        .revision;
    policy
        .set(
            healthy.package(),
            healthy.capability(),
            EditorExtensionPolicyAction::Grant,
            revision,
        )
        .unwrap();
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        ExtensionsExtensionSourceProvider::new(manager.clone(), Some(policy.clone())),
    ));
    let snapshot = catalog.list(ExtensionPackagesReload::Refresh);
    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "ash.academy");
    assert!(snapshot.extensions[0].renderer_client.is_some());
    let manifest: serde_json::Value =
        serde_json::from_str(&snapshot.extensions[0].manifest_json).unwrap();
    assert_eq!(
        manifest["contributes"]["customEditors"][0]["viewType"],
        "academy.test"
    );
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.subject.as_deref() == Some("ash.unrelated@test"))
    );
    let admission: Arc<dyn crate::ExtensionsEditorExtensionAdmission> = Arc::new(
        crate::extension_packages_editor_extensions::ProfileEditorExtensionAdmission(policy),
    );
    let deployments =
        crate::extension_packages_editor_extensions::deployments(&manager, &admission).unwrap();
    assert_eq!(deployments.len(), 1);
    assert_eq!(deployments[0].id, "ash.academy");
    assert!(deployments[0].authority.authorizes());
    assert_eq!(
        manager
            .list_installed(ListInstalledRequest {})
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn product_editor_without_a_native_for_this_platform_retains_routes_without_execution_admission() {
    let root = tempfile::tempdir().unwrap();
    let mut package_files = files(manifest());
    let sidecar_path = "editor/ash/editor-extensions.json";
    let mut sidecar: serde_json::Value =
        serde_json::from_slice(&package_files[sidecar_path]).unwrap();
    sidecar["editorExtensions"][0]["targetPlatform"] = if cfg!(target_os = "windows") {
        "linux-x64"
    } else {
        "win32-x64"
    }
    .into();
    package_files.insert(sidecar_path.into(), serde_json::to_vec(&sidecar).unwrap());
    let manager =
        installed_manager_with_files(root.path(), SourceAuthority::Product, package_files);
    let policy = Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
    for kind in [CapabilityKind::Executable, CapabilityKind::EditorExtension] {
        let source = manager.local_capability_sources(kind).unwrap().remove(0);
        let revision = policy
            .snapshot(source.package(), source.capability())
            .revision;
        policy
            .set(
                source.package(),
                source.capability(),
                EditorExtensionPolicyAction::Grant,
                revision,
            )
            .unwrap();
    }
    let mut catalog = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(
        ExtensionsExtensionSourceProvider::new(manager.clone(), Some(policy.clone())),
    ));
    let snapshot = catalog.list(ExtensionPackagesReload::Refresh);
    assert!(
        snapshot.diagnostics.is_empty(),
        "{:?}",
        snapshot.diagnostics
    );
    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "ash.academy");
    assert!(snapshot.extensions[0].renderer_client.is_none());
    let declaration: serde_json::Value =
        serde_json::from_str(&snapshot.extensions[0].manifest_json).unwrap();
    assert_eq!(
        declaration["contributes"]["customEditors"][0]["viewType"],
        "academy.test"
    );
    assert_eq!(declaration["ashRuntime"]["kind"], "rust");
    let admission: Arc<dyn crate::ExtensionsEditorExtensionAdmission> = Arc::new(
        crate::extension_packages_editor_extensions::ProfileEditorExtensionAdmission(policy),
    );
    assert!(
        crate::extension_packages_editor_extensions::deployments(&manager, &admission)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn malformed_client_admission_keeps_only_declarative_document_routes() {
    for invalid in [
        "../escape.js",
        "/absolute.js",
        "dist\\editor.js",
        "dist/%2e%2e/editor.js",
        "dist//editor.js",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut declaration = manifest();
        declaration["ashRuntime"]["client"]["entry"] = invalid.into();
        let manager = installed_manager(root.path(), SourceAuthority::Product, declaration);
        let policy =
            Arc::new(EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap());
        let source = manager
            .local_capability_sources(CapabilityKind::Executable)
            .unwrap()
            .remove(0);
        let revision = policy
            .snapshot(source.package(), source.capability())
            .revision;
        policy
            .set(
                source.package(),
                source.capability(),
                EditorExtensionPolicyAction::Grant,
                revision,
            )
            .unwrap();
        let snapshot = ExtensionsExtensionSourceProvider::new(manager, Some(policy))
            .snapshot()
            .unwrap();
        assert_eq!(snapshot.packages.len(), 1);
        assert!(snapshot.packages[0].renderer_client.is_none());
        assert_eq!(snapshot.diagnostics.len(), 1);
    }
    for invalid in ["sha256:abc", "sha512:abc", "not-a-digest"] {
        let mut declaration = manifest();
        declaration["ashRuntime"]["client"]["sourceDigest"] = invalid.into();
        assert!(super::renderer_client("ash.academy", &declaration.to_string()).is_err());
    }
}

fn installed_manager(
    root: &Path,
    authority: SourceAuthority,
    manifest: serde_json::Value,
) -> Arc<ExtensionPackageManager> {
    installed_manager_with_files(root, authority, files(manifest))
}

fn installed_manager_with_files(
    root: &Path,
    authority: SourceAuthority,
    files: BTreeMap<String, Vec<u8>>,
) -> Arc<ExtensionPackageManager> {
    let provider: Arc<dyn ExtensionSource> = Arc::new(Registry { authority, files });
    let sources = ash_core_plugins::ExtensionSources::new([(
        ash_utils_plugins::ExtensionSourceId::new("test").unwrap(),
        provider,
    )])
    .unwrap();
    let manager = Arc::new(ExtensionPackageManager::open(root.join("packages"), sources).unwrap());
    manager
        .install(InstallPackageRequest {
            package_id: "ash.academy@test".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    manager
}

fn manifest() -> serde_json::Value {
    serde_json::json!({
        "publisher": "ash", "name": "academy", "version": "1.0.0",
        "contributes": { "customEditors": [{ "viewType": "academy.test", "selector": [{ "filenamePattern": "*.ash-doc" }] }] },
        "ashRuntime": { "kind": "rust", "entrypoint": "academy-runtime", "client": {
            "apiVersion": 1, "entry": "dist/editor.js", "digest": sha256(b"export {};"),
            "style": "dist/editor.css", "styleDigest": sha256(b".academy {}"), "sourceDigest": sha256(b"sources")
        } }
    })
}

fn files(manifest: serde_json::Value) -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        ("editor/package.json".into(), serde_json::to_vec(&manifest).unwrap()),
        ("editor/ash/editor-extensions.json".into(), serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "editorExtensions": [{ "id": "academy", "executable": "academy-runtime", "runtimeApiVersion": 1,
                "activationEvents": [{ "type": "onCommand", "id": "academy.run" }], "capabilities": ["command"] }]
        })).unwrap()),
        ("bin/academy".into(), b"#!/bin/sh\nexit 0\n".to_vec()),
        ("editor/dist/editor.js".into(), b"export {};".to_vec()),
        ("editor/dist/editor.css".into(), b".academy {}".to_vec()),
    ])
}

enum SourceAuthority {
    Product,
    Registry,
}

struct Registry {
    authority: SourceAuthority,
    files: BTreeMap<String, Vec<u8>>,
}

impl Registry {
    fn package_files(&self, id: &str) -> BTreeMap<String, Vec<u8>> {
        let mut files = self.files.clone();
        // Distinct identities have distinct artifacts, so damaging one cannot alter the other's bytes.
        files.insert("package-identity.txt".into(), id.as_bytes().to_vec());
        files
    }
}

impl ExtensionSource for Registry {
    fn product_runtime_authority(&self, _: &str) -> Option<String> {
        match self.authority {
            SourceAuthority::Product => Some("pinned-root:ash".into()),
            SourceAuthority::Registry => None,
        }
    }
    fn search(
        &self,
        _: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, ExtensionsClientError> {
        Ok(SearchPackagesResult {
            packages: Vec::new(),
            unavailable_sources: Vec::new(),
        })
    }
    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, ExtensionsClientError> {
        let payload = Payload(self.package_files(&request.package_id));
        let mut package = payload.package_ref();
        package.id = request.package_id;
        Ok(PackageDetails {
            ui_targets: None,
            package,
            package_type: "editor".into(),
            display_name: "Academy".into(),
            description: "Test editor".into(),
            license: "MIT".into(),
            source: PackageSource::Official,
            upstream: None,
            capabilities: capabilities()
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
        let files = self.package_files(&request.package_id);
        let mut package = Payload(files.clone()).package_ref();
        package.id = request.package_id;
        Ok(Box::new(PackagePayload {
            package,
            files,
            capabilities: capabilities(),
        }))
    }
}

fn capabilities() -> Vec<ExtensionPackageCapability> {
    vec![
        ExtensionPackageCapability {
            kind: CapabilityKind::Executable,
            id: "academy-runtime".into(),
            path: "bin/academy".into(),
            runtime: Some("direct".into()),
            language_ids: Vec::new(),
        },
        ExtensionPackageCapability {
            kind: CapabilityKind::EditorExtension,
            id: "editor-resources".into(),
            path: "editor".into(),
            runtime: None,
            language_ids: Vec::new(),
        },
    ]
}

struct Payload(BTreeMap<String, Vec<u8>>);

impl Payload {
    fn package_ref(&self) -> PackageRef {
        let mut hash = Sha256::new();
        hash.update(b"marketplace-package-v1\0");
        for (path, contents) in &self.0 {
            hash.update((path.len() as u64).to_be_bytes());
            hash.update(path.as_bytes());
            hash.update((contents.len() as u64).to_be_bytes());
            hash.update(contents);
        }
        PackageRef {
            id: "ash.academy".into(),
            version: "1.0.0".into(),
            digest: format!("sha256:{:x}", hash.finalize()),
        }
    }
}

struct PackagePayload {
    package: PackageRef,
    files: BTreeMap<String, Vec<u8>>,
    capabilities: Vec<ExtensionPackageCapability>,
}

impl ExtensionPackagePayload for PackagePayload {
    fn package(&self) -> &PackageRef {
        &self.package
    }
    fn capabilities(&self) -> &[ExtensionPackageCapability] {
        &self.capabilities
    }
    fn expected_file_count(&self) -> u64 {
        self.files.len() as u64
    }
    fn expected_size_bytes(&self) -> u64 {
        self.files.values().map(|bytes| bytes.len() as u64).sum()
    }
    fn copy_to(&self, destination: &Path) -> Result<(), ExtensionsClientError> {
        for (relative, bytes) in &self.files {
            let path = destination.join(relative);
            fs::create_dir_all(path.parent().unwrap())
                .map_err(|_| ExtensionsClientError::storage())?;
            fs::write(&path, bytes).map_err(|_| ExtensionsClientError::storage())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                destination.join("bin/academy"),
                fs::Permissions::from_mode(0o755),
            )
            .map_err(|_| ExtensionsClientError::storage())?;
        }
        Ok(())
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
