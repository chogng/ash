use super::WorkspaceReadAccess;
use super::plugin_deployments;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginAuthorityCommand;
use ash_core_plugins::PluginAuthorityCommandId;
use ash_core_plugins::PluginAuthorityCommandRequest;
use ash_core_plugins::PluginPackageStore;
use ash_plugin::LocalPluginPackage;

#[test]
fn effective_javascript_package_launches_product_host_with_exact_identity_and_read_ceiling() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".ash-plugin")).unwrap();
    std::fs::create_dir_all(root.path().join("example")).unwrap();
    std::fs::write(
        root.path().join(".ash-plugin/plugin.json"),
        include_bytes!("../../../../../app-ts/extension-sdk/example/.ash-plugin/plugin.json"),
    )
    .unwrap();
    std::fs::write(
        root.path().join("example/extension.js"),
        "export function activate() {}",
    )
    .unwrap();
    let package = LocalPluginPackage::load(root.path()).unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let store = PluginPackageStore::open(store_root.path()).unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    let installed = authority
        .install_local(
            PluginAuthorityCommandId::new("install").unwrap(),
            0,
            &package,
        )
        .unwrap()
        .package;
    assert!(
        plugin_deployments(&authority)
            .unwrap()
            .deployments
            .is_empty()
    );
    for (revision, id, command) in [
        (
            1,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ),
        (
            2,
            "enable",
            PluginAuthorityCommand::Enable { package: installed },
        ),
    ] {
        authority
            .apply(PluginAuthorityCommandRequest {
                command_id: PluginAuthorityCommandId::new(id).unwrap(),
                expected_revision: revision,
                command,
            })
            .unwrap();
    }
    let snapshot = plugin_deployments(&authority).unwrap();
    assert_eq!(snapshot.deployments.len(), 1);
    let deployment = &snapshot.deployments[0];
    assert_eq!(deployment.id, "ash/sdk-example:inspect");
    assert!(deployment.command.executable().ends_with(format!(
        "ash-js-extension-host{}",
        std::env::consts::EXE_SUFFIX
    )));
    let arguments: Vec<_> = deployment
        .command
        .arguments()
        .iter()
        .map(|argument| argument.to_str().unwrap())
        .collect();
    assert_eq!(
        arguments,
        [
            "--extension-id",
            "ash/sdk-example:inspect",
            "--package",
            deployment.command.working_directory().to_str().unwrap(),
            "--entry",
            "example/extension.js"
        ]
    );
    assert!(deployment.workspace_read == WorkspaceReadAccess::Read);
    assert!(deployment.authority.authorizes());
}
