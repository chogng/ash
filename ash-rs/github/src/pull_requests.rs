use super::*;
use crate::api::Operation;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PullRequestPage {
    pub pull_requests: Vec<PullRequest>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_page: Option<u32>,
}

pub struct PullRequestFiles {
    pub files: Vec<PullRequestFile>,
    pub next_page: Option<u32>,
    /// A full final page reaches GitHub's 3000-file cap and cannot prove completeness.
    pub limit_reached: bool,
}

pub struct UpdatePullRequest<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub state: Option<IssueState>,
    pub base: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PullRequestFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub patch: Option<String>,
    pub previous_filename: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PullRequestReview {
    pub id: u64,
    pub body: String,
    pub state: String,
    pub html_url: String,
    pub commit_id: String,
    pub submitted_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MergeResult {
    pub sha: String,
    pub merged: bool,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitStatus {
    pub context: String,
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckStatus {
    pub state: String,
    pub statuses: Vec<CommitStatus>,
    pub checks: Vec<CheckRun>,
    pub next_page: Option<u32>,
}

#[derive(Deserialize)]
struct CombinedStatus {
    state: String,
    statuses: Vec<CommitStatus>,
    total_count: u64,
}
#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
    total_count: u64,
}

impl GitHub {
    pub async fn repository(&self, repository: &Repository) -> Result<RepositoryInfo> {
        self.api(
            repository,
            HttpMethod::Get,
            &format!("repos/{}/{}", repository.owner, repository.name),
            None,
        )
        .await
    }
    pub async fn pull_requests(
        &self,
        repository: &Repository,
        state: IssueState,
        page: u32,
    ) -> Result<PullRequestPage> {
        validate_page(page)?;
        let pull_requests: Vec<PullRequest> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!(
                    "pulls?state={}&sort=updated&direction=desc&per_page=100&page={page}",
                    state.as_str()
                )),
                None,
            )
            .await?;
        let next_page = (pull_requests.len() == 100).then_some(page + 1);
        Ok(PullRequestPage {
            pull_requests,
            next_page,
        })
    }

    pub async fn pull_request_files(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<PullRequestFiles> {
        validate_number(number)?;
        validate_page(page)?;
        // GitHub caps this endpoint at 3000 files. Never claim a complete diff beyond it.
        if page > 30 {
            return Err(Error::InvalidInput("PR files support pages 1–30".into()));
        }
        let items: Vec<PullRequestFile> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("pulls/{number}/files?per_page=100&page={page}")),
                None,
            )
            .await?;
        let next_page = (items.len() == 100 && page < 30).then_some(page + 1);
        Ok(PullRequestFiles {
            limit_reached: page == 30 && items.len() == 100,
            files: items,
            next_page,
        })
    }

    pub async fn pull_request_reviews(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<Page<PullRequestReview>> {
        validate_number(number)?;
        validate_page(page)?;
        let items: Vec<PullRequestReview> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("pulls/{number}/reviews?per_page=100&page={page}")),
                None,
            )
            .await?;
        let next_page = (items.len() == 100).then_some(page + 1);
        Ok(Page { items, next_page })
    }

    pub async fn review_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        event: ReviewEvent,
        body: &str,
    ) -> Result<PullRequestReview> {
        validate_number(number)?;
        validate_commit(commit)?;
        crate::issues::validate_body(body)?;
        if event != ReviewEvent::Approve {
            crate::issues::validate_text(body, 65_536, "Review")?;
        }
        let review: PullRequestReview = self
            .api(
                repository,
                HttpMethod::Post,
                &repository.endpoint(&format!("pulls/{number}/reviews")),
                Some(json!({"commit_id":commit,"event":event,"body":body})),
            )
            .await?;
        if review.id == 0 || !review.commit_id.eq_ignore_ascii_case(commit) {
            return Err(Error::SubmissionUncertain);
        }
        Ok(review)
    }

    /// GitHub checks the reviewed commit atomically while merging.
    pub async fn merge_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        method: MergeMethod,
    ) -> Result<MergeResult> {
        validate_number(number)?;
        validate_commit(commit)?;
        let method = match method {
            MergeMethod::Merge => "merge",
            MergeMethod::Squash => "squash",
            MergeMethod::Rebase => "rebase",
        };
        self.api(
            repository,
            HttpMethod::Put,
            &repository.endpoint(&format!("pulls/{number}/merge")),
            Some(json!({"sha":commit,"merge_method":method})),
        )
        .await
    }

    /// Auto-merge is enabled for the reviewed head, with GitHub's expectedHeadOid gate.
    pub async fn enable_auto_merge(
        &self,
        repository: &Repository,
        pull_request: &PullRequest,
        method: MergeMethod,
    ) -> Result<()> {
        if pull_request.draft || pull_request.state != "open" {
            return Err(Error::InvalidInput(
                "Automatic merge requires an open, non-draft PR".into(),
            ));
        }
        validate_commit(&pull_request.head.sha)?;
        if !valid_pull_request(repository, pull_request) {
            return Err(Error::InvalidInput(
                "PR identity must belong to the selected repository".into(),
            ));
        }
        let method = match method {
            MergeMethod::Merge => "MERGE",
            MergeMethod::Squash => "SQUASH",
            MergeMethod::Rebase => "REBASE",
        };
        let response = self.graphql(repository,
            "mutation($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){pullRequest{id headRefOid autoMergeRequest{mergeMethod}}}}",
            json!({"input":{"pullRequestId":pull_request.node_id,"expectedHeadOid":pull_request.head.sha,"mergeMethod":method}}), Operation::Write).await?;
        let result = response
            .pointer("/data/enablePullRequestAutoMerge/pullRequest")
            .ok_or(Error::SubmissionUncertain)?;
        if result.get("id").and_then(serde_json::Value::as_str)
            != Some(pull_request.node_id.as_str())
            || result.get("headRefOid").and_then(serde_json::Value::as_str)
                != Some(pull_request.head.sha.as_str())
            || result
                .pointer("/autoMergeRequest/mergeMethod")
                .and_then(serde_json::Value::as_str)
                != Some(method)
        {
            return Err(Error::SubmissionUncertain);
        }
        Ok(())
    }
    pub async fn merge_options(&self, repository: &Repository) -> Result<MergeOptions> {
        self.api(
            repository,
            HttpMethod::Get,
            &format!("repos/{}/{}", repository.owner, repository.name),
            None,
        )
        .await
    }

    pub async fn find_pull_request(
        &self,
        repository: &Repository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("state", "all")
            .append_pair("head", &format!("{}:{head}", repository.owner))
            .append_pair("base", base)
            .append_pair("per_page", "100")
            .finish();
        let requests: Vec<PullRequest> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("pulls?{query}")),
                None,
            )
            .await?;
        if requests.len() > 1 {
            return Err(Error::Conflict(
                "Multiple PRs exist for this task branch; select the intended PR on GitHub".into(),
            ));
        }
        Ok(requests.into_iter().next())
    }

    pub async fn checks(
        &self,
        repository: &Repository,
        commit: &str,
        page: u32,
    ) -> Result<CheckStatus> {
        validate_commit(commit)?;
        validate_page(page)?;
        let statuses: CombinedStatus = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("commits/{commit}/status?per_page=100&page={page}")),
                None,
            )
            .await?;
        let runs: CheckRuns = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!(
                    "commits/{commit}/check-runs?per_page=100&page={page}"
                )),
                None,
            )
            .await?;
        let next_page = ((u64::from(page) * 100 < statuses.total_count)
            || (u64::from(page) * 100 < runs.total_count))
            .then_some(page + 1);
        Ok(CheckStatus {
            state: statuses.state,
            statuses: statuses.statuses,
            checks: runs.check_runs,
            next_page,
        })
    }
    pub async fn pull_request(&self, repository: &Repository, number: u64) -> Result<PullRequest> {
        if number == 0 {
            return Err(Error::InvalidInput("PR number must be positive".into()));
        }
        let pull_request: PullRequest = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("pulls/{number}")),
                None,
            )
            .await?;
        if pull_request.number != number || !valid_pull_request(repository, &pull_request) {
            return Err(Error::InvalidResponse(
                "GitHub returned a different PR".into(),
            ));
        }
        Ok(pull_request)
    }

    pub async fn create_pull_request(
        &self,
        repository: &Repository,
        request: CreatePullRequest<'_>,
    ) -> Result<PullRequest> {
        crate::issues::validate_text(request.title, 256, "PR title")?;
        crate::issues::validate_body(request.body)?;
        crate::issues::validate_text(request.head, 255, "PR head branch")?;
        crate::issues::validate_text(request.base, 255, "PR base branch")?;
        if request.head == request.base {
            return Err(Error::InvalidInput(
                "PR requires a title and distinct head/base branches".into(),
            ));
        }
        let result: PullRequest = self
            .api(
                repository,
                HttpMethod::Post,
                &repository.endpoint("pulls"),
                Some(json!({
                    "title": request.title, "body": request.body, "head": request.head,
                    "base": request.base, "draft": request.draft,
                })),
            )
            .await?;
        if !valid_pull_request(repository, &result) {
            return Err(Error::SubmissionUncertain);
        }
        Ok(result)
    }

    pub async fn update_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        request: UpdatePullRequest<'_>,
    ) -> Result<PullRequest> {
        validate_number(number)?;
        let mut body = serde_json::Map::new();
        if let Some(title) = request.title {
            crate::issues::validate_text(title, 256, "PR title")?;
            body.insert("title".into(), json!(title));
        }
        if let Some(text) = request.body {
            crate::issues::validate_body(text)?;
            body.insert("body".into(), json!(text));
        }
        if let Some(state) = request.state {
            body.insert("state".into(), json!(state.as_str()));
        }
        if let Some(base) = request.base {
            crate::issues::validate_text(base, 255, "PR base branch")?;
            body.insert("base".into(), json!(base));
        }
        if body.is_empty() {
            return Err(Error::InvalidInput("PR update requires a change".into()));
        }
        let result: PullRequest = self
            .api(
                repository,
                HttpMethod::Patch,
                &repository.endpoint(&format!("pulls/{number}")),
                Some(json!(body)),
            )
            .await?;
        if result.number != number || !valid_pull_request(repository, &result) {
            return Err(Error::SubmissionUncertain);
        }
        Ok(result)
    }
}

fn valid_pull_request(repository: &Repository, pull_request: &PullRequest) -> bool {
    pull_request.number > 0
        && !pull_request.node_id.is_empty()
        && pull_request.html_url.eq_ignore_ascii_case(&format!(
            "https://{}/{}/{}/pull/{}",
            repository.host, repository.owner, repository.name, pull_request.number
        ))
}

fn validate_number(number: u64) -> Result<()> {
    if number == 0 {
        return Err(Error::InvalidInput("PR number must be positive".into()));
    }
    Ok(())
}

fn validate_page(page: u32) -> Result<()> {
    if !(1..=10_000).contains(&page) {
        return Err(Error::InvalidInput(
            "Page must be between 1 and 10000".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_commit(commit: &str) -> Result<()> {
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::InvalidInput(
            "An exact Git commit is required".into(),
        ));
    }
    Ok(())
}
