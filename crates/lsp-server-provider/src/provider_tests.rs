use std::fs;
use std::path::Path;

use ash_lsp::LanguageServerEnvironmentPolicy;
use tempfile::TempDir;

use crate::CSS_LANGUAGE_SERVER_ID;
use crate::CssLanguageServerProvider;
use crate::DirectPackageLanguageServerProvider;
use crate::LanguageServerProviderError;
use crate::LspServerLaunch;
use crate::LspServerProviders;
use crate::ManagedNodeRuntime;
use crate::ManagedNodeRuntimeSource;

#[test]
fn css_provider_uses_managed_node_and_a_clean_environment() {
    let fixture = ProviderFixture::new();
    let provider = fixture.provider();
    assert_eq!(
        provider.node_runtime().source(),
        ManagedNodeRuntimeSource::PackagedNode
    );
    let mut registry = LspServerProviders::new();
    registry.register(provider).unwrap();

    let definition = registry
        .definition(
            CSS_LANGUAGE_SERVER_ID,
            fixture.dir.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        definition.language_ids().collect::<Vec<_>>(),
        vec!["css", "less", "scss"]
    );
    let (_, command, _) = definition.into_launch_parts();
    let node = fs::canonicalize(&fixture.node).unwrap();
    let entrypoint = fs::canonicalize(&fixture.entrypoint).unwrap();
    assert_eq!(command.program(), node.as_os_str());
    assert_eq!(
        command.arguments(),
        [entrypoint.as_os_str(), std::ffi::OsStr::new("--stdio")]
    );
    assert_eq!(
        command.environment_policy(),
        LanguageServerEnvironmentPolicy::Clear
    );
    assert!(
        !command
            .environment()
            .contains_key(std::ffi::OsStr::new("NODE_OPTIONS"))
    );
    assert!(
        !command
            .environment()
            .contains_key(std::ffi::OsStr::new("NODE_PATH"))
    );
    assert!(
        !command
            .environment()
            .contains_key(std::ffi::OsStr::new("ELECTRON_RUN_AS_NODE"))
    );
    assert_eq!(command.current_dir(), Some(fixture.dir.path()));
}

#[test]
fn css_provider_uses_electron_only_for_the_language_server_child() {
    let fixture = ProviderFixture::new();
    let provider = fixture
        .provider_with_runtime(ManagedNodeRuntime::from_electron_path(&fixture.node).unwrap());
    assert_eq!(
        provider.node_runtime().source(),
        ManagedNodeRuntimeSource::ElectronRunAsNode
    );
    let mut registry = LspServerProviders::new();
    registry.register(provider).unwrap();

    let definition = registry
        .definition(
            CSS_LANGUAGE_SERVER_ID,
            fixture.dir.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    let (_, command, _) = definition.into_launch_parts();
    assert_eq!(
        command
            .environment()
            .get(std::ffi::OsStr::new("ELECTRON_RUN_AS_NODE"))
            .map(std::ffi::OsString::as_os_str),
        Some(std::ffi::OsStr::new("1"))
    );
    assert_eq!(
        command.environment_policy(),
        LanguageServerEnvironmentPolicy::Clear
    );
}

#[test]
fn css_provider_accepts_an_authoritative_executable_override() {
    let fixture = ProviderFixture::new();
    let provider = fixture.provider();
    let executable = fixture.root.path().join("explicit-css-server");
    write_executable(&executable);
    let mut registry = LspServerProviders::new();
    registry.register(provider).unwrap();

    let definition = registry
        .definition(
            CSS_LANGUAGE_SERVER_ID,
            fixture.dir.path(),
            LspServerLaunch::ExplicitExecutable(&executable),
        )
        .unwrap()
        .unwrap();
    let (_, command, _) = definition.into_launch_parts();
    assert_eq!(
        command.program(),
        fs::canonicalize(executable).unwrap().as_os_str()
    );
    assert!(command.arguments().is_empty());
    assert_eq!(
        command.environment_policy(),
        LanguageServerEnvironmentPolicy::Inherit
    );
}

#[test]
fn registry_rejects_duplicate_provider_identity() {
    let fixture = ProviderFixture::new();
    let mut registry = LspServerProviders::new();
    registry.register(fixture.provider()).unwrap();
    let error = registry.register(fixture.provider()).unwrap_err();
    assert!(matches!(
        error,
        LanguageServerProviderError::DuplicateProvider(id) if id == CSS_LANGUAGE_SERVER_ID
    ));
}

#[test]
fn packaged_registry_retains_user_enablement() {
    let fixture = ProviderFixture::new();
    let mut registry = LspServerProviders::new();
    registry.register_packaged(fixture.provider()).unwrap();

    assert!(registry.contains(CSS_LANGUAGE_SERVER_ID));
    assert!(registry.activation_enables(CSS_LANGUAGE_SERVER_ID));
}

#[test]
fn direct_package_provider_launches_the_verified_executable() {
    let fixture = ProviderFixture::new();
    let direct = fixture.root.path().join("demo-language-server");
    write_executable(&direct);
    let provider = DirectPackageLanguageServerProvider::new(
        "demo-language-server",
        ["demo".to_string()],
        &direct,
    )
    .unwrap();
    let mut registry = LspServerProviders::new();
    registry.register_packaged(provider).unwrap();

    let definition = registry
        .definition(
            "demo-language-server",
            fixture.dir.path(),
            LspServerLaunch::Packaged,
        )
        .unwrap()
        .unwrap();
    assert_eq!(definition.language_ids().collect::<Vec<_>>(), vec!["demo"]);
    let (_, command, _) = definition.into_launch_parts();
    assert_eq!(
        command.program(),
        direct.canonicalize().unwrap().as_os_str()
    );
    assert!(command.arguments().is_empty());
    assert_eq!(command.current_dir(), Some(fixture.dir.path()));
}

struct ProviderFixture {
    root: TempDir,
    dir: TempDir,
    node: std::path::PathBuf,
    entrypoint: std::path::PathBuf,
}

impl ProviderFixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let dir = TempDir::new().unwrap();
        let node = root.path().join("node");
        let entrypoint = root
            .path()
            .join("languages")
            .join(CSS_LANGUAGE_SERVER_ID)
            .join("0.1.0")
            .join("server/css-language-server");
        write_executable(&node);
        fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        fs::write(&entrypoint, b"// server").unwrap();
        Self {
            root,
            dir,
            node,
            entrypoint,
        }
    }

    fn provider(&self) -> CssLanguageServerProvider {
        self.provider_with_runtime(ManagedNodeRuntime::from_path(&self.node).unwrap())
    }

    fn provider_with_runtime(&self, runtime: ManagedNodeRuntime) -> CssLanguageServerProvider {
        CssLanguageServerProvider::new(&self.entrypoint, runtime).unwrap()
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
