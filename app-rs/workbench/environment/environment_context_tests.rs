use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    EnvironmentContext, display_working_directory, editor_language_for_path,
    repository_root_from_path,
};
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_editor::CodeEditorLanguage;

use crate::app_server::testing::{
    AppServerClient, InProcessClientOptions, InProcessTransport, start_in_process_client,
};

static NEXT_REPOSITORY_ID: AtomicU64 = AtomicU64::new(0);

#[test]
fn home_relative_working_directory_uses_a_compact_label() {
    assert_eq!(
        display_working_directory(
            Path::new("/Users/lance/Desktop/ash"),
            Some(Path::new("/Users/lance")),
        ),
        "~/Desktop/ash"
    );
    assert_eq!(
        display_working_directory(Path::new("/Users/lance"), Some(Path::new("/Users/lance"))),
        "~"
    );
}

#[test]
fn fixture_exposes_all_four_toolbar_values_without_inventing_git_state() {
    let repository = EnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(3));
    let plain_directory = EnvironmentContext::fixture("/tmp/plain", None, None);

    assert_eq!(repository.location_label(), "Local");
    assert_eq!(repository.working_directory_label(), "~/Desktop/ash");
    assert_eq!(repository.git_branch_label(), "main");
    assert_eq!(repository.diff_summary_label(), "Changes 3 • +3 -0");
    assert_eq!(plain_directory.git_branch_label(), "No Git");
    assert_eq!(plain_directory.diff_summary_label(), "Changes —");
}

#[test]
fn remote_env_keeps_remote_path_and_location_identity() {
    let context = EnvironmentContext::capture_remote("/srv/remote/project".into());

    assert_eq!(context.location_label(), "Remote");
    assert_eq!(
        context.working_directory(),
        Path::new("/srv/remote/project")
    );
    assert_eq!(context.working_directory_label(), "/srv/remote/project");
}

#[test]
fn file_extension_selects_only_the_editor_language_contract() {
    assert_eq!(
        editor_language_for_path(Path::new("src/main.rs")),
        CodeEditorLanguage::Rust
    );
    assert_eq!(
        editor_language_for_path(Path::new("config/settings.jsonc")),
        CodeEditorLanguage::Jsonc
    );
    assert_eq!(
        editor_language_for_path(Path::new("README.md")),
        CodeEditorLanguage::PlainText
    );
}

#[test]
fn repository_relative_path_recovers_only_an_ancestor_root() {
    let working_directory = Path::new("repository/crates/desktop");

    assert_eq!(
        repository_root_from_path(working_directory, "crates/desktop"),
        Some("repository".into())
    );
    assert_eq!(
        repository_root_from_path(working_directory, "../desktop"),
        None
    );
    assert_eq!(
        repository_root_from_path(working_directory, "other/desktop"),
        None
    );
}

#[test]
fn repository_capture_builds_real_changed_file_diffs() {
    let root = std::env::temp_dir().join(format!(
        "app-env-context-{}-{}",
        std::process::id(),
        NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(&root, &["init", "--initial-branch=main"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.invalid"]);
    std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
    std::fs::write(root.join("deleted.txt"), "gone\n").unwrap();
    run_git(&root, &["add", "tracked.txt", "deleted.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    std::fs::write(root.join("tracked.txt"), "after\n").unwrap();
    std::fs::remove_file(root.join("deleted.txt")).unwrap();
    std::fs::write(root.join("untracked.txt"), "new\nfile\n").unwrap();

    let mut context = EnvironmentContext::capture(root.clone());
    context.apply_git_snapshot(Some(&git_client(&root).git_text_diff().unwrap()));

    assert_eq!(context.git_branch_label(), "main");
    assert_eq!(
        context.git_repository_root(),
        Some(root.canonicalize().unwrap().as_path())
    );
    assert_eq!(context.diff_summary_label(), "Changes 3 • +3 -2");
    let tracked = context
        .diffs()
        .iter()
        .find(|diff| diff.path() == "tracked.txt")
        .unwrap();
    assert!(!tracked.document().diff().hunks().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn switching_working_directory_replaces_path_and_repository_state() {
    let root = std::env::temp_dir().join(format!(
        "app-cwd-change-{}-{}",
        std::process::id(),
        NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let child = root.join("plain");
    std::fs::create_dir_all(&child).unwrap();
    let mut context = EnvironmentContext::capture_current();

    context.switch_working_directory(child.clone()).unwrap();

    assert_eq!(context.working_directory(), child.canonicalize().unwrap());
    assert_eq!(context.git_branch_label(), "No Git");
    assert_eq!(context.diff_summary_label(), "Changes —");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn switching_branch_refreshes_the_repository_state() {
    let root = std::env::temp_dir().join(format!(
        "app-branch-switch-{}-{}",
        std::process::id(),
        NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    run_git(&root, &["init", "--initial-branch=main"]);
    run_git(&root, &["config", "user.name", "Ash Test"]);
    run_git(&root, &["config", "user.email", "ash@example.invalid"]);
    std::fs::write(root.join("tracked.txt"), "main\n").unwrap();
    run_git(&root, &["add", "tracked.txt"]);
    run_git(&root, &["commit", "-m", "initial"]);
    run_git(&root, &["branch", "topic"]);
    let mut context = EnvironmentContext::capture_current();
    context.switch_working_directory(root.clone()).unwrap();
    let mut client = git_client(&root);
    let topic = client
        .list_git_branches()
        .unwrap()
        .branches
        .into_iter()
        .find(|branch| branch.name() == "topic")
        .unwrap();

    client
        .switch_git_branch(GitBranchSwitchParams {
            repository_id: None,
            name: topic.name().into(),
        })
        .unwrap();
    context.apply_git_snapshot(Some(&client.git_text_diff().unwrap()));

    assert_eq!(context.git_branch_label(), "topic");
    std::fs::remove_dir_all(root).unwrap();
}

fn git_client(root: &Path) -> AppServerClient<InProcessTransport> {
    let profile_root = std::env::temp_dir().join(format!(
        "app-env-context-profile-{}-{}",
        std::process::id(),
        NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed)
    ));
    start_in_process_client(
        InProcessClientOptions::new(
            profile_root,
            ClientInfo {
                name: "app-test".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
        )
        .with_dir_root(root),
    )
    .unwrap()
}

fn run_git(root: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
