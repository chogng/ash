use crate::Error;
use crate::Issue;
use crate::Observation;
use crate::Store;
use crate::Workflow;
use ash_protocol::SymphonyControl;
use ash_protocol::SymphonyTaskStatus;
use std::collections::BTreeMap;

fn workflow(root: &tempfile::TempDir, options: &str) -> Workflow {
    let path = root.path().join("WORKFLOW.md");
    std::fs::write(&path, format!("---\n{options}\n---\n{{{{ issue.identifier }}}}: {{{{ issue.title }}}} (attempt {{{{ attempt }}}})")).unwrap();
    Workflow::load(&path).unwrap()
}

fn issue(id: &str, state: &str, priority: i64) -> Issue {
    Issue {
        id: id.into(),
        identifier: id.into(),
        title: format!("Issue {id}"),
        description: String::new(),
        state: state.into(),
        url: None,
        labels: Vec::new(),
        priority: Some(priority),
        created_at: "2026-10-08".into(),
        updated_at: None,
        branch_name: None,
        assignee_id: None,
        blocked_by: BTreeMap::new(),
        local: false,
        dispatchable: true,
    }
}

fn observation(status: SymphonyTaskStatus) -> Observation {
    Observation {
        status,
        session_id: None,
        thread_id: None,
        turn_id: None,
        error: None,
    }
}

#[test]
fn reservations_survive_reopen_and_controls_win_over_old_observations() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "agent:\n  max_concurrent_agents: 1");
    let path = root.path().join("state.db");
    let store = Store::open(&path).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    let id = store
        .submit("submit", &plan.id, "First", "Instructions")
        .unwrap();
    assert_eq!(
        store
            .submit("submit", &plan.id, "First", "Instructions")
            .unwrap(),
        id
    );
    assert!(matches!(
        store.submit("submit", &plan.id, "Changed", "Instructions"),
        Err(Error::Conflict)
    ));
    let reserved = store.reserve(1000).unwrap().remove(0);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert!(store.reserve(2000).unwrap().is_empty());
    assert_eq!(store.job(&id).unwrap(), reserved);
    store.control("pause", &id, SymphonyControl::Pause).unwrap();
    store
        .observe(&reserved, observation(SymphonyTaskStatus::Running), 2000)
        .unwrap();
    assert_eq!(store.job(&id).unwrap().status, SymphonyTaskStatus::Stopping);
    store
        .observe(&reserved, observation(SymphonyTaskStatus::Completed), 3000)
        .unwrap();
    assert_eq!(store.job(&id).unwrap().status, SymphonyTaskStatus::Paused);
    store.control("resume", &id, SymphonyControl::Run).unwrap();
    let resumed = store.reserve(4000).unwrap().remove(0);
    assert_eq!(resumed.attempt, 2);
    store
        .observe(&reserved, observation(SymphonyTaskStatus::Completed), 4001)
        .unwrap();
    assert_eq!(store.job(&id).unwrap().status, SymphonyTaskStatus::Starting);
    store
        .observe(&resumed, observation(SymphonyTaskStatus::Completed), 5000)
        .unwrap();
    assert_eq!(
        store.job(&id).unwrap().status,
        SymphonyTaskStatus::Completed
    );
    assert!(!store.needs_host().unwrap());
}

#[test]
fn concurrency_state_limits_priority_and_blockers_are_enforced_before_io() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  project_slug: test\nagent:\n  max_concurrent_agents: 2\n  max_concurrent_agents_by_state:\n    Todo: 1",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    let mut blocked = issue("BLOCKED", "Todo", 0);
    blocked
        .blocked_by
        .insert("dependency".into(), "In Progress".into());
    store
        .ingest(
            &plan,
            vec![
                issue("HIGH", "Todo", 1),
                issue("LOW", "Todo", 4),
                issue("ACTIVE", "In Progress", 2),
                blocked,
            ],
            1000,
        )
        .unwrap();
    let reserved = store.reserve(1000).unwrap();
    assert_eq!(
        reserved
            .iter()
            .map(|job| job.issue.id.as_str())
            .collect::<Vec<_>>(),
        ["HIGH", "ACTIVE"]
    );
    assert!(store.reserve(1001).unwrap().is_empty());
    store
        .observe(
            &reserved[0],
            observation(SymphonyTaskStatus::Retrying),
            1002,
        )
        .unwrap();
    let next = store.reserve(1003).unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].issue.id, "LOW");
    assert_eq!(store.job(&reserved[0].id).unwrap().retry_at, 11002);
}

