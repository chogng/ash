//! Atomic Codex-compatible thread ownership records.

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use serde::Deserialize;
use serde::Serialize;
use tempfile::NamedTempFile;

const OWNER_FILENAME: &str = "codex-thread.json";
const OWNER_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerRecord {
    version: u8,
    owner_thread_id: Option<String>,
}

pub(crate) fn owner(git_dir: &Path) -> Result<Option<String>> {
    let path = git_dir.join(OWNER_FILENAME);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("cannot read worktree owner at {}", path.display()));
        }
    };
    let record: OwnerRecord = serde_json::from_slice(&contents)
        .with_context(|| format!("invalid worktree owner at {}", path.display()))?;
    if record.version != OWNER_VERSION
        || record
            .owner_thread_id
            .as_ref()
            .is_some_and(String::is_empty)
    {
        bail!("invalid worktree owner at {}", path.display());
    }
    Ok(record.owner_thread_id)
}

pub(crate) fn bind_thread(git_dir: &Path, thread_id: &str) -> Result<()> {
    if thread_id.is_empty() {
        bail!("worktree owner thread ID cannot be empty");
    }
    let path = git_dir.join(OWNER_FILENAME);
    let lock_path = git_dir.join(format!("{OWNER_FILENAME}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("cannot open worktree owner lock at {}", lock_path.display()))?;
    fs2::FileExt::lock_exclusive(&lock)
        .with_context(|| format!("cannot lock worktree owner at {}", path.display()))?;

    if let Some(existing) = owner(git_dir)? {
        if existing == thread_id {
            return Ok(());
        }
        bail!("worktree already belongs to thread {existing}");
    }

    let replaces_pending_record = path.exists();
    let mut temporary = NamedTempFile::new_in(git_dir)
        .with_context(|| format!("cannot create worktree metadata in {}", git_dir.display()))?;
    serde_json::to_writer(
        &mut temporary,
        &OwnerRecord {
            version: OWNER_VERSION,
            owner_thread_id: Some(thread_id.to_owned()),
        },
    )?;
    temporary.flush()?;
    if replaces_pending_record {
        return temporary
            .persist(&path)
            .map(|_| ())
            .map_err(|error| error.error)
            .with_context(|| {
                format!(
                    "cannot replace pending worktree owner at {}",
                    path.display()
                )
            });
    }
    match temporary.persist_noclobber(&path) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if owner(git_dir)?.as_deref() == Some(thread_id) {
                Ok(())
            } else {
                bail!("worktree was concurrently assigned to another thread")
            }
        }
        Err(error) => Err(error.error)
            .with_context(|| format!("cannot write worktree owner at {}", path.display())),
    }
}
