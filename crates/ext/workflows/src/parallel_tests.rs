use super::*;
use crate::Store;
use protocol::CommandId;
use protocol::SessionId;

fn oid(digit: char) -> String {
    std::iter::repeat_n(digit, 40).collect()
}

fn digest(digit: char) -> String {
    format!(
        "sha256:{}",
        std::iter::repeat_n(digit, 64).collect::<String>()
    )
}

fn check_plan() -> CheckPlan {
    CheckPlan {
        key: "unit".into(),
        program: "cargo".into(),
        arguments: vec!["test".into(), "-p".into(), "ash-workflows".into()],
        working_directory: String::new(),
        timeout_ms: 60_000,
        environment_digest: digest('d'),
        required: true,
    }
}

fn definitions() -> Vec<ParallelTaskDefinition> {
    vec![
        ParallelTaskDefinition {
            id: "task-a".into(),
            goal: "Implement part A".into(),
            allowed_paths: vec!["src/a.rs".into()],
            dependencies: vec![],
            checks: vec![check_plan()],
        },
        ParallelTaskDefinition {
            id: "task-b".into(),
            goal: "Implement part B".into(),
            allowed_paths: vec!["src/b.rs".into()],
            dependencies: vec![],
            checks: vec![check_plan()],
        },
    ]
}

fn development() -> ParallelDevelopment {
    ParallelDevelopment::new(
        "run-1".into(),
        "Implement two independent changes".into(),
        oid('a'),
        ParallelTarget {
            remote: "origin".into(),
            reference: "main".into(),
            expected_oid: oid('b'),
        },
        definitions(),
    )
    .unwrap()
}

fn worker(thread: &str, turn: &str, delegation: &str) -> WorkerAttempt {
    WorkerAttempt {
        delegation_id: DelegationId::new(delegation).unwrap(),
        thread_id: ThreadId::new(thread).unwrap(),
        turn_id: TurnId::new(turn).unwrap(),
        status: WorkerStatus::Running,
    }
}

fn snapshot(
    id: &str,
    digest_digit: char,
    thread: &str,
    turn: &str,
    tree_digit: char,
) -> ReviewSnapshot {
    ReviewSnapshot {
        snapshot_id: id.into(),
        digest: digest(digest_digit),
        base_tree: oid('a'),
        candidate_tree: oid(tree_digit),
        source_thread: ThreadId::new(thread).unwrap(),
        source_turn: TurnId::new(turn).unwrap(),
        source_sequence: 7,
        changed_paths: vec![
            if id.starts_with("snapshot-a") {
                "src/a.rs"
            } else {
                "src/b.rs"
            }
            .into(),
        ],
    }
}

fn approved_review(snapshot_id: &str, digest_digit: char) -> ReviewVerdict {
    ReviewVerdict {
        review_id: format!("review-{snapshot_id}"),
        snapshot_id: snapshot_id.into(),
        snapshot_digest: digest(digest_digit),
        reviewer_thread: ThreadId::new("reviewer-a").unwrap(),
        reviewer_turn: TurnId::new("review-turn-a").unwrap(),
        decision: ReviewDecision::Approved,
        findings: vec![],
    }
}

fn passing_check(id: &str, snapshot_id: &str, digest_digit: char) -> CheckEvidence {
    CheckEvidence {
        check_id: id.into(),
        check_key: "unit".into(),
        snapshot_id: snapshot_id.into(),
        snapshot_digest: digest(digest_digit),
        command_digest: check_plan().digest().unwrap(),
        environment_digest: digest('d'),
        log_digest: Some(digest('e')),
        outcome: CheckOutcome::Passed,
        exit_code: Some(0),
        started_at_unix_ms: 10,
        finished_at_unix_ms: Some(20),
        source_before_digest: digest('f'),
        source_after_digest: digest('f'),
        output_truncated: false,
    }
}

fn prepare_task_a(development: &mut ParallelDevelopment) {
    development
        .start_worker("task-a", worker("worker-a", "turn-a", "delegation-a"))
        .unwrap();
    development
        .record_snapshot(
            "task-a",
            snapshot("snapshot-a", '1', "worker-a", "turn-a", 'c'),
        )
        .unwrap();
}

