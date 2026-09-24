use std::path::{Path, PathBuf};

use crate::PaneBinding;
use crate::QuickAccess;
use crate::directory_picker::DirectoryPickerState;
use crate::presentation::SETTINGS_DIALOG;
use crate::{
    ADD_SESSION, EnvironmentContextView, INSPECTOR_RESIZE_HANDLE, InspectorPartState,
    LogicalViewport, PaneGroupId, PaneInput, PanePart, PaneSplitDirection, SESSION_SEARCH_INPUT,
    SessionSearchState, SidebarPart, TAB_CONTAINER_RESIZE_HANDLE, TAB_CONTAINER_SETTINGS_ACTION,
    TAB_CONTAINER_SETTINGS_CLOSE, TAB_CONTAINER_SETTINGS_TAB, TAB_CONTEXT_MENU, TITLEBAR,
    TabContainerState, TabInput, TabInputKey, TabInputMetadata, WINDOW, WorkbenchHost,
    WorkbenchPresentation, WorkbenchPresentationModel, WorkbenchSceneLayout,
    build_workbench_presentation, pane_group_element_id, rebuild_workbench_overlays,
    terminal_grid_size_for_viewport, terminal_mouse_position_for_viewport,
    terminal_pane_sash_for_viewport,
};
use crate::{MainSurfaceKind, TabContextMenuState, WorkbenchKeybindings};
use ash_commands::AppCommandId;
use ash_diff::DiffDocument;
use ash_editor::{CodeEditorLanguage, CodeEditorStyle, DiffEditorDocument};
use ash_editor_host::{FILE_EDITOR_DOCUMENT, FILE_EDITOR_PANE, FILE_EDITOR_TABS, FileEditorHost};
use ash_files::{
    DirectoryEntry, FILES_PANE, FILES_REFRESH, FILES_SEARCH, FILES_TOOLBAR, FilesState,
};
use ash_keybinding::{HostPlatform, KeySequence};
use ash_scm::GitBranchPickerState;
use ash_scm::{CHANGES_PANE, CHANGES_TOOLBAR, MULTI_DIFF_EDITOR, ScmDiff, ScmState};
use ash_session::SessionPaneState;
use ash_session::interaction::{
    COMPOSER, COMPOSER_KEY_HINT_BAR, COMPOSER_PANEL, ContextAction, SESSION_HEADER, THREAD_TIMELINE,
};
use ash_settings::RemoteConnectionManagerState;
use ash_settings::RemoteConnectionPickerState;
use ash_settings::RemoteTunnelManagerState;
use ash_settings::SettingsState;
use ash_terminal::{GridSize, ScreenBuffer, TerminalCore};
use ash_text_file::{TextFileAccess, TextFileDiskVersion, TextFileModifiedAt, TextFileSnapshot};
use ash_ui_components::ScrollbarPresentation;
use zui::runtime::AccessibilityNode;
use zui::ui::{AccessibilityRole, CursorFeedback, DispatchInvalidation, UiDispatch, UiIntent};
use zui::ui::{
    CaretVisibility, Color, Edges, Point, Rect, TextInputCommand, TextInputLayoutEngine, UiScene,
};
use zui::window::WindowControlInsets;

const APP_DISPLAY_NAME: &str = "app";

struct TestKeybindings;

impl WorkbenchKeybindings for TestKeybindings {
    fn pending_keybinding(&self) -> Option<(&KeySequence, usize)> {
        None
    }

    fn platform(&self) -> HostPlatform {
        HostPlatform::current()
    }

    fn binding_for_command(&self, _command: AppCommandId) -> Option<&KeySequence> {
        None
    }
}

struct TestEnvironmentContext {
    working_directory: PathBuf,
    working_directory_label: String,
    git_branch: Option<String>,
    diffs: Vec<ScmDiff>,
}

impl TestEnvironmentContext {
    fn fixture(
        working_directory_label: impl Into<String>,
        git_branch: Option<&str>,
        diff_count: Option<usize>,
    ) -> Self {
        let diffs = (0..diff_count.unwrap_or(0))
            .filter_map(|index| {
                DiffDocument::from_text("", &format!("fixture {index}\n"))
                    .ok()
                    .map(|document| {
                        ScmDiff::new(
                            format!("fixture-{index}.txt"),
                            DiffEditorDocument::new(document, CodeEditorLanguage::PlainText),
                        )
                    })
            })
            .collect();
        Self {
            working_directory: PathBuf::from("/fixture"),
            working_directory_label: working_directory_label.into(),
            git_branch: git_branch.map(str::to_owned),
            diffs,
        }
    }

    fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    fn working_directory_label(&self) -> &str {
        &self.working_directory_label
    }

    fn diffs(&self) -> &[ScmDiff] {
        &self.diffs
    }
}

fn viewport() -> LogicalViewport {
    LogicalViewport {
        width: 1000.0,
        height: 700.0,
    }
}

fn environment_context_view(context: &TestEnvironmentContext) -> EnvironmentContextView<'_> {
    EnvironmentContextView {
        location: "Local",
        working_directory: context.working_directory_label(),
        git_branch: context.git_branch.as_deref().unwrap_or("No Git"),
        diff_summary: context.git_branch.as_ref().map_or_else(
            || "Changes —".to_string(),
            |_| {
                format!(
                    "Changes {} • +{} -0",
                    context.diffs.len(),
                    context.diffs.len()
                )
            },
        ),
        upstream_distance: context.git_branch.as_ref().map(|_| (0, 0)),
    }
}

#[test]
fn inspector_part_outer_border_is_owned_by_workbench() {
    let bounds = Rect::from_xywh(680.0, 40.0, 320.0, 660.0);
    let mut scene = UiScene::new(ash_ui_theme::DEFAULT_UI_THEME.workbench_background);

    crate::draw_inspector_border(&mut scene, bounds, ash_ui_theme::DEFAULT_UI_THEME);

    let frame = scene.rects().first().copied().expect("Inspector frame");
    assert_eq!(frame.bounds(), bounds);
    assert_eq!(frame.fill(), Color::TRANSPARENT);
    assert_eq!(frame.border().widths(), Edges::new(0.0, 0.0, 0.0, 1.0));
    assert_eq!(
        frame.border().color(),
        ash_ui_theme::DEFAULT_UI_THEME.border
    );
}

fn presentation(terminal: Option<&TerminalCore>, scroll_offset: usize) -> WorkbenchPresentation {
    presentation_with_dispatch(terminal, scroll_offset).0
}