#[test]
fn failed_poll_does_not_retire_jobs_but_full_snapshot_reconciles_removals() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: github\n  provider:\n    repo: owner/repo",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(&plan, vec![issue("1", "open", 1)], 1000)
        .unwrap();
    let reserved = store.reserve(1000).unwrap().remove(0);
    store.poll_error(&plan.id, "offline".into(), 2000).unwrap();
    assert_eq!(
        store.job(&reserved.id).unwrap().desired,
        SymphonyControl::Run
    );
    store.ingest(&plan, Vec::new(), 3000).unwrap();
    assert_eq!(
        store.job(&reserved.id).unwrap().desired,
        SymphonyControl::Complete
    );
    store
        .observe(&reserved, observation(SymphonyTaskStatus::Paused), 4000)
        .unwrap();
    assert_eq!(
        store.job(&reserved.id).unwrap().status,
        SymphonyTaskStatus::Completed
    );
}

#[test]
fn bad_reload_blocks_new_dispatch_without_changing_an_accepted_attempt() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "agent:\n  max_concurrent_agents: 1");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store.submit("first", &plan.id, "First", "").unwrap();
    let first = store.reserve(1000).unwrap().remove(0);
    store.submit("second", &plan.id, "Second", "").unwrap();
    store
        .reload(&plan, Err(Error::Invalid("bad YAML".into())))
        .unwrap();
    store
        .observe(&first, observation(SymphonyTaskStatus::Completed), 2000)
        .unwrap();
    assert!(store.reserve(2000).unwrap().is_empty());
    assert!(
        store.workflows().unwrap()[0]
            .error
            .as_ref()
            .unwrap()
            .contains("bad YAML")
    );
    let revised = workflow(&root, "agent:\n  max_concurrent_agents: 2");
    store.reload(&plan, Ok(revised)).unwrap();
    assert_eq!(store.reserve(3000).unwrap().len(), 1);
    assert!(first.invocation.unwrap().prompt.contains("attempt "));
}

#[test]
fn invalid_template_in_one_workflow_does_not_starve_another() {
    let root = tempfile::tempdir().unwrap();
    let mut bad = workflow(&root, "");
    bad.prompt = "{{ issue.unknown }}".into();
    let other = tempfile::tempdir().unwrap();
    let good = workflow(&other, "");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("bad", bad.clone()).unwrap();
    store.configure("good", good.clone()).unwrap();
    store.submit("bad-job", &bad.id, "Bad", "").unwrap();
    store.submit("good-job", &good.id, "Good", "").unwrap();
    assert_eq!(store.reserve(1000).unwrap()[0].workflow_id, good.id);
    assert!(
        store
            .jobs()
            .unwrap()
            .iter()
            .find(|item| item.workflow_id == bad.id)
            .unwrap()
            .error
            .is_some()
    );
}

#[test]
fn continuation_batches_keep_the_thread_and_failure_backoff_resets_after_success() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  project_slug: test\nagent:\n  max_turns: 2",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(&plan, vec![issue("1", "In Progress", 1)], 0)
        .unwrap();
    let first = store.reserve(0).unwrap().remove(0);
    store
        .observe(&first, observation(SymphonyTaskStatus::Completed), 1)
        .unwrap();
    let second = store.reserve(1001).unwrap().remove(0);
    assert_eq!((second.attempt, second.turn_number), (1, 2));
    store
        .observe(&first, observation(SymphonyTaskStatus::Retrying), 1002)
        .unwrap();
    assert_eq!(store.job(&first.id).unwrap().turn_number, 2);
    store
        .observe(&second, observation(SymphonyTaskStatus::Completed), 1002)
        .unwrap();
    let next = store.reserve(2002).unwrap().remove(0);
    assert_eq!((next.attempt, next.turn_number), (2, 1));
    store
        .observe(&next, observation(SymphonyTaskStatus::Retrying), 2003)
        .unwrap();
    assert_eq!(store.job(&first.id).unwrap().retry_at, 22003);
}

