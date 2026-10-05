//! Immutable object transfer; importing never changes the recipient's checkout or index.
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::GitTreeId;

/// An explicitly negotiated prerequisite already present at both ends of a transfer.
pub enum GitPackBase<'a> {
    Complete,
    ExistingCommit(&'a str),
}

impl GitClient {
    pub async fn contains_commit(&self, repository: &GitRepository, id: &str) -> GitResult<bool> {
        GitTreeId::new(id.to_owned())?;
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{id}^{{commit}}"),
                ],
            )
            .await?;
        if output.status.code() == Some(1) {
            return Ok(false);
        }
        output.require_success()?;
        Ok(true)
    }

    /// Includes the exact HEAD and captured disk tree, including binary and untracked files.
    /// Submodule content has a separate object database and cannot be represented by this pack.
    pub async fn export_task_pack(
        &self,
        repository: &GitRepository,
        head: &str,
        tree: &GitTreeId,
        base: GitPackBase<'_>,
    ) -> GitResult<Vec<u8>> {
        GitTreeId::new(head.to_owned())?;
        self.validate_task_tree(repository, tree).await?;
        let mut revisions = format!("{head}\n{}\n", tree.as_str());
        if let GitPackBase::ExistingCommit(id) = base {
            GitTreeId::new(id.to_owned())?;
            revisions.push_str(&format!("^{id}\n"));
        }
        let output = self
            .run_mutation_with_stdin(
                repository.worktree_root(),
                ["pack-objects", "--stdout", "--revs"],
                revisions.into_bytes(),
            )
            .await?
            .require_success()?;
        Ok(output.stdout)
    }

    async fn validate_task_tree(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
    ) -> GitResult<()> {
        let kind = self
            .run_query(
                repository.worktree_root(),
                ["cat-file", "-t", tree.as_str()],
            )
            .await?
            .require_success()?;
        if kind.stdout != b"tree\n" {
            return Err(GitError::InvalidConfiguration {
                field: "task tree",
                requirement: "must identify a tree object",
            });
        }
        let entries = self
            .run_query(repository.worktree_root(), ["ls-tree", "-r", tree.as_str()])
            .await?
            .require_success()?;
        if entries
            .stdout
            .split(|b| *b == b'\n')
            .any(|entry| entry.starts_with(b"160000 "))
        {
            return Err(GitError::InvalidConfiguration {
                field: "task snapshot",
                requirement: "cannot contain submodules or embedded repositories",
            });
        }
        Ok(())
    }

    /// Checks pack integrity and connectivity before the host provisions a disposable worktree.
    pub async fn import_task_pack(
        &self,
        repository: &GitRepository,
        head: &str,
        tree: &GitTreeId,
        pack: Vec<u8>,
    ) -> GitResult<()> {
        GitTreeId::new(head.to_owned())?;
        if pack.len() > self.limits().max_output_bytes() {
            return Err(GitError::InvalidConfiguration {
                field: "task pack",
                requirement: "exceeds the configured object transfer limit",
            });
        }
        self.run_mutation_with_stdin(
            repository.worktree_root(),
            ["index-pack", "--stdin", "--strict"],
            pack,
        )
        .await?
        .require_success()?;
        if self.resolve_commit(repository, head).await? != head {
            return Err(GitError::InvalidConfiguration {
                field: "task HEAD",
                requirement: "must identify a commit object",
            });
        }
        self.validate_task_tree(repository, tree).await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
