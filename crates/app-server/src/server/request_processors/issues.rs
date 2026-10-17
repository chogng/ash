use super::RpcError;
use super::decode;
use super::github_processor::github_authentication_error;
use super::github_processor::github_error;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::issues::IssueComment;
use ash_app_server_protocol::protocol::issues::IssueListParams;
use ash_app_server_protocol::protocol::issues::IssueListResult;
use ash_app_server_protocol::protocol::issues::IssueReadParams;
use ash_app_server_protocol::protocol::issues::IssueReadResult;
use ash_app_server_protocol::protocol::issues::IssueRepository;
use ash_app_server_protocol::protocol::issues::IssueSummary;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_config::ConfigStore;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

/// Directory-specific Issue adapter. Persistent cache and configuration stay with
/// their domain stores; remote work runs on the shared request executor.
pub(super) struct IssueRequestProcessor {
    root: PathBuf,
    cache: Mutex<ash_state::SqliteIssueCache>,
}

impl IssueRequestProcessor {
    pub(super) fn request_blocking(
        processor: Option<&Self>,
        method: ClientMethod,
        params: &Value,
        github: Option<&super::github_processor::GitHubRequestProcessor>,
        config: Option<&ConfigStore>,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let processor = processor.ok_or_else(|| issue_error("Issue runtime unavailable".into()))?;
        super::request_dispatch::runtime()
            .map_err(|error| issue_error(error.to_string()))?
            .block_on(
                processor.request(
                    method,
                    params,
                    github
                        .ok_or_else(|| {
                            RpcError::new(-32030, AppServerErrorName::AccountUnavailable)
                        })
                        .and_then(|provider| provider.client(cancellation)),
                    config,
                ),
            )
    }

    pub(super) fn open(root: &Path, database: &Path) -> Result<Self, String> {
        let root = dunce::canonicalize(root)
            .map_err(|error| format!("cannot resolve Issue repository root: {error}"))?;
        Ok(Self {
            root,
            cache: Mutex::new(ash_state::SqliteIssueCache::open(database)?),
        })
    }

    pub(super) fn handles(method: ClientMethod) -> bool {
        matches!(method, ClientMethod::IssueList | ClientMethod::IssueRead)
    }

    /// The host prepares current credentials. Apply that result after validating the
    /// request and local repository, preserving the existing error precedence.
    pub(super) async fn request(
        &self,
        method: ClientMethod,
        params: &Value,
        client: Result<github::GitHub, RpcError>,
        config: Option<&ConfigStore>,
    ) -> Result<Value, RpcError> {
        match method {
            ClientMethod::IssueList => self.list(params, client, config).await,
            ClientMethod::IssueRead => self.read(params, client).await,
            _ => unreachable!("only Issue query methods are dispatched here"),
        }
    }

