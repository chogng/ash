use std::path::Path;
use std::path::PathBuf;

use crate::GitClient;
use crate::GitError;
use crate::GitResult;

/// Physical layout of an opened Git working tree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitRepositoryKind {
    Standard,
    LinkedWorktree,
}

/// Validated paths identifying one Git working tree and its metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRepository {
    worktree_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    kind: GitRepositoryKind,
}

impl GitRepository {
    pub fn worktree_root(&self) -> &Path {
        &self.worktree_root
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    pub fn kind(&self) -> GitRepositoryKind {
        self.kind
    }
}

impl GitClient {
    /// Opens the working tree containing `start` and resolves its Git metadata paths.
    pub async fn open_repository(&self, start: &Path) -> GitResult<GitRepository> {
        let cwd = existing_directory(start)?;
        let output = self.discover_repository(cwd).await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("not a git repository")
                || stderr.contains("this operation must be run in a work tree")
            {
                return Err(GitError::NotAWorkingTree {
                    path: start.to_path_buf(),
                });
            }
            return Err(GitError::CommandFailed {
                command: output.command,
                exit_code: output.status.code(),
                stderr: stderr.trim().to_string(),
            });
        }

        let stdout = String::from_utf8(output.stdout).map_err(|_| {
            GitError::invalid_output(&output.command, "repository paths are not UTF-8")
        })?;
        let mut lines = stdout.lines();
        let worktree_root = required_path(lines.next(), &output.command, "working tree root")?;
        let git_dir = required_path(lines.next(), &output.command, "git directory")?;
        let common_dir = required_path(lines.next(), &output.command, "common Git directory")?;
        if lines.next().is_some() {
            return Err(GitError::invalid_output(
                output.command,
                "repository discovery returned more than three paths",
            ));
        }
        let kind = if git_dir == common_dir {
            GitRepositoryKind::Standard
        } else {
            GitRepositoryKind::LinkedWorktree
        };
        Ok(GitRepository {
            worktree_root,
            git_dir,
            common_dir,
            kind,
        })
    }
}

fn existing_directory(start: &Path) -> GitResult<PathBuf> {
    let metadata = std::fs::metadata(start).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GitError::InvalidStartPath {
                path: start.to_path_buf(),
            }
        } else {
            GitError::io("inspect Git start path", error)
        }
    })?;
    let directory = if metadata.is_dir() {
        start
    } else {
        start.parent().ok_or_else(|| GitError::InvalidStartPath {
            path: start.to_path_buf(),
        })?
    };
    dunce::canonicalize(directory)
        .map_err(|source| GitError::io("resolve Git start directory", source))
}

fn required_path(value: Option<&str>, command: &str, label: &str) -> GitResult<PathBuf> {
    let value = value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GitError::invalid_output(command, format!("missing {label}")))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(GitError::invalid_output(
            command,
            format!("{label} was not absolute"),
        ));
    }
    Ok(normalize_native_path(path))
}

fn normalize_native_path(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        dunce::simplified(&path).to_path_buf()
    } else {
        path
    }
}

#[cfg(test)]
#[path = "repository_tests.rs"]
mod tests;
