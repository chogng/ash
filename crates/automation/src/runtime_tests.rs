use super::*;
use crate::AutomationWrite;
use std::path::Path;
use std::sync::Mutex;

fn plan(directory: &Path, id: &str, anchor: u64) -> AutomationWrite {
    serde_json::from_value(serde_json::json!({
        "command_id":format!("create-{id}"), "id":id, "expected_revision":0, "status":"enabled",
        "definition":{"title":"Scheduled automation", "prompt":"Inspect the build", "directory":directory,
            "session":{"type":"continue","sessionId":"session","threadId":"thread"},
            "schedule":{"type":"interval","anchor":anchor,"minutes":1}}
    })).unwrap()
}

fn pr_plan(directory: &Path, anchor: u64) -> AutomationWrite {
    let mut request = plan(directory, "follow-up", anchor);
    request.definition.condition = Some(
        serde_json::from_value(serde_json::json!({
            "type":"gitHubChecks","host":"github.com","owner":"team","repository":"repo","number":7,
            "accountId":"account","credentialRevision":"1"
        }))
        .unwrap(),
    );
    request
}

struct FailingAfterReservation(Arc<AutomationStore>);
impl AutomationExecutor for FailingAfterReservation {
    fn advance(&self, run: &AutomationRun, _: UnixMillis) -> Result<AutomationRun, String> {
        self.0
            .claim_event(
                &run.id,
                ash_protocol::AutomationEvent {
                    key: "head-a".into(),
                    context: "diagnostics".into(),
                },
            )
            .unwrap();
        Err("execution owner temporarily unavailable".into())
    }
    fn changed(&self) {}
    fn report_error(&self, _: &str) {}
}

#[test]
fn an_execution_error_after_reservation_preserves_the_durable_event_for_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&directory.path().join("automation.db")).unwrap());
    let current = now().unwrap();
    let request = pr_plan(directory.path(), current.get() + 3_600_000);
    store.write(&request, current).unwrap();
    let run = store.run_now("follow-up", "check", current).unwrap();
    let executor = FailingAfterReservation(store.clone());
    advance(&store, &executor, &run, current).unwrap();
    let saved = store.get_run(&run.id).unwrap();
    assert_eq!(saved.event.as_ref().unwrap().key, "head-a");
    assert_eq!(
        saved.message.as_deref(),
        Some("execution owner temporarily unavailable")
    );
    advance(&store, &executor, &saved, current).unwrap();
    assert_eq!(store.get_run(&run.id).unwrap(), saved);
}

struct BlockingCheck {
    started: mpsc::Sender<String>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl AutomationExecutor for BlockingCheck {
    fn advance(&self, run: &AutomationRun, now: UnixMillis) -> Result<AutomationRun, String> {
        self.started.send(run.automation_id.clone()).unwrap();
        if run.definition.condition.is_some() {
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15));
        }
        let mut observed = run.clone();
        observed.status = ash_protocol::AutomationRunStatus::Completed;
        observed.finished_at = Some(now);
        Ok(observed)
    }

    fn changed(&self) {}
    fn report_error(&self, _: &str) {}
}

#[test]
fn pending_pr_check_does_not_block_a_periodic_run() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&directory.path().join("automation.db")).unwrap());
    let current = now().unwrap();
    store
        .write(
            &pr_plan(directory.path(), current.get() + 3_600_000),
            current,
        )
        .unwrap();
    store.run_now("follow-up", "check", current).unwrap();
    let (started, events) = mpsc::channel();
    let (release_check, release) = mpsc::channel();
    let runtime = AutomationRuntime::start(
        store.clone(),
        Arc::new(BlockingCheck {
            started,
            release: Mutex::new(release),
        }),
    )
    .unwrap();

    assert_eq!(
        events.recv_timeout(Duration::from_secs(5)).unwrap(),
        "follow-up"
    );
    let current = now().unwrap();
    store
        .write(
            &plan(directory.path(), "periodic", current.get() + 1),
            current,
        )
        .unwrap();
    let second = events.recv_timeout(Duration::from_secs(5));
    drop(release_check);
    drop(runtime);

    assert_eq!(second.unwrap(), "periodic");
    let runs = store.runs("periodic", 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, ash_protocol::AutomationRunStatus::Completed);
}

#[test]
fn only_idle_time_can_turn_due_occurrences_into_missed_runs() {
    let directory = tempfile::tempdir().unwrap();
    let timestamp = |value| UnixMillis::new(value).unwrap();
    for (idle_since, status) in [
        (64_000, ash_protocol::AutomationRunStatus::Pending),
        (1_000, ash_protocol::AutomationRunStatus::Skipped),
    ] {
        let store =
            AutomationStore::open(&directory.path().join(format!("{idle_since}.db"))).unwrap();
        let mut last_checked = timestamp(1_000);
        store
            .write(&plan(directory.path(), "periodic", 60_000), last_checked)
            .unwrap();

        let current = timestamp(65_000);
        assert!(poll_due(&store, &mut last_checked, timestamp(idle_since), current).unwrap());
        assert_eq!(last_checked, current);
        let runs = store.runs("periodic", 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, status);
    }
}
