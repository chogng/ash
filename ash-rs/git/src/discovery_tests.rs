use super::*;
use crate::GitClient;
use crate::GitError;
use crate::test_support::TestRepository;
use futures::poll;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::task::Poll;
use std::time::Duration;
use tokio::sync::oneshot;

fn key(directory: &std::path::Path) -> Key {
    Key {
        cwd: directory.to_path_buf(),
        executable: GitClient::system().executable().unwrap(),
        search_path: None,
        limits: GitExecutionLimits::default(),
    }
}

fn probe(
    directory: &std::path::Path,
    started: &Arc<AtomicUsize>,
) -> (
    impl Future<Output = GitResult<GitCommandOutput>> + Send + 'static,
    oneshot::Sender<()>,
) {
    let started = started.clone();
    let directory = directory.to_path_buf();
    let (release, ready) = oneshot::channel();
    (
        async move {
            started.fetch_add(1, Ordering::SeqCst);
            ready.await.unwrap();
            GitClient::system()
                .run_query_unchecked(&directory, ["rev-parse", "--show-toplevel"])
                .await
        },
        release,
    )
}

#[tokio::test]
async fn duplicate_callers_share_one_probe_and_next_call_runs_again() {
    let repository = TestRepository::init();
    let directory = repository.root();
    let coordinator = Coordinator::new(2);
    let started = Arc::new(AtomicUsize::new(0));
    let (work, release) = probe(directory, &started);
    let first = coordinator.query(key(directory), work);
    let mut callers = vec![first];
    for _ in 1..32 {
        let (work, _) = probe(directory, &started);
        callers.push(coordinator.query(key(directory), work));
    }
    for caller in &mut callers {
        assert!(poll!(caller).is_pending());
    }
    assert_eq!(started.load(Ordering::SeqCst), 1);
    // Cancelling the original caller leaves the shared process owned by the others.
    drop(callers.remove(0));
    release.send(()).unwrap();
    let outputs = futures::future::join_all(callers).await;
    assert!(
        outputs
            .iter()
            .all(|output| output.as_ref().unwrap().status.success())
    );
    assert!(
        outputs
            .windows(2)
            .all(|pair| pair[0].as_ref().unwrap().stdout == pair[1].as_ref().unwrap().stdout)
    );
    assert!(coordinator.pending.lock().unwrap().is_empty());
    let (work, release) = probe(directory, &started);
    release.send(()).unwrap();
    coordinator.query(key(directory), work).await.unwrap();
    assert_eq!(started.load(Ordering::SeqCst), 2);
    println!("32 overlapping repository requests -> 1 probe; a later request -> a new probe");
}

#[tokio::test]
async fn concurrency_is_bounded_and_last_cancellation_releases_its_slot() {
    let directory = tempfile::tempdir().unwrap();
    let coordinator = Coordinator::new(2);
    let started = Arc::new(AtomicUsize::new(0));
    let mut calls = Vec::new();
    let mut releases = Vec::new();
    for number in 0..6 {
        let path = directory.path().join(number.to_string());
        std::fs::create_dir(&path).unwrap();
        let (work, release) = probe(&path, &started);
        calls.push(coordinator.query(key(&path), work));
        releases.push(release);
    }
    for call in &mut calls {
        assert!(poll!(call).is_pending());
    }
    assert_eq!(started.load(Ordering::SeqCst), 2);
    drop(calls.remove(0));
    assert!(poll!(&mut calls[1]).is_pending());
    assert_eq!(started.load(Ordering::SeqCst), 3);
    drop(calls);
    assert!(coordinator.pending.lock().unwrap().is_empty());
    assert_eq!(coordinator.permits.available_permits(), 2);
    assert!(
        releases
            .into_iter()
            .all(|release| release.send(()).is_err())
    );
}

#[tokio::test]
async fn failures_are_shared_without_changing_the_error_source() {
    let directory = tempfile::tempdir().unwrap();
    let coordinator = Coordinator::new(1);
    let error = GitError::io("probe", std::io::Error::from_raw_os_error(5));
    let shared = coordinator.query(key(directory.path()), async move { Err(error) });
    let (first, second) = tokio::join!(shared.clone(), shared);
    let (Err(GitError::Io { source: first, .. }), Err(GitError::Io { source: second, .. })) =
        (first, second)
    else {
        panic!("typed I/O errors");
    };
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(first.raw_os_error(), Some(5));
    assert!(coordinator.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn differing_executable_environment_and_limits_are_not_combined() {
    let directory = tempfile::tempdir().unwrap();
    let coordinator = Coordinator::new(4);
    let started = Arc::new(AtomicUsize::new(0));
    let mut keys = vec![key(directory.path()); 4];
    keys[1].executable = directory.path().join("other-git");
    keys[2].search_path = Some("other-search-path".into());
    keys[3].limits =
        GitExecutionLimits::new(Duration::from_secs(1), Duration::from_secs(2), 1024).unwrap();
    let mut calls = Vec::new();
    let mut releases = Vec::new();
    for key in keys {
        let (work, release) = probe(directory.path(), &started);
        calls.push(coordinator.query(key, work));
        releases.push(release);
    }
    for call in &mut calls {
        assert!(matches!(poll!(call), Poll::Pending));
    }
    assert_eq!(started.load(Ordering::SeqCst), 4);
    drop(calls);
    assert!(coordinator.pending.lock().unwrap().is_empty());
}
