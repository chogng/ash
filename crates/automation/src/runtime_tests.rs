use super::*;
use crate::AutomationWrite;

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
    let request: AutomationWrite = serde_json::from_value(serde_json::json!({
        "command_id":"create", "id":"follow-up", "expected_revision":0, "status":"enabled",
        "definition":{"title":"Follow PR", "prompt":"Fix CI", "directory":directory.path(),
            "session":{"type":"continue","sessionId":"session","threadId":"thread"},
            "schedule":{"type":"interval","anchor":current.get() + 3_600_000,"minutes":1},
            "condition":{"type":"gitHubChecks","host":"github.com","owner":"team","repository":"repo","number":7,
                "accountId":"account","credentialRevision":"1"}}
    })).unwrap();
    store.write(&request, current).unwrap();
    let run = store.run_now("follow-up", "check", current).unwrap();
    let executor = FailingAfterReservation(store.clone());
    tick(&store, &executor, current).unwrap();
    let saved = store.get_run(&run.id).unwrap();
    assert_eq!(saved.event.as_ref().unwrap().key, "head-a");
    assert_eq!(
        saved.message.as_deref(),
        Some("execution owner temporarily unavailable")
    );
    tick(&store, &executor, current).unwrap();
    assert_eq!(store.get_run(&run.id).unwrap(), saved);
}
