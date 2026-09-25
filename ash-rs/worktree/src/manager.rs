use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use ash_file_access::Dir;
use ash_git::GitClient;
use ash_git::GitDetachedWorktreeRequest;
use ash_git::GitError;
use ash_git::GitHead;
use ash_git::GitNamedWorktreeRequest;
use ash_git::GitPrivateRef;
use ash_git::GitRepository;
use ash_git::GitWorktreeRemovalMode;
use ash_protocol::ContentDigest;
use ignore::WalkBuilder;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::binding;
use crate::metadata;
use crate::settings::WorktreeSettings;

pub use ash_git::GitWorktreeAvailability as WorktreeAvailability;

/// Physical role of one checkout in a repository's worktree inventory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeKind {
    Primary,
    Linked,
}

/// Explicit selector used to resolve one worktree switch target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorktreeSelector {
    Branch(String),
    CheckoutRoot(PathBuf),
}

/// State of Codex thread ownership metadata attached to one worktree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorktreeOwner {
    Unbound,
    Thread(String),
    Invalid,
}

/// One Git worktree and the selected directory corresponding to the caller's source directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Worktree {
    checkout_root: PathBuf,
    dir: PathBuf,
    head: String,
    branch: Option<String>,
    kind: WorktreeKind,
    availability: WorktreeAvailability,
    current: bool,
    owner: WorktreeOwner,
}

/// Durable owner of one isolated managed directory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ManagedDirOwner {
    Thread { thread_id: String },
}

impl ManagedDirOwner {
    pub(crate) fn validate(&self, source_dir_id: &str) -> Result<()> {
        let _ = source_dir_id;
        let Self::Thread { thread_id } = self;
        let valid = !thread_id.trim().is_empty();
        if valid {
            Ok(())
        } else {
            bail!("managed directory owner is invalid")
        }
    }

    pub(crate) fn metadata_owner_id(&self) -> String {
        let Self::Thread { thread_id } = self;
        thread_id.clone()
    }

    fn managed_dir_id(&self) -> String {
        let Self::Thread { thread_id } = self;
        hex_digest(thread_id)
    }
}

/// Inputs that must be durably bound before an execution owner may use a managed directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedDirProvisionRequest {
    pub source: ManagedDirSource,
    pub target: ManagedDirTarget,
    pub repository_targets: BTreeMap<PathBuf, ManagedDirTarget>,
    pub source_dir_id: String,
    pub owner: ManagedDirOwner,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedDirSource {
    CurrentDirectory {
        source_directory: PathBuf,
    },
    ImmutableTree {
        source_directory: PathBuf,
        tree_id: String,
        repository_trees: BTreeMap<PathBuf, String>,
    },
}

