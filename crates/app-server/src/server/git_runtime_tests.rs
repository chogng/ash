use super::GitRuntime;
use crate::server::notification_queue::NotificationQueue;
use crate::server::update_broker::UpdateBroker;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ConfigStore;
use ash_config::GitAutoFetchMode;
use ash_config::GitConfig;
use ash_config::PreferencesUpdate;
use ash_config::UserConfigCommand;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_git::GitCommitRequest;
use ash_protocol::CommandId;
use ash_protocol::Patch;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn scoped_commit_publishes_real_index_changes_to_all_connections_after_failure() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let head = repository.git_output(&["rev-parse", "HEAD"]);
    repository.write("tracked.txt", "changed\n");
    repository.write("new.txt", "new\n");
    repository.git(&["config", "user.name", ""]);
    repository.git(&["config", "user.email", ""]);
    let broker = Arc::new(UpdateBroker::default());
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    let initial = runtime.status().unwrap();
    first.drain();
    second.drain();
    let failure = runtime.commit_for(
        Some(&initial.repository_id),
        GitCommitRequest::new("retry after fixing identity".into())
            .unwrap()
            .with_untracked_changes()
            .sign_off(),
    );
    assert!(matches!(
        failure,
        Err(super::GitRuntimeError::Service(
            crate::git_service::GitServiceError::Git(_)
        ))
    ));
    assert_eq!(repository.git_output(&["rev-parse", "HEAD"]), head);
    assert_eq!(repository.git_output(&["show", ":tracked.txt"]), "changed");
    assert_eq!(repository.git_output(&["show", ":new.txt"]), "new");
    let events = first.drain();
    assert_eq!(events, second.drain());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["method"], "git/statusChanged");
    assert_eq!(
        events[0]["params"]["status"]["repositoryId"],
        initial.repository_id
    );
    assert_eq!(
        events[0]["params"]["status"]["revision"],
        initial.revision + 1
    );
    assert_eq!(
        events[0]["params"]["status"]["changes"][0]["indexStatus"],
        "added"
    );
    assert_eq!(
        events[0]["params"]["status"]["changes"][1]["indexStatus"],
        "modified"
    );
}

#[test]
fn failed_commit_preserves_original_error_with_poisoned_graph_cache() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let head = repository.git_output(&["rev-parse", "HEAD"]);
    repository.write("tracked.txt", "changed\n");
    repository.write("new.txt", "new\n");
    repository.git(&["config", "user.name", ""]);
    repository.git(&["config", "user.email", ""]);
    let broker = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    let initial = runtime.status().unwrap();
    queue.drain();
    let owner = runtime.repository(Some(&initial.repository_id)).unwrap();
    poison_graph_cache(&owner);

    let failure = runtime.commit_for(
        Some(&initial.repository_id),
        GitCommitRequest::new("retain original commit failure".into())
            .unwrap()
            .with_untracked_changes()
            .sign_off(),
    );
    let error = failure
        .err()
        .expect("commit must fail without Git identity");
    assert!(
        matches!(
            error,
            super::GitRuntimeError::Service(crate::git_service::GitServiceError::Git(_))
        ),
        "graph invalidation must not replace the commit error: {error:?}"
    );
    assert_eq!(repository.git_output(&["rev-parse", "HEAD"]), head);
    assert_eq!(repository.git_output(&["show", ":tracked.txt"]), "changed");
    assert_eq!(repository.git_output(&["show", ":new.txt"]), "new");
    assert_eq!(
        std::fs::read_to_string(repository.root().join("tracked.txt")).unwrap(),
        "changed\n"
    );
    // The owner accepts the snapshot before cache invalidation can prevent its notification.
    let accepted =
        serde_json::to_value(owner.state.lock().unwrap().status.as_ref().unwrap()).unwrap();
    assert_eq!(accepted["revision"], initial.revision + 1);
    assert_eq!(accepted["changes"][0]["indexStatus"], "added");
    assert_eq!(accepted["changes"][1]["indexStatus"], "modified");
    assert!(queue.drain().is_empty());
    assert!(owner.graph_sessions.is_poisoned());
}

