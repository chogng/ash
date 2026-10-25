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
            condition: None,
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
fn active_runs_remain_visible_after_skipped_runs_fill_the_history_page() {
    let dir = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
    store.write(&request(dir.path()), time(0)).unwrap();
    store.poll(time(59_000), time(60_000)).unwrap();
    let mut active = store.active_runs().unwrap().remove(0);
    for minute in 2..=52 {
        store
            .poll(time(minute * 60_000 - 1), time(minute * 60_000))
            .unwrap();
    }
    for status in [
        AutomationRunStatus::Pending,
        AutomationRunStatus::Running,
        AutomationRunStatus::NeedsInput,
        AutomationRunStatus::Stopping,
    ] {
        active.status = status;
        store.observe(&active).unwrap();
        let page = store.runs("daily", 50).unwrap();
        assert_eq!(page.len(), 51);
        assert_eq!(page.last(), Some(&active));
        assert!(
            page[..50]
                .iter()
                .all(|run| { run.status == AutomationRunStatus::Skipped && run.id != active.id })
        );
    }
    active.status = AutomationRunStatus::Stopped;
    active.finished_at = Some(time(53 * 60_000));
    store.observe(&active).unwrap();
    let page = store.runs("daily", 50).unwrap();
    assert_eq!(page.len(), 50);
    assert!(page.iter().all(|run| run.id != active.id));
    assert_eq!(store.get_run(&active.id).unwrap(), active);
    assert!(store.active_runs().unwrap().is_empty());
    assert!(matches!(
        store.get_run("missing"),
        Err(AutomationError::NotFound)
    ));
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

fn follow_up(directory: &Path) -> AutomationWrite {
    let mut request = request(directory);
    request.definition.session = AutomationSession::Continue {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
    };
    request.definition.condition = Some(ash_protocol::AutomationCondition::GitHubChecks {
        host: "github.com".into(),
        owner: "team".into(),
        repository: "repo".into(),
        number: 7,
        account_id: "account".into(),
        credential_revision: "1".into(),
    });
    request
}

#[test]
fn provider_events_survive_restart_and_deduplicate_across_plans_and_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("automation.db");
    let event = ash_protocol::AutomationEvent {
        key: "pr-head-a".into(),
        context: "diagnostics".into(),
    };
    let store = AutomationStore::open(&path).unwrap();
    let mut request = follow_up(directory.path());
    let plan = store.write(&request, time(0)).unwrap();
    let run = store.run_now(&plan.id, "first", time(1)).unwrap();
    assert!(store.claim_event(&run.id, event.clone()).unwrap());
    drop(store);
    let store = AutomationStore::open(&path).unwrap();
    assert_eq!(store.get_run(&run.id).unwrap().event, Some(event.clone()));
    assert!(store.claim_event(&run.id, event.clone()).unwrap());
    let mut settled = store.get_run(&run.id).unwrap();
    settled.status = AutomationRunStatus::Completed;
    settled.finished_at = Some(time(2));
    store.observe(&settled).unwrap();
    request.command_id = "second-plan".into();
    request.id = "other-window".into();
    store.write(&request, time(3)).unwrap();
    let duplicate = store.run_now(&request.id, "second", time(3)).unwrap();
    assert!(!store.claim_event(&duplicate.id, event.clone()).unwrap());
    request.id = plan.id.clone();
    request.command_id = "edit-plan".into();
    request.expected_revision = plan.revision;
    store.write(&request, time(3)).unwrap();
    let edited = store.run_now(&plan.id, "edited", time(4)).unwrap();
    assert!(!store.claim_event(&edited.id, event).unwrap());
    assert!(
        store
            .claim_event(
                &edited.id,
                ash_protocol::AutomationEvent {
                    key: "pr-head-b".into(),
                    context: "new diagnostics".into(),
                }
            )
            .unwrap()
    );
}

#[test]
fn stopping_or_pausing_fences_dispatch_even_after_an_event_was_reserved() {
    for pause in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(&directory.path().join("automation.db")).unwrap();
        let mut request = follow_up(directory.path());
        let plan = store.write(&request, time(0)).unwrap();
        let run = store.run_now(&plan.id, "run", time(1)).unwrap();
        assert!(
            store
                .claim_event(
                    &run.id,
                    ash_protocol::AutomationEvent {
                        key: "pr-head".into(),
                        context: "diagnostics".into(),
                    }
                )
                .unwrap()
        );
        if pause {
            request.expected_revision = plan.revision;
            request.command_id = "pause".into();
            request.status = AutomationStatus::Paused;
            store.write(&request, time(2)).unwrap();
        } else {
            store.stop_run(&run.id).unwrap();
        }
        assert_eq!(
            store.get_run(&run.id).unwrap().status,
            AutomationRunStatus::Stopping
        );
        assert_eq!(
            store
                .dispatch_if_current(&run.id, || panic!("revoked dispatch"))
                .unwrap(),
            None::<()>
        );
        assert!(
            !store
                .claim_event(
                    &run.id,
                    ash_protocol::AutomationEvent {
                        key: "another-head".into(),
                        context: "late observation".into(),
                    }
                )
                .unwrap()
        );
    }
}

#[test]
fn older_clients_cannot_turn_a_conditional_plan_into_an_unconditional_schedule() {
    let directory = tempfile::tempdir().unwrap();
    let store = AutomationStore::open(&directory.path().join("automation.db")).unwrap();
    let mut request = follow_up(directory.path());
    let plan = store.write(&request, time(0)).unwrap();
    request.command_id = "old-client-edit".into();
    request.expected_revision = plan.revision;
    request.definition.condition = None;
    assert!(matches!(
        store.write(&request, time(1)),
        Err(AutomationError::Invalid(_))
    ));
    assert_eq!(store.list().unwrap(), [plan]);
}
