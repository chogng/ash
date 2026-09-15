use super::GitRuntime;
use crate::server::notification_queue::NotificationQueue;
use crate::server::update_broker::UpdateBroker;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

#[test]
fn runtime_revisions_and_notifies_only_for_changed_repository_state() {
    let repository = TestRepository::init();
    repository.write("repository/tracked.txt", "initial\n");
    repository.write("outside.txt", "initial\n");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "initial"]);
    let broker = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);
    let authorization = mutation_authorization(&repository.root().join("repository"));
    let dir_root = authorization.dir().canonical_path().to_path_buf();
    let repository_root = Dir::open_local(repository.root())
        .unwrap()
        .canonical_path()
        .to_path_buf();
    let runtime = GitRuntime::new(authorization, broker).unwrap();

    let initial = runtime.status().unwrap();
    assert_eq!(initial.revision, 1);
    assert_eq!(initial.path, "repository");
    assert!(initial.changes.is_empty());
    assert_eq!(queue.drain().len(), 1);
    let watched_paths = runtime.watched_paths();
    assert!(
        watched_paths
            .iter()
            .any(|watch| { watch.path == dir_root && watch.recursive })
    );
    assert!(
        watched_paths
            .iter()
            .any(|watch| { watch.path == repository_root.join(".gitignore") && !watch.recursive })
    );
    assert!(
        watched_paths
            .iter()
            .any(|watch| { watch.path == repository_root.join(".git") && watch.recursive })
    );

    repository.write("outside.txt", "outside change\n");
    let outside_only = runtime.status().unwrap();
    assert_eq!(outside_only.stream_instance_id, initial.stream_instance_id);
    assert_eq!(outside_only.revision, 1);
    assert!(outside_only.changes.is_empty());
    assert!(queue.drain().is_empty());

    repository.write("repository/tracked.txt", "repository change\n");
    let changed = runtime.status().unwrap();
    assert_eq!(changed.stream_instance_id, initial.stream_instance_id);
    assert_eq!(changed.revision, 2);
    assert_eq!(changed.changes.len(), 1);
    let notifications = queue.drain();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0]["method"], "git/statusChanged");
    assert_eq!(
        notifications[0]["params"]["status"]["streamInstanceId"],
        initial.stream_instance_id.as_str()
    );
    assert_eq!(notifications[0]["params"]["status"]["revision"], 2);

    let unchanged = runtime.status().unwrap();
    assert_eq!(unchanged.revision, 2);
    assert!(queue.drain().is_empty());
}

#[test]
fn restricted_runtime_exposes_read_only_git_and_rejects_mutations() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    repository.write("tracked.txt", "changed\n");
    let runtime = GitRuntime::new(
        inspection_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();

    let status = runtime.status().unwrap();
    assert_eq!(status.changes.len(), 1);
    assert_eq!(runtime.recent_commits().unwrap().len(), 1);
    assert_eq!(runtime.local_branches().unwrap().len(), 1);
    assert!(runtime.text_diff().is_ok());
    assert!(matches!(
        runtime.stage(vec![PathBuf::from("tracked.txt")]),
        Err(super::GitRuntimeError::Service(
            crate::git_service::GitServiceError::Permission
        ))
    ));
    assert!(runtime.switch_branch("main").is_err());
}

#[test]
fn runtime_incarnations_use_distinct_revision_scopes() {
    let repository = TestRepository::init();
    let broker = Arc::new(UpdateBroker::default());
    let first = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::clone(&broker),
    )
    .unwrap();
    let second = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();

    let first_status = first.status().unwrap();
    let second_status = second.status().unwrap();

    assert!(first_status.path.is_empty());
    assert_ne!(
        first_status.stream_instance_id,
        second_status.stream_instance_id
    );
    assert_eq!(first_status.revision, 1);
    assert_eq!(second_status.revision, 1);
}

#[test]
fn unchanged_watcher_refresh_keeps_graph_cursor_alive() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    repository.write("tracked.txt", "updated\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "updated"]);
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    runtime.status().unwrap();

    let first_page = runtime
        .graph(1, std::num::NonZeroUsize::new(1).unwrap(), None)
        .unwrap();
    let cursor = first_page.next_cursor.expect("graph continuation cursor");

    runtime.repositories[0].refresh_from_watcher();

    let final_page = runtime
        .graph(1, std::num::NonZeroUsize::new(1).unwrap(), Some(&cursor))
        .unwrap();
    assert_eq!(final_page.commits.len(), 1);
    assert!(!final_page.has_more);
}

