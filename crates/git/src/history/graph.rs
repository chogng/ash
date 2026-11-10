use std::ffi::OsString;
use std::num::NonZeroUsize;

use crate::GitClient;
use crate::GitCommitSummary;
use crate::GitError;
use crate::GitRemote;
use crate::GitRepository;
use crate::GitResult;
use crate::client::GitQueryStream;

pub(crate) const CATALOG_TAG_LIMIT: usize = 5000;

/// The ref kinds that can be shown in a repository graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitReferenceKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

/// Display metadata for the commit targeted by a branch or tag.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReferenceCommit {
    pub author_name: String,
    pub timestamp_seconds: i64,
    pub subject: String,
}

/// One branch or tag ref associated with a repository graph object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReference {
    name: String,
    object_id: String,
    kind: GitReferenceKind,
    remote_name: Option<String>,
    current: bool,
    commit_details: Option<GitReferenceCommit>,
}

#[derive(Clone, Copy)]
pub(crate) enum ReferenceQuery {
    Graph,
    WithCatalog,
}

#[derive(Default)]
pub(crate) struct ReferenceSnapshot {
    pub(crate) references: Vec<GitReference>,
    pub(crate) tags: Vec<(String, String)>,
    pub(crate) upstream_remote: Option<String>,
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

