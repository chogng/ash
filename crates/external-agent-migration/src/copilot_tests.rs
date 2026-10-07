use super::*;
use crate::AgentImportLocation;
use crate::detect_migration_plan;
use crate::inspect_agent_paths;

#[test]
fn copilot_discovers_shared_and_scoped_rules_without_copying_agents() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".github/instructions")).unwrap();
    std::fs::write(root.path().join("AGENTS.md"), "Shared separately").unwrap();
    std::fs::write(
        root.path().join(".github/copilot-instructions.md"),
        "Common rule",
    )
    .unwrap();
    std::fs::write(
        root.path()
            .join(".github/instructions/rust.instructions.md"),
        "---\napplyTo: '**/*.{rs,toml},Cargo.lock'\ndescription: Rust\n---\nRust rule",
    )
    .unwrap();
    std::fs::write(
        root.path()
            .join(".github/instructions/review.instructions.md"),
        "---\ndescription: Review\n---\nRead when selected",
    )
    .unwrap();
    std::fs::write(
        root.path().join(".github/instructions/ignored.md"),
        "ignored",
    )
    .unwrap();
    let inspection =
        inspect_agent_paths([AgentImportLocation::copilot_project(root.path())]).unwrap();
    assert_eq!(inspection.candidates().len(), 2);
    let plan =
        detect_migration_plan([AgentImportLocation::copilot_project(root.path())], None).unwrap();
    assert_eq!(plan.items().len(), 3);
    assert!(plan.diagnostics().is_empty());
    let documents = plan
        .items()
        .iter()
        .map(|item| match item.detail() {
            MigrationItemDetail::Instruction { document } => document,
            _ => panic!("wrong fragment"),
        })
        .collect::<Vec<_>>();
    assert!(
        documents
            .iter()
            .any(|doc| doc.load == ExternalInstructionLoad::Always)
    );
    assert!(
        documents
            .iter()
            .any(|doc| doc.load == ExternalInstructionLoad::Selected)
    );
    assert!(documents.iter().any(|doc| doc.load
        == ExternalInstructionLoad::Files {
            patterns: vec!["**/*.{rs,toml}".into(), "Cargo.lock".into()]
        }));
    assert!(!format!("{plan:?}").contains("Common rule"));
}

#[test]
fn malformed_or_unsupported_metadata_never_becomes_global() {
    for header in [
        "applyTo: ''",
        "applyTo: [x]",
        "excludeAgent: code-review",
        "applyTo: '**/*.rs,'",
        "applyTo: '{rs,toml'",
        "description: []",
    ] {
        assert!(
            parse(
                &format!("---\n{header}\n---\nRule"),
                ImportItemKind::InstructionRules
            )
            .is_err(),
            "{header}"
        );
    }
    assert!(parse("---\napplyTo: '**'", ImportItemKind::InstructionRules).is_err());
}

#[cfg(unix)]
#[test]
fn copilot_rejects_symlink_sources() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("copilot-instructions.md"), "outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".github")).unwrap();
    let plan =
        detect_migration_plan([AgentImportLocation::copilot_project(root.path())], None).unwrap();
    assert!(plan.items().is_empty());
    assert!(!plan.diagnostics().is_empty());
}
