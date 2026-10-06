use crate::Error;
use crate::GitHub;
use crate::HttpMethod;
use crate::PullRequestFiles;
use crate::Repository;
use crate::Result;
use crate::api::Operation;
use crate::issues::validate_text;
use crate::pull_requests::validate_commit;
use crate::pull_requests::validate_number;
use crate::pull_requests::validate_page;
use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewCommentInput {
    pub path: String,
    pub line: u32,
    pub side: DiffSide,
    pub body: String,
}

pub struct ReviewDiff {
    pub base_commit: String,
    pub files: PullRequestFiles,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    Text { text: String },
    Binary,
    TooLarge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub body: String,
    pub url: String,
    pub author: Option<ReviewAuthor>,
    pub viewer_can_update: bool,
    pub viewer_can_delete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewAuthor {
    pub login: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub diff_side: DiffSide,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub viewer_can_resolve: bool,
    pub comments: ThreadComments,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComments {
    pub nodes: Vec<ReviewComment>,
    pub page_info: PageInfo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadPage {
    pub nodes: Vec<ReviewThread>,
    pub page_info: PageInfo,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadState {
    Resolved,
    Unresolved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RequestedReviewers {
    pub users: Vec<ReviewerUser>,
    pub teams: Vec<ReviewerTeam>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewerUser {
    pub login: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewerTeam {
    pub slug: String,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum ReviewerChange {
    Request,
    Remove,
}

const COMMENT_FIELDS: &str = "id body url author{login} viewerCanUpdate viewerCanDelete";
const THREAD_FIELDS: &str = "id path line diffSide isResolved isOutdated viewerCanResolve";
const PAGE_FIELDS: &str = "pageInfo{hasNextPage endCursor}";

impl GitHub {
    pub async fn requested_reviewers(
        &self,
        repository: &Repository,
        number: u64,
    ) -> Result<RequestedReviewers> {
        validate_number(number)?;
        self.api(
            repository,
            HttpMethod::Get,
            &repository.endpoint(&format!("pulls/{number}/requested_reviewers")),
            None,
        )
        .await
    }

    pub async fn change_reviewers(
        &self,
        repository: &Repository,
        number: u64,
        change: ReviewerChange,
        users: &[String],
        teams: &[String],
    ) -> Result<RequestedReviewers> {
        validate_number(number)?;
        if users.len() + teams.len() == 0
            || users.len() + teams.len() > 100
            || users
                .iter()
                .chain(teams)
                .any(|name| !crate::valid_component(name))
        {
            return Err(Error::InvalidInput(
                "Select up to 100 reviewer logins or team slugs".into(),
            ));
        }
        #[derive(Deserialize)]
        struct Changed {
            number: u64,
            requested_reviewers: Vec<ReviewerUser>,
            requested_teams: Vec<ReviewerTeam>,
        }
        let method = match change {
            ReviewerChange::Request => HttpMethod::Post,
            ReviewerChange::Remove => HttpMethod::Delete,
        };
        let changed: Changed = self
            .api(
                repository,
                method,
                &repository.endpoint(&format!("pulls/{number}/requested_reviewers")),
                Some(json!({"reviewers":users,"team_reviewers":teams})),
            )
            .await?;
        if changed.number != number {
            return Err(Error::SubmissionUncertain);
        }
        Ok(RequestedReviewers {
            users: changed.requested_reviewers,
            teams: changed.requested_teams,
        })
    }

    pub async fn update_review_comment(
        &self,
        repository: &Repository,
        number: u64,
        comment: &str,
        body: &str,
    ) -> Result<ReviewComment> {
        validate_text(body, 65_536, "Review comment")?;
        self.validate_parent(repository, number, comment, "PullRequestReviewComment")
            .await?;
        let query = format!(
            "mutation($input:UpdatePullRequestReviewCommentInput!){{updatePullRequestReviewComment(input:$input){{pullRequestReviewComment{{{COMMENT_FIELDS}}}}}}}"
        );
        let value = self
            .graphql(
                repository,
                &query,
                json!({"input":{"pullRequestReviewCommentId":comment,"body":body}}),
                Operation::Write,
            )
            .await?;
        let updated: ReviewComment =
            decode(value.pointer("/data/updatePullRequestReviewComment/pullRequestReviewComment"))
                .map_err(|_| Error::SubmissionUncertain)?;
        if updated.id != comment {
            return Err(Error::SubmissionUncertain);
        }
        Ok(updated)
    }

    pub async fn delete_review_comment(
        &self,
        repository: &Repository,
        number: u64,
        comment: &str,
    ) -> Result<()> {
        self.validate_parent(repository, number, comment, "PullRequestReviewComment")
            .await?;
        // Deletion has no returned object; the echoed mutation identity confirms its acknowledgement.
        let value = self.graphql(repository, "mutation($input:DeletePullRequestReviewCommentInput!){deletePullRequestReviewComment(input:$input){clientMutationId}}", json!({"input":{"id":comment,"clientMutationId":comment}}), Operation::Write).await?;
        if value
            .pointer("/data/deletePullRequestReviewComment/clientMutationId")
            .and_then(serde_json::Value::as_str)
            != Some(comment)
        {
            return Err(Error::SubmissionUncertain);
        }
        Ok(())
    }
    /// Files and comments refer to the reviewed head; a changed PR must be reopened.
    pub async fn review_diff(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        page: u32,
    ) -> Result<ReviewDiff> {
        validate_commit(commit)?;
        validate_page(page)?;
        let current = self.pull_request(repository, number).await?;
        if !current.head.sha.eq_ignore_ascii_case(commit) {
            return Err(Error::Conflict(
                "PR changed since it was opened for review".into(),
            ));
        }
        // A PR diff starts at the merge base, not the current tip of its target branch.
        let comparison: serde_json::Value = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("compare/{}...{commit}", current.base.sha)),
                None,
            )
            .await?;
        let base_commit = comparison
            .pointer("/merge_base_commit/sha")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| Error::InvalidResponse("Missing merge base".into()))?
            .to_owned();
        validate_commit(&base_commit)
            .map_err(|_| Error::InvalidResponse("Invalid merge base".into()))?;
        let files = self.pull_request_files(repository, number, page).await?;
        let after = self.pull_request(repository, number).await?;
        if after.head.sha != current.head.sha || after.base.sha != current.base.sha {
            return Err(Error::Conflict(
                "PR changed while its files were loading".into(),
            ));
        }
        Ok(ReviewDiff { base_commit, files })
    }

    pub async fn file_content(
        &self,
        repository: &Repository,
        commit: &str,
        path: &str,
    ) -> Result<FileContent> {
        validate_commit(commit)?;
        validate_path(path)?;
        let encoded = path
            .split('/')
            .map(|part| {
                url::form_urlencoded::byte_serialize(part.as_bytes())
                    .collect::<String>()
                    .replace('+', "%20")
            })
            .collect::<Vec<_>>()
            .join("/");
        let value: serde_json::Value = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("contents/{encoded}?ref={commit}")),
                None,
            )
            .await?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("file") {
            return Err(Error::InvalidInput("Review content must be a file".into()));
        }
        let size = value
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| Error::InvalidResponse("Missing file size".into()))?;
        if size > 1024 * 1024 {
            return Ok(FileContent::TooLarge);
        }
        if value.get("encoding").and_then(serde_json::Value::as_str) != Some("base64") {
            return Err(Error::InvalidResponse("Unsupported file encoding".into()));
        }
        let encoded = value
            .get("content")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| Error::InvalidResponse("Missing file content".into()))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.replace(['\n', '\r'], ""))
            .map_err(|_| Error::InvalidResponse("Invalid file encoding".into()))?;
        if bytes.len() as u64 != size {
            return Err(Error::InvalidResponse(
                "File size does not match content".into(),
            ));
        }
        if bytes.contains(&0) {
            return Ok(FileContent::Binary);
        }
        match String::from_utf8(bytes) {
            Ok(text) => Ok(FileContent::Text { text }),
            Err(_) => Ok(FileContent::Binary),
        }
    }