#[test]
fn shutdown_cancels_and_joins_tracker_and_execution_io() {
    struct Waiting {
        started: std::sync::mpsc::Sender<&'static str>,
    }
    impl crate::Executor for Waiting {
        fn poll(
            &self,
            _: &Workflow,
            cancellation: &ash_async_utils::CancellationToken,
        ) -> Result<Vec<Issue>, String> {
            self.started.send("poll").unwrap();
            while !cancellation.is_cancelled() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err("cancelled".into())
        }
        fn advance(
            &self,
            _: &crate::Job,
            cancellation: &ash_async_utils::CancellationToken,
        ) -> Result<Observation, String> {
            self.started.send("execution").unwrap();
            while !cancellation.is_cancelled() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err("cancelled".into())
        }
        fn cleanup(
            &self,
            _: &crate::Job,
            _: &ash_async_utils::CancellationToken,
        ) -> Result<(), String> {
            Ok(())
        }
        fn changed(&self) {}
        fn report_error(&self, error: &str) {
            panic!("{error}");
        }
    }
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "tracker:\n  kind: linear\n  project_slug: test");
    let store = std::sync::Arc::new(Store::open(&root.path().join("state.db")).unwrap());
    store.configure("configure", plan.clone()).unwrap();
    store.submit("submit", &plan.id, "Shutdown", "").unwrap();
    let (started, events) = std::sync::mpsc::channel();
    let runtime = crate::Runtime::start(store, std::sync::Arc::new(Waiting { started })).unwrap();
    let mut observed = vec![
        events
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
        events
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap(),
    ];
    observed.sort();
    assert_eq!(observed, ["execution", "poll"]);
    let before = std::time::Instant::now();
    drop(runtime);
    assert!(before.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn progress_timeout_resets_on_core_events_and_excludes_interactive_waits() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "codex:\n  stall_timeout_ms: 1000");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store.submit("submit", &plan.id, "Progress", "").unwrap();
    let job = store.reserve(100).unwrap().remove(0);
    assert!(!store.stalled(&job, 1, false, 100).unwrap());
    assert!(!store.stalled(&job, 2, false, 1100).unwrap());
    assert!(!store.stalled(&job, 2, true, 10000).unwrap());
    assert!(!store.stalled(&job, 2, false, 10999).unwrap());
    assert!(!store.stalled(&job, 2, false, 11000).unwrap());
    assert!(store.stalled(&job, 2, false, 11001).unwrap());
    assert!(store.job(&job.id).unwrap().timing_out);
}

#[test]
fn idempotency_fingerprints_distinguish_delimiters_inside_user_text() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store.submit("submit", &plan.id, "a:b", "c").unwrap();
    assert!(matches!(
        store.submit("submit", &plan.id, "a", "b:c"),
        Err(Error::Conflict)
    ));
}

#[test]
fn upstream_workflow_loads_unchanged_and_first_attempt_has_no_follow_up_context() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("WORKFLOW.md");
    std::fs::write(&path, include_str!("../testdata/upstream-workflow.md")).unwrap();
    let plan = Workflow::load(&path).unwrap();
    assert!(
        plan.hooks
            .before_remove
            .as_deref()
            .unwrap()
            .contains("workspace.before_remove")
    );
    assert!(
        plan.workspace_root
            .as_deref()
            .unwrap()
            .ends_with("code/symphony-workspaces")
    );
    assert!(plan.codex.command.contains("gpt-5.5"));
    let first = plan.render(&issue("LIN-1", "Todo", 1), None).unwrap();
    assert!(!first.contains("Follow-up context:"));
    assert!(first.contains("## Codex Workpad"));
    assert!(first.contains("Human Review"));
    let retry = plan.render(&issue("LIN-1", "Todo", 1), Some(1)).unwrap();
    assert!(retry.contains("follow-up attempt #1"));
}