fn presentation_with_dispatch(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
) -> (WorkbenchPresentation, UiDispatch) {
    let files = FilesState::default();
    let scm = ScmState::default();
    let mut dispatch = UiDispatch::default();
    let presentation = presentation_with_capabilities(
        terminal,
        scroll_offset,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
        TabContextMenuState::default(),
        &files,
        &scm,
        &mut dispatch,
    );
    (presentation, dispatch)
}

fn accessibility_nodes(
    presentation: &WorkbenchPresentation,
    dispatch: &UiDispatch,
) -> Vec<AccessibilityNode> {
    presentation
        .interaction_frame()
        .accessibility_nodes(dispatch)
}

fn presentation_with_tab_container(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
    tab_container: TabContainerState,
) -> WorkbenchPresentation {
    presentation_with_tab_container_and_menu(
        terminal,
        scroll_offset,
        tab_container,
        TabContextMenuState::default(),
    )
}

fn presentation_with_tab_container_and_menu(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
    tab_container: TabContainerState,
    tab_context_menu: TabContextMenuState,
) -> WorkbenchPresentation {
    presentation_with_parts_and_menu(
        terminal,
        scroll_offset,
        tab_container,
        InspectorPartState::default(),
        tab_context_menu,
    )
}

fn presentation_with_parts_and_menu(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    tab_context_menu: TabContextMenuState,
) -> WorkbenchPresentation {
    let files = FilesState::default();
    let scm = ScmState::default();
    let mut dispatch = UiDispatch::default();
    presentation_with_capabilities(
        terminal,
        scroll_offset,
        tab_container,
        inspector_part,
        tab_context_menu,
        &files,
        &scm,
        &mut dispatch,
    )
}

fn presentation_with_capabilities(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    tab_context_menu: TabContextMenuState,
    files: &FilesState,
    scm: &ScmState,
    dispatch: &mut UiDispatch,
) -> WorkbenchPresentation {
    presentation_with_active_tab_input(
        terminal,
        scroll_offset,
        tab_container,
        inspector_part,
        tab_context_menu,
        files,
        scm,
        dispatch,
        None,
    )
}

fn presentation_with_active_tab_input(
    terminal: Option<&TerminalCore>,
    scroll_offset: usize,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    tab_context_menu: TabContextMenuState,
    files: &FilesState,
    scm: &ScmState,
    dispatch: &mut UiDispatch,
    active_tab_input: Option<TabInputKey>,
) -> WorkbenchPresentation {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(0));
    let mut text_layout = TextInputLayoutEngine::new();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();
    let dir_tab_key = TabInputKey::session(
        ash_protocol::SessionId::new("files-input-session").expect("test session ID is non-empty"),
    );
    let files_input_enabled = inspector_part.is_expanded() && active_tab_input.is_none();
    let inspector_part = files_input_enabled
        .then(InspectorPartState::default)
        .unwrap_or(inspector_part);
    let mut dir_workbench = WorkbenchHost::new();
    dir_workbench.upsert_session_input_with(
        TabInput::session(
            dir_tab_key
                .session_id()
                .expect("dir tab must carry a session")
                .clone(),
            TabInputMetadata::new("Directory")
                .with_dirs([environment_context.working_directory().to_path_buf()]),
        ),
        PaneInput::files(environment_context.working_directory().to_path_buf()),
        PaneBinding::new,
    );
    let files_pane_part = dir_workbench
        .workbench()
        .pane_part(&dir_tab_key)
        .expect("Files pane part");
    let files_mount = files_input_enabled.then(|| {
        dir_workbench
            .mount(&dir_tab_key, files_pane_part.root_pane())
            .expect("Files input should mount")
    });
    let active_tab_input = active_tab_input
        .as_ref()
        .or(files_input_enabled.then_some(&dir_tab_key));
    let pane_group = files_input_enabled.then_some(files_pane_part);
    let sidebar_part = SidebarPart::default();
    let initial = build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal,
            terminal_panes: &[],
            pane_group,
            active_pane: files_mount,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: scroll_offset,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: if terminal
                .is_some_and(|terminal| terminal.active_screen() == ScreenBuffer::Alternate)
            {
                MainSurfaceKind::Terminal
            } else {
                MainSurfaceKind::Agent
            },
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input,
            caret_visibility: CaretVisibility::Visible,
            dispatch,
            tab_container,
            inspector_part,
            files,
            scm,
            files_pane_expanded: false,
            tab_context_menu: tab_context_menu.clone(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );
    dispatch.reconcile_focus(&initial.interaction_frame(), COMPOSER);
    build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal,
            terminal_panes: &[],
            pane_group,
            active_pane: files_mount,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: scroll_offset,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: if terminal
                .is_some_and(|terminal| terminal.active_screen() == ScreenBuffer::Alternate)
            {
                MainSurfaceKind::Terminal
            } else {
                MainSurfaceKind::Agent
            },
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input,
            caret_visibility: CaretVisibility::Visible,
            dispatch,
            tab_container,
            inspector_part,
            files,
            scm,
            files_pane_expanded: false,
            tab_context_menu,
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    )
}

#[test]
fn settings_tab_input_renders_a_dialog_and_selects_the_tab_container_entry() {
    let files = FilesState::default();
    let scm = ScmState::default();
    let mut dispatch = UiDispatch::default();
    let presentation = presentation_with_active_tab_input(
        None,
        0,
        TabContainerState::expanded(),
        InspectorPartState::default(),
        TabContextMenuState::default(),
        &files,
        &scm,
        &mut dispatch,
        Some(TabInputKey::Settings),
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &dispatch);
    let interaction = presentation.interaction_frame();

    assert!(
        presentation
            .frame()
            .scene()
            .text_blocks()
            .iter()
            .any(|text| text.text() == "Settings")
    );
    assert!(
        presentation
            .frame()
            .scene()
            .icons()
            .iter()
            .any(|icon| icon.icon() == ash_icons::icons::GEAR)
    );
    let node = accessibility_nodes
        .iter()
        .find(|node| node.id == TAB_CONTAINER_SETTINGS_TAB)
        .expect("settings workbench item should be mounted");
    assert_eq!(node.selection, zui::ui::AccessibilitySelection::Selected);
    assert_eq!(
        interaction
            .node(SETTINGS_DIALOG)
            .expect("Settings dialog root")
            .parent(),
        Some(WINDOW)
    );
    assert_eq!(
        interaction
            .node(ash_settings::SETTINGS_PAGE)
            .expect("Settings page")
            .parent(),
        Some(SETTINGS_DIALOG)
    );
    assert!(
        interaction
            .focus_order()
            .any(|id| id == ash_settings::SETTINGS_SEARCH_INPUT)
    );
    assert!(interaction.focus_order().all(|id| id != COMPOSER));
    assert_eq!(interaction.target_at(Point::new(10.0, 100.0)), None);
    assert_eq!(
        accessibility_nodes
            .iter()
            .find(|node| node.id == TAB_CONTAINER_SETTINGS_CLOSE)
            .map(|node| node.role),
        None
    );
}

