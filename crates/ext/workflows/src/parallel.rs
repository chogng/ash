//! Durable facts for one parallel development run.
use core_api::CoreError;
use protocol::DelegationId;
use protocol::ThreadId;
use protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParallelTaskDefinition {
    pub id: String,
    pub goal: String,
    /// Candidate path scope; the host must still enforce filesystem access separately.
    pub allowed_paths: Vec<String>,
    pub dependencies: Vec<String>,
    pub checks: Vec<CheckPlan>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckPlan {
    pub key: String,
    pub program: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub timeout_ms: u64,
    pub environment_digest: String,
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParallelTarget {
    pub remote: String,
    pub reference: String,
    /// Commit captured by the trusted host when the run starts, not a branch name lookup.
    pub expected_oid: String,
}

/// Durable input consumed by the App Server binder before a delegated Turn is accepted.
/// The captured tree is immutable; the target object pins the worker's checkout base.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParallelBindingIntent {
    pub run_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub source_thread: ThreadId,
    pub target_oid: String,
    pub repository_trees: BTreeMap<String, String>,
}

impl ParallelBindingIntent {
    pub fn validate(&self) -> Result<(), CoreError> {
        validate_identity(&self.run_id, "run id")?;
        validate_identity(&self.task_id, "task id")?;
        validate_identity(&self.snapshot_id, "snapshot id")?;
        validate_digest(&self.snapshot_digest, "snapshot digest")?;
        validate_git_oid(&self.target_oid, "binding target commit")?;
        if self.repository_trees.len() != 1 || !self.repository_trees.contains_key(".") {
            return Err(invalid(
                "Parallel binding currently requires one primary repository tree",
            ));
        }
        for (path, tree) in &self.repository_trees {
            if path != "." {
                validate_relative_path(path)?;
            }
            validate_git_oid(tree, "binding tree")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParallelDevelopment {
    run_id: String,
    revision: u64,
    goal: String,
    baseline_tree: String,
    target: ParallelTarget,
    status: ParallelStatus,
    tasks: BTreeMap<String, ParallelTask>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ParallelCommandReceipt {
    pub development: ParallelDevelopment,
    pub outcome: ParallelMutationOutcome,
    pub replayed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParallelMutationOutcome {
    Created,
    Applied,
    EvidenceForCurrentSnapshot,
    HistoricalEvidence,
}

/// Closed command payload used for durable deduplication; each command has typed, serializable input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ParallelMutation {
    StartWorker {
        task_id: String,
        attempt: WorkerAttempt,
    },
    FinishWorker {
        task_id: String,
        thread_id: ThreadId,
        status: WorkerStatus,
    },
    RecordSnapshot {
        task_id: String,
        snapshot: ReviewSnapshot,
    },
    RecordReview {
        task_id: String,
        review: ReviewVerdict,
    },
    RecordCheck {
        task_id: String,
        check: CheckEvidence,
    },
    AcceptTask {
        task_id: String,
        snapshot_id: String,
        review_id: String,
        check_ids: Vec<String>,
        policy_revision: String,
        accepted_at_unix_ms: u64,
    },
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParallelStatus {
    Active,
    Accepted,
    Queued,
    Landing,
    Published,
    Blocked,
    Cancelling,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ParallelTask {
    id: String,
    goal: String,
    allowed_paths: Vec<String>,
    dependencies: Vec<String>,
    checks_plan: Vec<CheckPlan>,
    attempts: Vec<WorkerAttempt>,
    snapshots: Vec<ReviewSnapshot>,
    reviews: Vec<ReviewVerdict>,
    checks: Vec<CheckEvidence>,
    acceptance_history: Vec<AcceptanceRecord>,
    current_acceptance: Option<AcceptanceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerAttempt {
    pub delegation_id: DelegationId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub status: WorkerStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewSnapshot {
    pub snapshot_id: String,
    pub digest: String,
    pub base_tree: String,
    pub candidate_tree: String,
    pub source_thread: ThreadId,
    pub source_turn: TurnId,
    pub source_sequence: u64,
    pub changed_paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewFinding {
    pub severity: FindingSeverity,
    pub path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub blob_digest: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdict {
    pub review_id: String,
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub reviewer_thread: ThreadId,
    pub reviewer_turn: TurnId,
    pub decision: ReviewDecision,
    pub findings: Vec<ReviewFinding>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Passed,
    Failed,
    TimedOut,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
/// Claimed result from the host check runner; Worker text must never construct this record.
pub struct CheckEvidence {
    pub check_id: String,
    pub check_key: String,
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub command_digest: String,
    pub environment_digest: String,
    pub log_digest: Option<String>,
    pub outcome: CheckOutcome,
    pub exit_code: Option<i32>,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: Option<u64>,
    pub source_before_digest: String,
    pub source_after_digest: String,
    pub output_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptanceRecord {
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub review_id: String,
    pub check_ids: Vec<String>,
    pub policy_revision: String,
    pub accepted_at_unix_ms: u64,
}

impl CheckPlan {
    pub fn digest(&self) -> Result<String, CoreError> {
        let bytes =
            serde_json::to_vec(self).map_err(|error| CoreError::Journal(error.to_string()))?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }

    fn validate(&self) -> Result<(), CoreError> {
        validate_identity(&self.key, "check plan id")?;
        if self.program.trim().is_empty()
            || self.program.len() > 4096
            || self.program.bytes().any(|byte| byte.is_ascii_control())
            || self.arguments.len() > 256
            || self.arguments.iter().any(|argument| {
                argument.len() > 16 * 1024 || argument.bytes().any(|byte| byte == 0)
            })
        {
            return Err(invalid("Invalid executable or arguments in check plan"));
        }
        if self.program.contains('/') {
            validate_relative_path(&self.program)?;
        }
        if !self.working_directory.is_empty() {
            validate_relative_path(&self.working_directory)?;
        }
        if !(1..=24 * 60 * 60 * 1000).contains(&self.timeout_ms) {
            return Err(invalid("Check timeout must be between 1 ms and 24 hours"));
        }
        validate_digest(&self.environment_digest, "check environment digest")
    }
}

impl ParallelMutation {
    pub fn apply(
        &self,
        development: &mut ParallelDevelopment,
    ) -> Result<ParallelMutationOutcome, CoreError> {
        match self {
            Self::StartWorker { task_id, attempt } => {
                development.start_worker(task_id, attempt.clone())?;
                Ok(ParallelMutationOutcome::Applied)
            }
            Self::FinishWorker {
                task_id,
                thread_id,
                status,
            } => {
                development.finish_worker(task_id, thread_id, *status)?;
                Ok(ParallelMutationOutcome::Applied)
            }
            Self::RecordSnapshot { task_id, snapshot } => {
                development.record_snapshot(task_id, snapshot.clone())?;
                Ok(ParallelMutationOutcome::Applied)
            }
            Self::RecordReview { task_id, review } => {
                Ok(if development.record_review(task_id, review.clone())? {
                    ParallelMutationOutcome::EvidenceForCurrentSnapshot
                } else {
                    ParallelMutationOutcome::HistoricalEvidence
                })
            }
            Self::RecordCheck { task_id, check } => {
                Ok(if development.record_check(task_id, check.clone())? {
                    ParallelMutationOutcome::EvidenceForCurrentSnapshot
                } else {
                    ParallelMutationOutcome::HistoricalEvidence
                })
            }
            Self::AcceptTask {
                task_id,
                snapshot_id,
                review_id,
                check_ids,
                policy_revision,
                accepted_at_unix_ms,
            } => development
                .accept_task(
                    task_id,
                    snapshot_id,
                    review_id,
                    check_ids.clone(),
                    policy_revision.clone(),
                    *accepted_at_unix_ms,
                )
                .map(|_| ParallelMutationOutcome::Applied),
            Self::Cancel => {
                development.cancel()?;
                Ok(ParallelMutationOutcome::Applied)
            }
        }
    }
}

impl ParallelDevelopment {
    pub fn new(
        run_id: String,
        goal: String,
        baseline_tree: String,
        target: ParallelTarget,
        definitions: Vec<ParallelTaskDefinition>,
    ) -> Result<Self, CoreError> {
        validate_identity(&run_id, "run id")?;
        if goal.trim().is_empty() || goal.len() > 16 * 1024 {
            return Err(invalid(
                "Parallel development goal must contain 1 to 16384 bytes",
            ));
        }
        validate_git_oid(&baseline_tree, "baseline tree")?;
        validate_identity(&target.remote, "target remote")?;
        if target.remote != "origin" {
            return Err(invalid(
                "Parallel development currently supports only the origin remote",
            ));
        }
        validate_ref(&target.reference)?;
        validate_git_oid(&target.expected_oid, "target commit")?;
        if definitions.len() < 2 {
            return Err(invalid(
                "Parallel development requires at least two independent tasks",
            ));
        }

        let mut tasks = BTreeMap::new();
        for definition in definitions {
            validate_identity(&definition.id, "task id")?;
            if definition.goal.trim().is_empty() || definition.goal.len() > 16 * 1024 {
                return Err(invalid("Each task goal must contain 1 to 16384 bytes"));
            }
            if definition.allowed_paths.is_empty() {
                return Err(invalid("Each task requires at least one allowed path"));
            }
            let mut paths = definition.allowed_paths;
            paths.sort();
            paths.dedup();
            for path in &paths {
                validate_relative_path(path)?;
            }
            let mut dependencies = definition.dependencies;
            dependencies.sort();
            dependencies.dedup();
            if dependencies.contains(&definition.id) {
                return Err(invalid("A parallel task cannot depend on itself"));
            }
            if definition.checks.is_empty() || !definition.checks.iter().any(|check| check.required)
            {
                return Err(invalid("Each task requires at least one frozen check"));
            }
            let mut check_keys = BTreeSet::new();
            for check in &definition.checks {
                check.validate()?;
                if !check_keys.insert(check.key.as_str()) {
                    return Err(invalid("Check plan ids must be unique per task"));
                }
            }
            let task = ParallelTask {
                id: definition.id.clone(),
                goal: definition.goal,
                allowed_paths: paths,
                dependencies,
                checks_plan: definition.checks,
                attempts: Vec::new(),
                snapshots: Vec::new(),
                reviews: Vec::new(),
                checks: Vec::new(),
                acceptance_history: Vec::new(),
                current_acceptance: None,
            };
            if tasks.insert(definition.id, task).is_some() {
                return Err(invalid("Parallel task ids must be unique"));
            }
        }

        let run = Self {
            run_id,
            revision: 0,
            goal,
            baseline_tree,
            target,
            status: ParallelStatus::Active,
            tasks,
        };
        run.validate()?;
        Ok(run)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn creation_request_key(&self) -> Result<String, CoreError> {
        serde_json::to_string(&(&self.goal, &self.baseline_tree, &self.target, &self.tasks))
            .map_err(|error| CoreError::Journal(error.to_string()))
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn goal(&self) -> &str {
        &self.goal
    }

    pub fn baseline_tree(&self) -> &str {
        &self.baseline_tree
    }

    pub fn baseline_digest(&self) -> Result<String, CoreError> {
        let identity = format!(
            "{}\0{}\0{}",
            self.run_id, self.target.expected_oid, self.baseline_tree
        );
        Ok(format!("sha256:{:x}", Sha256::digest(identity.as_bytes())))
    }

    pub fn target(&self) -> &ParallelTarget {
        &self.target
    }

    pub fn status(&self) -> ParallelStatus {
        self.status
    }

    pub fn tasks(&self) -> &BTreeMap<String, ParallelTask> {
        &self.tasks
    }

    pub fn task(&self, task_id: &str) -> Result<&ParallelTask, CoreError> {
        self.tasks
            .get(task_id)
            .ok_or_else(|| invalid("Unknown parallel task"))
    }

    pub fn start_worker(&mut self, task_id: &str, attempt: WorkerAttempt) -> Result<(), CoreError> {
        self.ensure_active()?;
        if attempt.status != WorkerStatus::Running {
            return Err(invalid("A new Worker attempt must be running"));
        }
        let dependencies = self.task(task_id)?.dependencies.clone();
        if dependencies.iter().any(|dependency| {
            self.tasks
                .get(dependency)
                .is_none_or(|task| task.current_acceptance.is_none())
        }) {
            return Err(invalid(
                "Task dependencies must be accepted before starting a Worker",
            ));
        }
        if self
            .tasks
            .values()
            .flat_map(|task| &task.attempts)
            .any(|previous| {
                previous.delegation_id == attempt.delegation_id
                    || previous.thread_id == attempt.thread_id
                    || previous.turn_id == attempt.turn_id
            })
        {
            return Err(invalid("Worker identity is already recorded in this run"));
        }
        let task = self.task_mut(task_id)?;
        if task
            .attempts
            .last()
            .is_some_and(|previous| previous.status == WorkerStatus::Running)
        {
            return Err(invalid("A task can have only one active Worker attempt"));
        }
        if task
            .attempts
            .iter()
            .any(|previous| previous.thread_id == attempt.thread_id)
        {
            return Err(invalid("Worker repair requires a new Thread"));
        }
        task.attempts.push(attempt);
        task.current_acceptance = None;
        self.status = ParallelStatus::Active;
        Ok(())
    }

    pub fn finish_worker(
        &mut self,
        task_id: &str,
        thread_id: &ThreadId,
        status: WorkerStatus,
    ) -> Result<(), CoreError> {
        if !matches!(
            self.status,
            ParallelStatus::Active | ParallelStatus::Cancelling
        ) {
            return Err(invalid("Parallel development is not active or cancelling"));
        }
        if status == WorkerStatus::Running {
            return Err(invalid("A finished Worker must have a terminal status"));
        }
        let task = self.task_mut(task_id)?;
        let attempt = task
            .attempts
            .last_mut()
            .filter(|attempt| &attempt.thread_id == thread_id)
            .ok_or_else(|| invalid("Worker result does not match the current attempt"))?;
        if attempt.status != WorkerStatus::Running {
            return Err(invalid("Worker attempt has already finished"));
        }
        attempt.status = status;
        if self.status == ParallelStatus::Cancelling
            && self
                .tasks
                .values()
                .flat_map(|task| &task.attempts)
                .all(|attempt| attempt.status != WorkerStatus::Running)
        {
            self.status = ParallelStatus::Cancelled;
        }
        Ok(())
    }

    pub fn record_snapshot(
        &mut self,
        task_id: &str,
        snapshot: ReviewSnapshot,
    ) -> Result<(), CoreError> {
        self.ensure_active()?;
        validate_identity(&snapshot.snapshot_id, "snapshot id")?;
        validate_digest(&snapshot.digest, "snapshot digest")?;
        validate_git_oid(&snapshot.base_tree, "snapshot base tree")?;
        validate_git_oid(&snapshot.candidate_tree, "snapshot candidate tree")?;
        for path in &snapshot.changed_paths {
            validate_relative_path(path)?;
            let task = self.task(task_id)?;
            if !task
                .allowed_paths
                .iter()
                .any(|allowed| path_contains(allowed, path))
            {
                return Err(invalid(
                    "Snapshot contains a path outside the task's allowed scope",
                ));
            }
        }
        if snapshot.changed_paths.is_empty() || snapshot.source_sequence == 0 {
            return Err(invalid("Snapshot must capture at least one changed path"));
        }
        if snapshot.base_tree != self.baseline_tree {
            return Err(invalid("Snapshot base tree differs from the run baseline"));
        }
        let task = self.task_mut(task_id)?;
        let current_worker = task
            .attempts
            .last()
            .filter(|worker| {
                matches!(
                    worker.status,
                    WorkerStatus::Running | WorkerStatus::Completed
                )
            })
            .ok_or_else(|| invalid("Cannot capture a task without a live Worker attempt"))?;
        if current_worker.thread_id != snapshot.source_thread
            || current_worker.turn_id != snapshot.source_turn
        {
            return Err(invalid(
                "Snapshot source does not match the current Worker attempt",
            ));
        }
        if task.snapshots.last().is_some_and(|previous| {
            previous.source_thread == snapshot.source_thread
                && previous.source_turn == snapshot.source_turn
                && snapshot.source_sequence <= previous.source_sequence
        }) {
            return Err(invalid(
                "Snapshot sequence must advance within a Worker attempt",
            ));
        }
        if task
            .snapshots
            .iter()
            .any(|previous| previous.snapshot_id == snapshot.snapshot_id)
        {
            return Err(invalid("Snapshot id is already recorded"));
        }
        task.snapshots.push(snapshot);
        task.current_acceptance = None;
        self.status = ParallelStatus::Active;
        Ok(())
    }

    pub fn record_review(
        &mut self,
        task_id: &str,
        review: ReviewVerdict,
    ) -> Result<bool, CoreError> {
        self.ensure_active()?;
        validate_identity(&review.review_id, "review id")?;
        validate_digest(&review.snapshot_digest, "review snapshot digest")?;
        let current = {
            let task = self.task_mut(task_id)?;
            if task
                .reviews
                .iter()
                .any(|previous| previous.review_id == review.review_id)
            {
                return Err(invalid("Review id is already recorded"));
            }
            let snapshot = task
                .snapshots
                .iter()
                .find(|snapshot| snapshot.snapshot_id == review.snapshot_id)
                .ok_or_else(|| invalid("Review references an unknown snapshot"))?;
            if snapshot.digest != review.snapshot_digest {
                return Err(invalid(
                    "Review snapshot digest does not match the captured snapshot",
                ));
            }
            if task
                .attempts
                .last()
                .is_some_and(|worker| worker.thread_id == review.reviewer_thread)
            {
                return Err(invalid("A Worker cannot review its own candidate"));
            }
            for finding in &review.findings {
                validate_relative_path(&finding.path)?;
                if !task
                    .allowed_paths
                    .iter()
                    .any(|path| path_contains(path, &finding.path))
                {
                    return Err(invalid(
                        "Review finding is outside the task's allowed paths",
                    ));
                }
                if finding.line_start == 0 || finding.line_end < finding.line_start {
                    return Err(invalid("Review finding has an invalid line range"));
                }
                validate_digest(&finding.blob_digest, "finding blob digest")?;
                if finding.message.trim().is_empty() || finding.message.len() > 8192 {
                    return Err(invalid(
                        "Review finding message must contain 1 to 8192 bytes",
                    ));
                }
            }
            let current = task.snapshots.last().is_some_and(|candidate| {
                candidate.snapshot_id == review.snapshot_id
                    && candidate.digest == review.snapshot_digest
            });
            if current {
                task.current_acceptance = None;
            }
            task.reviews.push(review);
            current
        };
        if current {
            self.status = ParallelStatus::Active;
        }
        Ok(current)
    }

    pub fn record_check(&mut self, task_id: &str, check: CheckEvidence) -> Result<bool, CoreError> {
        self.ensure_active()?;
        validate_identity(&check.check_id, "check id")?;
        validate_identity(&check.check_key, "check plan id")?;
        validate_digest(&check.snapshot_digest, "check snapshot digest")?;
        validate_digest(&check.command_digest, "check command digest")?;
        validate_digest(&check.environment_digest, "check environment digest")?;
        validate_digest(&check.source_before_digest, "source-before digest")?;
        validate_digest(&check.source_after_digest, "source-after digest")?;
        if let Some(log_digest) = &check.log_digest {
            validate_digest(log_digest, "check log digest")?;
        }
        if check
            .finished_at_unix_ms
            .is_some_and(|finished| finished < check.started_at_unix_ms)
        {
            return Err(invalid("Check finished before it started"));
        }
        if check.outcome == CheckOutcome::Passed
            && (check.exit_code != Some(0)
                || check.finished_at_unix_ms.is_none()
                || check.log_digest.is_none()
                || check.output_truncated
                || check.source_before_digest != check.source_after_digest)
        {
            return Err(invalid(
                "A passing check requires exit 0, complete logs, and an unchanged source tree",
            ));
        }
        let current = {
            let task = self.task_mut(task_id)?;
            let plan = task
                .checks_plan
                .iter()
                .find(|plan| plan.key == check.check_key)
                .ok_or_else(|| invalid("Check is not part of the frozen plan"))?;
            if check.command_digest != plan.digest()?
                || check.environment_digest != plan.environment_digest
            {
                return Err(invalid(
                    "Check command or environment differs from the frozen plan",
                ));
            }
            if task
                .checks
                .iter()
                .any(|previous| previous.check_id == check.check_id)
            {
                return Err(invalid("Check id is already recorded"));
            }
            let snapshot = task
                .snapshots
                .iter()
                .find(|snapshot| snapshot.snapshot_id == check.snapshot_id)
                .ok_or_else(|| invalid("Check references an unknown snapshot"))?;
            if snapshot.digest != check.snapshot_digest {
                return Err(invalid(
                    "Check snapshot digest does not match the captured snapshot",
                ));
            }
            let current = task.snapshots.last().is_some_and(|candidate| {
                candidate.snapshot_id == check.snapshot_id
                    && candidate.digest == check.snapshot_digest
            });
            if current {
                task.current_acceptance = None;
            }
            task.checks.push(check);
            current
        };
        if current {
            self.status = ParallelStatus::Active;
        }
        Ok(current)
    }

    pub fn accept_task(
        &mut self,
        task_id: &str,
        snapshot_id: &str,
        review_id: &str,
        check_ids: Vec<String>,
        policy_revision: String,
        accepted_at_unix_ms: u64,
    ) -> Result<AcceptanceRecord, CoreError> {
        self.ensure_active()?;
        if policy_revision.trim().is_empty() || policy_revision.len() > 256 {
            return Err(invalid("Acceptance requires a policy revision"));
        }
        let dependencies = self.task(task_id)?.dependencies.clone();
        if dependencies.iter().any(|dependency| {
            self.tasks
                .get(dependency)
                .is_none_or(|task| task.current_acceptance.is_none())
        }) {
            return Err(invalid("Task dependencies must be accepted first"));
        }
        let task = self.task_mut(task_id)?;
        let snapshot = task
            .snapshots
            .last()
            .filter(|snapshot| snapshot.snapshot_id == snapshot_id)
            .ok_or_else(|| invalid("Acceptance must target the latest snapshot"))?;
        if check_ids.is_empty() {
            return Err(invalid("Acceptance requires at least one real check"));
        }
        let review = task
            .reviews
            .iter()
            .rev()
            .find(|review| review.review_id == review_id)
            .ok_or_else(|| invalid("Acceptance requires a recorded review"))?;
        if review.snapshot_id != snapshot.snapshot_id
            || review.snapshot_digest != snapshot.digest
            || task
                .reviews
                .iter()
                .rev()
                .find(|candidate| candidate.snapshot_id == snapshot.snapshot_id)
                .is_none_or(|latest| latest.review_id != review.review_id)
            || review.decision != ReviewDecision::Approved
            || review
                .findings
                .iter()
                .any(|finding| finding.severity == FindingSeverity::Error)
        {
            return Err(invalid(
                "Acceptance requires an approving review of the latest snapshot",
            ));
        }
        let mut unique_checks = BTreeSet::new();
        let mut covered_plan_checks = BTreeSet::new();
        for check_id in &check_ids {
            if !unique_checks.insert(check_id) {
                return Err(invalid("Acceptance check ids must be unique"));
            }
            let check = task
                .checks
                .iter()
                .rev()
                .find(|check| &check.check_id == check_id)
                .ok_or_else(|| invalid("Acceptance references a missing check"))?;
            if check.snapshot_id != snapshot.snapshot_id
                || check.snapshot_digest != snapshot.digest
                || check.outcome != CheckOutcome::Passed
                || !check.is_complete_pass()
            {
                return Err(invalid(
                    "Acceptance requires passing checks of the latest snapshot",
                ));
            }
            let latest_for_key = task
                .checks
                .iter()
                .rev()
                .find(|candidate| candidate.check_key == check.check_key)
                .ok_or_else(|| invalid("Required check evidence disappeared"))?;
            if latest_for_key.check_id != check.check_id {
                return Err(invalid("Acceptance cannot use superseded check evidence"));
            }
            if !covered_plan_checks.insert(check.check_key.as_str()) {
                return Err(invalid(
                    "Acceptance may use only one result per required check",
                ));
            }
        }
        if task
            .checks_plan
            .iter()
            .filter(|plan| plan.required)
            .any(|required| !covered_plan_checks.contains(required.key.as_str()))
        {
            return Err(invalid(
                "Acceptance is missing a required check from the frozen plan",
            ));
        }
        let current_worker = task
            .attempts
            .last()
            .ok_or_else(|| invalid("Acceptance requires a Worker attempt"))?;
        if current_worker.thread_id != snapshot.source_thread
            || current_worker.turn_id != snapshot.source_turn
            || current_worker.status != WorkerStatus::Completed
        {
            return Err(invalid(
                "Acceptance requires a completed Worker for the latest snapshot",
            ));
        }
        let record = AcceptanceRecord {
            snapshot_id: snapshot.snapshot_id.clone(),
            snapshot_digest: snapshot.digest.clone(),
            review_id: review.review_id.clone(),
            check_ids,
            policy_revision,
            accepted_at_unix_ms,
        };
        task.acceptance_history.push(record.clone());
        task.current_acceptance = Some(record.clone());
        if self
            .tasks
            .values()
            .all(|task| task.current_acceptance.is_some())
        {
            self.status = ParallelStatus::Accepted;
        }
        Ok(record)
    }

    pub fn block(&mut self) -> Result<(), CoreError> {
        self.ensure_active()?;
        self.status = ParallelStatus::Blocked;
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), CoreError> {
        if matches!(
            self.status,
            ParallelStatus::Published | ParallelStatus::Cancelling | ParallelStatus::Cancelled
        ) {
            return Err(invalid(
                "Published or cancelled development cannot be cancelled",
            ));
        }
        self.status = if self
            .tasks
            .values()
            .flat_map(|task| &task.attempts)
            .any(|attempt| attempt.status == WorkerStatus::Running)
        {
            ParallelStatus::Cancelling
        } else {
            ParallelStatus::Cancelled
        };
        Ok(())
    }

    pub(crate) fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }

    fn task_mut(&mut self, task_id: &str) -> Result<&mut ParallelTask, CoreError> {
        self.tasks
            .get_mut(task_id)
            .ok_or_else(|| invalid("Unknown parallel task"))
    }

    fn ensure_active(&self) -> Result<(), CoreError> {
        if self.status != ParallelStatus::Active {
            return Err(invalid("Parallel development is not active"));
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), CoreError> {
        validate_identity(&self.run_id, "run id")?;
        validate_git_oid(&self.baseline_tree, "baseline tree")?;
        validate_ref(&self.target.reference)?;
        if self.target.remote != "origin" {
            return Err(invalid(
                "Parallel development currently supports only the origin remote",
            ));
        }
        validate_git_oid(&self.target.expected_oid, "target commit")?;
        if self.tasks.len() < 2 {
            return Err(invalid(
                "Parallel development requires at least two independent tasks",
            ));
        }
        let mut definitions = Vec::with_capacity(self.tasks.len());
        for (task_id, task) in &self.tasks {
            if task_id != &task.id {
                return Err(invalid("Parallel task key does not match its identity"));
            }
            definitions.push(ParallelTaskDefinition {
                id: task.id.clone(),
                goal: task.goal.clone(),
                allowed_paths: task.allowed_paths.clone(),
                dependencies: task.dependencies.clone(),
                checks: task.checks_plan.clone(),
            });
            let mut check_keys = BTreeSet::new();
            for check in &task.checks_plan {
                check.validate()?;
                if !check_keys.insert(check.key.as_str()) {
                    return Err(invalid("Stored check plan ids must be unique"));
                }
            }
            if !task.checks_plan.iter().any(|check| check.required) {
                return Err(invalid("Stored task has no required check"));
            }
            let mut snapshot_ids = BTreeSet::new();
            for snapshot in &task.snapshots {
                validate_identity(&snapshot.snapshot_id, "snapshot id")?;
                validate_digest(&snapshot.digest, "snapshot digest")?;
                validate_git_oid(&snapshot.base_tree, "snapshot base tree")?;
                validate_git_oid(&snapshot.candidate_tree, "snapshot candidate tree")?;
                if snapshot.base_tree != self.baseline_tree || snapshot.changed_paths.is_empty() {
                    return Err(invalid(
                        "Stored snapshot has an invalid base tree or empty scope",
                    ));
                }
                if !snapshot_ids.insert(snapshot.snapshot_id.as_str()) {
                    return Err(invalid("Stored snapshot ids must be unique per task"));
                }
                for path in &snapshot.changed_paths {
                    validate_relative_path(path)?;
                    if !task
                        .allowed_paths
                        .iter()
                        .any(|allowed| path_contains(allowed, path))
                    {
                        return Err(invalid("Stored snapshot exceeds its task path scope"));
                    }
                }
                if !task.attempts.iter().any(|attempt| {
                    attempt.thread_id == snapshot.source_thread
                        && attempt.turn_id == snapshot.source_turn
                }) {
                    return Err(invalid("Stored snapshot has no matching Worker attempt"));
                }
            }
            let mut review_ids = BTreeSet::new();
            for review in &task.reviews {
                if !review_ids.insert(review.review_id.as_str()) {
                    return Err(invalid("Stored review ids must be unique per task"));
                }
                let snapshot = task
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot.snapshot_id == review.snapshot_id)
                    .ok_or_else(|| invalid("Stored review references a missing snapshot"))?;
                if snapshot.digest != review.snapshot_digest {
                    return Err(invalid("Stored review digest does not match its snapshot"));
                }
                validate_digest(&review.snapshot_digest, "review snapshot digest")?;
                for finding in &review.findings {
                    validate_relative_path(&finding.path)?;
                    validate_digest(&finding.blob_digest, "finding blob digest")?;
                    if finding.line_start == 0
                        || finding.line_end < finding.line_start
                        || finding.message.trim().is_empty()
                        || !task
                            .allowed_paths
                            .iter()
                            .any(|path| path_contains(path, &finding.path))
                    {
                        return Err(invalid(
                            "Stored review finding is invalid or outside task scope",
                        ));
                    }
                }
            }
            let mut check_ids = BTreeSet::new();
            for check in &task.checks {
                if !check_ids.insert(check.check_id.as_str()) {
                    return Err(invalid("Stored check ids must be unique per task"));
                }
                let snapshot = task
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot.snapshot_id == check.snapshot_id)
                    .ok_or_else(|| invalid("Stored check references a missing snapshot"))?;
                if snapshot.digest != check.snapshot_digest {
                    return Err(invalid("Stored check digest does not match its snapshot"));
                }
                let plan = task
                    .checks_plan
                    .iter()
                    .find(|plan| plan.key == check.check_key)
                    .ok_or_else(|| invalid("Stored check is missing from its plan"))?;
                if check.command_digest != plan.digest()?
                    || check.environment_digest != plan.environment_digest
                {
                    return Err(invalid("Stored check differs from its frozen plan"));
                }
                validate_digest(&check.command_digest, "check command digest")?;
                validate_digest(&check.environment_digest, "check environment digest")?;
                validate_digest(&check.source_before_digest, "source-before digest")?;
                validate_digest(&check.source_after_digest, "source-after digest")?;
                if let Some(log_digest) = &check.log_digest {
                    validate_digest(log_digest, "check log digest")?;
                }
                if check.outcome == CheckOutcome::Passed && !check.is_complete_pass() {
                    return Err(invalid("Stored passing check evidence is incomplete"));
                }
            }
            if let Some(acceptance) = &task.current_acceptance {
                if !task.acceptance_history.contains(acceptance) {
                    return Err(invalid("Current acceptance is missing from its history"));
                }
                let snapshot = task
                    .snapshots
                    .last()
                    .ok_or_else(|| invalid("Current acceptance has no candidate snapshot"))?;
                let review = task
                    .reviews
                    .iter()
                    .find(|review| review.review_id == acceptance.review_id)
                    .ok_or_else(|| invalid("Current acceptance has no review"))?;
                if snapshot.snapshot_id != acceptance.snapshot_id
                    || snapshot.digest != acceptance.snapshot_digest
                    || review.snapshot_id != snapshot.snapshot_id
                    || review.snapshot_digest != snapshot.digest
                    || review.decision != ReviewDecision::Approved
                {
                    return Err(invalid(
                        "Current acceptance does not match the latest candidate",
                    ));
                }
                for check_id in &acceptance.check_ids {
                    let check = task
                        .checks
                        .iter()
                        .find(|check| &check.check_id == check_id)
                        .ok_or_else(|| invalid("Current acceptance has missing check evidence"))?;
                    if check.snapshot_id != snapshot.snapshot_id
                        || check.snapshot_digest != snapshot.digest
                        || !check.is_complete_pass()
                    {
                        return Err(invalid(
                            "Current acceptance has stale or incomplete check evidence",
                        ));
                    }
                }
            }
        }
        validate_task_graph(&definitions)?;
        if definitions
            .iter()
            .filter(|definition| definition.dependencies.is_empty())
            .count()
            < 2
        {
            return Err(invalid(
                "Parallel development requires at least two concurrently startable tasks",
            ));
        }
        if self.status == ParallelStatus::Accepted
            && !self
                .tasks
                .values()
                .all(|task| task.current_acceptance.is_some())
        {
            return Err(invalid("Accepted run is missing an accepted task"));
        }
        if self.status == ParallelStatus::Cancelled
            && self
                .tasks
                .values()
                .flat_map(|task| &task.attempts)
                .any(|attempt| attempt.status == WorkerStatus::Running)
        {
            return Err(invalid("Cancelled run still has a running Worker"));
        }
        Ok(())
    }
}

impl ParallelTask {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn goal(&self) -> &str {
        &self.goal
    }
    pub fn allowed_paths(&self) -> &[String] {
        &self.allowed_paths
    }
    pub fn dependencies(&self) -> &[String] {
        &self.dependencies
    }
    pub fn checks_plan(&self) -> &[CheckPlan] {
        &self.checks_plan
    }
    pub fn attempts(&self) -> &[WorkerAttempt] {
        &self.attempts
    }
    pub fn snapshots(&self) -> &[ReviewSnapshot] {
        &self.snapshots
    }
    pub fn reviews(&self) -> &[ReviewVerdict] {
        &self.reviews
    }
    pub fn checks(&self) -> &[CheckEvidence] {
        &self.checks
    }
    pub fn acceptance(&self) -> Option<&AcceptanceRecord> {
        self.current_acceptance.as_ref()
    }
    pub fn acceptance_history(&self) -> &[AcceptanceRecord] {
        &self.acceptance_history
    }
}

impl CheckEvidence {
    fn is_complete_pass(&self) -> bool {
        self.outcome == CheckOutcome::Passed
            && self.exit_code == Some(0)
            && self.finished_at_unix_ms.is_some()
            && self.log_digest.is_some()
            && !self.output_truncated
            && self.source_before_digest == self.source_after_digest
    }
}

fn validate_task_graph(definitions: &[ParallelTaskDefinition]) -> Result<(), CoreError> {
    let mut ids = BTreeSet::new();
    let mut paths: Vec<(&str, &str)> = Vec::new();
    for definition in definitions {
        validate_identity(&definition.id, "task id")?;
        if !ids.insert(definition.id.as_str()) {
            return Err(invalid("Parallel task ids must be unique"));
        }
        if definition.allowed_paths.is_empty() {
            return Err(invalid("Each task requires at least one allowed path"));
        }
        for path in &definition.allowed_paths {
            validate_relative_path(path)?;
            for (other_task, other_path) in &paths {
                if *other_task != definition.id.as_str() && paths_overlap(other_path, path) {
                    return Err(invalid("Parallel task path scopes must not overlap"));
                }
            }
            paths.push((definition.id.as_str(), path.as_str()));
        }
    }
    for definition in definitions {
        for dependency in &definition.dependencies {
            if !ids.contains(dependency.as_str()) {
                return Err(invalid(
                    "Parallel task dependency references an unknown task",
                ));
            }
        }
    }
    fn visit(
        id: &str,
        definitions: &BTreeMap<&str, &ParallelTaskDefinition>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<(), CoreError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_string()) {
            return Err(invalid("Parallel task dependencies contain a cycle"));
        }
        let definition = definitions
            .get(id)
            .ok_or_else(|| invalid("Unknown parallel task"))?;
        for dependency in &definition.dependencies {
            visit(dependency, definitions, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    let by_id = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<BTreeMap<_, _>>();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in ids {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || value == "."
        || value == ".."
    {
        return Err(invalid(&format!("Invalid {label}")));
    }
    Ok(())
}

fn validate_ref(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains("..")
        || value.contains("@{")
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
    {
        return Err(invalid("Invalid target ref"));
    }
    Ok(())
}

fn validate_git_oid(value: &str, label: &str) -> Result<(), CoreError> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(&format!("Invalid {label} object id")));
    }
    Ok(())
}

fn validate_digest(value: &str, label: &str) -> Result<(), CoreError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(invalid(&format!("Invalid {label}")));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(&format!("Invalid {label}")));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(invalid("Invalid relative path"));
    }
    let components = value.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == "." || *component == "..")
        || components
            .iter()
            .any(|component| component.eq_ignore_ascii_case(".git"))
    {
        return Err(invalid(
            "Relative path escapes or targets protected Git metadata",
        ));
    }
    Ok(())
}

fn paths_overlap(left: &str, right: &str) -> bool {
    path_contains(left, right) || path_contains(right, left)
}

fn path_contains(parent: &str, child: &str) -> bool {
    parent == child
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn invalid(message: &str) -> CoreError {
    CoreError::InvalidInput(message.into())
}

#[cfg(test)]
#[path = "parallel_tests.rs"]
mod tests;