    async fn list(
        &self,
        params: &Value,
        client: Result<github::GitHub, RpcError>,
        config: Option<&ConfigStore>,
    ) -> Result<Value, RpcError> {
        let params: IssueListParams = decode(params)?;
        let repository = github_repository(&self.root).await?;
        let query = params.query.trim();
        github::validate_issue_query(query, params.page).map_err(github_error)?;
        let github = client?;
        if !repository
            .host
            .eq_ignore_ascii_case(&github.authorization().host)
        {
            return Err(RpcError::new(
                -32030,
                AppServerErrorName::AccountAuthenticationRequired,
            ));
        }
        let state = match params.state {
            ash_app_server_protocol::protocol::issues::IssueState::Open => "open",
            ash_app_server_protocol::protocol::issues::IssueState::Closed => "closed",
        };
        let settings = config
            .ok_or_else(|| issue_error("Issue configuration is unavailable".into()))?
            .read_snapshot()
            .map_err(|error| issue_error(error.to_string()))?
            .values
            .issues;
        let interval = settings.auto_refresh_minutes * 60;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| issue_error(error.to_string()))?
            .as_secs();
        use ash_app_server_protocol::protocol::issues::IssueListMode;
        let key = ash_state::IssueCacheKey {
            authorization: github.authorization(),
            repository: &repository,
            state,
            query,
            page: params.page,
        };
        let fresh = {
            let cache = self
                .cache
                .lock()
                .map_err(|_| issue_error("Issue cache operation lock poisoned".into()))?;
            if params.mode == IssueListMode::ClearCache {
                if params.page != 1 {
                    return Err(issue_error("Clear cache must start at page 1".into()));
                }
                cache.clear(&key).map_err(issue_error)?;
            }
            let stored = if matches!(params.mode, IssueListMode::Cached | IssueListMode::Auto) {
                cache.read(&key, now).map_err(issue_error)?
            } else {
                None
            };
            stored.filter(|entry| {
                params.mode == IssueListMode::Cached
                    || interval == 0
                    || now.saturating_sub(entry.fetched_at) < u64::from(interval)
            })
        };
        let (page, fetched_at, cached) = if let Some(entry) = fresh {
            (entry.page, entry.fetched_at, true)
        } else {
            let page = github
                .search_issues(
                    &repository,
                    if state == "open" {
                        github::IssueState::Open
                    } else {
                        github::IssueState::Closed
                    },
                    query,
                    params.page,
                )
                .await
                .map_err(github_error)?;
            let fetched_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| issue_error(error.to_string()))?
                .as_secs();
            github
                .validate_authorization()
                .map_err(github_authentication_error)?;
            self.cache
                .lock()
                .map_err(|_| issue_error("Issue cache operation lock poisoned".into()))?
                .write(&key, &page, fetched_at)
                .map_err(issue_error)?;
            (page, fetched_at, false)
        };
        github
            .validate_authorization()
            .map_err(github_authentication_error)?;
        result(&IssueListResult {
            repository: IssueRepository {
                host: repository.host,
                owner: repository.owner,
                name: repository.name,
            },
            issues: page.issues.into_iter().map(summary).collect(),
            next_page: page.next_page,
            cached,
            fetched_at,
            refresh_after_seconds: (interval != 0)
                .then(|| interval.saturating_sub(now.saturating_sub(fetched_at) as u32)),
            notice: page.notice,
        })
    }

    async fn read(
        &self,
        params: &Value,
        client: Result<github::GitHub, RpcError>,
    ) -> Result<Value, RpcError> {
        let params: IssueReadParams = decode(params)?;
        let repository = github_repository(&self.root).await?;
        if (
            repository.host.as_str(),
            repository.owner.as_str(),
            repository.name.as_str(),
        ) != (
            params.repository.host.as_str(),
            params.repository.owner.as_str(),
            params.repository.name.as_str(),
        ) {
            return Err(issue_error(
                "Repository changed; refresh the issue list".into(),
            ));
        }
        let github = client?;
        let snapshot = github
            .issue(&repository, params.number)
            .await
            .map_err(github_error)?;
        result(&IssueReadResult {
            body: snapshot.issue.body.clone().unwrap_or_default(),
            issue: summary(snapshot.issue),
            comments: snapshot
                .comments
                .into_iter()
                .map(|comment| IssueComment {
                    id: comment.id,
                    body: comment.body,
                    url: comment.html_url,
                    updated_at: comment.updated_at,
                })
                .collect(),
        })
    }
}

async fn github_repository(root: &std::path::Path) -> Result<github::Repository, RpcError> {
    let git = ash_git::GitClient::system();
    let repository = git
        .open_repository(root)
        .await
        .map_err(|error| issue_error(error.to_string()))?;
    let remotes = git
        .remotes(&repository)
        .await
        .map_err(|error| issue_error(error.to_string()))?;
    let remote = remotes
        .iter()
        .find(|remote| remote.name() == "origin")
        .ok_or_else(|| issue_error("Issue management requires an origin remote".into()))?;
    if !remote.has_single_identity() {
        return Err(issue_error(
            "Origin fetch and push URLs must identify the same repository".into(),
        ));
    }
    let identity = remote
        .identity()
        .ok_or_else(|| issue_error("Origin has no supported repository identity".into()))?;
    // Git remote metadata only associates this workspace with a hosted repository. This
    // integration uses the GitHub.com account provider; other Git hosts are not login failures.
    if !identity.host().eq_ignore_ascii_case("github.com") {
        return Err(issue_error(
            "GitHub issue management requires a GitHub.com origin remote".into(),
        ));
    }
    github::Repository::new(
        identity.host().into(),
        identity.owner().into(),
        identity.repository().into(),
    )
    .map_err(github_error)
}

pub(super) fn summary(issue: github::Issue) -> IssueSummary {
    IssueSummary {
        labels: issue.labels.into_iter().map(|label| label.name).collect(),
        assignees: issue
            .assignees
            .into_iter()
            .map(|assignee| assignee.login)
            .collect(),
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        updated_at: issue.updated_at,
        state: issue.state,
        state_reason: issue.state_reason,
    }
}

pub(super) fn issue_error(detail: String) -> RpcError {
    log::warn!("Issue operation failed: {detail}");
    let mut error = RpcError::new(-32070, AppServerErrorName::IssueOperationFailed);
    error.detail = Some(detail);
    error
}