#[test]
fn a_late_snapshot_from_the_same_worker_cannot_replace_a_newer_candidate() {
    let mut development = development();
    prepare_task_a(&mut development);
    let mut late = snapshot("snapshot-a-late", '2', "worker-a", "turn-a", 'd');
    late.source_sequence = 6;
    assert!(development.record_snapshot("task-a", late).is_err());
    assert_eq!(
        development
            .task("task-a")
            .unwrap()
            .snapshots()
            .last()
            .unwrap()
            .snapshot_id,
        "snapshot-a"
    );
}

#[test]
fn immutable_binding_intent_is_durable_and_delegation_replay_is_exact() {
    let store = Store::in_memory().unwrap();
    let session = SessionId::new("parallel-session").unwrap();
    let root = ThreadId::new("parallel-root").unwrap();
    let delegation = DelegationId::new("parallel-run-worker-a").unwrap();
    let run = development();
    store
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start").unwrap(),
            run.clone(),
        )
        .unwrap();
    let intent = ParallelBindingIntent {
        run_id: run.run_id().into(),
        task_id: "task-a".into(),
        snapshot_id: "baseline".into(),
        snapshot_digest: run.baseline_digest().unwrap(),
        source_thread: root.clone(),
        target_oid: run.target().expected_oid.clone(),
        repository_trees: BTreeMap::from([(String::from("."), run.baseline_tree().into())]),
    };
    store
        .put_parallel_binding_intent(&session, &root, &delegation, &intent)
        .unwrap();
    store
        .put_parallel_binding_intent(&session, &root, &delegation, &intent)
        .unwrap();
    assert_eq!(
        store
            .read_parallel_binding_intent(&session, &root, &delegation)
            .unwrap(),
        Some(intent.clone())
    );

    let mut conflicting = intent;
    conflicting.snapshot_id = "other-snapshot".into();
    assert!(matches!(
        store.put_parallel_binding_intent(&session, &root, &delegation, &conflicting),
        Err(core_api::CoreError::Policy(_))
    ));
}

#[test]
fn dependent_worker_waits_for_accepted_prerequisite_and_new_attempt_is_running() {
    let mut dependent_definitions = definitions();
    dependent_definitions[1].dependencies = vec!["task-a".into()];
    dependent_definitions.push(ParallelTaskDefinition {
        id: "task-c".into(),
        goal: "Implement part C".into(),
        allowed_paths: vec!["src/c.rs".into()],
        dependencies: vec![],
        checks: vec![check_plan()],
    });
    let mut development = ParallelDevelopment::new(
        "run-1".into(),
        "Implement dependent work".into(),
        oid('a'),
        ParallelTarget {
            remote: "origin".into(),
            reference: "main".into(),
            expected_oid: oid('b'),
        },
        dependent_definitions,
    )
    .unwrap();
    assert!(
        development
            .start_worker("task-b", worker("worker-b", "turn-b", "delegation-b"),)
            .is_err()
    );
    let mut invalid_attempt = worker("worker-a", "turn-a", "delegation-a");
    invalid_attempt.status = WorkerStatus::Completed;
    assert!(development.start_worker("task-a", invalid_attempt).is_err());
}

