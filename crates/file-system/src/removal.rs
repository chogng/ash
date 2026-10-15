//! Conditional file removal for hosts that have already authorized the directory.
use ash_file_access::Dir;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::io;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// Review token covers a leaf's bytes or link target, without following the final symlink.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRemoval {
    pub path: PathBuf,
    pub revision: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileRemovalMode {
    Trash,
    Permanent,
}

/// Returns exact revisions for a bounded list of regular files or symlinks.
/// Directory deletion is deliberately a different operation.
pub fn review_file_removals(dir: &Dir, paths: &[PathBuf]) -> io::Result<Vec<FileRemoval>> {
    if paths.is_empty() || paths.len() > 5000 {
        return Err(io::Error::other("file removal requires 1 to 5000 paths"));
    }
    let mut unique = BTreeSet::new();
    paths
        .iter()
        .map(|path| {
            if !unique.insert(path.clone()) {
                return Err(io::Error::other("duplicate removal path"));
            }
            let relative = resolve_leaf(dir, path)?;
            Ok(FileRemoval {
                path: path.clone(),
                revision: revision(dir, &relative)?,
            })
        })
        .collect()
}

/// Rechecks every reviewed leaf under the directory's write lock. Files are isolated by
/// handle-relative renames before invoking the OS recycle bin, so a replaced source path
/// cannot redirect removal to unreviewed content. Failures retain recoverable files and
/// never degrade a requested recycle operation to permanent deletion.
pub fn remove_reviewed_files(
    dir: &Dir,
    entries: &[FileRemoval],
    mode: FileRemovalMode,
) -> io::Result<()> {
    remove_using(dir, entries, |staging| match mode {
        FileRemovalMode::Permanent => std::fs::remove_dir_all(staging),
        FileRemovalMode::Trash => {
            let context = trash::TrashContext::new();
            #[cfg(target_os = "macos")]
            let context = {
                use trash::macos::DeleteMethod;
                use trash::macos::TrashContextExtMacos;
                let mut context = context;
                // NSFileManager avoids asking the user for Finder automation permission.
                context.set_delete_method(DeleteMethod::NsFileManager);
                context
            };
            context.delete(staging).map_err(io::Error::other)
        }
    })
}

fn remove_using(
    dir: &Dir,
    entries: &[FileRemoval],
    remove: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let _lock = dir
        .directory()
        .lock_writes()
        .map_err(|_| io::Error::other("directory write lock failed"))?;
    let reviewed = review_file_removals(
        dir,
        &entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>(),
    )?;
    if reviewed != entries {
        return Err(io::Error::other("files changed since removal was reviewed"));
    }
    let mut nonce = [0u8; 32];
    rand::fill(&mut nonce);
    let staging_name: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let staging = PathBuf::from(format!(".ash-trash-{staging_name}"));
    let handle = dir.directory().handle();
    handle.create_dir(&staging)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| {
        for (index, entry) in entries.iter().enumerate() {
            let source = resolve_leaf(dir, &entry.path)?;
            if revision(dir, &source)? != entry.revision {
                return Err(io::Error::other("file changed during removal"));
            }
            let target = staging.join(index.to_string()).join(
                entry
                    .path
                    .file_name()
                    .ok_or_else(|| io::Error::other("missing filename"))?,
            );
            handle.create_dir(target.parent().expect("staging child has a parent"))?;
            handle.rename(&source, handle, &target)?;
            moved.push((source, target.clone()));
            if revision(dir, &target)? != entry.revision {
                return Err(io::Error::other("file changed during removal"));
            }
        }
        dir.directory().ensure_current().map_err(io::Error::other)?;
        remove(&dir.canonical_path().join(&staging))
    })();
    if let Err(error) = result {
        // Restore only absent sources; never replace a concurrent writer's new file.
        for (source, target) in moved.iter().rev() {
            if handle
                .symlink_metadata(source)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                && handle.symlink_metadata(target).is_ok()
            {
                let _ = handle.rename(target, handle, source);
            }
        }
        // Empty staging directories are harmless; non-empty ones are recovery artifacts.
        for (_, target) in &moved {
            if let Some(parent) = target.parent() {
                let _ = handle.remove_dir(parent);
            }
        }
        let _ = handle.remove_dir(&staging);
        return Err(io::Error::other(format!(
            "{error}; any unrecovered files remain in {}",
            dir.canonical_path().join(staging).display()
        )));
    }
    Ok(())
}

fn resolve_leaf(dir: &Dir, path: &Path) -> io::Result<PathBuf> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(io::Error::other(
            "file removal requires a relative file path",
        ));
    }
    dir.directory().ensure_current().map_err(io::Error::other)?;
    let parent = dir
        .resolve_existing(
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
        .map_err(io::Error::other)?;
    let relative = parent
        .strip_prefix(dir.canonical_path())
        .map_err(io::Error::other)?
        .join(
            path.file_name()
                .ok_or_else(|| io::Error::other("missing filename"))?,
        );
    Ok(relative)
}

fn revision(dir: &Dir, relative: &Path) -> io::Result<String> {
    let handle = dir.directory().handle();
    let metadata = handle.symlink_metadata(relative)?;
    let mut hash = Sha256::new();
    if metadata.is_symlink() {
        hash.update(b"symlink\0");
        let target = handle.read_link_contents(relative)?;
        hash.update(target.as_os_str().as_encoded_bytes());
    } else if metadata.is_file() {
        hash.update(b"file\0");
        let mut file = handle.open(relative)?;
        // A link introduced between lstat and open must not change the reviewed kind.
        if handle.symlink_metadata(relative)?.is_symlink() {
            return Err(io::Error::other("file changed during review"));
        }
        let mut buffer = [0u8; 65536];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
    } else {
        return Err(io::Error::other(
            "only regular files and symbolic links can be removed",
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
#[path = "removal_tests.rs"]
mod tests;
