use std::collections::HashSet;
use std::time::Instant;

use ash_diff::DiffDocument;
use ash_editor::CodeEditorLanguage;
use ash_editor::CodeEditorStyle;
use ash_editor::DiffEditorDocument;
use ash_scm::CHANGES_PANE;
use ash_scm::CHANGES_TOOLBAR;
use ash_scm::ChangesActivation;
use ash_scm::ChangesToolbarAction;
use ash_scm::MULTI_DIFF_EDITOR;
use ash_scm::ScmDiff;
use ash_scm::ScmPaneIdentity;
use ash_scm::ScmState;
use zui::ui::ElementId;
use zui::ui::Point;
use zui::ui::Size;
use zui::ui::UiDispatch;
use zui::ui::UiIntent;

use crate::PaneBinding;
use crate::PaneInput;
use crate::PaneSplitDirection;
use crate::TabInput;
use crate::TabInputKey;
use crate::TabInputMetadata;
use crate::WorkbenchHost;

fn changes(owner: u32) -> ScmState {
    let mut state = ScmState::new(ScmPaneIdentity::new(owner));
    state.set_branch(Some("main"));
    state.replace_diffs((0..12).map(|index| {
        ScmDiff::new(
            format!("file-{index}.txt"),
            DiffEditorDocument::new(
                DiffDocument::from_text("old\n", "new\n").unwrap(),
                CodeEditorLanguage::PlainText,
            ),
        )
    }));
    state
}

fn host() -> (
    WorkbenchHost<PaneBinding>,
    TabInputKey,
    crate::PaneKey,
    crate::PaneKey,
) {
    let session = ash_protocol::SessionId::new("scm-panes").unwrap();
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        TabInput::session(session, TabInputMetadata::new("Changes")),
        PaneInput::diff("/fixture".into()),
        || PaneBinding::changes(changes(1)),
    );
    let first = host.active_mount().unwrap().key().clone();
    let state = host
        .binding(&first)
        .unwrap()
        .scm()
        .unwrap()
        .duplicate(ScmPaneIdentity::new(2));
    let second = host
        .try_split_active_with(
            PaneInput::diff("/fixture".into()),
            PaneSplitDirection::Horizontal,
            || Ok::<_, std::convert::Infallible>(PaneBinding::changes(state)),
        )
        .unwrap()
        .unwrap();
    (host, tab, first, second)
}

