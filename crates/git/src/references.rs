use crate::GitClient;
use crate::GitCommitRequest;
use crate::GitRepository;
use crate::GitResult;
use crate::client::validate_argument;
use crate::error::invalid_command as invalid;

/// Git-owned integration state survives renderer and server restarts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitIntegration {
    Merge,
    Rebase,
    CherryPick,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitCommandOutcome {
    Completed,
    Conflicted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitStashMode {
    Tracked,
    IncludeUntracked,
}

/// Reviewed repository intents, never arbitrary Git arguments.
#[derive(Clone, Debug)]
pub enum GitCommand {
    CreateBranchAt {
        name: String,
        object_id: String,
    },
    FetchAndCheckout {
        remote: String,
        remote_identity: String,
        reference: String,
        object_id: String,
        name: String,
    },
    PushBranch {
        remote: String,
        remote_identity: String,
        name: String,
        branch: String,
        expected_head: String,
    },
    CheckoutDetached {
        object_id: String,
    },
    CheckoutRemoteBranch {
        name: String,
        reference: String,
    },
    RenameBranch {
        name: String,
        new_name: String,
    },
    DeleteRemoteBranch {
        remote: String,
        name: String,
    },
    Merge {
        reference: String,
    },
    Rebase {
        reference: String,
    },
    CherryPick {
        reference: String,
        mainline: Option<u32>,
    },
    Continue {
        operation: GitIntegration,
    },
    Abort {
        operation: GitIntegration,
    },
    Stash {
        message: String,
        mode: GitStashMode,
    },
    ApplyStash {
        object_id: String,
    },
    PopStash {
        object_id: String,
    },
    DropStash {
        object_id: String,
    },
    CreateTag {
        name: String,
        reference: String,
    },
    DeleteTag {
        name: String,
    },
    AddRemote {
        name: String,
        url: String,
    },
    RemoveRemote {
        name: String,
    },
    Amend {
        message: String,
    },
    UndoCommit {
        expected_head: String,
    },
}

/// Displayable ref identities omit remote URLs and credentials.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GitCatalog {
    pub tags: Vec<(String, String)>,
    pub stashes: Vec<(String, String)>,
    pub remotes: Vec<String>,
    pub upstream_remote: Option<String>,
    pub operation: Option<GitIntegration>,
}

/// Ref and remote metadata captured with status, including changes that leave HEAD untouched.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitReferenceState {
    pub references: Vec<crate::GitReference>,
    pub remotes: Vec<crate::GitRemote>,
    pub catalog: GitCatalog,
}

impl GitClient {
    pub async fn reference_state(
        &self,
        repository: &GitRepository,
    ) -> GitResult<GitReferenceState> {
        Ok(GitReferenceState {
            references: self.references(repository).await?,
            remotes: self.remotes(repository).await?,
            catalog: self.catalog(repository).await?,
        })
    }

    pub async fn catalog(&self, repository: &GitRepository) -> GitResult<GitCatalog> {
        let tags = self
            .run_query(
                repository.worktree_root(),
                [
                    "for-each-ref",
                    "--count=5000",
                    "--format=%(refname:strip=2)%00%(objectname)",
                    "refs/tags",
                ],
            )
            .await?
            .require_success()?;
        let tags = std::str::from_utf8(&tags.stdout)
            .map_err(|_| invalid("invalid ref encoding"))?
            .lines()
            .map(|line| {
                let (name, object_id) = line
                    .split_once('\0')
                    .ok_or_else(|| invalid("invalid tag record"))?;
                Ok((name.to_owned(), object_id.to_owned()))
            })
            .collect::<GitResult<Vec<_>>>()?;
        let stashes = self.stashes(repository).await?;
        let remotes = self.remote_names(repository).await?;
        // Remote names can contain slashes; the display upstream ref cannot identify its owner.
        let upstream = self
            .run_query(
                repository.worktree_root(),
                [
                    "for-each-ref",
                    "--format=%(HEAD)%00%(upstream:remotename)",
                    "refs/heads",
                ],
            )
            .await?
            .require_success()?;
        let upstream_remote = std::str::from_utf8(&upstream.stdout)
            .map_err(|_| invalid("invalid upstream encoding"))?
            .lines()
            .try_fold(None, |selected, line| -> GitResult<Option<String>> {
                let (head, remote) = line
                    .split_once('\0')
                    .ok_or_else(|| invalid("invalid upstream record"))?;
                if head == "*" && remotes.iter().any(|name| name == remote) {
                    Ok(Some(remote.to_owned()))
                } else {
                    Ok(selected)
                }
            })?;
        Ok(GitCatalog {
            tags,
            stashes,
            remotes,
            upstream_remote,
            operation: self.integration_state(repository),
        })
    }

    pub fn integration_state(&self, repository: &GitRepository) -> Option<GitIntegration> {
        let metadata = repository.git_dir();
        if metadata.join("rebase-merge").is_dir() || metadata.join("rebase-apply").is_dir() {
            Some(GitIntegration::Rebase)
        } else if metadata.join("CHERRY_PICK_HEAD").is_file() || metadata.join("sequencer").is_dir()
        {
            Some(GitIntegration::CherryPick)
        } else if metadata.join("MERGE_HEAD").is_file() {
            Some(GitIntegration::Merge)
        } else {
            None
        }
    }