impl ManagedDirSource {
    fn source_directory(&self) -> &Path {
        match self {
            Self::CurrentDirectory { source_directory }
            | Self::ImmutableTree {
                source_directory, ..
            } => source_directory,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedDirTarget {
    SourceHead,
    NewBranch {
        name: String,
    },
    Branch {
        name: String,
        object_id: String,
    },
    UnbornBranch {
        name: String,
        anchor_object_id: String,
    },
    Detached {
        object_id: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedDirKind {
    Git,
    Directory,
}

/// Durable managed checkout assigned exclusively to one execution owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedDirBinding {
    owner: ManagedDirOwner,
    managed_worktree_id: String,
    checkout_root: PathBuf,
    dir: PathBuf,
    source_dir_id: String,
    source_repository_root: PathBuf,
    target_branch: Option<String>,
    target_head: String,
    target_unborn: bool,
    baseline_tree: String,
    baseline_ref: String,
    kind: ManagedDirKind,
    repositories: Vec<ManagedRepositoryBinding>,
}

/// One repository mapped into a Thread dir.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedRepositoryBinding {
    repository_id: String,
    relative_path: PathBuf,
    worktree_root: PathBuf,
    source_repository_root: PathBuf,
    target_branch: Option<String>,
    target_head: String,
    target_unborn: bool,
    baseline_tree: String,
    baseline_ref: String,
}

impl ManagedDirBinding {
    pub fn owner(&self) -> &ManagedDirOwner {
        &self.owner
    }
    pub fn managed_worktree_id(&self) -> &str {
        &self.managed_worktree_id
    }

    pub fn checkout_root(&self) -> &Path {
        &self.checkout_root
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn source_dir_id(&self) -> &str {
        &self.source_dir_id
    }

    pub fn source_repository_root(&self) -> &Path {
        &self.source_repository_root
    }

    pub fn source_directory(&self) -> PathBuf {
        match self.kind {
            ManagedDirKind::Git => self
                .dir
                .strip_prefix(&self.checkout_root)
                .map(|relative| self.source_repository_root.join(relative))
                .unwrap_or_else(|_| self.source_repository_root.clone()),
            ManagedDirKind::Directory => self.source_repository_root.clone(),
        }
    }

    pub fn target_branch(&self) -> Option<&str> {
        self.target_branch.as_deref()
    }

    pub fn target_head(&self) -> &str {
        &self.target_head
    }

    pub const fn target_unborn(&self) -> bool {
        self.target_unborn
    }

    pub fn baseline_tree(&self) -> &str {
        &self.baseline_tree
    }

    pub fn baseline_ref(&self) -> &str {
        &self.baseline_ref
    }

    pub const fn kind(&self) -> ManagedDirKind {
        self.kind
    }

    pub fn repositories(&self) -> &[ManagedRepositoryBinding] {
        &self.repositories
    }

    /// Returns the canonical identity of the durable binding without exposing host paths.
    pub fn manifest_digest(&self) -> Result<ContentDigest> {
        let managed_dir_id = Dir::open_local(&self.dir)?.id();
        let repositories = self
            .repositories
            .iter()
            .map(|repository| {
                (
                    repository.repository_id.as_str(),
                    &repository.relative_path,
                    repository.target_branch.as_deref(),
                    repository.target_head.as_str(),
                    repository.target_unborn,
                    repository.baseline_tree.as_str(),
                    repository.baseline_ref.as_str(),
                )
            })
            .collect::<Vec<_>>();
        let encoded = serde_json::to_vec(&(
            1_u32,
            &self.owner,
            self.managed_worktree_id.as_str(),
            self.source_dir_id.as_str(),
            managed_dir_id,
            self.kind,
            repositories,
        ))?;
        Ok(ContentDigest::sha256(&encoded))
    }
}

impl ManagedRepositoryBinding {
    pub fn repository_id(&self) -> &str {
        &self.repository_id
    }
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }
    pub fn worktree_root(&self) -> &Path {
        &self.worktree_root
    }
    pub fn source_repository_root(&self) -> &Path {
        &self.source_repository_root
    }
    pub fn target_branch(&self) -> Option<&str> {
        self.target_branch.as_deref()
    }
    pub fn target_head(&self) -> &str {
        &self.target_head
    }
    pub const fn target_unborn(&self) -> bool {
        self.target_unborn
    }
    pub fn baseline_tree(&self) -> &str {
        &self.baseline_tree
    }
    pub fn baseline_ref(&self) -> &str {
        &self.baseline_ref
    }
}

/// Proof supplied by the ledger owner before destructive managed-directory cleanup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedDirCleanupEligibility {
    AllChangeSetsSettled,
}

impl Worktree {
    pub fn checkout_root(&self) -> &Path {
        &self.checkout_root
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn head(&self) -> &str {
        &self.head
    }

    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    pub const fn kind(&self) -> WorktreeKind {
        self.kind
    }

    pub const fn availability(&self) -> &WorktreeAvailability {
        &self.availability
    }

    pub const fn is_current(&self) -> bool {
        self.current
    }

    pub fn owner_thread_id(&self) -> Option<&str> {
        match &self.owner {
            WorktreeOwner::Thread(thread_id) => Some(thread_id),
            WorktreeOwner::Unbound | WorktreeOwner::Invalid => None,
        }
    }

    pub const fn owner(&self) -> &WorktreeOwner {
        &self.owner
    }
}

/// Discovers switch targets and manages Codex-compatible ownership for managed worktrees.
#[derive(Clone, Debug)]
pub struct WorktreeManager {
    settings: WorktreeSettings,
    git: GitClient,
}

impl WorktreeManager {
    pub fn new(mut settings: WorktreeSettings) -> Self {
        settings.root = dunce::simplified(&settings.root).to_path_buf();
        Self {
            settings,
            git: GitClient::system(),
        }
    }

    pub fn settings(&self) -> &WorktreeSettings {
        &self.settings
    }

    /// Creates a user-owned checkout without binding it to a Thread.
    pub async fn create_unbound(&self, source_directory: &Path, name: &str) -> Result<PathBuf> {
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            bail!("worktree name must use 1–64 letters, numbers, '-' or '_'");
        }
        let source = self.git.open_repository(source_directory).await?;
        let head = self.git.resolve_commit(&source, "HEAD").await?;
        let checkout = self.settings.root.join("manual").join(name);
        if std::fs::symlink_metadata(&checkout).is_ok() {
            bail!("worktree already exists at {}", checkout.display());
        }
        std::fs::create_dir_all(
            checkout
                .parent()
                .context("worktree checkout omitted its parent")?,
        )?;
        let request = GitDetachedWorktreeRequest::new(checkout.clone(), head)?;
        self.git.create_detached_checkout(&source, &request).await?;
        Ok(checkout)
    }

    /// Removes one listed, unbound linked checkout; Git rejects dirty or locked targets.
    pub async fn remove_unbound(
        &self,
        source_directory: &Path,
        checkout_root: &Path,
    ) -> Result<()> {
        if !checkout_root.is_absolute() {
            bail!("worktree checkout selector must be an absolute path");
        }
        let target = dunce::canonicalize(checkout_root).with_context(|| {
            format!(
                "cannot resolve worktree checkout {}",
                checkout_root.display()
            )
        })?;
        let worktree = self
            .list(source_directory)
            .await?
            .into_iter()
            .find(|worktree| worktree.checkout_root() == target)
            .context("worktree selector did not match a checkout")?;
        if worktree.kind() != WorktreeKind::Linked
            || worktree.is_current()
            || !matches!(worktree.availability(), WorktreeAvailability::Ready)
            || !matches!(worktree.owner(), WorktreeOwner::Unbound)
        {
            bail!("worktree is not an unbound linked checkout");
        }
        let source = self.git.open_repository(source_directory).await?;
        self.git
            .remove_clean_linked_worktree(&source, worktree.checkout_root())
            .await?;
        Ok(())
    }

    /// Lists the repository's worktrees while preserving the source directory's relative cwd.
    pub async fn list(&self, source_directory: &Path) -> Result<Vec<Worktree>> {
        let source_directory = dunce::canonicalize(source_directory).with_context(|| {
            format!(
                "cannot resolve source directory {}",
                source_directory.display()
            )
        })?;
        let source_repository = self.git.open_repository(&source_directory).await?;
        let relative_directory = source_directory
            .strip_prefix(source_repository.worktree_root())
            .context("source directory is outside its repository root")?;
        let entries = self.git.worktrees(&source_repository).await?;
        let mut worktrees = Vec::with_capacity(entries.len());
        for (index, entry) in entries.into_iter().enumerate() {
            let current = if entry.checkout_root() == source_repository.worktree_root() {
                true
            } else if entry.checkout_root().exists() {
                existing_paths_match(entry.checkout_root(), source_repository.worktree_root())?
            } else {
                false
            };
            let owner = if entry.availability().is_available() && entry.checkout_root().exists() {
                match self.git.open_repository(entry.checkout_root()).await {
                    Ok(repository) => match metadata::owner(repository.git_dir()) {
                        Ok(Some(thread_id)) => WorktreeOwner::Thread(thread_id),
                        Ok(None) => WorktreeOwner::Unbound,
                        Err(_) => WorktreeOwner::Invalid,
                    },
                    Err(GitError::NotAWorkingTree { .. }) => WorktreeOwner::Invalid,
                    Err(error) => return Err(error.into()),
                }
            } else {
                WorktreeOwner::Unbound
            };
            worktrees.push(Worktree {
                dir: entry.checkout_root().join(relative_directory),
                checkout_root: entry.checkout_root().to_path_buf(),
                head: entry.head().to_string(),
                branch: entry.branch().map(ToOwned::to_owned),
                kind: if index == 0 {
                    WorktreeKind::Primary
                } else {
                    WorktreeKind::Linked
                },
                availability: entry.availability().clone(),
                current,
                owner,
            });
        }
        Ok(worktrees)
    }

    /// Resolves one available worktree without changing process or product state.
    pub async fn resolve(
        &self,
        source_directory: &Path,
        selector: &WorktreeSelector,
    ) -> Result<Worktree> {
        let checkout_root = match selector {
            WorktreeSelector::Branch(branch) => {
                if branch.trim().is_empty() {
                    bail!("worktree branch selector cannot be empty");
                }
                None
            }
            WorktreeSelector::CheckoutRoot(root) => {
                if !root.is_absolute() {
                    bail!("worktree checkout selector must be an absolute path");
                }
                Some(dunce::canonicalize(root).with_context(|| {
                    format!("cannot resolve worktree checkout {}", root.display())
                })?)
            }
        };
        let worktrees = self.list(source_directory).await?;
        let mut matching = Vec::new();
        for worktree in worktrees {
            let matches = match selector {
                WorktreeSelector::Branch(branch) => worktree.branch() == Some(branch.as_str()),
                WorktreeSelector::CheckoutRoot(_) if !worktree.checkout_root().exists() => false,
                WorktreeSelector::CheckoutRoot(_) => existing_paths_match(
                    worktree.checkout_root(),
                    checkout_root
                        .as_deref()
                        .expect("checkout selector was canonicalized"),
                )?,
            };
            if matches {
                matching.push(worktree);
            }
        }
        if matching.len() > 1 {
            bail!("worktree selector matched more than one checkout");
        }
        let worktree = matching
            .pop()
            .context("worktree selector did not match a checkout")?;
        if !worktree.availability().is_available() {
            bail!(
                "worktree {} is not available",
                worktree.checkout_root().display()
            );
        }
        if !worktree.dir().is_dir() {
            bail!(
                "worktree directory does not exist: {}",
                worktree.dir().display()
            );
        }
        Ok(worktree)
    }

    pub async fn bind_thread(&self, checkout: &Path, thread_id: &str) -> Result<()> {
        let repository = self.managed_checkout(checkout).await?;
        metadata::bind_thread(repository.git_dir(), thread_id)
    }

    pub async fn owner(&self, checkout: &Path) -> Result<Option<String>> {
        let repository = self.managed_checkout(checkout).await?;
        metadata::owner(repository.git_dir())
    }

    /// Creates and durably binds one isolated checkout for an exact execution owner.
    pub async fn provision(
        &self,
        request: &ManagedDirProvisionRequest,
    ) -> Result<ManagedDirBinding> {
        if request.source_dir_id.trim().is_empty() {
            bail!("managed directory source identity cannot be empty");
        }
        request.owner.validate(&request.source_dir_id)?;
        let source_directory = dunce::canonicalize(request.source.source_directory())
            .with_context(|| {
                format!(
                    "cannot resolve source directory {}",
                    request.source.source_directory().display()
                )
            })?;
        let source_repository = match self.git.open_repository(&source_directory).await {
            Ok(repository) => repository,
            Err(ash_git::GitError::NotAWorkingTree { .. }) => {
                if matches!(&request.target, ManagedDirTarget::NewBranch { .. }) {
                    bail!("a named worktree requires a Git repository");
                }
                return self.provision_directory(request, &source_directory).await;
            }
            Err(error) => return Err(error.into()),
        };
        let relative_dir = source_directory
            .strip_prefix(source_repository.worktree_root())
            .context("source directory is outside its repository root")?
            .to_path_buf();
        let baseline_tree = match &request.source {
            ManagedDirSource::CurrentDirectory { .. } => {
                self.git.capture_worktree_tree(&source_repository).await?
            }
            ManagedDirSource::ImmutableTree { tree_id, .. } => {
                ash_git::GitTreeId::new(tree_id.clone())?
            }
        };
        let (target_branch, target_head, target_unborn) = match &request.target {
            ManagedDirTarget::SourceHead => {
                let snapshot = self.git.snapshot(&source_repository).await?;
                match snapshot.head() {
                    GitHead::Branch {
                        name, object_id, ..
                    } => (Some(name.clone()), object_id.clone(), false),
                    GitHead::Detached { object_id } => (None, object_id.clone(), false),
                    GitHead::Unborn { name } => (
                        Some(name.clone()),
                        self.git
                            .create_worktree_anchor(&source_repository, &baseline_tree)
                            .await?,
                        true,
                    ),
                }
            }
            ManagedDirTarget::NewBranch { name } => {
                if name.trim().is_empty() {
                    bail!("managed worktree branch name cannot be empty");
                }
                let snapshot = self.git.snapshot(&source_repository).await?;
                let head = match snapshot.head() {
                    GitHead::Branch { object_id, .. } | GitHead::Detached { object_id } => {
                        object_id.clone()
                    }
                    GitHead::Unborn { .. } => {
                        self.git
                            .create_worktree_anchor(&source_repository, &baseline_tree)
                            .await?
                    }
                };
                (Some(name.clone()), head, false)
            }
            ManagedDirTarget::Branch { name, object_id } => {
                if name.trim().is_empty() {
                    bail!("managed directory target branch cannot be empty");
                }
                (Some(name.clone()), object_id.clone(), false)
            }
            ManagedDirTarget::UnbornBranch {
                name,
                anchor_object_id,
            } => {
                if name.trim().is_empty() {
                    bail!("managed directory target branch cannot be empty");
                }
                (Some(name.clone()), anchor_object_id.clone(), true)
            }
            ManagedDirTarget::Detached { object_id } => (None, object_id.clone(), false),
        };
        let digest = request.owner.managed_dir_id();
        let checkout_root = self.settings.root.join(&digest[..4]).join(&digest);
        if checkout_root.exists() {
            let binding = self.recover(&checkout_root, &request.owner).await?;
            if let ManagedDirTarget::NewBranch { name } = &request.target
                && binding.target_branch() != Some(name.as_str())
            {
                bail!("existing managed worktree uses a different branch");
            }
            return Ok(binding);
        }
        std::fs::create_dir_all(
            checkout_root
                .parent()
                .context("managed checkout omitted its parent")?,
        )?;
        let baseline_ref = GitPrivateRef::new(format!("refs/ash/managed-dirs/{digest}/baseline"))?;
        self.git
            .pin_private_ref(&source_repository, &baseline_ref, &baseline_tree)
            .await?;
        let created = match &request.target {
            ManagedDirTarget::NewBranch { name } => {
                let creation = GitNamedWorktreeRequest::new(
                    checkout_root.clone(),
                    target_head.clone(),
                    name.clone(),
                )?;
                self.git
                    .create_named_worktree(&source_repository, &creation)
                    .await
            }
            _ => {
                let creation =
                    GitDetachedWorktreeRequest::new(checkout_root.clone(), target_head.clone())?;
                self.git
                    .create_detached_worktree(&source_repository, &creation)
                    .await
            }
        };
        let linked_repository = match created {
            Ok(repository) => repository,
            Err(error) => {
                let _ = self
                    .git
                    .delete_private_ref(&source_repository, &baseline_ref)
                    .await;
                return Err(error.into());
            }
        };
        let result = async {
            self.git
                .install_worktree_tree(&linked_repository, &baseline_tree)
                .await?;
            let metadata_owner_id = request.owner.metadata_owner_id();
            metadata::bind_thread(linked_repository.git_dir(), &metadata_owner_id)?;
            binding::write(
                linked_repository.git_dir(),
                &binding::BindingRecord::new(
                    digest.clone(),
                    request.owner.clone(),
                    request.source_dir_id.clone(),
                    source_repository.worktree_root().to_path_buf(),
                    relative_dir.clone(),
                    target_branch.clone(),
                    target_head.clone(),
                    target_unborn,
                    baseline_tree.as_str().to_string(),
                    baseline_ref.as_str().to_string(),
                    binding::BindingKind::Git,
                ),
            )?;
            self.git
                .lock_worktree(
                    &source_repository,
                    &checkout_root,
                    &format!("Ash managed directory for {metadata_owner_id}"),
                )
                .await?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            let _ = self
                .git
                .remove_linked_worktree(
                    &source_repository,
                    &checkout_root,
                    GitWorktreeRemovalMode::DiscardVerifiedContents,
                )
                .await;
            if let ManagedDirTarget::NewBranch { name } = &request.target {
                let _ = self
                    .git
                    .delete_branch_at(&source_repository, name, &target_head)
                    .await;
            }
            let _ = self
                .git
                .delete_private_ref(&source_repository, &baseline_ref)
                .await;
            return Err(error);
        }
        let checkout_root = dunce::canonicalize(&checkout_root)?;
        let repository_binding = ManagedRepositoryBinding {
            repository_id: local_repository_id(&source_repository)?,
            relative_path: PathBuf::from("."),
            worktree_root: checkout_root.clone(),
            source_repository_root: source_repository.worktree_root().to_path_buf(),
            target_branch: target_branch.clone(),
            target_head: target_head.clone(),
            target_unborn,
            baseline_tree: baseline_tree.as_str().to_string(),
            baseline_ref: baseline_ref.as_str().to_string(),
        };
        let dir = checkout_root.join(&relative_dir);
        let nested = match self
            .provision_nested_repositories(
                request,
                &source_directory,
                source_repository.worktree_root(),
                &dir,
                &digest,
            )
            .await
        {
            Ok(nested) => nested,
            Err(error) => {
                let _ = self
                    .git
                    .unlock_worktree(&source_repository, &checkout_root)
                    .await;
                let _ = self
                    .git
                    .remove_linked_worktree(
                        &source_repository,
                        &checkout_root,
                        GitWorktreeRemovalMode::DiscardVerifiedContents,
                    )
                    .await;
                if let ManagedDirTarget::NewBranch { name } = &request.target {
                    let _ = self
                        .git
                        .delete_branch_at(&source_repository, name, &target_head)
                        .await;
                }
                let _ = self
                    .git
                    .delete_private_ref(&source_repository, &baseline_ref)
                    .await;
                return Err(error);
            }
        };
        let mut repositories = vec![repository_binding];
        repositories.extend(nested);
        let record = binding::read(linked_repository.git_dir())?.with_repositories(
            repositories
                .iter()
                .map(repository_record)
                .collect::<Vec<_>>(),
        );
        binding::replace(linked_repository.git_dir(), &record)?;
        Ok(ManagedDirBinding {
            owner: request.owner.clone(),
            managed_worktree_id: digest,
            checkout_root: checkout_root.clone(),
            dir,
            source_dir_id: request.source_dir_id.clone(),
            source_repository_root: source_repository.worktree_root().to_path_buf(),
            target_branch,
            target_head,
            target_unborn,
            baseline_tree: baseline_tree.as_str().to_string(),
            baseline_ref: baseline_ref.as_str().to_string(),
            kind: ManagedDirKind::Git,
            repositories,
        })
    }

    async fn provision_nested_repositories(
        &self,
        request: &ManagedDirProvisionRequest,
        source_directory: &Path,
        primary_repository_root: &Path,
        dir: &Path,
        digest: &str,
    ) -> Result<Vec<ManagedRepositoryBinding>> {
        let roots = discover_nested_repository_roots(source_directory, primary_repository_root);
        let relative_paths = roots
            .iter()
            .map(|root| {
                root.strip_prefix(source_directory)
                    .map(Path::to_path_buf)
                    .context("nested repository is outside the source dir")
            })
            .collect::<Result<std::collections::BTreeSet<_>>>()?;
        if !request.repository_targets.is_empty()
            && request
                .repository_targets
                .keys()
                .collect::<std::collections::BTreeSet<_>>()
                != relative_paths
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
        {
            bail!("managed directory repository targets do not match its nested repositories");
        }
        let mut created = Vec::new();
        for source_root in roots {
            let relative_path = source_root
                .strip_prefix(source_directory)
                .context("nested repository is outside the source dir")?
                .to_path_buf();
            let source_repository = self.git.open_repository(&source_root).await?;
            let baseline_tree = match &request.source {
                ManagedDirSource::CurrentDirectory { .. } => {
                    self.git.capture_worktree_tree(&source_repository).await?
                }
                ManagedDirSource::ImmutableTree {
                    repository_trees, ..
                } => ash_git::GitTreeId::new(
                    repository_trees
                        .get(&relative_path)
                        .cloned()
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "nested repository {} has no immutable checkpoint",
                                relative_path.display()
                            )
                        })?,
                )?,
            };
            let target = request.repository_targets.get(&relative_path);
            let inherited = binding::try_read(source_repository.git_dir())?;
            let (target_branch, target_head, target_unborn) = match target {
                Some(ManagedDirTarget::Branch { name, object_id }) => {
                    (Some(name.clone()), object_id.clone(), false)
                }
                Some(ManagedDirTarget::UnbornBranch {
                    name,
                    anchor_object_id,
                }) => (Some(name.clone()), anchor_object_id.clone(), true),
                Some(ManagedDirTarget::Detached { object_id }) => (None, object_id.clone(), false),
                Some(ManagedDirTarget::NewBranch { .. }) => {
                    bail!("nested managed repositories cannot create a new branch")
                }
                Some(ManagedDirTarget::SourceHead) | None => match inherited {
                    Some(record) if record.kind == binding::BindingKind::Git => (
                        record.target_branch,
                        record.target_head,
                        record.target_unborn,
                    ),
                    _ => match self.git.snapshot(&source_repository).await?.head() {
                        GitHead::Branch {
                            name, object_id, ..
                        } => (Some(name.clone()), object_id.clone(), false),
                        GitHead::Detached { object_id } => (None, object_id.clone(), false),
                        GitHead::Unborn { name } => (
                            Some(name.clone()),
                            self.git
                                .create_worktree_anchor(&source_repository, &baseline_tree)
                                .await?,
                            true,
                        ),
                    },
                },
            };
            let path_digest = hex_digest(&relative_path.to_string_lossy());
            let baseline_ref = GitPrivateRef::new(format!(
                "refs/ash/managed-dirs/{digest}/repositories/{path_digest}/baseline"
            ))?;
            self.git
                .pin_private_ref(&source_repository, &baseline_ref, &baseline_tree)
                .await?;
            let destination = dir.join(&relative_path);
            if destination.exists() {
                if destination.is_dir() {
                    std::fs::remove_dir_all(&destination)?;
                } else {
                    bail!(
                        "nested repository destination is not a directory: {}",
                        destination.display()
                    );
                }
            }
            let linked = match self
                .git
                .create_detached_worktree(
                    &source_repository,
                    &GitDetachedWorktreeRequest::new(destination.clone(), target_head.clone())?,
                )
                .await
            {
                Ok(linked) => linked,
                Err(error) => {
                    let _ = self
                        .git
                        .delete_private_ref(&source_repository, &baseline_ref)
                        .await;
                    for repository in created.iter().rev() {
                        let _ = self.cleanup_repository(repository).await;
                    }
                    return Err(error.into());
                }
            };
            let repository = ManagedRepositoryBinding {
                repository_id: local_repository_id(&source_repository)?,
                relative_path: relative_path.clone(),
                worktree_root: destination.clone(),
                source_repository_root: source_root.clone(),
                target_branch: target_branch.clone(),
                target_head: target_head.clone(),
                target_unborn,
                baseline_tree: baseline_tree.as_str().to_string(),
                baseline_ref: baseline_ref.as_str().to_string(),
            };
            let setup = async {
                self.git
                    .install_worktree_tree(&linked, &baseline_tree)
                    .await?;
                let metadata_owner_id = request.owner.metadata_owner_id();
                metadata::bind_thread(linked.git_dir(), &metadata_owner_id)?;
                binding::write(
                    linked.git_dir(),
                    &binding::BindingRecord::new(
                        digest.to_string(),
                        request.owner.clone(),
                        request.source_dir_id.clone(),
                        source_root.clone(),
                        PathBuf::from("."),
                        target_branch,
                        target_head,
                        target_unborn,
                        baseline_tree.as_str().to_string(),
                        baseline_ref.as_str().to_string(),
                        binding::BindingKind::Git,
                    ),
                )?;
                self.git
                    .lock_worktree(
                        &source_repository,
                        &destination,
                        &format!("Ash managed nested repository for {}", metadata_owner_id),
                    )
                    .await?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = setup {
                let _ = self
                    .git
                    .remove_linked_worktree(
                        &source_repository,
                        &destination,
                        GitWorktreeRemovalMode::DiscardVerifiedContents,
                    )
                    .await;
                let _ = self
                    .git
                    .delete_private_ref(&source_repository, &baseline_ref)
                    .await;
                for repository in created.iter().rev() {
                    let _ = self.cleanup_repository(repository).await;
                }
                return Err(error);
            }
            created.push(repository);
        }
        Ok(created)
    }