#[test]
fn liquid_filters_and_strict_errors_match_the_workflow_contract() {
    let root = tempfile::tempdir().unwrap();
    let mut plan = workflow(&root, "");
    let mut item = issue("LIN-1", "Todo", 1);
    item.labels = vec!["one".into(), "two".into()];
    plan.prompt =
        "{{ issue.labels | join: ', ' }}{% if attempt %} retry {{ attempt | plus: 1 }}{% endif %}"
            .into();
    assert_eq!(plan.render(&item, None).unwrap(), "one, two");
    assert_eq!(plan.render(&item, Some(1)).unwrap(), "one, two retry 2");
    plan.prompt = "{{ issue.missing }}".into();
    assert!(plan.render(&item, None).is_err());
    plan.prompt = "{{ issue.title | unsupported_filter }}".into();
    assert!(plan.render(&item, None).is_err());
}

#[test]
fn dispatch_normalizes_states_and_priorities_and_rejects_terminal_or_unroutable_issues() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  project_slug: test\n  active_states: [Todo, Done]\nagent:\n  max_concurrent_agents: 3\n  max_concurrent_agents_by_state:\n    ' TODO ': 1",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    let mut unknown_priority = issue("ZERO", "Todo", 0);
    unknown_priority.created_at = String::new();
    let mut unroutable = issue("UNROUTABLE", "Todo", 1);
    unroutable.dispatchable = false;
    store
        .ingest(
            &plan,
            vec![
                unknown_priority,
                issue("HIGH", " Todo ", 1),
                issue("DONE", "Done", 1),
                unroutable,
            ],
            0,
        )
        .unwrap();
    let reserved = store.reserve(0).unwrap();
    assert_eq!(reserved.len(), 1);
    assert_eq!(reserved[0].issue.id, "HIGH");
    assert_eq!(store.jobs().unwrap().len(), 2);
}

#[test]
fn continuation_uses_guidance_and_failure_after_clean_exit_uses_twenty_second_backoff() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  project_slug: test\nagent:\n  max_turns: 2",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(&plan, vec![issue("ONE", "In Progress", 1)], 0)
        .unwrap();
    let first = store.reserve(0).unwrap().remove(0);
    store
        .observe(&first, observation(SymphonyTaskStatus::Completed), 1)
        .unwrap();
    let second = store.reserve(1).unwrap().remove(0);
    assert!(
        second
            .invocation
            .as_ref()
            .unwrap()
            .prompt
            .contains("continuation turn #2 of 2")
    );
    assert!(
        !second
            .invocation
            .as_ref()
            .unwrap()
            .prompt
            .contains("Issue ONE")
    );
    store
        .observe(&second, observation(SymphonyTaskStatus::Completed), 2)
        .unwrap();
    assert!(store.reserve(1001).unwrap().is_empty());
    let next = store.reserve(1002).unwrap().remove(0);
    assert!(
        next.invocation
            .as_ref()
            .unwrap()
            .prompt
            .contains("attempt 1")
    );
    store
        .observe(&next, observation(SymphonyTaskStatus::Retrying), 1003)
        .unwrap();
    assert_eq!(store.job(&next.id).unwrap().retry_at, 21003);
}

#[test]
fn id_refresh_stops_a_terminal_issue_without_retiring_other_claims() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "tracker:\n  kind: linear\n  project_slug: test");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(
            &plan,
            vec![issue("ONE", "Todo", 1), issue("TWO", "Todo", 2)],
            0,
        )
        .unwrap();
    let jobs = store.reserve(0).unwrap();
    let refreshed = store
        .revalidate(&jobs[0], Some(issue("ONE", "Done", 1)))
        .unwrap();
    assert_eq!(refreshed.desired, SymphonyControl::Complete);
    assert!(refreshed.cleanup_pending);
    assert_eq!(
        store.job(&jobs[1].id).unwrap().desired,
        SymphonyControl::Run
    );
}

