use super::write;
use std::fs;
use std::path::Path;

#[test]
fn default_exports_never_overwrite_an_existing_transcript() {
    let root = std::env::temp_dir().join(format!("ash-tui-export-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("ash-transcript.md"), "existing").unwrap();

    let path = write(&root, None, "new").unwrap();

    assert_eq!(path, root.join("ash-transcript-2.md"));
    assert_eq!(fs::read_to_string(path).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(root.join("ash-transcript.md")).unwrap(),
        "existing"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn requested_exports_are_bounded_and_refuse_overwrite() {
    let root = std::env::temp_dir().join(format!("ash-tui-export-path-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();

    assert!(write(&root, Some(Path::new("../outside.md")), "no").is_err());
    let path = write(&root, Some(Path::new("conversation.md")), "yes").unwrap();
    assert!(write(&root, Some(Path::new("conversation.md")), "replace").is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "yes");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn requested_exports_do_not_follow_a_directory_symlink_outside_the_dir() {
    let root = std::env::temp_dir().join(format!("ash-tui-export-symlink-{}", std::process::id()));
    let outside =
        std::env::temp_dir().join(format!("ash-tui-export-outside-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("outside")).unwrap();

    assert!(write(&root, Some(Path::new("outside/escaped.md")), "no").is_err());
    assert!(!outside.join("escaped.md").exists());

    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}