    pub fn commit_details(&self) -> Option<&GitReferenceCommit> {
        self.commit_details.as_ref()
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
        if self.stream.is_none() {
            self.done = true;
            return Ok(None);
        }
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
        super::summary::parse_commit_fields([&object_id, &parents, &timestamp, &subject], command)
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
    /// Compares reachable commits without enumerating either history to the caller.
    pub async fn same_graph_roots(
        &self,
        repository: &GitRepository,
        previous: &[String],
        current: &[String],
    ) -> GitResult<bool> {
        if previous == current {
            return Ok(true);
        }
        // A union is unchanged exactly when every root is reachable from the other union.
        // Compare only changed roots. Limited rev-list walks can misclassify ancestors when
        // commit dates go backwards; merge-base performs an ancestry check instead.
        for (roots, candidates) in [(previous, current), (current, previous)] {
            let known = candidates
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            for root in roots {
                if known.contains(root.as_str()) {
                    continue;
                }
                let mut covered = false;
                for candidate in candidates {
                    let output = self
                        .run_query_unchecked(
                            repository.worktree_root(),
                            [
                                "merge-base",
                                "--is-ancestor",
                                root.as_str(),
                                candidate.as_str(),
                            ],
                        )
                        .await?;
                    if output.status.success() {
                        covered = true;
                        break;
                    }
                    if output.status.code() != Some(1) {
                        output.require_success()?;
                    }
                }
                if !covered {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// Starts one repository graph traversal with refs and remotes captured once.
    pub async fn start_graph(&self, repository: &GitRepository) -> GitResult<GitGraphCursor> {
        self.start_graph_for_refs(repository, None).await
    }

    /// Traverses only the union reachable from the supplied immutable commit IDs.
    /// Omission retains the public repository graph; an empty selection has no commits.
    pub async fn start_graph_for_refs(
        &self,
        repository: &GitRepository,
        revisions: Option<&[String]>,
    ) -> GitResult<GitGraphCursor> {
        if let Some(revisions) = revisions {
            if revisions.len() > 1000 {
                return Err(GitError::InvalidConfiguration {
                    field: "graph revisions",
                    requirement: "must contain at most 1000 roots",
                });
            }
            for revision in revisions {
                crate::objects::validate_object_id(revision, "graph revision")?;
            }
        }
        let references = self.references(repository).await?;
        let remotes = self.remotes(repository).await?;
        if revisions.is_some_and(|revisions| revisions.is_empty()) {
            return Ok(GitGraphCursor {
                stream: None,
                references,
                remotes,
                pending: None,
                done: false,
            });
        }
        // --all includes detached HEAD and accepts unborn repositories. Exclude its refs before
        // adding public namespaces so stash/private snapshots and other worktree HEADs stay out.
        // Git clears --exclude at the next ref selector, so this order is part of the contract.
        let mut arguments = vec![OsString::from("log"), OsString::from("--single-worktree")];
        if let Some(revisions) = revisions {
            arguments.extend(revisions.iter().map(OsString::from));
        } else {
            arguments.extend(
                [
                    "--exclude=refs/*",
                    "--all",
                    "--branches",
                    "--remotes",
                    "--tags",
                ]
                .map(OsString::from),
            );
        }
        arguments.extend(
            ["--topo-order", "-z", "--format=%H%x00%P%x00%ct%x00%s", "--"].map(OsString::from),
        );
        let stream = self
            .start_query_stream(repository.worktree_root(), arguments)
            .await?;
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
        Ok(self
            .read_references(repository, ReferenceQuery::Graph)
            .await?
            .references)
    }

    pub(crate) async fn read_references(
        &self,
        repository: &GitRepository,
        query: ReferenceQuery,
    ) -> GitResult<ReferenceSnapshot> {
        // Starred atoms describe an annotated tag's target. The catalog still uses the
        // unpeeled tag ID to identify the exact ref it was built from.
        let mut format = String::from(
            "--format=%(refname)%00%(objectname)%00%(symref)%00%(HEAD)%00%(*objectname)%00%(objecttype)%00%(authorname)%00%(committerdate:unix)%00%(subject)%00%(*objecttype)%00%(*authorname)%00%(*committerdate:unix)%00%(*subject)",
        );
        if matches!(query, ReferenceQuery::WithCatalog) {
            format.push_str("%00%(upstream:remotename)");
        }
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "for-each-ref",
                    &format,
                    "refs/heads",
                    "refs/remotes",
                    "refs/tags",
                ],
            )
            .await?;
        parse_references(&output.stdout, &output.command, query)
    }
}

fn parse_references(
    bytes: &[u8],
    command: &str,
    query: ReferenceQuery,
) -> GitResult<ReferenceSnapshot> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::invalid_output(command, "ref output was not UTF-8"))?;
    let mut snapshot = ReferenceSnapshot::default();
    let with_catalog = matches!(query, ReferenceQuery::WithCatalog);
    let field_count = if with_catalog { 14 } else { 13 };
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != field_count {
            return Err(GitError::invalid_output(
                command,
                format!(
                    "ref record had {} fields instead of {field_count}",
                    fields.len()
                ),
            ));
        }
        let Some(full_name) = fields[0].strip_prefix("refs/") else {
            continue;
        };
        let ref_path = full_name.split_once('/');
        let (namespace, name) = ref_path.unwrap_or((full_name, ""));
        let object_id = fields[1];
        if with_catalog {
            // Keep the raw tag ID, including symbolic tags and the exact refs/tags ref.
            if namespace == "tags" && snapshot.tags.len() < CATALOG_TAG_LIMIT {
                snapshot.tags.push((name.to_owned(), object_id.to_owned()));
            }
            if namespace == "heads" && fields[3] == "*" && !fields[13].is_empty() {
                snapshot.upstream_remote = Some(fields[13].to_owned());
            }
        }
        if !fields[2].is_empty() {
            continue;
        }
        if object_id.is_empty() {
            return Err(GitError::invalid_output(
                command,
                "ref record omitted object id",
            ));
        }
        let metadata = if fields[5] == "commit" {
            &fields[6..9]
        } else if fields[9] == "commit" {
            &fields[10..13]
        } else {
            &[][..]
        };
        let commit_details = if metadata.is_empty() {
            None
        } else {
            Some(GitReferenceCommit {
                author_name: metadata[0].to_string(),
                timestamp_seconds: metadata[1].parse().map_err(|_| {
                    GitError::invalid_output(command, "ref commit timestamp was not an integer")
                })?,
                subject: metadata[2].to_string(),
            })
        };
        if ref_path.is_none() {
            continue;
        }
        let (kind, remote_name) = match namespace {
            "heads" if name.is_empty() => {
                return Err(GitError::invalid_output(command, "local ref omitted name"));
            }
            "heads" => (GitReferenceKind::LocalBranch, None),
            "remotes" => {
                let (remote, _) = name
                    .split_once('/')
                    .filter(|(remote, branch)| !remote.is_empty() && !branch.is_empty())
                    .ok_or_else(|| {
                        GitError::invalid_output(
                            command,
                            "remote ref omitted remote or branch name",
                        )
                    })?;
                (GitReferenceKind::RemoteBranch, Some(remote.to_owned()))
            }
            "tags" => (GitReferenceKind::Tag, None),
            _ => continue,
        };
        let object_id = if kind == GitReferenceKind::Tag && !fields[4].is_empty() {
            fields[4]
        } else {
            object_id
        };
        snapshot.references.push(GitReference {
            name: name.to_owned(),
            object_id: object_id.to_owned(),
            kind,
            remote_name,
            current: kind == GitReferenceKind::LocalBranch && fields[3] == "*",
            commit_details,
        });
    }
    Ok(snapshot)
}

#[cfg(test)]
#[path = "graph_tests.rs"]
mod tests;