#[test]
fn runtime_discovers_nested_repositories_and_routes_operations_by_repository_id() {
    let repository = TestRepository::init();
    repository.write(".gitignore", "nested/\n");
    repository.write("root.txt", "root before\n");
    repository.git(&["add", ".gitignore", "root.txt"]);
    repository.git(&["commit", "-m", "root initial"]);

    std::fs::create_dir_all(repository.root().join("nested")).unwrap();
    repository.git_at("nested", &["init", "--initial-branch=main"]);
    repository.git_at("nested", &["config", "user.name", "Ash Test"]);
    repository.git_at("nested", &["config", "user.email", "ash@example.invalid"]);
    repository.write("nested/nested.txt", "nested before\n");
    repository.git_at("nested", &["add", "nested.txt"]);
    repository.git_at("nested", &["commit", "-m", "nested initial"]);

    repository.write("root.txt", "root after\n");
    repository.write("nested/nested.txt", "nested after\n");
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let descriptors = runtime.repositories().repositories;

    assert_eq!(
        descriptors
            .iter()
            .map(|descriptor| descriptor.path.as_str())
            .collect::<Vec<_>>(),
        vec!["", "nested"]
    );
    let root_id = descriptors
        .iter()
        .find(|descriptor| descriptor.path.is_empty())
        .unwrap()
        .id
        .clone();
    let nested_id = descriptors
        .iter()
        .find(|descriptor| descriptor.path == "nested")
        .unwrap()
        .id
        .clone();

    let root_status = runtime.status_for(Some(&root_id)).unwrap();
    let nested_status = runtime.status_for(Some(&nested_id)).unwrap();
    assert_eq!(root_status.repository_id, root_id);
    assert_eq!(nested_status.repository_id, nested_id);
    assert_eq!(root_status.changes.len(), 1);
    assert_eq!(root_status.changes[0].path, "root.txt");
    assert_eq!(nested_status.changes.len(), 1);
    assert_eq!(nested_status.changes[0].path, "nested.txt");

    let staged = runtime
        .stage_for(Some(&nested_id), vec![PathBuf::from("nested.txt")])
        .unwrap();
    assert_eq!(staged.repository_id, nested_id);
    assert_ne!(
        staged.changes[0].index_status,
        staged.changes[0].worktree_status
    );
    assert!(matches!(
        runtime.status_for(Some("repo_missing")),
        Err(super::GitRuntimeError::RepositoryNotFound)
    ));
}

#[test]
fn runtime_projects_text_diffs_and_switches_only_existing_local_branches() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "before\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    repository.git(&["branch", "topic"]);
    repository.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/example/ash.git",
    ]);
    let head = repository.git_output(&["rev-parse", "HEAD"]);
    repository.git(&["update-ref", "refs/remotes/origin/main", &head]);
    repository.write("tracked.txt", "after\n");
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();

    let projection = runtime.text_diff().unwrap();

    assert_eq!(projection.status.changes.len(), 1);
    assert_eq!(projection.diffs.len(), 1);
    assert_eq!(projection.diffs[0].path, "tracked.txt");
    assert_eq!(projection.diffs[0].original, "before\n");
    assert_eq!(projection.diffs[0].modified, "after\n");
    assert_eq!(projection.statistics.files, 1);
    let history = runtime.recent_commits().unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].subject, "initial");
    assert_eq!(history[0].object_id.len(), 40);
    assert!(history[0].parent_object_ids.is_empty());
    let branches = runtime.local_branches().unwrap();
    assert!(
        branches
            .iter()
            .any(|branch| branch.name == "main" && branch.current)
    );
    assert!(
        branches
            .iter()
            .any(|branch| branch.name == "topic" && !branch.current)
    );
    let graph = runtime
        .graph(1, std::num::NonZeroUsize::new(50).unwrap(), None)
        .unwrap();
    assert!(graph.references.iter().any(|reference| {
        reference.name == "origin/main"
            && reference.kind
                == ash_app_server_protocol::protocol::git::GitReferenceKindDto::RemoteBranch
    }));
    assert_eq!(graph.remotes[0].name, "origin");
    assert_eq!(
        graph.remotes[0]
            .identity
            .as_ref()
            .expect("remote identity")
            .provider,
        ash_app_server_protocol::protocol::git::GitRemoteProviderDto::Github
    );

    let switched = runtime.switch_branch("topic").unwrap();
    assert!(matches!(
        switched.head,
        ash_app_server_protocol::protocol::git::GitHeadDto::Branch { ref name, .. }
            if name == "topic"
    ));
    assert!(runtime.switch_branch("missing").is_err());
}

struct TestRepository {
    root: PathBuf,
}

impl TestRepository {
    fn init() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ash-app-server-git-runtime-{}-{}",
            std::process::id(),
            unique_sequence()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let repository = Self { root };
        repository.git(&["init", "--initial-branch=main"]);
        repository.git(&["config", "user.name", "Ash Test"]);
        repository.git(&["config", "user.email", "ash@example.invalid"]);
        repository
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn git(&self, arguments: &[&str]) {
        self.git_output(arguments);
    }

    fn git_at(&self, relative: &str, arguments: &[&str]) {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(self.root.join(relative))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            relative,
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(&self, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}

impl Drop for TestRepository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn unique_sequence() -> u64 {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn mutation_authorization(root: &Path) -> Authorization {
    Grant::for_environment(
        Dir::open_local(root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::MutateRepository]),
    )
    .authorize(Permission::MutateRepository)
    .unwrap()
}

fn inspection_authorization(root: &Path) -> Authorization {
    Grant::for_environment(
        Dir::open_local(root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::InspectRepository]),
    )
    .authorize(Permission::InspectRepository)
    .unwrap()
}
