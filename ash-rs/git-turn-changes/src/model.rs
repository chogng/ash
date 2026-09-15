use ash_protocol::ContentDigest;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;

const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;

/// Stable identity for one Turn/repository change set.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ChangeSetId(String);

impl ChangeSetId {
    pub fn new(value: impl Into<String>) -> Result<Self, TurnChangeError> {
        let value = value.into();
        if value.is_empty() || value.contains('\0') {
            return Err(TurnChangeError::InvalidIdentity);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ChangeSetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Open,
    Sealed,
    Incomplete,
    Discarded,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageState {
    Unconfigured,
    Queued,
    Generating,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CommitState {
    Idle,
    Queued,
    Committing,
    Committed { object_id: String },
    Conflict { paths: Vec<PathBuf> },
    Failed { message: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalTurnState {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeFileKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFile {
    pub path: PathBuf,
    pub previous_path: Option<PathBuf>,
    pub kind: ChangeFileKind,
    pub before_object_id: Option<String>,
    pub after_object_id: Option<String>,
    pub before_mode: Option<String>,
    pub after_mode: Option<String>,
    pub binary: bool,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnChangeSetDraft {
    pub change_set_id: ChangeSetId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub repository_id: String,
    pub worktree_root: PathBuf,
    pub target_branch: Option<String>,
    pub base_object_id: Option<String>,
    pub before_tree: String,
    pub baseline_dependency_paths: BTreeSet<PathBuf>,
    pub message_state: MessageState,
}

/// Durable net change produced by one Turn in one repository.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeSet {
    pub change_set_id: ChangeSetId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub repository_id: String,
    pub worktree_root: PathBuf,
    pub target_branch: Option<String>,
    pub base_object_id: Option<String>,
    pub before_tree: String,
    pub after_tree: Option<String>,
    pub capture_state: CaptureState,
    pub message_state: MessageState,
    pub commit_state: CommitState,
    pub terminal_state: Option<TerminalTurnState>,
    pub files: Vec<ChangeFile>,
    pub dependencies: BTreeSet<ChangeSetId>,
    #[serde(default)]
    pub baseline_dependency_paths: BTreeSet<PathBuf>,
    #[serde(default)]
    pub external_dependency_paths: BTreeSet<PathBuf>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub read_paths: BTreeSet<PathBuf>,
    #[serde(default)]
    pub write_paths: BTreeSet<PathBuf>,
    #[serde(default)]
    pub opaque_dependencies: bool,
    #[serde(default)]
    pub attribution_incomplete: bool,
    pub generated_message: Option<String>,
    pub draft_message: Option<String>,
    pub draft_edited: bool,
    pub revision: u64,
}

impl TurnChangeSet {
    pub fn open(draft: TurnChangeSetDraft) -> Result<Self, TurnChangeError> {
        if draft.repository_id.is_empty()
            || draft.worktree_root.as_os_str().is_empty()
            || draft.before_tree.is_empty()
        {
            return Err(TurnChangeError::InvalidSnapshot);
        }
        Ok(Self {
            change_set_id: draft.change_set_id,
            session_id: draft.session_id,
            thread_id: draft.thread_id,
            turn_id: draft.turn_id,
            repository_id: draft.repository_id,
            worktree_root: draft.worktree_root,
            target_branch: draft.target_branch,
            base_object_id: draft.base_object_id,
            before_tree: draft.before_tree,
            after_tree: None,
            capture_state: CaptureState::Open,
            message_state: draft.message_state,
            commit_state: CommitState::Idle,
            terminal_state: None,
            files: Vec::new(),
            dependencies: BTreeSet::new(),
            baseline_dependency_paths: draft.baseline_dependency_paths,
            external_dependency_paths: BTreeSet::new(),
            warnings: Vec::new(),
            read_paths: BTreeSet::new(),
            write_paths: BTreeSet::new(),
            opaque_dependencies: false,
            attribution_incomplete: false,
            generated_message: None,
            draft_message: None,
            draft_edited: false,
            revision: 1,
        })
    }

    /// Stable identity of the sealed code and attribution evidence.
    ///
    /// Commit-message and publication state are deliberately excluded because they can change
    /// after a Turn has sealed without changing the candidate result.
    pub fn evidence_digest(&self) -> Result<ContentDigest, TurnChangeError> {
        self.require_capture(CaptureState::Sealed)?;
        let identity = (
            &self.change_set_id,
            &self.session_id,
            &self.thread_id,
            &self.turn_id,
            &self.repository_id,
            &self.target_branch,
            &self.base_object_id,
        );
        let effects = (
            &self.before_tree,
            &self.after_tree,
            "git",
            &self.terminal_state,
            &self.files,
            &self.dependencies,
            &self.baseline_dependency_paths,
            &self.external_dependency_paths,
            &self.read_paths,
            &self.write_paths,
            self.opaque_dependencies,
            self.attribution_incomplete,
        );
        let encoded = serde_json::to_vec(&(1_u32, identity, effects))
            .map_err(|error| TurnChangeError::EvidenceEncoding(error.to_string()))?;
        Ok(ContentDigest::sha256(&encoded))
    }

    pub fn seal(
        &mut self,
        after_tree: String,
        terminal_state: TerminalTurnState,
        files: Vec<ChangeFile>,
        dependencies: BTreeSet<ChangeSetId>,
    ) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Open)?;
        if after_tree.is_empty() {
            return Err(TurnChangeError::InvalidSnapshot);
        }
        self.after_tree = Some(after_tree);
        self.terminal_state = Some(terminal_state);
        self.files = files;
        self.dependencies = dependencies;
        self.capture_state = CaptureState::Sealed;
        self.bump_revision()
    }

    pub fn mark_incomplete(&mut self, warning: String) -> Result<(), TurnChangeError> {
        if matches!(self.capture_state, CaptureState::Discarded) {
            return Err(TurnChangeError::InvalidTransition);
        }
        if warning.trim().is_empty() {
            return Err(TurnChangeError::InvalidWarning);
        }
        self.capture_state = CaptureState::Incomplete;
        self.warnings.push(warning);
        self.bump_revision()
    }

    pub fn seal_incomplete(
        &mut self,
        after_tree: String,
        terminal_state: TerminalTurnState,
        files: Vec<ChangeFile>,
        dependencies: BTreeSet<ChangeSetId>,
        warning: String,
    ) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Open)?;
        if after_tree.is_empty() {
            return Err(TurnChangeError::InvalidSnapshot);
        }
        if warning.trim().is_empty() {
            return Err(TurnChangeError::InvalidWarning);
        }
        self.after_tree = Some(after_tree);
        self.terminal_state = Some(terminal_state);
        self.files = files;
        self.dependencies = dependencies;
        self.capture_state = CaptureState::Incomplete;
        self.warnings.push(warning);
        self.bump_revision()
    }

    pub fn record_tool_scope(
        &mut self,
        read_paths: impl IntoIterator<Item = PathBuf>,
        write_paths: impl IntoIterator<Item = PathBuf>,
        opaque_dependencies: bool,
    ) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Open)?;
        self.read_paths.extend(read_paths);
        self.write_paths.extend(write_paths);
        self.opaque_dependencies |= opaque_dependencies;
        let referenced = self
            .read_paths
            .iter()
            .chain(self.write_paths.iter())
            .collect::<BTreeSet<_>>();
        self.external_dependency_paths.extend(
            self.baseline_dependency_paths
                .iter()
                .filter(|candidate| {
                    opaque_dependencies
                        || referenced.iter().any(|path| paths_overlap(candidate, path))
                })
                .cloned(),
        );
        self.bump_revision()
    }

    pub fn record_ambiguous_write(&mut self, warning: String) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Open)?;
        if warning.trim().is_empty() {
            return Err(TurnChangeError::InvalidWarning);
        }
        self.attribution_incomplete = true;
        self.warnings.push(warning);
        self.bump_revision()
    }

    pub fn refresh_open_files(&mut self, files: Vec<ChangeFile>) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Open)?;
        if self.files == files {
            return Ok(());
        }
        self.files = files;
        self.bump_revision()
    }

    pub fn queue_message(&mut self) -> Result<(), TurnChangeError> {
        self.require_sealed()?;
        if self.files.is_empty() {
            return Err(TurnChangeError::NoChanges);
        }
        self.message_state = MessageState::Queued;
        self.bump_revision()
    }

    pub fn begin_message_generation(&mut self) -> Result<(), TurnChangeError> {
        if self.message_state != MessageState::Queued {
            return Err(TurnChangeError::InvalidTransition);
        }
        self.message_state = MessageState::Generating;
        self.bump_revision()
    }

    pub fn finish_message_generation(&mut self, message: String) -> Result<(), TurnChangeError> {
        if self.message_state != MessageState::Generating {
            return Err(TurnChangeError::InvalidTransition);
        }
        validate_message(&message)?;
        self.generated_message = Some(message.clone());
        if !self.draft_edited {
            self.draft_message = Some(message);
        }
        self.message_state = MessageState::Ready;
        self.bump_revision()
    }

    pub fn fail_message_generation(&mut self, warning: String) -> Result<(), TurnChangeError> {
        if !matches!(
            self.message_state,
            MessageState::Queued | MessageState::Generating
        ) {
            return Err(TurnChangeError::InvalidTransition);
        }
        if warning.trim().is_empty() {
            return Err(TurnChangeError::InvalidWarning);
        }
        self.message_state = MessageState::Failed;
        self.warnings.push(warning);
        self.bump_revision()
    }

    pub fn update_draft(&mut self, message: String) -> Result<(), TurnChangeError> {
        validate_message(&message)?;
        self.draft_message = Some(message);
        self.draft_edited = true;
        self.bump_revision()
    }

    pub fn queue_commit(&mut self) -> Result<(), TurnChangeError> {
        self.require_committable()?;
        self.commit_state = CommitState::Queued;
        self.bump_revision()
    }

    pub fn begin_commit(&mut self) -> Result<(), TurnChangeError> {
        if self.commit_state != CommitState::Queued {
            return Err(TurnChangeError::InvalidTransition);
        }
        self.commit_state = CommitState::Committing;
        self.bump_revision()
    }

    pub fn finish_commit(&mut self, object_id: String) -> Result<(), TurnChangeError> {
        if self.commit_state != CommitState::Committing || object_id.is_empty() {
            return Err(TurnChangeError::InvalidTransition);
        }
        self.commit_state = CommitState::Committed { object_id };
        self.bump_revision()
    }

    pub fn fail_commit(
        &mut self,
        conflict_paths: Vec<PathBuf>,
        message: String,
    ) -> Result<(), TurnChangeError> {
        if !matches!(
            self.commit_state,
            CommitState::Queued | CommitState::Committing
        ) {
            return Err(TurnChangeError::InvalidTransition);
        }
        self.commit_state = if conflict_paths.is_empty() {
            CommitState::Failed { message }
        } else {
            CommitState::Conflict {
                paths: conflict_paths,
            }
        };
        self.bump_revision()
    }

    pub fn discard(&mut self) -> Result<(), TurnChangeError> {
        if matches!(
            self.commit_state,
            CommitState::Queued | CommitState::Committing
        ) {
            return Err(TurnChangeError::InvalidTransition);
        }
        self.capture_state = CaptureState::Discarded;
        self.bump_revision()
    }

    pub fn satisfy_dependency(&mut self, dependency: &ChangeSetId) -> Result<(), TurnChangeError> {
        if self.dependencies.remove(dependency) {
            self.bump_revision()?;
        }
        Ok(())
    }

    pub fn satisfy_external_dependencies(
        &mut self,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<(), TurnChangeError> {
        let mut changed = false;
        for path in paths {
            changed |= self.external_dependency_paths.remove(&path);
        }
        if changed {
            self.bump_revision()?;
        }
        Ok(())
    }

    pub fn draft_message(&self) -> Result<&str, TurnChangeError> {
        self.draft_message
            .as_deref()
            .ok_or(TurnChangeError::MissingCommitMessage)
    }

    fn require_capture(&self, expected: CaptureState) -> Result<(), TurnChangeError> {
        if self.capture_state == expected {
            Ok(())
        } else {
            Err(TurnChangeError::InvalidTransition)
        }
    }

    fn require_sealed(&self) -> Result<(), TurnChangeError> {
        self.require_capture(CaptureState::Sealed)
    }

    fn require_committable(&self) -> Result<(), TurnChangeError> {
        self.require_sealed()?;
        if self.files.is_empty() {
            return Err(TurnChangeError::NoChanges);
        }
        if !self.dependencies.is_empty() {
            return Err(TurnChangeError::UnresolvedDependencies);
        }
        if !self.external_dependency_paths.is_empty() {
            return Err(TurnChangeError::UnresolvedExternalDependencies);
        }
        self.draft_message()?;
        if !matches!(
            self.commit_state,
            CommitState::Idle | CommitState::Conflict { .. } | CommitState::Failed { .. }
        ) {
            return Err(TurnChangeError::InvalidTransition);
        }
        Ok(())
    }

    fn bump_revision(&mut self) -> Result<(), TurnChangeError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(TurnChangeError::RevisionOverflow)?;
        Ok(())
    }
}

fn validate_message(message: &str) -> Result<(), TurnChangeError> {
    if message.trim().is_empty()
        || message.contains('\0')
        || message.len() > MAX_COMMIT_MESSAGE_BYTES
    {
        return Err(TurnChangeError::InvalidCommitMessage);
    }
    Ok(())
}

fn paths_overlap(left: &std::path::Path, right: &std::path::Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TurnChangeError {
    #[error("change-set identity is invalid")]
    InvalidIdentity,
    #[error("change-set snapshot is invalid")]
    InvalidSnapshot,
    #[error("change-set transition is invalid")]
    InvalidTransition,
    #[error("change-set warning is invalid")]
    InvalidWarning,
    #[error("change set has no net changes")]
    NoChanges,
    #[error("change set has unresolved dependencies")]
    UnresolvedDependencies,
    #[error("change set depends on initial worktree changes")]
    UnresolvedExternalDependencies,
    #[error("commit message is missing")]
    MissingCommitMessage,
    #[error("commit message is invalid")]
    InvalidCommitMessage,
    #[error("change-set revision overflowed")]
    RevisionOverflow,
    #[error("change-set evidence could not be encoded: {0}")]
    EvidenceEncoding(String),
}
