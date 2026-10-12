use crate::WorktreeManager;
use crate::manager::copy_directory;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use ash_protocol::ContentDigest;
use std::path::Path;
use std::path::PathBuf;

/// Replacement that preserves the directory identity and rolls back unless committed.
pub struct DirectoryRestoration {
    root: PathBuf,
    backup: PathBuf,
    target: PathBuf,
    _staging: Option<tempfile::TempDir>,
    original: Vec<std::ffi::OsString>,
    installed: Vec<std::ffi::OsString>,
    committed: bool,
}

impl DirectoryRestoration {
    pub fn commit(&mut self) {
        self.committed = true;
    }

    /// Retained in the recovery intent before any live entries are moved.
    pub fn backup(&self) -> &Path {
        &self.backup
    }

    pub fn install(&mut self) -> Result<()> {
        for entry in std::fs::read_dir(&self.root)? {
            let name = entry?.file_name();
            std::fs::rename(self.root.join(&name), self.backup.join(&name))?;
            self.original.push(name);
        }
        for entry in std::fs::read_dir(&self.target)? {
            let name = entry?.file_name();
            std::fs::rename(self.target.join(&name), self.root.join(&name))?;
            self.installed.push(name);
        }
        Ok(())
    }

    pub fn rollback(&mut self) -> Result<()> {
        while let Some(name) = self.installed.last() {
            let path = self.root.join(name);
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                std::fs::remove_dir_all(path)?;
            } else {
                std::fs::remove_file(path)?;
            }
            self.installed.pop();
        }
        while let Some(name) = self.original.last() {
            std::fs::rename(self.backup.join(name), self.root.join(name))?;
            self.original.pop();
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for DirectoryRestoration {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = self.rollback() {
                if let Some(staging) = self._staging.take() {
                    let _ = staging.keep();
                }
                eprintln!("cannot roll back directory restoration; backup retained: {error}");
            }
        }
    }
}

impl WorktreeManager {
    /// Prepares immutable files before recording the durable restoration intent.
    pub fn prepare_directory_restoration(
        &self,
        root: &Path,
        digest: &ContentDigest,
    ) -> Result<DirectoryRestoration> {
        let parent = root.parent().context("managed directory has no parent")?;
        let staging = tempfile::Builder::new()
            .prefix(".history-files-")
            .tempdir_in(parent)?;
        let target = staging.path().join("target");
        std::fs::create_dir(&target)?;
        self.copy_directory_checkpoint(digest, &target)?;
        let backup = staging.path().join("previous");
        std::fs::create_dir(&backup)?;
        Ok(DirectoryRestoration {
            root: root.to_path_buf(),
            backup,
            target,
            _staging: Some(staging),
            original: Vec::new(),
            installed: Vec::new(),
            committed: false,
        })
    }

    /// Installs a retained tree without replacing the root inode held by editors and terminals.
    pub fn restore_directory_checkpoint(
        &self,
        root: &Path,
        digest: &ContentDigest,
    ) -> Result<DirectoryRestoration> {
        let mut restoration = self.prepare_directory_restoration(root, digest)?;
        restoration.install()?;
        Ok(restoration)
    }

