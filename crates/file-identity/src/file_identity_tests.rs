use super::FileInformation;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
const TEST_ROOT_ENVIRONMENT_VARIABLE: &str = "ASH_FILE_IDENTITY_TEST_ROOT";

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os(TEST_ROOT_ENVIRONMENT_VARIABLE)
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "ash-file-identity-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap_or_else(|error| {
            panic!(
                "failed to create a file identity test directory under {}: {error}",
                root.display()
            )
        });
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn compares_path_and_multiple_handle_observations_for_the_same_file() {
    let directory = TestDirectory::new();
    let path = directory.path().join("same-文件.txt");
    fs::write(&path, "same").unwrap();

    let from_path = FileInformation::from_path(&path).unwrap();
    let first_handle = FileInformation::from_file(&File::open(&path).unwrap()).unwrap();
    let second_handle = FileInformation::from_file(&File::open(&path).unwrap()).unwrap();

    assert!(from_path.same_file_as(first_handle));
    assert!(first_handle.same_file_as(second_handle));
    assert!(!from_path.has_multiple_links());
}

#[test]
fn distinguishes_distinct_files_even_when_their_contents_match() {
    let directory = TestDirectory::new();
    let first = directory.path().join("first.txt");
    let second = directory.path().join("second.txt");
    let third = directory.path().join("third.txt");
    fs::write(&first, "identical contents").unwrap();
    fs::copy(&first, &second).unwrap();
    fs::write(&third, "different contents").unwrap();

    let first_information = FileInformation::from_path(&first).unwrap();
    let second_information = FileInformation::from_path(&second).unwrap();
    let third_information = FileInformation::from_path(&third).unwrap();

    assert!(!first_information.same_file_as(second_information));
    assert!(!first_information.same_file_as(third_information));
    assert!(!second_information.same_file_as(third_information));
}

#[test]
fn content_changes_do_not_change_filesystem_identity() {
    let directory = TestDirectory::new();
    let path = directory.path().join("mutable.txt");
    fs::write(&path, "before").unwrap();
    let before = FileInformation::from_path(&path).unwrap();

    fs::write(&path, "after with a different length").unwrap();
    let after = FileInformation::from_path(&path).unwrap();

    assert!(before.same_file_as(after));
}

#[test]
fn renaming_a_file_preserves_its_identity() {
    let directory = TestDirectory::new();
    let original = directory.path().join("original.txt");
    let renamed = directory.path().join("renamed.txt");
    fs::write(&original, "rename me").unwrap();
    let before = FileInformation::from_path(&original).unwrap();

    fs::rename(&original, &renamed).unwrap();
    let after = FileInformation::from_path(&renamed).unwrap();

    assert!(before.same_file_as(after));
}

#[test]
fn replacing_a_path_changes_its_identity() {
    let directory = TestDirectory::new();
    let path = directory.path().join("current.txt");
    let displaced = directory.path().join("displaced.txt");
    let replacement = directory.path().join("replacement.txt");
    fs::write(&path, "old").unwrap();
    fs::write(&replacement, "new").unwrap();
    let before = FileInformation::from_path(&path).unwrap();

    fs::rename(&path, &displaced).unwrap();
    fs::rename(&replacement, &path).unwrap();
    let displaced_information = FileInformation::from_path(&displaced).unwrap();
    let replacement_information = FileInformation::from_path(&path).unwrap();

    assert!(before.same_file_as(displaced_information));
    assert!(!before.same_file_as(replacement_information));
}

#[test]
fn reports_hard_links_and_observes_link_removal_when_supported() {
    let directory = TestDirectory::new();
    let first = directory.path().join("first.txt");
    let linked = directory.path().join("linked.txt");
    fs::write(&first, "linked").unwrap();
    if !link_capability_available(fs::hard_link(&first, &linked), "hard links") {
        return;
    }

    let first_information = FileInformation::from_path(&first).unwrap();
    let linked_information = FileInformation::from_path(&linked).unwrap();
    assert!(first_information.same_file_as(linked_information));
    assert!(first_information.has_multiple_links());
    assert!(linked_information.has_multiple_links());

    fs::remove_file(&linked).unwrap();
    let after_removal = FileInformation::from_path(&first).unwrap();
    assert!(first_information.same_file_as(after_removal));
    assert!(!after_removal.has_multiple_links());
}

#[test]
fn from_path_follows_file_symlinks_when_supported() {
    let directory = TestDirectory::new();
    let target = directory.path().join("target.txt");
    let link = directory.path().join("link.txt");
    fs::write(&target, "target").unwrap();
    if !link_capability_available(create_file_symlink(&target, &link), "file symlinks") {
        return;
    }

    let target_information = FileInformation::from_path(&target).unwrap();
    let link_information = FileInformation::from_path(&link).unwrap();

    assert!(target_information.same_file_as(link_information));
}

#[test]
fn missing_paths_return_not_found() {
    let directory = TestDirectory::new();
    let error = FileInformation::from_path(directory.path().join("missing.txt")).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[test]
fn compares_the_volume_component_of_identity() {
    let object = [0x5a; 16];
    let first_volume = FileInformation::new(7, object, 1);
    let second_volume = FileInformation::new(8, object, 1);

    assert!(!first_volume.same_file_as(second_volume));
}

#[test]
fn compares_every_bit_of_the_128_bit_object_identity() {
    let baseline = FileInformation::new(7, [0; 16], 1);

    for byte_index in 0..16 {
        for bit_index in 0..8 {
            let mut object = [0; 16];
            object[byte_index] = 1 << bit_index;
            let changed = FileInformation::new(7, object, 1);
            assert!(
                !baseline.same_file_as(changed),
                "identity ignored byte {byte_index}, bit {bit_index}"
            );
        }
    }
}

#[test]
fn classifies_link_count_boundaries() {
    let object = [0; 16];

    for links in [0, 1] {
        assert!(!FileInformation::new(7, object, links).has_multiple_links());
    }
    for links in [2, u64::MAX] {
        assert!(FileInformation::new(7, object, links).has_multiple_links());
    }
}

fn link_capability_available(result: io::Result<()>, capability: &str) -> bool {
    match result {
        Ok(()) => true,
        Err(error) if link_capability_is_unavailable(&error) => {
            eprintln!("skipping {capability} assertion on this filesystem: {error}");
            false
        }
        Err(error) => panic!("failed to create {capability} fixture: {error}"),
    }
}

fn link_capability_is_unavailable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
    ) || platform_link_capability_is_unavailable(error)
}

#[cfg(windows)]
fn platform_link_capability_is_unavailable(error: &io::Error) -> bool {
    // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, and ERROR_PRIVILEGE_NOT_HELD are returned by
    // Windows filesystems or policies that cannot create the requested link type. Rust currently
    // classifies at least ERROR_PRIVILEGE_NOT_HELD as Uncategorized rather than PermissionDenied.
    matches!(error.raw_os_error(), Some(1 | 50 | 1314))
}

#[cfg(not(windows))]
fn platform_link_capability_is_unavailable(_error: &io::Error) -> bool {
    false
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}