#[test]
fn task_scopes_and_dependencies_are_validated_before_persisting_a_run() {
    let mut invalid_paths = definitions();
    invalid_paths[1].allowed_paths = vec!["src".into()];
    assert!(
        ParallelDevelopment::new(
            "run-1".into(),
            "goal".into(),
            oid('a'),
            ParallelTarget {
                remote: "origin".into(),
                reference: "main".into(),
                expected_oid: oid('b')
            },
            invalid_paths,
        )
        .is_err()
    );

    let mut cycle = definitions();
    cycle[0].dependencies = vec!["task-b".into()];
    assert!(
        ParallelDevelopment::new(
            "run-1".into(),
            "goal".into(),
            oid('a'),
            ParallelTarget {
                remote: "origin".into(),
                reference: "main".into(),
                expected_oid: oid('b')
            },
            cycle,
        )
        .is_err()
    );

    let mut sequential = definitions();
    sequential[1].dependencies = vec!["task-a".into()];
    assert!(
        ParallelDevelopment::new(
            "run-1".into(),
            "goal".into(),
            oid('a'),
            ParallelTarget {
                remote: "origin".into(),
                reference: "main".into(),
                expected_oid: oid('b')
            },
            sequential,
        )
        .is_err()
    );

    let mut traversal = definitions();
    traversal[0].allowed_paths = vec!["src/../outside".into()];
    assert!(
        ParallelDevelopment::new(
            "run-1".into(),
            "goal".into(),
            oid('a'),
            ParallelTarget {
                remote: "origin".into(),
                reference: "main".into(),
                expected_oid: oid('b')
            },
            traversal,
        )
        .is_err()
    );
    let mut drive_path = definitions();
    drive_path[0].allowed_paths = vec!["C:/outside.rs".into()];
    assert!(
        ParallelDevelopment::new(
            "run-1".into(),
            "goal".into(),
            oid('a'),
            ParallelTarget {
                remote: "origin".into(),
                reference: "main".into(),
                expected_oid: oid('b')
            },
            drive_path,
        )
        .is_err()
    );
}

#[test]
fn acceptance_requires_current_snapshot_review_and_complete_real_check_evidence() {
    let mut development = development();
    prepare_task_a(&mut development);
    let review = approved_review("snapshot-a", '1');
    assert!(development.record_review("task-a", review).unwrap());
    development
        .record_check("task-a", passing_check("check-a", "snapshot-a", '1'))
        .unwrap();
    development
        .finish_worker(
            "task-a",
            &ThreadId::new("worker-a").unwrap(),
            WorkerStatus::Completed,
        )
        .unwrap();
    let accepted = development
        .accept_task(
            "task-a",
            "snapshot-a",
            "review-snapshot-a",
            vec!["check-a".into()],
            "policy-7".into(),
            30,
        )
        .unwrap();
    assert_eq!(accepted.snapshot_digest, digest('1'));
    assert_eq!(development.status(), ParallelStatus::Active);

    development
        .start_worker("task-b", worker("worker-b", "turn-b", "delegation-b"))
        .unwrap();
    development
        .record_snapshot(
            "task-b",
            snapshot("snapshot-b", '2', "worker-b", "turn-b", 'd'),
        )
        .unwrap();
    development
        .record_review("task-b", approved_review("snapshot-b", '2'))
        .unwrap();
    development
        .record_check("task-b", passing_check("check-b", "snapshot-b", '2'))
        .unwrap();
    development
        .finish_worker(
            "task-b",
            &ThreadId::new("worker-b").unwrap(),
            WorkerStatus::Completed,
        )
        .unwrap();
    development
        .accept_task(
            "task-b",
            "snapshot-b",
            "review-snapshot-b",
            vec!["check-b".into()],
            "policy-7".into(),
            40,
        )
        .unwrap();
    assert_eq!(development.status(), ParallelStatus::Accepted);
}

#[test]
fn old_snapshot_verdicts_are_preserved_but_cannot_accept_the_new_candidate() {
    let mut development = development();
    prepare_task_a(&mut development);
    assert!(
        development
            .record_review("task-a", approved_review("snapshot-a", '1'))
            .unwrap()
    );
    development
        .record_check("task-a", passing_check("check-a", "snapshot-a", '1'))
        .unwrap();
    development
        .finish_worker(
            "task-a",
            &ThreadId::new("worker-a").unwrap(),
            WorkerStatus::Completed,
        )
        .unwrap();
    development
        .start_worker(
            "task-a",
            worker("worker-a-repair", "turn-a-repair", "delegation-a-repair"),
        )
        .unwrap();
    development
        .record_snapshot(
            "task-a",
            snapshot("snapshot-a2", '2', "worker-a-repair", "turn-a-repair", 'd'),
        )
        .unwrap();
    let mut late_approval = approved_review("snapshot-a", '1');
    late_approval.review_id = "late-review-snapshot-a".into();
    assert_eq!(
        ParallelMutation::RecordReview {
            task_id: "task-a".into(),
            review: late_approval,
        }
        .apply(&mut development)
        .unwrap(),
        ParallelMutationOutcome::HistoricalEvidence
    );
    assert!(
        development
            .accept_task(
                "task-a",
                "snapshot-a2",
                "review-snapshot-a",
                vec!["check-a".into()],
                "policy-7".into(),
                50,
            )
            .is_err()
    );
    assert_eq!(development.task("task-a").unwrap().reviews().len(), 2);
    assert_eq!(development.task("task-a").unwrap().acceptance(), None);
}