#[test]
fn a_retry_without_a_slot_increments_backoff_but_new_pending_work_does_not() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "agent:\n  max_concurrent_agents: 1");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    let retry_id = store.submit("first", &plan.id, "First", "").unwrap();
    let first = store.reserve(0).unwrap().remove(0);
    store
        .observe(&first, observation(SymphonyTaskStatus::Retrying), 1)
        .unwrap();
    store.submit("second", &plan.id, "Second", "").unwrap();
    let second = store.reserve(2).unwrap().remove(0);
    let pending_id = store.submit("third", &plan.id, "Third", "").unwrap();
    assert!(store.reserve(10001).unwrap().is_empty());
    let retry = store.job(&retry_id).unwrap();
    assert_eq!(retry.retry_attempt, 2);
    assert_eq!(retry.retry_at, 30001);
    assert_eq!(
        retry.error.as_deref(),
        Some("no available orchestrator slots")
    );
    assert_eq!(store.job(&pending_id).unwrap().retry_attempt, 0);
    store
        .observe(&second, observation(SymphonyTaskStatus::Completed), 10002)
        .unwrap();
    let next = store.reserve(10003).unwrap().remove(0);
    assert_eq!(next.id, pending_id);
}

#[test]
fn literal_linear_credentials_are_resolved_from_the_source_without_being_saved() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  provider:\n    project_slug: test\n    api_key: fixture-secret\n    endpoint: https://linear.example/graphql\n    assignee: me\n    extension: preserved",
    );
    assert_eq!(plan.linear_credential().unwrap(), "fixture-secret");
    assert_eq!(
        plan.tracker_endpoint.as_deref(),
        Some("https://linear.example/graphql")
    );
    assert_eq!(plan.tracker_assignee.as_deref(), Some("me"));
    assert_eq!(plan.provider_options["extension"], "preserved");
    assert!(
        !serde_json::to_string(&plan)
            .unwrap()
            .contains("fixture-secret")
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    assert!(!format!("{plan:?}").contains("fixture-secret"));
    let bytes = std::fs::read(root.path().join("state.db")).unwrap();
    assert!(
        !bytes
            .windows(b"fixture-secret".len())
            .any(|item| item == b"fixture-secret")
    );
}

#[test]
fn blockers_discovered_before_dispatch_release_the_claim_without_removing_the_workspace() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(&root, "tracker:\n  kind: linear\n  project_slug: test");
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(&plan, vec![issue("ONE", "Todo", 1)], 0)
        .unwrap();
    let job = store.reserve(0).unwrap().remove(0);
    let mut blocked = issue("ONE", "Todo", 1);
    blocked
        .blocked_by
        .insert("dependency".into(), "Todo".into());
    let stopped = store.revalidate(&job, Some(blocked)).unwrap();
    assert_eq!(stopped.desired, SymphonyControl::Complete);
    assert!(!stopped.cleanup_pending);
}

#[test]
fn continuation_keeps_its_worker_slot_when_a_higher_priority_issue_arrives() {
    let root = tempfile::tempdir().unwrap();
    let plan = workflow(
        &root,
        "tracker:\n  kind: linear\n  project_slug: test\nagent:\n  max_concurrent_agents: 1\n  max_turns: 2",
    );
    let store = Store::open(&root.path().join("state.db")).unwrap();
    store.configure("configure", plan.clone()).unwrap();
    store
        .ingest(&plan, vec![issue("RUNNING", "In Progress", 4)], 0)
        .unwrap();
    let first = store.reserve(0).unwrap().remove(0);
    store
        .prepared(
            &first,
            ash_protocol::SessionId::new("session").unwrap(),
            ash_protocol::ThreadId::new("thread").unwrap(),
        )
        .unwrap();
    store
        .observe(&first, observation(SymphonyTaskStatus::Completed), 1)
        .unwrap();
    store
        .ingest(
            &plan,
            vec![issue("RUNNING", "In Progress", 4), issue("NEW", "Todo", 1)],
            2,
        )
        .unwrap();
    let next = store.reserve(2).unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id, first.id);
    assert_eq!(next[0].turn_number, 2);
}
