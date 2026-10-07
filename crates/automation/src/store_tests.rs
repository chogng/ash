use super::*;
use ash_protocol::AutomationSession;

fn time(value: u64) -> UnixMillis {
    UnixMillis::new(value).unwrap()
}

fn request(directory: &Path) -> AutomationWrite {
    AutomationWrite {
        command_id: "create".into(),
        id: "daily".into(),
        expected_revision: 0,
        status: AutomationStatus::Enabled,
        definition: AutomationDefinition {
            title: "Check build".into(),
            prompt: "Inspect the build".into(),
            directory: directory.to_string_lossy().into_owned(),
            session: AutomationSession::New,
            schedule: AutomationSchedule::Interval {
                anchor: time(60_000),
                minutes: 1,
            },
        },
    }
}

#[test]
fn writes_replay_exactly_and_reject_conflicting_commands_and_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    let mut request = request(dir.path());
    let original = store.write(&request, time(0)).unwrap();
    assert_eq!(store.write(&request, time(50_000)).unwrap(), original);
    request.definition.title = "Changed".into();
    assert!(matches!(
        store.write(&request, time(0)),
        Err(AutomationError::CommandConflict)
    ));
    request.command_id = "edit".into();
    assert!(matches!(
        store.write(&request, time(0)),
        Err(AutomationError::Conflict)
    ));
    request.expected_revision = original.revision;
    assert_eq!(store.write(&request, time(0)).unwrap().revision, 2);
}

#[test]
fn due_run_and_next_occurrence_survive_reopening_without_duplicate_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = AutomationStore::open(&path).unwrap();
    store.write(&request(dir.path()), time(0)).unwrap();
    store.poll(time(59_000), time(60_000)).unwrap();
    let runs = store.active_runs().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(store.list().unwrap()[0].next_run_at, Some(time(120_000)));
    drop(store);
    let reopened = AutomationStore::open(&path).unwrap();
    reopened.poll(time(60_000), time(60_000)).unwrap();
    assert_eq!(reopened.active_runs().unwrap(), runs);
    assert_eq!(reopened.runs("daily", 100).unwrap().len(), 1);
}

#[test]
fn overlapping_and_missed_repetitions_are_recorded_without_starting_more_runs() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    store.write(&request(dir.path()), time(0)).unwrap();
    store.poll(time(59_000), time(60_000)).unwrap();
    store.poll(time(119_000), time(120_000)).unwrap();
    assert_eq!(store.active_runs().unwrap().len(), 1);
    assert_eq!(
        store.runs("daily", 100).unwrap()[0].status,
        AutomationRunStatus::Skipped
    );
    let mut run = store.active_runs().unwrap().remove(0);
    run.status = AutomationRunStatus::Completed;
    run.finished_at = Some(time(120_000));
    store.observe(&run).unwrap();
    store.poll(time(600_000), time(600_000)).unwrap();
    assert!(store.active_runs().unwrap().is_empty());
    assert_eq!(store.list().unwrap()[0].next_run_at, Some(time(660_000)));
}

#[test]
fn overdue_once_runs_after_restart_and_does_not_repeat() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    let mut request = request(dir.path());
    request.definition.schedule = AutomationSchedule::Once { at: time(60_000) };
    store.write(&request, time(0)).unwrap();
    store.poll(time(600_000), time(600_000)).unwrap();
    assert_eq!(store.active_runs().unwrap().len(), 1);
    assert_eq!(store.list().unwrap()[0].next_run_at, None);
    store.poll(time(600_000), time(700_000)).unwrap();
    assert_eq!(store.runs("daily", 100).unwrap().len(), 1);
}

#[test]
fn manual_run_replays_and_keeps_the_schedule_while_stop_survives_observation_races() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    let plan = store.write(&request(dir.path()), time(0)).unwrap();
    let run = store.run_now(&plan.id, "manual", time(1_000)).unwrap();
    assert_eq!(store.run_now(&plan.id, "manual", time(2_000)).unwrap(), run);
    assert!(matches!(
        store.run_now(&plan.id, "another", time(2_000)),
        Err(AutomationError::Busy)
    ));
    assert_eq!(store.list().unwrap()[0], plan);
    store.stop_run(&run.id).unwrap();
    let mut observed = run;
    observed.status = AutomationRunStatus::Running;
    store.observe(&observed).unwrap();
    assert_eq!(
        store.active_runs().unwrap()[0].status,
        AutomationRunStatus::Stopping
    );
    observed.status = AutomationRunStatus::Stopped;
    observed.finished_at = Some(time(3_000));
    store.observe(&observed).unwrap();
    assert!(store.active_runs().unwrap().is_empty());
}

#[test]
fn paused_plans_do_not_fire_and_deleted_identities_cannot_be_reused() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    let mut request = request(dir.path());
    request.status = AutomationStatus::Paused;
    store.write(&request, time(0)).unwrap();
    store.poll(time(59_000), time(60_000)).unwrap();
    assert!(!store.needs_host().unwrap());
    store.delete(&request.id, 1).unwrap();
    store.delete(&request.id, 1).unwrap();
    request.command_id = "recreate".into();
    assert!(matches!(
        store.write(&request, time(0)),
        Err(AutomationError::Conflict)
    ));
}

#[test]
fn persisted_rules_are_validated_before_they_can_be_dispatched() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    let plan = store.write(&request(dir.path()), time(0)).unwrap();
    let mut record = serde_json::to_value(plan).unwrap();
    record["definition"]["schedule"]["minutes"] = serde_json::json!(0);
    store
        .connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE automation_plans SET record = ?1",
            [record.to_string()],
        )
        .unwrap();
    assert!(matches!(store.list(), Err(AutomationError::Invalid(_))));
    assert!(matches!(
        store.poll(time(0), time(60_000)),
        Err(AutomationError::Invalid(_))
    ));
    assert!(store.active_runs().unwrap().is_empty());
}
