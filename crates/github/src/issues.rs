use super::Comment;
use super::Error;
use super::GitHub;
use super::Issue;
use super::Repository;
use super::Result;
use crate::api::Operation;
use ash_http_client::HttpMethod;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

pub struct CreateIssue<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub labels: &'a [String],
    pub assignees: &'a [String],
}

pub struct UpdateIssue<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub state: Option<super::IssueState>,
    pub labels: Option<&'a [String]>,
    pub assignees: Option<&'a [String]>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssueAssignee {
    pub login: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssueMetadata {
    #[serde(flatten)]
    pub issue: Issue,
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssueRepositoryInfo {
    pub node_id: String,
    pub default_branch: String,
    pub full_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssueBranch {
    pub id: String,
    pub name: String,
    pub commit: String,
}

impl GitHub {
    pub async fn comments(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<crate::Page<Comment>> {
        if number == 0 || !(1..=10_000).contains(&page) {
            return Err(Error::InvalidInput(
                "Comments require a positive issue or PR number and a valid page".into(),
            ));
        }
        let items: Vec<Comment> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!(
                    "issues/{number}/comments?per_page=100&page={page}"
                )),
                None,
            )
            .await?;
        let next_page = (items.len() == 100).then_some(page + 1);
        Ok(crate::Page { items, next_page })
    }
    pub async fn create_issue(
        &self,
        repository: &Repository,
        request: CreateIssue<'_>,
    ) -> Result<Issue> {
        validate_text(request.title, 256, "Issue title")?;
        validate_body(request.body)?;
        validate_names(request.labels, request.assignees)?;
        let issue: Issue = self.api(repository, HttpMethod::Post, &repository.endpoint("issues"),
            Some(json!({"title":request.title.trim(),"body":request.body,"labels":request.labels,"assignees":request.assignees}))).await?;
        validate_created_issue(repository, &issue)?;
        Ok(issue)
    }

    pub async fn update_issue(
        &self,
        repository: &Repository,
        number: u64,
        update: UpdateIssue<'_>,
    ) -> Result<Issue> {
        let mut body = serde_json::Map::new();
        if let Some(title) = update.title {
            validate_text(title, 256, "Issue title")?;
            body.insert("title".into(), json!(title.trim()));
        }
        if let Some(text) = update.body {
            validate_body(text)?;
            body.insert("body".into(), json!(text));
        }
        if let Some(state) = update.state {
            body.insert("state".into(), json!(state.as_str()));
        }
        if let Some(labels) = update.labels {
            validate_names(labels, &[])?;
            body.insert("labels".into(), json!(labels));
        }
        if let Some(assignees) = update.assignees {
            validate_names(&[], assignees)?;
            body.insert("assignees".into(), json!(assignees));
        }
        if body.is_empty() {
            return Err(Error::InvalidInput("Issue update is empty".into()));
        }
        // GitHub shares the Issue mutation endpoint with PRs. This domain operation
        // explicitly resolves an Issue before sending any change.
        self.issue_metadata(repository, number).await?;
        let issue: Issue = self
            .api(
                repository,
                HttpMethod::Patch,
                &repository.endpoint(&format!("issues/{number}")),
                Some(body.into()),
            )
            .await?;
        if issue.number != number {
            return Err(Error::SubmissionUncertain);
        }
        validate_created_issue(repository, &issue)?;
        Ok(issue)
    }

    /// Discussion comments are shared by Issues and PRs in GitHub's API.
    pub async fn create_comment(
        &self,
        repository: &Repository,
        number: u64,
        body: &str,
    ) -> Result<super::Comment> {
        if number == 0 {
            return Err(Error::InvalidInput(
                "Issue or PR number must be positive".into(),
            ));
        }
        validate_text(body, 65_536, "Comment")?;
        let comment: super::Comment = self
            .api(
                repository,
                HttpMethod::Post,
                &repository.endpoint(&format!("issues/{number}/comments")),
                Some(json!({"body":body})),
            )
            .await?;
        if comment.id == 0 {
            return Err(Error::SubmissionUncertain);
        }
        Ok(comment)
    }

    pub async fn update_comment(
        &self,
        repository: &Repository,
        comment_id: u64,
        body: &str,
    ) -> Result<super::Comment> {
        if comment_id == 0 {
            return Err(Error::InvalidInput("Comment ID must be positive".into()));
        }
        validate_text(body, 65_536, "Comment")?;
        let comment: super::Comment = self
            .api(
                repository,
                HttpMethod::Patch,
                &repository.endpoint(&format!("issues/comments/{comment_id}")),
                Some(json!({"body":body})),
            )
            .await?;
        if comment.id != comment_id {
            return Err(Error::SubmissionUncertain);
        }
        Ok(comment)
    }

    pub async fn delete_comment(&self, repository: &Repository, comment_id: u64) -> Result<()> {
        if comment_id == 0 {
            return Err(Error::InvalidInput("Comment ID must be positive".into()));
        }
        self.api::<serde_json::Value>(
            repository,
            HttpMethod::Delete,
            &repository.endpoint(&format!("issues/comments/{comment_id}")),
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn update_issue_label_color(
        &self,
        repository: &Repository,
        name: &str,
        color: &str,
    ) -> Result<IssueLabel> {
        if name.trim().is_empty()
            || name.len() > 50
            || name.chars().any(char::is_control)
            || color.len() != 6
            || !color.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Error::InvalidInput(
                "Label requires a name and a six-digit RGB color".into(),
            ));
        }
        let name = url::form_urlencoded::byte_serialize(name.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        self.api(
            repository,
            HttpMethod::Patch,
            &repository.endpoint(&format!("labels/{name}")),
            Some(json!({"color":color})),
        )
        .await
    }

    pub async fn automatic_issue_candidates(
        &self,
        repository: &Repository,
        labels: &[String],
        assignee: Option<&str>,
        limit: usize,
    ) -> Result<Vec<IssueMetadata>> {
        let mut issues = Vec::new();
        for page in 1..=100 {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("state", "open")
                .append_pair("labels", &labels.join(","))
                .append_pair("assignee", assignee.unwrap_or("none"))
                .append_pair("sort", "updated")
                .append_pair("direction", "desc")
                .append_pair("per_page", "100")
                .append_pair("page", &page.to_string())
                .finish();
            let rows: Vec<IssueMetadata> = self
                .api(
                    repository,
                    HttpMethod::Get,
                    &repository.endpoint(&format!("issues?{query}")),
                    None,
                )
                .await?;
            let complete = rows.len() < 100;
            issues.extend(rows.into_iter().filter(|issue| {
                issue.issue.pull_request.is_none()
                    && issue.issue.state == "open"
                    && labels
                        .iter()
                        .all(|name| issue.issue.labels.iter().any(|label| &label.name == name))
                    && match assignee {
                        Some(name) => {
                            !issue.issue.assignees.is_empty()
                                && issue
                                    .issue
                                    .assignees
                                    .iter()
                                    .all(|account| account.login.eq_ignore_ascii_case(name))
                        }
                        None => issue.issue.assignees.is_empty(),
                    }
            }));
            if complete || issues.len() >= limit {
                issues.truncate(limit);
                return Ok(issues);
            }
        }
        Err(Error::OperationFailed(
            "Automatic Issue discovery exceeded its page limit; narrow the label filter".into(),
        ))
    }

    pub async fn unassign_issue(
        &self,
        repository: &Repository,
        number: u64,
        owner: &str,
    ) -> Result<()> {
        let before = self.issue_metadata(repository, number).await?;
        if !before
            .issue
            .assignees
            .iter()
            .any(|assignee| assignee.login.eq_ignore_ascii_case(owner))
        {
            return Ok(());
        }
        let after: IssueMetadata = self
            .api(
                repository,
                HttpMethod::Delete,
                &repository.endpoint(&format!("issues/{number}/assignees")),
                Some(json!({"assignees":[owner]})),
            )
            .await?;
        if after
            .issue
            .assignees
            .iter()
            .any(|assignee| assignee.login.eq_ignore_ascii_case(owner))
        {
            return Err(Error::InvalidResponse(
                "GitHub did not release the requested assignee".into(),
            ));
        }
        Ok(())
    }

    pub async fn close_completed_issue(&self, repository: &Repository, number: u64) -> Result<()> {
        let closed: IssueMetadata = self
            .api(
                repository,
                HttpMethod::Patch,
                &repository.endpoint(&format!("issues/{number}")),
                Some(json!({"state":"closed","state_reason":"completed"})),
            )
            .await?;
        if closed.issue.state != "closed" {
            return Err(Error::InvalidResponse(
                "GitHub did not confirm Issue closure".into(),
            ));
        }
        Ok(())
    }

    pub async fn issue_repository(&self, repository: &Repository) -> Result<IssueRepositoryInfo> {
        self.api(
            repository,
            HttpMethod::Get,
            &format!("repos/{}/{}", repository.owner, repository.name),
            None,
        )
        .await
    }

    pub async fn issue_metadata(
        &self,
        repository: &Repository,
        number: u64,
    ) -> Result<IssueMetadata> {
        if number == 0 {
            return Err(Error::InvalidInput("Issue number must be positive".into()));
        }
        let issue: IssueMetadata = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("issues/{number}")),
                None,
            )
            .await?;
        if issue.issue.number != number
            || issue.node_id.is_empty()
            || issue.issue.pull_request.is_some()
        {
            return Err(Error::InvalidResponse(
                "Expected a GitHub issue with a stable identity".into(),
            ));
        }
        Ok(issue)
    }

    pub async fn issue_labels(&self, repository: &Repository) -> Result<Vec<IssueLabel>> {
        let mut labels = Vec::new();
        for page in 1..=100 {
            let rows: Vec<IssueLabel> = self
                .api(
                    repository,
                    HttpMethod::Get,
                    &repository.endpoint(&format!("labels?per_page=100&page={page}")),
                    None,
                )
                .await?;
            let complete = rows.len() < 100;
            labels.extend(rows);
            if complete {
                return Ok(labels);
            }
        }
        Err(Error::OperationFailed(
            "Repository label list exceeds 10000 labels".into(),
        ))
    }

    pub async fn issue_assignees(&self, repository: &Repository) -> Result<Vec<IssueAssignee>> {
        let mut assignees = Vec::new();
        for page in 1..=100 {
            let rows: Vec<IssueAssignee> = self
                .api(
                    repository,
                    HttpMethod::Get,
                    &repository.endpoint(&format!("assignees?per_page=100&page={page}")),
                    None,
                )
                .await?;
            let complete = rows.len() < 100;
            assignees.extend(rows);
            if complete {
                return Ok(assignees);
            }
        }
        Err(Error::OperationFailed(
            "Repository assignee list exceeds 10000 accounts".into(),
        ))
    }

    pub async fn create_issue_label(
        &self,
        repository: &Repository,
        name: &str,
        color: &str,
    ) -> Result<IssueLabel> {
        if name.trim().is_empty()
            || name.len() > 50
            || name.chars().any(char::is_control)
            || color.len() != 6
            || !color.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(Error::InvalidInput(
                "Label requires a name and a six-digit RGB color".into(),
            ));
        }
        self.api(
            repository,
            HttpMethod::Post,
            &repository.endpoint("labels"),
            Some(json!({"name":name,"color":color})),
        )
        .await
    }

    pub async fn assign_issue(
        &self,
        repository: &Repository,
        number: u64,
        login: &str,
    ) -> Result<()> {
        let before = self.issue_metadata(repository, number).await?;
        if before
            .issue
            .assignees
            .iter()
            .any(|assignee| !assignee.login.eq_ignore_ascii_case(login))
        {
            return Err(Error::Conflict(
                "Issue is already assigned to another account".into(),
            ));
        }
        if before
            .issue
            .assignees
            .iter()
            .any(|assignee| assignee.login.eq_ignore_ascii_case(login))
        {
            return Ok(());
        }
        let response: IssueMetadata = self
            .api(
                repository,
                HttpMethod::Post,
                &repository.endpoint(&format!("issues/{number}/assignees")),
                Some(json!({"assignees":[login]})),
            )
            .await?;
        if response.issue.assignees.len() != 1
            || !response.issue.assignees[0]
                .login
                .eq_ignore_ascii_case(login)
        {
            return Err(Error::InvalidResponse(
                "GitHub did not assign the requested account exclusively".into(),
            ));
        }
        Ok(())
    }

    /// Replaces only explicitly managed stage labels; unrelated labels are never submitted for replacement.
    pub async fn sync_issue_labels(
        &self,
        repository: &Repository,
        number: u64,
        managed: &[String],
        desired: Option<&str>,
        expected: &[String],
    ) -> Result<Vec<String>> {
        let issue = self.issue_metadata(repository, number).await?;
        let mut actual = issue
            .issue
            .labels
            .iter()
            .filter(|label| managed.contains(&label.name))
            .map(|label| label.name.clone())
            .collect::<Vec<_>>();
        actual.sort();
        let mut expected = expected.to_vec();
        expected.sort();
        let target = desired
            .map(|label| vec![label.to_owned()])
            .unwrap_or_default();
        if actual == target {
            return Ok(actual);
        }
        // The empty set is the recoverable midpoint after removing the previous managed label.
        if actual != expected && !actual.is_empty() {
            return Err(Error::Conflict(
                "Issue stage labels changed outside this assignment".into(),
            ));
        }
        for name in &actual {
            if desired == Some(name.as_str()) {
                continue;
            }
            let segment: String = url::form_urlencoded::byte_serialize(name.as_bytes())
                .collect::<String>()
                .replace('+', "%20");
            let _: serde_json::Value = self
                .api(
                    repository,
                    HttpMethod::Delete,
                    &repository.endpoint(&format!("issues/{number}/labels/{segment}")),
                    None,
                )
                .await?;
        }
        if let Some(label) = desired {
            let _: serde_json::Value = self
                .api(
                    repository,
                    HttpMethod::Post,
                    &repository.endpoint(&format!("issues/{number}/labels")),
                    Some(json!({"labels":[label]})),
                )
                .await?;
        }
        let after = self.issue_metadata(repository, number).await?;
        let mut actual = after
            .issue
            .labels
            .into_iter()
            .filter(|label| managed.contains(&label.name))
            .map(|label| label.name)
            .collect::<Vec<_>>();
        actual.sort();
        if actual != target {
            return Err(Error::Conflict(
                "Issue labels changed during synchronization".into(),
            ));
        }
        Ok(actual)
    }

    pub async fn linked_issue_branches(
        &self,
        repository: &Repository,
        issue_id: &str,
    ) -> Result<Vec<LinkedIssueBranch>> {
        let response: serde_json::Value = self.graphql(repository, "query($id:ID!){node(id:$id){... on Issue{linkedBranches(first:100){nodes{id ref{name target{oid}}} pageInfo{hasNextPage}}}}}", json!({"id":issue_id}), Operation::Read).await?;
        let branches = response
            .pointer("/data/node/linkedBranches")
            .ok_or_else(|| Error::InvalidResponse("GitHub did not return issue branches".into()))?;
        if branches
            .pointer("/pageInfo/hasNextPage")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        {
            return Err(Error::OperationFailed(
                "Issue has more than 100 linked branches".into(),
            ));
        }
        branches
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| Error::InvalidResponse("Missing linked branch list".into()))?
            .iter()
            .map(|value| {
                Ok(LinkedIssueBranch {
                    id: string(value, "/id")?,
                    name: string(value, "/ref/name")?,
                    commit: string(value, "/ref/target/oid")?,
                })
            })
            .collect()
    }

    pub async fn create_linked_issue_branch(
        &self,
        repository: &Repository,
        issue_id: &str,
        name: &str,
        commit: &str,
    ) -> Result<LinkedIssueBranch> {
        if !(40..=64).contains(&commit.len()) || !commit.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::InvalidInput(
                "Linked branch requires an exact commit".into(),
            ));
        }
        if let Some(existing) = self
            .linked_issue_branches(repository, issue_id)
            .await?
            .into_iter()
            .find(|branch| branch.name == name)
        {
            if existing.commit != commit {
                return Err(Error::Conflict(
                    "Existing linked branch moved from the requested starting commit".into(),
                ));
            }
            return Ok(existing);
        }
        let response: serde_json::Value = self.graphql(repository, "mutation($input:CreateLinkedBranchInput!){createLinkedBranch(input:$input){linkedBranch{id ref{name target{oid}}}}}", json!({"input":{"issueId":issue_id,"name":name,"oid":commit}}), Operation::Write).await?;
        let value = response
            .pointer("/data/createLinkedBranch/linkedBranch")
            .ok_or_else(|| {
                Error::InvalidResponse("GitHub did not return the linked branch".into())
            })?;
        let branch = LinkedIssueBranch {
            id: string(value, "/id")?,
            name: string(value, "/ref/name")?,
            commit: string(value, "/ref/target/oid")?,
        };
        if branch.name != name || branch.commit != commit {
            return Err(Error::InvalidResponse(
                "GitHub created a different branch or commit".into(),
            ));
        }
        Ok(branch)
    }
}

