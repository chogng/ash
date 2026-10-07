use std::fs;
use std::path::{Path, PathBuf};

use super::*;

struct FixedCandidates(Vec<PathBuf>);

impl LanguageServerExecutableCandidates for FixedCandidates {
    fn candidates(&self, executable_name: &str) -> Result<Vec<PathBuf>, LspServerResolverError> {
        Ok(self
            .0
            .iter()
            .filter(|path| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == executable_name)
            })
            .cloned()
            .collect())
    }
}

#[test]
fn json_and_shell_builtins_resolve_with_canonical_routes_and_launch_arguments() {
    let directory = tempfile::tempdir().expect("directory");
    let executables = [
        RUST_ANALYZER_SERVER_ID,
        JSON_LANGUAGE_SERVER_ID,
        BASH_LANGUAGE_SERVER_ID,
    ]
    .map(|name| {
        let path = directory.path().join(platform_executable_name(name));
        fs::write(&path, b"test server").expect("executable");
        make_executable(&path);
        path
    });

    let resolution = LspServerResolver::default()
        .resolve(
            &FixedCandidates(executables.into()),
            LanguageServerExecutionPolicy::Allowed,
            directory.path(),
        )
        .expect("resolution");

    assert_eq!(resolution.definitions().len(), 3);
    let routes = resolution
        .definitions()
        .iter()
        .map(|definition| {
            (
                definition.name().as_str(),
                definition.language_ids().collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        routes,
        vec![
            (RUST_ANALYZER_SERVER_ID, vec!["rust"]),
            (JSON_LANGUAGE_SERVER_ID, vec!["json", "jsonc"]),
            (BASH_LANGUAGE_SERVER_ID, vec!["shellscript"]),
        ]
    );
}

#[test]
fn enabled_rust_analyzer_resolves_from_the_frozen_host_path() {
    let directory = tempfile::tempdir().expect("directory");
    let executable = directory.path().join(executable_name());
    fs::write(&executable, b"test server").expect("executable");
    make_executable(&executable);
    let candidates = FixedCandidates(vec![executable.clone()]);

    let resolution = LspServerResolver::default()
        .resolve(
            &candidates,
            LanguageServerExecutionPolicy::Allowed,
            directory.path(),
        )
        .expect("resolution");

    assert_eq!(resolution.definitions().len(), 1);
    assert!(matches!(
        resolution.entries()[0].state(),
        LspServerAvailability::Resolved { executable: resolved }
            if resolved == &fs::canonicalize(executable).unwrap()
    ));
}

#[cfg(unix)]
#[test]
fn rustup_proxy_keeps_the_rust_analyzer_launch_name_after_validation() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("directory");
    let rustup = directory.path().join("rustup");
    fs::write(&rustup, b"test rustup proxy").expect("rustup executable");
    make_executable(&rustup);
    let rust_analyzer = directory.path().join("rust-analyzer");
    symlink(&rustup, &rust_analyzer).expect("rust-analyzer proxy");

    let resolution = LspServerResolver::default()
        .resolve(
            &FixedCandidates(vec![rust_analyzer.clone()]),
            LanguageServerExecutionPolicy::Allowed,
            directory.path(),
        )
        .expect("resolution");
    let (_, command, _) = resolution.definitions()[0].clone().into_launch_parts();

    assert_eq!(
        command.program(),
        fs::canonicalize(&rustup).unwrap().as_os_str()
    );
    assert_eq!(command.argv0(), Some(rust_analyzer.as_os_str()));
    assert!(matches!(
        resolution.entries()[0].state(),
        LspServerAvailability::Resolved { executable }
            if executable == &fs::canonicalize(&rustup).unwrap()
    ));
}

#[test]
fn disabled_resolver_does_not_resolve_available_servers() {
    let directory = tempfile::tempdir().expect("directory");
    let executable = directory.path().join(executable_name());
    fs::write(&executable, b"test server").expect("executable");
    make_executable(&executable);

    let resolution = LspServerResolver::disabled()
        .resolve(
            &FixedCandidates(vec![executable]),
            LanguageServerExecutionPolicy::Allowed,
            directory.path(),
        )
        .expect("resolution");

    assert!(resolution.definitions().is_empty());
    assert!(
        resolution
            .entries()
            .iter()
            .all(|entry| entry.state() == &LspServerAvailability::Disabled)
    );
}

#[test]
fn execution_policy_blocks_resolution_before_inspecting_candidates() {
    let candidates = FixedCandidates(vec![PathBuf::from("/does/not/exist")]);
    let resolution = LspServerResolver::default()
        .resolve(
            &candidates,
            LanguageServerExecutionPolicy::Disallowed,
            Path::new("/dir"),
        )
        .expect("resolution");

    assert!(resolution.definitions().is_empty());
    assert_eq!(
        resolution.entries()[0].state(),
        &LspServerAvailability::ExecutionDisallowed
    );
}

#[test]
fn invalid_explicit_executable_is_authoritative_and_does_not_fall_back() {
    let directory = tempfile::tempdir().expect("directory");
    let discovered = directory.path().join(executable_name());
    fs::write(&discovered, b"test server").expect("executable");
    make_executable(&discovered);
    let candidates = FixedCandidates(vec![discovered]);
    let resolver = LspServerResolver::new(
        LanguageServerPreference::enabled()
            .with_explicit_executable(directory.path().join("missing")),
    );

    let resolution = resolver
        .resolve(
            &candidates,
            LanguageServerExecutionPolicy::Allowed,
            directory.path(),
        )
        .expect("resolution");

    assert!(resolution.definitions().is_empty());
    assert_eq!(
        resolution.entries()[0].state(),
        &LspServerAvailability::ExecutableUnavailable
    );
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "rust-analyzer.exe"
    } else {
        "rust-analyzer"
    }
}

fn platform_executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).expect("permissions");
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}
