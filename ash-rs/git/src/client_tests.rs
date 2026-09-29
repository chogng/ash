use std::time::Duration;

use pretty_assertions::assert_eq;

use super::FsmonitorOverride;
use super::GitClient;
use super::GitExecutionLimits;
use super::GitInvocation;
use super::REPOSITORY_SELECTOR_ENVIRONMENT;
use crate::GitError;
use crate::test_support::TestRepository;

#[test]
fn execution_limits_reject_zero_values() {
    let error = GitExecutionLimits::new(Duration::ZERO, Duration::from_secs(1), 1)
        .expect_err("zero query timeout");
    assert!(matches!(
        error,
        GitError::InvalidConfiguration {
            field: "query_timeout",
            requirement: "must be non-zero",
        }
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn query_runner_captures_system_git_output() {
    let repository = TestRepository::init();
    let output = GitClient::system()
        .run_query(repository.root(), ["--version"])
        .await
        .expect("run git version");

    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .expect("version is UTF-8")
            .starts_with("git version ")
    );
    assert_eq!(output.stderr, Vec::<u8>::new());
}

#[tokio::test(flavor = "current_thread")]
async fn clone_repository_uses_an_unused_child_folder() {
    let source = TestRepository::init();
    let destination = tempfile::tempdir().unwrap();
    let name = source.root().file_name().unwrap().to_string_lossy();
    let first = GitClient::system()
        .clone_repository(source.root().to_str().unwrap(), destination.path())
        .await
        .unwrap();
    assert_eq!(
        first,
        destination
            .path()
            .canonicalize()
            .unwrap()
            .join(name.as_ref())
    );
    assert!(first.join(".git").exists());

    let second = GitClient::system()
        .clone_repository(source.root().to_str().unwrap(), destination.path())
        .await
        .unwrap();
    assert_eq!(
        second,
        destination
            .path()
            .canonicalize()
            .unwrap()
            .join(format!("{name}-1"))
    );
    assert!(second.join(".git").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn clone_repository_rejects_a_url_without_a_repository_name() {
    let destination = tempfile::tempdir().unwrap();
    let error = GitClient::system()
        .clone_repository("https://example.com/", destination.path())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GitError::InvalidConfiguration {
            field: "clone URL",
            ..
        }
    ));
    assert_eq!(destination.path().read_dir().unwrap().count(), 0);
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn concurrent_clones_reserve_distinct_destinations_before_git_starts() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("clones");
    let alias = root.path().join("alias");
    let started = root.path().join("started");
    let release = root.path().join("release");
    std::fs::create_dir(&destination).unwrap();
    std::fs::create_dir(&started).unwrap();
    std::os::unix::fs::symlink(&destination, &alias).unwrap();
    let executable = root.path().join("git");
    std::fs::write(&executable, format!(
        "#!/bin/sh\nfor arg do target=\"$arg\"; done\nprintf '%s' \"$target\" > '{}/'$$\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nmkdir -p \"$target/.git\"\n",
        started.display(), release.display(),
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = GitClient::with_executable(executable, GitExecutionLimits::default()).unwrap();
    let unblock = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while started.read_dir().unwrap().count() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let targets: Vec<_> = started
            .read_dir()
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        std::fs::write(release, "").unwrap();
        targets
    });
    let (first, second) = tokio::join!(
        client.clone_repository("https://example.com/repo.git", &destination),
        client.clone_repository("https://example.com/repo.git", &alias),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    let targets = unblock.join().unwrap();
    assert_eq!(targets.len(), 2);
    assert_ne!(targets[0], targets[1]);
    assert_ne!(first, second);
    assert!(first.join(".git").exists());
    assert!(second.join(".git").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn failed_clone_releases_its_empty_destination_reservation() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("missing.git");
    let destination = root.path().join("clones");
    std::fs::create_dir(&destination).unwrap();
    assert!(
        GitClient::system()
            .clone_repository(source.to_str().unwrap(), &destination)
            .await
            .is_err()
    );
    assert_eq!(destination.read_dir().unwrap().count(), 0);
}

#[test]
fn git_commands_remove_inherited_repository_selectors() {
    let client = GitClient::system();
    let invocation = GitInvocation::query(
        std::path::Path::new("/dir"),
        ["status"],
        FsmonitorOverride::Disabled,
    );
    let (command, _) = client.configure_command(&invocation).unwrap();
    let environment = command
        .as_std()
        .get_envs()
        .collect::<std::collections::HashMap<_, _>>();

    for name in REPOSITORY_SELECTOR_ENVIRONMENT {
        assert_eq!(environment.get(std::ffi::OsStr::new(name)), Some(&None));
    }
}

#[tokio::test]
async fn system_git_uses_an_absolute_installation_path_when_workspace_contains_git() {
    let directory = tempfile::tempdir().unwrap();
    let impostor = directory
        .path()
        .join(if cfg!(windows) { "git.exe" } else { "git" });
    std::fs::write(impostor, b"not an installed Git executable").unwrap();
    let client = GitClient::system();
    let path = client.executable().unwrap();
    assert!(path.is_absolute());
    assert!(!path.starts_with(directory.path()));
    let output = client
        .run_query(directory.path(), ["--version"])
        .await
        .unwrap();
    assert!(output.stdout.starts_with(b"git version "));
    assert!(GitClient::with_executable("git".into(), GitExecutionLimits::default()).is_err());
}

#[cfg(windows)]
#[path = "process_tests.rs"]
mod process;
