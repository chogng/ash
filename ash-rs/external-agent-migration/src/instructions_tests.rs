use super::read_claude_instructions;
use crate::AgentImportDiagnosticCode;
use crate::AgentImportLocation;
use std::fs;
use std::path::Path;

#[test]
fn reads_first_nonempty_claude_project_file_without_rewriting_it() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".claude")).unwrap();
    fs::write(root.path().join("CLAUDE.md"), "  ").unwrap();
    fs::write(
        root.path().join(".claude/CLAUDE.md"),
        "Use Claude-specific terms.\n",
    )
    .unwrap();
    let read = read_claude_instructions(AgentImportLocation::claude_project(root.path())).unwrap();
    let selected = read.selected().unwrap();
    assert_eq!(selected.relative_path(), Path::new(".claude/CLAUDE.md"));
    assert_eq!(selected.content(), "Use Claude-specific terms.\n");
    assert!(read.diagnostics().is_empty());
}

#[cfg(unix)]
#[test]
fn excludes_symlinked_claude_file() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.md"), "secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.md"),
        root.path().join("CLAUDE.md"),
    )
    .unwrap();
    let read = read_claude_instructions(AgentImportLocation::claude_project(root.path())).unwrap();
    assert!(read.selected().is_none());
    assert_eq!(
        read.diagnostics()[0].code(),
        AgentImportDiagnosticCode::SymlinkNotAllowed
    );
}
