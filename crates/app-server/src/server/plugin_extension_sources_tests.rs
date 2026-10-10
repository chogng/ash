use super::PluginExtensionSourceProvider;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_external_ext::packages::DynamicExtensionSourceProvider;
use ash_plugin::LocalPluginPackage;
use std::fs;
use std::sync::Arc;

#[test]
fn standard_package_declarations_share_runtime_enablement_and_revocation() {
    let source = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join(".ash-plugin")).unwrap();
    fs::write(source.path().join(".ash-plugin/plugin.json"), serde_json::json!({
        "schemaVersion": 1, "id": "acme/standard", "version": "1.0.0", "displayName": "Standard",
        "compatibility": {"ash": ">=0.1.0"}, "permissions": [],
        "contributions": {"editorExtensions": [{"id": "tasks", "runtime": "javascript", "api": "vscode",
            "entrypoint": "extension.cjs", "runtimeApiVersion": 1,
            "activationEvents": [{"type": "onTaskType", "taskType": "builder"}], "capabilities": ["taskProvider"]}]}
    }).to_string()).unwrap();
    let manifest = serde_json::json!({
        "name": "standard", "publisher": "acme", "version": "1.0.0", "main": "./extension.cjs",
        "contributes": {"taskDefinitions": [{"type": "builder", "required": [], "properties": {}}],
            "problemMatchers": [{"name": "builder", "owner": "builder", "pattern": {"regexp": "^(.+):(.*)$", "file": 1, "message": 2, "kind": "file"}}]}
    });
    fs::write(source.path().join("package.json"), manifest.to_string()).unwrap();
    fs::write(
        source.path().join("extension.cjs"),
        "exports.activate = () => {};",
    )
    .unwrap();
    let local = LocalPluginPackage::load(source.path()).unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let authority =
        PluginActivationAuthority::in_memory(PluginPackageStore::open(store_root.path()).unwrap())
            .unwrap();
    let installed = authority
        .install_local(PluginAuthorityCommandId::new("install").unwrap(), 0, &local)
        .unwrap()
        .package;
    let provider = Arc::new(PluginExtensionSourceProvider::new(authority.clone()));
    let mut catalog = ash_external_ext::packages::ExtensionPackages::new(vec![])
        .with_dynamic_sources(provider.clone());
    assert!(
        catalog
            .list(ash_external_ext::packages::ExtensionPackagesReload::Cached)
            .extensions
            .is_empty()
    );
    apply(
        &authority,
        1,
        "enable",
        PluginAuthorityCommand::Enable {
            package: installed.clone(),
        },
    );
    assert!(provider.snapshot().unwrap().packages.is_empty());
    apply(
        &authority,
        2,
        "grant",
        PluginAuthorityCommand::Grant {
            package: installed.clone(),
        },
    );
    let sources = provider.snapshot().unwrap();
    assert_eq!(sources.packages.len(), 1);
    assert_eq!(sources.packages[0].subject, "acme/standard:tasks");
    let snapshot = catalog.list(ash_external_ext::packages::ExtensionPackagesReload::Cached);
    assert!(
        snapshot.diagnostics.is_empty(),
        "{:?}",
        snapshot.diagnostics
    );
    assert_eq!(snapshot.extensions.len(), 1);
    assert_eq!(snapshot.extensions[0].id, "acme.standard");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&snapshot.extensions[0].manifest_json).unwrap(),
        manifest
    );
    assert_eq!(
        catalog
            .open_resource(snapshot.generation, "acme.standard", "extension.cjs")
            .unwrap()
            .bytes,
        b"exports.activate = () => {};"
    );
    apply(
        &authority,
        3,
        "revoke",
        PluginAuthorityCommand::RevokeGrant { package: installed },
    );
    let retired = catalog.list(ash_external_ext::packages::ExtensionPackagesReload::Cached);
    assert!(retired.generation > snapshot.generation);
    assert!(retired.extensions.is_empty());
    assert!(
        catalog
            .open_resource(snapshot.generation, "acme.standard", "extension.cjs")
            .is_err()
    );
}

