use super::ExtensionPackageSnapshot;
use super::PackageSnapshotError;
use super::PackageSnapshotLimits;
use super::read_bounded_file_after_inspection;
use ash_file_identity::FileInformation;
use std::fs;

#[test]
fn rejects_hard_linked_package_files() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let package = directory.path().join("package");
    fs::create_dir(&package).expect("package directory");
    let outside = directory.path().join("outside.json");
    fs::write(&outside, b"outside").expect("outside file");
    fs::hard_link(&outside, package.join("linked.json")).expect("hard link");

    assert_eq!(
        ExtensionPackageSnapshot::load(
            &package,
            PackageSnapshotLimits {
                max_total_bytes: usize::MAX,
            },
        )
        .map(|_| ()),
        Err(PackageSnapshotError::UnsafeEntry)
    );
}

#[test]
fn rejects_same_length_file_replacement_after_inspection() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("resource.json");
    fs::write(&path, b"old-bytes").expect("old file");
    let inspected = FileInformation::from_path(&path).expect("inspected identity");
    let canonical = fs::canonicalize(&path).expect("canonical path");
    let root = fs::canonicalize(directory.path()).expect("canonical root");
    let displaced = directory.path().join("displaced.json");
    fs::rename(&path, &displaced).expect("displace old file");
    fs::write(&path, b"new-bytes").expect("replacement file");

    assert_eq!(
        read_bounded_file_after_inspection(&root, &path, 9, inspected, &canonical),
        Err(PackageSnapshotError::Unavailable)
    );
}

#[test]
fn applies_the_remaining_catalog_byte_budget_before_reading() {
    let directory = tempfile::tempdir().expect("temporary directory");
    fs::write(directory.path().join("resource.json"), b"resource").expect("resource");

    assert_eq!(
        ExtensionPackageSnapshot::load(
            directory.path(),
            PackageSnapshotLimits { max_total_bytes: 1 },
        )
        .map(|_| ()),
        Err(PackageSnapshotError::CatalogTooLarge)
    );
}
