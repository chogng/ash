//! Directory-owned route to the Git capability process. Repository state stays in the provider.
use super::update_broker::UpdateBroker;
use crate::git_provider::GitProviderClient;
use crate::git_provider::service_error;
use crate::git_service::GitServiceError;
use ash_app_server_protocol::git_provider::*;
use ash_app_server_protocol::protocol::git::*;
use ash_async_utils::CancellationToken;
use ash_config::ConfigStore;
use ash_file_access::Authorization;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) struct GitRuntime {
    client: Option<Arc<GitProviderClient>>,
    updates: Arc<UpdateBroker>,
}

pub(super) struct GitWatcher {
    shutdown: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    client: Option<std::sync::Weak<GitProviderClient>>,
}

pub(super) struct GitRuntimeCommit {
    pub(super) object_id: String,
    pub(super) status: GitStatusResult,
}

#[derive(Debug)]
pub(crate) enum GitRuntimeError {
    Boundary,
    InvalidGraphCursor,
    RepositoryNotFound,
    Service(GitServiceError),
}

impl GitRuntime {
    pub(super) fn new(
        authorization: Authorization,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        Self::open(vec![(None, authorization)], updates)
    }
    pub(super) fn new_for_dirs(
        directories: Vec<(String, Authorization)>,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        Self::open(
            directories
                .into_iter()
                .map(|(id, authorization)| (Some(id), authorization))
                .collect(),
            updates,
        )
    }
    fn open(
        directories: Vec<(Option<String>, Authorization)>,
        updates: Arc<UpdateBroker>,
    ) -> Result<Arc<Self>, GitRuntimeError> {
        let client = crate::git_provider::product_executable()
            .and_then(|executable| GitProviderClient::open(executable, directories))
            .ok();
        Ok(Arc::new(Self { client, updates }))
    }
    fn call(
        &self,
        request: GitProviderRequest,
        cancellation: Option<&CancellationToken>,
    ) -> Result<GitProviderResponse, GitRuntimeError> {
        self.client
            .as_ref()
            .ok_or_else(|| provider_error(GitProviderError::Unavailable))?
            .call(request, cancellation)
            .map_err(provider_error)
    }
    pub(super) fn common_dir_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CommonDirectory {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Path(path) => Ok(path),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn reconcile(&self) -> Result<(), GitRuntimeError> {
        self.call(GitProviderRequest::Reconcile, None).map(|_| ())
    }
    pub(super) fn initialize(
        &self,
        root: &Path,
        branch: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitRuntimeError> {
        self.call(
            GitProviderRequest::Initialize {
                root: root.to_path_buf(),
                branch: branch.to_owned(),
            },
            Some(cancellation),
        )
        .map(|_| ())
    }
    pub(super) fn repositories(&self) -> Result<GitRepositoriesResult, GitRuntimeError> {
        match self.call(GitProviderRequest::Repositories, None)? {
            GitProviderResponse::Repositories(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn status_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Status {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn check_ignore_for(
        &self,
        repository_id: Option<&str>,
        paths: &[PathBuf],
        cancellation: &CancellationToken,
    ) -> Result<Vec<PathBuf>, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CheckIgnore {
                repository_id: repository_id.map(str::to_owned),
                paths: paths.to_vec(),
            },
            Some(cancellation),
        )? {
            GitProviderResponse::Paths(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn local_branches_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        match self.call(
            GitProviderRequest::LocalBranches {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Branches(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn catalog_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<ash_git::GitCatalog, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Catalog {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Catalog(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn command_for(
        &self,
        repository_id: Option<&str>,
        command: &ash_git::GitCommand,
        cancellation: &CancellationToken,
    ) -> Result<
        (
            GitStatusResult,
            ash_git::GitCommandOutcome,
            Option<ash_git::GitIntegration>,
        ),
        GitRuntimeError,
    > {
        match self.call(
            GitProviderRequest::Command {
                repository_id: repository_id.map(str::to_owned),
                command: command.clone(),
            },
            Some(cancellation),
        )? {
            GitProviderResponse::Command(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn index_diff_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        comparison: ash_git::GitChangeFileComparison,
    ) -> Result<ash_git::GitIndexDiff, GitRuntimeError> {
        match self.call(
            GitProviderRequest::IndexDiff {
                repository_id: repository_id.map(str::to_owned),
                path: path.to_path_buf(),
                comparison,
            },
            None,
        )? {
            GitProviderResponse::IndexDiff { original, modified } => {
                let document = ash_diff::DiffDocument::from_text(
                    original.as_deref().unwrap_or(""),
                    modified.as_deref().unwrap_or(""),
                )
                .map_err(|_| GitRuntimeError::Service(GitServiceError::Runtime))?;
                Ok(ash_git::GitIndexDiff {
                    original,
                    modified,
                    document,
                })
            }
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn index_edit_for(
        &self,
        repository_id: Option<&str>,
        request: &ash_git::GitIndexEdit,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::IndexEdit {
                repository_id: repository_id.map(str::to_owned),
                request: request.clone(),
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn create_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CreateBranch {
                repository_id: repository_id.map(str::to_owned),
                name: name.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::Branches(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn delete_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<Vec<GitBranchDto>, GitRuntimeError> {
        match self.call(
            GitProviderRequest::DeleteBranch {
                repository_id: repository_id.map(str::to_owned),
                name: name.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::Branches(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn mutable_source_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        match self.call(
            GitProviderRequest::MutableSource {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Path(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn readable_source_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<PathBuf, GitRuntimeError> {
        match self.call(
            GitProviderRequest::ReadableSource {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Path(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn recent_commits_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<Vec<GitCommitSummaryDto>, GitRuntimeError> {
        match self.call(
            GitProviderRequest::RecentCommits {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::History(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn history_refs_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<ash_app_server_protocol::protocol::git::GitHistoryRefsResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::HistoryRefs {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::HistoryRefs(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn graph_for(
        &self,
        repository_id: Option<&str>,
        connection_id: u64,
        limit: std::num::NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<GitGraphResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Graph {
                repository_id: repository_id.map(str::to_owned),
                connection_id,
                limit,
                cursor: cursor.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::Graph(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn text_diff_for(
        &self,
        repository_id: Option<&str>,
    ) -> Result<GitTextDiffResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::TextDiff {
                repository_id: repository_id.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::TextDiff(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn commit_changes_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<GitCommitChangesResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CommitChanges {
                repository_id: repository_id.map(str::to_owned),
                object_id: object_id.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::CommitChanges(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn compare_changes_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
        base_reference: &str,
        mode: ash_git::GitComparisonMode,
    ) -> Result<GitCompareChangesResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CompareChanges {
                repository_id: repository_id.map(str::to_owned),
                object_id: object_id.to_owned(),
                base_reference: base_reference.to_owned(),
                mode,
            },
            None,
        )? {
            GitProviderResponse::CompareChanges(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn commit_message_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<String, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CommitMessage {
                repository_id: repository_id.map(str::to_owned),
                object_id: object_id.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::Text(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn commit_details_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
    ) -> Result<ash_git::GitCommitDetails, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CommitDetails {
                repository_id: repository_id.map(str::to_owned),
                object_id: object_id.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::CommitDetails(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn commit_file_for(
        &self,
        repository_id: Option<&str>,
        object_id: &str,
        path: &Path,
        comparison_base: Option<&str>,
    ) -> Result<GitCommitFileResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CommitFile {
                repository_id: repository_id.map(str::to_owned),
                object_id: object_id.to_owned(),
                path: path.to_path_buf(),
                comparison_base: comparison_base.map(str::to_owned),
            },
            None,
        )? {
            GitProviderResponse::CommitFile(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn change_file_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        comparison: GitChangeFileComparisonDto,
    ) -> Result<GitChangeFileResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::ChangeFile {
                repository_id: repository_id.map(str::to_owned),
                path: path.to_path_buf(),
                comparison,
            },
            None,
        )? {
            GitProviderResponse::ChangeFile(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn conflict_file_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
    ) -> Result<GitConflictFileResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::ConflictFile {
                repository_id: repository_id.map(str::to_owned),
                path: path.to_path_buf(),
            },
            None,
        )? {
            GitProviderResponse::ConflictFile(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn complete_conflict_for(
        &self,
        repository_id: Option<&str>,
        path: &Path,
        expected_stage_ids: [Option<String>; 3],
        expected_result_object_id: Option<String>,
        resolution: GitConflictResolutionDto,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::CompleteConflict {
                repository_id: repository_id.map(str::to_owned),
                path: path.to_path_buf(),
                expected_stage_ids,
                expected_result_object_id,
                resolution,
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn switch_branch_for(
        &self,
        repository_id: Option<&str>,
        name: &str,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::SwitchBranch {
                repository_id: repository_id.map(str::to_owned),
                name: name.to_owned(),
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn stage_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Stage {
                repository_id: repository_id.map(str::to_owned),
                paths,
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn unstage_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Unstage {
                repository_id: repository_id.map(str::to_owned),
                paths,
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn discard_worktree_for(
        &self,
        repository_id: Option<&str>,
        paths: Vec<PathBuf>,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::DiscardWorktree {
                repository_id: repository_id.map(str::to_owned),
                paths,
            },
            None,
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn commit_for(
        &self,
        repository_id: Option<&str>,
        request: ash_git::GitCommitRequest,
    ) -> Result<GitRuntimeCommit, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Commit {
                repository_id: repository_id.map(str::to_owned),
                request,
            },
            None,
        )? {
            GitProviderResponse::Commit { object_id, status } => {
                Ok(GitRuntimeCommit { object_id, status })
            }
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn fetch_for(
        &self,
        repository_id: Option<&str>,
        mode: GitFetchModeDto,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Fetch {
                repository_id: repository_id.map(str::to_owned),
                mode,
            },
            Some(cancellation),
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn pull_fast_forward_for(
        &self,
        repository_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::PullFastForward {
                repository_id: repository_id.map(str::to_owned),
            },
            Some(cancellation),
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    pub(super) fn push_for(
        &self,
        repository_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<GitStatusResult, GitRuntimeError> {
        match self.call(
            GitProviderRequest::Push {
                repository_id: repository_id.map(str::to_owned),
            },
            Some(cancellation),
        )? {
            GitProviderResponse::Status(value) => Ok(value),
            _ => Err(GitRuntimeError::Service(GitServiceError::Runtime)),
        }
    }
    fn resynchronize(&self) {
        self.updates.publish_git_repositories_changed();
        if let Ok(repositories) = self.repositories() {
            for repository in repositories.repositories {
                self.updates.publish_git_ignore_changed(GitIgnoreChanged {
                    repository_id: repository.id.clone(),
                    paths: Vec::new(),
                });
                if let Ok(status) = self.status_for(Some(&repository.id)) {
                    self.updates.publish_git_status_changed(status);
                }
            }
        }
    }
    pub(super) fn close_connection(&self, connection_id: u64) {
        let _ = self.call(GitProviderRequest::CloseConnection { connection_id }, None);
    }
    pub(super) fn start_watching(self: &Arc<Self>, config: Option<Arc<ConfigStore>>) -> GitWatcher {
        let policy = config
            .as_ref()
            .and_then(|config| config.read_snapshot().ok())
            .map(|snapshot| snapshot.values.git)
            .unwrap_or_default();
        if let Err(error) = self.call(
            GitProviderRequest::StartWatching {
                policy: provider_policy(policy),
            },
            None,
        ) {
            log::warn!("Git provider could not start repository watches: {error:?}");
        }
        let (shutdown, receiver) = mpsc::channel();
        if self.client.is_none() {
            return GitWatcher {
                shutdown,
                thread: None,
                client: None,
            };
        }
        let changes = config.as_ref().map(|config| config.subscribe_changes());
        let runtime = Arc::downgrade(self);
        let thread = std::thread::Builder::new()
            .name("ash-git-provider-relay".into())
            .spawn(move || {
                let mut failed = false;
                loop {
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        _ => break,
                    }
                    let Some(runtime) = runtime.upgrade() else {
                        break;
                    };
                    if runtime
                        .client
                        .as_ref()
                        .is_some_and(|client| client.ensure_authorized().is_err())
                    {
                        break;
                    }
                    if changes
                        .as_ref()
                        .is_some_and(|changes| changes.try_iter().last().is_some())
                    {
                        if let Some(config) = &config {
                            if let Ok(snapshot) = config.read_snapshot() {
                                let _ = runtime.call(
                                    GitProviderRequest::Configure {
                                        policy: provider_policy(snapshot.values.git),
                                    },
                                    None,
                                );
                            }
                        }
                    }
                    match runtime.call(GitProviderRequest::DrainEvents, None) {
                        Ok(GitProviderResponse::Events(events)) => {
                            failed = false;
                            for event in events {
                                match event {
                                    GitProviderEvent::Resynchronize => runtime.resynchronize(),
                                    GitProviderEvent::RepositoriesChanged => {
                                        runtime.updates.publish_git_repositories_changed()
                                    }
                                    GitProviderEvent::StatusChanged(status) => {
                                        runtime.updates.publish_git_status_changed(status)
                                    }
                                    GitProviderEvent::IgnoreChanged(change) => {
                                        runtime.updates.publish_git_ignore_changed(change)
                                    }
                                }
                            }
                        }
                        result => {
                            if !failed {
                                log::warn!("Git provider event relay unavailable: {result:?}");
                            }
                            failed = true;
                        }
                    }
                }
            })
            .ok();
        GitWatcher {
            shutdown,
            thread,
            client: self.client.as_ref().map(Arc::downgrade),
        }
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        if let Some(client) = self.client.as_ref().and_then(std::sync::Weak::upgrade) {
            client.shutdown();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn provider_error(error: GitProviderError) -> GitRuntimeError {
    match error {
        GitProviderError::Boundary => GitRuntimeError::Boundary,
        GitProviderError::InvalidGraphCursor => GitRuntimeError::InvalidGraphCursor,
        GitProviderError::RepositoryNotFound => GitRuntimeError::RepositoryNotFound,
        error => GitRuntimeError::Service(service_error(error)),
    }
}

fn provider_policy(policy: ash_config::GitConfig) -> GitProviderPolicy {
    GitProviderPolicy {
        autofetch: match policy.autofetch {
            ash_config::GitAutoFetchMode::Off => GitProviderFetch::Off,
            ash_config::GitAutoFetchMode::Default => GitProviderFetch::Default,
            ash_config::GitAutoFetchMode::All => GitProviderFetch::All,
        },
        autofetch_period: policy.autofetch_period,
    }
}