#[test]
fn successful_commit_reports_poisoned_graph_cache_invalidation() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let head = repository.git_output(&["rev-parse", "HEAD"]);
    repository.write("tracked.txt", "changed\n");
    repository.git(&["add", "tracked.txt"]);
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let owner = runtime.repository(None).unwrap();
    poison_graph_cache(&owner);

    let failure = runtime.commit_for(
        None,
        GitCommitRequest::new("commit succeeded before invalidation".into()).unwrap(),
    );
    assert!(matches!(
        failure,
        Err(super::GitRuntimeError::Service(
            crate::git_service::GitServiceError::Runtime
        ))
    ));
    assert_ne!(repository.git_output(&["rev-parse", "HEAD"]), head);
    assert_eq!(
        repository.git_output(&["log", "-1", "--format=%s"]),
        "commit succeeded before invalidation"
    );
    assert_eq!(
        repository.git_output(&["diff", "--cached", "--name-only"]),
        ""
    );
}

fn poison_graph_cache(owner: &super::GitRepositoryRuntime) {
    // Unwind while holding the actual owner lock, rather than mocking its error result.
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _cache = owner.graph_sessions.lock().unwrap();
        panic!("poison graph cache for commit error preservation");
    }));
    assert!(poisoned.is_err());
    assert!(owner.graph_sessions.is_poisoned());
}

#[test]
fn commit_amend_and_undo_use_one_repository_owner_and_return_complete_messages() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let parent = repository.git_output(&["rev-parse", "HEAD"]);
    repository.write("tracked.txt", "changed\n");
    repository.write("new.txt", "untracked\n");
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let repository_id = runtime.status().unwrap().repository_id;
    let committed = runtime
        .commit_for(
            Some(&repository_id),
            GitCommitRequest::new("Second subject\n\nComplete body.".into())
                .unwrap()
                .with_tracked_changes(),
        )
        .unwrap();
    assert_eq!(repository.git_output(&["ls-files", "new.txt"]), "");
    let amended = runtime
        .commit_for(
            Some(&repository_id),
            GitCommitRequest::new("Amended subject\n\nComplete body.".into())
                .unwrap()
                .amend()
                .sign_off(),
        )
        .unwrap();
    assert_ne!(committed.object_id, amended.object_id);
    assert_eq!(repository.git_output(&["rev-parse", "HEAD^"]), parent);
    assert_eq!(
        runtime
            .commit_message_for(Some(&repository_id), &amended.object_id)
            .unwrap(),
        "Amended subject\n\nComplete body.\n\nSigned-off-by: Ash Test <ash@example.invalid>"
    );
    let (undone, outcome, _) = runtime
        .command_for(
            Some(&repository_id),
            &ash_git::GitCommand::UndoCommit {
                expected_head: amended.object_id,
            },
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(outcome, ash_git::GitCommandOutcome::Completed);
    assert_eq!(undone.repository_id, repository_id);
    assert_eq!(repository.git_output(&["rev-parse", "HEAD"]), parent);
    assert_eq!(repository.git_output(&["show", ":tracked.txt"]), "changed");
    assert_eq!(repository.git_output(&["ls-files", "new.txt"]), "");
}