    async fn cleanup_repository(&self, binding: &ManagedRepositoryBinding) -> Result<()> {
        let source = self
            .git
            .open_repository(binding.source_repository_root())
            .await?;
        self.git
            .unlock_worktree(&source, binding.worktree_root())
            .await?;
        self.git
            .remove_linked_worktree(
                &source,
                binding.worktree_root(),
                GitWorktreeRemovalMode::DiscardVerifiedContents,
            )
            .await?;
        self.git
            .delete_private_ref(
                &source,
                &GitPrivateRef::new(binding.baseline_ref().to_string())?,
            )
            .await?;
        Ok(())
    }

    async fn provision_directory(
        &self,
        request: &ManagedDirProvisionRequest,
        source_directory: &Path,
    ) -> Result<ManagedDirBinding> {
        if request.source_dir_id.trim().is_empty() {
            bail!("managed directory source identity cannot be empty");
        }
        request.owner.validate(&request.source_dir_id)?;
        let digest = request.owner.managed_dir_id();
        let checkout_root = self.settings.root.join(&digest[..4]).join(&digest);
        if checkout_root.exists() {
            return self.recover(&checkout_root, &request.owner).await;
        }
        let dir = checkout_root.join("dir");
        if matches!(request.source, ManagedDirSource::ImmutableTree { .. }) {
            bail!("non-Git managed directories cannot be provisioned from a Git tree");
        }
        std::fs::create_dir_all(&dir)?;
        let baseline_tree = copy_directory(source_directory, &dir)?;
        let checkout_root = dunce::canonicalize(&checkout_root)?;
        let dir = checkout_root.join("dir");
        let result = (|| {
            binding::write(
                &checkout_root,
                &binding::BindingRecord::new(
                    digest.clone(),
                    request.owner.clone(),
                    request.source_dir_id.clone(),
                    source_directory.to_path_buf(),
                    PathBuf::from("dir"),
                    None,
                    baseline_tree.clone(),
                    false,
                    baseline_tree.clone(),
                    String::new(),
                    binding::BindingKind::Directory,
                )
                .with_repositories(Vec::new()),
            )
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir_all(&checkout_root);
            return Err(error);
        }
        Ok(ManagedDirBinding {
            owner: request.owner.clone(),
            managed_worktree_id: digest,
            checkout_root,
            dir,
            source_dir_id: request.source_dir_id.clone(),
            source_repository_root: source_directory.to_path_buf(),
            target_branch: None,
            target_head: baseline_tree.clone(),
            target_unborn: false,
            baseline_tree,
            baseline_ref: String::new(),
            kind: ManagedDirKind::Directory,
            repositories: Vec::new(),
        })
    }

    /// Recovers the durable binding stored inside an existing managed linked worktree.
    pub async fn recover(
        &self,
        checkout_root: &Path,
        owner: &ManagedDirOwner,
    ) -> Result<ManagedDirBinding> {
        if let Some(mut record) = binding::try_read(checkout_root)? {
            if record.kind != binding::BindingKind::Directory {
                bail!("managed directory binding has an invalid dir kind");
            }
            if !record.matches_owner(owner) || record.managed_worktree_id != owner.managed_dir_id()
            {
                bail!("managed directory binding owner does not match its durable owner");
            }
            if record.needs_upgrade() {
                let upgraded = record.clone().upgrade(owner.clone());
                binding::replace(checkout_root, &upgraded)?;
                record = upgraded;
            }
            let checkout_root = dunce::canonicalize(checkout_root)?;
            let managed_root = dunce::canonicalize(&self.settings.root)?;
            if !has_managed_layout(&managed_root, &checkout_root) {
                bail!(
                    "{} is not a managed Thread directory",
                    checkout_root.display()
                );
            }
            let dir = checkout_root.join(&record.relative_dir);
            let repositories = repositories_from_record(&record, &dir, &dir, true);
            return Ok(ManagedDirBinding {
                owner: owner.clone(),
                managed_worktree_id: record.managed_worktree_id,
                dir,
                checkout_root,
                source_dir_id: record.source_dir_id,
                source_repository_root: record.source_repository_root,
                target_branch: None,
                target_head: record.target_head,
                target_unborn: record.target_unborn,
                baseline_tree: record.baseline_tree,
                baseline_ref: record.baseline_ref,
                kind: ManagedDirKind::Directory,
                repositories,
            });
        }
        let repository = self.managed_checkout(checkout_root).await?;
        if metadata::owner(repository.git_dir())?.as_deref()
            != Some(owner.metadata_owner_id().as_str())
        {
            bail!("managed worktree belongs to another execution owner");
        }
        let record = binding::read(repository.git_dir())?;
        if !record.matches_owner(owner) || record.managed_worktree_id != owner.managed_dir_id() {
            bail!("managed worktree binding owner does not match its durable owner");
        }
        let dir = repository.worktree_root().join(&record.relative_dir);
        let repositories =
            repositories_from_record(&record, &dir, repository.worktree_root(), false);
        Ok(ManagedDirBinding {
            owner: owner.clone(),
            managed_worktree_id: record.managed_worktree_id,
            checkout_root: repository.worktree_root().to_path_buf(),
            dir,
            source_dir_id: record.source_dir_id,
            source_repository_root: record.source_repository_root,
            target_branch: record.target_branch,
            target_head: record.target_head,
            target_unborn: record.target_unborn,
            baseline_tree: record.baseline_tree,
            baseline_ref: record.baseline_ref,
            kind: match record.kind {
                binding::BindingKind::Git => ManagedDirKind::Git,
                binding::BindingKind::Directory => ManagedDirKind::Directory,
            },
            repositories,
        })
    }

    /// Recovers the deterministic managed directory assigned to one exact owner.
    pub async fn recover_owner(&self, owner: &ManagedDirOwner) -> Result<ManagedDirBinding> {
        let digest = owner.managed_dir_id();
        self.recover(&self.settings.root.join(&digest[..4]).join(&digest), owner)
            .await
    }

    /// Recovers every valid Thread binding reachable from one source repository.
    pub async fn recover_threads(
        &self,
        source_directory: &Path,
        source_dir_id: &str,
    ) -> Result<Vec<(String, ManagedDirBinding)>> {
        let mut bindings = self.recover_directory_threads(source_dir_id).await?;
        let source_repository = match self.git.open_repository(source_directory).await {
            Ok(repository) => repository,
            Err(GitError::NotAWorkingTree { .. }) => return Ok(bindings),
            Err(error) => return Err(error.into()),
        };
        self.repair_managed_worktrees(&source_repository).await?;
        let worktrees = self.list(source_directory).await?;
        let managed_root = match dunce::canonicalize(&self.settings.root) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(bindings),
            Err(error) => return Err(error.into()),
        };
        for worktree in worktrees {
            let Some(thread_id) = worktree.owner_thread_id() else {
                continue;
            };
            if worktree.kind() != WorktreeKind::Linked || !worktree.availability().is_available() {
                continue;
            }
            // A repository may also have managed checkouts owned by other profiles.
            if !has_managed_layout(&managed_root, worktree.checkout_root()) {
                continue;
            }
            let owner = ManagedDirOwner::Thread {
                thread_id: thread_id.to_string(),
            };
            if worktree
                .checkout_root()
                .file_name()
                .and_then(|name| name.to_str())
                != Some(owner.managed_dir_id().as_str())
            {
                continue;
            }
            if !self
                .relocate_thread_binding(
                    worktree.checkout_root(),
                    &owner,
                    source_directory,
                    source_dir_id,
                    &source_repository,
                )
                .await?
            {
                continue;
            }
            bindings.push((
                thread_id.to_string(),
                self.recover(worktree.checkout_root(), &owner).await?,
            ));
        }
        Ok(bindings)
    }

