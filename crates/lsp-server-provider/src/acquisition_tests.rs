use super::*;
use crate::LspServerResolverError;

struct Candidates(Vec<PathBuf>);
impl LanguageServerExecutableCandidates for Candidates {
    fn candidates(&self, name: &str) -> Result<Vec<PathBuf>, LspServerResolverError> {
        assert_eq!(name, "rust-analyzer");
        Ok(self.0.clone())
    }
}

#[cfg(unix)]
fn script(root: &Path, name: &str, contents: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{contents}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn failed_proxy_falls_through_to_usable_path_without_downloading() {
    let root = tempfile::tempdir().unwrap();
    let broken = script(root.path(), "broken", "exit 1");
    let working = script(
        root.path(),
        "working",
        "test \"$1\" = --version && test \"$RUSTUP_AUTO_INSTALL\" = 0",
    );
    let rust = rust_support()
        .resolve(
            root.path(),
            None,
            &Candidates(vec![broken, working.clone()]),
            &BTreeMap::new(),
            || panic!("local server must avoid installation"),
            || panic!("native servers do not require Node"),
        )
        .unwrap();
    let (_, command, _) = rust.definition().clone().into_launch_parts();
    assert_eq!(
        command.program(),
        working.canonicalize().unwrap().as_os_str()
    );
    assert_eq!(command.current_dir(), Some(root.path()));
}

#[test]
fn missing_candidates_reach_managed_installation_but_explicit_override_never_does() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing");
    let candidates = Candidates(vec![missing.clone()]);
    let fallback = rust_support().resolve(
        root.path(),
        None,
        &candidates,
        &BTreeMap::new(),
        || Err(ManagedLanguageServerError::Installation("offline".into())),
        || panic!("native servers do not require Node"),
    );
    assert!(
        matches!(fallback, Err(ManagedLanguageServerError::Installation(message)) if message == "offline")
    );
    let explicit = rust_support().resolve(
        root.path(),
        Some(&missing),
        &candidates,
        &BTreeMap::new(),
        || panic!("explicit override must never download"),
        || panic!("native servers do not require Node"),
    );
    assert!(
        matches!(explicit, Err(ManagedLanguageServerError::Unavailable(path)) if path == missing)
    );
}

#[cfg(unix)]
#[test]
fn preserves_proxy_invocation_name_and_workspace_during_probe_and_launch() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("workspace");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("rust-toolchain.toml"), "fixture").unwrap();
    let proxy = script(
        root.path(),
        "rustup",
        "test \"${0##*/}\" = rust-analyzer && test -f rust-toolchain.toml",
    );
    let invoked = root.path().join("rust-analyzer");
    std::os::unix::fs::symlink(&proxy, &invoked).unwrap();
    let rust = rust_support()
        .resolve(
            &dir,
            None,
            &Candidates(vec![invoked.clone()]),
            &BTreeMap::new(),
            || panic!("proxy is usable"),
            || panic!("native servers do not require Node"),
        )
        .unwrap();
    let (_, command, _) = rust.definition().clone().into_launch_parts();
    assert_eq!(command.program(), proxy.canonicalize().unwrap().as_os_str());
    assert_eq!(command.argv0(), Some(invoked.as_os_str()));
}

#[test]
fn pinned_releases_cover_supported_desktop_targets() {
    let releases: Vec<ExecutableRelease> = serde_json::from_value(
        rust_manifest()["ashLanguageServers"]["servers"][0]["releases"].clone(),
    )
    .unwrap();
    assert_eq!(releases.len(), 6);
    for release in releases {
        assert!(release.url.starts_with(&format!(
            "https://github.com/rust-lang/rust-analyzer/releases/download/{}/rust-analyzer-{}",
            release.version, release.target
        )));
        assert_eq!(release.sha256.len(), 64);
        assert!(release.size > 0);
    }
}

#[cfg(unix)]
#[test]
fn probes_and_launches_with_configured_toolchain_and_environment_precedence() {
    let root = tempfile::tempdir().unwrap();
    let executable = script(
        root.path(),
        "rust-analyzer",
        "test \"$RUSTUP_TOOLCHAIN\" = configured && test \"$RUSTUP_AUTO_INSTALL\" = 1",
    );
    let environment = BTreeMap::from([
        ("RUSTUP_TOOLCHAIN".into(), "configured".into()),
        ("RUSTUP_AUTO_INSTALL".into(), "1".into()),
    ]);
    for explicit in [None, Some(executable.as_path())] {
        let server = rust_support()
            .resolve(
                root.path(),
                explicit,
                &Candidates(vec![executable.clone()]),
                &environment,
                || panic!("configured local toolchain must avoid installation"),
                || panic!("native servers do not require Node"),
            )
            .unwrap();
        let (_, command, _) = server.definition().clone().into_launch_parts();
        assert_eq!(
            command.environment()[std::ffi::OsStr::new("RUSTUP_TOOLCHAIN")],
            "configured"
        );
        assert_eq!(
            command.environment()[std::ffi::OsStr::new("RUSTUP_AUTO_INSTALL")],
            "1"
        );
    }
}

