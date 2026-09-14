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

    let rust = snapshot
        .automatic_content(&[PathBuf::from("src/lib.rs")])
        .unwrap();
    assert!(rust.contains("Always follow this."));
    assert!(rust.contains("Use Rust conventions."));
    assert!(!rust.contains("Explain carefully."));
    let typescript = snapshot
        .automatic_content(&[PathBuf::from("src/lib.ts")])
        .unwrap();
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
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        InstructionDiagnosticCode::InvalidLoadPolicy
    );
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
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        InstructionDiagnosticCode::InvalidLoadPolicy
    );
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
    assert!(
        catalog
            .snapshot()
            .global_content()
            .unwrap()
            .contains("Personal shared rule.")
    );

    fs::write(home.path().join("ASH.md"), "Personal Ash rule.").unwrap();
    let refreshed = catalog.refresh();
    assert_eq!(refreshed.generation(), 2);
    assert!(
        refreshed
            .global_content()
            .unwrap()
            .contains("Personal Ash rule.")
    );
}

#[test]
fn nested_always_on_rules_follow_confirmed_file_ancestors_once() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/nested")).unwrap();
    fs::create_dir_all(dir.path().join("other")).unwrap();
    fs::write(dir.path().join("src/AGENTS.md"), "Source rule.").unwrap();
    fs::write(dir.path().join("src/nested/ASH.md"), "Nested Ash rule.").unwrap();
    fs::write(dir.path().join("other/AGENTS.md"), "Unrelated rule.").unwrap();
    let catalog = InstructionCatalog::discover(dir.path());

    let loaded = catalog.nested_instructions(&[
        PathBuf::from("src/nested/lib.rs"),
        PathBuf::from("src/nested/other.rs"),
    ]);
    let content = loaded.content().unwrap();
    assert!(loaded.diagnostics().is_empty());
    assert!(content.find("Source rule.").unwrap() < content.find("Nested Ash rule.").unwrap());
    assert_eq!(content.matches("Source rule.").count(), 1);
    assert!(!content.contains("Unrelated rule."));
    assert!(catalog.nested_instructions(&[]).content().is_none());
    assert!(
        InstructionCatalog::discover_user(dir.path())
            .nested_instructions(&[PathBuf::from("src/nested/lib.rs")])
            .content()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn nested_rules_cannot_follow_a_symlink_outside_the_selected_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("AGENTS.md"), "Outside rule.").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();

    let loaded = InstructionCatalog::discover(root.path())
        .nested_instructions(&[PathBuf::from("linked/file.rs")]);
    assert!(loaded.content().is_none());
    assert_eq!(
        loaded.diagnostics()[0].code(),
        InstructionDiagnosticCode::SourceUnavailable
    );
}

#[test]
fn deep_files_keep_shallow_rules_when_nested_scan_limit_is_reached() {
    let root = tempfile::tempdir().unwrap();
    let deep = PathBuf::from("src").join(["deep"; 17].join("/"));
    fs::create_dir_all(root.path().join(&deep)).unwrap();
    fs::write(root.path().join("src/AGENTS.md"), "Shallow rule.").unwrap();

    let loaded =
        InstructionCatalog::discover(root.path()).nested_instructions(&[deep.join("file.rs")]);
    assert!(loaded.content().unwrap().contains("Shallow rule."));
    assert!(
        loaded
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code() == InstructionDiagnosticCode::EntryLimitExceeded)
    );
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
    assert!(
        snapshot
            .automatic_content(&[PathBuf::from("src/lib.rs")])
            .is_none()
    );
}

#[test]
fn bundled_always_on_template_is_read_as_plain_markdown() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("ASH.md"), crate::STARTER_ALWAYS_ON_TEMPLATE).unwrap();

    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    assert!(snapshot.diagnostics().is_empty());
    assert!(
        snapshot
            .global_content()
            .unwrap()
            .contains("Project instructions")
    );
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

#[test]
fn descriptions_are_discoverable_without_loading_bodies_and_reads_select_only_exact_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("review.md"), "---\nname: review\ndescription: 'Review <API> & contracts'\nload: on-demand\n---\nREVIEW BODY").unwrap();
    write_instruction(&root, "other", "on-demand", &[], "OTHER BODY");
    let snapshot = InstructionCatalog::discover(dir.path()).snapshot();
    let initial = snapshot.context_content(&[], &[], &root).unwrap();
    assert!(initial.contains("Review &lt;API&gt; &amp; contracts"));
    assert!(!initial.contains("REVIEW BODY"));
    let selected = snapshot
        .context_content(&[], &[root.join("review.md")], &root)
        .unwrap();
    assert!(selected.contains("REVIEW BODY"));
    assert!(!selected.contains("OTHER BODY"));
    assert!(
        !snapshot
            .context_content(&[], &[dir.path().join("review.md")], &root)
            .unwrap()
            .contains("REVIEW BODY")
    );
}

#[test]
fn new_file_requires_contextual_and_nested_rules_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/AGENTS.md"), "Source rules").unwrap();
    write_instruction(&root, "rust", "contextual", &["**/*.rs"], "Rust rules");
    let catalog = InstructionCatalog::discover(dir.path());
    let targets = [PathBuf::from("src/new/deep.rs")];
    assert_eq!(
        catalog.read(&dir.path().join("src/AGENTS.md")).as_deref(),
        Some("Source rules")
    );
    assert!(catalog.read(&dir.path().join("src/secret.txt")).is_none());
    assert_eq!(
        catalog.required_reads(&targets, &[], &[]),
        vec![root.join("rust.md"), dir.path().join("src/AGENTS.md")]
    );
    assert!(
        catalog
            .required_reads(
                &targets,
                &[],
                &[root.join("rust.md"), dir.path().join("src/AGENTS.md")]
            )
            .is_empty()
    );
    assert!(
        catalog
            .required_reads(&targets, &[PathBuf::from("src/old.rs")], &[])
            .is_empty()
    );
}

#[test]
fn invalid_description_is_diagnosed_and_deleted_selection_disappears_after_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("bad.md"),
        "---\nload: on-demand\ndescription: ''\n---\nBad.",
    )
    .unwrap();
    write_instruction(&root, "selected", "on-demand", &[], "Selected body");
    let mut catalog = InstructionCatalog::discover(dir.path());
    let selected = [root.join("selected.md")];
    let content = catalog
        .snapshot()
        .context_content(&[], &selected, &root)
        .unwrap();
    assert!(content.contains("Selected body"));
    assert!(content.contains("instruction-diagnostics"));
    fs::remove_file(&selected[0]).unwrap();
    assert!(
        !catalog
            .refresh()
            .context_content(&[], &selected, &root)
            .unwrap()
            .contains("Selected body")
    );
}

#[test]
fn personal_rule_selection_cannot_be_spoofed_by_a_workspace_relative_path() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("instructions");
    fs::create_dir(&root).unwrap();
    write_instruction(
        &root,
        "rust",
        "contextual",
        &["**/*.rs"],
        "Personal Rust rule",
    );
    let catalog = InstructionCatalog::discover_user(home.path());
    let targets = [PathBuf::from("new.rs")];
    assert_eq!(
        catalog.required_reads(&targets, &[PathBuf::from("instructions/rust.md")], &[]),
        vec![root.join("rust.md")]
    );
    assert!(
        catalog
            .required_reads(&targets, &[], &[root.join("rust.md")])
            .is_empty()
    );
}