    async fn repair_managed_worktrees(&self, source_repository: &GitRepository) -> Result<()> {
        let managed_root = match dunce::canonicalize(&self.settings.root) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for worktree in self.git.worktrees(source_repository).await? {
            if worktree.checkout_root() == source_repository.worktree_root()
                || !worktree.availability().is_available()
                || !worktree.checkout_root().exists()
                || !has_managed_owner_layout(&managed_root, worktree.checkout_root())
            {
                continue;
            }
            match self.git.open_repository(worktree.checkout_root()).await {
                Ok(_) => {}
                Err(GitError::NotAWorkingTree { .. }) => {
                    self.git
                        .repair_linked_worktree(source_repository, worktree.checkout_root())
                        .await?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn relocate_thread_binding(
        &self,
        checkout_root: &Path,
        owner: &ManagedDirOwner,
        source_directory: &Path,
        source_dir_id: &str,
        source_repository: &GitRepository,
    ) -> Result<bool> {
        let linked_repository = self.managed_checkout(checkout_root).await?;
        let mut record = binding::read(linked_repository.git_dir())?;
        if record.kind != binding::BindingKind::Git
            || !record.matches_owner(owner)
            || record.managed_worktree_id != owner.managed_dir_id()
        {
            bail!("managed worktree binding does not match its durable owner");
        }
        let relative_dir = source_directory
            .strip_prefix(source_repository.worktree_root())
            .context("source directory is outside its repository root")?;
        if record.relative_dir != relative_dir {
            return Ok(false);
        }

        let current_source_root = source_repository.worktree_root();
        // Directory identity follows the current path. Repository identities stay unchanged so
        // existing ChangeSets continue to address the same entries after the path migration.
        let mut changed = record.source_dir_id != source_dir_id
            || record.source_repository_root != current_source_root;
        record.source_dir_id = source_dir_id.to_string();
        record.source_repository_root = current_source_root.to_path_buf();
        let managed_dir = checkout_root.join(relative_dir);
        for repository in &mut record.repositories {
            let source_root = if repository.relative_path == Path::new(".") {
                current_source_root.to_path_buf()
            } else {
                source_directory.join(&repository.relative_path)
            };
            let opened_source = self.git.open_repository(&source_root).await?;
            if repository.source_repository_root != opened_source.worktree_root() {
                repository.source_repository_root = opened_source.worktree_root().to_path_buf();
                changed = true;
            }
            if repository.relative_path == Path::new(".") {
                continue;
            }
            let managed_repository = managed_dir.join(&repository.relative_path);
            let opened_managed = match self.git.open_repository(&managed_repository).await {
                Ok(repository) => repository,
                Err(GitError::NotAWorkingTree { .. }) => {
                    self.git
                        .repair_linked_worktree(&opened_source, &managed_repository)
                        .await?;
                    self.git.open_repository(&managed_repository).await?
                }
                Err(error) => return Err(error.into()),
            };
            let mut nested_record = binding::read(opened_managed.git_dir())?;
            if nested_record.kind != binding::BindingKind::Git
                || !nested_record.matches_owner(owner)
                || nested_record.managed_worktree_id != owner.managed_dir_id()
            {
                bail!("managed nested worktree binding does not match its durable owner");
            }
            let nested_changed = nested_record.source_dir_id != source_dir_id
                || nested_record.source_repository_root != opened_source.worktree_root();
            if nested_changed {
                nested_record.source_dir_id = source_dir_id.to_string();
                nested_record.source_repository_root = opened_source.worktree_root().to_path_buf();
                binding::replace(opened_managed.git_dir(), &nested_record)?;
            }
        }
        if changed {
            binding::replace(linked_repository.git_dir(), &record)?;
        }
        Ok(true)
    }

    async fn recover_directory_threads(
        &self,
        source_dir_id: &str,
    ) -> Result<Vec<(String, ManagedDirBinding)>> {
        let mut recovered = Vec::new();
        let Ok(buckets) = std::fs::read_dir(&self.settings.root) else {
            return Ok(recovered);
        };
        for bucket in buckets {
            let bucket = bucket?;
            if !bucket.file_type()?.is_dir() {
                continue;
            }
            let name = bucket.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.len() != 4 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            for checkout in std::fs::read_dir(bucket.path())? {
                let checkout = checkout?;
                if !checkout.file_type()?.is_dir() {
                    continue;
                }
                let Some(record) = binding::try_read(&checkout.path())? else {
                    continue;
                };
                if record.kind != binding::BindingKind::Directory
                    || record.source_dir_id != source_dir_id
                {
                    continue;
                }
                let thread_id = record.owner_thread_id.clone();
                let owner = ManagedDirOwner::Thread {
                    thread_id: thread_id.clone(),
                };
                if record.managed_worktree_id != owner.managed_dir_id() {
                    continue;
                }
                recovered.push((
                    thread_id.clone(),
                    self.recover(&checkout.path(), &owner).await?,
                ));
            }
        }
        Ok(recovered)
    }

    /// Removes a managed checkout only after every ChangeSet is settled.
    pub async fn cleanup(
        &self,
        binding: &ManagedDirBinding,
        _eligibility: ManagedDirCleanupEligibility,
    ) -> Result<()> {
        if binding.kind == ManagedDirKind::Directory {
            let managed_root = dunce::canonicalize(&self.settings.root)?;
            let checkout_root = dunce::canonicalize(&binding.checkout_root)?;
            if !has_managed_layout(&managed_root, &checkout_root) {
                bail!(
                    "{} is not a managed Thread directory",
                    checkout_root.display()
                );
            }
            std::fs::remove_dir_all(checkout_root)?;
            return Ok(());
        }
        for repository in binding.repositories.iter().skip(1).rev() {
            self.cleanup_repository(repository).await?;
        }
        let source_repository = self
            .git
            .open_repository(&binding.source_repository_root)
            .await?;
        self.git
            .unlock_worktree(&source_repository, &binding.checkout_root)
            .await?;
        self.git
            .remove_linked_worktree(
                &source_repository,
                &binding.checkout_root,
                GitWorktreeRemovalMode::DiscardVerifiedContents,
            )
            .await?;
        self.git
            .delete_private_ref(
                &source_repository,
                &GitPrivateRef::new(binding.baseline_ref.clone())?,
            )
            .await?;
        Ok(())
    }

    async fn managed_checkout(&self, checkout: &Path) -> Result<GitRepository> {
        let managed_root = dunce::canonicalize(&self.settings.root).with_context(|| {
            format!(
                "cannot resolve managed worktree root {}",
                self.settings.root.display()
            )
        })?;
        let checkout = dunce::canonicalize(checkout)
            .with_context(|| format!("cannot resolve worktree {}", checkout.display()))?;
        if !has_managed_layout(&managed_root, &checkout) {
            bail!("{} is not a managed worktree", checkout.display());
        }
        let repository = self.git.open_repository(&checkout).await?;
        if repository.worktree_root() != checkout {
            bail!("{} is not a worktree root", checkout.display());
        }
        if repository.git_dir() == repository.common_dir() {
            bail!("{} is not a linked worktree", checkout.display());
        }
        Ok(repository)
    }
}

fn discover_nested_repository_roots(
    source_directory: &Path,
    primary_repository_root: &Path,
) -> Vec<PathBuf> {
    const MAX_REPOSITORIES: usize = 128;
    let mut roots = Vec::new();
    let mut builder = WalkBuilder::new(source_directory);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .max_depth(Some(16))
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            entry.depth() == 0
                || !matches!(
                    name.as_ref(),
                    ".git" | "node_modules" | "target" | ".build" | "out" | "dist" | ".cache"
                )
        });
    for entry in builder.build().filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|kind| kind.is_dir())
            || !entry.path().join(".git").exists()
        {
            continue;
        }
        let Ok(root) = dunce::canonicalize(entry.path()) else {
            continue;
        };
        if root != primary_repository_root && !roots.contains(&root) {
            roots.push(root);
            if roots.len() >= MAX_REPOSITORIES {
                break;
            }
        }
    }
    roots.sort();
    roots
}

