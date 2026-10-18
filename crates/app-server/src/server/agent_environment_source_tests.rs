use super::AgentEnvironmentSource;
use super::RepositoryInspection;
use ash_agent_environment::RepositoryEnvironment;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigStore;
use ash_config::UserConfigCommand;
use ash_core::HarnessContextProvider;
use ash_core::HarnessContextRequest;
use ash_core::HarnessContextScope;
use ash_file_access::Dir;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::CommandId;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new(ash_git::GitClient::system().executable().unwrap())
        .current_dir(root)
        .args([
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Environment Test",
            "-c",
            "user.email=environment@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn inspection_only_directory_open_and_environment_move_do_not_run_repository_helpers() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    git(
        root.path(),
        &["init", "--quiet", "--initial-branch=environment-test"],
    );
    std::fs::write(root.path().join("tracked.txt"), "initial\n").unwrap();
    git(root.path(), &["add", "tracked.txt"]);
    git(
        root.path(),
        &["commit", "--quiet", "-m", "Environment baseline"],
    );
    git(
        root.path(),
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    std::fs::write(root.path().join("tracked.txt"), "changed\n").unwrap();
    let marker = root.path().join(".git/environment-helper-ran");
    std::fs::write(
        root.path().join(".git/environment-helper"),
        "#!/bin/sh\nprintf invoked > .git/environment-helper-ran\nexit 1\n",
    )
    .unwrap();
    git(
        root.path(),
        &["config", "core.fsmonitor", "sh .git/environment-helper"],
    );
    let index = std::fs::read(root.path().join(".git/index")).unwrap();

    let state = ash_state::StateRuntime::open(profile.path()).unwrap();
    let config =
        ConfigStore::open_with_paths(state.database_path(), profile.path().join("config.toml"))
            .unwrap();
    let directory = Dir::open_local(root.path()).unwrap();
    let permissions = Permissions::new([Permission::InspectRepository]);
    assert!(!permissions.allows(Permission::ExecuteCommands));
    assert!(!permissions.allows(Permission::MutateRepository));
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("inspect-environment").unwrap(),
            expected_revision: config.read_snapshot().unwrap().revision,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: directory.id(),
                permissions,
                display_path: None,
            },
        })
        .unwrap();
    let runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let server = crate::open_app_server(
        crate::AppServerOptions::new(profile.path())
            .with_profile_runtime(runtime)
            .with_user_config_dir_root(root.path())
            .without_built_in_skills(),
        ash_app_server_diff::compute,
    )
    .unwrap();
    assert_eq!(
        server
            .env_runtime
            .read()
            .unwrap()
            .selected_grant
            .as_ref()
            .unwrap()
            .permissions(),
        &Permissions::new([Permission::InspectRepository])
    );
    let contributions = server
        .env_runtime
        .read()
        .unwrap()
        ._dir_contributions
        .clone()
        .unwrap();
    let context = contributions
        .snapshot(&HarnessContextRequest {
            scope: HarnessContextScope::Environment,
            read_paths: &[],
        })
        .unwrap();
    assert_repository_facts(context.environment().unwrap().repository());
    assert!(
        !marker.exists(),
        "directory open executed a repository helper"
    );

    let moved = contributions
        .environment_for_directory(directory.canonical_path(), RepositoryInspection::Allowed)
        .unwrap()
        .snapshot([directory.canonical_path().to_path_buf()])
        .unwrap();
    assert_repository_facts(moved.repository());
    assert!(
        !marker.exists(),
        "environment move executed a repository helper"
    );
    assert_eq!(
        std::fs::read(root.path().join(".git/index")).unwrap(),
        index
    );
}

fn assert_repository_facts(repository: &RepositoryEnvironment) {
    let RepositoryEnvironment::Git {
        branch,
        main_branch,
        status,
        recent_commits,
    } = repository
    else {
        panic!("repository context was omitted");
    };
    assert_eq!(branch.as_deref(), Some("environment-test"));
    assert_eq!(main_branch.as_deref(), Some("main"));
    assert!(status.contains("M tracked.txt"), "{status}");
    assert!(
        recent_commits.contains("Environment baseline"),
        "{recent_commits}"
    );
}

#[test]
fn environment_capture_preserves_unborn_detached_and_plain_directories() {
    let root = tempfile::tempdir().unwrap();
    let capture = || {
        AgentEnvironmentSource::capture(root.path(), RepositoryInspection::Allowed)
            .unwrap()
            .repository
    };
    assert_eq!(capture(), RepositoryEnvironment::NotDetected);
    git(
        root.path(),
        &["init", "--quiet", "--initial-branch=environment-test"],
    );
    assert_eq!(
        capture(),
        RepositoryEnvironment::git(
            Some("environment-test".into()),
            Some("environment-test".into()),
            "(clean)".into(),
            "(none)".into(),
        )
        .unwrap()
    );
    git(
        root.path(),
        &["commit", "--quiet", "--allow-empty", "-m", "Initial"],
    );
    git(root.path(), &["checkout", "--quiet", "--detach"]);
    let RepositoryEnvironment::Git {
        branch,
        main_branch,
        status,
        recent_commits,
    } = capture()
    else {
        panic!("detached repository was omitted");
    };
    assert!(branch.is_none());
    assert!(main_branch.is_none());
    assert_eq!(status, "(clean)");
    assert!(recent_commits.contains("Initial"));
    assert_eq!(
        AgentEnvironmentSource::capture(root.path(), RepositoryInspection::Omit)
            .unwrap()
            .repository,
        RepositoryEnvironment::NotDetected
    );
}

#[test]
fn environment_capture_omits_content_queries_that_can_start_repository_programs() {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "--quiet", "--initial-branch=main"]);
    std::fs::write(root.path().join("tracked.txt"), "initial\n").unwrap();
    git(root.path(), &["add", "tracked.txt"]);
    git(root.path(), &["commit", "--quiet", "-m", "Initial"]);
    std::fs::write(root.path().join("tracked.txt"), "modified contents\n").unwrap();
    std::fs::write(
        root.path().join(".gitattributes"),
        "tracked.txt filter=environment\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join(".git/content-helper"),
        "#!/bin/sh\nprintf invoked > .git/content-helper-ran\ncat\n",
    )
    .unwrap();
    git(
        root.path(),
        &[
            "config",
            "filter.environment.clean",
            "sh .git/content-helper",
        ],
    );
    let capture = || {
        AgentEnvironmentSource::capture(root.path(), RepositoryInspection::Allowed)
            .unwrap()
            .repository
    };
    let RepositoryEnvironment::Git {
        branch,
        status,
        recent_commits,
        ..
    } = capture()
    else {
        panic!("repository metadata was omitted");
    };
    assert_eq!(branch.as_deref(), Some("main"));
    assert_eq!(status, "(none)");
    assert!(recent_commits.contains("Initial"));
    assert!(!root.path().join(".git/content-helper-ran").exists());

    // A partial clone must not fetch objects merely to supply optional context.
    git(root.path(), &["config", "remote.origin.promisor", "true"]);
    let RepositoryEnvironment::Git {
        branch,
        status,
        recent_commits,
        ..
    } = capture()
    else {
        panic!("repository metadata was omitted");
    };
    assert_eq!(branch.as_deref(), Some("main"));
    assert_eq!(status, "(none)");
    assert_eq!(recent_commits, "(none)");
    assert!(!root.path().join(".git/content-helper-ran").exists());
}