#[test]
fn expanded_inspector_part_file_row_hover_rebuilds_with_the_hover_background() {
    let mut files = FilesState::default();
    files.refresh(vec![
        DirectoryEntry::file("alpha.txt"),
        DirectoryEntry::file("beta.txt"),
    ]);
    let scm = ScmState::default();
    let mut dispatch = UiDispatch::default();
    let initial = presentation_with_capabilities(
        None,
        0,
        TabContainerState::collapsed(),
        InspectorPartState::expanded(),
        TabContextMenuState::default(),
        &files,
        &scm,
        &mut dispatch,
    );
    let accessibility_nodes = accessibility_nodes(&initial, &dispatch);
    let (row_id, row_bounds) = {
        let row = accessibility_nodes
            .iter()
            .find(|node| node.label == "beta.txt")
            .expect("file row should be registered in the Workbench frame");
        (row.id, row.bounds)
    };
    let point = Point::new(
        row_bounds.origin.x + row_bounds.size.width * 0.5,
        row_bounds.origin.y + row_bounds.size.height * 0.5,
    );

    assert_eq!(initial.interaction_frame().target_at(point), Some(row_id));
    let outcome = dispatch.pointer_moved(point, &initial.interaction_frame());

    assert_eq!(outcome.invalidation, DispatchInvalidation::Paint);
    assert!(dispatch.is_hovered(row_id));
    let hovered = presentation_with_capabilities(
        None,
        0,
        TabContainerState::collapsed(),
        InspectorPartState::expanded(),
        TabContextMenuState::default(),
        &files,
        &scm,
        &mut dispatch,
    );

    assert!(hovered.frame().scene().rects().iter().any(|rect| {
        rect.bounds() == row_bounds
            && rect.fill() == ash_ui_theme::DEFAULT_UI_THEME.list_hover_background
    }));
}

#[test]
fn primary_layout_keeps_output_above_a_bottom_composer() {
    let layout = WorkbenchSceneLayout::for_viewport(
        viewport(),
        TabContainerState::collapsed(),
        InspectorPartState::default(),
    )
    .unwrap();

    assert_eq!(layout.titlebar().origin.y, 0.0);
    assert_eq!(layout.titlebar().size.height, 32.0);
    assert_eq!(layout.main().origin.x, 0.0);
    assert_eq!(layout.main().bottom(), 700.0);
    assert_eq!(layout.output.bottom(), layout.composer_panel.origin.y);
    assert_eq!(layout.composer_panel.origin.y, 572.0);
    assert_eq!(layout.composer_key_hint_bar.origin.y, 580.0);
    assert_eq!(layout.composer.origin.y, 612.0);
    assert_eq!(layout.composer.bottom(), 656.0);
    assert_eq!(layout.composer_toolbar.origin.y, 664.0);
}

#[test]
fn editor_surface_mounts_the_active_file_beside_the_session_canvas() {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(0));
    let files = FilesState::default();
    let scm = ScmState::default();
    let mut file_editor_host = FileEditorHost::default();
    file_editor_host.open(TextFileSnapshot::new(
        "src/main.rs".into(),
        "fn main() {}\n".into(),
        TextFileDiskVersion::new(
            13,
            TextFileModifiedAt::KnownMillis(1),
            TextFileAccess::Writable,
        ),
    ));
    let code_editor_style = CodeEditorStyle::light();
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();

    let presentation = build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &[],
            pane_group: None,
            active_pane: None,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: MainSurfaceKind::Editor,
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input: None,
            caret_visibility: CaretVisibility::Visible,
            dispatch: &dispatch,
            tab_container: TabContainerState::collapsed(),
            inspector_part: InspectorPartState::expanded(),
            files: &files,
            scm: &scm,
            files_pane_expanded: false,
            tab_context_menu: TabContextMenuState::default(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &dispatch);

    for id in [FILE_EDITOR_PANE, FILE_EDITOR_TABS, FILE_EDITOR_DOCUMENT] {
        assert!(accessibility_nodes.iter().any(|node| node.id == id));
    }
    assert!(
        accessibility_nodes
            .iter()
            .any(|node| node.id == FILE_EDITOR_PANE && node.parent == Some(WINDOW))
    );
    for id in [SESSION_HEADER, COMPOSER, THREAD_TIMELINE] {
        assert!(accessibility_nodes.iter().any(|node| node.id == id));
    }
    assert!(
        presentation
            .frame()
            .scene()
            .text_blocks()
            .iter()
            .any(|block| block.text() == "New session")
    );
    assert!(
        presentation
            .frame()
            .scene()
            .text_blocks()
            .iter()
            .any(|block| block.text() == "fn main() {}")
    );
}

#[test]
fn multiline_composer_grows_upward_between_key_hints_and_bottom_toolbar() {
    let layout = WorkbenchSceneLayout::for_viewport_with_composer_height(
        viewport(),
        TabContainerState::collapsed(),
        InspectorPartState::default(),
        160.0,
    )
    .unwrap();

    assert_eq!(layout.composer.size.height, 160.0);
    assert_eq!(layout.composer_panel.size.height, 244.0);
    assert_eq!(
        layout.composer.origin.y,
        layout.composer_key_hint_bar.bottom() + 8.0
    );
    assert_eq!(
        layout.composer.bottom() + 8.0,
        layout.composer_toolbar.origin.y
    );
    assert_eq!(layout.output.bottom(), layout.composer_panel.origin.y);
}

#[test]
fn primary_presentation_uses_a_flat_light_surface() {
    let layout = WorkbenchSceneLayout::for_viewport(
        viewport(),
        TabContainerState::collapsed(),
        InspectorPartState::default(),
    )
    .unwrap();
    let presentation = presentation(None, 0);
    let composer_panel = presentation
        .frame()
        .scene()
        .rects()
        .iter()
        .find(|rect| rect.bounds() == layout.composer_panel)
        .unwrap();
    let hint_editor_separator = presentation
        .frame()
        .scene()
        .rects()
        .iter()
        .find(|rect| {
            rect.bounds()
                == layout
                    .session_pane_layout
                    .composer()
                    .hint_editor_separator()
        })
        .unwrap();

    assert_eq!(
        presentation.frame().scene().background(),
        Color::rgb(252, 252, 253)
    );
    assert_eq!(composer_panel.fill(), Color::WHITE);
    assert_eq!(composer_panel.border().widths().top, 1.0);
    assert_eq!(
        hint_editor_separator.fill(),
        ash_ui_theme::DEFAULT_UI_THEME.border
    );
    let intentional_pills = presentation
        .frame()
        .scene()
        .rects()
        .iter()
        .filter(|rect| rect.corner_radii().top_left > 4.0)
        .collect::<Vec<_>>();
    assert_eq!(intentional_pills.len(), 1);
    assert_eq!(intentional_pills[0].bounds().size.height, 24.0);
}

