use super::*;
use crate::{SkillCompatibility, SkillDiagnosticCode, SkillName, SkillSourceId, SkillSourceRoot};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

fn skill(name: &str, description: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n{body}")
}

fn create_skill(root: &Path, name: &str, description: &str, body: &str) {
    let directory = root.join(name);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("SKILL.md"), skill(name, description, body)).unwrap();
}

fn source(id: &str, root: &Path) -> SkillSourceRoot {
    SkillSourceRoot::user(SkillSourceId::new(id).unwrap(), root).unwrap()
}

#[test]
fn discovery_is_metadata_only_stable_and_source_qualified() {
    let user = TestDirectory::new();
    let dir = TestDirectory::new();
    create_skill(
        user.path(),
        "review",
        "Reviews user code when requested.",
        "USER_BODY_SENTINEL",
    );
    create_skill(
        dir.path(),
        "review",
        "Reviews dir code when requested.",
        "DIR_BODY_SENTINEL",
    );

    let catalog = SkillCatalog::discover(vec![
        source("dir:skill-source:project", dir.path()),
        source("user:skill-source:personal", user.path()),
    ])
    .unwrap();
    let snapshot = catalog.snapshot();

    assert_eq!(snapshot.generation().get(), 1);
    assert_eq!(snapshot.list().len(), 2);
    assert_eq!(
        snapshot.list()[0].id().source.as_str(),
        "dir:skill-source:project"
    );
    assert_eq!(
        snapshot.list()[1].id().source.as_str(),
        "user:skill-source:personal"
    );
    assert_eq!(
        snapshot.list()[1].metadata().description(),
        "Reviews user code when requested."
    );
    let debug_projection = format!("{snapshot:?}");
    assert!(!debug_projection.contains("USER_BODY_SENTINEL"));
    assert!(!debug_projection.contains("DIR_BODY_SENTINEL"));
}

#[test]
fn one_invalid_skill_isolated_as_a_sanitized_diagnostic() {
    let directory = TestDirectory::new();
    create_skill(
        directory.path(),
        "valid",
        "Handles valid tasks when requested.",
        "# Valid",
    );
    fs::create_dir_all(directory.path().join("broken")).unwrap();
    fs::write(
        directory.path().join("broken/SKILL.md"),
        "---\nname: different\ndescription: Broken.\n---\nsecret body",
    )
    .unwrap();

    let catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", directory.path())])
            .unwrap();
    let snapshot = catalog.snapshot();

    assert_eq!(snapshot.list().len(), 1);
    assert_eq!(snapshot.list()[0].id().name.as_str(), "valid");
    assert_eq!(snapshot.diagnostics().len(), 1);
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        SkillDiagnosticCode::InvalidSkillName
    );
    assert_eq!(snapshot.diagnostics()[0].subject(), Some("broken/SKILL.md"));
    assert!(!snapshot.diagnostics()[0].message().contains("secret"));
    assert!(
        !snapshot.diagnostics()[0]
            .message()
            .contains(directory.path().to_str().unwrap())
    );
}

#[test]
fn refresh_changes_generation_only_for_visible_projection_changes() {
    let directory = TestDirectory::new();
    create_skill(
        directory.path(),
        "review",
        "Reviews code when requested.",
        "first",
    );
    let mut catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", directory.path())])
            .unwrap();
    let first = catalog.snapshot();

    let unchanged = catalog.refresh();
    assert!(Arc::ptr_eq(&first, &unchanged));
    assert_eq!(unchanged.generation().get(), 1);

    fs::write(
        directory.path().join("review/SKILL.md"),
        skill(
            "review",
            "Reviews code when requested.",
            "second body changes digest",
        ),
    )
    .unwrap();
    let changed = catalog.refresh();
    assert_eq!(changed.generation().get(), 2);
    assert_ne!(
        first.list()[0].content_digest(),
        changed.list()[0].content_digest()
    );
}

#[test]
fn refresh_projects_a_source_that_disappears_as_a_diagnostic() {
    let directory = TestDirectory::new();
    create_skill(
        directory.path(),
        "review",
        "Reviews code when requested.",
        "# Review",
    );
    let root = directory.path().to_path_buf();
    let mut catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", &root)]).unwrap();
    fs::remove_dir_all(&root).unwrap();

    let changed = catalog.refresh();

    assert_eq!(changed.generation().get(), 2);
    assert!(changed.list().is_empty());
    assert_eq!(
        changed.diagnostics()[0].code(),
        SkillDiagnosticCode::SourceUnavailable
    );
}

#[test]
fn read_uses_exact_source_qualified_identity() {
    let directory = TestDirectory::new();
    create_skill(
        directory.path(),
        "review",
        "Reviews code when requested.",
        "# Review",
    );
    let catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", directory.path())])
            .unwrap();
    let id = crate::SkillId::new(
        SkillSourceId::new("user:skill-source:personal").unwrap(),
        SkillName::new("review").unwrap(),
    );

    let snapshot = catalog.snapshot();
    let entry = snapshot.read(&id).unwrap();

    assert_eq!(entry.availability(), SkillAvailability::Available);
    assert_eq!(entry.compatibility(), &SkillCompatibility::Compatible);
}

#[cfg(unix)]
#[test]
fn linked_skill_entries_and_manifests_are_rejected() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new();
    let outside = TestDirectory::new();
    create_skill(
        outside.path(),
        "linked",
        "Handles linked tasks when requested.",
        "# Linked",
    );
    symlink(
        outside.path().join("linked"),
        directory.path().join("linked"),
    )
    .unwrap();
    create_skill(
        directory.path(),
        "hard-linked",
        "Handles hard-link tests when requested.",
        "# Hard link",
    );
    fs::hard_link(
        directory.path().join("hard-linked/SKILL.md"),
        directory.path().join("hard-linked/COPY.md"),
    )
    .unwrap();

    let catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", directory.path())])
            .unwrap();
    let snapshot = catalog.snapshot();

    assert!(snapshot.list().is_empty());
    assert!(
        snapshot
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code() == SkillDiagnosticCode::PathEscapesRoot)
    );
    assert!(
        snapshot
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code() == SkillDiagnosticCode::UnsupportedFileType)
    );
}

#[test]
fn oversized_body_and_frontmatter_are_bounded() {
    let directory = TestDirectory::new();
    create_skill(
        directory.path(),
        "huge-body",
        "Handles large tasks when requested.",
        &"x".repeat(1024 * 1024),
    );
    fs::create_dir_all(directory.path().join("huge-frontmatter")).unwrap();
    fs::write(
        directory.path().join("huge-frontmatter/SKILL.md"),
        format!(
            "---\nname: huge-frontmatter\ndescription: {}\n---\n",
            "x".repeat(17 * 1024)
        ),
    )
    .unwrap();

    let catalog =
        SkillCatalog::discover(vec![source("user:skill-source:personal", directory.path())])
            .unwrap();
    let snapshot = catalog.snapshot();

    assert!(snapshot.list().is_empty());
    assert_eq!(
        snapshot
            .diagnostics()
            .iter()
            .filter(|diagnostic| diagnostic.code() == SkillDiagnosticCode::ContentTooLarge)
            .count(),
        2
    );
}

#[test]
fn duplicate_source_registration_is_rejected() {
    let directory = TestDirectory::new();
    let first = source("user:skill-source:personal", directory.path());
    let second = source("user:skill-source:personal", directory.path());

    let error = SkillCatalog::discover(vec![first, second]).unwrap_err();

    assert_eq!(error.kind(), SkillErrorKind::DuplicateSource);
}

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-skills-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
