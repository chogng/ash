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
            || panic!("local server must avoid installation"),
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
    let fallback = rust_support().resolve(root.path(), None, &candidates, || {
        Err(ManagedLanguageServerError::Installation("offline".into()))
    });
    assert!(
        matches!(fallback, Err(ManagedLanguageServerError::Installation(message)) if message == "offline")
    );
    let explicit = rust_support().resolve(root.path(), Some(&missing), &candidates, || {
        panic!("explicit override must never download")
    });
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
        .resolve(&dir, None, &Candidates(vec![invoked.clone()]), || {
            panic!("proxy is usable")
        })
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

fn rust_manifest() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../extensions/rust/package.json")).unwrap()
}
fn rust_support() -> LanguageServerAcquisition {
    LanguageServerAcquisition::from_contribution(rust_manifest()["ashLanguageServers"].clone())
        .unwrap()
        .remove(0)
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
        *contribution.pointer_mut(pointer).unwrap() = value;
        assert!(LanguageServerAcquisition::from_contribution(contribution).is_err());
    }
}
