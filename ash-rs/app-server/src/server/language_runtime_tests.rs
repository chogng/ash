use std::fs;
use std::path::Path;
use std::sync::Arc;

use ash_config::LanguageServerConfig;
use ash_config::LanguageServerId;
use ash_config::LanguageServerModeConfig;
use ash_config::LanguageServersConfig;
use ash_lsp_server_provider::CSS_LANGUAGE_SERVER_ID;
use ash_lsp_server_provider::CssLanguageServerProvider;
use ash_lsp_server_provider::LanguageServerMode;
use ash_lsp_server_provider::LspServerProviders;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_lsp_server_provider::NodePackageLanguageServerProvider;
use ash_lsp_server_provider::RUST_ANALYZER_SERVER_ID;
use ash_lsp_server_provider::TYPESCRIPT_LANGUAGE_SERVER_ID;
use tempfile::TempDir;

use super::AppServerLanguageRuntime;
use super::UpdateBroker;
use super::configured_provider_definitions;
use super::preference;

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
fn unconfigured_builtin_language_server_is_disabled() {
    assert_eq!(
        preference(&LanguageServersConfig::default(), RUST_ANALYZER_SERVER_ID).mode(),
        LanguageServerMode::Disabled
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
    assert_eq!(definitions[0].name().as_str(), CSS_LANGUAGE_SERVER_ID);
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
            LanguageServerId::new(CSS_LANGUAGE_SERVER_ID).unwrap(),
            LanguageServerConfig { mode, executable },
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
        let provider = CssLanguageServerProvider::new(
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