    pub async fn review_threads(
        &self,
        repository: &Repository,
        number: u64,
        cursor: Option<&str>,
    ) -> Result<ReviewThreadPage> {
        validate_number(number)?;
        validate_cursor(cursor)?;
        let query = format!(
            "query($owner:String!,$name:String!,$number:Int!,$cursor:String){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{reviewThreads(first:50,after:$cursor){{nodes{{{THREAD_FIELDS} comments(first:100){{nodes{{{COMMENT_FIELDS}}} {PAGE_FIELDS}}}}} {PAGE_FIELDS}}}}}}}}}"
        );
        let value = self.graphql(repository, &query, json!({"owner":repository.owner,"name":repository.name,"number":number,"cursor":cursor}), Operation::Read).await?;
        decode(value.pointer("/data/repository/pullRequest/reviewThreads"))
    }

    pub async fn thread_comments(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        cursor: Option<&str>,
    ) -> Result<ThreadComments> {
        validate_cursor(cursor)?;
        self.validate_thread(repository, number, thread).await?;
        let query = format!(
            "query($id:ID!,$cursor:String){{node(id:$id){{... on PullRequestReviewThread{{comments(first:100,after:$cursor){{nodes{{{COMMENT_FIELDS}}} {PAGE_FIELDS}}}}}}}}}"
        );
        let value = self
            .graphql(
                repository,
                &query,
                json!({"id":thread,"cursor":cursor}),
                Operation::Read,
            )
            .await?;
        decode(value.pointer("/data/node/comments"))
    }

