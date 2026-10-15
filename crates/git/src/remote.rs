//! Remote identity, configuration and transport; authentication policy belongs to the caller.
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitResult;
use crate::client::validate_argument;
use crate::error::invalid_command as invalid;
use std::ffi::OsString;

/// Integration selection for a pull; Git configuration remains authoritative in configured mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPullMode {
    Configured,
    Rebase,
}

/// Per-invocation transport policy. Hosts do not rewrite repository configuration.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GitPushMode {
    #[default]
    Normal,
    Force,
    Lease,
    LeaseIfIncludes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitTagPolicy {
    Configured,
    Include,
    Exclude,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GitTransportOptions {
    pub prune: bool,
    pub tag_policy: GitTagPolicy,
    pub replace_tags: bool,
    pub auto_stash: bool,
    pub follow_tags: bool,
    pub push_mode: GitPushMode,
}

impl Default for GitTransportOptions {
    fn default() -> Self {
        Self {
            prune: true,
            tag_policy: GitTagPolicy::Configured,
            replace_tags: false,
            auto_stash: false,
            follow_tags: false,
            push_mode: GitPushMode::Normal,
        }
    }
}

/// The immutable local commit and tracking branch reviewed by an interactive push.
#[derive(Clone, Debug)]
pub struct GitPushTarget {
    pub branch: String,
    pub object_id: String,
    pub upstream: String,
}

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
    // Validate every transport URL immediately before effects. A push URL may differ from fetch.
    pub(crate) async fn require_remote_identity(
        &self,
        repository: &GitRepository,
        name: &str,
        expected: &str,
    ) -> GitResult<()> {
        validate_argument(name)?;
        let remote = self
            .remotes(repository)
            .await?
            .into_iter()
            .find(|remote| remote.name() == name)
            .ok_or_else(|| invalid("remote no longer exists"))?;
        let identity = remote
            .identity()
            .ok_or_else(|| invalid("remote has no repository identity"))?;
        let actual = format!(
            "{}/{}/{}",
            identity.host(),
            identity.owner(),
            identity.repository()
        );
        if !remote.has_single_identity() || !actual.eq_ignore_ascii_case(expected) {
            return Err(invalid("remote repository changed"));
        }
        Ok(())
    }

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
        self.fetch_with_options(repository, None, false, GitTransportOptions::default())
            .await
    }

    /// Fetches and prunes every configured remote without interactive credential prompts.
    pub async fn fetch(&self, repository: &GitRepository) -> GitResult<()> {
        self.fetch_with_options(repository, None, true, GitTransportOptions::default())
            .await
    }

    /// Fetches one still-configured remote without changing the current checkout.
    pub async fn fetch_remote(&self, repository: &GitRepository, name: &str) -> GitResult<()> {
        self.fetch_with_options(
            repository,
            Some(name),
            false,
            GitTransportOptions::default(),
        )
        .await
    }

    /// Pulls the configured upstream, honoring Git settings unless rebase is explicit.
    pub async fn pull(&self, repository: &GitRepository, mode: GitPullMode) -> GitResult<()> {
        self.pull_with_options(repository, mode, GitTransportOptions::default())
            .await
    }

    pub async fn fetch_with_options(
        &self,
        repository: &GitRepository,
        remote: Option<&str>,
        all: bool,
        options: GitTransportOptions,
    ) -> GitResult<()> {
        if let Some(name) = remote {
            self.require_remote(repository, name).await?;
        }
        let mut arguments = vec![
            "fetch",
            if options.prune {
                "--prune"
            } else {
                "--no-prune"
            },
        ];
        if all {
            arguments.push("--all");
        }
        if let Some(name) = remote {
            arguments.extend(["--", name]);
        }
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        Ok(())
    }

    pub async fn pull_with_options(
        &self,
        repository: &GitRepository,
        mode: GitPullMode,
        options: GitTransportOptions,
    ) -> GitResult<()> {
        let mut arguments = vec!["pull", "--no-edit"];
        match options.tag_policy {
            GitTagPolicy::Configured => {}
            GitTagPolicy::Include => arguments.push("--tags"),
            GitTagPolicy::Exclude => arguments.push("--no-tags"),
        }
        if options.replace_tags {
            arguments.push("--force");
        }
        if options.auto_stash {
            arguments.push("--autostash");
        }
        match mode {
            GitPullMode::Rebase => arguments.push("--rebase"),
            GitPullMode::Configured => {
                // Modern Git requires a divergence policy. Supply the merge default only
                // when neither branch nor repository/global configuration selected rebase.
                if !self.has_pull_rebase_configuration(repository).await? {
                    arguments.push("--no-rebase");
                }
            }
        }
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        Ok(())
    }

    async fn has_pull_rebase_configuration(&self, repository: &GitRepository) -> GitResult<bool> {
        let branch = self
            .run_query_unchecked(
                repository.worktree_root(),
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
            )
            .await?;
        let mut keys = vec!["pull.rebase".to_owned()];
        if branch.status.success() {
            let name = std::str::from_utf8(&branch.stdout)
                .map_err(|_| {
                    GitError::invalid_output(&branch.command, "branch name was not UTF-8")
                })?
                .trim_end();
            keys.push(format!("branch.{name}.rebase"));
        } else if branch.status.code() != Some(1) {
            branch.require_success()?;
        }
        for key in keys {
            let output = self
                .run_configuration_probe(repository.worktree_root(), ["config", "--get", &key])
                .await?;
            if output.status.success() {
                return Ok(true);
            }
            if output.status.code() != Some(1) {
                output.require_success()?;
            }
        }
        Ok(false)
    }

    /// Pushes the current branch to its configured upstream.
    pub async fn push(&self, repository: &GitRepository) -> GitResult<()> {
        self.push_with_options(repository, GitTransportOptions::default())
            .await
    }

    pub async fn push_with_options(
        &self,
        repository: &GitRepository,
        options: GitTransportOptions,
    ) -> GitResult<()> {
        let mut arguments = vec!["push"];
        if options.follow_tags {
            arguments.push("--follow-tags");
        }
        match options.push_mode {
            GitPushMode::Normal => {}
            GitPushMode::Force => arguments.push("--force"),
            GitPushMode::Lease => arguments.push("--force-with-lease"),
            GitPushMode::LeaseIfIncludes => {
                arguments.extend(["--force-with-lease", "--force-if-includes"])
            }
        }
        self.run_mutation(repository.worktree_root(), arguments)
            .await?
            .require_success()?;
        Ok(())
    }
    /// Uses an explicit object/ref pair so a concurrent checkout cannot change what is sent.
    pub async fn push_reviewed(
        &self,
        repository: &GitRepository,
        target: &GitPushTarget,
        options: GitTransportOptions,
    ) -> GitResult<()> {
        let root = repository.worktree_root();
        if !crate::references::valid_commit_identity(&target.object_id) {
            return Err(invalid("expected a complete commit identity"));
        }
        self.validate_ref(repository, &format!("refs/heads/{}", target.branch))
            .await?;
        let output = self
            .run_query(
                root,
                [
                    "for-each-ref",
                    "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)",
                    &format!("refs/heads/{}", target.branch),
                ],
            )
            .await?
            .require_success()?;
        let value = std::str::from_utf8(&output.stdout)
            .map_err(|_| invalid("invalid upstream encoding"))?
            .trim_end_matches('\n');
        let fields: Vec<_> = value.split('\0').collect();
        if fields.len() != 3
            || fields[0].is_empty()
            || !fields[1].starts_with("refs/heads/")
            || fields[2] != target.upstream
        {
            return Err(invalid("tracking branch changed before push"));
        }
        self.require_remote(repository, fields[0]).await?;
        self.validate_ref(repository, fields[1]).await?;
        let status = self.snapshot(repository).await?;
        if !matches!(status.head(), crate::GitHead::Branch {name,object_id,..} if name==&target.branch && object_id==&target.object_id)
        {
            return Err(invalid("local branch changed before push"));
        }
        let mut args = vec!["push".to_owned()];
        if options.follow_tags {
            args.push("--follow-tags".into());
        }
        match options.push_mode {
            GitPushMode::Normal => {}
            GitPushMode::Force => args.push("--force".into()),
            GitPushMode::Lease => args.push("--force-with-lease".into()),
            GitPushMode::LeaseIfIncludes => {
                args.extend(["--force-with-lease".into(), "--force-if-includes".into()])
            }
        }
        args.extend([
            "--".into(),
            fields[0].to_owned(),
            format!("{}:{}", target.object_id, fields[1]),
        ]);
        self.run_mutation(root, args).await?.require_success()?;
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
    pub(crate) async fn require_remote(
        &self,
        repository: &GitRepository,
        name: &str,
    ) -> GitResult<()> {
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

impl GitClient {
    /// A reflog fork point different from the current merge base means upstream history
    /// was rewritten after this branch forked. Pulling may replay already integrated work.
    pub async fn pull_upstream_was_rewritten(&self, repository: &GitRepository) -> GitResult<bool> {
        let status = self.snapshot(repository).await?;
        let crate::GitHead::Branch {
            upstream: Some(upstream),
            ..
        } = status.head()
        else {
            return Ok(false);
        };
        let fork = self
            .run_query_unchecked(
                repository.worktree_root(),
                ["merge-base", "--fork-point", upstream.name(), "HEAD"],
            )
            .await?;
        if fork.status.code() == Some(1) {
            return Ok(false);
        }
        let fork = fork.require_success()?;
        let base = self
            .run_query_unchecked(
                repository.worktree_root(),
                ["merge-base", upstream.name(), "HEAD"],
            )
            .await?;
        if base.status.code() == Some(1) {
            return Ok(true);
        }
        let base = base.require_success()?;
        Ok(fork.stdout != base.stdout)
    }
}