#[test]
fn primary_presentation_has_an_agent_timeline_and_fixed_composer() {
    let presentation = presentation(None, 0);
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();

    assert!(!visible_text.contains(&"app"));
    assert!(!visible_text.contains(&"Starting shell…"));
    assert!(visible_text.contains(&"Ask Ash anything…"));
    assert!(visible_text.contains(&"Local"));
    assert!(!visible_text.contains(&"Agent"));
    assert!(!visible_text.contains(&"SESSIONS"));
    assert_eq!(presentation.frame().scene().icons().len(), 7);
}

#[test]
fn expanded_tab_container_reflows_the_terminal_without_a_placeholder_session() {
    let layout = WorkbenchSceneLayout::for_viewport(
        viewport(),
        TabContainerState::expanded(),
        InspectorPartState::default(),
    )
    .unwrap();
    let presentation = presentation_with_tab_container(None, 0, TabContainerState::expanded());
    let accessibility_nodes = accessibility_nodes(&presentation, &UiDispatch::default());
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    let resize_handle = accessibility_nodes
        .iter()
        .find(|node| node.id == TAB_CONTAINER_RESIZE_HANDLE)
        .unwrap();
    let search = accessibility_nodes
        .iter()
        .find(|node| node.id == SESSION_SEARCH_INPUT)
        .unwrap();
    let add_session = accessibility_nodes
        .iter()
        .find(|node| node.id == ADD_SESSION)
        .unwrap();
    let mut dispatch = UiDispatch::default();

    assert_eq!(layout.tab_container().unwrap().size.width, 200.0);
    assert_eq!(layout.main().origin.x, 200.0);
    assert_eq!(layout.composer.origin.x, 224.0);
    assert!(visible_text.contains(&"Search sessions..."));
    assert!(visible_text.contains(&"Settings"));
    assert!(
        accessibility_nodes
            .iter()
            .all(|node| node.id != crate::FIRST_TAB_CONTAINER_SESSION_TAB)
    );
    let inspected_search = presentation
        .frame()
        .scene()
        .inspection()
        .target_at(Point::new(
            search.bounds.origin.x + 2.0,
            search.bounds.origin.y + 2.0,
        ))
        .expect("session search should expose its inspection hierarchy");
    assert_eq!(
        presentation
            .frame()
            .scene()
            .inspection()
            .ancestry(inspected_search.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        vec!["SidebarView", "SessionsToolbar", "SearchBox", "InputBox",]
    );
    assert_eq!(search.role, AccessibilityRole::TextInput);
    assert_eq!(add_session.role, AccessibilityRole::Button);
    assert_eq!(add_session.label, "Add new session");
    assert_eq!(resize_handle.role, AccessibilityRole::Separator);
    assert_eq!(resize_handle.label, "Resize tabs");
    assert_eq!(resize_handle.value.as_deref(), Some("200 pixels"));
    assert_eq!(
        presentation
            .interaction_frame()
            .target_at(Point::new(200.0, 100.0)),
        Some(TAB_CONTAINER_RESIZE_HANDLE)
    );
    dispatch.pointer_moved(Point::new(200.0, 100.0), &presentation.interaction_frame());
    assert_eq!(
        dispatch.pointer_feedback(&presentation.interaction_frame()),
        CursorFeedback::ResizeHorizontal
    );
    assert_eq!(
        terminal_grid_size_for_viewport(
            viewport(),
            ScreenBuffer::Primary,
            TabContainerState::expanded(),
            InspectorPartState::default(),
        )
        .cols(),
        94
    );
    assert_eq!(
        terminal_mouse_position_for_viewport(
            viewport(),
            ScreenBuffer::Primary,
            TabContainerState::expanded(),
            InspectorPartState::default(),
            Point::new(100.0, 100.0),
        ),
        None
    );
}

#[test]
fn session_search_filters_tabs_by_session_name() {
    let session_pane = SessionPaneState::default();
    let mut session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    session_search.apply(TextInputCommand::Insert("missing session".to_owned()));
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(0));
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let files = FilesState::default();
    let scm = ScmState::default();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();

    let presentation = build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &[],
            pane_group: None,
            active_pane: None,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: MainSurfaceKind::Agent,
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input: None,
            caret_visibility: CaretVisibility::Visible,
            dispatch: &dispatch,
            tab_container: TabContainerState::expanded(),
            inspector_part: InspectorPartState::default(),
            files: &files,
            scm: &scm,
            files_pane_expanded: false,
            tab_context_menu: TabContextMenuState::default(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &dispatch);

    assert!(
        accessibility_nodes
            .iter()
            .all(|node| node.id != crate::FIRST_TAB_CONTAINER_SESSION_TAB)
    );
    assert!(
        presentation
            .frame()
            .scene()
            .text_blocks()
            .iter()
            .any(|block| block.text() == "missing session")
    );
}

#[test]
fn active_files_input_mounts_directly_in_its_pane_group_with_files_actions() {
    let inspector_part = InspectorPartState::expanded();
    let presentation = presentation_with_parts_and_menu(
        None,
        0,
        TabContainerState::collapsed(),
        inspector_part,
        TabContextMenuState::default(),
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &UiDispatch::default());
    let pane_group = accessibility_nodes
        .iter()
        .find(|node| node.id == pane_group_element_id(PaneGroupId::ROOT))
        .unwrap();
    let explorer = accessibility_nodes
        .iter()
        .find(|node| node.id == FILES_PANE)
        .unwrap();
    let toolbar = accessibility_nodes
        .iter()
        .find(|node| node.id == FILES_TOOLBAR)
        .unwrap();
    let resize_handle = accessibility_nodes
        .iter()
        .find(|node| node.id == INSPECTOR_RESIZE_HANDLE);

    assert_eq!(
        accessibility_nodes
            .iter()
            .find(|node| node.id == pane_group_element_id(PaneGroupId::ROOT))
            .map(|node| node.bounds),
        Some(zui::ui::Rect::from_xywh(0.0, 32.0, 1000.0, 668.0))
    );
    assert_eq!(pane_group.role, AccessibilityRole::Group);
    assert_eq!(pane_group.label, "Files pane group");
    assert_eq!(
        explorer.parent,
        Some(pane_group_element_id(PaneGroupId::ROOT))
    );
    assert_eq!(explorer.label, "Files");
    assert_eq!(toolbar.label, "Files toolbar");
    assert_eq!(
        toolbar.parent,
        Some(pane_group_element_id(PaneGroupId::ROOT))
    );
    assert!(resize_handle.is_none());
    assert_eq!(
        toolbar.bounds,
        zui::ui::Rect::from_xywh(0.0, 32.0, 1000.0, 36.0)
    );
    assert_eq!(
        explorer.bounds,
        zui::ui::Rect::from_xywh(0.0, 68.0, 1000.0, 632.0)
    );
    for id in [FILES_REFRESH, FILES_SEARCH] {
        assert!(accessibility_nodes.iter().any(|node| node.id == id));
    }
    assert!(
        accessibility_nodes
            .iter()
            .all(|node| !matches!(node.id, CHANGES_PANE | MULTI_DIFF_EDITOR))
    );
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|text| text.text())
        .collect::<Vec<_>>();
    assert!(visible_text.contains(&"No files loaded"));
    assert!(visible_text.contains(&"↑0 ↓0"));
    assert_eq!(
        accessibility_nodes
            .iter()
            .filter(|node| node.parent == Some(ash_files::FILES_ACTION_BAR))
            .count(),
        2
    );
    assert_eq!(
        terminal_grid_size_for_viewport(
            viewport(),
            ScreenBuffer::Primary,
            TabContainerState::collapsed(),
            InspectorPartState::default(),
        )
        .cols(),
        119
    );
}