fn frame(
    host: &WorkbenchHost<PaneBinding>,
    width: u32,
    dispatch: &UiDispatch,
) -> crate::WorkbenchPresentation {
    let tab = host.workbench().sidebar_part().active_tab_key().unwrap();
    let part = host.workbench().pane_part(tab).unwrap();
    let mounts = part
        .group_ids()
        .into_iter()
        .map(|pane| host.mount(tab, pane).unwrap())
        .collect::<Vec<_>>();
    let mut terminal = ash_terminal::TerminalCore::new(ash_terminal::GridSize::new(24, 80));
    terminal.process_output(b"pane terminal output");
    let terminals = mounts
        .iter()
        .filter(|mount| mount.kind() == crate::PaneInputKind::Terminal)
        .map(|mount| crate::PaneView {
            pane_id: Some(mount.pane_id()),
            core: Some(&terminal),
            scroll_offset: 0,
            scrollbar_presentation: Default::default(),
            selection: None,
        })
        .collect::<Vec<_>>();
    crate::presentation::build_workbench_presentation(
        crate::LogicalViewport {
            width: width as f32,
            height: 700.0,
        },
        crate::WorkbenchPresentationModel {
            app_name: "app",
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &terminals,
            pane_group: Some(part),
            pane_mounts: &mounts,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: Default::default(),
            terminal_selection: None,
            main_surface: crate::MainSurfaceKind::Agent,
            file_editor_host: &ash_editor_host::FileEditorHost::default(),
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &CodeEditorStyle::light(),
            session_pane: &ash_session::SessionPaneState::default(),
            environment_context: crate::EnvironmentContextView {
                location: "Local",
                working_directory: "/fixture",
                git_branch: "main",
                diff_summary: "Changes".into(),
                upstream_distance: None,
            },
            session_search: &crate::SessionSearchState::default(),
            sidebar_part: host.workbench().sidebar_part(),
            active_tab_input: Some(tab),
            caret_visibility: zui::ui::CaretVisibility::Hidden,
            dispatch,
            tab_container: crate::TabContainerState::collapsed(),
            inspector_part: Default::default(),
            files: &ash_files::FilesState::default(),
            tab_context_menu: Default::default(),
            git_branch_picker: &ash_scm::GitBranchPickerState::default(),
            directory_picker: &crate::directory_picker::DirectoryPickerState::default(),
            remote_connection_picker: &ash_settings::RemoteConnectionPickerState::default(),
            remote_connection_manager: &ash_settings::RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &ash_settings::RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &crate::keybindings::WorkbenchKeybindings::default(),
            quick_access: &crate::QuickAccess::default(),
            settings: &ash_settings::SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: zui::window::WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut zui::ui::TextInputLayoutEngine::default(),
    )
}

#[test]
fn two_changes_panes_have_disjoint_interaction_and_animation_identities() {
    let (host, tab, first, second) = host();
    let dispatch = UiDispatch::default();
    let frame = frame(&host, 1200, &dispatch);
    let part = host.workbench().pane_part(&tab).unwrap();
    let ids = frame
        .interaction_frame()
        .accessibility_nodes(&dispatch)
        .iter()
        .map(|node| node.id)
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), ids.iter().copied().collect::<HashSet<_>>().len());
    for key in [&first, &second] {
        let scm = host.binding(key).unwrap().scm().unwrap();
        let root = scm.identity().element(CHANGES_PANE);
        assert_eq!(frame.pane_for_element(part, root), Some(key.pane()));
        let bounds = frame.element_bounds(root).unwrap();
        assert_eq!(bounds.size.width, 600.0);
        assert_eq!(bounds.size.height, 668.0);
        let identity = scm.editor().section_identities().next().unwrap();
        assert_eq!(
            frame.pane_for_element(part, identity.header_id()),
            Some(key.pane())
        );
    }
    let left = host
        .binding(&first)
        .unwrap()
        .scm()
        .unwrap()
        .editor()
        .section_identities()
        .next()
        .unwrap();
    let right = host
        .binding(&second)
        .unwrap()
        .scm()
        .unwrap()
        .editor()
        .section_identities()
        .next()
        .unwrap();
    assert_ne!(left.fold_animation_key(), right.fold_animation_key());
}

#[test]
fn changes_pointer_and_keyboard_focus_resolve_the_owning_group() {
    let (mut host, tab, first, second) = host();
    let mut dispatch = UiDispatch::default();
    let presentation = frame(&host, 1200, &dispatch);
    for key in [&first, &second] {
        let scm = host.binding(key).unwrap().scm().unwrap();
        let action = scm.identity().element(ElementId::scoped(29, 7));
        let bounds = presentation.element_bounds(action).unwrap();
        let point = Point::new(bounds.origin.x + 5.0, bounds.origin.y + 5.0);
        dispatch.pointer_moved(point, presentation.interaction_frame());
        dispatch.press_primary(presentation.interaction_frame());
        assert_eq!(
            dispatch
                .release_primary(point, presentation.interaction_frame())
                .intent,
            Some(UiIntent::Activate(action))
        );
        let group = presentation
            .pane_at(host.workbench().pane_part(&tab).unwrap(), point)
            .unwrap();
        assert_eq!(group, key.pane());
        host.activate_pane(&tab, group);
        assert_eq!(
            host.binding_mut(key)
                .unwrap()
                .scm_mut()
                .unwrap()
                .activate(action),
            ChangesActivation::Changed
        );
        dispatch.focus_element(presentation.interaction_frame(), action);
        assert_eq!(
            presentation.pane_for_element(
                host.workbench().pane_part(&tab).unwrap(),
                dispatch.focused().unwrap()
            ),
            Some(key.pane())
        );
    }
    assert_eq!(host.focus_previous_pane(&tab), Some(first.pane()));
    assert_eq!(host.focus_next_pane(&tab), Some(second.pane()));
}

