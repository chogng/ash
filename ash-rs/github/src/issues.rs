use super::GitHub;
use super::Issue;
use super::Repository;
use super::Result;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

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
    pub async fn update_issue_label_color(
        &self,
        repository: &Repository,
        name: &str,
        color: &str,
    ) -> Result<IssueLabel> {
        if color.len() != 6 || !color.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Label color must contain six hexadecimal digits".into());
        }
        let name = url::form_urlencoded::byte_serialize(name.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        self.api(
            repository,
            "PATCH",
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
                    "GET",
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
        Err("Automatic Issue discovery exceeded its page limit; narrow the label filter".into())
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
                "DELETE",
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
            return Err("GitHub did not release the requested assignee".into());
        }
        Ok(())
    }

    pub async fn close_completed_issue(&self, repository: &Repository, number: u64) -> Result<()> {
        let closed: IssueMetadata = self
            .api(
                repository,
                "PATCH",
                &repository.endpoint(&format!("issues/{number}")),
                Some(json!({"state":"closed","state_reason":"completed"})),
            )
            .await?;
        if closed.issue.state != "closed" {
            return Err("GitHub did not confirm Issue closure".into());
        }
        Ok(())
    }

    pub async fn issue_repository(&self, repository: &Repository) -> Result<IssueRepositoryInfo> {
        self.api(
            repository,
            "GET",
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
            return Err("Issue number must be positive".into());
        }
        let issue: IssueMetadata = self
            .api(
                repository,
                "GET",
                &repository.endpoint(&format!("issues/{number}")),
                None,
            )
            .await?;
        if issue.issue.number != number
            || issue.node_id.is_empty()
            || issue.issue.pull_request.is_some()
        {
            return Err("Expected a GitHub issue with a stable identity".into());
        }
        Ok(issue)
    }

    pub async fn issue_labels(&self, repository: &Repository) -> Result<Vec<IssueLabel>> {
        let mut labels = Vec::new();
        for page in 1..=100 {
            let rows: Vec<IssueLabel> = self
                .api(
                    repository,
                    "GET",
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
        Err("Repository label list exceeds 10000 labels".into())
    }

    pub async fn issue_assignees(&self, repository: &Repository) -> Result<Vec<IssueAssignee>> {
        let mut assignees = Vec::new();
        for page in 1..=100 {
            let rows: Vec<IssueAssignee> = self
                .api(
                    repository,
                    "GET",
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
        Err("Repository assignee list exceeds 10000 accounts".into())
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
            return Err("Label requires a name and a six-digit RGB color".into());
        }
        self.api(
            repository,
            "POST",
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
            return Err("Issue is already assigned to another account".into());
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
                "POST",
                &repository.endpoint(&format!("issues/{number}/assignees")),
                Some(json!({"assignees":[login]})),
            )
            .await?;
        if response.issue.assignees.len() != 1
            || !response.issue.assignees[0]
                .login
                .eq_ignore_ascii_case(login)
        {
            return Err("GitHub did not assign the requested account exclusively".into());
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
            return Err("Issue stage labels changed outside this assignment".into());
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
                    "DELETE",
                    &repository.endpoint(&format!("issues/{number}/labels/{segment}")),
                    None,
                )
                .await?;
        }
        if let Some(label) = desired {
            let _: serde_json::Value = self
                .api(
                    repository,
                    "POST",
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
            return Err("Issue labels changed during synchronization".into());
        }
        Ok(actual)
    }

    pub async fn linked_issue_branches(
        &self,
        repository: &Repository,
        issue_id: &str,
    ) -> Result<Vec<LinkedIssueBranch>> {
        let response: serde_json::Value = self.api(repository, "POST", "graphql", Some(json!({"query":"query($id:ID!){node(id:$id){... on Issue{linkedBranches(first:100){nodes{id ref{name target{oid}}} pageInfo{hasNextPage}}}}}","variables":{"id":issue_id}}))).await?;
        let branches = response
            .pointer("/data/node/linkedBranches")
            .ok_or("GitHub did not return issue branches")?;
        if branches
            .pointer("/pageInfo/hasNextPage")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        {
            return Err("Issue has more than 100 linked branches".into());
        }
        branches
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .ok_or("Missing linked branch list")?
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
            return Err("Linked branch requires an exact commit".into());
        }
        if let Some(existing) = self
            .linked_issue_branches(repository, issue_id)
            .await?
            .into_iter()
            .find(|branch| branch.name == name)
        {
            if existing.commit != commit {
                return Err(
                    "Existing linked branch moved from the requested starting commit".into(),
                );
            }
            return Ok(existing);
        }
        let response: serde_json::Value = self.api(repository, "POST", "graphql", Some(json!({"query":"mutation($input:CreateLinkedBranchInput!){createLinkedBranch(input:$input){linkedBranch{id ref{name target{oid}}}}}","variables":{"input":{"issueId":issue_id,"name":name,"oid":commit}}}))).await?;
        let value = response
            .pointer("/data/createLinkedBranch/linkedBranch")
            .ok_or("GitHub did not return the linked branch")?;
        let branch = LinkedIssueBranch {
            id: string(value, "/id")?,
            name: string(value, "/ref/name")?,
            commit: string(value, "/ref/target/oid")?,
        };
        if branch.name != name || branch.commit != commit {
            return Err("GitHub created a different branch or commit".into());
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
        .ok_or_else(|| format!("Missing GitHub field {pointer}"))
}

#[cfg(all(test, unix))]
#[path = "issues_tests.rs"]
mod tests;