#[test]
fn cancelled_and_stale_undo_leave_the_head_and_index_unchanged() {
    let repository = TestRepository::init();
    for message in ["initial", "second"] {
        repository.write("tracked.txt", message);
        repository.git(&["add", "tracked.txt"]);
        repository.git(&["commit", "-m", message]);
    }
    let head = repository.git_output(&["rev-parse", "HEAD"]);
    let parent = repository.git_output(&["rev-parse", "HEAD^"]);
    let index = repository.git_output(&["ls-files", "--stage"]);
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let cancellation = ash_async_utils::CancellationSource::new();
    cancellation.cancel();
    assert!(
        runtime
            .command_for(
                None,
                &ash_git::GitCommand::UndoCommit {
                    expected_head: head.clone()
                },
                &cancellation.token()
            )
            .is_err()
    );
    assert!(
        runtime
            .command_for(
                None,
                &ash_git::GitCommand::UndoCommit {
                    expected_head: parent
                },
                &ash_async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
    assert_eq!(repository.git_output(&["rev-parse", "HEAD"]), head);
    assert_eq!(repository.git_output(&["ls-files", "--stage"]), index);
    assert_eq!(
        std::fs::read_to_string(repository.root().join("tracked.txt")).unwrap(),
        "second"
    );
}

#[test]
fn ignore_changes_keep_directory_scope_and_do_not_cross_authorized_connections() {
    use ash_file_watcher::FileWatcherEvent;
    let repository = TestRepository::init();
    repository.write("nested/.gitignore", "*.log\n");
    let external = TestRepository::init();
    external.write("rules", "*.cache\n");
    let rules = external.root().join("rules");
    repository.git(&["config", "core.excludesFile", rules.to_str().unwrap()]);
    let broker = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    let unrelated = NotificationQueue::default();
    broker.register(1, false, &queue);
    broker.fork_scope().register(2, false, &unrelated);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    let owner = runtime.repository(None).unwrap();
    for (paths, expected) in [
        (
            vec![owner.service.dir_root().join("nested/.gitignore")],
            serde_json::json!(["nested"]),
        ),
        (
            vec![owner.service.dir_root().join("nested/file.log")],
            serde_json::json!(["nested/file.log"]),
        ),
        (
            vec![owner.identity.git_dir().join("index")],
            serde_json::json!([]),
        ),
        (vec![rules.clone()], serde_json::json!([])),
    ] {
        let change = owner
            .ignore_change(&FileWatcherEvent::PathsChanged { paths })
            .unwrap()
            .unwrap();
        owner.updates.publish_git_ignore_changed(change);
        let events = queue.drain();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["method"], "git/ignoreChanged");
        assert_eq!(events[0]["params"]["repositoryId"], owner.descriptor.id);
        assert_eq!(events[0]["params"]["paths"], expected);
        assert!(unrelated.drain().is_empty());
    }
    assert!(
        owner
            .ignore_change(&FileWatcherEvent::PathsChanged {
                paths: vec![owner.identity.git_dir().join("refs/heads/main")],
            })
            .unwrap()
            .is_none()
    );
    assert!(queue.drain().is_empty());
    assert!(
        owner
            .watched_paths()
            .iter()
            .any(|watch| watch.path == rules && !watch.recursive)
    );
}

#[test]
fn branch_mutations_refresh_all_connections_and_invalidate_history_cursors() {
    let repository = TestRepository::init();
    for value in ["initial", "updated"] {
        repository.write("tracked.txt", value);
        repository.git(&["add", "tracked.txt"]);
        repository.git(&["commit", "-m", value]);
    }
    let broker = Arc::new(UpdateBroker::default());
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    let initial = runtime.status().unwrap();
    first.drain();
    second.drain();
    let limit = std::num::NonZeroUsize::new(1).unwrap();
    let cursor = runtime.graph(1, limit, None).unwrap().next_cursor.unwrap();

    for (created, expected_revision) in
        [(true, initial.revision + 1), (false, initial.revision + 2)]
    {
        let branches = if created {
            runtime.create_branch_for(None, "topic").unwrap()
        } else {
            runtime.delete_branch_for(None, "topic").unwrap()
        };
        assert_eq!(
            branches.iter().any(|branch| branch.name == "topic"),
            created
        );
        assert_eq!(repository.git_output(&["branch", "--show-current"]), "main");
        let notifications = first.drain();
        assert_eq!(notifications, second.drain());
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0]["method"], "git/statusChanged");
        assert_eq!(
            notifications[0]["params"]["status"]["revision"],
            expected_revision
        );
        assert!(matches!(
            runtime.graph(1, limit, Some(&cursor)),
            Err(super::GitRuntimeError::InvalidGraphCursor)
        ));
    }

    assert!(runtime.delete_branch_for(None, "main").is_err());
    assert!(first.drain().is_empty());
    assert!(second.drain().is_empty());
}