fn copy_directory(source: &Path, destination: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    copy_directory_entries(source, source, destination, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn copy_directory_entries(
    root: &Path,
    source: &Path,
    destination: &Path,
    digest: &mut Sha256,
) -> Result<()> {
    let mut entries = std::fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let source_path = entry.path();
        let relative = source_path
            .strip_prefix(root)
            .context("managed directory copy escaped its source root")?;
        let relative_text = relative
            .to_str()
            .context("managed directory path is not UTF-8")?;
        let destination_path = destination.join(relative);
        let metadata = std::fs::symlink_metadata(&source_path)?;
        digest.update(relative_text.as_bytes());
        digest.update([0]);
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            digest.update(b"directory");
            std::fs::create_dir_all(&destination_path)?;
            copy_directory_entries(root, &source_path, destination, digest)?;
        } else if metadata.file_type().is_symlink() {
            digest.update(b"symlink");
            let target = std::fs::read_link(&source_path)?;
            digest.update(target.to_string_lossy().as_bytes());
            copy_symlink(&source_path, &target, &destination_path)?;
        } else if metadata.is_file() {
            digest.update(b"file");
            let bytes = std::fs::read(&source_path)?;
            digest.update(&bytes);
            std::fs::write(&destination_path, bytes)?;
            std::fs::set_permissions(&destination_path, metadata.permissions())?;
        } else {
            bail!(
                "unsupported managed directory entry: {}",
                source_path.display()
            );
        }
        digest.update([0]);
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(_: &Path, target: &Path, destination: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, destination)?;
    Ok(())
}

#[cfg(windows)]
fn copy_symlink(source: &Path, target: &Path, destination: &Path) -> Result<()> {
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(target, destination)?;
    } else {
        std::os::windows::fs::symlink_file(target, destination)?;
    }
    Ok(())
}

