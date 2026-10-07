use super::*;
use crate::ShellCommandRequest;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn discovery_freezes_the_first_valid_supplied_candidate() {
    let directory = TestDirectory::new();
    let missing = directory.path().join("missing-rg");
    let executable = directory.executable("rg");

    let discovered = RipgrepExecutable::discover_candidates([missing, executable.clone()]).unwrap();

    assert_eq!(discovered.path(), executable.canonicalize().unwrap());
}

#[test]
fn invalid_explicit_override_does_not_fall_back() {
    let directory = TestDirectory::new();
    let missing = directory.path().join("missing-rg");

    assert!(matches!(
        RipgrepExecutable::from_override("ASH_RG_PATH", missing),
        Err(RipgrepDiscoveryError::InvalidOverride {
            variable: "ASH_RG_PATH",
            ..
        })
    ));
}

#[test]
fn materialization_forces_no_config_and_rejects_process_spawning_flags() {
    let directory = TestDirectory::new();
    let executable = RipgrepExecutable::from_path(directory.executable("rg")).unwrap();
    let request = ShellCommandRequest::new("rg", ["needle", "-g", "*.rs"], ".").unwrap();

    let materialized = executable.materialize(request).unwrap();

    assert_eq!(materialized.program(), executable.path().to_string_lossy());
    assert_eq!(
        materialized.arguments(),
        ["--no-config", "needle", "-g", "*.rs"]
    );
    let unsafe_request =
        ShellCommandRequest::new("rg", ["--pre", "decoder", "needle"], ".").unwrap();
    assert!(matches!(
        executable.materialize(unsafe_request),
        Err(RipgrepRequestError::UnsafeArgument(argument)) if argument == "--pre"
    ));
    for argument in [
        "--search-zip",
        "--follow",
        "--file",
        "--ignore-file=rules",
        "--hostname-bin",
        "--hostname-bin=/bin/hostname",
        "-f/etc/hosts",
        "-LH",
        "-nz",
    ] {
        let request = ShellCommandRequest::new("rg", [argument, "needle"], ".").unwrap();
        assert!(matches!(
            executable.materialize(request),
            Err(RipgrepRequestError::UnsafeArgument(rejected)) if rejected == argument
        ));
    }
}

#[test]
fn compact_safe_options_do_not_treat_their_values_as_option_clusters() {
    let directory = TestDirectory::new();
    let executable = RipgrepExecutable::from_path(directory.executable("rg")).unwrap();

    for argument in ["-g*.foo", "-e-L", "-C2", "-tjson"] {
        let request = ShellCommandRequest::new("rg", [argument, "."], ".").unwrap();
        assert!(
            executable.materialize(request).is_ok(),
            "{argument} should remain available"
        );
    }
}

#[test]
fn option_delimiter_keeps_dash_prefixed_positional_paths_available() {
    let directory = TestDirectory::new();
    let executable = RipgrepExecutable::from_path(directory.executable("rg")).unwrap();
    let request = ShellCommandRequest::new("rg", ["--files", "--", "-L"], ".").unwrap();

    let materialized = executable.materialize(request).unwrap();

    assert_eq!(
        materialized.arguments(),
        ["--no-config", "--files", "--", "-L"]
    );
}

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-ripgrep-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn executable(&self, name: &str) -> PathBuf {
        let path = self.path.join(name);
        fs::write(&path, b"test executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).unwrap();
        }
        path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
