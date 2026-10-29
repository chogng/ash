use crate::RemovalMode;
use crate::RemovalReport;
use crate::absolute_path;
use crate::invalid;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::io;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

fn redirected(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

pub(crate) fn ensure_directory(path: &Path) -> io::Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            ensure_directory(parent)?;
        }
        fs::create_dir(path)?;
    }
    real_directory(path).map(|_| ())
}

pub(crate) fn real_directory(path: &Path) -> io::Result<PathBuf> {
    // Check all ancestors: a junction in a parent is just as dangerous as one at
    // the deletion root. Never canonicalize away evidence before this check.
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        #[cfg(target_os = "macos")]
        if matches!(ancestor.to_str(), Some("/var" | "/tmp")) {
            // macOS owns these fixed aliases; application-controlled links at
            // every other component remain forbidden, including below /var.
            let expected = Path::new("private").join(ancestor.file_name().expect("system alias"));
            if metadata.file_type().is_symlink() && fs::read_link(ancestor)? == expected {
                continue;
            }
        }
        if redirected(&metadata) || !metadata.is_dir() {
            return Err(invalid("directory contains a link or reparse point"));
        }
    }
    dunce::canonicalize(path)
}

pub(crate) fn require_regular_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !redirected(&metadata) && metadata.is_file() => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(invalid("expected a regular owned file")),
        Err(error) => Err(error),
    }
}

pub(crate) fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    read_bounded_with_limit(path, 1024 * 1024)
}

pub(crate) fn read_bounded_with_limit(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    require_regular_or_missing(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("ownership record is too large"));
    }
    Ok(bytes)
}

pub(crate) fn file_hash(path: &Path) -> io::Result<String> {
    require_regular_or_missing(path)?;
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// Removes only an explicitly owned tree. Repositories, worktrees, links and
/// unknown special files make the entire tree ineligible, before any deletion.
pub fn remove_owned_tree(path: &Path, report: &mut RemovalReport) -> io::Result<()> {
    if !path.try_exists()? {
        return Ok(());
    }
    if !eligible(path)? {
        report.retained.push(path.to_owned());
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        real_directory(parent)?;
    }
    let result = if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => report.removed.push(path.to_owned()),
        Err(error) => report.failures.push(format!("{}: {error}", path.display())),
    }
    Ok(())
}

pub(crate) fn eligible(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    if redirected(&metadata) {
        return Ok(false);
    }
    if metadata.is_file() {
        return Ok(true);
    }
    if !metadata.is_dir() {
        return Ok(false);
    }
    // A bare Git repository has no .git entry, but is equally user-owned.
    if path.join("HEAD").is_file() && path.join("objects").is_dir() && path.join("refs").is_dir() {
        return Ok(false);
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        if [
            ".git",
            ".hg",
            ".svn",
            "worktrees",
            "workspaces",
            "repositories",
        ]
        .iter()
        .any(|protected| name.to_string_lossy().eq_ignore_ascii_case(protected))
            || !eligible(&entry.path())?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn clean_profile(
    root: &Path,
    mode: RemovalMode,
    report: &mut RemovalReport,
) -> io::Result<()> {
    clean_selected(
        root,
        mode,
        &[
            "cache",
            "app-server-packages",
            "dictation-models",
            "logs",
            "run",
            "leases",
        ],
        &[
            "config.toml",
            "settings.json",
            "configuration.json",
            "keybindings.json",
            "keyboard-layout.json",
            "state.sqlite3",
            "state.sqlite3-wal",
            "state.sqlite3-shm",
            "connectors.sqlite3",
            "connectors.sqlite3-wal",
            "connectors.sqlite3-shm",
            "secrets",
            "attachments",
            "plugins",
            "marketplace-manager",
            "themes",
            "extensions",
            "extensions-manager",
            "editor-extension-policy.json",
            "generated-images",
            "mcp-oauth-locks",
            "chatgpt-plan.lock",
            "xai.lock",
        ],
        report,
    )
}

pub(crate) fn clean_user_data(
    root: &Path,
    mode: RemovalMode,
    report: &mut RemovalReport,
) -> io::Result<()> {
    clean_selected(
        root,
        mode,
        &[
            "updates",
            "logs",
            "crashes",
            "Code Cache",
            "Cache",
            "GPUCache",
            "DawnGraphiteCache",
            "DawnWebGPUCache",
        ],
        &[
            "session-data",
            "state.json",
            "workbench-state.json",
            "Local State",
            "Preferences",
            "Network",
        ],
        report,
    )
}

fn clean_selected(
    root: &Path,
    mode: RemovalMode,
    cache: &[&str],
    data: &[&str],
    report: &mut RemovalReport,
) -> io::Result<()> {
    if !root.try_exists()? {
        return Ok(());
    }
    absolute_path(root)?;
    real_directory(root)?;
    if root.join(".git").exists() {
        report.retained.push(root.to_owned());
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if cache.contains(&name.as_ref())
            || (mode == RemovalMode::Purge && data.contains(&name.as_ref()))
        {
            remove_owned_tree(&entry.path(), report)?;
        } else {
            report.retained.push(entry.path());
        }
    }
    if fs::read_dir(root)?.next().is_none() {
        fs::remove_dir(root)?;
    }
    Ok(())
}
