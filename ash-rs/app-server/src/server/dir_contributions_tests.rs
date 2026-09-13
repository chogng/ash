use super::*;
use crate::server::fs_watcher::DirFileChangeSink;
use ash_file_access::Authorization;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

#[test]
fn global_instructions_are_injected_but_other_load_policies_are_not() {
    let dir = TempDir::new().unwrap();
    write_instruction(
        dir.path(),
        "global",
        "global",
        "Always use the project formatter.",
    );
    write_instruction(
        dir.path(),
        "rust-files",
        "contextual\npatterns:\n  - '**/*.rs'",
        "Use Rust-specific review guidance.",
    );
    fs::write(
        dir.path().join("AGENTS.md"),
        "Legacy root instructions must not be injected.",
    )
    .unwrap();

    let customizations = customizations(dir.path());
    let harness = instruction_snapshot(customizations.as_ref(), "session-global");

    assert_eq!(customizations.instruction_snapshot().entries().len(), 2);
    let injected = harness.instructions().directory_instructions().unwrap();
    assert!(harness.instructions().system_body().is_empty());
    assert!(injected.contains("Always use the project formatter."));
    assert!(!injected.contains("Rust-specific review guidance."));
    assert!(!injected.contains("Legacy root instructions"));
}

#[test]
fn cwd_without_load_instructions_does_not_load_contributions() {
    let dir = TempDir::new().unwrap();
    write_instruction(dir.path(), "global", "global", "Must not be loaded.");
    write_agent(
        dir.path(),
        "reviewer",
        "Reviews code",
        "Must not be loaded.",
    );

    let contributions = DirContributions::discover(
        dir.path(),
        Arc::new(crate::dir_grants::DirGrants::default()),
        None,
    )
    .unwrap();

    assert!(contributions.instruction_snapshot().entries().is_empty());
    assert!(contributions.agent_snapshot().entries().is_empty());
    assert!(
        instruction_snapshot(contributions.as_ref(), "session-without-authorization")
            .instructions()
            .directory_instructions()
            .is_none()
    );
}

#[test]
fn file_changes_refresh_instruction_and_agent_snapshots() {
    let dir = TempDir::new().unwrap();
    write_instruction(dir.path(), "global", "global", "First version.");
    write_agent(dir.path(), "reviewer", "Reviews code", "Review carefully.");
    let customizations = customizations(dir.path());
    let instruction_generation = customizations.instruction_snapshot().generation();
    let agent_generation = customizations.agent_snapshot().generation();

    write_instruction(dir.path(), "global", "global", "Second version.");
    write_agent(
        dir.path(),
        "reviewer",
        "Reviews code and tests",
        "Review carefully.",
    );
    customizations.files_changed(&FsChanged::PathsChanged {
        dir_id: None,
        paths: vec![
            PathBuf::from(".ash/instructions/global.md"),
            PathBuf::from(".ash/agents/reviewer.md"),
        ],
    });

    assert!(customizations.instruction_snapshot().generation() > instruction_generation);
    assert!(customizations.agent_snapshot().generation() > agent_generation);
    assert!(
        instruction_snapshot(customizations.as_ref(), "session-refresh")
            .instructions()
            .directory_instructions()
            .unwrap()
            .contains("Second version.")
    );
    assert_eq!(
        customizations.agent_snapshot().entries()[0].description(),
        "Reviews code and tests"
    );
}

#[test]
fn dirs_are_rendered_only_for_the_matching_session() {
    let cwd = TempDir::new().unwrap();
    let dir = TempDir::new().unwrap();
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let first = SessionId::new("session-with-dir").unwrap();
    let second = SessionId::new("session-without-dir").unwrap();
    let authorization = Grant::for_session_tree(
        first.clone(),
        Dir::open_local(dir.path()).unwrap(),
        GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::InspectRepository]),
    );
    access.add_dir(first.clone(), authorization).unwrap();
    let customizations = DirContributions::discover(cwd.path(), Arc::clone(&access), None).unwrap();

    let first_environment = instruction_snapshot(customizations.as_ref(), first.as_str())
        .environment()
        .unwrap()
        .render();
    let second_snapshot = instruction_snapshot(customizations.as_ref(), second.as_str());

    let dir_path = dunce::canonicalize(dir.path())
        .unwrap()
        .display()
        .to_string();
    assert!(first_environment.contains(&dir_path));
    assert!(first_environment.contains("<filesystem>"));
    assert!(first_environment.contains("<accessible_dirs>"));
    assert!(first_environment.contains("Relative paths resolve from cwd"));
    assert!(
        !second_snapshot
            .environment()
            .unwrap()
            .render()
            .contains(&dir_path)
    );

    access.clear_session(&first);
    assert!(
        !instruction_snapshot(customizations.as_ref(), first.as_str())
            .environment()
            .unwrap()
            .render()
            .contains(&dir_path)
    );
}