    /// A conflict is a durable, inspectable Git state rather than a lost command failure.
    pub async fn execute_command(
        &self,
        repository: &GitRepository,
        command: &GitCommand,
    ) -> GitResult<GitCommandOutcome> {
        let root = repository.worktree_root();
        let current = self.integration_state(repository);
        if current.is_some()
            && !matches!(
                command,
                GitCommand::Continue { .. } | GitCommand::Abort { .. }
            )
        {
            return Err(invalid("finish or abort the current integration first"));
        }
        let outcome = match command {
            GitCommand::CreateBranchAt { name, object_id } => {
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                let commit = self.resolve_commit(repository, object_id).await?;
                self.run_mutation(root, ["branch", "--", name, &commit])
                    .await
            }
            GitCommand::FetchAndCheckout {
                remote,
                remote_identity,
                reference,
                object_id,
                name,
            } => {
                self.require_remote_identity(repository, remote, remote_identity)
                    .await?;
                self.validate_ref(repository, reference).await?;
                if !reference.starts_with("refs/") || !valid_commit_identity(object_id) {
                    return Err(invalid(
                        "expected a complete remote ref and commit identity",
                    ));
                }
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                let status = self
                    .run_query(
                        root,
                        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                    )
                    .await?
                    .require_success()?;
                if !status.stdout.is_empty() {
                    return Err(invalid(
                        "save and commit or stash local changes before checkout",
                    ));
                }
                self.run_mutation(root, ["fetch", "--no-tags", "--", remote, reference])
                    .await?
                    .require_success()?;
                let commit = self.resolve_commit(repository, "FETCH_HEAD").await?;
                if commit != *object_id {
                    return Err(invalid("remote commit changed since review"));
                }
                self.run_mutation(root, ["switch", "--no-track", "-c", name, "--", &commit])
                    .await
            }
            GitCommand::PushBranch {
                remote,
                remote_identity,
                name,
                branch,
                expected_head,
            } => {
                self.require_remote_identity(repository, remote, remote_identity)
                    .await?;
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                if !valid_commit_identity(expected_head) {
                    return Err(invalid("expected a complete commit identity"));
                }
                let head = self.resolve_commit(repository, "HEAD").await?;
                if head != *expected_head {
                    return Err(invalid("local HEAD changed before push"));
                }
                let current_branch = self
                    .run_query(root, ["symbolic-ref", "--quiet", "HEAD"])
                    .await?
                    .require_success()?;
                if String::from_utf8_lossy(&current_branch.stdout).trim()
                    != format!("refs/heads/{branch}")
                {
                    return Err(invalid("local branch changed before push"));
                }
                let target = format!("{head}:refs/heads/{name}");
                self.run_mutation(root, ["push", "--", remote, &target])
                    .await
            }
            GitCommand::CheckoutDetached { object_id } => {
                let commit = self.resolve_commit(repository, object_id).await?;
                self.run_mutation(root, ["switch", "--detach", "--", &commit])
                    .await
            }
            GitCommand::CheckoutRemoteBranch { name, reference } => {
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                let remote_ref = format!("refs/remotes/{reference}");
                self.validate_ref(repository, &remote_ref).await?;
                self.resolve_commit(repository, &remote_ref).await?;
                self.run_mutation(root, ["switch", "--track", "-c", name, "--", &remote_ref])
                    .await
            }
            GitCommand::RenameBranch { name, new_name } => {
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                self.validate_ref(repository, &format!("refs/heads/{new_name}"))
                    .await?;
                self.run_mutation(root, ["branch", "-m", "--", name, new_name])
                    .await
            }
            GitCommand::DeleteRemoteBranch { remote, name } => {
                self.delete_remote_branch(repository, remote, name).await
            }
            GitCommand::Merge { reference } => {
                self.start_integration(repository, "merge", reference, None)
                    .await
            }
            GitCommand::Rebase { reference } => {
                self.start_integration(repository, "rebase", reference, None)
                    .await
            }
            GitCommand::CherryPick {
                reference,
                mainline,
            } => {
                self.start_integration(repository, "cherry-pick", reference, *mainline)
                    .await
            }
            GitCommand::Continue { operation } | GitCommand::Abort { operation } => {
                if current != Some(*operation) {
                    return Err(invalid("integration state changed"));
                }
                let action = if matches!(command, GitCommand::Continue { .. }) {
                    "--continue"
                } else {
                    "--abort"
                };
                let name = match operation {
                    GitIntegration::Merge => "merge",
                    GitIntegration::Rebase => "rebase",
                    GitIntegration::CherryPick => "cherry-pick",
                };
                // Continuing commits must never launch a terminal editor inside the app-server.
                self.run_mutation_with_stdin_and_environment(
                    root,
                    [name, action],
                    Vec::new(),
                    [("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")],
                )
                .await
            }
            GitCommand::Stash { message, mode } => {
                let message = GitCommitRequest::new(message.clone())?;
                let mut arguments = vec!["stash", "push", "--message", message.message()];
                if *mode == GitStashMode::IncludeUntracked {
                    arguments.push("--include-untracked");
                }
                self.run_mutation(root, arguments).await
            }
            GitCommand::ApplyStash { object_id } => {
                self.mutate_stash(repository, "apply", object_id).await
            }
            GitCommand::PopStash { object_id } => {
                self.mutate_stash(repository, "pop", object_id).await
            }
            GitCommand::DropStash { object_id } => {
                self.mutate_stash(repository, "drop", object_id).await
            }
            GitCommand::CreateTag { name, reference } => {
                self.validate_ref(repository, &format!("refs/tags/{name}"))
                    .await?;
                let commit = self.resolve_commit(repository, reference).await?;
                self.run_mutation(root, ["tag", "--", name, &commit]).await
            }
            GitCommand::DeleteTag { name } => {
                self.validate_ref(repository, &format!("refs/tags/{name}"))
                    .await?;
                self.run_mutation(root, ["tag", "-d", "--", name]).await
            }
            GitCommand::AddRemote { name, url } => self.add_remote(repository, name, url).await,
            GitCommand::RemoveRemote { name } => self.remove_remote(repository, name).await,
            GitCommand::Amend { message } => self.amend_commit(repository, message).await,
            GitCommand::UndoCommit { expected_head } => {
                let head = self.resolve_commit(repository, "HEAD").await?;
                if head != *expected_head {
                    return Err(invalid("HEAD changed after confirmation"));
                }
                let parent = self.resolve_commit(repository, "HEAD^1").await?;
                // Compare-and-swap HEAD: another Git client must not lose a newer commit.
                self.run_mutation(
                    root,
                    [
                        "update-ref",
                        "-m",
                        "ash: undo commit",
                        "HEAD",
                        &parent,
                        expected_head,
                    ],
                )
                .await
            }
        }?;
        if outcome.status.success() {
            return Ok(GitCommandOutcome::Completed);
        }
        if matches!(
            command,
            GitCommand::Merge { .. }
                | GitCommand::Rebase { .. }
                | GitCommand::CherryPick { .. }
                | GitCommand::Continue { .. }
                | GitCommand::ApplyStash { .. }
                | GitCommand::PopStash { .. }
        ) && self
            .snapshot(repository)
            .await?
            .changes()
            .iter()
            .any(|change| change.is_conflicted())
        {
            return Ok(GitCommandOutcome::Conflicted);
        }
        outcome.require_success()?;
        Ok(GitCommandOutcome::Completed)
    }