fn repository_record(repository: &ManagedRepositoryBinding) -> binding::RepositoryBindingRecord {
    binding::RepositoryBindingRecord {
        repository_id: repository.repository_id.clone(),
        relative_path: repository.relative_path.clone(),
        source_repository_root: repository.source_repository_root.clone(),
        target_branch: repository.target_branch.clone(),
        target_head: repository.target_head.clone(),
        target_unborn: repository.target_unborn,
        baseline_tree: repository.baseline_tree.clone(),
        baseline_ref: repository.baseline_ref.clone(),
    }
}

fn repositories_from_record(
    record: &binding::BindingRecord,
    dir: &Path,
    primary_worktree_root: &Path,
    directory: bool,
) -> Vec<ManagedRepositoryBinding> {
    if directory {
        return Vec::new();
    }
    if record.repositories.is_empty() {
        return vec![ManagedRepositoryBinding {
            repository_id: format!("{}:repository", record.managed_worktree_id),
            relative_path: PathBuf::from("."),
            worktree_root: primary_worktree_root.to_path_buf(),
            source_repository_root: record.source_repository_root.clone(),
            target_branch: record.target_branch.clone(),
            target_head: record.target_head.clone(),
            target_unborn: record.target_unborn,
            baseline_tree: record.baseline_tree.clone(),
            baseline_ref: record.baseline_ref.clone(),
        }];
    }
    record
        .repositories
        .iter()
        .map(|repository| ManagedRepositoryBinding {
            repository_id: repository.repository_id.clone(),
            relative_path: repository.relative_path.clone(),
            worktree_root: if repository.relative_path == Path::new(".") {
                primary_worktree_root.to_path_buf()
            } else {
                dir.join(&repository.relative_path)
            },
            source_repository_root: repository.source_repository_root.clone(),
            target_branch: repository.target_branch.clone(),
            target_head: repository.target_head.clone(),
            target_unborn: repository.target_unborn,
            baseline_tree: repository.baseline_tree.clone(),
            baseline_ref: repository.baseline_ref.clone(),
        })
        .collect()
}

