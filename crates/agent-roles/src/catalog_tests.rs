use super::*;
use std::fs;

#[test]
fn discovers_a_typed_agent_role() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("reviewer.md"),
        "---\nname: reviewer\ndescription: Reviews code changes.\nmodel: openai/gpt-5\ntools:\n  - read_file\ndelegationTools:\n  - write_file\nrequiredDelegationTools:\n  - write_file\nskills:\n  - code-review\ninstructions:\n  - rust-style\n---\n\nReview correctness and regressions.\n",
    )
    .unwrap();

    let snapshot = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    assert!(snapshot.diagnostics().is_empty());
    assert_eq!(snapshot.entries().len(), 1);
    let role = &snapshot.entries()[0];
    assert_eq!(role.name(), "reviewer");
    assert_eq!(
        role.source(),
        &AgentRoleSource::Directory { id: "test".into() }
    );
    assert!(role.content_digest().starts_with("sha256:"));
    assert_eq!(role.model(), Some("openai/gpt-5"));
    assert_eq!(role.tools().unwrap(), ["read_file"]);
    assert_eq!(role.delegation_tools().unwrap(), ["write_file"]);
    assert_eq!(role.required_delegation_tools(), ["write_file"]);
    assert_eq!(role.skills().unwrap(), ["code-review"]);
    assert_eq!(role.instructions(), ["rust-style"]);
}

#[test]
fn filename_mismatch_is_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("reviewer.md"),
        "---\nname: other\ndescription: Reviews code.\n---\n\nReview.\n",
    )
    .unwrap();

    let snapshot = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    assert!(snapshot.entries().is_empty());
    assert_eq!(snapshot.diagnostics().len(), 1);
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        AgentRoleDiagnosticCode::InvalidName
    );
}

#[test]
fn conflicting_delegation_tool_rules_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("coordinator.md"),
        "---\nname: coordinator\ndescription: Coordinates work.\ndelegationTools:\n  - write_file\nrequiredDelegationTools:\n  - write_file\ndisallowedDelegationTools:\n  - write_file\n---\n\nCoordinate.\n",
    )
    .unwrap();

    let snapshot = AgentRoleCatalog::discover("test", dir.path()).snapshot();

    assert!(snapshot.entries().is_empty());
    assert_eq!(snapshot.diagnostics().len(), 1);
    assert_eq!(
        snapshot.diagnostics()[0].code(),
        AgentRoleDiagnosticCode::InvalidReference
    );
}

#[test]
fn windows_line_endings_use_the_same_body_and_digest() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    let text =
        "---\nname: reviewer\ndescription: Reviews code.\ntools: []\n---\n\nReview evidence.\n";
    let path = root.join("reviewer.md");
    fs::write(&path, text).unwrap();
    let lf = AgentRoleCatalog::discover("test", dir.path()).snapshot();
    fs::write(path, text.replace('\n', "\r\n")).unwrap();
    let crlf = AgentRoleCatalog::discover("test", dir.path()).snapshot();
    assert!(crlf.diagnostics().is_empty());
    assert_eq!(lf.entries(), crlf.entries());
}

#[test]
fn directory_definitions_cannot_claim_a_product_entry_point_or_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    for metadata in [
        "launch: host",
        "source: builtIn",
        "version: 1",
        "delegates: [team/implementer]",
    ] {
        fs::write(
            root.join("advisor.md"),
            format!("---\nname: advisor\ndescription: Advice.\n{metadata}\n---\n\nAdvise.\n"),
        )
        .unwrap();
        let snapshot = AgentRoleCatalog::discover("test", dir.path()).snapshot();
        assert!(snapshot.entries().is_empty(), "{metadata}");
        assert_eq!(
            snapshot.diagnostics()[0].code(),
            AgentRoleDiagnosticCode::InvalidFrontmatter
        );
    }
}

#[test]
fn refresh_advances_generation_after_a_definition_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("reviewer.md");
    fs::write(
        &path,
        "---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview.\n",
    )
    .unwrap();
    let mut catalog = AgentRoleCatalog::discover("test", dir.path());

    fs::write(
        path,
        "---\nname: reviewer\ndescription: Reviews code deeply.\n---\n\nReview.\n",
    )
    .unwrap();
    let snapshot = catalog.refresh();

    assert_eq!(snapshot.generation(), 2);
    assert_eq!(snapshot.entries()[0].description(), "Reviews code deeply.");
}
