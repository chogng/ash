use super::*;
use tokio::time::timeout;

fn roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/workspace")]
}

#[tokio::test]
async fn slow_consumer_has_bounded_paths_and_a_scoped_rescan() {
    let (tx, mut rx) = watch_channel();
    for index in 0..100_000 {
        tx.add_changed_paths(&[PathBuf::from(format!("/workspace/{index}"))], roots)
            .await;
        if let PendingEvent::Paths(batch) = &*tx.inner.pending.lock().await {
            assert!(batch.paths.len() <= MAX_PENDING_PATHS);
            assert!(batch.bytes <= MAX_PENDING_BYTES);
        }
    }
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: roots()
        })
    );
    // A change arriving after delivery must survive even if the consumer is scanning.
    tx.add_changed_paths(&[PathBuf::from("/workspace/final")], roots)
        .await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged {
            paths: vec![PathBuf::from("/workspace/final")]
        })
    );
}

#[tokio::test]
async fn path_byte_budget_and_root_churn_do_not_retain_event_history() {
    let (tx, mut rx) = watch_channel();
    tx.add_changed_paths(&[PathBuf::from("x".repeat(MAX_PENDING_BYTES + 1))], roots)
        .await;
    for index in 0..10_000 {
        tx.require_rescan(&[PathBuf::from(format!("/current-root-{index}"))])
            .await;
    }
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: vec![PathBuf::from("/current-root-9999")]
        })
    );
    drop(tx);
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn debouncer_keeps_one_bounded_accumulator_and_cancellation_deadline() {
    let (tx, rx) = watch_channel();
    let mut rx = DebouncedWatchReceiver::new(rx, Duration::from_millis(50));
    tx.add_changed_paths(&[PathBuf::from("/workspace/first")], roots)
        .await;
    assert!(timeout(Duration::from_millis(10), rx.recv()).await.is_err());
    let deadline = rx.deadline.unwrap();
    for index in 0..20_000 {
        tx.add_changed_paths(&[PathBuf::from(format!("/workspace/{index}"))], roots)
            .await;
    }
    assert_eq!(rx.deadline, Some(deadline));
    drop(tx);
    assert_eq!(
        timeout(Duration::from_secs(2), rx.recv()).await.unwrap(),
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: roots()
        })
    );
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn repeated_scans_are_rate_limited_without_losing_last_invalidation() {
    let (tx, mut rx) = watch_channel();
    tx.require_rescan(&roots()).await;
    rx.recv().await.unwrap();
    let start = Instant::now();
    for _ in 0..1000 {
        tx.require_rescan(&roots()).await;
    }
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());
    tx.add_changed_paths(&[PathBuf::from("/workspace/last-write")], roots)
        .await;
    drop(tx);
    assert_eq!(
        timeout(Duration::from_secs(2), rx.recv()).await.unwrap(),
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: roots()
        })
    );
    assert!(start.elapsed() >= RESCAN_INTERVAL - Duration::from_millis(20));
    assert_eq!(rx.recv().await, None);
}

#[tokio::test]
async fn rescan_cooldown_retains_new_writes_then_becomes_quiet() {
    let (tx, mut rx) = watch_channel();
    tx.require_rescan(&roots()).await;
    rx.recv().await.unwrap();
    tx.require_rescan(&roots()).await;
    // Cancel a pending receive while the second rescan is cooling down.
    assert!(timeout(Duration::from_millis(10), rx.recv()).await.is_err());
    let during = PathBuf::from("/workspace/during-cooldown");
    tx.add_changed_paths(&[during], roots).await;
    assert_eq!(
        timeout(Duration::from_secs(2), rx.recv()).await.unwrap(),
        Some(FileWatcherEvent::RescanRequired {
            watched_paths: roots()
        })
    );
    // Once the scan hint is taken, a concurrent writer needs its own invalidation.
    let after = PathBuf::from("/workspace/during-scan");
    tx.add_changed_paths(std::slice::from_ref(&after), roots)
        .await;
    assert_eq!(
        rx.recv().await,
        Some(FileWatcherEvent::PathsChanged { paths: vec![after] })
    );
    assert!(
        timeout(RESCAN_INTERVAL + Duration::from_millis(25), rx.recv())
            .await
            .is_err(),
        "an expired cooldown must not generate a rescan without another change"
    );
}
