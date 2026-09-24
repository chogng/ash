use super::DirSelectionAction;
use super::choices;
use crate::widgets::list_selection::ListSelectionInputOutcome;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_protocol::protocol::environment::PermissionDto;
use ash_app_server_protocol::protocol::environment::SessionDirDto;
use ash_app_server_protocol::protocol::environment::SessionDirListResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::path::PathBuf;

fn panel(paths: &[&str]) -> super::DirPanel {
    super::DirPanel::new(panel_choices(paths))
}

fn panel_choices(paths: &[&str]) -> super::DirChoices {
    choices(
        &ash_protocol::SessionId::new("session").unwrap(),
        SessionDirListResult {
            revision: 1,
            dirs: paths
                .iter()
                .map(|path| SessionDirDto {
                    path: PathBuf::from(path),
                    permissions: Vec::new(),
                    contributions: Default::default(),
                })
                .collect(),
        },
    )
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn submit(panel: &mut super::DirPanel, path: &str) -> u64 {
    panel.handle_key(key(KeyCode::Char('/')));
    panel.handle_paste(path.into());
    let crate::widgets::list_selection::ListSelectionOutcome::Activate(DirSelectionAction::Add {
        request_id,
        path: submitted,
        target: super::DirAddTarget::Session,
    }) = panel.handle_key(key(KeyCode::Enter))
    else {
        panic!("Enter must submit the directory path");
    };
    assert_eq!(submitted, PathBuf::from(path));
    request_id
}

#[test]
fn adding_keeps_existing_items_visible_and_focuses_the_confirmed_directory() {
    use crate::widgets::list_selection::ListSelectionOutcome;
    let mut panel = panel(&["/dir/old"]);
    let request_id = submit(&mut panel, "/dir/new  folder");
    assert_eq!(panel.state().visible_items().len(), 16);
    assert_eq!(panel.state().message(), Some("Adding directory…"));
    assert_eq!(
        panel.key_hints().text(),
        crate::keymap::bindings::CLOSE_HINTS.text()
    );
    assert_eq!(
        panel.handle_key(key(KeyCode::Enter)),
        ListSelectionOutcome::Consumed
    );
    panel.handle_paste("ignored".into());
    assert_eq!(panel.state().query(), "/dir/new  folder");

    panel.finish_add(
        request_id,
        Ok(super::AddedDir {
            path: "/dir/new  folder".into(),
            already_present: false,
            choices: panel_choices(&["/dir/old", "/dir/new  folder"]),
        }),
    );
    assert_eq!(panel.state().active_tab().label(), "/dir/new  folder");
    assert_eq!(panel.state().query(), "");
    assert!(!panel.state().search().unwrap().input_active());
    assert_eq!(panel.state().selected_item().unwrap().label(), "Read files");
    assert!(
        matches!(panel.handle_key(key(KeyCode::Enter)), ListSelectionOutcome::Activate(DirSelectionAction::SetPermissions(params)) if params.path == PathBuf::from("/dir/new  folder"))
    );
}

#[test]
fn project_folder_panel_starts_in_path_input_and_emits_a_project_add() {
    let choices = super::project_choices(
        &ash_protocol::SessionId::new("session").unwrap(),
        SessionDirListResult {
            revision: 0,
            dirs: Vec::new(),
        },
    );
    let mut panel = super::DirPanel::for_target(choices, super::DirAddTarget::Project);
    assert!(panel.state().search().unwrap().input_active());
    panel.handle_paste("/work/extra".into());
    assert!(matches!(
        panel.handle_key(key(KeyCode::Enter)),
        crate::widgets::list_selection::ListSelectionOutcome::Activate(
            DirSelectionAction::Add {
                path,
                target: super::DirAddTarget::Project,
                ..
            }
        ) if path == PathBuf::from("/work/extra")
    ));
}

#[test]
fn failed_add_preserves_input_and_can_retry_without_accepting_stale_results() {
    let mut panel = panel(&[]);
    let first = submit(&mut panel, "/dir/missing");
    panel.finish_add(first, Err("Directory does not exist".into()));
    assert_eq!(panel.state().query(), "/dir/missing");
    assert!(panel.state().search().unwrap().input_active());
    assert_eq!(panel.state().message(), Some("Directory does not exist"));
    assert!(panel.key_hints().text().contains("add"));
    let crate::widgets::list_selection::ListSelectionOutcome::Activate(DirSelectionAction::Add {
        request_id: second,
        ..
    }) = panel.handle_key(key(KeyCode::Enter))
    else {
        panic!("retry must submit")
    };
    assert_ne!(first, second);
    panel.finish_add(first, Err("stale".into()));
    assert_eq!(panel.state().message(), Some("Adding directory…"));
    panel.finish_add(
        second,
        Ok(super::AddedDir {
            path: "/dir/missing".into(),
            already_present: true,
            choices: panel_choices(&["/dir/missing"]),
        }),
    );
    assert_eq!(
        panel.state().message(),
        Some("Directory already added: /dir/missing")
    );
}

#[test]
fn closing_pending_add_does_not_change_a_reopened_panel() {
    use crate::app::App;
    use crate::app::AppCommand;
    let mut app = App::new();
    app.update(super::Event::PickerOpened(panel_choices(&[])));
    app.handle_key(key(KeyCode::Char('/')));
    for c in "/dir/new".chars() {
        app.handle_key(key(KeyCode::Char(c)));
    }
    let Some(AppCommand::Dirs(super::Command::Add { request_id, path })) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("app must route add")
    };
    app.handle_key(key(KeyCode::Esc));
    assert!(app.list_selection().is_none());
    app.update(super::Event::PickerOpened(panel_choices(&[])));
    app.update(super::Event::AddCompleted {
        request_id,
        result: Ok(super::AddedDir {
            path,
            already_present: false,
            choices: panel_choices(&["/dir/new"]),
        }),
    });
    assert!(app.list_selection().unwrap().visible_items().is_empty());
    assert_eq!(app.list_selection().unwrap().message(), None);
}

