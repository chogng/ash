use std::ffi::OsString;
use std::num::NonZeroUsize;

use crate::GitClient;
use crate::GitCommitSummary;
use crate::GitError;
use crate::GitRemote;
use crate::GitRepository;
use crate::GitResult;
use crate::client::GitQueryStream;

/// The ref kinds that can be shown in a repository graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitReferenceKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

/// One branch or tag ref associated with a repository graph object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReference {
    name: String,
    object_id: String,
    kind: GitReferenceKind,
    remote_name: Option<String>,
    current: bool,
}

impl GitReference {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    pub fn kind(&self) -> GitReferenceKind {
        self.kind
    }

    pub fn remote_name(&self) -> Option<&str> {
        self.remote_name.as_deref()
    }

    pub fn is_current(&self) -> bool {
        self.current
    }
}

/// A page of graph data containing reachable commits, branch refs, and configured remotes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitGraph {
    commits: Vec<GitCommitSummary>,
    references: Vec<GitReference>,
    remotes: Vec<GitRemote>,
    has_more: bool,
}

impl GitGraph {
    pub fn commits(&self) -> &[GitCommitSummary] {
        &self.commits
    }

    pub fn references(&self) -> &[GitReference] {
        &self.references
    }

    pub fn remotes(&self) -> &[GitRemote] {
        &self.remotes
    }

    pub const fn has_more(&self) -> bool {
        self.has_more
    }
}

/// Stateful reader for one repository graph traversal.
///
/// A cursor owns the Git log process and the ref metadata captured when traversal starts. Callers
/// should keep it for the lifetime of one history list and request pages in order. Dropping it
/// terminates the underlying process without affecting the repository.
pub struct GitGraphCursor {
    stream: Option<GitQueryStream>,
    references: Vec<GitReference>,
    remotes: Vec<GitRemote>,
    pending: Option<GitCommitSummary>,
    done: bool,
}

impl GitGraphCursor {
    /// Reads the next bounded page from this traversal.
    pub async fn page(&mut self, limit: NonZeroUsize) -> GitResult<GitGraph> {
        if self.done {
            return Err(GitError::InvalidConfiguration {
                field: "graph_cursor",
                requirement: "must not be exhausted",
            });
        }
        let mut commits = Vec::with_capacity(limit.get());
        if let Some(commit) = self.pending.take() {
            commits.push(commit);
        }
        while commits.len() < limit.get() {
            let Some(commit) = self.next_commit().await? else {
                break;
            };
            commits.push(commit);
        }
        let has_more = if self.done {
            false
        } else if let Some(commit) = self.next_commit().await? {
            self.pending = Some(commit);
            true
        } else {
            false
        };
        Ok(GitGraph {
            commits,
            references: self.references.clone(),
            remotes: self.remotes.clone(),
            has_more,
        })
    }

    async fn next_commit(&mut self) -> GitResult<Option<GitCommitSummary>> {
        let Some(object_id) = self
            .stream
            .as_mut()
            .expect("active graph cursor stream")
            .next_field()
            .await?
        else {
            let stream = self.stream.take().expect("active graph cursor stream");
            self.done = true;
            stream.finish().await?;
            return Ok(None);
        };
        let parents = self.required_field("commit parent object ids").await?;
        let timestamp = self.required_field("commit timestamp").await?;
        let subject = self.required_field("commit subject").await?;
        let command = self
            .stream
            .as_ref()
            .map(|stream| stream.command())
            .unwrap_or("git log");
        super::info::parse_commit_fields([&object_id, &parents, &timestamp, &subject], command)
            .map(Some)
    }

    async fn required_field(&mut self, label: &str) -> GitResult<Vec<u8>> {
        let field = self
            .stream
            .as_mut()
            .expect("active graph cursor stream")
            .next_field()
            .await?;
        field.ok_or_else(|| {
            let command = self
                .stream
                .as_ref()
                .map(|stream| stream.command())
                .unwrap_or("git log");
            GitError::invalid_output(command, format!("stream omitted {label}"))
        })
    }
}

impl GitClient {
    /// Starts one repository graph traversal with refs and remotes captured once.
    pub async fn start_graph(&self, repository: &GitRepository) -> GitResult<GitGraphCursor> {
        let references = self.references(repository).await?;
        let remotes = self.remotes(repository).await?;
        let stream = self.start_query_stream(
            repository.worktree_root(),
            [
                OsString::from("log"),
                OsString::from("--all"),
                OsString::from("--topo-order"),
                OsString::from("-z"),
                OsString::from("--format=%H%x00%P%x00%ct%x00%s"),
            ],
        )?;
        Ok(GitGraphCursor {
            stream: Some(stream),
            references,
            remotes,
            pending: None,
            done: false,
        })
    }

    /// Lists branches and tags. Annotated tags point at their target so graph labels attach to commits.
    pub async fn references(&self, repository: &GitRepository) -> GitResult<Vec<GitReference>> {
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "for-each-ref",
                    "--format=%(refname)%00%(objectname)%00%(symref)%00%(HEAD)%00%(*objectname)",
                    "refs/heads",
                    "refs/remotes",
                    "refs/tags",
                ],
            )
            .await?;
        parse_references(&output.stdout, &output.command)
    }
}

fn parse_references(bytes: &[u8], command: &str) -> GitResult<Vec<GitReference>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::invalid_output(command, "ref output was not UTF-8"))?;
    let mut references = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(GitError::invalid_output(
                command,
                format!("ref record had {} fields instead of 5", fields.len()),
            ));
        }
        if !fields[2].is_empty() {
            continue;
        }
        let full_name = fields[0];
        let object_id = fields[1];
        if object_id.is_empty() {
            return Err(GitError::invalid_output(
                command,
                "ref record omitted object id",
            ));
        }
        let reference = if let Some(name) = full_name.strip_prefix("refs/heads/") {
            if name.is_empty() {
                return Err(GitError::invalid_output(command, "local ref omitted name"));
            }
            GitReference {
                name: name.to_string(),
                object_id: object_id.to_string(),
                kind: GitReferenceKind::LocalBranch,
                remote_name: None,
                current: fields[3] == "*",
            }
        } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
            let Some((remote_name, branch_name)) = name.split_once('/') else {
                return Err(GitError::invalid_output(
                    command,
                    "remote ref omitted remote or branch name",
                ));
            };
            if remote_name.is_empty() || branch_name.is_empty() {
                return Err(GitError::invalid_output(
                    command,
                    "remote ref omitted remote or branch name",
                ));
            }
            GitReference {
                name: name.to_string(),
                object_id: object_id.to_string(),
                kind: GitReferenceKind::RemoteBranch,
                remote_name: Some(remote_name.to_string()),
                current: false,
            }
        } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
            GitReference {
                name: name.to_string(),
                object_id: if fields[4].is_empty() {
                    object_id
                } else {
                    fields[4]
                }
                .to_string(),
                kind: GitReferenceKind::Tag,
                remote_name: None,
                current: false,
            }
        } else {
            continue;
        };
        references.push(reference);
    }
    Ok(references)
}

#[cfg(test)]
#[path = "graph_tests.rs"]
mod tests;
