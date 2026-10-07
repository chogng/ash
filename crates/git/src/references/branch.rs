use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;

impl GitClient {
    /// Creates a local branch at HEAD without changing or adding a checkout.
    pub async fn create_branch(&self, repository: &GitRepository, name: &str) -> GitResult<()> {
        self.run_query(
            repository.worktree_root(),
            ["check-ref-format", "--branch", name],
        )
        .await?
        .require_success()?;
        self.run_mutation(repository.worktree_root(), ["branch", "--", name, "HEAD"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Deletes a local branch only when Git considers it merged and no worktree has it checked out.
    pub async fn delete_merged_branch(
        &self,
        repository: &GitRepository,
        name: &str,
    ) -> GitResult<()> {
        self.run_query(
            repository.worktree_root(),
            ["check-ref-format", "--branch", name],
        )
        .await?
        .require_success()?;
        self.run_mutation(repository.worktree_root(), ["branch", "-d", "--", name])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Resolves a commit without accepting option-like revision arguments.
    pub async fn resolve_commit(
        &self,
        repository: &GitRepository,
        revision: &str,
    ) -> GitResult<String> {
        let revision = format!("{revision}^{{commit}}");
        let output = self
            .run_query(
                repository.worktree_root(),
                ["rev-parse", "--verify", "--end-of-options", &revision],
            )
            .await?;
        let object_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !(40..=64).contains(&object_id.len())
            || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::invalid_output(
                output.command,
                "invalid commit identity",
            ));
        }
        Ok(object_id)
    }

    /// Creates an unoccupied branch at a fixed commit; an existing identical branch is a retry.
    pub async fn create_branch_at(
        &self,
        repository: &GitRepository,
        name: &str,
        object_id: &str,
    ) -> GitResult<()> {
        let reference = format!("refs/heads/{name}");
        self.run_query(repository.worktree_root(), ["check-ref-format", &reference])
            .await?
            .require_success()?;
        let commit = self.resolve_commit(repository, object_id).await?;
        let branches = self.local_branches(repository).await?;
        if let Some(branch) = branches.iter().find(|branch| branch.name() == name) {
            if branch.object_id() == commit {
                return Ok(());
            }
            return Err(GitError::invalid_output(
                "create branch",
                "branch already exists at another commit",
            ));
        }
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", &reference, &commit, &"0".repeat(commit.len())],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Removes a branch created during a failed worktree operation only at its original commit.
    pub async fn delete_branch_at(
        &self,
        repository: &GitRepository,
        name: &str,
        object_id: &str,
    ) -> GitResult<()> {
        let reference = format!("refs/heads/{name}");
        self.run_query(repository.worktree_root(), ["check-ref-format", &reference])
            .await?
            .require_success()?;
        let commit = self.resolve_commit(repository, object_id).await?;
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", "-d", &reference, &commit],
        )
        .await?
        .require_success()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "branch_tests.rs"]
mod tests;

use crate::GitBranch;
use crate::objects::validate_object_id;
use std::ffi::OsString;

impl GitClient {
    pub async fn validate_branch_name(
        &self,
        repository: &GitRepository,
        branch: &str,
    ) -> GitResult<()> {
        self.run_query(
            repository.worktree_root(),
            ["check-ref-format", "--branch", branch],
        )
        .await?;
        Ok(())
    }
    pub async fn read_optional_ref(
        &self,
        repository: &GitRepository,
        reference: &str,
    ) -> GitResult<Option<String>> {
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    reference,
                ],
            )
            .await?;
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        let output = output.require_success()?;
        let value = String::from_utf8(output.stdout)
            .map_err(|_| GitError::invalid_output(&output.command, "ref object ID was not UTF-8"))?
            .trim()
            .to_string();
        validate_object_id(&value, "ref object ID")?;
        Ok(Some(value))
    }
    pub async fn update_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        new_value: &str,
        old_value: &str,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference, new_value, old_value],
        )
        .await?
        .require_success()?;
        Ok(())
    }
    pub async fn update_optional_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        new_value: &str,
        old_value: Option<&str>,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", reference, new_value, old_value.unwrap_or("")],
        )
        .await?
        .require_success()?;
        Ok(())
    }
    pub async fn delete_ref_cas(
        &self,
        repository: &GitRepository,
        reference: &str,
        old_value: &str,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            ["update-ref", "-d", reference, old_value],
        )
        .await?
        .require_success()?;
        Ok(())
    }
    /// Switches the working tree to one local branch returned by [`GitClient::local_branches`].
    ///
    /// Git remains authoritative for dirty-worktree and linked-worktree conflicts. A rejected
    /// switch is returned as [`GitError::CommandFailed`] without retrying or discarding changes.
    pub async fn switch_branch(
        &self,
        repository: &GitRepository,
        branch: &GitBranch,
    ) -> GitResult<()> {
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("switch"),
                OsString::from("--"),
                OsString::from(branch.name()),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }
}