fn rust_manifest() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../extensions/rust/package.json")).unwrap()
}
fn rust_support() -> LanguageServerAcquisition {
    LanguageServerAcquisition::from_contribution(rust_manifest()["ashLanguageServers"].clone())
        .unwrap()
        .remove(0)
}

#[test]
fn legacy_workspace_markers_are_optional_and_do_not_change_launch_policy() {
    let current = rust_support();
    let mut legacy = rust_manifest()["ashLanguageServers"].clone();
    assert!(legacy["servers"][0].get("workspaceFiles").is_none());
    legacy["servers"][0]["workspaceFiles"] = serde_json::json!(["Cargo.toml"]);
    let legacy = LanguageServerAcquisition::from_contribution(legacy)
        .unwrap()
        .remove(0);
    assert!(current.same_policy(&legacy));
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("workspaceFiles")
            .is_none()
    );
}

#[test]
fn contribution_rejects_incompatible_or_unsafe_recipes() {
    for (pointer, value) in [
        ("/version", serde_json::json!(2)),
        (
            "/servers/0/workspaceFiles",
            serde_json::json!(["../Cargo.toml"]),
        ),
        (
            "/servers/0/executable",
            serde_json::json!("../rust-analyzer"),
        ),
        (
            "/servers/0/environment",
            serde_json::json!({"BAD=KEY":"value"}),
        ),
    ] {
        let mut contribution = rust_manifest()["ashLanguageServers"].clone();
        contribution["servers"][0]["workspaceFiles"] = serde_json::json!(["Cargo.toml"]);
        *contribution.pointer_mut(pointer).unwrap() = value;
        assert!(LanguageServerAcquisition::from_contribution(contribution).is_err());
    }
}

fn node_support(entrypoint: &str) -> Result<LanguageServerAcquisition, ManagedLanguageServerError> {
    LanguageServerAcquisition::from_contribution(serde_json::json!({
        "version": 2,
        "servers": [{ "id": "css-language-server", "languages": ["css", "scss", "less"], "runtime": "node", "entrypoint": entrypoint, "initializationOptions": { "provideFormatter": true }, "settings": { "css": {} } }]
    })).map(|mut servers| servers.remove(0))
}

#[test]
fn bundled_server_uses_the_managed_runtime_without_probing_or_downloading() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("server.cjs"), "// bundled server").unwrap();
    let mut server = node_support("server.cjs").unwrap();
    server.bind_package(root.path()).unwrap();
    let runtime = ManagedNodeRuntime::from_path(std::env::current_exe().unwrap()).unwrap();
    let resolved = server
        .resolve(
            root.path(),
            None,
            &Candidates(Vec::new()),
            &BTreeMap::from([("LANG".into(), "zh_CN.UTF-8".into())]),
            || panic!("bundled servers must not download"),
            || Ok(runtime.clone()),
        )
        .unwrap();
    assert_eq!(
        resolved.definition().language_ids().collect::<Vec<_>>(),
        ["css", "less", "scss"]
    );
    assert_eq!(
        resolved.definition().settings().get("css"),
        Some(&serde_json::json!({}))
    );
    let (_, command, options) = resolved.definition().clone().into_launch_parts();
    assert_eq!(
        options,
        Some(serde_json::json!({ "provideFormatter": true }))
    );
    assert_eq!(command.program(), runtime.executable());
    assert_eq!(
        command.arguments(),
        [
            root.path()
                .join("server.cjs")
                .canonicalize()
                .unwrap()
                .into_os_string(),
            "--stdio".into()
        ]
    );
    assert_eq!(
        command.environment()[std::ffi::OsStr::new("LANG")],
        "zh_CN.UTF-8"
    );
}

#[test]
fn bundled_server_binding_rejects_missing_or_escaping_resources_and_tracks_package_replacement() {
    for path in [
        "../server.cjs",
        "/server.cjs",
        "C:server.cjs",
        "server\\main.cjs",
        "./server.cjs",
    ] {
        assert!(node_support(path).is_err(), "{path}");
    }
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut server = node_support("server.cjs").unwrap();
    assert!(server.bind_package(first.path()).is_err());
    for root in [first.path(), second.path()] {
        std::fs::write(root.join("server.cjs"), "// bundled server").unwrap();
    }
    server.bind_package(first.path()).unwrap();
    let mut replacement = server.clone();
    replacement.bind_package(second.path()).unwrap();
    assert!(!server.same_policy(&replacement));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            second.path().join("server.cjs"),
            first.path().join("escape.cjs"),
        )
        .unwrap();
        assert!(
            node_support("escape.cjs")
                .unwrap()
                .bind_package(first.path())
                .is_err()
        );
    }
    let mut invalid = serde_json::json!({ "version": 2, "servers": [{ "id": "css-language-server", "languages": ["css"], "runtime": "node", "entrypoint": "server.cjs", "unexpected": true }] });
    assert!(LanguageServerAcquisition::from_contribution(invalid.clone()).is_err());
    invalid["servers"][0]
        .as_object_mut()
        .unwrap()
        .remove("unexpected");
    invalid["version"] = 1.into();
    assert!(LanguageServerAcquisition::from_contribution(invalid).is_err());
}