#[test]
fn changes_scroll_fold_and_toolbar_state_survive_resize_and_group_switching() {
    let (mut host, tab, first, second) = host();
    let dispatch = UiDispatch::default();
    let before = frame(&host, 1200, &dispatch);
    let first_identity = host
        .binding(&first)
        .unwrap()
        .scm()
        .unwrap()
        .editor()
        .section_identities()
        .next()
        .unwrap();
    let second_identity = host
        .binding(&second)
        .unwrap()
        .scm()
        .unwrap()
        .editor()
        .section_identities()
        .next()
        .unwrap();
    let second_y = before
        .element_bounds(second_identity.header_id())
        .unwrap()
        .origin
        .y;
    host.binding_mut(&first)
        .unwrap()
        .scm_mut()
        .unwrap()
        .editor_mut()
        .scroll(12.0, Size::new(600.0, 628.0), Instant::now());
    let after = frame(&host, 1200, &dispatch);
    assert!(
        after
            .element_bounds(first_identity.header_id())
            .unwrap()
            .origin
            .y
            < before
                .element_bounds(first_identity.header_id())
                .unwrap()
                .origin
                .y
    );
    assert_eq!(
        after
            .element_bounds(second_identity.header_id())
            .unwrap()
            .origin
            .y,
        second_y
    );
    let first_state = host.binding_mut(&first).unwrap().scm_mut().unwrap();
    first_state
        .toolbar_mut()
        .activate(Some(ChangesToolbarAction::SelectScope(
            ash_scm::ChangesScope::Unstaged,
        )));
    first_state.editor_mut().set_all_expanded(false);
    assert_eq!(
        host.binding(&second)
            .unwrap()
            .scm()
            .unwrap()
            .toolbar()
            .scope(),
        ash_scm::ChangesScope::CurrentTurn
    );
    host.activate_pane(&tab, first.pane());
    let narrow = frame(&host, 700, &dispatch);
    assert!(
        narrow
            .element_bounds(
                host.binding(&first)
                    .unwrap()
                    .scm()
                    .unwrap()
                    .identity()
                    .element(CHANGES_PANE)
            )
            .is_some()
    );
    assert!(
        narrow
            .element_bounds(
                host.binding(&second)
                    .unwrap()
                    .scm()
                    .unwrap()
                    .identity()
                    .element(CHANGES_PANE)
            )
            .is_none()
    );
    assert_eq!(
        host.workbench().pane_part(&tab).unwrap().group_ids().len(),
        2
    );
    host.activate_pane(&tab, second.pane());
    let narrow = frame(&host, 700, &dispatch);
    assert_eq!(
        narrow
            .element_bounds(
                host.binding(&second)
                    .unwrap()
                    .scm()
                    .unwrap()
                    .identity()
                    .element(CHANGES_PANE)
            )
            .unwrap()
            .size
            .width,
        700.0
    );
    let wide = frame(&host, 1200, &dispatch);
    assert!(
        wide.element_bounds(
            host.binding(&first)
                .unwrap()
                .scm()
                .unwrap()
                .identity()
                .element(CHANGES_TOOLBAR)
        )
        .is_some()
    );
    assert!(
        wide.element_bounds(
            host.binding(&second)
                .unwrap()
                .scm()
                .unwrap()
                .identity()
                .element(MULTI_DIFF_EDITOR)
        )
        .is_some()
    );
    assert_eq!(
        host.binding(&first)
            .unwrap()
            .scm()
            .unwrap()
            .toolbar()
            .scope(),
        ash_scm::ChangesScope::Unstaged
    );
    let closed = host.close_active_pane().unwrap();
    assert_eq!(closed.into_bindings().len(), 1);
    assert!(host.binding(&second).is_none());
    assert!(host.binding(&first).is_some());
    assert_eq!(host.active_mount().unwrap().key(), &first);
}

