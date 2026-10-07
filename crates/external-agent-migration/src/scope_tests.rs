use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::repository_root_for_cwd;

fn touch(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, "").unwrap();
}

#[test]
fn empty_cwd_yields_no_root() {
    assert_eq!(repository_root_for_cwd(Path::new("")).unwrap(), None);
}

#[test]
fn missing_cwd_yields_no_root() {
    let temp = TempDir::new().unwrap();
    let missing = temp.path().join("missing");
    assert_eq!(repository_root_for_cwd(&missing).unwrap(), None);
}

#[test]
fn file_cwd_resolves_to_parent_directory() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("notes.md");
    touch(&file);
    assert_eq!(
        repository_root_for_cwd(&file).unwrap(),
        Some(temp.path().to_path_buf())
    );
}

#[test]
fn walks_up_to_git_root() {
    let temp = TempDir::new().unwrap();
    let nested = temp.path().join("crates").join("deep");
    fs::create_dir_all(&nested).unwrap();
    touch(&temp.path().join(".git").join("HEAD"));

    assert_eq!(
        repository_root_for_cwd(&nested).unwrap(),
        Some(temp.path().to_path_buf())
    );
}

#[test]
fn directory_without_git_resolves_as_own_root() {
    let temp = TempDir::new().unwrap();
    let nested = temp.path().join("plain");
    fs::create_dir_all(&nested).unwrap();

    assert_eq!(repository_root_for_cwd(&nested).unwrap(), Some(nested));
}

#[test]
fn git_file_worktree_counts_as_repository_root() {
    let temp = TempDir::new().unwrap();
    touch(&temp.path().join(".git"));

    assert_eq!(
        repository_root_for_cwd(temp.path()).unwrap(),
        Some(temp.path().to_path_buf())
    );
}
