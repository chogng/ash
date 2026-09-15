use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn returns_the_nearest_ancestor_with_any_marker() {
    let dir = TestDirectory::new();
    let project = dir.path.join("project");
    let nested = project.join("src/bin");
    fs::create_dir_all(&nested).unwrap();
    fs::write(dir.path.join(".git"), "").unwrap();
    fs::write(project.join(".ash"), "").unwrap();

    let found = find_nearest_ancestor_with_markers(
        &nested,
        &[".git", ".ash"],
        FindUpErrorPolicy::Propagate,
    )
    .unwrap();

    assert_eq!(found, Some(project));
}

#[test]
fn accepts_a_nested_relative_marker_path() {
    let dir = TestDirectory::new();
    let nested = dir.path.join("src/bin");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(dir.path.join(".config/ash")).unwrap();

    let found =
        find_nearest_ancestor_with_markers(&nested, &[".config/ash"], FindUpErrorPolicy::Propagate)
            .unwrap();

    assert_eq!(found, Some(dir.path.clone()));
}

#[test]
fn returns_none_when_no_marker_exists_or_none_are_requested() {
    let dir = TestDirectory::new();
    let nested = dir.path.join("src");
    fs::create_dir_all(&nested).unwrap();

    assert_eq!(
        find_nearest_ancestor_with_markers(&nested, &[".git"], FindUpErrorPolicy::Propagate,)
            .unwrap(),
        None
    );
    assert_eq!(
        find_nearest_ancestor_with_markers(&nested, &[] as &[&str], FindUpErrorPolicy::Propagate,)
            .unwrap(),
        None
    );
}

#[test]
fn rejects_markers_that_can_escape_an_ancestor() {
    let dir = TestDirectory::new();

    let parent_error =
        find_nearest_ancestor_with_markers(&dir.path, &["../.git"], FindUpErrorPolicy::Ignore)
            .unwrap_err();
    let absolute_error = find_nearest_ancestor_with_markers(
        &dir.path,
        &[dir.path.as_path()],
        FindUpErrorPolicy::Ignore,
    )
    .unwrap_err();
    let empty_error =
        find_nearest_ancestor_with_markers(&dir.path, &[""], FindUpErrorPolicy::Ignore)
            .unwrap_err();

    assert_eq!(parent_error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(absolute_error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(empty_error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn rejects_a_relative_start_path() {
    let error = find_nearest_ancestor_with_markers(
        Path::new("project/src"),
        &[".git"],
        FindUpErrorPolicy::Ignore,
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn propagates_the_first_non_not_found_error_in_search_order() {
    let dir = TestDirectory::new();
    let nested = dir.path.join("project/src");
    let denied = nested.join(".git");

    let error = find_nearest_ancestor_with_probe(
        &nested,
        &[".git", ".ash"],
        FindUpErrorPolicy::Propagate,
        |candidate| {
            if candidate == denied {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "missing"))
            }
        },
    )
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
}

#[test]
fn ignore_policy_continues_after_metadata_errors() {
    let dir = TestDirectory::new();
    let project = dir.path.join("project");
    let nested = project.join("src");
    let denied = nested.join(".git");
    let match_path = project.join(".git");

    let found = find_nearest_ancestor_with_probe(
        &nested,
        &[".git"],
        FindUpErrorPolicy::Ignore,
        |candidate| {
            if candidate == denied {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            } else if candidate == match_path {
                Ok(())
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "missing"))
            }
        },
    )
    .unwrap();

    assert_eq!(found, Some(project));
}

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-find-up-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
