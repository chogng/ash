//! Exercises the product adapter against the actual SDK executable, not an in-process provider.
#[path = "../../../crates/app-server/src/git_service.rs"]
mod git_service;
#[path = "../../../crates/app-server/src/git_provider.rs"]
mod host;

use ash_app_server_protocol::git_provider::*;
use ash_app_server_protocol::protocol::git::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use host::GitProviderClient;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

// The recovery scenario counts this test process's executable children.
static PROCESS_TEST: Mutex<()> = Mutex::new(());

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
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn client(root: &Path, permission: Permission) -> (Arc<GitProviderClient>, Grant) {
    let grant = Grant::for_environment(
        Dir::open_local(root).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([permission]),
    );
    let client = GitProviderClient::open(
        env!("CARGO_BIN_EXE_ash-git-extension").into(),
        vec![(None, grant.authorize(permission).unwrap())],
    )
    .unwrap();
    (client, grant)
}
fn status(client: &GitProviderClient) -> GitStatusResult {
    let GitProviderResponse::Status(status) = client
        .call(
            GitProviderRequest::Status {
                repository_id: None,
            },
            None,
        )
        .unwrap()
    else {
        panic!("status expected")
    };
    status
}

#[test]
fn executable_keeps_history_pages_across_file_and_index_changes_and_observes_refs() {
    let _process = PROCESS_TEST.lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ash Test"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    for message in ["first", "second", "third", "fourth"] {
        std::fs::write(root.join("tracked.txt"), message).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["-c", "core.hooksPath=", "commit", "-m", message]);
    }
    let (provider, _grant) = client(&root, Permission::MutateRepository);
    let initial = status(&provider);
    let graph = |cursor: Option<String>| {
        let GitProviderResponse::Graph(page) = provider
            .call(
                GitProviderRequest::Graph {
                    repository_id: None,
                    connection_id: 1,
                    limit: std::num::NonZeroUsize::new(1).unwrap(),
                    cursor,
                },
                None,
            )
            .unwrap()
        else {
            panic!("graph expected")
        };
        page
    };
    let mut page = graph(None);
    std::fs::write(root.join("tracked.txt"), "worktree edit\n").unwrap();
    let edited = status(&provider);
    assert!(edited.revision > initial.revision);
    assert_eq!(edited.history_revision, initial.history_revision);
    page = graph(page.next_cursor);
    for request in [
        GitProviderRequest::Stage {
            repository_id: None,
            paths: vec!["tracked.txt".into()],
        },
        GitProviderRequest::Unstage {
            repository_id: None,
            paths: vec!["tracked.txt".into()],
        },
    ] {
        let GitProviderResponse::Status(changed) = provider.call(request, None).unwrap() else {
            panic!("status expected")
        };
        assert_eq!(changed.history_revision, initial.history_revision);
        assert_eq!(changed.head, initial.head);
        page = graph(page.next_cursor);
    }
    assert!(!page.has_more);
    let old_cursor = graph(None).next_cursor;
    git(&root, &["tag", "external-tag"]);
    let tagged = status(&provider);
    assert_eq!(tagged.head, initial.head);
    assert!(tagged.history_revision > initial.history_revision);
    let retained = match provider
        .call(
            GitProviderRequest::Graph {
                repository_id: None,
                connection_id: 1,
                limit: std::num::NonZeroUsize::new(1).unwrap(),
                cursor: old_cursor,
            },
            None,
        )
        .unwrap()
    {
        GitProviderResponse::Graph(page) => page,
        response => panic!("unexpected graph response: {response:?}"),
    };
    assert!(
        retained
            .references
            .iter()
            .any(|reference| reference.name == "external-tag")
    );
    assert!(
        graph(None)
            .references
            .iter()
            .any(|reference| reference.name == "external-tag")
    );
    provider.shutdown();
}

