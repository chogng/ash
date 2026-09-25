use super::BranchPanel;
use super::BranchSelectionAction;
use super::choices;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionOutcome;
use ash_app_server_protocol::protocol::git::GitBranchDto;
use ash_app_server_protocol::protocol::git::GitBranchListResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

#[test]
fn branch_picker_preselects_the_current_branch_and_preserves_its_identity() {
    let spec = choices(GitBranchListResult {
        branches: vec![branch("topic", false), branch("main", true)],
    });
    let mut picker = ListSelection::new(spec.model, spec.actions);
    assert_eq!(picker.state().title(), "Project branches");
    assert_eq!(picker.state().selected_item().unwrap().label(), "main");
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::Switch { name, current: true })
            if name == "main"
    ));
}

#[test]
fn branch_picker_shortcut_does_not_steal_search_input() {
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true)],
    }));
    panel.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    panel.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));
    assert!(!panel.is_branch_name_prompt());
    assert_eq!(panel.state().query(), "b");
}

#[test]
fn standalone_branch_prompt_prefills_ash_prefix_and_requires_a_suffix() {
    let mut panel = BranchPanel::new_branch();
    assert_eq!(panel.state().title(), "New branch");
    assert_eq!(panel.parent_title(), None);
    assert_eq!(panel.state().query(), "ash/");
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    for character in "topic".chars() {
        panel.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::CreateBranch {
            branch_name: "ash/topic".into()
        })
    );
    for _ in 0.."ash/topic".len() {
        panel.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
    }
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    assert_eq!(panel.state().message(), Some("Enter a branch name"));
    for character in "topic".chars() {
        panel.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::CreateBranch {
            branch_name: "topic".into()
        })
    );
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        ListSelectionOutcome::Dismiss
    );
}

#[test]
fn standalone_worktree_prompt_creates_only_a_checkout_command() {
    let mut panel = BranchPanel::new_worktree();
    assert_eq!(panel.state().title(), "New worktree");
    assert_eq!(panel.state().query(), "");
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    for character in "topic".chars() {
        panel.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::CreateWorktree {
            name: "topic".into()
        })
    );
}

#[test]
fn creating_a_worktree_through_app_server_leaves_session_catalog_unchanged() {
    use ash_app_server_client::{AppServerSession, InProcessClientOptions};
    use ash_app_server_protocol::protocol::common::ClientInfo;
    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["config", "user.name", "Ash Test"],
        vec!["config", "user.email", "ash@example.test"],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
    std::fs::write(repo.join("tracked.txt"), "base\n").unwrap();
    for args in [vec!["add", "tracked.txt"], vec!["commit", "-m", "initial"]] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
    let mut capabilities = crate::client_capabilities();
    capabilities.dir_permissions_host = None;
    let session = AppServerSession::start_embedded(
        InProcessClientOptions::new(
            root.path().join("state"),
            ClientInfo {
                name: "worktree-only-test".into(),
                version: "1".into(),
            },
        )
        .with_dir_root(repo.clone())
        .with_capabilities(capabilities),
    )
    .unwrap();
    let mut client = session.client();
    let before = client.list_sessions().unwrap().sessions;
    let created = super::execute(
        &mut client,
        super::Command::CreateWorktree {
            name: "topic".into(),
        },
    )
    .unwrap();
    let super::Event::WorktreeCreated(Ok(created)) = created else {
        panic!("worktree creation should succeed")
    };
    let checkout = std::path::PathBuf::from(created.path);
    assert_eq!(checkout, root.path().join("state/worktrees/manual/topic"));
    assert_eq!(
        std::fs::read_to_string(checkout.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert_eq!(client.list_sessions().unwrap().sessions, before);
}

#[test]
fn project_branch_picker_creates_a_branch_without_starting_a_task() {
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true)],
    }));
    assert_eq!(panel.state().selected_item().unwrap().label(), "main");
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    assert_eq!(panel.state().query(), "ash/");
    for character in "topic".chars() {
        panel.handle_key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
    }
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::CreateBranch {
            branch_name: "ash/topic".into()
        })
    );
}

#[test]
fn checked_out_branch_explains_why_it_cannot_switch() {
    let mut occupied = branch("topic", false);
    occupied.checked_out_elsewhere = Some(true);
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true), occupied],
    }));
    panel.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        panel.state().selected_item().unwrap().description(),
        Some("In another worktree")
    );
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    assert_eq!(
        panel.state().message(),
        Some("Branch is checked out in another worktree")
    );
}

