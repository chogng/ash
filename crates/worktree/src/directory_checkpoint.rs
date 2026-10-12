use crate::WorktreeManager;
use crate::manager::copy_directory;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use ash_protocol::ContentDigest;
use std::path::Path;
use std::path::PathBuf;

impl WorktreeManager {
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
        let actual = copy_directory(&root.join("dir"), destination)?;
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
