use super::expand_roots;
use ash_sandboxing::FileSystemAccess;

#[test]
fn host_read_grants_keep_only_the_recursive_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    std::fs::create_dir(root.join("child")).unwrap();
    std::fs::write(root.join("child/input"), "input").unwrap();
    for access in [FileSystemAccess::ReadOnly, FileSystemAccess::DirectoryWrite] {
        let paths = expand_roots([root.clone()], access, &[]).unwrap();
        assert_eq!(paths, vec![root.to_str().unwrap()]);
    }
}

#[test]
fn host_write_grants_expand_immediate_children_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let directory = root.join("child");
    let file = root.join("input");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(&file, "input").unwrap();
    std::fs::write(directory.join("nested"), "nested").unwrap();
    let mut paths = expand_roots([root.clone()], FileSystemAccess::FullAccess, &[]).unwrap();
    let mut expected = [root, directory, file]
        .map(|path| path.into_os_string().into_string().unwrap())
        .to_vec();
    paths.sort();
    expected.sort();
    assert_eq!(paths, expected);
}

#[test]
fn an_existing_write_grant_keeps_host_read_access_to_its_children() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let child = root.join("child");
    std::fs::create_dir(&child).unwrap();
    let paths = expand_roots(
        [root.clone()],
        FileSystemAccess::DirectoryWrite,
        &[root.to_str().unwrap().into()],
    )
    .unwrap();
    assert!(paths.contains(&child.to_str().unwrap().into()));
}