#[test]
fn automatic_fetch_runs_from_shared_config_without_a_frontend() {
    let source = TestRepository::init();
    source.write("tracked.txt", "remote commit\n");
    source.git(&["add", "tracked.txt"]);
    source.git(&["commit", "-m", "remote commit"]);
    let expected = source.git_output(&["rev-parse", "HEAD"]);

    let consumer = TestRepository::init();
    consumer.git(&["remote", "add", "origin", source.root().to_str().unwrap()]);
    let config_path = consumer.root().join("autofetch.sqlite3");
    std::fs::write(
        config_path.with_extension("toml"),
        "schemaVersion = 5\n[git]\nautofetch = 'off'\nautofetchPeriod = 1\n",
    )
    .unwrap();
    let config = Arc::new(ConfigStore::open(&config_path).unwrap());
    let broker = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    broker.register(1, false, &queue);
    let runtime = GitRuntime::new(mutation_authorization(consumer.root()), broker).unwrap();
    runtime.status().unwrap();
    queue.drain();
    let watcher = runtime.start_watching(Some(Arc::clone(&config)));
    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("enable-autofetch").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                context: Patch::Missing,
                time_context: Patch::Missing,
                features: Patch::Missing,
                model: Patch::Missing,
                model_reasoning_effort: Patch::Missing,
                approval_review_model: Patch::Missing,
                commit_message_model: Patch::Missing,
                advisor: Patch::Missing,
                tool_mode: Patch::Missing,
                grep_backend: Patch::Missing,
                trace: Patch::Missing,
                git: Patch::Value(GitConfig {
                    autofetch: GitAutoFetchMode::Default,
                    autofetch_period: 1,
                }),
                gui: Patch::Missing,
                tui: Patch::Missing,
            }),
        })
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut notified = false;
    loop {
        let output = Command::new("git")
            .args(["rev-parse", "--verify", "refs/remotes/origin/main"])
            .current_dir(consumer.root())
            .output()
            .unwrap();
        notified |= queue
            .drain()
            .iter()
            .any(|notification| notification["method"] == "git/statusChanged");
        if output.status.success() && notified {
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "App Server did not automatically fetch"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(watcher);
    assert!(
        notified,
        "completed automatic fetch must publish its status before stop"
    );
}

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

    runtime.repository(None).unwrap().refresh_from_watcher();

    let final_page = runtime
        .graph(1, std::num::NonZeroUsize::new(1).unwrap(), Some(&cursor))
        .unwrap();
    assert_eq!(final_page.commits.len(), 1);
    assert!(!final_page.has_more);
}

#[test]
fn new_graph_observes_external_changes_before_a_late_watcher_refresh() {
    let repository = TestRepository::init();
    for message in ["first", "second"] {
        repository.write("file.txt", message);
        repository.git(&["add", "."]);
        repository.git(&["commit", "-m", message]);
    }
    repository.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/example/old.git",
    ]);
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    runtime.status().unwrap();

    // The graph request reaches the backend before the remote edit's watcher event.
    repository.git(&[
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/new.git",
    ]);
    let limit = std::num::NonZeroUsize::new(1).unwrap();
    let first_page = runtime.graph(1, limit, None).unwrap();
    assert_eq!(
        first_page.remotes[0].identity.as_ref().unwrap().repository,
        "new"
    );
    let cursor = first_page.next_cursor.unwrap();
    runtime.repository(None).unwrap().refresh_from_watcher();

    let final_page = runtime.graph(1, limit, Some(&cursor)).unwrap();
    assert_eq!(final_page.commits.len(), 1);
    assert_ne!(
        first_page.commits[0].object_id,
        final_page.commits[0].object_id
    );
    assert!(!final_page.has_more);
    assert!(final_page.next_cursor.is_none());
}