#[test]
fn failed_or_incomplete_check_cannot_be_promoted_to_a_pass() {
    let mut development = development();
    prepare_task_a(&mut development);
    development
        .record_review("task-a", approved_review("snapshot-a", '1'))
        .unwrap();
    let mut fabricated = passing_check("check-a", "snapshot-a", '1');
    fabricated.output_truncated = true;
    assert!(development.record_check("task-a", fabricated).is_err());
    let mut failed = passing_check("check-failed", "snapshot-a", '1');
    failed.outcome = CheckOutcome::Failed;
    failed.exit_code = Some(1);
    development.record_check("task-a", failed).unwrap();
    development
        .finish_worker(
            "task-a",
            &ThreadId::new("worker-a").unwrap(),
            WorkerStatus::Completed,
        )
        .unwrap();
    assert!(
        development
            .accept_task(
                "task-a",
                "snapshot-a",
                "review-snapshot-a",
                vec!["check-failed".into()],
                "policy-7".into(),
                60,
            )
            .is_err()
    );
}

#[test]
fn store_reopens_and_replays_exact_command_receipts_with_revision_cas() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let store = Store::open(&database).unwrap();
    let session = SessionId::new("session-1").unwrap();
    let root = ThreadId::new("root-1").unwrap();
    let created = store
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start").unwrap(),
            development(),
        )
        .unwrap();
    assert_eq!(created.development.revision(), 1);
    assert_eq!(created.outcome, ParallelMutationOutcome::Created);
    assert_eq!(
        store
            .read_latest_parallel_development(&session, &root)
            .unwrap(),
        created.development
    );
    let replayed_start = store
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start").unwrap(),
            development(),
        )
        .unwrap();
    assert!(replayed_start.replayed);
    assert_eq!(replayed_start.development, created.development);
    let mut retry_with_new_run_id = development();
    retry_with_new_run_id.run_id = "retry-generated-run-id".into();
    let replayed_after_lost_start_response = store
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start").unwrap(),
            retry_with_new_run_id,
        )
        .unwrap();
    assert!(replayed_after_lost_start_response.replayed);
    assert_eq!(
        replayed_after_lost_start_response.development,
        created.development
    );
    let mut conflicting_run = development();
    conflicting_run.goal = "different goal".into();
    assert!(matches!(
        store.create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start").unwrap(),
            conflicting_run,
        ),
        Err(CoreError::CommandConflict)
    ));
    let updated = store
        .mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("worker-a-start").unwrap(),
            1,
            ParallelMutation::StartWorker {
                task_id: "task-a".into(),
                attempt: worker("worker-a", "turn-a", "delegation-a"),
            },
        )
        .unwrap();
    assert_eq!(updated.development.revision(), 2);
    assert_eq!(updated.outcome, ParallelMutationOutcome::Applied);
    assert_eq!(
        updated.development.task("task-a").unwrap().attempts().len(),
        1
    );

    let reopened = Store::open(&database).unwrap();
    let replayed = reopened
        .mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("worker-a-start").unwrap(),
            1,
            ParallelMutation::StartWorker {
                task_id: "task-a".into(),
                attempt: worker("worker-a", "turn-a", "delegation-a"),
            },
        )
        .unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.development.revision(), 2);
    assert_eq!(replayed.outcome, ParallelMutationOutcome::Applied);
    assert_eq!(
        reopened
            .read_parallel_development(&session, &root, "run-1")
            .unwrap(),
        updated.development,
    );
    assert!(matches!(
        reopened.mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("stale-command").unwrap(),
            1,
            ParallelMutation::Cancel,
        ),
        Err(CoreError::InvalidInput(_))
    ));
    assert!(matches!(
        reopened.mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("worker-a-start").unwrap(),
            1,
            ParallelMutation::StartWorker {
                task_id: "task-a".into(),
                attempt: worker("worker-a-alt", "turn-a-alt", "delegation-a-alt"),
            },
        ),
        Err(CoreError::CommandConflict)
    ));

    let cancelling = reopened
        .mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("cancel-run-1").unwrap(),
            2,
            ParallelMutation::Cancel,
        )
        .unwrap();
    assert_eq!(cancelling.development.status(), ParallelStatus::Cancelling);
    let cancelled = reopened
        .mutate_parallel_development(
            &session,
            &root,
            "run-1",
            &CommandId::new("worker-a-cancelled").unwrap(),
            3,
            ParallelMutation::FinishWorker {
                task_id: "task-a".into(),
                thread_id: ThreadId::new("worker-a").unwrap(),
                status: WorkerStatus::Cancelled,
            },
        )
        .unwrap();
    assert_eq!(cancelled.development.status(), ParallelStatus::Cancelled);
    let mut next_run = development();
    next_run.run_id = "run-2".into();
    let created_next = reopened
        .create_parallel_development(
            &session,
            &root,
            &CommandId::new("parallel-start-2").unwrap(),
            next_run,
        )
        .unwrap();
    assert_eq!(created_next.development.run_id(), "run-2");
    assert_eq!(
        reopened
            .list_parallel_developments(&session, &root)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reopened
            .read_latest_parallel_development(&session, &root)
            .unwrap()
            .run_id(),
        "run-2"
    );
    assert_eq!(
        reopened
            .read_parallel_development(&session, &root, "run-1")
            .unwrap()
            .status(),
        ParallelStatus::Cancelled
    );
}

