use super::RootSelectionAction;
use super::root_choices;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionOutcome;
use ash_app_server_protocol::protocol::projects::ProjectDto;
use ash_app_server_protocol::protocol::projects::ProjectRootDto;
use ash_app_server_protocol::protocol::projects::ProjectStatusDto;
use ash_file_access::DirId;
use ash_file_access::EnvId;
use ash_protocol::ProjectId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::path::Path;

#[test]
fn project_root_picker_preselects_the_current_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let a = workspace.path().join("a");
    let b = workspace.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let project = ProjectDto {
        project_id: ProjectId::new("project").unwrap(),
        revision: 1,
        status: ProjectStatusDto::Active,
        name: "Ash".into(),
        description: String::new(),
        roots: vec![root("a", &a), root("b", &b)],
        session_ids: Vec::new(),
    };
    let spec = root_choices(&project, &b).unwrap();
    let mut picker = ListSelection::new(spec.model, spec.actions);
    assert_eq!(picker.state().title(), "Switch project folder");
    assert_eq!(picker.state().selected_item().unwrap().label(), "b");
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(RootSelectionAction::Switch { path, current: true })
            if path == b
    ));

    // Navigating to the last item selects the add folder action
    picker.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(
        picker.state().selected_item().unwrap().label(),
        "+ Add folder to project…"
    );
    assert!(matches!(
        picker.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Activate(RootSelectionAction::Add)
    ));
}

fn root(seed: &str, path: &Path) -> ProjectRootDto {
    ProjectRootDto {
        environment_id: EnvId::local(),
        dir_id: format!("sha256:{}", seed.repeat(64))
            .parse::<DirId>()
            .unwrap(),
        path: url::Url::from_file_path(path)
            .unwrap()
            .as_str()
            .parse()
            .unwrap(),
        name: seed.into(),
        purpose: String::new(),
    }
}

#[test]
fn adding_a_project_root_persists_project_identity_and_keeps_permissions_explicit() {
    use ash_app_server_client::InProcessClientOptions;
    use ash_app_server_client::start_in_process_client;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::environment::SessionDirListParams;
    use ash_app_server_protocol::protocol::projects::ProjectReadParams;
    let _guard = crate::test_support::in_process_test_guard();
    struct NoModel;
    impl ash_client::OperationClient for NoModel {
        fn execute(
            &self,
            _: &ash_client::ClientRequest,
        ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
            panic!("Project directory operations must not invoke a model")
        }
    }
    let root = tempfile::tempdir().unwrap();
    let primary = root.path().join("primary");
    let extra = root.path().join("extra");
    std::fs::create_dir(&primary).unwrap();
    std::fs::create_dir(&extra).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            root.path().join("state"),
            ClientInfo {
                name: "project-root-test".into(),
                version: "1".into(),
            },
        )
        .with_dir_root(primary.clone())
        .with_model_operation_client(std::sync::Arc::new(NoModel))
        .with_capabilities(crate::client_capabilities()),
    )
    .unwrap();
    let conversation =
        crate::sessions::ActiveConversation::start(&mut client, "project".into()).unwrap();
    let session_id = conversation.session_id().clone();

    let super::Event::AddRootFinished { result, .. } = super::execute(
        &mut client,
        &primary,
        Some(&session_id),
        super::Command::AddRoot {
            request_id: 7,
            path: extra.clone(),
        },
    )
    .unwrap() else {
        panic!("the Project root operation must complete inline")
    };
    let added = result.unwrap();
    assert_eq!(
        added.path.canonicalize().unwrap(),
        extra.canonicalize().unwrap()
    );
    assert!(!added.already_present);

    let projects = client.list_projects().unwrap();
    assert_eq!(projects.projects.len(), 1);
    let project = client
        .read_project(ProjectReadParams {
            project_id: projects.projects[0].project_id.clone(),
        })
        .unwrap()
        .project;
    assert_eq!(project.roots.len(), 2);
    assert!(project.session_ids.contains(&session_id));
    let primary_path = primary.canonicalize().unwrap();
    let added_path = added.path.canonicalize().unwrap();
    assert!(project.roots.iter().any(|root| {
        root.path
            .to_host_path()
            .unwrap()
            .as_path()
            .canonicalize()
            .unwrap()
            == primary_path
    }));
    assert!(project.roots.iter().any(|root| {
        root.path
            .to_host_path()
            .unwrap()
            .as_path()
            .canonicalize()
            .unwrap()
            == added_path
    }));

    let directories = client
        .list_session_dirs(SessionDirListParams { session_id })
        .unwrap();
    let added_dir = directories
        .dirs
        .iter()
        .find(|dir| dir.path == added.path)
        .unwrap();
    assert!(added_dir.permissions.is_empty());

    let super::Event::AddRootFinished { result, .. } = super::execute(
        &mut client,
        &primary,
        Some(conversation.session_id()),
        super::Command::AddRoot {
            request_id: 8,
            path: extra,
        },
    )
    .unwrap() else {
        panic!("repeating the Project root operation must complete inline")
    };
    assert!(result.unwrap().already_present);
    assert_eq!(client.list_projects().unwrap().projects.len(), 1);
}
