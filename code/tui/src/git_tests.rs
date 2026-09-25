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
    assert_eq!(picker.state().title(), "Project branches and worktrees");
    assert_eq!(picker.state().selected_item().unwrap().label(), "main");
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::Switch { name, current: true })
            if name == "main"
    ));
}

#[test]
fn branch_picker_exposes_both_worktree_actions() {
    let spec = choices(GitBranchListResult {
        branches: vec![branch("main", true), branch("topic", false)],
    });
    let mut picker = ListSelection::new(spec.model, spec.actions);
    for _ in 0..2 {
        picker.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    }
    assert_eq!(
        picker.state().selected_item().unwrap().label(),
        "New worktree"
    );
    assert_eq!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::NewWorktree)
    );
    picker.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        picker.state().selected_item().unwrap().label(),
        "New branch"
    );
    assert_eq!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::NewBranch)
    );
}

#[test]
fn branch_picker_shortcuts_create_or_open_branch_prompt_without_stealing_search_input() {
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true)],
    }));
    assert!(panel.key_hints().text().contains("w New worktree"));
    assert!(panel.key_hints().text().contains("b New branch"));
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction::NewWorktree)
    );
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
    assert!(panel.is_worktree_name_prompt());
    assert_eq!(panel.state().query(), "ash/");
    panel.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    panel.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    panel.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));
    assert!(!panel.is_worktree_name_prompt());
    assert_eq!(panel.state().query(), "b");
}

#[test]
fn worktree_name_prompt_prefills_ash_prefix_and_requires_a_suffix() {
    let mut panel = BranchPanel::new(choices(GitBranchListResult {
        branches: vec![branch("main", true)],
    }));
    panel.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(
        panel.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    );
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
}

fn branch(name: &str, current: bool) -> GitBranchDto {
    GitBranchDto {
        name: name.into(),
        object_id: format!("object-{name}"),
        current,
        upstream: None,
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
    assert_eq!(spec.actions.len(), 4);
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
