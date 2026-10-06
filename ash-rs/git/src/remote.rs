//! Remote identity, configuration and transport; authentication policy belongs to the caller.
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::client::validate_argument;
use crate::error::invalid_command as invalid;
use std::ffi::OsString;
/// Fetch and push URLs configured for one named remote.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRemote {
    name: String,
    fetch_urls: Vec<String>,
    push_urls: Vec<String>,
}

impl GitRemote {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn fetch_urls(&self) -> &[String] {
        &self.fetch_urls
    }

    pub fn push_urls(&self) -> &[String] {
        &self.push_urls
    }

    /// Returns the provider-neutral repository identity parsed from the configured URLs.
    ///
    /// The identity intentionally excludes credentials and the original URL. Callers that need
    /// to display or associate a remote should use this projection rather than forwarding raw
    /// Git configuration values across a process boundary.
    /// Whether every fetch and push URL identifies the same repository.
    pub fn has_single_identity(&self) -> bool {
        let Some(identity) = self.identity() else {
            return false;
        };
        self.fetch_urls
            .iter()
            .chain(self.push_urls.iter())
            .all(|url| parse_remote_identity(url).as_ref() == Some(&identity))
    }

    pub fn identity(&self) -> Option<GitRemoteIdentity> {
        self.fetch_urls
            .iter()
            .chain(self.push_urls.iter())
            .find_map(|url| parse_remote_identity(url))
    }
}

/// Provider-neutral repository identity derived from one Git remote URL.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRemoteIdentity {
    host: String,
    owner: String,
    repository: String,
}

impl GitRemoteIdentity {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    pub fn repository(&self) -> &str {
        &self.repository
    }

    pub fn provider(&self) -> GitRemoteProvider {
        match self.host.as_str() {
            "github.com" => GitRemoteProvider::Github,
            "gitlab.com" => GitRemoteProvider::Gitlab,
            "bitbucket.org" => GitRemoteProvider::Bitbucket,
            _ => GitRemoteProvider::Other,
        }
    }
}

/// Well-known provider classification for a Git remote identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitRemoteProvider {
    Github,
    Gitlab,
    Bitbucket,
    Other,
}

impl GitClient {
    pub async fn remotes(&self, repository: &GitRepository) -> GitResult<Vec<GitRemote>> {
        let output = self
            .run_query(repository.worktree_root(), ["remote"])
            .await?;
        let remote_names = parse_lines(&output.stdout, &output.command, "remote name")?;
        let mut remotes = Vec::with_capacity(remote_names.len());
        for name in remote_names {
            let fetch_urls = self
                .remote_urls(repository, &name, RemoteUrlKind::Fetch)
                .await?;
            let push_urls = self
                .remote_urls(repository, &name, RemoteUrlKind::Push)
                .await?;
            remotes.push(GitRemote {
                name,
                fetch_urls,
                push_urls,
            });
        }
        Ok(remotes)
    }

    async fn remote_urls(
        &self,
        repository: &GitRepository,
        remote: &str,
        kind: RemoteUrlKind,
    ) -> GitResult<Vec<String>> {
        let mut args = vec![OsString::from("remote"), OsString::from("get-url")];
        if kind == RemoteUrlKind::Push {
            args.push(OsString::from("--push"));
        }
        args.extend([
            OsString::from("--all"),
            OsString::from("--"),
            OsString::from(remote),
        ]);
        let output = self.run_query(repository.worktree_root(), args).await?;
        parse_lines(&output.stdout, &output.command, "remote URL")
    }
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum RemoteUrlKind {
    Fetch,
    Push,
}

fn parse_lines(bytes: &[u8], command: &str, label: &str) -> GitResult<Vec<String>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| GitError::invalid_output(command, format!("{label} output was not UTF-8")))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn parse_remote_identity(url: &str) -> Option<GitRemoteIdentity> {
    let value = url.trim().trim_end_matches('/');
    let (host, path) = if let Some((_, authority_and_path)) = value.split_once("://") {
        let (authority, path) = authority_and_path
            .split_once('/')
            .unwrap_or((authority_and_path, ""));
        (remote_host(authority), path)
    } else if let Some((authority, path)) = value.split_once(':') {
        if authority.contains('/') {
            return None;
        }
        (remote_host(authority), path)
    } else {
        return None;
    };
    let host = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    let path = path.split_once('#').map_or(path, |(path, _)| path);
    let mut segments = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return None;
    }
    let mut repository = segments.pop()?;
    if let Some(stripped) = repository.strip_suffix(".git") {
        repository = stripped.to_string();
    }
    let owner = segments.join("/");
    if owner.is_empty() || repository.is_empty() {
        return None;
    }
    Some(GitRemoteIdentity {
        host,
        owner,
        repository,
    })
}

fn remote_host(authority: &str) -> &str {
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .trim();
    if let Some(host) = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
    {
        return host.0;
    }
    authority
        .rsplit_once(':')
        .filter(|(_, port)| {
            !port.is_empty() && port.chars().all(|character| character.is_ascii_digit())
        })
        .map_or(authority, |(host, _)| host)
}

impl GitClient {
    /// Fetches the current branch's default remote without interactive credential prompts.
    pub async fn fetch_default(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["fetch", "--prune"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Fetches and prunes every configured remote without interactive credential prompts.
    pub async fn fetch(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["fetch", "--all", "--prune"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Pulls the configured upstream only when it can fast-forward.
    pub async fn pull_fast_forward(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["pull", "--ff-only"])
            .await?
            .require_success()?;
        Ok(())
    }

    /// Pushes the current branch to its configured upstream.
    pub async fn push(&self, repository: &GitRepository) -> GitResult<()> {
        self.run_mutation(repository.worktree_root(), ["push"])
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
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;

impl GitClient {
    pub(crate) async fn remote_names(&self, repository: &GitRepository) -> GitResult<Vec<String>> {
        let output = self
            .run_query(repository.worktree_root(), ["remote"])
            .await?;
        Ok(std::str::from_utf8(&output.stdout)
            .map_err(|_| invalid("invalid remote encoding"))?
            .lines()
            .map(str::to_owned)
            .collect())
    }
    pub(crate) async fn delete_remote_branch(
        &self,
        repository: &GitRepository,
        remote: &str,
        name: &str,
    ) -> GitResult<crate::client::GitCommandOutput> {
        self.require_remote(repository, remote).await?;
        let reference = format!("refs/heads/{name}");
        self.validate_ref(repository, &reference).await?;
        self.run_mutation(
            repository.worktree_root(),
            ["push", "--", remote, &format!(":{reference}")],
        )
        .await
    }
    pub(crate) async fn add_remote(
        &self,
        repository: &GitRepository,
        name: &str,
        url: &str,
    ) -> GitResult<crate::client::GitCommandOutput> {
        self.validate_ref(repository, &format!("refs/remotes/{name}/HEAD"))
            .await?;
        validate_argument(url)?;
        self.run_mutation(
            repository.worktree_root(),
            ["remote", "add", "--", name, url],
        )
        .await
    }
    pub(crate) async fn remove_remote(
        &self,
        repository: &GitRepository,
        name: &str,
    ) -> GitResult<crate::client::GitCommandOutput> {
        self.require_remote(repository, name).await?;
        self.run_mutation(repository.worktree_root(), ["remote", "remove", "--", name])
            .await
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
}
