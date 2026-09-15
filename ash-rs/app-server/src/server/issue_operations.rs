use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::issues::IssueComment;
use ash_app_server_protocol::protocol::issues::IssueListParams;
use ash_app_server_protocol::protocol::issues::IssueListResult;
use ash_app_server_protocol::protocol::issues::IssueReadParams;
use ash_app_server_protocol::protocol::issues::IssueReadResult;
use ash_app_server_protocol::protocol::issues::IssueRepository;
use ash_app_server_protocol::protocol::issues::IssueSummary;
use serde_json::Value;

impl AppServer {
    pub(super) fn issue_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: IssueListParams = decode(params)?;
        let runtime = self.issue_runtime()?;
        let repository = runtime
            .block_on(repository(runtime.root()))
            .map_err(issue_error)?;
        let query = params.query.trim();
        github::validate_issue_query(query, params.page).map_err(issue_error)?;
        let state = match params.state {
            ash_app_server_protocol::protocol::issues::IssueState::Open => "open",
            ash_app_server_protocol::protocol::issues::IssueState::Closed => "closed",
        };
        let cache = self
            .issue_cache
            .as_ref()
            .ok_or_else(|| issue_error("Issue cache is unavailable".into()))?
            .lock()
            .map_err(|_| issue_error("Issue cache operation lock poisoned".into()))?;
        let settings = self
            .config
            .as_ref()
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
        let key = ash_state::IssueCacheKey {
            repository: &repository,
            state,
            query,
            page: params.page,
        };
        use ash_app_server_protocol::protocol::issues::IssueListMode;
        if params.mode == IssueListMode::ClearCache {
            if params.page != 1 {
                return Err(issue_error("Clear cache must start at page 1".into()));
            }
            cache.clear(&repository).map_err(issue_error)?;
        }
        let stored = if matches!(params.mode, IssueListMode::Cached | IssueListMode::Auto) {
            cache.read(&key, now).map_err(issue_error)?
        } else {
            None
        };
        let fresh = stored.filter(|entry| {
            params.mode == IssueListMode::Cached
                || interval == 0
                || now.saturating_sub(entry.fetched_at) < u64::from(interval)
        });
        let (page, fetched_at, cached) = if let Some(entry) = fresh {
            (entry.page, entry.fetched_at, true)
        } else {
            let page = runtime
                .block_on(github::GitHub::default().search_issues(
                    &repository,
                    if state == "open" {
                        github::IssueState::Open
                    } else {
                        github::IssueState::Closed
                    },
                    query,
                    params.page,
                ))
                .map_err(issue_error)?;
            let fetched_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| issue_error(error.to_string()))?
                .as_secs();
            cache.write(&key, &page, fetched_at).map_err(issue_error)?;
            (page, fetched_at, false)
        };
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

    pub(super) fn issue_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: IssueReadParams = decode(params)?;
        let runtime = self.issue_runtime()?;
        let repository = runtime
            .block_on(repository(runtime.root()))
            .map_err(issue_error)?;
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
        let snapshot = runtime
            .block_on(github::GitHub::default().issue(&repository, params.number))
            .map_err(issue_error)?;
        result(&IssueReadResult {
            body: snapshot.issue.body.clone().unwrap_or_default(),
            issue: summary(snapshot.issue),
            comments: snapshot
                .comments
                .into_iter()
                .map(|comment| IssueComment {
                    body: comment.body,
                    url: comment.html_url,
                    updated_at: comment.updated_at,
                })
                .collect(),
        })
    }
}

pub(super) async fn repository(root: &std::path::Path) -> Result<github::Repository, String> {
    let git = ash_git::GitClient::system();
    let repository = git
        .open_repository(root)
        .await
        .map_err(|error| error.to_string())?;
    let remotes = git
        .remotes(&repository)
        .await
        .map_err(|error| error.to_string())?;
    let remote = remotes
        .iter()
        .find(|remote| remote.name() == "origin")
        .ok_or("Issue management requires an origin remote")?;
    if !remote.has_single_identity() {
        return Err("Origin fetch and push URLs must identify the same repository".into());
    }
    let identity = remote
        .identity()
        .ok_or("Origin has no supported repository identity")?;
    github::Repository::new(
        identity.host().into(),
        identity.owner().into(),
        identity.repository().into(),
    )
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
    }
}

pub(super) fn issue_error(detail: String) -> RpcError {
    log::warn!("Issue operation failed: {detail}");
    let mut error = RpcError::new(-32070, AppServerErrorName::IssueOperationFailed);
    error.detail = Some(detail);
    error
}