    async fn start_integration(
        &self,
        repository: &GitRepository,
        operation: &str,
        reference: &str,
        mainline: Option<u32>,
    ) -> GitResult<crate::client::GitCommandOutput> {
        if !self.snapshot(repository).await?.changes().is_empty() {
            return Err(invalid(
                "integration requires a clean index and working tree",
            ));
        }
        let commit = self.resolve_commit(repository, reference).await?;
        let mut arguments = vec![operation];
        if operation == "merge" {
            arguments.push("--no-edit");
        }
        let mainline_number;
        if let Some(parent) = mainline {
            if parent == 0 {
                return Err(invalid("mainline parent must be positive"));
            }
            mainline_number = parent.to_string();
            arguments.extend(["--mainline", &mainline_number]);
        }
        arguments.extend(["--", &commit]);
        self.run_mutation(repository.worktree_root(), arguments)
            .await
    }

    async fn mutate_stash(
        &self,
        repository: &GitRepository,
        action: &str,
        object_id: &str,
    ) -> GitResult<crate::client::GitCommandOutput> {
        let stashes = self.stashes(repository).await?;
        let index = stashes
            .iter()
            .position(|(id, _)| id == object_id)
            .ok_or_else(|| invalid("stash no longer exists"))?;
        self.run_mutation(
            repository.worktree_root(),
            ["stash", action, "--", &format!("stash@{{{index}}}")],
        )
        .await
    }

    pub(crate) async fn validate_ref(
        &self,
        repository: &GitRepository,
        reference: &str,
    ) -> GitResult<()> {
        validate_argument(reference)?;
        self.run_query(repository.worktree_root(), ["check-ref-format", reference])
            .await?
            .require_success()?;
        Ok(())
    }

    async fn stashes(&self, repository: &GitRepository) -> GitResult<Vec<(String, String)>> {
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    "stash",
                    "list",
                    "-z",
                    "--max-count=5000",
                    "--format=%H%x00%gs",
                ],
            )
            .await?
            .require_success()?;
        let text =
            std::str::from_utf8(&output.stdout).map_err(|_| invalid("invalid stash encoding"))?;
        let fields = text.split_terminator('\0').collect::<Vec<_>>();
        if fields.len() % 2 != 0 {
            return Err(invalid("invalid stash record"));
        }
        Ok(fields
            .chunks_exact(2)
            .map(|pair| (pair[0].to_owned(), pair[1].to_owned()))
            .collect())
    }
}

#[cfg(test)]
#[path = "references_tests.rs"]
mod tests;

mod branch;

pub use metadata::GitBranch;
mod metadata;

fn valid_commit_identity(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
