use super::GitService;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_git::GitClient;
use ash_git::GitCommitRequest;
use ash_git::GitExecutionLimits;
use ash_git::GitHead;
use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn commit_requires_write_permission_for_the_whole_checkout_before_staging() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ash Test"]);
    git(&root, &["config", "user.email", "ash@example.invalid"]);
    std::fs::write(root.join("outside.txt"), "initial\n").unwrap();
    std::fs::write(root.join("nested/inside.txt"), "initial\n").unwrap();
    git(&root, &["add", "--all"]);
    git(&root, &["commit", "-m", "initial"]);
    let head = git(&root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("outside.txt"), "staged outside\n").unwrap();
    git(&root, &["add", "outside.txt"]);
    std::fs::write(root.join("nested/inside.txt"), "unstaged inside\n").unwrap();
    std::fs::write(root.join("nested/new.txt"), "untracked inside\n").unwrap();
    let index = git(&root, &["ls-files", "--stage"]);
    for (grant_root, permission) in [
        (root.clone(), Permission::InspectRepository),
        (root.join("nested"), Permission::MutateRepository),
    ] {
        let authorization = Grant::for_environment(
            Dir::open_local(&grant_root).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([permission]),
        )
        .authorize(permission)
        .unwrap();
        let mut service = GitService::new(authorization, grant_root).unwrap();
        let (client, commands) = recording_git(&root);
        service.client = client;
        for request in [
            GitCommitRequest::new("staged".into()).unwrap(),
            GitCommitRequest::new("tracked".into())
                .unwrap()
                .with_tracked_changes(),
            GitCommitRequest::new("all".into())
                .unwrap()
                .with_untracked_changes()
                .amend()
                .sign_off(),
        ] {
            std::fs::write(&commands, "").unwrap();
            let error = service
                .commit(request)
                .err()
                .expect("unauthorized commit must fail");
            if permission == Permission::InspectRepository {
                assert!(matches!(error, super::GitServiceError::Permission));
            } else {
                assert!(matches!(error, super::GitServiceError::Boundary));
            }
            assert_no_commit_mutations(&commands);
            if permission == Permission::InspectRepository {
                assert_eq!(std::fs::read_to_string(&commands).unwrap(), "");
            }
            assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
            assert_eq!(git(&root, &["ls-files", "--stage"]), index);
            assert_eq!(
                std::fs::read_to_string(root.join("nested/inside.txt")).unwrap(),
                "unstaged inside\n"
            );
        }
    }
    let authorization = Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::MutateRepository]),
    )
    .authorize(Permission::MutateRepository)
    .unwrap();
    let service = GitService::new(authorization, root.clone()).unwrap();
    service
        .commit(
            GitCommitRequest::new("authorized".into())
                .unwrap()
                .with_tracked_changes(),
        )
        .unwrap();
    assert_eq!(git(&root, &["show", "HEAD:outside.txt"]), "staged outside");
    assert_eq!(
        git(&root, &["show", "HEAD:nested/inside.txt"]),
        "unstaged inside"
    );
    assert_eq!(git(&root, &["ls-files", "nested/new.txt"]), "");
}

#[test]
fn stale_amend_target_never_runs_add_or_commit_for_any_scope() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ash Test"]);
    git(&root, &["config", "user.email", "ash@example.invalid"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    let expected = GitHead::Branch {
        name: "main".into(),
        object_id: git(&root, &["rev-parse", "HEAD"]),
        upstream: None,
    };
    git(&root, &["switch", "-c", "other"]);
    std::fs::write(root.join("tracked.txt"), "staged\n").unwrap();
    git(&root, &["add", "tracked.txt"]);
    std::fs::write(root.join("tracked.txt"), "working\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    let index = std::fs::read(root.join(".git/index")).unwrap();
    let authorization = Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::MutateRepository]),
    )
    .authorize(Permission::MutateRepository)
    .unwrap();
    let mut service = GitService::new(authorization, root.clone()).unwrap();
    let (client, commands) = recording_git(&root);
    service.client = client;
    for request in [
        GitCommitRequest::new("staged".into()).unwrap(),
        GitCommitRequest::new("tracked".into())
            .unwrap()
            .with_tracked_changes(),
        GitCommitRequest::new("all".into())
            .unwrap()
            .with_untracked_changes(),
    ] {
        std::fs::write(&commands, "").unwrap();
        let error = service
            .commit(
                request
                    .amend()
                    .with_expected_head(expected.clone())
                    .unwrap(),
            )
            .err()
            .unwrap();
        assert!(matches!(
            error,
            super::GitServiceError::Git(ash_git::GitError::InvalidConfiguration {
                field: "expected HEAD",
                ..
            })
        ));
        let recorded = std::fs::read_to_string(&commands).unwrap();
        assert!(
            !recorded.lines().any(|line| line
                .split_whitespace()
                .any(|argument| matches!(argument, "add" | "commit"))),
            "{recorded}"
        );
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
    }
}

