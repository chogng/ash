use super::join_descendant;
use std::io;
use std::path::Path;

#[test]
fn descendants_preserve_names_and_reject_every_parent_component() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for relative in ["file.txt", "子目录/a #%.txt", "./file", "."] {
        assert_eq!(
            join_descendant(root, Path::new(relative)).unwrap(),
            root.join(relative)
        );
    }
    for relative in ["", "..", "../sibling", "child/../file"] {
        assert_eq!(
            join_descendant(root, Path::new(relative))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    assert!(join_descendant(root, root).is_err());
    assert!(join_descendant(Path::new("relative-root"), Path::new("child")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_roots_drives_unc_and_device_paths_cannot_replace_the_base() {
    let root = Path::new(r"C:\workspace");
    for path in [
        r"\child",
        r"C:child",
        r"C:\child",
        r"\\server\share\child",
        r"\\?\C:\child",
        r"a\..\b",
    ] {
        assert!(join_descendant(root, Path::new(path)).is_err(), "{path}");
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_names_are_retained_losslessly() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let relative = Path::new(OsStr::from_bytes(b"child/\xff"));
    let result = join_descendant(Path::new("/root"), relative).unwrap();
    assert_eq!(result.as_os_str().as_bytes(), b"/root/child/\xff");
}
