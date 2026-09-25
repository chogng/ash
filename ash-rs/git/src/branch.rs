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

    /// Pushes exactly the reviewed commit to a task branch, without force or checkout changes.
    pub async fn push_branch_commit(
        &self,
        repository: &GitRepository,
        name: &str,
        object_id: &str,
    ) -> GitResult<()> {
        let reference = format!("refs/heads/{name}");
        self.run_query(repository.worktree_root(), ["check-ref-format", &reference])
            .await?;
        let commit = self.resolve_commit(repository, object_id).await?;
        self.run_mutation(
            repository.worktree_root(),
            ["push", "origin", &format!("{commit}:{reference}")],
        )
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

    /// Fetches origin/main into its tracking ref without touching the current checkout.
    pub async fn fetch_main(&self, repository: &GitRepository) -> GitResult<String> {
        self.fetch_branch(repository, "main").await
    }

    /// Fetches an explicitly selected origin branch without changing the working directory.
    pub async fn fetch_branch(&self, repository: &GitRepository, name: &str) -> GitResult<String> {
        let source = format!("refs/heads/{name}");
        self.run_query(repository.worktree_root(), ["check-ref-format", &source])
            .await?
            .require_success()?;
        let target = format!("refs/remotes/origin/{name}");
        self.run_mutation(
            repository.worktree_root(),
            [
                "fetch",
                "--no-tags",
                "origin",
                &format!("+{source}:{target}"),
            ],
        )
        .await?
        .require_success()?;
        self.resolve_commit(repository, &target).await
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
