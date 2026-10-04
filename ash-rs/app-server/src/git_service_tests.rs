use super::GitService;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_git::GitClient;
use ash_git::GitExecutionLimits;
use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

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

fn shell_path(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

fn git(root: &Path, args: &[&str]) {
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
}