    pub async fn reply_review_thread(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        body: &str,
    ) -> Result<ReviewComment> {
        validate_text(body, 65_536, "Reply")?;
        self.validate_thread(repository, number, thread).await?;
        let query = format!(
            "mutation($input:AddPullRequestReviewThreadReplyInput!){{addPullRequestReviewThreadReply(input:$input){{comment{{{COMMENT_FIELDS}}}}}}}"
        );
        let value = self
            .graphql(
                repository,
                &query,
                json!({"input":{"pullRequestReviewThreadId":thread,"body":body}}),
                Operation::Write,
            )
            .await?;
        decode(value.pointer("/data/addPullRequestReviewThreadReply/comment"))
            .map_err(|_| Error::SubmissionUncertain)
    }

    pub async fn resolve_review_thread(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        state: ThreadState,
    ) -> Result<()> {
        self.validate_thread(repository, number, thread).await?;
        let (mutation, input, resolved) = match state {
            ThreadState::Resolved => ("resolveReviewThread", "ResolveReviewThreadInput", true),
            ThreadState::Unresolved => {
                ("unresolveReviewThread", "UnresolveReviewThreadInput", false)
            }
        };
        let query = format!(
            "mutation($input:{input}!){{{mutation}(input:$input){{thread{{id isResolved}}}}}}"
        );
        let value = self
            .graphql(
                repository,
                &query,
                json!({"input":{"threadId":thread}}),
                Operation::Write,
            )
            .await?;
        let returned = value.pointer(&format!("/data/{mutation}/thread"));
        if returned
            .and_then(|v| v.get("id"))
            .and_then(serde_json::Value::as_str)
            != Some(thread)
            || returned
                .and_then(|v| v.get("isResolved"))
                .and_then(serde_json::Value::as_bool)
                != Some(resolved)
        {
            return Err(Error::SubmissionUncertain);
        }
        Ok(())
    }

    // Node IDs alone carry no repository authority. Check the thread's parent before mutation.
    async fn validate_thread(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
    ) -> Result<()> {
        self.validate_parent(repository, number, thread, "PullRequestReviewThread")
            .await
    }

    async fn validate_parent(
        &self,
        repository: &Repository,
        number: u64,
        node: &str,
        kind: &str,
    ) -> Result<()> {
        validate_number(number)?;
        validate_text(node, 256, "Review node ID")?;
        let query = format!(
            "query($id:ID!){{node(id:$id){{... on {kind}{{pullRequest{{number repository{{name owner{{login}}}}}}}}}}}}"
        );
        let value = self
            .graphql(repository, &query, json!({"id":node}), Operation::Read)
            .await?;
        let parent = value
            .pointer("/data/node/pullRequest")
            .ok_or(Error::NotFound)?;
        if parent.get("number").and_then(serde_json::Value::as_u64) != Some(number)
            || parent
                .pointer("/repository/name")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|name| !name.eq_ignore_ascii_case(&repository.name))
            || parent
                .pointer("/repository/owner/login")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|owner| !owner.eq_ignore_ascii_case(&repository.owner))
        {
            return Err(Error::PermissionDenied);
        }
        Ok(())
    }
}

pub(crate) fn validate_comments(comments: &[ReviewCommentInput]) -> Result<()> {
    if comments.len() > 100 {
        return Err(Error::InvalidInput(
            "A review accepts at most 100 comments".into(),
        ));
    }
    for comment in comments {
        validate_path(&comment.path)?;
        if comment.line == 0 {
            return Err(Error::InvalidInput("Review lines start at one".into()));
        }
        validate_text(&comment.body, 65_536, "Review comment")?;
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains(['\0', '\\'])
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(Error::InvalidInput("Invalid repository file path".into()));
    }
    Ok(())
}

fn validate_cursor(cursor: Option<&str>) -> Result<()> {
    if let Some(cursor) = cursor {
        validate_text(cursor, 1024, "Pagination cursor")?;
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(value: Option<&serde_json::Value>) -> Result<T> {
    serde_json::from_value(
        value
            .cloned()
            .ok_or_else(|| Error::InvalidResponse("Missing GitHub review result".into()))?,
    )
    .map_err(|_| Error::InvalidResponse("Invalid GitHub review result".into()))
}

#[cfg(test)]
#[path = "reviews_tests.rs"]
mod tests;
