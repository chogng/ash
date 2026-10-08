use crate::Error;
use crate::Issue;
use crate::Workflow;
use crate::workflow::identity;
use ash_protocol::SessionId;
use ash_protocol::SymphonyControl;
use ash_protocol::SymphonyTaskStatus;
use ash_protocol::SymphonyWorkflow;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use rusqlite::Connection;
use rusqlite::TransactionBehavior;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Job {
    pub id: String,
    pub workflow_id: String,
    pub issue: Issue,
    pub status: SymphonyTaskStatus,
    pub desired: SymphonyControl,
    pub attempt: u32,
    #[serde(default)]
    pub turn_number: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub retry_attempt: u32,
    #[serde(default)]
    pub progress_sequence: Option<u64>,
    #[serde(default)]
    pub progress_at: u64,
    #[serde(default)]
    pub timing_out: bool,
    pub session_id: Option<SessionId>,
    pub thread_id: Option<ThreadId>,
    pub turn_id: Option<TurnId>,
    pub retry_at: u64,
    pub error: Option<String>,
    /// Frozen before dispatch so an uncertain submission always replays identical input.
    pub invocation: Option<Invocation>,
    pub setup_done: bool,
    #[serde(default)]
    pub cleanup_pending: bool,
    #[serde(default)]
    pub worker_prepared: bool,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub tracker_retired: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Invocation {
    pub workflow: Workflow,
    pub prompt: String,
    pub prepared: bool,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub status: SymphonyTaskStatus,
    pub session_id: Option<SessionId>,
    pub thread_id: Option<ThreadId>,
    pub turn_id: Option<TurnId>,
    pub error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Plan {
    pub workflow: Workflow,
    pub enabled: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub reload_error: Option<String>,
    pub polled_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct State {
    workflows: BTreeMap<String, Plan>,
    jobs: BTreeMap<String, Job>,
    commands: BTreeMap<String, (String, String)>,
}

/// One profile owns this store. SQLite transactions arbitrate controls and scheduler observations.
pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS symphony_state (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL, body TEXT NOT NULL);")?;
        connection.execute(
            "INSERT OR IGNORE INTO symphony_state VALUES (1, 1, ?1)",
            [serde_json::to_string(&State::default())?],
        )?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.read(|_| ())?;
        Ok(store)
    }

    fn read<T>(&self, read: impl FnOnce(&State) -> T) -> Result<T, Error> {
        let connection = self.connection.lock().map_err(|_| Error::LockPoisoned)?;
        let (version, body): (u32, String) = connection.query_row(
            "SELECT version, body FROM symphony_state WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if version != 1 {
            return Err(Error::Invalid(
                "unsupported workflow storage version".into(),
            ));
        }
        Ok(read(&serde_json::from_str(&body)?))
    }

    fn mutate<T>(&self, mutate: impl FnOnce(&mut State) -> Result<T, Error>) -> Result<T, Error> {
        let mut connection = self.connection.lock().map_err(|_| Error::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let body: String =
            transaction.query_row("SELECT body FROM symphony_state WHERE id=1", [], |row| {
                row.get(0)
            })?;
        let mut state: State = serde_json::from_str(&body)?;
        let result = mutate(&mut state)?;
        let updated = serde_json::to_string(&state)?;
        if body != updated {
            transaction.execute("UPDATE symphony_state SET body=?1 WHERE id=1", [updated])?;
        }
        transaction.commit()?;
        Ok(result)
    }

    pub fn configure(&self, command: &str, workflow: Workflow) -> Result<String, Error> {
        self.mutate(|state| {
            let fingerprint = identity(&serde_json::to_string(&(
                "configure",
                &workflow.path,
                &workflow.digest,
            ))?);
            if let Some(id) = receipt(state, command, &fingerprint)? {
                return Ok(id);
            }
            let id = workflow.id.clone();
            if state.workflows.len() >= 100 && !state.workflows.contains_key(&id) {
                return Err(Error::Invalid("too many workflows".into()));
            }
            state.workflows.insert(
                id.clone(),
                Plan {
                    workflow,
                    enabled: true,
                    error: None,
                    reload_error: None,
                    polled_at: 0,
                },
            );
            state
                .commands
                .insert(command.into(), (fingerprint, id.clone()));
            Ok(id)
        })
    }

    pub fn set_enabled(&self, command: &str, id: &str, enabled: bool) -> Result<(), Error> {
        self.mutate(|state| {
            let fingerprint = identity(&serde_json::to_string(&("enable", id, enabled))?);
            if receipt(state, command, &fingerprint)?.is_some() {
                return Ok(());
            }
            state.workflows.get_mut(id).ok_or(Error::NotFound)?.enabled = enabled;
            state
                .commands
                .insert(command.into(), (fingerprint, id.into()));
            Ok(())
        })
    }

    pub fn submit(
        &self,
        command: &str,
        workflow_id: &str,
        title: &str,
        description: &str,
    ) -> Result<String, Error> {
        self.mutate(|state| {
            let fingerprint = identity(&serde_json::to_string(&(
                "submit",
                workflow_id,
                title,
                description,
            ))?);
            if let Some(id) = receipt(state, command, &fingerprint)? {
                return Ok(id);
            }
            if !state.workflows.contains_key(workflow_id) {
                return Err(Error::NotFound);
            }
            let id = identity(&format!("local:{command}"));
            let issue = Issue {
                id: id.clone(),
                identifier: format!("ASH-{}", &id[id.len() - 8..]),
                title: title.into(),
                description: description.into(),
                state: "Todo".into(),
                url: None,
                labels: Vec::new(),
                priority: None,
                created_at: String::new(),
                updated_at: None,
                branch_name: None,
                assignee_id: None,
                blocked_by: BTreeMap::new(),
                local: true,
                dispatchable: true,
            };
            issue.validate()?;
            insert_job(state, workflow_id, issue)?;
            let job_id = identity(&format!("{workflow_id}:{id}"));
            state
                .commands
                .insert(command.into(), (fingerprint, job_id.clone()));
            Ok(job_id)
        })
    }

    pub fn control(&self, command: &str, id: &str, control: SymphonyControl) -> Result<(), Error> {
        self.mutate(|state| {
            let fingerprint = identity(&serde_json::to_string(&("control", id, control))?);
            if receipt(state, command, &fingerprint)?.is_some() {
                return Ok(());
            }
            let job = state.jobs.get_mut(id).ok_or(Error::NotFound)?;
            job.desired = control;
            job.tracker_retired = false;
            if control == SymphonyControl::Complete {
                job.cleanup_pending = job.workspace_root.is_some();
            }
            if active(job.status) {
                if control != SymphonyControl::Run {
                    job.status = SymphonyTaskStatus::Stopping;
                }
            } else {
                job.status = match control {
                    SymphonyControl::Run => SymphonyTaskStatus::Pending,
                    SymphonyControl::Pause => SymphonyTaskStatus::Paused,
                    SymphonyControl::Complete => SymphonyTaskStatus::Completed,
                };
                job.retry_at = 0;
                job.turn_number = 0;
                job.worker_prepared = false;
            }
            state
                .commands
                .insert(command.into(), (fingerprint, id.into()));
            Ok(())
        })
    }

    pub fn jobs(&self) -> Result<Vec<Job>, Error> {
        self.read(|state| state.jobs.values().cloned().collect())
    }
    pub fn job(&self, id: &str) -> Result<Job, Error> {
        self.read(|state| state.jobs.get(id).cloned())?
            .ok_or(Error::NotFound)
    }
    pub fn workflow(&self, id: &str) -> Result<Workflow, Error> {
        self.read(|state| state.workflows.get(id).map(|plan| plan.workflow.clone()))?
            .ok_or(Error::NotFound)
    }
    pub(crate) fn plans(&self) -> Result<Vec<Plan>, Error> {
        self.read(|state| state.workflows.values().cloned().collect())
    }
    pub fn workflows(&self) -> Result<Vec<SymphonyWorkflow>, Error> {
        self.read(|state| {
            state
                .workflows
                .values()
                .map(|plan| SymphonyWorkflow {
                    id: plan.workflow.id.clone(),
                    path: plan.workflow.path.clone(),
                    directory: plan.workflow.directory.clone(),
                    tracker: match plan.workflow.tracker {
                        crate::Tracker::Local => "local",
                        crate::Tracker::Github { .. } => "github",
                        crate::Tracker::Linear { .. } => "linear",
                    }
                    .into(),
                    enabled: plan.enabled,
                    max_concurrent_agents: plan.workflow.max_concurrent_agents,
                    error: plan.reload_error.clone().or(plan.error.clone()),
                })
                .collect()
        })
    }

    pub(crate) fn reload(
        &self,
        previous: &Workflow,
        current: Result<Workflow, Error>,
    ) -> Result<(), Error> {
        self.mutate(|state| {
            let Some(plan) = state.workflows.get_mut(&previous.id) else {
                return Ok(());
            };
            // A newer explicit import wins over this scheduler's older reload.
            if plan.workflow.digest != previous.digest {
                return Ok(());
            }
            match current {
                Ok(workflow) if workflow.id != previous.id => {
                    plan.reload_error =
                        Some("workflow identity changed; import the new file explicitly".into())
                }
                Ok(workflow) if workflow.digest != previous.digest => {
                    plan.workflow = workflow;
                    plan.reload_error = None;
                    plan.polled_at = 0;
                }
                Ok(_) => {
                    plan.reload_error = None;
                }
                Err(error) => plan.reload_error = Some(error.to_string()),
            }
            Ok(())
        })
    }

    pub(crate) fn ingest(
        &self,
        workflow: &Workflow,
        issues: Vec<Issue>,
        now: u64,
    ) -> Result<(), Error> {
        for issue in &issues {
            issue.validate()?;
        }
        self.mutate(|state| {
            let Some(plan) = state.workflows.get(&workflow.id) else {
                return Ok(());
            };
            if plan.workflow.digest != workflow.digest {
                return Ok(());
            }
            let enabled = plan.enabled;
            let present: std::collections::BTreeSet<_> =
                issues.iter().map(|issue| issue.id.clone()).collect();
            for job in state.jobs.values_mut().filter(|job| {
                job.workflow_id == workflow.id
                    && !job.issue.local
                    && !present.contains(&job.issue.id)
            }) {
                job.desired = SymphonyControl::Complete;
                job.tracker_retired = true;
                job.status = if active(job.status) {
                    SymphonyTaskStatus::Stopping
                } else {
                    SymphonyTaskStatus::Completed
                };
            }
            for issue in issues {
                let id = identity(&format!("{}:{}", workflow.id, issue.id));
                if let Some(job) = state.jobs.get_mut(&id) {
                    if !workflow.active(&issue) {
                        job.tracker_retired = true;
                        job.cleanup_pending = workflow.terminal(&issue);
                        job.desired = SymphonyControl::Complete;
                        job.status = if active(job.status) {
                            SymphonyTaskStatus::Stopping
                        } else {
                            SymphonyTaskStatus::Completed
                        };
                    } else if job.status == SymphonyTaskStatus::Completed && job.tracker_retired {
                        job.tracker_retired = false;
                        job.desired = SymphonyControl::Run;
                        job.status = SymphonyTaskStatus::Pending;
                    }
                    job.issue = issue;
                } else if enabled && workflow.dispatchable(&issue) {
                    insert_job(state, &workflow.id, issue)?;
                }
            }
            let plan = state.workflows.get_mut(&workflow.id).unwrap();
            plan.polled_at = now;
            plan.error = None;
            Ok(())
        })
    }

    pub(crate) fn poll_error(&self, id: &str, message: String, now: u64) -> Result<(), Error> {
        self.mutate(|state| {
            let plan = state.workflows.get_mut(id).ok_or(Error::NotFound)?;
            plan.error = Some(message);
            plan.polled_at = now;
            Ok(())
        })
    }

    /// Refreshing one issue never retires unrelated work. A failed tracker read calls neither this
    /// operation nor ingest, preserving claims until the retry can establish the current state.
    pub fn revalidate(&self, original: &Job, issue: Option<Issue>) -> Result<Job, Error> {
        self.mutate(|state| {
            let workflow = state
                .workflows
                .get(&original.workflow_id)
                .ok_or(Error::NotFound)?
                .workflow
                .clone();
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt != original.attempt || job.turn_number != original.turn_number {
                return Ok(job.clone());
            }
            if let Some(issue) = issue {
                issue.validate()?;
                if !workflow.dispatchable(&issue) {
                    job.desired = SymphonyControl::Complete;
                    job.tracker_retired = true;
                }
                job.cleanup_pending = workflow.terminal(&issue);
                job.issue = issue;
            } else {
                job.desired = SymphonyControl::Complete;
                job.tracker_retired = true;
            }
            if let Some(invocation) = &mut job.invocation
                && !invocation.prepared
            {
                if job.turn_number == 1 {
                    invocation.prompt = workflow.render(
                        &job.issue,
                        (job.retry_attempt > 0).then_some(job.retry_attempt),
                    )?;
                }
            }
            Ok(job.clone())
        })
    }

    pub fn cleaned(&self, id: &str) -> Result<(), Error> {
        self.mutate(|state| {
            state
                .jobs
                .get_mut(id)
                .ok_or(Error::NotFound)?
                .cleanup_pending = false;
            Ok(())
        })
    }
    pub fn bound_workspace(&self, id: &str, root: String) -> Result<(), Error> {
        self.mutate(|state| {
            state
                .jobs
                .get_mut(id)
                .ok_or(Error::NotFound)?
                .workspace_root = Some(root);
            Ok(())
        })
    }

    /// Reservations count before any IO. Recovery reuses this frozen attempt and Core command.
    pub fn reserve(&self, now: u64) -> Result<Vec<Job>, Error> {
        self.mutate(|state| {
            let mut reserved = Vec::new();
            let mut candidates: Vec<_> = state
                .jobs
                .values()
                .filter(|job| {
                    matches!(
                        job.status,
                        SymphonyTaskStatus::Pending | SymphonyTaskStatus::Retrying
                    ) && job.retry_at <= now
                        && job.desired == SymphonyControl::Run
                })
                .cloned()
                .collect();
            candidates.sort_by_key(|job| {
                (
                    job.issue
                        .priority
                        .filter(|priority| (1..=4).contains(priority))
                        .unwrap_or(5),
                    chrono::DateTime::parse_from_rfc3339(&job.issue.created_at)
                        .map(|date| date.timestamp_micros())
                        .unwrap_or(i64::MAX),
                    job.issue.identifier.clone(),
                )
            });
            for candidate in candidates {
                let plan = state
                    .workflows
                    .get(&candidate.workflow_id)
                    .ok_or(Error::NotFound)?;
                if !plan.enabled
                    || plan.reload_error.is_some()
                    || !plan.workflow.dispatchable(&candidate.issue)
                {
                    continue;
                }
                let workers: Vec<_> = state
                    .jobs
                    .values()
                    .filter(|job| {
                        job.workflow_id == candidate.workflow_id
                            && job.id != candidate.id
                            && (active(job.status)
                                || (job.status == SymphonyTaskStatus::Pending
                                    && job.worker_prepared
                                    && job.turn_number > 0))
                    })
                    .collect();
                if workers.len() >= plan.workflow.max_concurrent_agents as usize {
                    retry_without_slot(
                        state.jobs.get_mut(&candidate.id).unwrap(),
                        plan.workflow.max_retry_backoff_ms,
                        now,
                    );
                    continue;
                }
                if let Some(limit) = plan
                    .workflow
                    .max_concurrent_agents_by_state
                    .iter()
                    .find_map(|(state, limit)| {
                        state
                            .eq_ignore_ascii_case(candidate.issue.state.trim())
                            .then_some(limit)
                    })
                    && workers
                        .iter()
                        .filter(|job| {
                            job.issue
                                .state
                                .trim()
                                .eq_ignore_ascii_case(candidate.issue.state.trim())
                        })
                        .count()
                        >= *limit as usize
                {
                    retry_without_slot(
                        state.jobs.get_mut(&candidate.id).unwrap(),
                        plan.workflow.max_retry_backoff_ms,
                        now,
                    );
                    continue;
                }
                let attempt = if candidate.turn_number == 0 {
                    candidate
                        .attempt
                        .checked_add(1)
                        .ok_or_else(|| Error::Invalid("attempt counter overflow".into()))?
                } else {
                    candidate.attempt
                };
                let prompt = match if candidate.turn_number > 0 {
                    Ok(continuation_prompt(
                        candidate.turn_number + 1,
                        plan.workflow.max_turns,
                    ))
                } else {
                    plan.workflow.render(
                        &candidate.issue,
                        (candidate.retry_attempt > 0).then_some(candidate.retry_attempt),
                    )
                } {
                    Ok(prompt) => prompt,
                    Err(error) => {
                        let job = state.jobs.get_mut(&candidate.id).unwrap();
                        job.error = Some(error.to_string());
                        job.attempt = attempt;
                        job.status = SymphonyTaskStatus::Retrying;
                        job.failures = job.failures.saturating_add(1);
                        job.retry_attempt = job.retry_attempt.saturating_add(1);
                        job.retry_at = now.saturating_add(
                            (10_000_u64
                                .saturating_mul(1 << job.retry_attempt.saturating_sub(1).min(10)))
                            .min(plan.workflow.max_retry_backoff_ms),
                        );
                        continue;
                    }
                };
                let plan = state.workflows.get(&candidate.workflow_id).unwrap();
                let job = state.jobs.get_mut(&candidate.id).unwrap();
                job.attempt = attempt;
                job.turn_number = candidate
                    .turn_number
                    .checked_add(1)
                    .ok_or_else(|| Error::Invalid("turn counter overflow".into()))?;
                job.status = SymphonyTaskStatus::Starting;
                job.progress_sequence = None;
                job.progress_at = now;
                job.timing_out = false;
                job.turn_id = None;
                job.invocation = Some(Invocation {
                    workflow: plan.workflow.clone(),
                    prompt,
                    prepared: false,
                });
                job.error = None;
                reserved.push(job.clone());
            }
            Ok(reserved)
        })
    }

    pub fn observe(&self, original: &Job, observed: Observation, now: u64) -> Result<(), Error> {
        self.mutate(|state| {
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt != original.attempt
                || job.turn_number != original.turn_number
                || !active(job.status)
            {
                return Ok(());
            }
            job.session_id = observed.session_id.or(job.session_id.clone());
            job.thread_id = observed.thread_id.or(job.thread_id.clone());
            job.turn_id = observed.turn_id.or(job.turn_id.clone());
            job.error = observed.error;
            if matches!(
                observed.status,
                SymphonyTaskStatus::Completed
                    | SymphonyTaskStatus::Retrying
                    | SymphonyTaskStatus::Paused
            ) {
                job.invocation = None;
                job.status = match job.desired {
                    SymphonyControl::Pause => SymphonyTaskStatus::Paused,
                    SymphonyControl::Complete => SymphonyTaskStatus::Completed,
                    SymphonyControl::Run
                        if job.issue.local && observed.status == SymphonyTaskStatus::Completed =>
                    {
                        SymphonyTaskStatus::Completed
                    }
                    SymphonyControl::Run => SymphonyTaskStatus::Retrying,
                };
                if job.status == SymphonyTaskStatus::Retrying {
                    let plan = state
                        .workflows
                        .get(&job.workflow_id)
                        .ok_or(Error::NotFound)?;
                    let delay = if observed.status == SymphonyTaskStatus::Completed {
                        job.failures = 0;
                        if job.turn_number < plan.workflow.max_turns {
                            // Continue the same worker batch and conversation; use the latest successfully polled tracker state.
                            job.status = SymphonyTaskStatus::Pending;
                            0
                        } else {
                            job.turn_number = 0;
                            job.worker_prepared = false;
                            job.retry_attempt = 1;
                            1000
                        }
                    } else {
                        job.turn_number = 0;
                        job.worker_prepared = false;
                        job.failures = job.failures.saturating_add(1);
                        job.retry_attempt = job.retry_attempt.saturating_add(1);
                        10_000_u64
                            .saturating_mul(1 << (job.retry_attempt.saturating_sub(1).min(10)))
                    };
                    job.retry_at =
                        now.saturating_add(delay.min(plan.workflow.max_retry_backoff_ms));
                }
            } else {
                job.status = if job.desired != SymphonyControl::Run {
                    SymphonyTaskStatus::Stopping
                } else {
                    observed.status
                };
            }
            Ok(())
        })
    }

    /// Core sequence is the progress receipt. Waiting for a person never triggers a stall retry.
    pub fn stalled(
        &self,
        original: &Job,
        sequence: u64,
        waiting: bool,
        now: u64,
    ) -> Result<bool, Error> {
        self.mutate(|state| {
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt != original.attempt
                || job.turn_number != original.turn_number
                || !active(job.status)
            {
                return Ok(false);
            }
            if job.progress_sequence != Some(sequence) || waiting {
                job.progress_sequence = Some(sequence);
                job.progress_at = now;
            }
            let limit = job
                .invocation
                .as_ref()
                .map_or(0, |invocation| invocation.workflow.stall_timeout_ms);
            if !waiting && limit > 0 && now.saturating_sub(job.progress_at) > limit {
                job.timing_out = true;
            }
            Ok(job.timing_out)
        })
    }

    pub fn timed_out(&self, original: &Job) -> Result<(), Error> {
        self.mutate(|state| {
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt == original.attempt && job.turn_number == original.turn_number {
                job.timing_out = true;
            }
            Ok(())
        })
    }

    pub fn advance_error(&self, original: &Job, error: String) -> Result<(), Error> {
        self.mutate(|state| {
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt == original.attempt
                && job.turn_number == original.turn_number
                && active(job.status)
            {
                job.error = Some(error);
            }
            Ok(())
        })
    }

    pub fn prepared(
        &self,
        original: &Job,
        session: SessionId,
        thread: ThreadId,
    ) -> Result<(), Error> {
        self.mutate(|state| {
            let job = state.jobs.get_mut(&original.id).ok_or(Error::NotFound)?;
            if job.attempt == original.attempt && job.turn_number == original.turn_number {
                job.session_id = Some(session);
                job.thread_id = Some(thread);
                job.setup_done = true;
                job.worker_prepared = true;
                if let Some(invocation) = &mut job.invocation {
                    invocation.prepared = true;
                }
            }
            Ok(())
        })
    }

    pub fn needs_host(&self) -> Result<bool, Error> {
        self.read(|state| {
            state
                .workflows
                .values()
                .any(|plan| plan.enabled && !matches!(plan.workflow.tracker, crate::Tracker::Local))
                || state.jobs.values().any(|job| {
                    active(job.status)
                        || job.cleanup_pending
                        || (matches!(
                            job.status,
                            SymphonyTaskStatus::Pending | SymphonyTaskStatus::Retrying
                        ) && state
                            .workflows
                            .get(&job.workflow_id)
                            .is_some_and(|plan| plan.enabled))
                })
        })
    }
}

pub(crate) fn active(status: SymphonyTaskStatus) -> bool {
    matches!(
        status,
        SymphonyTaskStatus::Starting
            | SymphonyTaskStatus::Running
            | SymphonyTaskStatus::Blocked
            | SymphonyTaskStatus::Stopping
    )
}

fn insert_job(state: &mut State, workflow_id: &str, issue: Issue) -> Result<(), Error> {
    if state.jobs.len() >= 2000 {
        return Err(Error::Invalid("workflow conversation limit reached".into()));
    }
    let id = identity(&format!("{workflow_id}:{}", issue.id));
    state.jobs.insert(
        id.clone(),
        Job {
            id,
            workflow_id: workflow_id.into(),
            issue,
            status: SymphonyTaskStatus::Pending,
            desired: SymphonyControl::Run,
            attempt: 0,
            turn_number: 0,
            failures: 0,
            retry_attempt: 0,
            progress_sequence: None,
            progress_at: 0,
            timing_out: false,
            session_id: None,
            thread_id: None,
            turn_id: None,
            retry_at: 0,
            error: None,
            invocation: None,
            setup_done: false,
            cleanup_pending: false,
            worker_prepared: false,
            workspace_root: None,
            tracker_retired: false,
        },
    );
    Ok(())
}

fn receipt(state: &State, command: &str, fingerprint: &str) -> Result<Option<String>, Error> {
    if command.is_empty() || command.len() > 256 {
        return Err(Error::Invalid("command identity is invalid".into()));
    }
    match state.commands.get(command) {
        Some((existing, id)) if existing == fingerprint => Ok(Some(id.clone())),
        Some(_) => Err(Error::Conflict),
        None => Ok(None),
    }
}

fn continuation_prompt(turn: u32, max_turns: u32) -> String {
    format!(
        "Continuation guidance:\n\n- The previous Codex turn completed normally, but the tracker work item is still in an active state.\n- This is continuation turn #{turn} of {max_turns} for the current agent run.\n- Resume from the current workspace and workpad state instead of restarting from scratch.\n- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.\n- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.\n"
    )
}

fn retry_without_slot(job: &mut Job, max_backoff_ms: u64, now: u64) {
    if job.status != SymphonyTaskStatus::Retrying {
        return;
    }
    job.retry_attempt = job.retry_attempt.saturating_add(1);
    job.error = Some("no available orchestrator slots".into());
    job.retry_at = now.saturating_add(
        (10_000_u64.saturating_mul(1 << job.retry_attempt.saturating_sub(1).min(10)))
            .min(max_backoff_ms),
    );
}
