use crate::SkillCatalog;
use crate::SkillSourceId;
use crate::SkillSourceKind;
use crate::SkillSourceRoot;
use std::path::Path;

#[test]
fn repository_built_in_skills_form_a_valid_catalog() {
    // Scan the actual assets tree so stale directories and omitted resources are detected.
    let source = SkillSourceRoot::built_in(
        SkillSourceId::new("builtin:skill-source:ash-release").unwrap(),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets"),
    )
    .unwrap();
    let catalog = SkillCatalog::discover(vec![source]).unwrap();
    let snapshot = catalog.snapshot();
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    assert_eq!(
        snapshot
            .list()
            .iter()
            .map(|entry| entry.id().name.as_str())
            .collect::<Vec<_>>(),
        ["create-instructions", "skill-creator"]
    );
    assert!(
        snapshot
            .list()
            .iter()
            .all(|entry| entry.source().kind() == SkillSourceKind::BuiltIn)
    );
}
