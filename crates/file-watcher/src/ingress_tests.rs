use super::*;
use notify::event::CreateKind;
use tokio::time::timeout;

fn change(path: impl Into<PathBuf>) -> notify::Result<Event> {
    Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(path.into()))
}

#[tokio::test]
async fn saturated_ingress_coalesces_and_delivers_changes_after_recovery() {
    let (tx, mut rx) = event_channel();
    for index in 0..100_000 {
        tx.send(change(format!("/workspace/generated/{index}")))
            .unwrap();
        let pending = tx.0.pending.lock().unwrap();
        assert!(pending.events.len() <= MAX_EVENTS);
        assert!(pending.paths <= MAX_PATHS);
        assert!(pending.bytes <= MAX_BYTES);
    }
    {
        let pending = tx.0.pending.lock().unwrap();
        assert!(pending.events.is_empty());
        assert_eq!(pending.bytes, 0);
    }
    assert!(rx.recv().await.unwrap().unwrap().need_rescan());
    tx.send(change("/workspace/final-state")).unwrap();
    assert_eq!(
        rx.recv().await.unwrap().unwrap().paths,
        vec![PathBuf::from("/workspace/final-state")]
    );
    drop(tx);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn event_byte_and_path_budgets_apply_before_retention() {
    let (tx, mut rx) = event_channel();
    tx.send(change("x".repeat(MAX_BYTES + 1))).unwrap();
    assert!(rx.recv().await.unwrap().unwrap().need_rescan());
    let (tx, mut rx) = event_channel();
    let mut event = Event::new(EventKind::Create(CreateKind::File));
    event.paths = (0..MAX_PATHS + 1)
        .map(|i| PathBuf::from(i.to_string()))
        .collect();
    tx.send(Ok(event)).unwrap();
    assert!(rx.recv().await.unwrap().unwrap().need_rescan());
}

#[tokio::test]
async fn rescan_storm_preserves_backend_recovery_and_deadline_on_cancel() {
    let (tx, mut rx) = event_channel();
    tx.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
        .unwrap();
    assert!(rx.recv().await.unwrap().unwrap().need_rescan());
    let start = Instant::now();
    for _ in 0..10_000 {
        tx.send(Err(notify::Error::generic("helper exited")))
            .unwrap();
        tx.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
            .unwrap();
    }
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());
    assert!(
        timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(start.elapsed() >= RESCAN_INTERVAL - Duration::from_millis(20));
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());
}

#[tokio::test]
async fn access_events_do_not_consume_budget_and_receiver_drop_releases_backlog() {
    let (tx, mut rx) = event_channel();
    for _ in 0..MAX_EVENTS * 2 {
        tx.send(Ok(Event::new(EventKind::Access(
            notify::event::AccessKind::Any,
        ))
        .add_path("ignored".into())))
            .unwrap();
    }
    assert!(timeout(Duration::from_millis(10), rx.recv()).await.is_err());
    tx.send(change("pending")).unwrap();
    drop(rx);
    assert!(tx.send(change("closed")).is_err());
    assert!(tx.0.pending.lock().unwrap().events.is_empty());
}

#[tokio::test]
async fn ready_ingress_yields_to_other_runtime_work() {
    let (tx, mut rx) = event_channel();
    for _ in 0..MAX_EVENTS {
        tx.send(change("/workspace/file")).unwrap();
    }
    let progressed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let progress = Arc::clone(&progressed);
    let worker = tokio::spawn(async move {
        progress.store(true, std::sync::atomic::Ordering::Release);
    });
    for _ in 0..MAX_EVENTS / 2 {
        rx.recv().await.unwrap().unwrap();
    }
    assert!(
        progressed.load(std::sync::atomic::Ordering::Acquire),
        "a ready queue starved another runnable task"
    );
    worker.await.unwrap();
}