#[test]
fn changes_agent_and_terminal_share_one_geometry_and_keep_their_own_input_regions() {
    let (mut host, tab, first, second) = host();
    let session = tab.session_id().unwrap().clone();
    host.open_or_activate_input_with(
        &tab,
        second.pane(),
        PaneInput::terminal(session.clone()),
        PaneBinding::new,
    )
    .unwrap();
    host.activate_pane(&tab, first.pane());
    let agent = host
        .try_split_active_with(
            PaneInput::agent(session, ash_protocol::ThreadId::new("thread").unwrap()),
            PaneSplitDirection::Vertical,
            || Ok::<_, std::convert::Infallible>(PaneBinding::new()),
        )
        .unwrap()
        .unwrap();
    let presentation = frame(&host, 1200, &UiDispatch::default());
    let part = host.workbench().pane_part(&tab).unwrap();
    let scm = host.binding(&first).unwrap().scm().unwrap();
    let diff_bounds = presentation
        .element_bounds(scm.identity().element(CHANGES_PANE))
        .unwrap();
    let terminal_bounds = presentation
        .element_bounds(crate::pane_group_element_id(second.pane()))
        .unwrap();
    let composer = presentation
        .element_bounds(ash_session::interaction::COMPOSER)
        .unwrap();
    assert_eq!(diff_bounds.size, Size::new(600.0, 334.0));
    assert_eq!(terminal_bounds.size, Size::new(600.0, 668.0));
    assert!(composer.origin.y >= (diff_bounds.origin.y + diff_bounds.size.height));
    assert_eq!(
        presentation.pane_for_element(part, ash_session::interaction::COMPOSER),
        Some(agent.pane())
    );
    assert_eq!(
        presentation.pane_at(
            part,
            Point::new(
                terminal_bounds.origin.x + 20.0,
                terminal_bounds.origin.y + 20.0
            )
        ),
        Some(second.pane())
    );
    let terminal_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .filter(|block| block.origin().x >= terminal_bounds.origin.x)
        .map(|block| block.text())
        .collect::<String>();
    assert!(
        terminal_text.contains("pane terminal output"),
        "{terminal_text}"
    );
}

#[test]
fn terminal_toggle_and_session_refresh_restore_the_exact_changes_binding() {
    let (mut host, tab, first, second) = host();
    let session = tab.session_id().unwrap().clone();
    let toolbar = host
        .binding_mut(&second)
        .unwrap()
        .scm_mut()
        .unwrap()
        .toolbar_mut();
    toolbar.apply_commit_message(ash_editor::CodeEditorCommand::Insert("keep draft".into()));
    host.open_or_activate_input_with(
        &tab,
        second.pane(),
        PaneInput::terminal(session.clone()),
        PaneBinding::new,
    )
    .unwrap();
    host.upsert_session_input_with(
        TabInput::session(session.clone(), TabInputMetadata::new("Updated")),
        PaneInput::terminal(session.clone()),
        || panic!("refresh must not replace binding"),
    );
    host.ensure_input_with(
        &tab,
        first.pane(),
        PaneInput::terminal(session),
        PaneBinding::new,
    )
    .unwrap();
    assert_eq!(host.active_mount().unwrap().pane_id(), second.pane());
    assert_eq!(host.activate_previous_input(), Some(second.clone()));
    assert_eq!(host.active_mount().unwrap().key(), &second);
    assert_eq!(
        host.binding_mut(&second)
            .unwrap()
            .scm_mut()
            .unwrap()
            .toolbar_mut()
            .activate(Some(ChangesToolbarAction::SubmitCommit)),
        ChangesActivation::Commit {
            message: "keep draft".into(),
            include_unstaged: false,
            push: false
        }
    );
    host.activate_pane(&tab, first.pane());
    let other = ash_protocol::SessionId::new("other-session").unwrap();
    host.upsert_session_input_with(
        TabInput::session(other.clone(), TabInputMetadata::new("Other")),
        PaneInput::terminal(other),
        PaneBinding::new,
    );
    host.activate_tab(tab.clone());
    assert_eq!(host.active_mount().unwrap().key(), &first);
}

#[test]
fn repository_retarget_preserves_the_split_and_group_selection() {
    let (mut host, tab, first, second) = host();
    let tree = host.workbench().pane_part(&tab).unwrap().tree().clone();
    host.retarget_input(&first, PaneInput::diff("/new-root".into()))
        .unwrap();
    host.retarget_input(&second, PaneInput::diff("/new-root".into()))
        .unwrap();
    assert_eq!(host.workbench().pane_part(&tab).unwrap().tree(), &tree);
    assert_eq!(host.active_mount().unwrap().key(), &second);
    assert_eq!(
        host.active_mount().unwrap().input(),
        &PaneInput::diff("/new-root".into())
    );
    host.activate_pane(&tab, first.pane());
    assert_eq!(host.active_mount().unwrap().key(), &first);
}
