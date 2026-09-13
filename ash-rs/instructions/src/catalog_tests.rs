use super::*;
use std::fs;

#[test]
fn discovers_three_loading_modes_and_renders_only_global_content() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(&root, "always", "global", &[], "Always follow this.");
    write_instruction(
        &root,
        "rust",
        "contextual",
        &["**/*.rs"],
        "Use Rust conventions.",
    );
    write_instruction(&root, "explain", "on-demand", &[], "Explain carefully.");

    let catalog = InstructionCatalog::discover(dir.path());
    let snapshot = catalog.snapshot();

    assert_eq!(snapshot.entries().len(), 3);
    assert!(snapshot.diagnostics().is_empty());
    let global = snapshot.global_content().unwrap();
    assert!(global.contains("Always follow this."));
    assert!(!global.contains("Use Rust conventions."));
    assert!(!global.contains("Explain carefully."));

    let rust = snapshot.automatic_content(&[PathBuf::from("src/lib.rs")]).unwrap();
    assert!(rust.contains("Always follow this."));
    assert!(rust.contains("Use Rust conventions."));
    assert!(!rust.contains("Explain carefully."));
    let typescript = snapshot.automatic_content(&[PathBuf::from("src/lib.ts")]).unwrap();
    assert!(!typescript.contains("Use Rust conventions."));
}

#[test]
fn refresh_advances_generation_only_for_visible_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(&root, "always", "global", &[], "First.");
    let mut catalog = InstructionCatalog::discover(dir.path());

    assert_eq!(catalog.refresh().generation(), 1);
    write_instruction(&root, "always", "global", &[], "Second.");
    let refreshed = catalog.refresh();

    assert_eq!(refreshed.generation(), 2);
    assert_eq!(refreshed.entries()[0].body(), "Second.");
}

#[test]
fn invalid_policy_is_isolated_as_a_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(&root, "bad", "contextual", &[], "Body.");
    write_instruction(&root, "good", "global", &[], "Good.");

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();

    assert_eq!(snapshot.entries().len(), 1);
    assert_eq!(snapshot.diagnostics().len(), 1);
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        InstructionDiagnosticCode::InvalidLoadPolicy
    );
}

#[test]
fn invalid_contextual_glob_is_rejected_at_discovery() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(&root, "invalid", "contextual", &["../secret/*.rs"], "Bad.");

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    assert!(snapshot.entries().is_empty());
    assert_eq!(snapshot.diagnostics()[0].code(), InstructionDiagnosticCode::InvalidLoadPolicy);
}

#[test]
fn excessive_contextual_patterns_are_rejected_before_matching() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(
        &root,
        "too-many",
        "contextual",
        &vec!["**/*.rs"; 33],
        "Bad.",
    );

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    assert!(snapshot.entries().is_empty());
    assert_eq!(snapshot.diagnostics()[0].code(), InstructionDiagnosticCode::InvalidLoadPolicy);
}

#[test]
fn always_on_agents_and_ash_files_precede_file_rules() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("AGENTS.md"), "Shared instructions.").unwrap();
    fs::write(dir.path().join("ASH.md"), "Ash instructions.").unwrap();
    fs::write(dir.path().join("CLAUDE.md"), "Claude-only instructions.").unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    write_instruction(&root, "more", "global", &[], "File instructions.");

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();

    assert!(snapshot.diagnostics().is_empty());
    let content = snapshot.global_content().unwrap();
    assert!(content.find("Shared instructions.") < content.find("Ash instructions."));
    assert!(content.find("Ash instructions.") < content.find("File instructions."));
    assert!(!content.contains("Claude-only instructions."));
}

#[test]
fn user_always_on_file_loads_without_an_instruction_directory() {
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("AGENTS.md"), "Personal shared rule.").unwrap();
    let mut catalog = InstructionCatalog::discover_user(home.path());
    assert!(catalog.snapshot().global_content().unwrap().contains("Personal shared rule."));

    fs::write(home.path().join("ASH.md"), "Personal Ash rule.").unwrap();
    let refreshed = catalog.refresh();
    assert_eq!(refreshed.generation(), 2);
    assert!(refreshed.global_content().unwrap().contains("Personal Ash rule."));
}

#[test]
fn bundled_starter_template_is_valid_and_inactive() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("example.md"), crate::STARTER_TEMPLATE).unwrap();

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    assert!(snapshot.diagnostics().is_empty());
    assert_eq!(snapshot.entries().len(), 1);
    assert!(snapshot.global_content().is_none());
    assert!(snapshot.automatic_content(&[PathBuf::from("src/lib.rs")]).is_none());
}

#[test]
fn bundled_always_on_template_is_read_as_plain_markdown() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("ASH.md"), crate::STARTER_ALWAYS_ON_TEMPLATE).unwrap();

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    assert!(snapshot.diagnostics().is_empty());
    assert!(snapshot.global_content().unwrap().contains("Project instructions"));
}

fn write_instruction(root: &Path, name: &str, load: &str, patterns: &[&str], body: &str) {
    let patterns = if patterns.is_empty() {
        String::new()
    } else {
        format!(
            "patterns:\n{}",
            patterns
                .iter()
                .map(|pattern| format!("  - '{pattern}'"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    fs::write(
        root.join(format!("{name}.md")),
        format!("---\nname: {name}\nload: {load}\n{patterns}\n---\n\n{body}\n"),
    )
    .unwrap();
}