#[test]
fn executable_preserves_git_contracts_cancellation_recovery_and_revocation() {
    let _process = PROCESS_TEST.lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ash Test"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["-c", "core.hooksPath=", "commit", "-m", "initial"]);
    let (provider, grant) = client(&root, Permission::MutateRepository);
    let initial = status(&provider);
    let large = "modified\n".repeat(100_000);
    std::fs::write(root.join("tracked.txt"), &large).unwrap();
    let GitProviderResponse::ChangeFile(file) = provider
        .call(
            GitProviderRequest::ChangeFile {
                repository_id: None,
                path: "tracked.txt".into(),
                comparison: GitChangeFileComparisonDto::Unstaged,
            },
            None,
        )
        .unwrap()
    else {
        panic!("change file expected")
    };
    assert_eq!(file.modified, GitCommitFileContentDto::Text { text: large });
    assert!(
        provider
            .call(
                GitProviderRequest::Stage {
                    repository_id: None,
                    paths: vec!["../outside".into()],
                },
                None
            )
            .is_err()
    );
    provider
        .call(
            GitProviderRequest::Stage {
                repository_id: None,
                paths: vec!["tracked.txt".into()],
            },
            None,
        )
        .unwrap();
    let GitProviderResponse::Commit {
        object_id,
        status: committed,
    } = provider
        .call(
            GitProviderRequest::Commit {
                repository_id: None,
                request: ash_git::GitCommitRequest::new("through extension".into()).unwrap(),
            },
            None,
        )
        .unwrap()
    else {
        panic!("commit expected")
    };
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), object_id);
    assert!(committed.changes.is_empty());

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let repository = runtime
        .block_on(ash_git::GitClient::system().open_repository(&root))
        .unwrap();
    let lock = ash_git::repository_operation_lock(&repository);
    let held = lock.lock().unwrap();
    std::fs::write(root.join("cancelled.txt"), "not staged\n").unwrap();
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let invoking = provider.clone();
    let waiting = std::thread::spawn(move || {
        invoking.call(
            GitProviderRequest::Stage {
                repository_id: None,
                paths: vec!["cancelled.txt".into()],
            },
            Some(&token),
        )
    });
    std::thread::sleep(Duration::from_millis(100));
    cancellation.cancel();
    assert!(matches!(
        waiting.join().unwrap(),
        Err(GitProviderError::Cancelled)
    ));
    drop(held);
    assert!(git(&root, &["diff", "--cached", "--name-only"]).is_empty());

    provider
        .call(
            GitProviderRequest::StartWatching {
                policy: GitProviderPolicy {
                    autofetch: GitProviderFetch::Off,
                    autofetch_period: 180,
                },
            },
            None,
        )
        .unwrap();
    std::fs::write(root.join("observed.txt"), "watch event\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let GitProviderResponse::Events(events) = provider
            .call(GitProviderRequest::DrainEvents, None)
            .unwrap()
        else {
            panic!("events expected")
        };
        if events.iter().any(|event| matches!(event, GitProviderEvent::StatusChanged(status) if status.changes.iter().any(|change| change.path == "observed.txt"))) { break; }
        assert!(
            Instant::now() < deadline,
            "file watcher did not publish through the channel"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    let GitProviderResponse::Graph(graph) = provider
        .call(
            GitProviderRequest::Graph {
                repository_id: None,
                connection_id: 1,
                limit: std::num::NonZeroUsize::new(1).unwrap(),
                cursor: None,
            },
            None,
        )
        .unwrap()
    else {
        panic!("graph expected")
    };
    let system = sysinfo::System::new_all();
    let processes: Vec<_> = system
        .processes()
        .values()
        .filter(|process| {
            process.parent() == Some(sysinfo::Pid::from_u32(std::process::id()))
                && process
                    .exe()
                    .is_some_and(|path| path == Path::new(env!("CARGO_BIN_EXE_ash-git-extension")))
        })
        .collect();
    assert_eq!(processes.len(), 1);
    assert!(processes[0].kill());
    let deadline = Instant::now() + Duration::from_secs(5);
    let recovered = loop {
        if let Ok(GitProviderResponse::Status(status)) = provider.call(
            GitProviderRequest::Status {
                repository_id: None,
            },
            None,
        ) {
            break status;
        }
        assert!(Instant::now() < deadline, "provider did not recover");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_ne!(initial.stream_instance_id, recovered.stream_instance_id);
    assert!(matches!(
        provider.call(
            GitProviderRequest::Graph {
                repository_id: None,
                connection_id: 1,
                limit: std::num::NonZeroUsize::new(1).unwrap(),
                cursor: graph.next_cursor,
            },
            None
        ),
        Err(GitProviderError::InvalidGraphCursor)
    ));
    let held = lock.lock().unwrap();
    let invoking = provider.clone();
    let waiting = std::thread::spawn(move || {
        invoking.call(
            GitProviderRequest::Stage {
                repository_id: None,
                paths: vec!["observed.txt".into()],
            },
            None,
        )
    });
    std::thread::sleep(Duration::from_millis(100));
    grant.revoke();
    assert!(matches!(
        waiting.join().unwrap(),
        Err(GitProviderError::Unavailable)
    ));
    drop(held);
    assert!(git(&root, &["diff", "--cached", "--name-only"]).is_empty());
    assert!(matches!(
        provider.call(
            GitProviderRequest::Status {
                repository_id: None
            },
            None
        ),
        Err(GitProviderError::Unavailable)
    ));
    provider.shutdown();
    assert!(matches!(
        provider.call(GitProviderRequest::Repositories, None),
        Err(GitProviderError::Unavailable)
    ));
    drop(provider);
    let (reader, _) = client(&root, Permission::InspectRepository);
    assert!(!status(&reader).changes.is_empty());
    assert!(matches!(
        reader.call(
            GitProviderRequest::Stage {
                repository_id: None,
                paths: vec!["observed.txt".into()]
            },
            None
        ),
        Err(GitProviderError::Unavailable)
    ));
    reader.shutdown();
}

#[test]
fn product_resolution_and_error_adapter_preserve_unavailable_and_cancellation() {
    if let Some(layout) = ash_install_context::InstallContext::current().package_layout() {
        assert!(
            host::product_executable()
                .unwrap()
                .starts_with(layout.binary_directory())
        );
    } else if std::env::var_os("ASH_GIT_EXTENSION_BIN").is_none() {
        assert!(host::product_executable().is_err());
    }
    match host::service_error(GitProviderError::IndexChanged) {
        git_service::GitServiceError::Git(error) => {
            assert!(matches!(error, ash_git::GitError::IndexChanged))
        }
        _ => panic!("index error changed"),
    }
    let source = CancellationSource::new();
    source.cancel();
    assert!(matches!(
        git_service::lock_for_request(&std::sync::Mutex::new(()), &source.token()),
        Err(git_service::GitServiceError::Cancelled)
    ));
}