#[test]
fn active_diff_input_mounts_multi_diff_editor_without_files_actions() {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(2));
    let files = FilesState::default();
    let mut scm = ScmState::default();
    scm.set_branch(Some("main"));
    scm.replace_diffs(
        environment_context
            .diffs()
            .iter()
            .map(|diff| ScmDiff::new(diff.path(), diff.document().clone())),
    );
    let tab_key = TabInputKey::session(
        ash_protocol::SessionId::new("session-1").expect("test session ID is non-empty"),
    );
    let mut workbench = WorkbenchHost::new();
    workbench.upsert_session_input_with(
        TabInput::session(
            tab_key
                .session_id()
                .expect("session tab must carry a session")
                .clone(),
            TabInputMetadata::new("Session")
                .with_dirs([environment_context.working_directory().to_path_buf()]),
        ),
        PaneInput::diff(environment_context.working_directory().to_path_buf()),
        PaneBinding::new,
    );
    let main_pane_group = workbench
        .workbench()
        .pane_part(&tab_key)
        .expect("main pane part");
    let main_pane = workbench.mount(&tab_key, main_pane_group.root_pane());
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();
    let presentation = build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &[],
            pane_group: Some(main_pane_group),
            active_pane: main_pane,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: MainSurfaceKind::Agent,
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input: Some(&tab_key),
            caret_visibility: CaretVisibility::Visible,
            dispatch: &dispatch,
            tab_container: TabContainerState::collapsed(),
            inspector_part: InspectorPartState::default(),
            files: &files,
            scm: &scm,
            files_pane_expanded: false,
            tab_context_menu: TabContextMenuState::default(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &dispatch);

    assert!(
        accessibility_nodes
            .iter()
            .any(|node| node.id == CHANGES_PANE)
    );
    assert_eq!(
        accessibility_nodes
            .iter()
            .find(|node| node.id == CHANGES_PANE)
            .and_then(|node| node.parent),
        Some(pane_group_element_id(PaneGroupId::ROOT))
    );
    assert!(
        accessibility_nodes
            .iter()
            .any(|node| node.id == MULTI_DIFF_EDITOR)
    );
    assert!(
        accessibility_nodes
            .iter()
            .any(|node| node.id == CHANGES_TOOLBAR)
    );
    assert!(
        accessibility_nodes
            .iter()
            .all(|node| !matches!(node.id, FILES_PANE | FILES_REFRESH | FILES_SEARCH))
    );
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|text| text.text())
        .collect::<Vec<_>>();
    assert!(visible_text.contains(&"fixture-0.txt"));
    assert!(visible_text.contains(&"fixture-1.txt"));
    assert!(visible_text.contains(&"Current turn"));
    assert!(visible_text.contains(&"Commit"));
    assert!(!visible_text.contains(&"No changes in this scope"));
    assert!(!visible_text.contains(&"HEAD"));
    assert!(!visible_text.contains(&"Working Tree"));
}

#[test]
fn expanded_diff_attaches_files_to_the_right_side_of_its_content() {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(1));
    let files = FilesState::default();
    let mut scm = ScmState::default();
    scm.set_branch(Some("main"));
    scm.replace_diffs(
        environment_context
            .diffs()
            .iter()
            .map(|diff| ScmDiff::new(diff.path(), diff.document().clone())),
    );
    let tab_key = TabInputKey::session(
        ash_protocol::SessionId::new("session-with-files").expect("test session ID is non-empty"),
    );
    let mut workbench = WorkbenchHost::new();
    workbench.upsert_session_input_with(
        TabInput::session(
            tab_key
                .session_id()
                .expect("session tab must carry a session")
                .clone(),
            TabInputMetadata::new("Session")
                .with_dirs([environment_context.working_directory().to_path_buf()]),
        ),
        PaneInput::diff(environment_context.working_directory().to_path_buf()),
        PaneBinding::new,
    );
    let pane = workbench
        .workbench()
        .pane_part(&tab_key)
        .expect("main pane part")
        .root_group();
    workbench
        .ensure_input_with(
            &tab_key,
            pane,
            PaneInput::files(environment_context.working_directory().to_path_buf()),
            PaneBinding::new,
        )
        .expect("Files input should be attached to the Changes group");
    let pane_group = workbench
        .workbench()
        .pane_part(&tab_key)
        .expect("main pane part");
    let active_pane = workbench.mount(&tab_key, pane);
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();
    let presentation = build_workbench_presentation(
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &[],
            pane_group: Some(pane_group),
            active_pane,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: MainSurfaceKind::Agent,
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input: Some(&tab_key),
            caret_visibility: CaretVisibility::Visible,
            dispatch: &dispatch,
            tab_container: TabContainerState::collapsed(),
            inspector_part: InspectorPartState::default(),
            files: &files,
            scm: &scm,
            files_pane_expanded: true,
            tab_context_menu: TabContextMenuState::default(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );
    let nodes = accessibility_nodes(&presentation, &dispatch);
    let node = |id| {
        nodes
            .iter()
            .find(|node| node.id == id)
            .expect("accessible node")
    };

    assert_eq!(
        node(CHANGES_TOOLBAR).bounds,
        Rect::from_xywh(0.0, 32.0, 1000.0, 40.0)
    );
    assert_eq!(
        node(MULTI_DIFF_EDITOR).bounds,
        Rect::from_xywh(0.0, 72.0, 500.0, 628.0)
    );
    assert_eq!(
        node(FILES_TOOLBAR).bounds,
        Rect::from_xywh(500.0, 72.0, 500.0, 36.0)
    );
    assert_eq!(
        node(FILES_PANE).bounds,
        Rect::from_xywh(500.0, 108.0, 500.0, 592.0)
    );
    assert_eq!(node(FILES_PANE).parent, Some(CHANGES_PANE));
    assert_eq!(node(FILES_TOOLBAR).parent, Some(CHANGES_PANE));
    assert_eq!(node(CHANGES_TOOLBAR).parent, Some(CHANGES_PANE));
    assert_eq!(active_pane.unwrap().kind(), crate::PaneInputKind::Diff);
    assert_eq!(pane_group.group(pane).unwrap().inputs().count(), 2);
}

