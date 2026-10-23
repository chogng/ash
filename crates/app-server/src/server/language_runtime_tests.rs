use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use ash_config::LanguageServerConfig;
use ash_config::LanguageServerId;
use ash_config::LanguageServerModeConfig;
use ash_config::LanguageServersConfig;
use ash_lsp_server_provider::LanguageServerMode;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;
const RUST_ANALYZER_SERVER_ID: &str = "rust-analyzer";
const TEST_SERVER_ID: &str = "css-language-server";
use ash_lsp_server_provider::TYPESCRIPT_LANGUAGE_SERVER_ID;
use tempfile::TempDir;

use super::AppServerLanguageRuntime;
use super::UpdateBroker;
use super::configure_definition;
use super::configured_provider_definitions;
use super::preference;

#[tokio::test]
async fn connection_guard_can_be_used_by_synchronous_adapters_inside_an_async_host() {
    let shared = std::sync::Mutex::new(AppServerLanguageRuntime::new(Arc::new(
        UpdateBroker::default(),
    )));
    let guard = super::LanguageRuntimeGuard::new(shared.lock().unwrap(), 1);
    assert!(
        shared.try_lock().is_ok(),
        "the profile registry is released before connection-local work"
    );
    drop(guard);
    shared.lock().unwrap().close_connection(1);
}