#[test]
fn legacy_single_run_tables_migrate_without_losing_state_or_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE agent_workflows (session TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root));
             CREATE TABLE agent_workflow_commands (session TEXT NOT NULL, root TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, plan TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session, root, command));
             CREATE TABLE agent_parallel_developments (session TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root));
             CREATE TABLE agent_parallel_commands (session TEXT NOT NULL, root TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(session, root, command));",
        )
        .unwrap();
    let session = SessionId::new("session-legacy").unwrap();
    let root = ThreadId::new("root-legacy").unwrap();
    let command = CommandId::new("legacy-start").unwrap();
    let initial = development();
    // The original single-run schema stored the serialized requested aggregate as its start key.
    let request = serde_json::to_string(&initial).unwrap();
    let mut persisted = initial.clone();
    persisted.set_revision(1);
    let state = serde_json::to_string(&persisted).unwrap();
    connection
        .execute(
            "INSERT INTO agent_parallel_developments(session, root, state) VALUES (?1, ?2, ?3)",
            rusqlite::params![session.as_str(), root.as_str(), state],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO agent_parallel_commands(session, root, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![session.as_str(), root.as_str(), command.as_str(), request, serde_json::to_string(&persisted).unwrap()],
        )
        .unwrap();
    drop(connection);

    let store = Store::open(&database).unwrap();
    let replayed = store
        .create_parallel_development(&session, &root, &command, initial)
        .unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.development, persisted);
    assert_eq!(replayed.outcome, ParallelMutationOutcome::Created);
    assert_eq!(
        store
            .read_parallel_development(&session, &root, "run-1")
            .unwrap(),
        persisted
    );
}