#[test]
fn external_ref_and_remote_changes_publish_without_head_or_file_changes() {
    let repository = TestRepository::init();
    for message in ["first", "second"] {
        repository.write("file.txt", message);
        repository.git(&["add", "."]);
        repository.git(&["commit", "-m", message]);
    }
    let broker = Arc::new(UpdateBroker::default());
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    let initial = runtime.status().unwrap();
    first.drain();
    second.drain();
    let limit = std::num::NonZeroUsize::new(1).unwrap();
    let commands: &[&[&str]] = &[
        &["branch", "external"],
        &["tag", "external-tag"],
        &["remote", "add", "origin", "https://example.invalid/first"],
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/second",
        ],
        &["update-ref", "refs/remotes/origin/topic", "HEAD"],
        &["tag", "-d", "external-tag"],
        &["branch", "-d", "external"],
        &["update-ref", "-d", "refs/remotes/origin/topic"],
    ];
    for (index, command) in commands.iter().enumerate() {
        let cursor = runtime.graph(1, limit, None).unwrap().next_cursor.unwrap();
        repository.git(command);
        let status = runtime.status().unwrap();
        assert_eq!(status.head, initial.head);
        assert_eq!(status.changes, initial.changes);
        assert_eq!(status.revision, initial.revision + index as u64 + 1);
        let notifications = first.drain();
        assert_eq!(notifications, second.drain());
        assert_eq!(notifications.len(), 1);
        assert!(matches!(
            runtime.graph(1, limit, Some(&cursor)),
            Err(super::GitRuntimeError::InvalidGraphCursor)
        ));
    }
    let cursor = runtime.graph(1, limit, None).unwrap().next_cursor.unwrap();
    repository.git(&["pack-refs", "--all", "--prune"]);
    runtime.status().unwrap();
    assert!(first.drain().is_empty());
    assert!(second.drain().is_empty());
    assert!(runtime.graph(1, limit, Some(&cursor)).is_ok());
}