#[test]
fn installed_server_catalog_respects_configuration_without_starting_a_process() {
    let fixture = ProviderFixture::new();
    let entrypoint = fixture.root.path().join("typescript-server");
    fs::write(
        &entrypoint,
        b"// catalog queries must not execute this file",
    )
    .unwrap();
    let mut providers = LspServerProviders::new();
    providers
        .register_packaged(
            NodePackageLanguageServerProvider::new(
                TYPESCRIPT_LANGUAGE_SERVER_ID,
                [String::from("typescript"), String::from("javascript")],
                &entrypoint,
                ManagedNodeRuntime::from_path(&fixture.node).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let mut runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    runtime.set_server_providers(providers);
    let mut configuration = LanguageServersConfig::default();
    let definitions = runtime
        .definitions(fixture.dir.path(), &configuration)
        .unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(
        definitions[0].language_ids().collect::<Vec<_>>(),
        ["javascript", "typescript"]
    );

    configuration.servers.insert(
        LanguageServerId::new(TYPESCRIPT_LANGUAGE_SERVER_ID).unwrap(),
        LanguageServerConfig {
            mode: LanguageServerModeConfig::Enabled,
            executable: Some(fixture.node.clone()),
            ..Default::default()
        },
    );
    let definitions = runtime
        .definitions(fixture.dir.path(), &configuration)
        .unwrap();
    assert_eq!(definitions.len(), 1);
    let (_, command, _) = definitions.into_iter().next().unwrap().into_launch_parts();
    assert!(command.arguments().is_empty());
    configuration.servers.values_mut().next().unwrap().mode = LanguageServerModeConfig::Disabled;
    assert!(
        runtime
            .definitions(fixture.dir.path(), &configuration)
            .unwrap()
            .is_empty()
    );
    assert!(runtime.manager().is_none());
}

#[test]
fn unconfigured_servers_have_no_core_rust_fallback() {
    assert_eq!(
        preference(&LanguageServersConfig::default(), RUST_ANALYZER_SERVER_ID).mode(),
        LanguageServerMode::Disabled
    );
    let runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    assert_eq!(
        runtime
            .acquisitions(&LanguageServersConfig::default())
            .count(),
        0
    );
}

#[test]
fn extension_advertisement_is_lazy_and_respects_language_and_extension_disablement() {
    use ash_external_ext::packages::ExtensionPackages;
    use ash_external_ext::packages::ExtensionPackagesReload;
    use ash_external_ext::packages::ExtensionRoot;
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("rust");
    fs::create_dir(&package).unwrap();
    fs::write(
        package.join("package.json"),
        include_str!("../../../../extensions/rust/package.json"),
    )
    .unwrap();
    let mut catalog = ExtensionPackages::new(vec![ExtensionRoot::built_in(root.path())]);
    let snapshot = catalog.list(ExtensionPackagesReload::Cached);
    let mut runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    runtime.set_home(root.path());
    runtime.reconcile_extensions(&snapshot, None).unwrap();
    let mut configuration = LanguageServersConfig::default();
    assert_eq!(runtime.acquisitions(&configuration).count(), 1);
    assert!(
        runtime
            .definitions(root.path(), &configuration)
            .unwrap()
            .is_empty()
    );
    assert!(!root.path().join("capabilities").exists());
    assert!(!runtime.allows_workspace_diagnostics(root.path(), "rust", &configuration));
    fs::write(root.path().join("Cargo.toml"), "").unwrap();
    assert!(runtime.allows_workspace_diagnostics(root.path(), "rust", &configuration));
    configuration.servers.insert(
        LanguageServerId::new(RUST_ANALYZER_SERVER_ID).unwrap(),
        LanguageServerConfig {
            mode: LanguageServerModeConfig::Disabled,
            executable: None,
            ..Default::default()
        },
    );
    assert_eq!(runtime.acquisitions(&configuration).count(), 0);
    let policy =
        ash_core_plugins::EditorExtensionPolicy::open(root.path().join("policy.json")).unwrap();
    configuration.servers.clear();
    policy
        .set_built_in_enablement(
            "ash.rust",
            ash_core_plugins::EditorExtensionPolicyAction::Disable,
            policy.generation(),
        )
        .unwrap();
    runtime
        .reconcile_extensions(&snapshot, Some(&policy))
        .unwrap();
    assert_eq!(runtime.acquisitions(&configuration).count(), 0);
    policy
        .set_built_in_enablement(
            "ash.rust",
            ash_core_plugins::EditorExtensionPolicyAction::Enable,
            policy.generation(),
        )
        .unwrap();
    runtime
        .reconcile_extensions(&snapshot, Some(&policy))
        .unwrap();
    assert_eq!(runtime.acquisitions(&configuration).count(), 1);
    configuration.servers.insert(
        LanguageServerId::new(RUST_ANALYZER_SERVER_ID).unwrap(),
        LanguageServerConfig {
            mode: LanguageServerModeConfig::Enabled,
            executable: None,
            ..Default::default()
        },
    );
    // Removing the extension never resurrects the old hard-coded provider, even with an override.
    fs::remove_dir_all(package).unwrap();
    runtime
        .reconcile_extensions(&catalog.list(ExtensionPackagesReload::Refresh), None)
        .unwrap();
    configuration.servers.values_mut().next().unwrap().mode = LanguageServerModeConfig::Enabled;
    configuration
        .servers
        .values_mut()
        .next()
        .unwrap()
        .executable = Some(root.path().join("rust-analyzer"));
    assert_eq!(runtime.acquisitions(&configuration).count(), 0);
    assert!(
        runtime
            .definitions(root.path(), &configuration)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn manually_injected_provider_requires_explicit_user_enablement() {
    let fixture = ProviderFixture::new();
    let providers = fixture.providers();
    assert!(
        configured_provider_definitions(
            &providers,
            &LanguageServersConfig::default(),
            fixture.dir.path(),
        )
        .unwrap()
        .is_empty()
    );

    let configuration = configuration(LanguageServerModeConfig::Enabled, None);
    let definitions =
        configured_provider_definitions(&providers, &configuration, fixture.dir.path()).unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name().as_str(), TEST_SERVER_ID);
}

#[test]
fn configured_provider_definitions_preserve_explicit_executable_override_semantics() {
    let fixture = ProviderFixture::new();
    let executable = fixture.root.path().join("explicit-css-server");
    write_executable(&executable);
    let definitions = configured_provider_definitions(
        &fixture.providers(),
        &configuration(LanguageServerModeConfig::Enabled, Some(executable.clone())),
        fixture.dir.path(),
    )
    .unwrap();
    let (_, command, _) = definitions.into_iter().next().unwrap().into_launch_parts();
    assert_eq!(
        command.program(),
        fs::canonicalize(executable).unwrap().as_os_str()
    );
    assert!(command.arguments().is_empty());
}

fn configuration(
    mode: LanguageServerModeConfig,
    executable: Option<std::path::PathBuf>,
) -> LanguageServersConfig {
    LanguageServersConfig {
        servers: [(
            LanguageServerId::new(TEST_SERVER_ID).unwrap(),
            LanguageServerConfig {
                mode,
                executable,
                ..Default::default()
            },
        )]
        .into_iter()
        .collect(),
    }
}

struct ProviderFixture {
    root: TempDir,
    dir: TempDir,
    node: std::path::PathBuf,
}

impl ProviderFixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let dir = TempDir::new().unwrap();
        let node = root.path().join("node");
        write_executable(&node);
        Self { root, dir, node }
    }

    fn providers(&self) -> LspServerProviders {
        let entrypoint = self.root.path().join("server/css-language-server");
        fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        fs::write(&entrypoint, b"// server").unwrap();
        let provider = NodePackageLanguageServerProvider::new(
            TEST_SERVER_ID,
            ["css", "less", "scss"].map(str::to_owned),
            entrypoint,
            ManagedNodeRuntime::from_path(&self.node).unwrap(),
        )
        .unwrap();
        let mut registry = LspServerProviders::new();
        registry.register(provider).unwrap();
        registry
    }
}

fn write_executable(path: &Path) {
    fs::write(path, b"runtime").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn configured_server_uses_the_complete_launch_contract_without_starting_during_discovery() {
    let fixture = ProviderFixture::new();
    let mut configuration = LanguageServersConfig::default();
    let config = LanguageServerConfig {
        executable: Some(fixture.node.clone()),
        language_ids: vec!["demo".into()],
        args: vec!["--stdio".into(), "argument with spaces".into()],
        environment: std::collections::BTreeMap::from([("LSP_TEST".into(), "yes".into())]),
        initialization_options: Some(serde_json::json!({"feature":true})),
        settings: std::collections::BTreeMap::from([(
            "demo".into(),
            serde_json::json!({"enabled":true}),
        )]),
        ..Default::default()
    };
    configuration
        .servers
        .insert(LanguageServerId::new("custom-lsp").unwrap(), config.clone());
    let runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    let definition = runtime
        .definitions(fixture.dir.path(), &configuration)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(definition.settings(), &config.settings);
    let (route, command, options) = definition.into_launch_parts();
    assert_eq!(route.language_ids().collect::<Vec<_>>(), ["demo"]);
    assert_eq!(
        command.arguments(),
        [
            std::ffi::OsString::from("--stdio"),
            "argument with spaces".into()
        ]
    );
    assert_eq!(
        command.environment()[std::ffi::OsStr::new("LSP_TEST")],
        "yes"
    );
    assert_eq!(options, config.initialization_options);
    assert!(runtime.manager().is_none());
}

#[test]
fn invalid_provider_and_custom_overrides_do_not_poison_other_definitions() {
    let fixture = ProviderFixture::new();
    let mut configuration = configuration(
        LanguageServerModeConfig::Enabled,
        Some(fixture.root.path().join("missing-css")),
    );
    for (id, executable) in [
        ("broken-custom", fixture.root.path().join("missing-custom")),
        ("working-custom", fixture.node.clone()),
    ] {
        configuration.servers.insert(
            LanguageServerId::new(id).unwrap(),
            LanguageServerConfig {
                executable: Some(executable),
                language_ids: vec!["demo".into()],
                ..Default::default()
            },
        );
    }
    let mut runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    runtime.set_server_providers(fixture.providers());
    let definitions = runtime
        .definitions(fixture.dir.path(), &configuration)
        .unwrap();
    assert_eq!(
        definitions
            .iter()
            .map(|definition| definition.name().as_str())
            .collect::<Vec<_>>(),
        ["working-custom"]
    );
    assert!(runtime.manager().is_none());
}

#[cfg(unix)]
#[test]
fn acquisition_uses_configured_environment_and_failure_does_not_block_other_servers() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("rust-analyzer");
    fs::write(
        &executable,
        "#!/bin/sh\ntest \"$RUSTUP_TOOLCHAIN\" = configured\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../../extensions/rust/package.json")).unwrap();
    let acquisition = ash_lsp_server_provider::LanguageServerAcquisition::from_contribution(
        manifest["ashLanguageServers"].clone(),
    )
    .unwrap()
    .remove(0);
    let mut runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    let mut configuration = LanguageServersConfig::default();
    configuration.servers.insert(
        LanguageServerId::new("rust-analyzer").unwrap(),
        LanguageServerConfig {
            executable: Some(executable.clone()),
            environment: std::collections::BTreeMap::from([(
                "RUSTUP_TOOLCHAIN".into(),
                "configured".into(),
            )]),
            ..Default::default()
        },
    );
    let server = runtime
        .resolve_server(&acquisition, root.path(), &configuration)
        .unwrap();
    let (_, command, _) = server.definition().clone().into_launch_parts();
    assert_eq!(
        command.environment()[std::ffi::OsStr::new("RUSTUP_TOOLCHAIN")],
        "configured"
    );

    runtime
        .sources
        .lock()
        .unwrap()
        .acquisitions
        .insert(acquisition.id.clone(), acquisition);
    runtime.reconcile_configuration(&configuration);
    // Changing an authoritative override retires that acquisition while other languages remain usable.
    runtime
        .acquired
        .lock()
        .unwrap()
        .insert("rust-analyzer".into(), server);
    fs::remove_file(executable).unwrap();
    configuration
        .servers
        .get_mut(&LanguageServerId::new("rust-analyzer").unwrap())
        .unwrap()
        .executable = Some(root.path().join("missing-rust-analyzer"));
    configuration.servers.insert(
        LanguageServerId::new("working").unwrap(),
        LanguageServerConfig {
            executable: Some("/bin/sh".into()),
            language_ids: vec!["demo".into()],
            args: vec!["-c".into(), "exit 0".into()],
            ..Default::default()
        },
    );
    runtime.reconcile_configuration(&configuration);
    runtime
        .restart(root.path(), 1, &configuration, "demo")
        .unwrap();
    assert_eq!(
        runtime
            .dir_state
            .language_servers
            .get("demo")
            .map(String::as_str),
        Some("working")
    );
    assert!(runtime.acquired.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn connection_sessions_keep_independent_revisions_saved_text_and_process_lifetimes() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("server.sh");
    fs::write(&script, super::regression_tests::SERVER).unwrap();
    let logs = root.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let path = root.path().join("same.demo");
    fs::write(&path, "disk").unwrap();
    let configuration = LanguageServersConfig {
        servers: std::collections::BTreeMap::from([(
            LanguageServerId::new("fixture").unwrap(),
            LanguageServerConfig {
                executable: Some("/bin/sh".into()),
                language_ids: vec!["demo".into()],
                args: vec![
                    script.to_string_lossy().into_owned(),
                    "--custom-flag".into(),
                ],
                environment: std::collections::BTreeMap::from([
                    ("LSP_LOG".into(), logs.to_string_lossy().into_owned()),
                    ("LSP_OPTION".into(), "applied".into()),
                ]),
                initialization_options: Some(serde_json::json!({"custom":true})),
                ..Default::default()
            },
        )]),
    };
    let store =
        Arc::new(ash_config::ConfigStore::open(root.path().join("config.sqlite3")).unwrap());
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(root.path()).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([
            ash_file_access::Permission::UseLanguageServices,
            ash_file_access::Permission::ExecuteCommands,
            ash_file_access::Permission::ReadFiles,
        ]),
    );
    let mut server = crate::tests::server()
        .with_config_store(store)
        .with_file_system(Arc::new(ash_file_system::LocalFileSystem::new(
            grant.clone(),
        )));
    server.env_runtime_mut().selected_grant = Some(grant);
    let mut first = server.connection();
    let mut second = server.connection();
    crate::tests::initialize(&server, &mut first);
    crate::tests::initialize(&server, &mut second);
    let sequence = std::sync::atomic::AtomicU64::new(2);
    let request =
        |connection: &mut crate::ConnectionState, method: &str, params: serde_json::Value| {
            let id = sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let response = crate::tests::call(
                &server,
                connection,
                serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            );
            assert!(response.get("result").is_some(), "{response}");
            response["result"].clone()
        };
    let config = configuration.servers.values().next().unwrap();
    request(
        &mut first,
        "languageServer/configure",
        serde_json::json!({
            "commandId":"configure-fixture","expectedRevision":0,"serverId":"fixture",
            "config":{"mode":"enabled","executable":config.executable,"languageIds":config.language_ids,"args":config.args,"environment":config.environment,"initializationOptions":config.initialization_options,"settings":{"demo":{"strict":true}}}
        }),
    );
    let missing = root.path().join("missing-custom");
    request(
        &mut first,
        "languageServer/configure",
        serde_json::json!({
            "commandId":"configure-broken","expectedRevision":1,"serverId":"broken",
            "config":{"mode":"enabled","executable":missing,"languageIds":["broken"]}
        }),
    );
    let catalog = request(&mut first, "language/servers", serde_json::json!({}));
    assert!(
        catalog["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| server["id"] == "fixture")
    );
    let read = request(&mut first, "config/read", serde_json::json!({}));
    assert_eq!(
        read["languageServers"]["broken"]["executable"],
        serde_json::json!(missing)
    );
    let hover = |connection: &mut crate::ConnectionState, revision, text: &str| {
        let operation = sequence.load(std::sync::atomic::Ordering::Relaxed);
        let result = request(
            connection,
            "language/hover",
            serde_json::json!({"operationId":format!("hover-{operation}"),"request":{
                "document":{"path":"same.demo","languageId":"demo","revision":revision,"text":text},
                "position":{"lineIndex":0,"columnIndex":0}
            }}),
        );
        result["contents"].as_str().unwrap().to_owned()
    };
    assert!(hover(&mut first, 9, "alpha").starts_with("alpha||"));
    request(
        &mut first,
        "languageServer/configure",
        serde_json::json!({
            "commandId":"correct-broken","expectedRevision":2,"serverId":"broken", "config":{"mode":"disabled"}
        }),
    );
    request(
        &mut first,
        "languageServer/remove",
        serde_json::json!({
            "commandId":"reset-broken","expectedRevision":3,"serverId":"broken"
        }),
    );
    let second_result = hover(&mut second, 1, "beta");
    assert!(second_result.starts_with("beta||"), "{second_result}");
    assert!(hover(&mut first, 10, "dirty").starts_with("dirty||"));
    request(
        &mut first,
        "language/save",
        serde_json::json!({"path":"same.demo","text":"alpha"}),
    );
    assert!(hover(&mut first, 10, "dirty").starts_with("dirty|alpha|"));
    let notifications = server.drain_notifications(&mut first);
    let capabilities: serde_json::Value = notifications
        .iter()
        .map(|raw| serde_json::from_str::<serde_json::Value>(raw).unwrap())
        .find(|value| value["method"] == "language/serverCapabilities")
        .unwrap();
    assert_eq!(
        capabilities["params"]["completionTriggerCharacters"],
        serde_json::json!(["="])
    );
    assert_eq!(
        capabilities["params"]["features"],
        serde_json::json!(["hover", "completion", "signatureHelp"])
    );
    request(
        &mut first,
        "language/close",
        serde_json::json!({"path":"same.demo"}),
    );
    assert_eq!(hover(&mut second, 1, "beta"), second_result);
    server.close_connection(first);
    assert_eq!(hover(&mut second, 1, "beta"), second_result);
    request(
        &mut second,
        "languageServer/configure",
        serde_json::json!({"commandId":"disable-fixture","expectedRevision":4,"serverId":"fixture","config":{"mode":"disabled"}}),
    );
    assert!(
        !server.language.lock().unwrap().server_running("fixture"),
        "configuration must retire the affected route before returning"
    );
    server.close_connection(second);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if fs::read_dir(&logs).unwrap().all(|entry| {
            fs::read_to_string(entry.unwrap().path())
                .unwrap()
                .lines()
                .last()
                .is_some_and(|line| line.contains("\"method\":\"exit\""))
        }) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    for entry in fs::read_dir(logs).unwrap() {
        let messages: Vec<serde_json::Value> = fs::read_to_string(entry.unwrap().path())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            messages[0],
            serde_json::json!({"environment":"applied","argument":"--custom-flag"})
        );
        let initialize = messages
            .iter()
            .find(|message| message["method"] == "initialize")
            .unwrap();
        assert_eq!(
            initialize["params"]["initializationOptions"],
            serde_json::json!({"custom":true})
        );
        assert_eq!(
            initialize["params"]["workspaceFolders"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(messages.last().unwrap()["method"], "exit");
    }
}

#[test]
fn rust_workspace_settings_merge_profile_options_before_initialization_and_stay_directory_local() {
    let fixture = ProviderFixture::new();
    let configuration = configuration(LanguageServerModeConfig::Enabled, None);
    let definition = ash_lsp_server_provider::resolve_executable(
        "rust-analyzer",
        &["rust".to_owned()],
        &fixture.node,
        fixture.dir.path(),
    )
    .unwrap();
    let mut config = configuration;
    config.servers.insert(LanguageServerId::new("rust-analyzer").unwrap(), LanguageServerConfig {
        initialization_options: Some(serde_json::json!({"cargo":{"features":["profile-feature"]}})),
        settings: BTreeMap::from([("rust-analyzer".into(), serde_json::json!({"cargo":{"allTargets":true,"extraEnv":{"NATIVE_LIB":"/prepared/lib"}}}))]),
        ..Default::default()
    });
    let mut runtime = AppServerLanguageRuntime::new(Arc::new(UpdateBroker::default()));
    let settings = BTreeMap::from([(
        "rust-analyzer".into(),
        serde_json::json!({"cargo":{"allTargets":false,"buildScripts":{"enable":false}},"check":{"workspace":false}}),
    )]);
    runtime.configure_workspace_settings(fixture.dir.path(), settings.clone());
    let other = fixture.root.path().join("another");
    runtime.configure_workspace_settings(&other, BTreeMap::new());
    assert_eq!(runtime.dir_state.settings, settings);
    assert!(runtime.env_runtimes[&other].dir_state.settings.is_empty());
    let resolved = configure_definition(definition, &config, &runtime.dir_state.settings).unwrap();
    assert_eq!(
        resolved.settings()["rust-analyzer"]["cargo"]["allTargets"],
        false
    );
    let (_, _, options) = resolved.into_launch_parts();
    assert_eq!(
        options.unwrap(),
        serde_json::json!({
            "cargo":{"features":["profile-feature"],"allTargets":false,"extraEnv":{"NATIVE_LIB":"/prepared/lib"},"buildScripts":{"enable":false}},
            "check":{"workspace":false}
        })
    );
    runtime.definitions_dirty = false;
    runtime.configure_workspace_settings(fixture.dir.path(), settings);
    assert!(
        !runtime.definitions_dirty,
        "unchanged discovery must not restart the server"
    );
    runtime.configure_workspace_settings(fixture.dir.path(), BTreeMap::new());
    assert!(
        runtime.definitions_dirty,
        "removing settings retires the prior launch"
    );
    runtime.dir_state.root = None;
    let settings = BTreeMap::from([(
        "rust-analyzer".into(),
        serde_json::json!({"check":{"workspace":false}}),
    )]);
    runtime.configure_workspace_settings(&other, settings.clone());
    assert_eq!(runtime.env_runtimes[&other].dir_state.settings, settings);
    assert!(
        runtime.dir_state.root.is_none(),
        "a retained directory keeps its existing owner"
    );
}