#[test]
fn app_add_completion_refreshes_the_open_panel_and_moves_focus() {
    use crate::app::App;
    use crate::app::AppCommand;
    let mut app = App::new();
    app.update(super::Event::PickerOpened(panel_choices(&[])));
    app.handle_key(key(KeyCode::Char('/')));
    for character in "/dir/new".chars() {
        app.handle_key(key(KeyCode::Char(character)));
    }
    let Some(AppCommand::Dirs(super::Command::Add { request_id, path })) =
        app.handle_key(key(KeyCode::Enter))
    else {
        panic!("Enter must reach the directory request dispatcher");
    };
    assert!(app.handle_key(key(KeyCode::Enter)).is_none());
    app.update(super::Event::AddCompleted {
        request_id,
        result: Ok(super::AddedDir {
            path,
            already_present: false,
            choices: panel_choices(&["/dir/new"]),
        }),
    });
    let view = app.list_selection().unwrap();
    assert_eq!(view.query(), "");
    assert_eq!(view.message(), Some("Added directory: /dir/new"));
    assert!(!view.search().unwrap().input_active());
    assert_eq!(view.selected_item().unwrap().label(), "Read files");
}

#[test]
fn empty_and_multiline_paths_are_rejected_without_a_request() {
    use crate::widgets::list_selection::ListSelectionOutcome;
    let mut panel = panel(&[]);
    panel.handle_key(key(KeyCode::Char('/')));
    assert_eq!(
        panel.handle_key(key(KeyCode::Enter)),
        ListSelectionOutcome::Consumed
    );
    assert_eq!(panel.state().message(), Some("Enter a directory path"));
    panel.handle_paste("/dir/a\n/dir/b".into());
    assert_eq!(panel.state().query(), "");
    assert_eq!(
        panel.state().message(),
        Some("Enter one directory path without control characters")
    );
}