#[test]
fn revoked_write_grant_rejects_every_commit_scope_before_running_git() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ash Test"]);
    git(&root, &["config", "user.email", "ash@example.invalid"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    git(&root, &["add", "tracked.txt"]);
    git(&root, &["commit", "-m", "initial"]);
    std::fs::write(root.join("tracked.txt"), "staged\n").unwrap();
    git(&root, &["add", "tracked.txt"]);
    std::fs::write(root.join("tracked.txt"), "unstaged\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let index = git(&root, &["ls-files", "--stage"]);
    let grant = Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::MutateRepository]),
    );
    let authorization = grant.authorize(Permission::MutateRepository).unwrap();
    let mut service = GitService::new(authorization, root.clone()).unwrap();
    let (client, commands) = recording_git(&root);
    service.client = client;
    // Revocation must apply to an already-created service, before it touches the shared index.
    grant.revoke();
    for request in [
        GitCommitRequest::new("staged".into()).unwrap(),
        GitCommitRequest::new("tracked".into())
            .unwrap()
            .with_tracked_changes(),
        GitCommitRequest::new("all".into())
            .unwrap()
            .with_untracked_changes()
            .amend()
            .sign_off(),
    ] {
        std::fs::write(&commands, "").unwrap();
        let error = service.commit(request).err().unwrap();
        assert!(matches!(error, super::GitServiceError::Permission));
        assert_eq!(std::fs::read_to_string(&commands).unwrap(), "");
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&root, &["ls-files", "--stage"]), index);
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("new.txt")).unwrap(),
            "untracked\n"
        );
    }
}

#[test]
fn commit_rejects_parent_and_symlink_paths_that_leave_the_authorized_checkout() {
    let authorized = tempfile::tempdir().unwrap();
    let root = authorized.path().canonicalize().unwrap();
    let external = tempfile::tempdir().unwrap();
    let external_root = external.path().canonicalize().unwrap();
    git(&external_root, &["init", "--initial-branch=main"]);
    git(&external_root, &["config", "user.name", "Ash Test"]);
    git(
        &external_root,
        &["config", "user.email", "ash@example.invalid"],
    );
    std::fs::write(external_root.join("file.txt"), "initial\n").unwrap();
    git(&external_root, &["add", "file.txt"]);
    git(&external_root, &["commit", "-m", "initial"]);
    std::fs::write(external_root.join("file.txt"), "outside change\n").unwrap();
    let head = git(&external_root, &["rev-parse", "HEAD"]);
    let index = git(&external_root, &["ls-files", "--stage"]);
    std::os::unix::fs::symlink(&external_root, root.join("escape")).unwrap();
    for path in [
        root.join("..").join(external_root.file_name().unwrap()),
        root.join("escape"),
    ] {
        let authorization = Grant::for_environment(
            Dir::open_local(&root).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([Permission::MutateRepository]),
        )
        .authorize(Permission::MutateRepository)
        .unwrap();
        let mut service = GitService::new(authorization, path).unwrap();
        let (client, commands) = recording_git(&external_root);
        service.client = client;
        std::fs::write(&commands, "").unwrap();
        let error = service
            .commit(
                GitCommitRequest::new("escape".into())
                    .unwrap()
                    .with_untracked_changes(),
            )
            .err()
            .expect("escaped checkout must be rejected");
        assert!(matches!(error, super::GitServiceError::Boundary));
        assert_no_commit_mutations(&commands);
        assert_eq!(git(&external_root, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&external_root, &["ls-files", "--stage"]), index);
        assert_eq!(
            std::fs::read_to_string(external_root.join("file.txt")).unwrap(),
            "outside change\n"
        );
    }
}

#[test]
fn branch_listing_discovers_once_and_refreshes_worktree_occupancy() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repository");
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(
        &root,
        &[
            "-c",
            "user.name=Ash Test",
            "-c",
            "user.email=ash@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    );
    let linked = directory.path().join("linked");
    git(
        &root,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let authorization = Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::InspectRepository]),
    )
    .authorize(Permission::InspectRepository)
    .unwrap();
    let mut service = GitService::new(authorization, root.clone()).unwrap();
    let executable = directory.path().join("record-git");
    let log = directory.path().join("commands");
    let git_path = GitClient::system().executable().unwrap();
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nexec {} \"$@\"\n",
            shell_path(&log),
            shell_path(&git_path)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    service.client = GitClient::with_executable(executable, GitExecutionLimits::default()).unwrap();

    let result = service.local_branches().unwrap();
    assert_eq!(result.branches.len(), 2);
    assert!(
        result
            .branches
            .iter()
            .any(|branch| branch.name() == "main" && branch.is_current())
    );
    assert_eq!(
        result.checked_out_elsewhere,
        HashSet::from(["topic".to_owned()])
    );
    let commands = std::fs::read_to_string(&log).unwrap();
    assert_eq!(commands.lines().count(), 3, "{commands}");
    assert_eq!(
        commands
            .lines()
            .filter(|line| line.contains("rev-parse"))
            .count(),
        1
    );

    git(&root, &["worktree", "remove", linked.to_str().unwrap()]);
    git(&root, &["branch", "later"]);
    std::fs::write(&log, "").unwrap();
    let refreshed = service.local_branches().unwrap();
    assert!(refreshed.checked_out_elsewhere.is_empty());
    assert!(
        refreshed
            .branches
            .iter()
            .any(|branch| branch.name() == "later")
    );
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 3);
}

fn recording_git(root: &Path) -> (GitClient, std::path::PathBuf) {
    // Keep the probe outside the working tree so all-change staging cannot include test artifacts.
    let executable = root.join(".git/record-git");
    let commands = root.join(".git/commands");
    let git_path = GitClient::system().executable().unwrap();
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nexec {} \"$@\"\n",
            shell_path(&commands),
            shell_path(&git_path)
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    (
        GitClient::with_executable(executable, GitExecutionLimits::default()).unwrap(),
        commands,
    )
}

fn assert_no_commit_mutations(log: &Path) {
    let commands = std::fs::read_to_string(log).unwrap();
    assert!(
        !commands
            .split_whitespace()
            .any(|argument| matches!(argument, "add" | "commit")),
        "unauthorized request launched a mutating Git command: {commands}"
    );
}

fn shell_path(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
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