#[test]
fn open_tab_context_menu_is_topmost_and_exposes_generic_actions() {
    let mut menu_state = TabContextMenuState::default();
    menu_state.open_unpinned(
        TabInputKey::session(
            ash_protocol::SessionId::new("context-menu-session")
                .expect("test session ID is non-empty"),
        ),
        Point::new(80.0, 120.0),
        Some(COMPOSER),
    );
    let presentation = presentation_with_tab_container_and_menu(
        None,
        0,
        TabContainerState::expanded(),
        menu_state,
    );
    let accessibility_nodes = accessibility_nodes(&presentation, &UiDispatch::default());
    let labels = accessibility_nodes
        .iter()
        .filter(|node| node.parent == Some(crate::TAB_CONTEXT_MENU))
        .map(|node| node.label.as_str())
        .collect::<Vec<_>>();
    let first_item = accessibility_nodes
        .iter()
        .find(|node| node.id == crate::TabContextMenuAction::TogglePin.element_id())
        .unwrap();

    assert_eq!(
        labels,
        [
            "Pin",
            "Rename",
            "Fork",
            "Move to group",
            "Archive",
            "Delete"
        ]
    );
    assert_eq!(
        presentation.interaction_frame().target_at(Point::new(
            first_item.bounds.origin.x + 2.0,
            first_item.bounds.origin.y + 2.0
        )),
        Some(crate::TabContextMenuAction::TogglePin.element_id())
    );
    assert!(
        presentation
            .frame()
            .scene()
            .text_blocks()
            .iter()
            .any(|text| text.text() == "Move to group")
    );
    assert!(
        presentation
            .frame()
            .scene()
            .icons()
            .iter()
            .any(|icon| icon.icon() == ash_icons::icons::CHEVRON_RIGHT)
    );
}

#[test]
fn open_tab_context_menu_keeps_target_action_bar_visible_in_the_tab_container() {
    let mut menu_state = TabContextMenuState::default();
    menu_state.open_unpinned(TabInputKey::Settings, Point::new(80.0, 120.0), None);

    let presentation = presentation_with_tab_container_and_menu(
        None,
        0,
        TabContainerState::expanded(),
        menu_state,
    );

    assert!(
        presentation
            .interaction_frame()
            .node(TAB_CONTAINER_SETTINGS_ACTION)
            .is_some()
    );
}

#[test]
fn primary_presentation_publishes_current_control_semantics_and_focus() {
    let (presentation, dispatch) = presentation_with_dispatch(None, 0);
    let accessibility_nodes = accessibility_nodes(&presentation, &dispatch);
    let key_hint_bar = accessibility_nodes
        .iter()
        .find(|node| node.id == COMPOSER_KEY_HINT_BAR)
        .unwrap();
    let composer = accessibility_nodes
        .iter()
        .find(|node| node.id == COMPOSER)
        .unwrap();
    let location = accessibility_nodes
        .iter()
        .find(|node| node.id == ContextAction::Location.element_id())
        .unwrap();

    assert_eq!(key_hint_bar.role, AccessibilityRole::Group);
    assert_eq!(key_hint_bar.label, "/ for commands");
    let inspected_key_hint_bar = presentation
        .frame()
        .scene()
        .inspection()
        .target_at(Point::new(
            key_hint_bar.bounds.origin.x + 100.0,
            key_hint_bar.bounds.origin.y + key_hint_bar.bounds.size.height / 2.0,
        ))
        .expect("composer key hint bar should expose its inspection hierarchy");
    assert_eq!(
        presentation
            .frame()
            .scene()
            .inspection()
            .ancestry(inspected_key_hint_bar.id())
            .iter()
            .map(|node| node.name())
            .collect::<Vec<_>>(),
        vec![
            "MainSurface",
            "ComposerPanel",
            "ComposerContent",
            "KeyHintBar"
        ]
    );
    assert_eq!(composer.role, AccessibilityRole::TextInput);
    assert_eq!(composer.label, "Command input");
    assert_eq!(composer.value.as_deref(), Some(""));
    assert!(composer.focused);
    assert_eq!(location.role, AccessibilityRole::Button);
    assert_eq!(location.label, "Environment: Local");
    assert!(!location.focused);
    for (name, bounds) in [("editor", composer.bounds), ("toolbar", location.bounds)] {
        let inspected = presentation
            .frame()
            .scene()
            .inspection()
            .target_at(Point::new(bounds.origin.x + 1.0, bounds.origin.y + 1.0))
            .unwrap_or_else(|| panic!("composer {name} should be inspectable"));
        assert!(
            presentation
                .frame()
                .scene()
                .inspection()
                .ancestry(inspected.id())
                .iter()
                .any(|node| node.name() == "ComposerContent"),
            "composer {name} should be inside ComposerContent"
        );
    }
}

#[test]
fn context_toolbar_pointer_clicks_activate_dir_and_branch_pickers() {
    let presentation = presentation(None, 0);

    for action in [ContextAction::WorkingDirectory, ContextAction::GitBranch] {
        let bounds = presentation
            .element_bounds(action.element_id())
            .expect("context action should be mounted");
        let point = Point::new(
            bounds.origin.x + bounds.size.width / 2.0,
            bounds.origin.y + bounds.size.height / 2.0,
        );
        let mut dispatch = UiDispatch::default();

        dispatch.pointer_moved(point, &presentation.interaction_frame());
        dispatch.press_primary(&presentation.interaction_frame());
        let outcome = dispatch.release_primary(point, &presentation.interaction_frame());

        assert_eq!(
            outcome.intent,
            Some(UiIntent::Activate(action.element_id()))
        );
    }
}