fn hex_digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn local_repository_id(repository: &GitRepository) -> Result<String> {
    let common_dir = Dir::open_local(repository.common_dir())?;
    Ok(format!("git:{}", common_dir.id()))
}

fn has_managed_layout(root: &Path, checkout: &Path) -> bool {
    let Ok(relative) = checkout.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(Component::Normal(bucket)) = components.next() else {
        return false;
    };
    let Some(bucket) = bucket.to_str() else {
        return false;
    };
    bucket.len() == 4
        && bucket.bytes().all(|byte| byte.is_ascii_hexdigit())
        && matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
}

fn has_managed_owner_layout(root: &Path, checkout: &Path) -> bool {
    let Ok(relative) = checkout.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let (Some(Component::Normal(bucket)), Some(Component::Normal(owner))) =
        (components.next(), components.next())
    else {
        return false;
    };
    let (Some(bucket), Some(owner)) = (bucket.to_str(), owner.to_str()) else {
        return false;
    };
    components.next().is_none()
        && bucket.len() == 4
        && owner.len() == 64
        && owner.starts_with(bucket)
        && owner.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn existing_paths_match(left: &Path, right: &Path) -> Result<bool> {
    Ok(dunce::canonicalize(left)? == dunce::canonicalize(right)?)
}
