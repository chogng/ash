use std::fs;
use std::path::Path;

use tempfile::TempDir;

use crate::AgentImportLocation;
use crate::source::Source;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn missing_projects_root_yields_no_files() {
    let temp = TempDir::new().unwrap();
    assert!(discovered(temp.path()).is_empty());
}

#[test]
fn discovers_memory_files_per_project_in_deterministic_order() {
    let temp = TempDir::new().unwrap();
    let projects = temp.path().join(".claude/projects");
    write(&projects.join("proj-a/memory/notes.md"), "a");
    write(&projects.join("proj-a/memory/deep/more.md"), "a2");
    write(&projects.join("proj-b/memory/MEMORY.md"), "b");
    write(&projects.join("proj-b/memory/ignored.txt"), "skip");
    write(&projects.join("memory.md"), "skip");
    fs::write(projects.join("plain-file.txt"), "skip").unwrap();

    let files = discovered(temp.path());
    assert_eq!(files.len(), 3);
    assert_eq!(files[0].project_key, "proj-a");
    assert_eq!(
        files[0].relative_path,
        std::path::PathBuf::from("deep/more.md")
    );
    assert_eq!(files[1].relative_path, std::path::PathBuf::from("notes.md"));
    assert_eq!(files[2].project_key, "proj-b");
    assert_eq!(
        files[2].relative_path,
        std::path::PathBuf::from("MEMORY.md")
    );
    assert!(files[0].source_path.ends_with("proj-a/memory/deep/more.md"));
}

#[cfg(unix)]
#[test]
fn symlinks_are_skipped_during_discovery() {
    let temp = TempDir::new().unwrap();
    let projects = temp.path().join(".claude/projects");
    let memory = projects.join("proj/memory");
    fs::create_dir_all(&memory).unwrap();
    let outside = temp.path().join("outside.md");
    fs::write(&outside, "outside").unwrap();
    std::os::unix::fs::symlink(&outside, memory.join("link.md")).unwrap();

    let files = discovered(temp.path());
    assert!(files.is_empty());
}

fn discovered(home: &Path) -> Vec<crate::ExternalMemoryFile> {
    let mut source = Source::new(AgentImportLocation::claude_user(home)).unwrap();
    super::discover_external_memory_files(&mut source)
}