#[test]
fn authorized_dir_contributions_are_session_scoped_refreshable_and_revocable() {
    let cwd = TempDir::new().unwrap();
    let dir = TempDir::new().unwrap();
    write_instruction(dir.path(), "extra", "global", "Directory guidance.");
    write_agent(
        dir.path(),
        "extra-reviewer",
        "Reviews directory files",
        "Review the directory.",
    );
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let first = SessionId::new("session-with-dir-contributions").unwrap();
    let second = SessionId::new("session-without-dir-contributions").unwrap();
    let root = Dir::open_local(dir.path()).unwrap();
    access
        .add_dir(
            first.clone(),
            Grant::for_session_tree(
                first.clone(),
                root.clone(),
                GrantSource::ExplicitUser,
                ash_file_access::Permissions::new([
                    ash_file_access::Permission::ReadFiles,
                    ash_file_access::Permission::LoadInstructions,
                ]),
            ),
        )
        .unwrap();
    let customizations = DirContributions::discover(cwd.path(), Arc::clone(&access), None).unwrap();
    let authorizations = access
        .snapshot_for(&first, ash_file_access::Permission::LoadInstructions)
        .unwrap()
        .unwrap()
        .authorizations()
        .to_vec();
    customizations.reconcile_session(&first, authorizations);

    assert!(
        instruction_snapshot(customizations.as_ref(), first.as_str())
            .instructions()
            .directory_instructions()
            .unwrap()
            .contains("Directory guidance.")
    );
    assert!(
        instruction_snapshot(customizations.as_ref(), second.as_str())
            .instructions()
            .directory_instructions()
            .is_none()
    );
    assert_eq!(customizations.agent_snapshots_for(&first).len(), 1);
    assert!(customizations.agent_snapshots_for(&second).is_empty());

    write_instruction(
        dir.path(),
        "extra",
        "global",
        "Refreshed directory guidance.",
    );
    customizations.dir_files_changed(
        &first,
        root.canonical_path(),
        &FsChanged::PathsChanged {
            dir_id: None,
            paths: vec![PathBuf::from(".ash/instructions/extra.md")],
        },
    );
    assert!(
        instruction_snapshot(customizations.as_ref(), first.as_str())
            .instructions()
            .directory_instructions()
            .unwrap()
            .contains("Refreshed directory guidance.")
    );

    access
        .set_permissions(
            &first,
            root.canonical_path(),
            1,
            ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
        )
        .unwrap();
    customizations.reconcile_session(&first, Vec::new());
    assert!(
        instruction_snapshot(customizations.as_ref(), first.as_str())
            .instructions()
            .directory_instructions()
            .is_none()
    );
}

fn customizations(dir: &Path) -> Arc<DirContributions> {
    DirContributions::discover(
        dir,
        Arc::new(crate::dir_grants::DirGrants::default()),
        Some(load_instructions_authorization(dir)),
    )
    .unwrap()
}

fn load_instructions_authorization(dir: &Path) -> Authorization {
    Grant::for_environment(
        Dir::open_local(dir).unwrap(),
        GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([ash_file_access::Permission::LoadInstructions]),
    )
    .authorize(ash_file_access::Permission::LoadInstructions)
    .unwrap()
}

fn instruction_snapshot(
    customizations: &DirContributions,
    session_id: &str,
) -> Arc<HarnessContext> {
    let session_id = SessionId::new(session_id).unwrap();
    let thread_id = ThreadId::new("dir-contributions-thread").unwrap();
    let turn_id = TurnId::new("dir-contributions-turn").unwrap();
    HarnessContextProvider::snapshot(
        customizations,
        &HarnessContextRequest {
            session_id: &session_id,
            thread_id: &thread_id,
            turn_id: &turn_id,
        },
    )
    .unwrap()
}

fn write_instruction(dir: &Path, name: &str, load: &str, body: &str) {
    let root = dir.join(".ash/instructions");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(format!("{name}.md")),
        format!("---\nname: {name}\nload: {load}\n---\n\n{body}\n"),
    )
    .unwrap();
}

fn write_agent(dir: &Path, name: &str, description: &str, body: &str) {
    let root = dir.join(".ash/agents");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(format!("{name}.md")),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"),
    )
    .unwrap();
}

#[test]
fn revoked_environment_grant_removes_cached_harness_instructions() {
    let dir = TempDir::new().unwrap();
    write_instruction(dir.path(), "global", "global", "Revocable guidance.");
    let grant = Grant::for_environment(
        Dir::open_local(dir.path()).unwrap(),
        GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::LoadInstructions]),
    );
    let contributions = DirContributions::discover(
        dir.path(),
        Arc::new(crate::dir_grants::DirGrants::default()),
        Some(
            grant
                .authorize(ash_file_access::Permission::LoadInstructions)
                .unwrap(),
        ),
    )
    .unwrap();
    assert!(
        instruction_snapshot(contributions.as_ref(), "session")
            .instructions()
            .directory_instructions()
            .is_some()
    );
    grant.revoke();
    assert!(
        instruction_snapshot(contributions.as_ref(), "session")
            .instructions()
            .directory_instructions()
            .is_none()
    );
    assert!(contributions.instruction_snapshot().entries().is_empty());
}

#[test]
fn a_valid_authorization_for_another_directory_cannot_load_contributions() {
    let authorized = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    write_instruction(other.path(), "global", "global", "Must not be loaded.");
    let grant = Grant::for_environment(
        Dir::open_local(authorized.path()).unwrap(),
        GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::LoadInstructions]),
    );
    let contributions = DirContributions::discover(
        other.path(),
        Arc::new(crate::dir_grants::DirGrants::default()),
        Some(
            grant
                .authorize(ash_file_access::Permission::LoadInstructions)
                .unwrap(),
        ),
    )
    .unwrap();
    assert!(contributions.instruction_snapshot().entries().is_empty());
}
