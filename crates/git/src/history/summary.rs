use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use std::ffi::OsString;
use std::num::NonZeroUsize;
/// Minimal commit metadata suitable for history lists and pickers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitSummary {
    object_id: String,
    parent_object_ids: Vec<String>,
    timestamp_seconds: i64,
    subject: String,
}

impl GitCommitSummary {
    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    pub fn parent_object_ids(&self) -> &[String] {
        &self.parent_object_ids
    }

    pub fn timestamp_seconds(&self) -> i64 {
        self.timestamp_seconds
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }
}

impl GitClient {
    pub async fn recent_commits(
        &self,
        repository: &GitRepository,
        limit: NonZeroUsize,
    ) -> GitResult<Vec<GitCommitSummary>> {
        let limit_arg = format!("-n{}", limit.get());
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    OsString::from("log"),
                    OsString::from("-z"),
                    OsString::from("--format=%H%x00%P%x00%ct%x00%s"),
                    OsString::from(limit_arg),
                ],
            )
            .await?;
        parse_commits(&output.stdout, &output.command)
    }
}
pub(crate) fn parse_commits(bytes: &[u8], command: &str) -> GitResult<Vec<GitCommitSummary>> {
    let mut fields = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.len() % 4 != 0 {
        return Err(GitError::invalid_output(
            command,
            "commit output did not contain groups of four fields",
        ));
    }
    fields
        .chunks_exact(4)
        .map(|fields| parse_commit_fields([fields[0], fields[1], fields[2], fields[3]], command))
        .collect()
}

pub(crate) fn parse_commit_fields(
    fields: [&[u8]; 4],
    command: &str,
) -> GitResult<GitCommitSummary> {
    let object_id = utf8(fields[0], command, "commit object id")?.to_string();
    let parent_object_ids = utf8(fields[1], command, "commit parent object ids")?
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let timestamp = utf8(fields[2], command, "commit timestamp")?;
    let timestamp_seconds = timestamp
        .parse()
        .map_err(|_| GitError::invalid_output(command, "commit timestamp was not an integer"))?;
    let subject = utf8(fields[3], command, "commit subject")?.to_string();
    Ok(GitCommitSummary {
        object_id,
        parent_object_ids,
        timestamp_seconds,
        subject,
    })
}

fn utf8<'a>(value: &'a [u8], command: &str, label: &str) -> GitResult<&'a str> {
    std::str::from_utf8(value)
        .map_err(|_| GitError::invalid_output(command, format!("{label} was not UTF-8")))
}

#[cfg(test)]
#[path = "summary_tests.rs"]
mod tests;
