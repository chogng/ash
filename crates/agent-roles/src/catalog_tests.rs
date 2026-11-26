use super::*;
use std::fs;

#[test]
fn creates_a_user_definition_without_replacing_an_existing_role() {
    let home = tempfile::tempdir().unwrap();
    let mut catalog = AgentRoleCatalog::discover_user(home.path());
    for _ in 0..2 {
        catalog
            .create_user_role(
                "release-helper",
                "Helps with releases",
                "Check release notes.",
            )
            .unwrap();
    }
    assert_eq!(
        catalog
            .create_user_role("release-helper", "Other details", "Other instructions.")
            .unwrap_err()
            .kind(),
        ErrorKind::AlreadyExists
    );
    assert_eq!(
        catalog
            .create_user_role("../escaped", "Description", "Instructions")
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidInput
    );

    let reopened = AgentRoleCatalog::discover_user(home.path()).snapshot();
    let role = reopened.get("release-helper").unwrap();
    assert_eq!(role.source(), &AgentRoleSource::User);
    assert_eq!(role.role_instructions(), "Check release notes.");
    assert!(reopened.diagnostics().is_empty());
}

#[test]
fn edits_user_text_without_replacing_role_options_or_overwriting_a_newer_edit() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("agents");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("review-helper.md"), "---\nname: review-helper\ndescription: Initial description\nmodel: openai/gpt-5\ntools:\n  - read_file\nrequiredTools:\n  - read_file\n---\nInitial instructions\n").unwrap();
    let mut catalog = AgentRoleCatalog::discover_user(home.path());
    let initial = catalog.snapshot();
    let digest = initial.get("review-helper").unwrap().content_digest();

    for _ in 0..2 {
        catalog
            .update_user_role(
                "review-helper",
                digest,
                "Revised description",
                "Revised instructions\nSecond line",
            )
            .unwrap();
    }
    assert!(matches!(
        catalog.update_user_role(
            "review-helper",
            digest,
            "Stale description",
            "Stale instructions"
        ),
        Err(UserRoleMutationError::RevisionConflict)
    ));

    let reopened = AgentRoleCatalog::discover_user(home.path()).snapshot();
    let role = reopened.get("review-helper").unwrap();
    assert_eq!(role.source(), &AgentRoleSource::User);
    assert_eq!(role.description(), "Revised description");
    assert_eq!(
        role.role_instructions(),
        "Revised instructions\nSecond line"
    );
    assert_ne!(role.content_digest(), digest);
    assert_eq!(role.model(), Some("openai/gpt-5"));
    assert_eq!(role.tools().unwrap(), ["read_file"]);
    assert_eq!(role.required_tools(), ["read_file"]);
}

#[test]
fn deletes_only_the_confirmed_user_role_revision() {
    let home = tempfile::tempdir().unwrap();
    let mut catalog = AgentRoleCatalog::discover_user(home.path());
    catalog
        .create_user_role(
            "release-helper",
            "Helps with releases",
            "Check release notes.",
        )
        .unwrap();
    let initial = catalog.snapshot();
    let digest = initial.get("release-helper").unwrap().content_digest();
    catalog
        .update_user_role(
            "release-helper",
            digest,
            "New release instructions",
            "Check the changelog.",
        )
        .unwrap();
    assert!(matches!(
        catalog.delete_user_role("release-helper", digest),
        Err(UserRoleMutationError::RevisionConflict)
    ));
    let current = catalog.snapshot();
    catalog
        .delete_user_role(
            "release-helper",
            current.get("release-helper").unwrap().content_digest(),
        )
        .unwrap();
    assert!(
        AgentRoleCatalog::discover_user(home.path())
            .snapshot()
            .get("release-helper")
            .is_none()
    );
}

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
