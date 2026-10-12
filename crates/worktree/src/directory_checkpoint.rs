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
    _staging: Option<tempfile::TempDir>,
    original: Vec<std::ffi::OsString>,
    installed: Vec<std::ffi::OsString>,
    committed: bool,
}

impl DirectoryRestoration {
    pub fn commit(&mut self) { self.committed = true; }

    pub fn rollback(&mut self) -> Result<()> {
        while let Some(name) = self.installed.last() {
            let path = self.root.join(name);
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() { std::fs::remove_dir_all(path)?; }
            else { std::fs::remove_file(path)?; }
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
                if let Some(staging) = self._staging.take() { let _ = staging.keep(); }
                eprintln!("cannot roll back directory restoration; backup retained: {error}");
            }
        }
    }
}

impl WorktreeManager {
    /// Installs a retained tree without replacing the root inode held by editors and terminals.
    pub fn restore_directory_checkpoint(&self, root: &Path, digest: &ContentDigest) -> Result<DirectoryRestoration> {
        let parent = root.parent().context("managed directory has no parent")?;
        let staging = tempfile::Builder::new().prefix(".history-files-").tempdir_in(parent)?;
        let target = staging.path().join("target");
        std::fs::create_dir(&target)?;
        self.copy_directory_checkpoint(digest, &target)?;
        let backup = staging.path().join("previous");
        std::fs::create_dir(&backup)?;
        let mut restoration = DirectoryRestoration { root: root.to_path_buf(), backup, _staging: Some(staging), original: Vec::new(), installed: Vec::new(), committed: false };
        for entry in std::fs::read_dir(root)? {
            let name = entry?.file_name();
            std::fs::rename(root.join(&name), restoration.backup.join(&name))?;
            restoration.original.push(name);
        }
        for entry in std::fs::read_dir(&target)? {
            let name = entry?.file_name();
            std::fs::rename(target.join(&name), root.join(&name))?;
            restoration.installed.push(name);
        }
        Ok(restoration)
    }
    /// Retains an exact directory copy independently of the managed checkout's lifetime.
    pub fn capture_directory_checkpoint(&self, source: &Path) -> Result<ContentDigest> {
        let root = self.settings().root.join(".directory-checkpoints");
        std::fs::create_dir_all(&root)?;
        let root = dunce::canonicalize(&root)?;
        if root.starts_with(dunce::canonicalize(source)?) {
            bail!("directory checkpoint storage cannot be inside its source");
        }
        let staging = tempfile::Builder::new().prefix(".capture-").tempdir_in(&root)?;
        let content = staging.path().join("dir");
        std::fs::create_dir(&content)?;
        let digest = ContentDigest::new(format!("sha256:{}", copy_directory(source, &content)?))?;
        let destination = self.directory_checkpoint_path(&digest);
        // Only a complete copy is published. Concurrent identical captures share one immutable tree.
        if !destination.exists() {
            if let Err(error) = std::fs::rename(staging.path(), &destination) {
                if !destination.exists() { return Err(error.into()); }
            }
        }
        Ok(digest)
    }

    pub(crate) fn copy_directory_checkpoint(&self, digest: &ContentDigest, destination: &Path) -> Result<()> {
        let root = self.directory_checkpoint_path(digest);
        let metadata = std::fs::symlink_metadata(&root).context("directory checkpoint is missing")?;
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
        self.settings().root.join(".directory-checkpoints")
            .join(digest.as_str().strip_prefix("sha256:").expect("ContentDigest validates its prefix"))
    }
}