#[test]
fn overlay_rebuild_restores_the_retained_base_scene_and_interactions() {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    let environment_context =
        TestEnvironmentContext::fixture("~/Desktop/ash", Some("main"), Some(0));
    let files = FilesState::default();
    let scm = ScmState::default();
    let git_branch_picker = GitBranchPickerState::default();
    let directory_picker = DirectoryPickerState::default();
    let remote_connection_picker = RemoteConnectionPickerState::default();
    let remote_connection_manager = RemoteConnectionManagerState::default();
    let keybindings = TestKeybindings;
    let quick_access = QuickAccess::default();
    let settings = SettingsState::default();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();
    let dispatch = UiDispatch::default();
    let mut text_layout = TextInputLayoutEngine::new();
    let closed_model = WorkbenchPresentationModel {
        app_name: APP_DISPLAY_NAME,
        palette: ash_ui_theme::DEFAULT_UI_THEME,
        typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
        terminal: None,
        terminal_panes: &[],
        pane_group: None,
        active_pane: None,
        terminal_pane_resize_split: None,
        terminal_scroll_offset: 0,
        terminal_scrollbar_presentation: ScrollbarPresentation::default(),
        terminal_selection: None,
        main_surface: MainSurfaceKind::Agent,
        file_editor_host: &file_editor_host,
        file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
        file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
        file_editor_diagnostics: &[],
        language_hover: None,
        language_completions: None,
        completion_selection: 0,
        code_editor_style: &code_editor_style,
        session_pane: &session_pane,
        environment_context: environment_context_view(&environment_context),
        session_search: &session_search,
        sidebar_part: &sidebar_part,
        active_tab_input: None,
        caret_visibility: CaretVisibility::Visible,
        dispatch: &dispatch,
        tab_container: TabContainerState::collapsed(),
        inspector_part: InspectorPartState::default(),
        files: &files,
        scm: &scm,
        files_pane_expanded: false,
        tab_context_menu: TabContextMenuState::default(),
        git_branch_picker: &git_branch_picker,
        directory_picker: &directory_picker,
        remote_connection_picker: &remote_connection_picker,
        remote_connection_manager: &remote_connection_manager,
        remote_tunnel_manager: &RemoteTunnelManagerState::default(),
        memories: &crate::memories::State::default(),
        keybindings: &keybindings,
        quick_access: &quick_access,
        settings: &settings,
        keybinding_diagnostics: &[],
        theme_scheme: ash_ui_theme::ColorScheme::Light,
        theme_follows_system: true,
        window_control_insets: WindowControlInsets::NONE,
        pointer_position: None,
    };
    let mut presentation =
        build_workbench_presentation(viewport(), closed_model.clone(), &mut text_layout);
    let base_scene = presentation.frame().scene().clone();
    let base_interactions = presentation.interaction_frame().clone();
    let base_accessibility = accessibility_nodes(&presentation, &dispatch);
    let mut menu = TabContextMenuState::default();
    menu.open_unpinned(
        TabInputKey::session(
            ash_protocol::SessionId::new("context-menu-session")
                .expect("test session ID is non-empty"),
        ),
        Point::new(200.0, 100.0),
        None,
    );

    assert!(rebuild_workbench_overlays(
        &mut presentation,
        viewport(),
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            tab_context_menu: menu,
            ..closed_model.clone()
        },
        &mut text_layout,
    ));
    assert!(
        presentation
            .interaction_frame()
            .node(TAB_CONTEXT_MENU)
            .is_some()
    );
    assert_ne!(*presentation.frame().scene(), base_scene);

    assert!(rebuild_workbench_overlays(
        &mut presentation,
        viewport(),
        closed_model,
        &mut text_layout,
    ));
    assert_eq!(*presentation.frame().scene(), base_scene);
    assert_eq!(*presentation.interaction_frame(), base_interactions);
    assert_eq!(
        accessibility_nodes(&presentation, &dispatch),
        base_accessibility
    );
}

#[test]
fn titlebar_drags_the_window_and_composer_is_a_registered_input_region() {
    let presentation = presentation(None, 0);
    let mut dispatch = UiDispatch::default();

    assert_eq!(
        dispatch
            .pointer_moved(Point::new(500.0, 17.0), &presentation.interaction_frame())
            .invalidation,
        DispatchInvalidation::Paint
    );
    assert_eq!(
        dispatch
            .press_primary(&presentation.interaction_frame())
            .intent,
        Some(UiIntent::StartWindowDrag(TITLEBAR))
    );
    assert_eq!(
        dispatch
            .pointer_moved(Point::new(500.0, 640.0), &presentation.interaction_frame())
            .invalidation,
        DispatchInvalidation::Paint
    );
    assert_eq!(
        presentation
            .interaction_frame()
            .target_at(Point::new(500.0, 640.0)),
        Some(COMPOSER)
    );
    assert_eq!(
        presentation
            .interaction_frame()
            .target_at(Point::new(28.0, 688.0)),
        Some(COMPOSER_PANEL)
    );
    assert_eq!(
        dispatch.pointer_feedback(&presentation.interaction_frame()),
        CursorFeedback::Text
    );
}

#[test]
fn context_toolbar_starts_with_environment_below_the_composer_editor() {
    let presentation = presentation(None, 0);
    let mut dispatch = UiDispatch::default();

    assert_eq!(
        dispatch
            .pointer_moved(Point::new(40.0, 676.0), &presentation.interaction_frame())
            .invalidation,
        DispatchInvalidation::Paint
    );
    assert_eq!(
        presentation
            .interaction_frame()
            .target_at(Point::new(40.0, 676.0)),
        Some(ContextAction::Location.element_id())
    );
    assert_eq!(
        dispatch.pointer_feedback(&presentation.interaction_frame()),
        CursorFeedback::Pointer
    );
    assert_eq!(
        dispatch
            .press_primary(&presentation.interaction_frame())
            .invalidation,
        DispatchInvalidation::Paint
    );
    assert!(dispatch.is_pressed(ContextAction::Location.element_id()));
}

