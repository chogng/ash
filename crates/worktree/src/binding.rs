use crate::manager::ManagedDirOwner;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const BINDING_FILENAME: &str = "ash-thread-dir.json";
const BINDING_VERSION: u8 = 6;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepositoryBindingRecord {
    pub repository_id: String,
    pub relative_path: PathBuf,
    pub source_repository_root: PathBuf,
    pub target_branch: Option<String>,
    pub target_head: String,
    #[serde(default)]
    pub target_unborn: bool,
    pub baseline_tree: String,
    pub baseline_ref: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BindingKind {
    #[default]
    Git,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindingRecord {
    version: u8,
    pub managed_worktree_id: String,
    pub owner_thread_id: String,
    #[serde(default)]
    pub owner: Option<ManagedDirOwner>,
    pub source_dir_id: String,
    pub source_repository_root: PathBuf,
    pub relative_dir: PathBuf,
    pub target_branch: Option<String>,
    pub target_head: String,
    #[serde(default)]
    pub target_unborn: bool,
    pub baseline_tree: String,
    pub baseline_ref: String,
    #[serde(default)]
    pub kind: BindingKind,
    #[serde(default)]
    pub repositories: Vec<RepositoryBindingRecord>,
}

impl BindingRecord {
    pub(crate) fn new(
        managed_worktree_id: String,
        owner: ManagedDirOwner,
        source_dir_id: String,
        source_repository_root: PathBuf,
        relative_dir: PathBuf,
        target_branch: Option<String>,
        target_head: String,
        target_unborn: bool,
        baseline_tree: String,
        baseline_ref: String,
        kind: BindingKind,
    ) -> Self {
        Self {
            version: BINDING_VERSION,
            managed_worktree_id,
            owner_thread_id: owner.metadata_owner_id(),
            owner: Some(owner),
            source_dir_id,
            source_repository_root,
            relative_dir,
            target_branch,
            target_head,
            target_unborn,
            baseline_tree,
            baseline_ref,
            kind,
            repositories: Vec::new(),
        }
    }

    pub(crate) fn with_repositories(mut self, repositories: Vec<RepositoryBindingRecord>) -> Self {
        self.repositories = repositories;
        self
    }

    pub(crate) fn matches_owner(&self, owner: &ManagedDirOwner) -> bool {
        match &self.owner {
            Some(recorded) => recorded == owner,
            None => matches!(
                owner,
                ManagedDirOwner::Thread { thread_id } if thread_id == &self.owner_thread_id
            ),
        }
    }

    pub(crate) fn needs_upgrade(&self) -> bool {
        self.version < BINDING_VERSION
    }

    pub(crate) fn upgrade(mut self, owner: ManagedDirOwner) -> Self {
        self.version = BINDING_VERSION;
        self.owner_thread_id = owner.metadata_owner_id();
        self.owner = Some(owner);
        self
    }
}

pub(crate) fn read(git_dir: &Path) -> Result<BindingRecord> {
    let path = git_dir.join(BINDING_FILENAME);
    let bytes = fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut value = serde_json::from_slice::<serde_json::Value>(&bytes)
        .with_context(|| format!("invalid Thread directory binding at {}", path.display()))?;
    if value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version < u64::from(BINDING_VERSION))
        && let Some(fields) = value.as_object_mut()
    {
        fields.remove("snapshotStore");
    }
    let record = serde_json::from_value::<BindingRecord>(value)
        .with_context(|| format!("invalid Thread directory binding at {}", path.display()))?;
    if !(1..=BINDING_VERSION).contains(&record.version)
        || record.managed_worktree_id.is_empty()
        || record.owner_thread_id.is_empty()
        || (record.version == BINDING_VERSION && record.owner.is_none())
        || record.owner.as_ref().is_some_and(|owner| {
            owner.metadata_owner_id() != record.owner_thread_id
                || owner.validate(&record.source_dir_id).is_err()
        })
        || record.target_head.is_empty()
        || record.baseline_tree.is_empty()
        || (record.kind == BindingKind::Git && record.baseline_ref.is_empty())
    {
        bail!("invalid Thread directory binding at {}", path.display());
    }
    Ok(record)
}

pub(crate) fn try_read(directory: &Path) -> Result<Option<BindingRecord>> {
    if !directory.join(BINDING_FILENAME).exists() {
        return Ok(None);
    }
    read(directory).map(Some)
}

pub(crate) fn write(git_dir: &Path, record: &BindingRecord) -> Result<()> {
    let path = git_dir.join(BINDING_FILENAME);
    if path.exists() {
        let current = read(git_dir)?;
        if &current == record {
            return Ok(());
        }
        bail!(
            "Thread directory binding already exists at {}",
            path.display()
        );
    }
    let mut temporary = NamedTempFile::new_in(git_dir).with_context(|| {
        format!(
            "cannot create Thread directory binding in {}",
            git_dir.display()
        )
    })?;
    serde_json::to_writer(&mut temporary, record)?;
    temporary.flush()?;
    temporary
        .persist_noclobber(&path)
        .map(|_| ())
        .map_err(|error| error.error)
        .with_context(|| {
            format!(
                "cannot write Thread directory binding at {}",
                path.display()
            )
        })
}

pub(crate) fn replace(git_dir: &Path, record: &BindingRecord) -> Result<()> {
    let current = read(git_dir)?;
    if current.owner_thread_id != record.owner_thread_id
        || current
            .owner
            .as_ref()
            .is_some_and(|owner| Some(owner) != record.owner.as_ref())
        || current.managed_worktree_id != record.managed_worktree_id
    {
        bail!("Thread directory binding owner changed during update");
    }
    let path = git_dir.join(BINDING_FILENAME);
    let mut temporary = NamedTempFile::new_in(git_dir)?;
    serde_json::to_writer(&mut temporary, record)?;
    temporary.flush()?;
    temporary
        .persist(&path)
        .map(|_| ())
        .map_err(|error| error.error)
        .with_context(|| format!("cannot replace {}", path.display()))
}
