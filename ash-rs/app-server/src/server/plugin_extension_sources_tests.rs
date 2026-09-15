use super::PluginExtensionSourceProvider;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_extensions::DynamicExtensionSourceProvider;
use ash_plugin::LocalPluginPackage;
use std::fs;

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
