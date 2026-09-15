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
    assert_eq!(picker.state().title(), "Switch branch");
    assert_eq!(picker.state().selected_item().unwrap().label(), "main");
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(BranchSelectionAction { name, current: true })
            if name == "main"
    ));
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
    assert_eq!(spec.actions.len(), 2);
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