#[test]
fn compact_viewport_uses_bounded_fallback_scene() {
    let session_pane = SessionPaneState::default();
    let session_search = SessionSearchState::default();
    let sidebar_part = SidebarPart::default();
    let environment_context = TestEnvironmentContext::fixture("/tmp/project", None, None);
    let mut text_layout = TextInputLayoutEngine::new();
    let dispatch = UiDispatch::default();
    let files = FilesState::default();
    let scm = ScmState::default();
    let file_editor_host = FileEditorHost::default();
    let code_editor_style = CodeEditorStyle::light();
    let presentation = build_workbench_presentation(
        LogicalViewport {
            width: 220.0,
            height: 100.0,
        },
        WorkbenchPresentationModel {
            app_name: APP_DISPLAY_NAME,
            palette: ash_ui_theme::DEFAULT_UI_THEME,
            typography: ash_ui_theme::DEFAULT_UI_TYPOGRAPHY.clone(),
            terminal: None,
            terminal_panes: &[],
            pane_group: None,
            active_pane: None,
            terminal_pane_resize_split: None,
            terminal_scroll_offset: 0,
            terminal_scrollbar_presentation: ScrollbarPresentation::default(),
            terminal_selection: None,
            main_surface: MainSurfaceKind::Agent,
            file_editor_host: &file_editor_host,
            file_editor_prompt: ash_editor_host::FileEditorPrompt::None,
            file_editor_search: &ash_editor_host::FileEditorSearchState::default(),
            file_editor_diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            code_editor_style: &code_editor_style,
            session_pane: &session_pane,
            environment_context: environment_context_view(&environment_context),
            session_search: &session_search,
            sidebar_part: &sidebar_part,
            active_tab_input: None,
            caret_visibility: CaretVisibility::Visible,
            dispatch: &dispatch,
            tab_container: TabContainerState::collapsed(),
            inspector_part: InspectorPartState::default(),
            files: &files,
            scm: &scm,
            files_pane_expanded: false,
            tab_context_menu: TabContextMenuState::default(),
            git_branch_picker: &GitBranchPickerState::default(),
            directory_picker: &DirectoryPickerState::default(),
            remote_connection_picker: &RemoteConnectionPickerState::default(),
            remote_connection_manager: &RemoteConnectionManagerState::default(),
            remote_tunnel_manager: &RemoteTunnelManagerState::default(),
            memories: &crate::memories::State::default(),
            keybindings: &TestKeybindings,
            quick_access: &QuickAccess::default(),
            settings: &SettingsState::default(),
            keybinding_diagnostics: &[],
            theme_scheme: ash_ui_theme::ColorScheme::Light,
            theme_follows_system: true,
            window_control_insets: WindowControlInsets::NONE,
            pointer_position: None,
        },
        &mut text_layout,
    );

    assert_eq!(presentation.frame().scene().rects().len(), 1);
    assert_eq!(presentation.frame().scene().text_blocks().len(), 1);
    assert_eq!(presentation.frame().scene().text_blocks()[0].text(), "app");
}

#[test]
fn primary_reserves_rows_for_composer_while_alternate_screen_uses_full_height() {
    let primary = terminal_grid_size_for_viewport(
        viewport(),
        ScreenBuffer::Primary,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
    );
    let alternate = terminal_grid_size_for_viewport(
        viewport(),
        ScreenBuffer::Alternate,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
    );

    assert_eq!(primary, GridSize::new(27, 119));
    assert_eq!(alternate, GridSize::new(34, 119));
}

#[test]
fn primary_pointer_coordinates_are_limited_to_the_output_region() {
    let first = terminal_mouse_position_for_viewport(
        viewport(),
        ScreenBuffer::Primary,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
        Point::new(24.0, 60.0),
    )
    .unwrap();
    let composer = terminal_mouse_position_for_viewport(
        viewport(),
        ScreenBuffer::Primary,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
        Point::new(40.0, 640.0),
    );

    assert_eq!((first.row(), first.col()), (0, 0));
    assert_eq!(composer, None);
}

#[test]
fn terminal_pane_sash_hit_uses_the_same_grid_geometry_as_the_panes() {
    let mut group = PanePart::new();
    group.split_active(PaneSplitDirection::Horizontal);

    let hit = terminal_pane_sash_for_viewport(
        viewport(),
        ScreenBuffer::Alternate,
        TabContainerState::collapsed(),
        InspectorPartState::default(),
        &group,
        Point::new(500.0, 300.0),
    )
    .expect("horizontal terminal Pane Sash");

    assert_eq!(hit.1, zui::ui::SplitViewOrientation::Horizontal);
    assert!(hit.2.resize(80.0).previous_size() > hit.2.resize(0.0).previous_size());
}

#[test]
fn primary_terminal_blocks_do_not_override_the_agent_timeline() {
    let mut terminal = TerminalCore::new(GridSize::new(29, 119));
    terminal.process_output(b"$ ");
    terminal.start_command("printf hi");
    terminal.process_output(b"\x1b[32mhi\x1b[0m\r\n");

    let presentation = presentation(Some(&terminal), 0);
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();

    assert!(!visible_text.contains(&"❯ printf hi"));
    assert!(!visible_text.contains(&"hi"));
    assert!(visible_text.contains(&"Ask Ash anything…"));
}

#[test]
fn primary_terminal_scrollback_does_not_change_the_agent_timeline() {
    let mut terminal = TerminalCore::new(GridSize::new(29, 119));
    terminal.start_command("history");
    for index in 0..80 {
        terminal.process_output(format!("line-{index}\r\n").as_bytes());
    }
    let presentation = presentation(Some(&terminal), 80);
    let visible_text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();

    assert!(!visible_text.contains(&"❯ history"));
    assert!(!visible_text.contains(&"line-0"));
    assert!(!visible_text.contains(&"line-79"));
    assert!(visible_text.contains(&"Ask Ash anything…"));
}

#[test]
fn primary_ime_candidate_position_comes_from_the_bottom_composer() {
    let terminal = TerminalCore::new(GridSize::new(29, 119));
    let layout = WorkbenchSceneLayout::for_viewport(
        viewport(),
        TabContainerState::collapsed(),
        InspectorPartState::default(),
    )
    .unwrap();

    let presentation = presentation(Some(&terminal), 0);
    let caret = presentation.ime_cursor_area.unwrap();

    assert!(layout.composer.contains(caret.origin));
}

#[test]
fn alternate_screen_ime_position_comes_from_the_terminal_cursor() {
    let mut terminal = TerminalCore::new(GridSize::new(34, 119));
    terminal.process_output(b"\x1b[?1049habc");

    let presentation = presentation(Some(&terminal), 0);
    let caret = presentation.ime_cursor_area.unwrap();

    assert_eq!(caret.origin, Point::new(48.0, 56.0));
    assert_eq!(caret.size.width, 8.0);
    assert_eq!(caret.size.height, 18.0);
}

#[test]
fn background_terminal_title_does_not_create_a_placeholder_session() {
    let mut terminal = TerminalCore::new(GridSize::new(29, 119));
    terminal.process_output(b"\x1b]2;project shell\x07");

    let presentation =
        presentation_with_tab_container(Some(&terminal), 0, TabContainerState::expanded());

    let text = presentation
        .frame()
        .scene()
        .text_blocks()
        .iter()
        .map(|block| block.text())
        .collect::<Vec<_>>();
    assert!(!text.contains(&APP_DISPLAY_NAME));
    assert!(!text.contains(&"project shell"));
}
