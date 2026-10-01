use crate::GitClient;
use crate::GitCommitRequest;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;

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
    RenameBranch { name: String, new_name: String },
    DeleteRemoteBranch { remote: String, name: String },
    Merge { reference: String },
    Rebase { reference: String },
    CherryPick { reference: String },
    Continue { operation: GitIntegration },
    Abort { operation: GitIntegration },
    Stash { message: String, mode: GitStashMode },
    ApplyStash { object_id: String },
    PopStash { object_id: String },
    DropStash { object_id: String },
    CreateTag { name: String, reference: String },
    DeleteTag { name: String },
    AddRemote { name: String, url: String },
    RemoveRemote { name: String },
    Amend { message: String },
    UndoCommit { expected_head: String },
}

/// Displayable ref identities omit remote URLs and credentials.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GitCatalog {
    pub tags: Vec<(String, String)>,
    pub stashes: Vec<(String, String)>,
    pub remotes: Vec<String>,
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

    pub async fn initialize_repository(
        &self,
        path: &std::path::Path,
        branch: &str,
    ) -> GitResult<()> {
        validate_argument(branch)?;
        // Initializing inside an existing checkout would create an unintended nested repository.
        if self
            .run_query_unchecked(path, ["rev-parse", "--git-dir"])
            .await?
            .status
            .success()
        {
            return Err(invalid("directory already belongs to a repository"));
        }
        self.run_mutation(path, ["init", "--initial-branch", branch])
            .await?
            .require_success()?;
        Ok(())
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
        let remotes = self
            .run_query(repository.worktree_root(), ["remote"])
            .await?
            .require_success()?;
        let remotes = std::str::from_utf8(&remotes.stdout)
            .map_err(|_| invalid("invalid remote encoding"))?
            .lines()
            .map(str::to_owned)
            .collect();
        Ok(GitCatalog {
            tags,
            stashes,
            remotes,
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
            GitCommand::RenameBranch { name, new_name } => {
                self.validate_ref(repository, &format!("refs/heads/{name}"))
                    .await?;
                self.validate_ref(repository, &format!("refs/heads/{new_name}"))
                    .await?;
                self.run_mutation(root, ["branch", "-m", "--", name, new_name])
                    .await
            }
            GitCommand::DeleteRemoteBranch { remote, name } => {
                self.require_remote(repository, remote).await?;
                let reference = format!("refs/heads/{name}");
                self.validate_ref(repository, &reference).await?;
                self.run_mutation(root, ["push", "--", remote, &format!(":{reference}")])
                    .await
            }
            GitCommand::Merge { reference } => {
                self.start_integration(repository, "merge", reference).await
            }
            GitCommand::Rebase { reference } => {
                self.start_integration(repository, "rebase", reference)
                    .await
            }
            GitCommand::CherryPick { reference } => {
                self.start_integration(repository, "cherry-pick", reference)
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
            GitCommand::AddRemote { name, url } => {
                self.validate_ref(repository, &format!("refs/remotes/{name}/HEAD"))
                    .await?;
                validate_argument(url)?;
                self.run_mutation(root, ["remote", "add", "--", name, url])
                    .await
            }
            GitCommand::RemoveRemote { name } => {
                self.require_remote(repository, name).await?;
                self.run_mutation(root, ["remote", "remove", "--", name])
                    .await
            }
            GitCommand::Amend { message } => {
                let message = GitCommitRequest::new(message.clone())?;
                self.run_mutation_with_stdin(
                    root,
                    ["commit", "--amend", "--file=-"],
                    message.message().as_bytes().to_vec(),
                )
                .await
            }
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

    async fn validate_ref(&self, repository: &GitRepository, reference: &str) -> GitResult<()> {
        validate_argument(reference)?;
        self.run_query(repository.worktree_root(), ["check-ref-format", reference])
            .await?
            .require_success()?;
        Ok(())
    }

    async fn require_remote(&self, repository: &GitRepository, name: &str) -> GitResult<()> {
        validate_argument(name)?;
        let output = self
            .run_query(repository.worktree_root(), ["remote"])
            .await?
            .require_success()?;
        if !String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|remote| remote == name)
        {
            return Err(invalid("remote no longer exists"));
        }
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

fn validate_argument(value: &str) -> GitResult<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(invalid("invalid reference, name or location"));
    }
    Ok(())
}

fn invalid(reason: &'static str) -> GitError {
    GitError::InvalidConfiguration {
        field: "Git command",
        requirement: reason,
    }
}

#[cfg(test)]
#[path = "operations_tests.rs"]
mod tests;