    /// A crashed installation may contain old entries, new entries, and originals in backup.
    /// Unknown contents indicate edits made after the interruption and must remain untouched.
    pub fn directory_rollback_is_safe(
        &self,
        root: &Path,
        previous: &ContentDigest,
        target: &ContentDigest,
        backup: Option<&Path>,
    ) -> Result<bool> {
        let verification = tempfile::tempdir()?;
        let before = verification.path().join("before");
        let after = verification.path().join("after");
        std::fs::create_dir(&before)?;
        std::fs::create_dir(&after)?;
        self.copy_directory_checkpoint(previous, &before)?;
        self.copy_directory_checkpoint(target, &after)?;
        let mut names = std::collections::BTreeSet::new();
        for directory in [&before, &after, root] {
            for entry in std::fs::read_dir(directory)? {
                names.insert(entry?.file_name());
            }
        }
        for name in names {
            let current = root.join(&name);
            let old = before.join(&name);
            let new = after.join(&name);
            if std::fs::symlink_metadata(&current).is_ok() {
                if !same_entry(&current, &old)? && !same_entry(&current, &new)? {
                    return Ok(false);
                }
            } else if std::fs::symlink_metadata(&old).is_ok()
                && !backup
                    .map(|directory| same_entry(&directory.join(&name), &old))
                    .transpose()?
                    .unwrap_or(false)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    /// Retains an exact directory copy independently of the managed checkout's lifetime.
    pub fn capture_directory_checkpoint(&self, source: &Path) -> Result<ContentDigest> {
        let root = self.settings().root.join(".directory-checkpoints");
        std::fs::create_dir_all(&root)?;
        let root = dunce::canonicalize(&root)?;
        if root.starts_with(dunce::canonicalize(source)?) {
            bail!("directory checkpoint storage cannot be inside its source");
        }
        let staging = tempfile::Builder::new()
            .prefix(".capture-")
            .tempdir_in(&root)?;
        let content = staging.path().join("dir");
        std::fs::create_dir(&content)?;
        let digest = ContentDigest::new(format!("sha256:{}", copy_directory(source, &content)?))?;
        let destination = self.directory_checkpoint_path(&digest);
        // Only a complete copy is published. Concurrent identical captures share one immutable tree.
        if !destination.exists() {
            if let Err(error) = std::fs::rename(staging.path(), &destination) {
                if !destination.exists() {
                    return Err(error.into());
                }
            }
        }
        Ok(digest)
    }

    pub(crate) fn copy_directory_checkpoint(
        &self,
        digest: &ContentDigest,
        destination: &Path,
    ) -> Result<()> {
        let root = self.directory_checkpoint_path(digest);
        let metadata =
            std::fs::symlink_metadata(&root).context("directory checkpoint is missing")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("directory checkpoint root is not an immutable directory");
        }
        let content = root.join("dir");
        let metadata = std::fs::symlink_metadata(&content)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("directory checkpoint content is not a directory");
        }
        let actual = copy_directory(&content, destination)?;
        if format!("sha256:{actual}") != digest.as_str() {
            bail!("directory checkpoint content digest mismatch");
        }
        Ok(())
    }

    fn directory_checkpoint_path(&self, digest: &ContentDigest) -> PathBuf {
        self.settings().root.join(".directory-checkpoints").join(
            digest
                .as_str()
                .strip_prefix("sha256:")
                .expect("ContentDigest validates its prefix"),
        )
    }
}

fn same_entry(left: &Path, right: &Path) -> Result<bool> {
    use std::io::Read;
    let metadata = |path| match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    };
    let (Some(a), Some(b)) = (metadata(left)?, metadata(right)?) else {
        return Ok(false);
    };
    if a.file_type() != b.file_type() {
        return Ok(false);
    }
    if a.file_type().is_symlink() {
        return Ok(std::fs::read_link(left)? == std::fs::read_link(right)?);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if a.permissions().mode() != b.permissions().mode() {
            return Ok(false);
        }
    }
    #[cfg(not(unix))]
    if a.permissions().readonly() != b.permissions().readonly() {
        return Ok(false);
    }
    if a.is_dir() {
        let names = |root| -> Result<std::collections::BTreeSet<std::ffi::OsString>> {
            std::fs::read_dir(root)?
                .map(|entry| entry.map(|entry| entry.file_name()).map_err(Into::into))
                .collect()
        };
        let entries = names(left)?;
        if entries != names(right)? {
            return Ok(false);
        }
        for name in entries {
            if !same_entry(&left.join(&name), &right.join(&name))? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    if !a.is_file() || a.len() != b.len() {
        return Ok(false);
    }
    let mut a = std::fs::File::open(left)?;
    let mut b = std::fs::File::open(right)?;
    let mut x = [0; 65536];
    let mut y = [0; 65536];
    loop {
        let read = a.read(&mut x)?;
        b.read_exact(&mut y[..read])?;
        if x[..read] != y[..read] {
            return Ok(false);
        }
        if read == 0 {
            return Ok(true);
        }
    }
}