#[test]
fn discovery_watches_empty_dirs_and_preserves_existing_repository_owners() {
    let repository = TestRepository::init();
    std::fs::remove_dir_all(repository.root().join(".git")).unwrap();
    let broker = Arc::new(UpdateBroker::default());
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    let runtime = GitRuntime::new(inspection_authorization(repository.root()), broker).unwrap();
    assert!(runtime.repositories().repositories.is_empty());
    let watcher = runtime.start_watching(None);
    repository.git(&["init", "-b", "main"]);
    await_repository_count(&runtime, 1);
    let owner = runtime.repository(None).unwrap();
    let status = owner.status().unwrap();
    assert!(
        first
            .drain()
            .iter()
            .any(|event| event["method"] == "git/repositoriesChanged")
    );
    assert!(
        second
            .drain()
            .iter()
            .any(|event| event["method"] == "git/repositoriesChanged")
    );
    std::fs::create_dir(repository.root().join("nested")).unwrap();
    repository.git_at("nested", &["init", "-b", "nested"]);
    await_repository_count(&runtime, 2);
    assert!(Arc::ptr_eq(&owner, &runtime.repository(None).unwrap()));
    assert_eq!(
        owner.status().unwrap().stream_instance_id,
        status.stream_instance_id
    );
    assert!(matches!(
        runtime.create_branch_for(None, "denied"),
        Err(super::GitRuntimeError::Service(
            crate::git_service::GitServiceError::Permission
        ))
    ));
    await_directory_change(|| {
        std::fs::rename(
            repository.root().join("nested"),
            repository.root().join("moved"),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !runtime
        .repositories()
        .repositories
        .iter()
        .any(|repo| repo.path == "moved")
    {
        assert!(
            Instant::now() < deadline,
            "moved repository was not discovered"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    await_directory_change(|| std::fs::remove_dir_all(repository.root().join("moved")));
    await_repository_count(&runtime, 1);
    await_directory_change(|| std::fs::remove_dir_all(repository.root().join(".git")));
    await_repository_count(&runtime, 0);
    repository.git(&["init", "-b", "recreated"]);
    await_repository_count(&runtime, 1);
    let recreated = runtime.status().unwrap();
    assert_eq!(recreated.repository_id, status.repository_id);
    assert_ne!(recreated.stream_instance_id, status.stream_instance_id);
    drop(watcher);
}

fn await_repository_count(runtime: &GitRuntime, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while runtime.repositories().repositories.len() != count {
        assert!(Instant::now() < deadline, "expected {count} repositories");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn await_directory_change(change: impl Fn() -> std::io::Result<()>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match change() {
            Ok(()) => return,
            // Windows pins a running Git process's working directory. Wait for an in-flight
            // query to exit; access denied from a persistent descendant watch must still fail.
            Err(error) if cfg!(windows) && error.raw_os_error() == Some(32) => {
                assert!(
                    Instant::now() < deadline,
                    "Git query kept the directory busy: {error}"
                );
            }
            Err(error) => panic!("unable to change repository directory: {error}"),
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn discovery_skips_deep_worktrees_but_accepts_them_when_opened_directly() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let worktree_path = ".delta/worktrees/review/ash";
    repository.git(&["worktree", "add", "-b", "review", worktree_path]);
    repository.git(&[
        "worktree",
        "add",
        "-b",
        "topic",
        "tools/worktrees/topic/ash",
    ]);

    let runtime = GitRuntime::new(
        inspection_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    assert_eq!(
        runtime
            .repositories()
            .repositories
            .iter()
            .map(|descriptor| descriptor.path.as_str())
            .collect::<Vec<_>>(),
        vec![""]
    );

    let worktree = GitRuntime::new(
        inspection_authorization(&repository.root().join(worktree_path)),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    assert_eq!(worktree.repositories().repositories.len(), 1);
    assert_eq!(
        runtime.common_dir_for(None).unwrap(),
        worktree.common_dir_for(None).unwrap()
    );
    assert!(matches!(
        worktree.status().unwrap().head,
        ash_app_server_protocol::protocol::git::GitHeadDto::Branch { name, .. } if name == "review"
    ));
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

    assert_eq!(
        runtime.common_dir_for(None).unwrap(),
        runtime.common_dir_for(Some(&root_id)).unwrap()
    );
    assert_ne!(
        runtime.common_dir_for(Some(&root_id)).unwrap(),
        runtime.common_dir_for(Some(&nested_id)).unwrap()
    );

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
fn worktrees_share_the_repository_admission_identity() {
    let repository = TestRepository::init();
    repository.write("tracked.txt", "initial\n");
    repository.git(&["add", "tracked.txt"]);
    repository.git(&["commit", "-m", "initial"]);
    let worktree = tempfile::tempdir().unwrap();
    repository.git(&[
        "worktree",
        "add",
        "--detach",
        worktree.path().to_str().unwrap(),
    ]);
    let main = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let linked = GitRuntime::new(
        mutation_authorization(worktree.path()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    assert_eq!(
        main.common_dir_for(None).unwrap(),
        linked.common_dir_for(None).unwrap()
    );
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

#[test]
fn stopping_watchers_cancels_an_active_automatic_fetch_before_joining_refresh() {
    use std::io::Read;
    use std::net::TcpListener;
    let repository = TestRepository::init();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("git://{}/repo.git", listener.local_addr().unwrap());
    repository.git(&["remote", "add", "origin", &url]);
    listener.set_nonblocking(true).unwrap();
    let accepting = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "automatic fetch did not connect");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("listener failed: {error}"),
            }
        }
    });
    let config_path = repository.root().join("autofetch.sqlite3");
    std::fs::write(
        config_path.with_extension("toml"),
        "schemaVersion = 5\n[git]\nautofetch = 'all'\nautofetchPeriod = 60\n",
    )
    .unwrap();
    let config = Arc::new(ConfigStore::open(&config_path).unwrap());
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    runtime.status().unwrap();
    let watcher = runtime.start_watching(Some(config));
    let mut remote = accepting.join().unwrap();
    remote.set_nonblocking(false).unwrap();
    remote
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = [0; 256];
    assert!(remote.read(&mut bytes).unwrap() > 0);
    // Force a refresh request that competes with the active network operation's lock.
    repository.write("during-fetch.txt", "refresh\n");
    let (done, completed) = std::sync::mpsc::channel();
    let closing = std::thread::spawn(move || {
        drop(watcher);
        done.send(()).unwrap();
    });
    completed.recv_timeout(Duration::from_secs(3)).unwrap();
    closing.join().unwrap();
    // Killing the Git process can close its TCP connection with FIN or RST; both prove that
    // cancellation released the active fetch. A timeout or additional data still fails.
    match remote.read(&mut bytes) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ) => {}
        result => panic!("automatic fetch connection stayed open after cancellation: {result:?}"),
    }
    assert!(runtime.status().is_ok());
}

#[test]
fn partially_failed_fetch_invalidates_the_graph_after_a_remote_ref_was_updated() {
    use ash_async_utils::CancellationSource;
    let repository = TestRepository::init();
    for value in ["initial", "updated"] {
        repository.write("tracked.txt", value);
        repository.git(&["add", "tracked.txt"]);
        repository.git(&["commit", "-m", value]);
    }
    let remote = TestRepository::init();
    remote.write("remote.txt", "remote commit\n");
    remote.git(&["add", "remote.txt"]);
    remote.git(&["commit", "-m", "remote commit"]);
    repository.git(&["remote", "add", "first", remote.root().to_str().unwrap()]);
    let missing = repository.root().join("missing-remote");
    repository.git(&["remote", "add", "second", missing.to_str().unwrap()]);
    let runtime = GitRuntime::new(
        mutation_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    runtime.status().unwrap();
    let page = runtime
        .graph(1, std::num::NonZeroUsize::new(1).unwrap(), None)
        .unwrap();
    let cursor = page.next_cursor.unwrap();
    let cancellation = CancellationSource::new();
    assert!(runtime.fetch(&cancellation.token()).is_err());
    assert_eq!(
        repository.git_output(&["rev-parse", "refs/remotes/first/main"]),
        remote.git_output(&["rev-parse", "HEAD"])
    );
    assert!(matches!(
        runtime.graph(1, std::num::NonZeroUsize::new(1).unwrap(), Some(&cursor)),
        Err(super::GitRuntimeError::InvalidGraphCursor)
    ));
    assert!(
        runtime
            .graph(1, std::num::NonZeroUsize::new(10).unwrap(), None)
            .is_ok()
    );
}

#[test]
fn repository_intents_publish_conflicts_and_refs_to_every_connection_and_reject_read_only() {
    use ash_async_utils::CancellationSource;
    use ash_git::GitCommand;
    use ash_git::GitCommandOutcome;
    let repository = TestRepository::init();
    repository.write("file.txt", "base\n");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "Base"]);
    repository.git(&["switch", "-c", "topic"]);
    repository.write("file.txt", "topic\n");
    repository.git(&["commit", "-am", "Topic"]);
    repository.git(&["switch", "main"]);
    repository.write("file.txt", "main\n");
    repository.git(&["commit", "-am", "Main"]);
    let broker = Arc::new(UpdateBroker::default());
    let first = NotificationQueue::default();
    let second = NotificationQueue::default();
    broker.register(1, false, &first);
    broker.register(2, false, &second);
    let runtime = GitRuntime::new(mutation_authorization(repository.root()), broker).unwrap();
    runtime.status().unwrap();
    first.drain();
    second.drain();
    let token = CancellationSource::new();
    let (status, outcome, operation) = runtime
        .command_for(
            None,
            &GitCommand::Merge {
                reference: "topic".into(),
            },
            &token.token(),
        )
        .unwrap();
    assert_eq!(outcome, GitCommandOutcome::Conflicted);
    assert_eq!(operation, Some(ash_git::GitIntegration::Merge));
    assert!(status.changes.iter().any(|change| change.conflicted));
    assert_eq!(first.drain(), second.drain());
    runtime
        .command_for(
            None,
            &GitCommand::Abort {
                operation: ash_git::GitIntegration::Merge,
            },
            &token.token(),
        )
        .unwrap();
    first.drain();
    second.drain();
    let before = runtime.status().unwrap();
    let (after, _, _) = runtime
        .command_for(
            None,
            &GitCommand::CreateTag {
                name: "review".into(),
                reference: "HEAD".into(),
            },
            &token.token(),
        )
        .unwrap();
    assert_eq!(after.revision, before.revision + 1);
    let updates = first.drain();
    assert_eq!(updates, second.drain());
    assert_eq!(updates.len(), 1);
    assert_eq!(runtime.catalog_for(None).unwrap().tags[0].0, "review");
    let read_only = GitRuntime::new(
        inspection_authorization(repository.root()),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    assert!(read_only.catalog_for(None).is_ok());
    assert!(matches!(
        read_only.command_for(
            None,
            &GitCommand::DeleteTag {
                name: "review".into()
            },
            &token.token()
        ),
        Err(super::GitRuntimeError::Service(
            crate::git_service::GitServiceError::Permission
        ))
    ));
    assert_eq!(repository.git_output(&["tag", "--list"]), "review");
}

#[test]
fn graph_comparisons_preserve_pagination_and_directory_read_authorization() {
    use ash_app_server_protocol::protocol::git::GitCommitFileContentDto;
    let repository = TestRepository::init();
    repository.write("scope/old.txt", "inside unchanged content\n");
    repository.write("outside.txt", "outside before\n");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "Base"]);
    let base = repository.git_output(&["rev-parse", "HEAD"]);
    repository.git(&["mv", "scope/old.txt", "scope/new.txt"]);
    repository.write("outside.txt", "outside after\n");
    repository.git(&["add", "."]);
    repository.git(&["commit", "-m", "Rename", "-m", "Complete body."]);
    let selected = repository.git_output(&["rev-parse", "HEAD"]);
    let runtime = GitRuntime::new(
        inspection_authorization(&repository.root().join("scope")),
        Arc::new(UpdateBroker::default()),
    )
    .unwrap();
    let page = runtime
        .graph(1, std::num::NonZeroUsize::new(1).unwrap(), None)
        .unwrap();
    let comparison = runtime
        .compare_changes_for(None, &selected, &base, ash_git::GitComparisonMode::Direct)
        .unwrap();
    assert_eq!(comparison.base_object_id, base);
    assert_eq!(comparison.changes.len(), 1);
    assert_eq!(comparison.changes[0].path, "new.txt");
    assert_eq!(
        comparison.changes[0].original_path.as_deref(),
        Some("old.txt")
    );
    let file = runtime
        .commit_file_for(None, &selected, Path::new("new.txt"), Some(&base))
        .unwrap();
    assert_eq!(
        file.original,
        GitCommitFileContentDto::Text {
            text: "inside unchanged content\n".into()
        }
    );
    assert_eq!(file.modified, file.original);
    assert!(
        runtime
            .commit_file_for(None, &selected, Path::new("../outside.txt"), Some(&base))
            .is_err()
    );
    assert_eq!(
        runtime.commit_message_for(None, &selected).unwrap(),
        "Rename\n\nComplete body."
    );
    let next = runtime
        .graph(
            1,
            std::num::NonZeroUsize::new(1).unwrap(),
            page.next_cursor.as_deref(),
        )
        .unwrap();
    assert_eq!(next.commits[0].object_id, base);
}
