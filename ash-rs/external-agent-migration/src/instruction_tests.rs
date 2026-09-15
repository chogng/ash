use super::*;

fn write(root: &Path, path: &str, body: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

fn documents(plan: &MigrationPlan) -> Vec<&ExternalInstruction> {
    plan.items()
        .iter()
        .map(|item| match item.detail() {
            MigrationItemDetail::Instruction { document } => document,
            _ => panic!("instruction-only discovery returned another artifact"),
        })
        .collect()
}

#[test]
fn claude_preserves_all_project_rules_and_nested_path_patterns() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "CLAUDE.md", "Main rule");
    write(root.path(), ".claude/CLAUDE.md", "Additional rule");
    write(
        root.path(),
        ".claude/rules/security/rust.md",
        "---\npaths:\n  - 'src/**/*.rs'\n---\nRust rule",
    );
    write(root.path(), ".claude/rules/global.md", "Global rule");
    write(
        root.path(),
        ".claude/settings.json",
        "invalid configuration must not be read by instruction import",
    );
    let plan = detect_instruction_plan(AgentImportLocation::claude_project(root.path())).unwrap();
    assert_eq!(plan.items().len(), 4);
    assert!(plan.diagnostics().is_empty());
    let docs = documents(&plan);
    assert_eq!(
        docs.iter()
            .filter(|doc| doc.load == ExternalInstructionLoad::Always)
            .count(),
        3
    );
    assert!(docs.iter().any(|doc| doc.load
        == ExternalInstructionLoad::Files {
            patterns: vec!["src/**/*.rs".into()]
        }));
    assert!(docs.iter().all(|doc| doc.unsupported.is_none()));
}

#[test]
fn cursor_preserves_always_glob_and_selected_modes() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), ".cursorrules", "Repository rule");
    write(
        root.path(),
        ".cursor/rules/global.mdc",
        "---\nalwaysApply: true\n---\nGlobal",
    );
    write(
        root.path(),
        ".cursor/rules/src/rust.mdc",
        "---\nglobs: ['**/*.rs', '**/Cargo.toml']\nalwaysApply: false\n---\nScoped",
    );
    write(
        root.path(),
        ".cursor/rules/review.mdc",
        "---\ndescription: Review APIs\nglobs: ''\nalwaysApply: false\n---\nSelected",
    );
    write(root.path(), ".cursor/rules/ignored.md", "Ignored");
    let plan = detect_instruction_plan(AgentImportLocation::cursor_project(root.path())).unwrap();
    assert_eq!(plan.items().len(), 4);
    assert!(plan.diagnostics().is_empty());
    let docs = documents(&plan);
    assert_eq!(
        docs.iter()
            .filter(|doc| doc.load == ExternalInstructionLoad::Always)
            .count(),
        2
    );
    assert!(
        docs.iter()
            .any(|doc| doc.load == ExternalInstructionLoad::Selected)
    );
    assert!(docs.iter().any(|doc| matches!(&doc.kind, ExternalInstructionKind::Rule { name } if name == "cursor-src-rust")));
}

#[test]
fn codex_does_not_duplicate_shared_agents_or_silently_append_an_override() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "AGENTS.md", "Shared");
    assert!(
        detect_instruction_plan(AgentImportLocation::codex_project(root.path()))
            .unwrap()
            .items()
            .is_empty()
    );
    write(root.path(), "AGENTS.override.md", "Override");
    let plan = detect_instruction_plan(AgentImportLocation::codex_project(root.path())).unwrap();
    assert_eq!(plan.items().len(), 1);
    assert!(documents(&plan)[0].unsupported.is_some());
    std::fs::remove_file(root.path().join("AGENTS.md")).unwrap();
    let plan = detect_instruction_plan(AgentImportLocation::codex_project(root.path())).unwrap();
    assert!(documents(&plan)[0].unsupported.is_none());
}

#[test]
fn codex_user_override_selects_one_document() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), ".codex/AGENTS.md", "Ordinary");
    write(root.path(), ".codex/AGENTS.override.md", "Override");
    let plan = detect_instruction_plan(AgentImportLocation::codex_user(root.path())).unwrap();
    assert_eq!(documents(&plan).len(), 1);
    assert_eq!(documents(&plan)[0].body, "Override");
}

#[test]
fn unsupported_imports_and_private_rules_remain_visible_without_losing_semantics() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "CLAUDE.md", "Read @instructions.md");
    write(root.path(), "CLAUDE.local.md", "Private rule");
    let plan = detect_instruction_plan(AgentImportLocation::claude_project(root.path())).unwrap();
    assert_eq!(plan.items().len(), 2);
    assert!(
        documents(&plan)
            .iter()
            .all(|document| document.unsupported.is_some())
    );
    assert!(cursor_rule("---\nalwaysApply: sometimes\n---\nRule").is_err());
    assert!(claude_rule("---\npaths: []\n---\nRule").is_err());
    assert!(claude_rule("---\nunknown: true\n---\nRule").is_err());
}

#[test]
fn instruction_reference_checks_preserve_literal_code_and_empty_codex_override_selection() {
    assert!(
        claude_plain("Literal `@README`\n```\n@README\n```\nNormal guidance")
            .unwrap()
            .unsupported
            .is_none()
    );
    assert!(
        claude_plain("Import @README")
            .unwrap()
            .unsupported
            .is_some()
    );
    let root = tempfile::tempdir().unwrap();
    write(root.path(), ".codex/AGENTS.md", "Ordinary");
    write(root.path(), ".codex/AGENTS.override.md", " \n");
    let plan = detect_instruction_plan(AgentImportLocation::codex_user(root.path())).unwrap();
    assert_eq!(documents(&plan)[0].body, "Ordinary");
    assert!(plan.diagnostics().is_empty());
}