fn string(value: &serde_json::Value, pointer: &str) -> Result<String> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| Error::InvalidResponse(format!("Missing GitHub field {pointer}")))
}

pub(crate) fn validate_text(value: &str, maximum: usize, name: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > maximum || value.contains('\0') {
        return Err(Error::InvalidInput(format!(
            "{name} must contain 1–{maximum} characters"
        )));
    }
    Ok(())
}

pub(crate) fn validate_body(value: &str) -> Result<()> {
    if value.chars().count() > 65_536 || value.contains('\0') {
        return Err(Error::InvalidInput(
            "Body exceeds 65536 characters or contains NUL".into(),
        ));
    }
    Ok(())
}

fn validate_names(labels: &[String], assignees: &[String]) -> Result<()> {
    if labels.len() > 100 || assignees.len() > 10 {
        return Err(Error::InvalidInput("Too many labels or assignees".into()));
    }
    for label in labels {
        validate_text(label, 50, "Label")?;
        if label.chars().any(char::is_control) {
            return Err(Error::InvalidInput("Invalid label".into()));
        }
    }
    if assignees.iter().any(|name| !super::valid_component(name)) {
        return Err(Error::InvalidInput("Invalid GitHub assignee".into()));
    }
    Ok(())
}

fn validate_created_issue(repository: &Repository, issue: &Issue) -> Result<()> {
    if issue.number == 0
        || issue.pull_request.is_some()
        || !issue.html_url.eq_ignore_ascii_case(&format!(
            "https://{}/{}/{}/issues/{}",
            repository.host, repository.owner, repository.name, issue.number
        ))
    {
        return Err(Error::SubmissionUncertain);
    }
    Ok(())
}

#[cfg(test)]
#[path = "issues_tests.rs"]
mod tests;