#[test]
fn directory_add_feedback_is_visible_below_the_input() {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    let mut panel = panel(&[]);
    let request_id = submit(&mut panel, "/dir/new");
    let mut terminal = Terminal::new(TestBackend::new(72, 8)).unwrap();
    let draw = |terminal: &mut Terminal<TestBackend>, panel: &super::DirPanel| {
        terminal
            .draw(|frame| {
                crate::widgets::list_selection::draw_body_with_pointer(
                    frame,
                    frame.area(),
                    panel.state(),
                    None,
                    None,
                    crate::render::test_context(),
                )
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .chunks(72)
            .map(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let pending = draw(&mut terminal, &panel);
    panel.finish_add(
        request_id,
        Ok(super::AddedDir {
            path: "/dir/new".into(),
            already_present: false,
            choices: panel_choices(&["/dir/new"]),
        }),
    );
    let added = draw(&mut terminal, &panel);
    assert!(pending.contains("Adding directory…\nNo directories"));
    assert!(added.contains("Added directory: /dir/new"));
    assert!(!added.contains("No directories"));
    crate::tui_assert_snapshot!(
        "directory_add_feedback",
        format!("Pending:\n{pending}\n\nAdded:\n{added}")
    );
}

#[test]
fn panel_add_uses_server_paths_preserves_permissions_and_reports_missing_directories() {
    use ash_app_server_client::InProcessClientOptions;
    use ash_app_server_client::start_in_process_client;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use ash_app_server_protocol::protocol::environment::SessionDirPermissionsSetParams;
    let _guard = crate::test_support::in_process_test_guard();
    struct NoModel;
    impl ash_client::OperationClient for NoModel {
        fn execute(
            &self,
            _: &ash_client::ClientRequest,
        ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
            panic!("directory operations must not invoke a model")
        }
    }
    let root = tempfile::tempdir().unwrap();
    let primary = root.path().join("primary");
    let extra = root.path().join("extra  folder");
    std::fs::create_dir(&primary).unwrap();
    std::fs::create_dir(&extra).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            root.path().join("state"),
            ClientInfo {
                name: "directory-panel-test".into(),
                version: "1".into(),
            },
        )
        .with_dir_root(primary)
        .with_model_operation_client(std::sync::Arc::new(NoModel))
        .with_capabilities(crate::client_capabilities()),
    )
    .unwrap();
    let conversation =
        crate::sessions::ActiveConversation::start(&mut client, "directories".into()).unwrap();
    let session = conversation.session_id();
    let mut panel = super::DirPanel::new(super::load_selection(&mut client, session).unwrap());
    let request_id = submit(&mut panel, "../extra  folder");
    let super::Event::AddCompleted { result, .. } = super::execute(
        &mut client,
        session,
        super::Command::Add {
            request_id,
            path: "../extra  folder".into(),
        },
    )
    .unwrap() else {
        panic!("add returns its completion")
    };
    let added = result.unwrap();
    let canonical = added.path.clone();
    assert_eq!(
        canonical.canonicalize().unwrap(),
        extra.canonicalize().unwrap()
    );
    panel.finish_add(request_id, Ok(added));
    assert_eq!(
        panel.state().active_tab().label(),
        canonical.display().to_string()
    );
    assert!(!panel.state().search().unwrap().input_active());
    let updated = client
        .set_session_dir_permissions(SessionDirPermissionsSetParams {
            session_id: session.clone(),
            path: canonical.clone(),
            expected_revision: 1,
            permissions: vec![PermissionDto::ReadFiles],
        })
        .unwrap();
    assert_eq!(updated.dirs[0].permissions, vec![PermissionDto::ReadFiles]);

    let repeated = super::add(&mut client, session, "../extra  folder/.".into()).unwrap();
    assert_eq!(repeated.path, canonical);
    assert!(repeated.already_present);
    let listed = client
        .list_session_dirs(
            ash_app_server_protocol::protocol::environment::SessionDirListParams {
                session_id: session.clone(),
            },
        )
        .unwrap();
    assert_eq!(listed.dirs.len(), 1);
    assert_eq!(listed.dirs[0].permissions, vec![PermissionDto::ReadFiles]);
    let super::Event::AddCompleted { result, .. } = super::execute(
        &mut client,
        session,
        super::Command::Add {
            request_id: 99,
            path: "../missing".into(),
        },
    )
    .unwrap() else {
        panic!("failed add must return an inline completion")
    };
    assert!(result.is_err());
    let empty = super::remove(&mut client, session, canonical).unwrap();
    assert!(empty.actions.is_empty());
}

#[test]
fn empty_directories_open_and_dismiss_without_an_action() {
    let view = choices(
        &ash_protocol::SessionId::new("session").unwrap(),
        SessionDirListResult {
            revision: 0,
            dirs: Vec::new(),
        },
    );
    assert!(view.actions.is_empty());
    let mut state = ListSelectionState::new(view.model);
    assert!(!state.show_tabs());
    assert!(state.visible_items().is_empty());
    assert_eq!(state.empty_message(), "No directories");
    assert_eq!(state.selected_visible_index(), None);
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionInputOutcome::Consumed,
    );
    assert_eq!(
        state.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        ListSelectionInputOutcome::Dismiss,
    );
}

#[test]
fn every_directory_is_reachable_and_removing_the_last_clears_selection() {
    let session = ash_protocol::SessionId::new("session").unwrap();
    let view = choices(
        &session,
        SessionDirListResult {
            revision: 3,
            dirs: ["/dir/first", "/dir/second"]
                .map(|path| SessionDirDto {
                    contributions: Default::default(),
                    path: PathBuf::from(path),
                    permissions: Vec::new(),
                })
                .to_vec(),
        },
    );
    let mut state = ListSelectionState::new(view.model);
    assert!(state.show_tabs());
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let ListSelectionInputOutcome::Activate(id) =
        state.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    else {
        panic!("the second directory must be selectable")
    };
    assert_eq!(
        view.actions.get(&id),
        Some(&DirSelectionAction::Remove {
            path: PathBuf::from("/dir/second"),
        })
    );
    let empty = choices(
        &session,
        SessionDirListResult {
            revision: 4,
            dirs: Vec::new(),
        },
    );
    state.replace_model(empty.model);
    assert!(!state.show_tabs());
    assert!(state.visible_items().is_empty());
    assert_eq!(state.selected_visible_index(), None);
}

#[test]
fn dir_view_maps_exact_paths_to_remove_actions() {
    let view = choices(
        &ash_protocol::SessionId::new("session").unwrap(),
        SessionDirListResult {
            revision: 3,
            dirs: vec![SessionDirDto {
                contributions: Default::default(),
                path: PathBuf::from("/dir/shared"),
                permissions: vec![PermissionDto::ReadFiles],
            }],
        },
    );

    let state = ListSelectionState::new(view.model);
    assert_eq!(state.title(), "Directories");
    assert!(matches!(
        view.actions
            .get(state.visible_items()[0].id().unwrap()),
        Some(DirSelectionAction::Remove { path })
            if path == &PathBuf::from("/dir/shared")
    ));
    assert!(matches!(
        view.actions
            .get(state.visible_items()[1].id().unwrap()),
        Some(DirSelectionAction::SetPermissions(params))
            if params.session_id.as_str() == "session"
                && params.expected_revision == 3
                && params.permissions.is_empty()
    ));
}

#[test]
fn move_session_adds_directory_and_updates_cwd() {
    use ash_app_server_client::InProcessClientOptions;
    use ash_app_server_client::start_in_process_client;
    use ash_app_server_protocol::protocol::common::ClientInfo;
    use std::sync::Arc;
    struct NoModel;
    impl ash_client::OperationClient for NoModel {
        fn execute(
            &self,
            _: &ash_client::ClientRequest,
        ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
            panic!("Directory operations must not invoke a model")
        }
    }
    let _guard = crate::test_support::in_process_test_guard();
    let root = tempfile::tempdir().unwrap();
    let primary = root.path().join("primary");
    let target = root.path().join("target");
    std::fs::create_dir_all(&primary).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    let mut client = start_in_process_client(
        InProcessClientOptions::new(
            root.path().join("state"),
            ClientInfo {
                name: "dir-move-test".into(),
                version: "1".into(),
            },
        )
        .with_dir_root(primary.clone())
        .with_model_operation_client(Arc::new(NoModel))
        .with_capabilities(crate::client_capabilities()),
    )
    .unwrap();
    let conversation =
        crate::sessions::ActiveConversation::start(&mut client, "test".into()).unwrap();
    let session_id = conversation.session_id().clone();

    let event = super::execute(
        &mut client,
        &session_id,
        super::Command::MoveSession {
            path: target.clone(),
        },
    )
    .unwrap();

    let super::Event::Moved { path } = event else {
        panic!("execute MoveSession must return Event::Moved");
    };
    assert_eq!(path.canonicalize().unwrap(), target.canonicalize().unwrap());
}
