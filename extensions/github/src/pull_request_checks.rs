use crate::GitHub;
use crate::api::Operation;
use crate::endpoint;
use ash_http_client::HttpMethod;
use chrono::DateTime;
use github::Error;
use github::PullRequestChecks;
use github::PullRequestChecksStatus;
use github::Repository;
use github::Result;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

const PAGE_SIZE: usize = 100;
const PAGE_LIMIT: usize = 30;

const QUERY: &str = r"
query AshPullRequestChecks($owner: String!, $repo: String!, $number: Int!, $headCursor: String, $mergeCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      baseRefName
      headRefOid
      potentialMergeCommit {
        oid
        statusCheckRollup {
          contexts(first: 100, after: $mergeCursor) { ...CheckPage }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $headCursor) { ...CheckPage }
            }
          }
        }
      }
    }
  }
}

fragment CheckPage on StatusCheckRollupContextConnection {
  nodes {
    __typename
    ... on CheckRun { name status conclusion completedAt startedAt isRequired(pullRequestNumber: $number) }
    ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
  }
  pageInfo { hasNextPage endCursor }
}";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCommits {
    base_ref_name: String,
    head_ref_oid: String,
    potential_merge_commit: Option<Commit>,
    commits: Nodes<PullRequestCommit>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct PullRequestCommit {
    commit: Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    oid: String,
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    contexts: CheckPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckPage {
    nodes: Vec<Check>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
enum Check {
    CheckRun {
        name: String,
        status: String,
        conclusion: Option<String>,
        completed_at: Option<String>,
        started_at: Option<String>,
        is_required: bool,
    },
    StatusContext {
        context: String,
        state: String,
        is_required: bool,
    },
}

impl Check {
    fn timestamp(&self) -> Option<i64> {
        match self {
            Self::CheckRun {
                completed_at,
                started_at,
                ..
            } => [completed_at.as_deref(), started_at.as_deref()]
                .into_iter()
                .flatten()
                .find_map(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|time| time.timestamp_millis()),
            Self::StatusContext { .. } => None,
        }
    }

    fn status(&self) -> PullRequestChecksStatus {
        use PullRequestChecksStatus::*;
        match self {
            Self::CheckRun {
                status, conclusion, ..
            } => match (status.as_str(), conclusion.as_deref()) {
                ("COMPLETED", Some("SUCCESS" | "NEUTRAL" | "SKIPPED")) => Success,
                ("COMPLETED", Some(_)) => Failure,
                _ => Pending,
            },
            Self::StatusContext { state, .. } => match state.as_str() {
                "SUCCESS" => Success,
                "PENDING" | "EXPECTED" => Pending,
                _ => Failure,
            },
        }
    }

    fn required_name(&self) -> Option<&str> {
        match self {
            Self::CheckRun {
                name, is_required, ..
            } => is_required.then_some(name),
            Self::StatusContext {
                context,
                is_required,
                ..
            } => is_required.then_some(context),
        }
    }
}

#[derive(Deserialize)]
struct Branch {
    name: String,
    protection: Option<Protection>,
}

#[derive(Deserialize)]
struct Protection {
    required_status_checks: Option<ProtectedChecks>,
}

#[derive(Deserialize)]
struct ProtectedChecks {
    enforcement_level: Option<String>,
    #[serde(default)]
    contexts: Vec<String>,
    #[serde(default)]
    checks: Vec<RequiredCheck>,
}

#[derive(Deserialize)]
struct RequiredCheck {
    context: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BranchRule {
    RequiredStatusChecks {
        parameters: RequiredChecksRule,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct RequiredChecksRule {
    required_status_checks: Vec<RequiredCheck>,
}

impl GitHub {
    pub(crate) async fn pull_request_checks(
        &self,
        repository: &Repository,
        number: u64,
        head_commit: &str,
    ) -> Result<PullRequestChecks> {
        let number = i32::try_from(number)
            .ok()
            .filter(|number| *number > 0)
            .ok_or_else(|| {
                Error::InvalidInput("Use a positive GitHub pull request number".into())
            })?;
        if head_commit.len() != 40 || !head_commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::InvalidInput(
                "Use a full hexadecimal PR head SHA".into(),
            ));
        }

        let stale_checks = PullRequestChecks {
            status: PullRequestChecksStatus::Pending,
            latest_check_at_unix_ms: None,
        };
        let mut checks = Vec::new();
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        let mut base = String::new();
        let mut merge_oid: Option<String> = None;
        for _ in 0..PAGE_LIMIT {
            // Each cursor belongs to one commit's connection.
            let (head_cursor, merge_cursor) = if merge_oid.is_some() {
                (None, cursor.as_ref())
            } else {
                (cursor.as_ref(), None)
            };
            let response = self
                .graphql(
                    repository,
                    QUERY,
                    json!({
                        "owner": repository.owner, "repo": repository.name, "number": number,
                        "headCursor": head_cursor, "mergeCursor": merge_cursor,
                    }),
                    Operation::Read,
                )
                .await?;
            let pr = response
                .pointer("/data/repository/pullRequest")
                .filter(|value| !value.is_null())
                .ok_or(Error::NotFound)?;
            let pr: PullRequestCommits = serde_json::from_value(pr.clone())
                .map_err(|_| Error::InvalidResponse("Invalid GitHub pull request checks".into()))?;
            if !pr.head_ref_oid.eq_ignore_ascii_case(head_commit)
                || (cursor.is_some() && pr.base_ref_name != base)
            {
                return Ok(stale_checks);
            }
            base = pr.base_ref_name;
            let Some(head) = pr
                .commits
                .nodes
                .into_iter()
                .next()
                .map(|entry| entry.commit)
            else {
                return Ok(stale_checks);
            };
            if !head.oid.eq_ignore_ascii_case(head_commit) {
                return Ok(stale_checks);
            }
            let merge = pr.potential_merge_commit.filter(|commit| {
                commit.status_check_rollup.as_ref().is_some_and(|rollup| {
                    merge_cursor.is_some()
                        || !rollup.contexts.nodes.is_empty()
                        || rollup.contexts.page_info.has_next_page
                })
            });
            let current_merge_oid = merge.as_ref().map(|commit| &commit.oid);
            if cursor.is_some() && merge_oid.as_ref() != current_merge_oid {
                return Ok(stale_checks);
            }
            merge_oid = current_merge_oid.cloned();
            let commit = merge.unwrap_or(head);
            if let Some(rollup) = commit.status_check_rollup {
                checks.extend(rollup.contexts.nodes);
                if rollup.contexts.page_info.has_next_page {
                    cursor = Some(
                        rollup
                            .contexts
                            .page_info
                            .end_cursor
                            .filter(|next| !next.is_empty() && cursors.insert(next.clone()))
                            .ok_or_else(|| {
                                Error::InvalidResponse("Invalid GitHub check page cursor".into())
                            })?,
                    );
                    continue;
                }
            } else if cursor.is_some() {
                return Ok(stale_checks);
            }
            let required = self.required_check_names(repository, &base).await?;
            return Ok(summarize_checks(&checks, required));
        }
        Err(Error::InvalidResponse(
            "GitHub pull request checks exceeded the page limit".into(),
        ))
    }

    async fn required_check_names(
        &self,
        repository: &Repository,
        base: &str,
    ) -> Result<HashSet<String>> {
        let encoded: String = url::form_urlencoded::byte_serialize(base.as_bytes()).collect();
        let branch: Branch = self
            .api(
                repository,
                HttpMethod::Get,
                &endpoint(repository, &format!("branches/{encoded}")),
                None,
            )
            .await?;
        if branch.name != base {
            return Err(Error::InvalidResponse(
                "GitHub returned a different base branch".into(),
            ));
        }
        let mut names = HashSet::new();
        if let Some(protection) = branch
            .protection
            .and_then(|value| value.required_status_checks)
            && protection.enforcement_level.as_deref() != Some("off")
        {
            names.extend(protection.contexts);
            names.extend(protection.checks.into_iter().map(|check| check.context));
        }

        for page in 1..=PAGE_LIMIT {
            let path = format!("rules/branches/{encoded}?per_page={PAGE_SIZE}&page={page}");
            let rules: Vec<BranchRule> = match self
                .api(
                    repository,
                    HttpMethod::Get,
                    &endpoint(repository, &path),
                    None,
                )
                .await
            {
                // Enterprise hosts that predate rulesets still report classic protection.
                Err(Error::NotFound) if page == 1 => return Ok(names),
                result => result?,
            };
            let last_page = rules.len() < PAGE_SIZE;
            for rule in rules {
                if let BranchRule::RequiredStatusChecks { parameters } = rule {
                    names.extend(
                        parameters
                            .required_status_checks
                            .into_iter()
                            .map(|check| check.context),
                    );
                }
            }
            if last_page {
                return Ok(names);
            }
        }
        Err(Error::InvalidResponse(
            "GitHub branch rules exceeded the page limit".into(),
        ))
    }
}

fn summarize_checks(checks: &[Check], mut unreported: HashSet<String>) -> PullRequestChecks {
    use PullRequestChecksStatus::*;
    let filter_required =
        !unreported.is_empty() || checks.iter().any(|check| check.required_name().is_some());
    let mut status = Neutral;
    let mut latest_check_at_unix_ms = None;
    for check in checks {
        if let Some(name) = check.required_name() {
            unreported.remove(name);
        } else if filter_required {
            continue;
        }
        latest_check_at_unix_ms = latest_check_at_unix_ms.max(check.timestamp());
        match check.status() {
            Failure => status = Failure,
            Pending if status != Failure => status = Pending,
            Success if status == Neutral => status = Success,
            Pending | Success | Neutral => {}
        }
    }
    if status != Failure && !unreported.is_empty() {
        status = Pending;
    }
    PullRequestChecks {
        status,
        latest_check_at_unix_ms,
    }
}

#[cfg(test)]
#[path = "pull_request_checks_tests.rs"]
mod tests;