#[test]
fn projects_only_effective_declarative_extension_packages() {
    let source = tempfile::tempdir().unwrap();
    write_plugin(source.path());
    let local = LocalPluginPackage::load(source.path()).unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let store = PluginPackageStore::open(store_root.path()).unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    let installed = authority
        .install_local(PluginAuthorityCommandId::new("install").unwrap(), 0, &local)
        .unwrap()
        .package;
    let provider = PluginExtensionSourceProvider::new(authority.clone());

    let installed_snapshot = provider.snapshot().unwrap();

    assert!(installed_snapshot.packages.is_empty());
    apply(
        &authority,
        1,
        "grant",
        PluginAuthorityCommand::Grant {
            package: installed.clone(),
        },
    );
    apply(
        &authority,
        2,
        "enable",
        PluginAuthorityCommand::Enable { package: installed },
    );

    let active_snapshot = provider.snapshot().unwrap();

    assert_eq!(active_snapshot.generation, 2);
    assert_eq!(active_snapshot.packages.len(), 1);
    assert_eq!(active_snapshot.packages[0].subject, "acme/theme:theme");
    assert!(
        active_snapshot.packages[0]
            .path
            .ends_with("extensions/theme")
    );
}

fn apply(
    authority: &PluginActivationAuthority,
    expected_revision: u64,
    command_id: &str,
    command: PluginAuthorityCommand,
) {
    authority
        .apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new(command_id).unwrap(),
            expected_revision,
            command,
        })
        .unwrap();
}

fn write_plugin(root: &std::path::Path) {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::create_dir_all(root.join("extensions/theme/themes")).unwrap();
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        r#"{
            "schemaVersion": 1,
            "id": "acme/theme",
            "version": "1.0.0",
            "displayName": "Theme",
            "compatibility": {"ash": ">=0.1.0"},
            "contributions": {
                "declarativeExtensions": [{"id":"theme","path":"extensions/theme"}]
            }
        }"#,
    )
    .unwrap();
    fs::write(
        root.join("extensions/theme/package.json"),
        r#"{"name":"theme","publisher":"acme","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(root.join("extensions/theme/themes/theme.json"), "{}").unwrap();
}

#[test]
fn one_failed_authority_does_not_remove_other_external_packages() {
    use super::super::marketplace_extension_sources::CombinedExtensionSourceProvider;
    use ash_external_ext::packages::DynamicExtensionPackageSource;
    use ash_external_ext::packages::DynamicExtensionSourceSnapshot;
    use ash_external_ext::packages::ExtensionDiagnosticCode;
    use ash_external_ext::packages::ExtensionPackages;
    use ash_external_ext::packages::ExtensionPackagesReload;

    struct FailedSource;
    impl DynamicExtensionSourceProvider for FailedSource {
        fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
            Err("source unavailable".into())
        }
    }
    struct HealthySource(std::path::PathBuf);
    impl DynamicExtensionSourceProvider for HealthySource {
        fn snapshot(&self) -> Result<DynamicExtensionSourceSnapshot, String> {
            Ok(DynamicExtensionSourceSnapshot {
                generation: 1,
                packages: vec![DynamicExtensionPackageSource::plugin("healthy", &self.0)],
                diagnostics: Vec::new(),
            })
        }
    }
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("package.json"),
        r#"{"name":"healthy","publisher":"test","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(root.path().join("resource.txt"), "healthy resource").unwrap();
    let combined = CombinedExtensionSourceProvider::new(vec![
        Arc::new(FailedSource),
        Arc::new(HealthySource(root.path().to_path_buf())),
    ]);
    let mut packages = ExtensionPackages::new(Vec::new()).with_dynamic_sources(Arc::new(combined));
    let snapshot = packages.list(ExtensionPackagesReload::Refresh);
    assert_eq!(snapshot.extensions[0].id, "test.healthy");
    assert_eq!(snapshot.diagnostics.len(), 1);
    assert_eq!(
        snapshot.diagnostics[0].code,
        ExtensionDiagnosticCode::SourceUnavailable
    );
    assert_eq!(
        packages
            .open_resource(snapshot.generation, "test.healthy", "resource.txt")
            .unwrap()
            .bytes,
        b"healthy resource"
    );
    assert_eq!(packages.list(ExtensionPackagesReload::Cached), snapshot);
}
