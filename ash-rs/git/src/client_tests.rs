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
