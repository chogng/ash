use super::*;
use ash_app_server_protocol::protocol::ide::IdeActiveFile;
use ash_app_server_protocol::protocol::ide::IdeSelection;

#[test]
fn ide_context_rejects_escaped_paths_invalid_ranges_and_large_selections() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("lib.rs");
    std::fs::write(&file, "disk").unwrap();
    let roots = vec![
        root.path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    ];
    let mut context = IdeContext {
        active_file: Some(IdeActiveFile {
            path: file.to_string_lossy().into_owned(),
            version: 1,
            selections: vec![IdeSelection {
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 2,
                text: "x".into(),
                truncated: false,
            }],
        }),
        open_tabs: vec![],
        dirty_files: vec![],
    };
    validate_context(&context, &roots).unwrap();
    context.active_file.as_mut().unwrap().selections[0].end_column = 0;
    assert!(validate_context(&context, &roots).is_err());
    context.active_file.as_mut().unwrap().selections[0].end_column = 2;
    context.active_file.as_mut().unwrap().selections[0].text = "x".repeat(160_001);
    assert!(validate_context(&context, &roots).is_err());
    context.active_file = None;
    let outside = tempfile::NamedTempFile::new().unwrap();
    context
        .open_tabs
        .push(outside.path().to_string_lossy().into_owned());
    assert!(validate_context(&context, &roots).is_err());
}

#[cfg(unix)]
#[test]
fn ide_context_rejects_symlinks_that_escape_directory_grants() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let alias = root.path().join("alias.rs");
    std::os::unix::fs::symlink(outside.path(), &alias).unwrap();
    let context = IdeContext {
        active_file: None,
        open_tabs: vec![alias.to_string_lossy().into_owned()],
        dirty_files: vec![],
    };
    assert!(
        validate_context(
            &context,
            &[root
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        )
        .is_err()
    );
}
