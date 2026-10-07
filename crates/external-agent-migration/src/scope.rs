use std::io;
use std::path::Path;
use std::path::PathBuf;

/// Resolves one working directory to the repository root that owns it.
///
/// Missing directories yield no root. Files resolve to their parent. Directories without an
/// enclosing `.git` entry resolve as the directory itself so plain project folders still apply.
/// Callers combine the result with an [`crate::ImportScope::Project`] location.
pub fn repository_root_for_cwd(cwd: &Path) -> io::Result<Option<PathBuf>> {
    if cwd.as_os_str().is_empty() {
        return Ok(None);
    }

    let mut current = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        std::env::current_dir()?.join(cwd)
    };

    if !current.exists() {
        return Ok(None);
    }

    if current.is_file() {
        let Some(parent) = current.parent() else {
            return Ok(None);
        };
        current = parent.to_path_buf();
    }

    let fallback = current.clone();
    loop {
        let git_path = current.join(".git");
        if git_path.is_dir() || git_path.is_file() {
            return Ok(Some(current));
        }
        if !current.pop() {
            break;
        }
    }

    Ok(Some(fallback))
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