#[test]
fn branch_picker_accepts_older_server_without_worktree_occupancy() {
    let result: GitBranchListResult = serde_json::from_value(serde_json::json!({
        "branches": [{
            "name": "main",
            "objectId": "abc123",
            "current": true,
            "upstream": null
        }]
    }))
    .unwrap();
    assert_eq!(result.branches[0].checked_out_elsewhere, None);
    let spec = choices(result);
    let mut picker = ListSelection::new(spec.model, spec.actions);
    assert_eq!(
        picker.state().selected_item().unwrap().description(),
        Some("Current")
    );
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::Switch { current: true, .. })
    ));
}

#[test]
fn older_server_shows_unknown_worktree_use_on_other_branches() {
    let mut topic = branch("topic", false);
    topic.checked_out_elsewhere = None;
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true), topic],
    }));
    panel.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        panel.state().selected_item().unwrap().description(),
        Some("Switch · worktree use unknown")
    );
}

#[test]
fn git_operation_error_is_explained_without_a_protocol_code() {
    let message = super::git_error_message(
        ash_app_server_client::ClientError::Server {
            code: -32061,
            message: "GitOperationFailed".into(),
        },
        super::GitAction::Switch,
    );
    assert_eq!(
        message,
        "Could not switch branch. Check uncommitted changes and worktree use."
    );
}

#[test]
fn old_server_reports_how_to_enable_branch_creation() {
    let message = super::git_error_message(
        ash_app_server_client::ClientError::Server {
            code: -32601,
            message: "MethodNotFound".into(),
        },
        super::GitAction::Create,
    );
    assert!(message.contains("Restart"));
}

fn branch(name: &str, current: bool) -> GitBranchDto {
    GitBranchDto {
        name: name.into(),
        object_id: format!("object-{name}"),
        current,
        upstream: None,
        checked_out_elsewhere: Some(false),
    }
}

#[test]
fn branch_commands_list_and_switch_the_real_workspace_repository() {
    use ash_app_server_client::InProcessClientOptions;
    use ash_app_server_client::start_in_process_client;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::git::GitHeadDto;
    let _guard = crate::test_support::in_process_test_guard();
    struct NoModel;
    impl ash_client::OperationClient for NoModel {
        fn execute(
            &self,
            _: &ash_client::ClientRequest,
        ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
            panic!("Git branch operations must not invoke a model")
        }
    }
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    run_git(&repo, &["init", "--initial-branch=main"]);
    run_git(&repo, &["config", "user.name", "Ash Test"]);
    run_git(&repo, &["config", "user.email", "ash@example.test"]);
    std::fs::write(repo.join("tracked.txt"), "base\n").unwrap();
    run_git(&repo, &["add", "tracked.txt"]);
    run_git(&repo, &["commit", "-m", "initial"]);
    run_git(&repo, &["branch", "topic"]);
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            root.path().join("state"),
            ClientInfo {
                name: "branch-picker-test".into(),
                version: "1".into(),
            },
        )
        .with_dir_root(repo.clone())
        .with_model_operation_client(std::sync::Arc::new(NoModel))
        .with_capabilities(crate::client_capabilities()),
    )
    .unwrap();

    let super::Event::PickerOpened(spec) =
        super::execute(&mut client, super::Command::OpenPicker).unwrap()
    else {
        panic!("branch listing must open the picker")
    };
    assert_eq!(spec.actions.len(), 3);
    let super::Event::SwitchFinished(result) = super::execute(
        &mut client,
        super::Command::Switch {
            name: "topic".into(),
        },
    )
    .unwrap() else {
        panic!("branch switching must return its status")
    };
    assert!(matches!(
        result.unwrap().head,
        GitHeadDto::Branch { name, .. } if name == "topic"
    ));
    let super::Event::CreateFinished { name, result } = super::execute(
        &mut client,
        super::Command::Create {
            name: "ash/new-topic".into(),
        },
    )
    .unwrap() else {
        panic!("branch creation must return the updated branch list")
    };
    assert_eq!(name, "ash/new-topic");
    let result = result.unwrap();
    assert!(result.branches.iter().any(|branch| branch.name == name));
    let spec = super::choices_after_create(result, &name).unwrap();
    let picker = ListSelection::new(spec.model, spec.actions);
    assert_eq!(picker.state().selected_item().unwrap().label(), name);
    assert_eq!(
        std::process::Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&repo)
            .output()
            .unwrap()
            .stdout,
        b"topic\n"
    );
    let linked = root.path().join("linked");
    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "linked-topic",
            linked.to_str().unwrap(),
            "main",
        ],
    );
    let super::Event::PickerOpened(spec) =
        super::execute(&mut client, super::Command::OpenPicker).unwrap()
    else {
        panic!("branch listing must reopen the picker")
    };
    assert!(spec.actions.values().any(|action| matches!(action,
        BranchSelectionAction::Occupied { name } if name == "linked-topic")));
}

fn run_git(root: &std::path::Path, arguments: &[&str]) {
    let output = std::process::Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
