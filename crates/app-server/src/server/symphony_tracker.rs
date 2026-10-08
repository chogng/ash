use super::AppServer;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpHeader;
use ash_http_client::HttpRequest;
use ash_symphony::Issue;
use ash_symphony::Tracker;
use ash_symphony::Workflow;
use serde::Deserialize;
use std::collections::BTreeMap;

impl AppServer {
    pub(crate) fn poll_symphony(
        &self,
        workflow: &Workflow,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Issue>, String> {
        match &workflow.tracker {
            Tracker::Local => Ok(Vec::new()),
            Tracker::Github { repo } => {
                let (owner, name) = repo.split_once('/').ok_or("Invalid GitHub repository")?;
                let github = self
                    .github_client(cancellation)
                    .map_err(|error| error.to_string())?;
                let repository = github::Repository::new(
                    github.authorization().host.clone(),
                    owner.into(),
                    name.into(),
                )
                .map_err(|error| error.to_string())?;
                let runtime = self.issue_runtime().map_err(|error| error.to_string())?;
                let mut issues = Vec::new();
                // Read both states before reconciling. A failed page never retires existing work.
                for state in [github::IssueState::Open, github::IssueState::Closed] {
                    let mut page = 1;
                    loop {
                        cancellation.check().map_err(|error| error.to_string())?;
                        let result = runtime
                            .block_on(github.issues(&repository, state, page))
                            .map_err(|_| {
                                "GitHub issue polling failed; check account access".to_owned()
                            })?;
                        for issue in result
                            .issues
                            .into_iter()
                            .filter(|issue| issue.pull_request.is_none())
                        {
                            issues.push(Issue {
                                id: format!("{repo}#{}", issue.number),
                                identifier: format!("{repo}#{}", issue.number),
                                title: issue.title,
                                description: issue.body.unwrap_or_default(),
                                state: issue.state,
                                url: Some(issue.html_url),
                                labels: issue.labels.into_iter().map(|label| label.name).collect(),
                                priority: None,
                                created_at: issue.created_at,
                                updated_at: Some(issue.updated_at),
                                branch_name: None,
                                assignee_id: None,
                                blocked_by: BTreeMap::new(),
                                local: false,
                                dispatchable: true,
                            });
                        }
                        if issues.len() > 2000 {
                            return Err(
                                "GitHub workflow exceeds 2000 issues; select a smaller repository"
                                    .into(),
                            );
                        }
                        match result.next_page {
                            Some(next) if next > page && next <= 100 => page = next,
                            Some(_) => {
                                return Err(
                                    "GitHub issue pagination exceeds the workflow limit".into()
                                );
                            }
                            None => break,
                        }
                    }
                }
                Ok(issues)
            }
            Tracker::Linear { project_slug, .. } => {
                self.poll_symphony_linear(workflow, project_slug, &[], cancellation)
            }
        }
    }

    pub(crate) fn refresh_symphony(
        &self,
        workflow: &Workflow,
        id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<Issue>, String> {
        match &workflow.tracker {
            Tracker::Linear { project_slug, .. } => Ok(self
                .poll_symphony_linear(workflow, project_slug, &[id.into()], cancellation)?
                .into_iter()
                .find(|issue| issue.id == id)),
            Tracker::Github { repo } => {
                let number = id
                    .strip_prefix(&format!("{repo}#"))
                    .and_then(|number| number.parse().ok())
                    .ok_or("Invalid GitHub issue ID")?;
                let (owner, name) = repo.split_once('/').ok_or("Invalid GitHub repository")?;
                let github = self
                    .github_client(cancellation)
                    .map_err(|error| error.to_string())?;
                let repository = github::Repository::new(
                    github.authorization().host.clone(),
                    owner.into(),
                    name.into(),
                )
                .map_err(|error| error.to_string())?;
                let result = self
                    .issue_runtime()
                    .map_err(|error| error.to_string())?
                    .block_on(github.issue(&repository, number));
                match result {
                    Ok(snapshot) => {
                        let issue = snapshot.issue;
                        Ok(Some(Issue {
                            id: id.into(),
                            identifier: id.into(),
                            title: issue.title,
                            description: issue.body.unwrap_or_default(),
                            state: issue.state,
                            url: Some(issue.html_url),
                            labels: issue.labels.into_iter().map(|label| label.name).collect(),
                            priority: None,
                            created_at: issue.created_at,
                            updated_at: Some(issue.updated_at),
                            branch_name: None,
                            assignee_id: None,
                            blocked_by: BTreeMap::new(),
                            local: false,
                            dispatchable: issue.pull_request.is_none(),
                        }))
                    }
                    Err(github::Error::NotFound) => Ok(None),
                    Err(_) => Err("GitHub issue refresh failed; check account access".into()),
                }
            }
            Tracker::Local => Ok(None),
        }
    }

    fn symphony_linear_request(
        &self,
        endpoint: &str,
        token: &str,
        payload: serde_json::Value,
        cancellation: &CancellationToken,
    ) -> Result<serde_json::Value, String> {
        let http = self
            .symphony_http
            .as_ref()
            .ok_or("Tracker transport is unavailable")?;
        let request = HttpRequest::post(
            endpoint,
            vec![
                HttpHeader::new("Authorization", token),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            serde_json::to_vec(&payload).map_err(|_| "Linear query could not be encoded")?,
        )
        .map_err(|_| "Linear credential or request is invalid")?
        .without_redirects();
        let response = http
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| "Linear issue polling failed")?;
        if !response.is_success() {
            return Err(format!(
                "Linear issue polling returned HTTP {}",
                response.status()
            ));
        }
        let envelope: serde_json::Value =
            serde_json::from_slice(response.body()).map_err(|_| "Linear response is invalid")?;
        if envelope
            .get("errors")
            .is_some_and(|errors| !errors.as_array().is_some_and(Vec::is_empty))
        {
            return Err(
                "Linear rejected the issue query; check credential and project access".into(),
            );
        }
        Ok(envelope)
    }

    fn poll_symphony_linear(
        &self,
        workflow: &Workflow,
        project: &str,
        ids: &[String],
        cancellation: &CancellationToken,
    ) -> Result<Vec<Issue>, String> {
        let token = workflow
            .linear_credential()
            .map_err(|error| error.to_string())?;
        self.fetch_symphony_linear(workflow, project, &token, ids, cancellation)
    }

    fn fetch_symphony_linear(
        &self,
        workflow: &Workflow,
        project: &str,
        token: &str,
        ids: &[String],
        cancellation: &CancellationToken,
    ) -> Result<Vec<Issue>, String> {
        let endpoint = workflow
            .tracker_endpoint
            .as_deref()
            .unwrap_or("https://api.linear.app/graphql");
        let assignee = match workflow.tracker_assignee.as_deref().map(str::trim) {
            Some("me") => {
                let viewer = self.symphony_linear_request(
                    endpoint,
                    token,
                    serde_json::json!({"query":"query SymphonyViewer { viewer { id } }"}),
                    cancellation,
                )?;
                Some(
                    viewer["data"]["viewer"]["id"]
                        .as_str()
                        .filter(|id| !id.trim().is_empty())
                        .ok_or("Linear viewer ID is missing")?
                        .to_lowercase(),
                )
            }
            Some(assignee) if !assignee.is_empty() => Some(assignee.to_lowercase()),
            _ => None,
        };
        let mut filter = serde_json::json!({"project":{"slugId":{"eq":project}}});
        if !ids.is_empty() {
            filter["id"] = serde_json::json!({"in":ids});
        }
        let mut issues = Vec::new();
        let mut after = None::<String>;
        let mut pages = 0;
        loop {
            pages += 1;
            if pages > 40 {
                return Err("Linear issue pagination exceeds the workflow limit".into());
            }
            cancellation.check().map_err(|error| error.to_string())?;
            let body = self.symphony_linear_request(endpoint, token,
                serde_json::json!({"query":LINEAR_QUERY,"variables":{"filter":filter,"after":after}}), cancellation)?;
            let envelope: LinearEnvelope =
                serde_json::from_value(body).map_err(|_| "Linear response is invalid")?;
            let page = envelope.data.ok_or("Linear issue data is missing")?.issues;
            for issue in page.nodes {
                let mut blocked_by = BTreeMap::new();
                for relation in issue.inverse_relations.nodes {
                    if relation.kind == "blocks" {
                        blocked_by.insert(relation.issue.id, relation.issue.state.name);
                    }
                }
                issues.push(Issue {
                    id: issue.id,
                    identifier: issue.identifier,
                    title: issue.title,
                    description: issue.description.unwrap_or_default(),
                    state: issue.state.name,
                    url: Some(issue.url),
                    labels: issue
                        .labels
                        .nodes
                        .into_iter()
                        .map(|label| label.name)
                        .collect(),
                    priority: (issue.priority > 0).then_some(issue.priority),
                    created_at: issue.created_at.unwrap_or_default(),
                    updated_at: issue.updated_at,
                    branch_name: issue.branch_name,
                    dispatchable: assignee.as_ref().is_none_or(|expected| {
                        issue
                            .assignee
                            .as_ref()
                            .is_some_and(|actual| actual.id.trim().eq_ignore_ascii_case(expected))
                    }),
                    assignee_id: issue.assignee.map(|assignee| assignee.id),
                    blocked_by,
                    local: false,
                });
            }
            if issues.len() > 2000 {
                return Err("Linear workflow exceeds 2000 issues; select a smaller project".into());
            }
            if !page.page_info.has_next_page {
                return Ok(issues);
            }
            let cursor = page
                .page_info
                .end_cursor
                .ok_or("Linear pagination cursor is missing")?;
            if after.as_ref() == Some(&cursor) {
                return Err("Linear pagination did not advance".into());
            }
            after = Some(cursor);
        }
    }
}

// All project states are required to stop moved, completed and deleted tasks safely.
const LINEAR_QUERY: &str = r#"query SymphonyIssues($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, filter: $filter) {
    nodes { id identifier title description url priority createdAt updatedAt branchName assignee { id } state { name }
      labels { nodes { name } }
      inverseRelations { nodes { type issue { id state { name } } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}"#;

#[derive(Deserialize)]
struct LinearEnvelope {
    data: Option<LinearData>,
}
#[derive(Deserialize)]
struct LinearData {
    issues: LinearPage,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearPage {
    nodes: Vec<LinearIssue>,
    page_info: PageInfo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinearIssue {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    priority: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
    branch_name: Option<String>,
    assignee: Option<Assignee>,
    state: Named,
    labels: Nodes<Named>,
    inverse_relations: Nodes<Relation>,
}
#[derive(Deserialize)]
struct Assignee {
    id: String,
}
#[derive(Deserialize)]
struct Named {
    name: String,
}
#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}
#[derive(Deserialize)]
struct Relation {
    #[serde(rename = "type")]
    kind: String,
    issue: RelatedIssue,
}
#[derive(Deserialize)]
struct RelatedIssue {
    id: String,
    state: Named,
}

#[cfg(test)]
#[path = "symphony_tracker_tests.rs"]
mod tests;