#[test]
fn run_keyed_intermediate_schema_migrates_creation_order_and_start_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE agent_workflows (session TEXT NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root));
             CREATE TABLE agent_workflow_commands (session TEXT NOT NULL, root TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, plan TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session, root, command));
             CREATE TABLE agent_parallel_developments (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root, run_id));
             CREATE TABLE agent_parallel_commands (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(session, root, run_id, command));",
        )
        .unwrap();
    let session = SessionId::new("session-intermediate").unwrap();
    let root = ThreadId::new("root-intermediate").unwrap();
    let start_command = CommandId::new("start-run-1").unwrap();
    let initial = development();
    let mut active = initial.clone();
    active.set_revision(1);
    let mut cancelled = active.clone();
    ParallelMutation::Cancel.apply(&mut cancelled).unwrap();
    cancelled.set_revision(2);
    connection
        .execute(
            "INSERT INTO agent_parallel_developments(session, root, run_id, state) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session.as_str(), root.as_str(), active.run_id(), serde_json::to_string(&cancelled).unwrap()],
        )
        .unwrap();
    // The run-keyed prototype also serialized the aggregate as the create request key.
    connection
        .execute(
            "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![session.as_str(), root.as_str(), active.run_id(), start_command.as_str(), serde_json::to_string(&initial).unwrap(), serde_json::to_string(&active).unwrap()],
        )
        .unwrap();
    let mut other_initial = initial.clone();
    other_initial.run_id = "run-2".into();
    other_initial.goal = "A different historical start request".into();
    let mut other_active = other_initial.clone();
    other_active.set_revision(1);
    let mut other_cancelled = other_active.clone();
    ParallelMutation::Cancel
        .apply(&mut other_cancelled)
        .unwrap();
    other_cancelled.set_revision(2);
    connection
        .execute(
            "INSERT INTO agent_parallel_developments(session, root, run_id, state) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session.as_str(), root.as_str(), other_active.run_id(), serde_json::to_string(&other_cancelled).unwrap()],
        )
        .unwrap();
    // The old composite key allowed the same command id to be reused on another run.
    connection
        .execute(
            "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![session.as_str(), root.as_str(), other_active.run_id(), start_command.as_str(), serde_json::to_string(&other_initial).unwrap(), serde_json::to_string(&other_active).unwrap()],
        )
        .unwrap();
    drop(connection);

    let store = Store::open(&database).unwrap();
    let mut regenerated = initial;
    regenerated.run_id = "newly-generated-retry-id".into();
    let replayed = store
        .create_parallel_development(&session, &root, &start_command, regenerated)
        .unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.development, active);
    assert_eq!(
        store
            .read_latest_parallel_development(&session, &root)
            .unwrap()
            .run_id(),
        "run-2"
    );
}

#[test]
fn ambiguous_historical_start_receipts_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("state.db");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE agent_parallel_developments (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(session, root, run_id));
             CREATE TABLE agent_parallel_commands (session TEXT NOT NULL, root TEXT NOT NULL, run_id TEXT NOT NULL, command TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(session, root, run_id, command));",
        )
        .unwrap();
    let session = SessionId::new("session-ambiguous").unwrap();
    let root = ThreadId::new("root-ambiguous").unwrap();
    let command = CommandId::new("reused-start").unwrap();
    for run_id in ["run-1", "run-2"] {
        let mut requested = development();
        requested.run_id = run_id.into();
        let mut active = requested.clone();
        active.set_revision(1);
        let mut cancelled = active.clone();
        ParallelMutation::Cancel.apply(&mut cancelled).unwrap();
        cancelled.set_revision(2);
        connection
            .execute(
                "INSERT INTO agent_parallel_developments(session, root, run_id, state) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![session.as_str(), root.as_str(), run_id, serde_json::to_string(&cancelled).unwrap()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_parallel_commands(session, root, run_id, command, request, receipt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![session.as_str(), root.as_str(), run_id, command.as_str(), serde_json::to_string(&requested).unwrap(), serde_json::to_string(&active).unwrap()],
            )
            .unwrap();
    }
    drop(connection);

    let store = Store::open(&database).unwrap();
    let mut retry = development();
    retry.run_id = "new-retry-id".into();
    let error = store
        .create_parallel_development(&session, &root, &command, retry)
        .unwrap_err();
    assert!(format!("{error:?}").contains("More than one historical parallel command receipt"));
}
