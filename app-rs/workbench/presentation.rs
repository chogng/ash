use ash_commands::AppCommandId;
use ash_editor_host::{
    FILE_EDITOR_DOCUMENT, FILE_EDITOR_FIND_INPUT, FILE_EDITOR_REPLACE_INPUT, FileEditorHost,
    FileEditorPane, FileEditorPrompt, FileEditorSearchState,
};
use ash_keybinding::{HostPlatform, KeySequence};
use ash_settings::REMOTE_CONNECTION_SEARCH_INPUT;
use ash_settings::REMOTE_TUNNEL_REMOTE_PORT;
use ash_settings::RemoteConnectionManager;
use ash_settings::RemoteConnectionManagerField;
use ash_settings::RemoteConnectionManagerState;
use ash_settings::RemoteConnectionPicker;
use ash_settings::RemoteConnectionPickerState;
use ash_settings::RemoteTunnelManager;
use ash_settings::RemoteTunnelManagerState;
use ash_terminal::{GridSize, ScreenBuffer, TerminalCore, TerminalMousePosition};
use ash_ui_components::{
    Dialog, DialogIds, DialogStyle, InteractionRegion, Sash, SashOrientation, SashState, SashStyle,
    ScrollMetrics, ScrollView, ScrollbarPresentation,
};
use zui::ui::{
    Border, BoxShadow, CaretVisibility, Color, CornerRadii, FontWeight, PaintRect, Rect,
    SceneCheckpoint, Size, SplitViewOrientation, SplitViewResizeSnapshot, TextBlock,
    TextInputLayoutEngine, TextStyle, UiScene,
};

use crate::PaneBinding;
use crate::QuickAccess;
use crate::SessionSearchState;
use crate::{
    InspectorPartState, PaneGroupId as PaneId, PaneInputKind, PaneMount, PanePart, PanePartSashes,
    PaneSplitId, SidebarPart, SidebarView, TITLEBAR_HEIGHT, TabContainerState, TabInputKey,
    Titlebar, TitlebarInsets, mounted_sidebar_item_id, pane_group_element_id,
    sidebar_selected_item_id, sidebar_session_groups,
};
use crate::{
    MainSurfaceKind, SESSION_SEARCH_INPUT, TabContextMenu, TabContextMenuState, WINDOW,
    paint_chord_hint,
};
use ash_files::FILE_SEARCH_INPUT;
use ash_files::FilesLayout;
use ash_files::FilesPane;
use ash_files::FilesState;
use ash_files::FilesToolbar;
use ash_scm::EditorPane;
use ash_scm::ScmState;
use ash_scm::{GIT_BRANCH_SEARCH_INPUT, GitBranchPicker, GitBranchPickerState};
use ash_session::SessionPaneContext;
use ash_session::SessionPaneLayout;
use ash_session::SessionPaneState;
use ash_session::SessionPaneView;
use ash_session::draw_session_pane;
use ash_terminal_runtime::TerminalSelectionRange;
use ash_ui_theme::UiTheme;

use crate::directory_picker::DIRECTORY_SEARCH_INPUT;
use crate::directory_picker::DirectoryPicker;
use crate::directory_picker::DirectoryPickerState;

type PaneViewMount<'a> = PaneMount<'a, PaneBinding>;
use crate::InspectorLayoutSpec;
use crate::PaneGroupLayout;
use crate::PartVisibility;
use crate::WorkbenchLayout;
use crate::WorkbenchLayoutSpec;
use ash_editor::CodeEditorStyle;
use ash_settings::AppearanceSettingsSnapshot;
use ash_settings::GeneralSettingsSnapshot;
use ash_settings::KeybindingSettingsSnapshot;
use ash_settings::RemoteSettingsSnapshot;
use ash_settings::SettingsFeatureSnapshot;
use ash_settings::SettingsPaneStyle;
use ash_settings::SettingsPaneView;
use ash_settings::SettingsState;
use zui::ui::{
    AccessibilityRole, ComponentContext, CursorFeedback, ElementId, InteractionFrame,
    InteractionFrameCheckpoint, UiDispatch, UiFrame,
};
use zui::window::WindowControlInsets;

const COMPOSER_HEIGHT: f32 = 44.0;
const SETTINGS_DIALOG_WIDTH: f32 = 960.0;
const SETTINGS_DIALOG_HEIGHT: f32 = 710.0;

pub const MAIN_SURFACE: ElementId = ElementId::scoped(1, 3);
pub const TERMINAL_OUTPUT: ElementId = ElementId::scoped(1, 4);
pub const TAB_CONTAINER_RESIZE_HANDLE: ElementId = ElementId::scoped(1, 16);
pub const INSPECTOR_RESIZE_HANDLE: ElementId = ElementId::scoped(1, 51);
pub const SETTINGS_DIALOG: ElementId = ElementId::scoped(1, 56);

pub(crate) use crate::LogicalViewport;

pub trait WorkbenchKeybindings {
    fn pending_keybinding(&self) -> Option<(&KeySequence, usize)>;
    fn platform(&self) -> HostPlatform;
    fn binding_for_command(&self, command: AppCommandId) -> Option<&KeySequence>;
}

impl<C> WorkbenchKeybindings for ash_keybindings_host::Keybindings<C>
where
    C: ash_keybindings_host::KeybindingCatalog<Command = AppCommandId>,
{
    fn pending_keybinding(&self) -> Option<(&KeySequence, usize)> {
        self.pending_keybinding()
    }

    fn platform(&self) -> HostPlatform {
        self.platform()
    }

    fn binding_for_command(&self, command: AppCommandId) -> Option<&KeySequence> {
        self.binding_for_command(command)
    }
}

#[derive(Clone)]
pub struct EnvironmentContextView<'a> {
    pub location: &'a str,
    pub working_directory: &'a str,
    pub git_branch: &'a str,
    pub diff_summary: String,
    pub upstream_distance: Option<(usize, usize)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkbenchSceneLayout {
    pub workbench: WorkbenchLayout,
    pub output: Rect,
    pub session_header: Rect,
    pub thread_timeline: Rect,
    pub session_pane_layout: SessionPaneLayout,
    pub composer_panel: Rect,
    pub composer_key_hint_bar: Rect,
    pub composer_toolbar: Rect,
    pub composer: Rect,
}

impl WorkbenchSceneLayout {
    pub fn titlebar(self) -> Rect {
        self.workbench.titlebar()
    }

    pub fn tab_container(self) -> Option<Rect> {
        self.workbench.tab_container()
    }

    fn tab_container_sash_track(self) -> Option<Rect> {
        self.workbench.tab_container_sash_track()
    }

    fn inspector(self) -> Option<Rect> {
        self.workbench.inspector()
    }

    fn inspector_sash_track(self) -> Option<Rect> {
        self.workbench.inspector_sash_track()
    }

    fn inspector_resize_snapshot(self) -> Option<SplitViewResizeSnapshot> {
        self.workbench.inspector_resize_snapshot()
    }

    pub fn main(self) -> Rect {
        self.workbench.main()
    }

    pub fn for_viewport(
        viewport: LogicalViewport,
        tab_container: TabContainerState,
        inspector_part: InspectorPartState,
    ) -> Option<Self> {
        Self::for_viewport_with_composer_and_interaction_height(
            viewport,
            tab_container,
            inspector_part,
            COMPOSER_HEIGHT,
            0.0,
        )
    }

    #[cfg(test)]
    pub fn for_viewport_with_composer_height(
        viewport: LogicalViewport,
        tab_container: TabContainerState,
        inspector_part: InspectorPartState,
        preferred_composer_height: f32,
    ) -> Option<Self> {
        Self::for_viewport_with_composer_and_interaction_height(
            viewport,
            tab_container,
            inspector_part,
            preferred_composer_height,
            0.0,
        )
    }

    fn for_viewport_with_composer_and_interaction_height(
        viewport: LogicalViewport,
        tab_container: TabContainerState,
        inspector_part: InspectorPartState,
        preferred_composer_height: f32,
        preferred_interaction_height: f32,
    ) -> Option<Self> {
        let workbench = WorkbenchLayoutSpec::new(
            TITLEBAR_HEIGHT,
            tab_container.layout_spec(),
            InspectorLayoutSpec::new(
                if inspector_part.is_expanded() {
                    PartVisibility::Expanded
                } else {
                    PartVisibility::Collapsed
                },
                inspector_part.preferred_width(),
                360.0,
                800.0,
                400.0,
            ),
        )
        .for_viewport(viewport)?;
        let main = workbench.main();
        let session_pane_layout = SessionPaneLayout::for_bounds(
            main,
            preferred_composer_height.max(COMPOSER_HEIGHT),
            preferred_interaction_height,
        );
        let composer_panel = session_pane_layout.composer();
        let output = composer_panel.output();
        Some(Self {
            workbench,
            output,
            session_header: session_pane_layout.header(),
            thread_timeline: session_pane_layout.timeline(),
            session_pane_layout,
            composer_panel: composer_panel.panel(),
            composer_key_hint_bar: composer_panel.key_hint_bar(),
            composer_toolbar: composer_panel.toolbar(),
            composer: composer_panel.editor(),
        })
    }
}

pub fn inspector_resize_snapshot_for_viewport(
    viewport: LogicalViewport,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
) -> Option<SplitViewResizeSnapshot> {
    WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)
        .and_then(WorkbenchSceneLayout::inspector_resize_snapshot)
}

pub struct WorkbenchPresentation {
    pub frame: UiFrame<InteractionFrame>,
    pub ime_cursor_area: Option<Rect>,
    pub tab_container_scroll_metrics: Option<ScrollMetrics>,
    pub tab_container_scroll_view: Option<ScrollView>,
    pub directory_picker_scroll_metrics: Option<ScrollMetrics>,
    pub directory_picker_item_viewport: Option<Rect>,
    pub remote_connection_picker_scroll_metrics: Option<ScrollMetrics>,
    pub remote_connection_picker_item_viewport: Option<Rect>,
    pub remote_connection_manager_scroll_metrics: Option<ScrollMetrics>,
    pub remote_connection_manager_list_viewport: Option<Rect>,
    pub remote_tunnel_manager_scroll_metrics: Option<ScrollMetrics>,
    pub remote_tunnel_manager_list_viewport: Option<Rect>,
    base_checkpoint: Option<WorkbenchBaseCheckpoint>,
}

impl WorkbenchPresentation {
    pub fn frame(&self) -> &UiFrame<InteractionFrame> {
        &self.frame
    }

    pub fn scene_mut(&mut self) -> &mut UiScene {
        self.frame.scene_mut()
    }

    pub fn interaction_frame(&self) -> &InteractionFrame {
        self.frame.interaction()
    }

    pub fn interaction_frame_mut(&mut self) -> &mut InteractionFrame {
        self.frame.interaction_mut()
    }

    pub fn element_bounds(&self, id: ElementId) -> Option<Rect> {
        self.interaction_frame().node(id).map(|node| node.bounds())
    }
}

#[derive(Clone, Debug, PartialEq)]
struct WorkbenchBaseCheckpoint {
    scene: SceneCheckpoint,
    interaction: InteractionFrameCheckpoint,
    ime_cursor_area: Option<Rect>,
}

struct WorkbenchOverlayPresentation {
    ime_cursor_area: Option<Rect>,
    directory_picker_scroll_metrics: Option<ScrollMetrics>,
    directory_picker_item_viewport: Option<Rect>,
    remote_connection_picker_scroll_metrics: Option<ScrollMetrics>,
    remote_connection_picker_item_viewport: Option<Rect>,
    remote_connection_manager_scroll_metrics: Option<ScrollMetrics>,
    remote_connection_manager_list_viewport: Option<Rect>,
    remote_tunnel_manager_scroll_metrics: Option<ScrollMetrics>,
    remote_tunnel_manager_list_viewport: Option<Rect>,
}

#[derive(Clone, Copy)]
pub struct PaneView<'a> {
    pub pane_id: Option<PaneId>,
    pub kind: PaneInputKind,
    pub core: Option<&'a TerminalCore>,
    pub scroll_offset: usize,
    pub scrollbar_presentation: ScrollbarPresentation,
    pub selection: Option<TerminalSelectionRange>,
}

#[derive(Clone)]
pub struct WorkbenchPresentationModel<'a> {
    pub app_name: &'a str,
    pub palette: UiTheme,
    pub typography: ash_ui_theme::UiTypography,
    pub terminal: Option<&'a TerminalCore>,
    pub terminal_panes: &'a [PaneView<'a>],
    pub pane_group: Option<&'a PanePart>,
    pub active_pane: Option<PaneViewMount<'a>>,
    pub terminal_pane_resize_split: Option<PaneSplitId>,
    pub terminal_scroll_offset: usize,
    pub terminal_scrollbar_presentation: ScrollbarPresentation,
    pub terminal_selection: Option<TerminalSelectionRange>,
    pub main_surface: MainSurfaceKind,
    pub file_editor_host: &'a FileEditorHost,
    pub file_editor_prompt: FileEditorPrompt,
    pub file_editor_search: &'a FileEditorSearchState,
    pub file_editor_diagnostics: &'a [ash_editor::CodeEditorDiagnostic],
    pub language_hover: Option<&'a ash_lsp_manager::LanguageHover>,
    pub language_completions: Option<&'a ash_lsp_manager::LanguageCompletions>,
    pub completion_selection: usize,
    pub code_editor_style: &'a CodeEditorStyle,
    pub session_pane: &'a SessionPaneState,
    pub environment_context: EnvironmentContextView<'a>,
    pub session_search: &'a SessionSearchState,
    pub sidebar_part: &'a SidebarPart,
    pub active_tab_input: Option<&'a TabInputKey>,
    pub caret_visibility: CaretVisibility,
    pub dispatch: &'a UiDispatch,
    pub tab_container: TabContainerState,
    pub inspector_part: InspectorPartState,
    pub files: &'a FilesState,
    pub scm: &'a ScmState,
    pub files_pane_expanded: bool,
    pub tab_context_menu: TabContextMenuState,
    pub git_branch_picker: &'a GitBranchPickerState,
    pub directory_picker: &'a DirectoryPickerState,
    pub remote_connection_picker: &'a RemoteConnectionPickerState,
    pub remote_connection_manager: &'a RemoteConnectionManagerState,
    pub remote_tunnel_manager: &'a RemoteTunnelManagerState,
    pub memories: &'a crate::memories::State,
    pub keybindings: &'a dyn WorkbenchKeybindings,
    pub quick_access: &'a QuickAccess,
    pub settings: &'a SettingsState,
    pub keybinding_diagnostics: &'a [String],
    pub theme_scheme: ash_ui_theme::ColorScheme,
    pub theme_follows_system: bool,
    pub window_control_insets: WindowControlInsets,
    pub pointer_position: Option<zui::ui::Point>,
}

#[derive(Clone)]
struct TabContainerView<'a> {
    search: &'a SessionSearchState,
    sidebar_part: &'a SidebarPart,
    selected_id: ElementId,
    visible_action_bar_tab: Option<&'a TabInputKey>,
    scroll: ash_ui_components::ScrollState,
    scrollbar_presentation: ScrollbarPresentation,
    caret_visibility: CaretVisibility,
    dispatch: &'a UiDispatch,
}

#[derive(Clone, Copy)]
struct FileEditorPresentationView<'a> {
    host: &'a FileEditorHost,
    prompt: FileEditorPrompt,
    search: &'a FileEditorSearchState,
    diagnostics: &'a [ash_editor::CodeEditorDiagnostic],
    language_hover: Option<&'a ash_lsp_manager::LanguageHover>,
    language_completions: Option<&'a ash_lsp_manager::LanguageCompletions>,
    completion_selection: usize,
    style: &'a CodeEditorStyle,
    caret_visibility: CaretVisibility,
    dispatch: &'a UiDispatch,
    pointer_position: Option<zui::ui::Point>,
}

#[derive(Clone)]
struct MainPresentationView<'a> {
    terminal: PaneView<'a>,
    terminal_panes: &'a [PaneView<'a>],
    pane_group: Option<&'a PanePart>,
    active_pane: Option<PaneViewMount<'a>>,
    terminal_pane_resize_split: Option<PaneSplitId>,
    main_surface: MainSurfaceKind,
    session_title: &'a str,
    session_pane: &'a SessionPaneState,
    session_pane_context: &'a SessionPaneContext,
    files: &'a FilesState,
    scm: &'a ScmState,
    files_pane_expanded: bool,
    environment_context: EnvironmentContextView<'a>,
    caret_visibility: CaretVisibility,
    dispatch: &'a UiDispatch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct MainDrawResult {
    ime_cursor_area: Option<Rect>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct TabContainerDrawResult {
    search_caret: Option<Rect>,
    scroll_metrics: Option<ScrollMetrics>,
    scroll_view: Option<ScrollView>,
}

#[cfg(test)]
pub fn build_workbench_presentation(
    viewport: LogicalViewport,
    model: WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
) -> WorkbenchPresentation {
    build_workbench_presentation_with_bindings(
        viewport,
        model,
        text_layout,
        SashState::Resting,
        None,
    )
}

pub fn build_workbench_presentation_with_animation_bindings(
    viewport: LogicalViewport,
    model: WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
    inspector_sash_state: SashState,
    animation_bindings: &mut dyn zui::ui::AnimationBinding,
) -> WorkbenchPresentation {
    build_workbench_presentation_with_bindings(
        viewport,
        model,
        text_layout,
        inspector_sash_state,
        Some(animation_bindings),
    )
}

fn build_workbench_presentation_with_bindings(
    viewport: LogicalViewport,
    model: WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
    inspector_sash_state: SashState,
    mut animation_bindings: Option<&mut dyn zui::ui::AnimationBinding>,
) -> WorkbenchPresentation {
    let palette = model.palette;
    let mut frame = UiFrame::<InteractionFrame>::new(palette.workbench_background);
    frame.draw_component(&InteractionRegion::new(
        "Window",
        WINDOW,
        Rect::from_xywh(0.0, 0.0, viewport.width, viewport.height),
        AccessibilityRole::Window,
        model.app_name,
    ));
    let Some(layout) = WorkbenchSceneLayout::for_viewport_with_composer_and_interaction_height(
        viewport,
        model.tab_container,
        model.inspector_part,
        model.session_pane.composer_preferred_height(),
        model
            .session_pane
            .composer_interaction_view()
            .map_or(0.0, |view| {
                ash_session::interaction_preferred_height(view.items().len())
            }),
    ) else {
        draw_compact_scene(frame.scene_mut(), viewport, model.app_name, palette);
        return WorkbenchPresentation {
            frame,
            ime_cursor_area: None,
            tab_container_scroll_metrics: None,
            tab_container_scroll_view: None,
            directory_picker_scroll_metrics: None,
            directory_picker_item_viewport: None,
            remote_connection_picker_scroll_metrics: None,
            remote_connection_picker_item_viewport: None,
            remote_connection_manager_scroll_metrics: None,
            remote_connection_manager_list_viewport: None,
            remote_tunnel_manager_scroll_metrics: None,
            remote_tunnel_manager_list_viewport: None,
            base_checkpoint: None,
        };
    };

    let session_input = model
        .active_tab_input
        .filter(|input| input.is_session())
        .and_then(|selected| model.sidebar_part.input(selected))
        .or_else(|| {
            let selected = model.sidebar_part.selected_session()?;
            model
                .sidebar_part
                .inputs()
                .find(|input| input.session_id() == Some(selected))
        });
    let session_title = session_input
        .map(|input| model.sidebar_part.tab_name(input))
        .unwrap_or("New session");
    let session_pane_context = SessionPaneContext::new(
        model.environment_context.location,
        model.environment_context.working_directory,
        model.environment_context.git_branch,
        &model.environment_context.diff_summary,
    );
    let selected_id = sidebar_selected_item_id(model.sidebar_part, model.active_tab_input);
    let titlebar = Titlebar::new(
        layout.titlebar(),
        crate::WorkbenchUiStyle::from_theme(palette, &model.typography),
        model.tab_container.is_expanded(),
        TitlebarInsets::new(
            model.window_control_insets.left(),
            model.window_control_insets.right(),
        ),
        model.dispatch,
    );
    frame.draw_component(&titlebar);
    let tab_container_draw = if let Some(bounds) = layout.tab_container() {
        frame.with_context(|context| {
            draw_tab_container(
                context,
                bounds,
                Rect::from_xywh(0.0, 0.0, viewport.width, viewport.height),
                TabContainerView {
                    search: model.session_search,
                    sidebar_part: model.sidebar_part,
                    selected_id,
                    visible_action_bar_tab: model.tab_context_menu.target_tab(),
                    scroll: model.tab_container.scroll_state(),
                    scrollbar_presentation: model.tab_container.scrollbar_presentation(),
                    caret_visibility: model.caret_visibility,
                    dispatch: model.dispatch,
                },
                text_layout,
                palette,
                &model.typography,
            )
        })
    } else {
        TabContainerDrawResult::default()
    };
    let session_search_caret = tab_container_draw.search_caret;
    let file_editor_caret = if let Some(bounds) = layout.inspector() {
        if model.main_surface == MainSurfaceKind::Editor {
            frame.with_context(|context| {
                draw_file_editor_inspector(
                    context,
                    bounds,
                    FileEditorPresentationView {
                        host: model.file_editor_host,
                        prompt: model.file_editor_prompt,
                        search: model.file_editor_search,
                        diagnostics: model.file_editor_diagnostics,
                        language_hover: model.language_hover,
                        language_completions: model.language_completions,
                        completion_selection: model.completion_selection,
                        style: model.code_editor_style,
                        caret_visibility: model.caret_visibility,
                        dispatch: model.dispatch,
                        pointer_position: model.pointer_position,
                    },
                    text_layout,
                    palette,
                )
            })
        } else {
            None
        }
    } else {
        None
    };
    let main_draw = |context: &mut ComponentContext<'_, '_>| {
        draw_main(
            context,
            layout,
            MainPresentationView {
                terminal: PaneView {
                    pane_id: None,
                    kind: PaneInputKind::Terminal,
                    core: model.terminal,
                    scroll_offset: model.terminal_scroll_offset,
                    scrollbar_presentation: model.terminal_scrollbar_presentation,
                    selection: model.terminal_selection,
                },
                terminal_panes: model.terminal_panes,
                pane_group: model.pane_group,
                active_pane: model.active_pane,
                terminal_pane_resize_split: model.terminal_pane_resize_split,
                main_surface: model.main_surface,
                session_title,
                session_pane: model.session_pane,
                session_pane_context: &session_pane_context,
                files: model.files,
                scm: model.scm,
                files_pane_expanded: model.files_pane_expanded,
                environment_context: model.environment_context.clone(),
                caret_visibility: model.caret_visibility,
                dispatch: model.dispatch,
            },
            palette,
            text_layout,
        )
    };
    let main_draw = match animation_bindings.as_deref_mut() {
        Some(animation_bindings) => frame.with_animation_bindings(animation_bindings, main_draw),
        None => frame.with_context(main_draw),
    };
    if let Some(bounds) = layout.inspector() {
        draw_inspector_border(frame.scene_mut(), bounds, palette);
    }
    if let Some(bounds) = layout.inspector_sash_track() {
        frame.with_context(|context| {
            draw_sash(
                context,
                bounds,
                SashOrientation::Vertical,
                inspector_sash_state,
                INSPECTOR_RESIZE_HANDLE,
                "InspectorPartResizeHandle",
                "Resize inspector",
                palette,
            )
        });
    }
    let ime_cursor_area = if model.dispatch.is_focused(FILE_EDITOR_DOCUMENT)
        || model.dispatch.is_focused(FILE_EDITOR_FIND_INPUT)
        || model.dispatch.is_focused(FILE_EDITOR_REPLACE_INPUT)
    {
        file_editor_caret
    } else if model.dispatch.is_focused(SESSION_SEARCH_INPUT) {
        session_search_caret
    } else {
        main_draw.ime_cursor_area
    };
    if let Some(bounds) = layout.tab_container_sash_track() {
        frame.with_context(|context| {
            draw_sash(
                context,
                bounds,
                SashOrientation::Vertical,
                model.tab_container.sash_state(),
                TAB_CONTAINER_RESIZE_HANDLE,
                "TabContainerResizeHandle",
                "Resize tabs",
                palette,
            )
        });
    }
    let base_checkpoint = WorkbenchBaseCheckpoint {
        scene: frame.scene().checkpoint(),
        interaction: frame.interaction().checkpoint(),
        ime_cursor_area,
    };
    let overlay =
        draw_workbench_overlays(&mut frame, viewport, &model, text_layout, ime_cursor_area);
    WorkbenchPresentation {
        frame,
        ime_cursor_area: overlay.ime_cursor_area,
        tab_container_scroll_metrics: tab_container_draw.scroll_metrics,
        tab_container_scroll_view: tab_container_draw.scroll_view,
        directory_picker_scroll_metrics: overlay.directory_picker_scroll_metrics,
        directory_picker_item_viewport: overlay.directory_picker_item_viewport,
        remote_connection_picker_scroll_metrics: overlay.remote_connection_picker_scroll_metrics,
        remote_connection_picker_item_viewport: overlay.remote_connection_picker_item_viewport,
        remote_connection_manager_scroll_metrics: overlay.remote_connection_manager_scroll_metrics,
        remote_connection_manager_list_viewport: overlay.remote_connection_manager_list_viewport,
        remote_tunnel_manager_scroll_metrics: overlay.remote_tunnel_manager_scroll_metrics,
        remote_tunnel_manager_list_viewport: overlay.remote_tunnel_manager_list_viewport,
        base_checkpoint: Some(base_checkpoint),
    }
}

/// Replaces only volatile Workbench overlays while retaining base layout, paint, and interaction data.
pub fn rebuild_workbench_overlays(
    presentation: &mut WorkbenchPresentation,
    viewport: LogicalViewport,
    model: WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
) -> bool {
    let Some(base) = presentation.base_checkpoint.clone() else {
        return false;
    };
    presentation.scene_mut().restore(&base.scene);
    presentation
        .interaction_frame_mut()
        .restore(base.interaction);
    let overlay = draw_workbench_overlays(
        &mut presentation.frame,
        viewport,
        &model,
        text_layout,
        base.ime_cursor_area,
    );
    presentation.ime_cursor_area = overlay.ime_cursor_area;
    presentation.directory_picker_scroll_metrics = overlay.directory_picker_scroll_metrics;
    presentation.directory_picker_item_viewport = overlay.directory_picker_item_viewport;
    presentation.remote_connection_picker_scroll_metrics =
        overlay.remote_connection_picker_scroll_metrics;
    presentation.remote_connection_picker_item_viewport =
        overlay.remote_connection_picker_item_viewport;
    presentation.remote_connection_manager_scroll_metrics =
        overlay.remote_connection_manager_scroll_metrics;
    presentation.remote_connection_manager_list_viewport =
        overlay.remote_connection_manager_list_viewport;
    presentation.remote_tunnel_manager_scroll_metrics =
        overlay.remote_tunnel_manager_scroll_metrics;
    presentation.remote_tunnel_manager_list_viewport = overlay.remote_tunnel_manager_list_viewport;
    true
}

fn draw_workbench_overlays(
    frame: &mut UiFrame<InteractionFrame>,
    viewport: LogicalViewport,
    model: &WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
    mut ime_cursor_area: Option<Rect>,
) -> WorkbenchOverlayPresentation {
    let palette = model.palette;
    let viewport_bounds = Rect::from_xywh(0.0, 0.0, viewport.width, viewport.height);
    let mut directory_picker_scroll_metrics = None;
    let mut directory_picker_item_viewport = None;
    let mut remote_connection_picker_scroll_metrics = None;
    let mut remote_connection_picker_item_viewport = None;
    let mut remote_connection_manager_scroll_metrics = None;
    let mut remote_connection_manager_list_viewport = None;
    let mut remote_tunnel_manager_scroll_metrics = None;
    let mut remote_tunnel_manager_list_viewport = None;
    if model
        .active_tab_input
        .is_some_and(|input| input.is_settings())
    {
        let draw = frame.with_context(|context| {
            draw_settings_dialog(context, viewport_bounds, model, text_layout)
        });
        if draw.ime_cursor_area.is_some() {
            ime_cursor_area = draw.ime_cursor_area;
        }
        remote_connection_manager_scroll_metrics = draw.remote_connection_scroll_metrics;
        remote_connection_manager_list_viewport = draw.remote_connection_list_viewport;
    }
    if let Some(context_menu) = TabContextMenu::new(
        viewport_bounds,
        model.sidebar_part,
        &model.tab_context_menu,
        model.caret_visibility,
        crate::TabContextMenuStyle::from_theme(palette),
        WINDOW,
        text_layout,
        model.dispatch,
    ) {
        frame.draw_component(&context_menu);
    }
    if let Some(directory_picker) = DirectoryPicker::new(
        viewport_bounds,
        model.directory_picker,
        model.caret_visibility,
        palette,
        text_layout,
        model.dispatch,
    ) {
        directory_picker_scroll_metrics = directory_picker.scroll_metrics();
        directory_picker_item_viewport = Some(directory_picker.item_viewport_bounds());
        if model.dispatch.is_focused(DIRECTORY_SEARCH_INPUT) {
            ime_cursor_area = directory_picker.search_caret_bounds();
        }
        frame.draw_component(&directory_picker);
    }
    if let Some(connection_picker) = RemoteConnectionPicker::new(
        viewport_bounds,
        model.remote_connection_picker,
        model.caret_visibility,
        ash_settings::RemoteUiStyle::from_theme(palette),
        text_layout,
        model.dispatch,
        WINDOW,
    ) {
        remote_connection_picker_scroll_metrics = connection_picker.scroll_metrics();
        remote_connection_picker_item_viewport = Some(connection_picker.item_viewport_bounds());
        if model.dispatch.is_focused(REMOTE_CONNECTION_SEARCH_INPUT) {
            ime_cursor_area = connection_picker.search_caret_bounds();
        }
        frame.draw_component(&connection_picker);
    }
    if let Some(connection_manager) = RemoteConnectionManager::new(
        viewport_bounds,
        model.remote_connection_manager,
        model.caret_visibility,
        ash_settings::RemoteUiStyle::from_theme(palette),
        text_layout,
        model.dispatch,
        WINDOW,
    ) {
        remote_connection_manager_scroll_metrics = Some(connection_manager.list_scroll_metrics());
        remote_connection_manager_list_viewport = Some(connection_manager.list_viewport_bounds());
        for field in [
            RemoteConnectionManagerField::Name,
            RemoteConnectionManagerField::Host,
            RemoteConnectionManagerField::Directory,
        ] {
            if model.dispatch.is_focused(field.element_id()) {
                ime_cursor_area = connection_manager.caret_bounds(field);
            }
        }
        frame.draw_component(&connection_manager);
    }
    if let Some(tunnel_manager) = RemoteTunnelManager::new(
        viewport_bounds,
        model.remote_tunnel_manager,
        model.caret_visibility,
        ash_settings::RemoteUiStyle::from_theme(palette),
        text_layout,
        model.dispatch,
        WINDOW,
    ) {
        remote_tunnel_manager_scroll_metrics = Some(tunnel_manager.list_scroll_metrics());
        remote_tunnel_manager_list_viewport = Some(tunnel_manager.list_viewport_bounds());
        if model.dispatch.is_focused(REMOTE_TUNNEL_REMOTE_PORT) {
            ime_cursor_area = tunnel_manager.remote_port_caret_bounds();
        }
        frame.draw_component(&tunnel_manager);
    }
    if model.memories.open {
        ime_cursor_area = frame.with_context(|context| {
            crate::memories::draw(
                context,
                viewport_bounds,
                model.memories,
                palette,
                model.dispatch,
                model.caret_visibility,
                text_layout,
                model.code_editor_style,
            )
        });
    }
    if let Some(branch_picker) = GitBranchPicker::new(
        viewport_bounds,
        model.git_branch_picker,
        model.caret_visibility,
        palette,
        text_layout,
        model.dispatch,
    ) {
        if model.dispatch.is_focused(GIT_BRANCH_SEARCH_INPUT) {
            ime_cursor_area = branch_picker.search_caret_bounds();
        }
        frame.draw_component(&branch_picker);
    }
    if let Some((keybinding, entered)) = model.keybindings.pending_keybinding() {
        paint_chord_hint(
            frame.scene_mut(),
            viewport_bounds,
            keybinding,
            entered,
            model.keybindings.platform(),
        );
    }
    let shortcut_search_caret = if model.quick_access.shortcuts_open() {
        let shortcut_items = model.quick_access.shortcut_items(model.keybindings);
        let shortcut_rows = shortcut_items
            .iter()
            .map(|item| item.row())
            .collect::<Vec<_>>();
        ash_settings::draw_keyboard_shortcuts_overlay(
            frame,
            viewport_bounds,
            model.settings.keyboard_shortcuts(),
            model.quick_access.query_input(),
            &shortcut_rows,
            model.keybinding_diagnostics,
            WINDOW,
            model.keybindings.platform(),
            model.caret_visibility,
            text_layout,
            model.dispatch,
        )
    } else {
        None
    };
    if model
        .dispatch
        .is_focused(ash_settings::KEYBOARD_SHORTCUTS_SEARCH)
    {
        ime_cursor_area = shortcut_search_caret;
    }
    WorkbenchOverlayPresentation {
        ime_cursor_area,
        directory_picker_scroll_metrics,
        directory_picker_item_viewport,
        remote_connection_picker_scroll_metrics,
        remote_connection_picker_item_viewport,
        remote_connection_manager_scroll_metrics,
        remote_connection_manager_list_viewport,
        remote_tunnel_manager_scroll_metrics,
        remote_tunnel_manager_list_viewport,
    }
}

pub fn terminal_grid_size_for_viewport(
    viewport: LogicalViewport,
    active_screen: ScreenBuffer,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
) -> GridSize {
    let Some(layout) = WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)
    else {
        return GridSize::default();
    };
    let bounds = terminal_content_bounds(layout, active_screen);
    ash_terminal_runtime::grid_size(bounds)
}

pub fn terminal_grid_size_for_bounds(bounds: Rect) -> GridSize {
    ash_terminal_runtime::grid_size(bounds)
}

pub fn terminal_pane_bounds_for_viewport(
    viewport: LogicalViewport,
    active_screen: ScreenBuffer,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    group: &PanePart,
) -> Vec<(PaneId, Rect)> {
    let Some(layout) = WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)
    else {
        return Vec::new();
    };
    let bounds = terminal_content_bounds(layout, active_screen);
    PaneGroupLayout::for_tree(bounds, group.tree())
        .leaves()
        .iter()
        .map(|leaf| (leaf.id(), leaf.bounds()))
        .collect()
}

pub fn terminal_mouse_position_for_viewport(
    viewport: LogicalViewport,
    active_screen: ScreenBuffer,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    point: zui::ui::Point,
) -> Option<TerminalMousePosition> {
    let layout = WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)?;
    let bounds = terminal_content_bounds(layout, active_screen);
    if !bounds.contains(point) {
        return None;
    }
    ash_terminal_runtime::mouse_position(bounds, point)
}

pub fn terminal_pane_mouse_position_for_viewport(
    viewport: LogicalViewport,
    active_screen: ScreenBuffer,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    group: &PanePart,
    point: zui::ui::Point,
) -> Option<(PaneId, TerminalMousePosition)> {
    let Some(layout) = WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)
    else {
        return None;
    };
    let content_bounds = terminal_content_bounds(layout, active_screen);
    let pane_geometry = PaneGroupLayout::for_tree(content_bounds, group.tree());
    let leaf = pane_geometry
        .leaves()
        .iter()
        .find(|leaf| leaf.bounds().contains(point))?;
    let bounds = leaf.bounds();
    ash_terminal_runtime::mouse_position(bounds, point).map(|position| (leaf.id(), position))
}

fn draw_files_pane(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    files: &FilesState,
    environment_context: &EnvironmentContextView<'_>,
    parent: ElementId,
    caret_visibility: CaretVisibility,
    dispatch: &UiDispatch,
    text_layout: &mut TextInputLayoutEngine,
    palette: UiTheme,
) -> Option<Rect> {
    let layout = FilesLayout::for_bounds(bounds);
    let files_toolbar = FilesToolbar::new(
        layout.toolbar(),
        files,
        environment_context.upstream_distance,
        caret_visibility,
        ash_files::FilesToolbarStyle::from_theme(palette),
        parent,
        text_layout,
        dispatch,
    );
    let search_caret = files_toolbar.search_caret_bounds();
    context.draw_component(&files_toolbar);
    let files_style = ash_files::FilesPaneStyle::from_theme(palette);
    context.draw_component(&FilesPane::new(
        layout.content(),
        files,
        parent,
        &files_style,
        dispatch,
    ));
    dispatch
        .is_focused(FILE_SEARCH_INPUT)
        .then_some(search_caret)
        .flatten()
}

fn draw_changes_pane(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    scm: &ScmState,
    files_pane_expanded: bool,
    files: &FilesState,
    environment_context: &EnvironmentContextView<'_>,
    parent: ElementId,
    caret_visibility: CaretVisibility,
    palette: UiTheme,
    dispatch: &UiDispatch,
    text_layout: &mut TextInputLayoutEngine,
) -> Option<Rect> {
    let content_bounds = EditorPane::content_bounds_for(bounds);
    let (editor_bounds, files_bounds) = if files_pane_expanded {
        let editor_width = content_bounds.size.width * 0.5;
        (
            Rect::from_xywh(
                content_bounds.origin.x,
                content_bounds.origin.y,
                editor_width,
                content_bounds.size.height,
            ),
            Some(Rect::from_xywh(
                content_bounds.origin.x + editor_width,
                content_bounds.origin.y,
                content_bounds.size.width - editor_width,
                content_bounds.size.height,
            )),
        )
    } else {
        (content_bounds, None)
    };
    context.draw_component(
        &EditorPane::new(
            bounds,
            scm.editor(),
            ash_scm::ScmPaneStyle::from_theme(palette),
            parent,
        )
        .with_content_bounds(editor_bounds)
        .with_toolbar(scm.toolbar(), dispatch),
    );
    files_bounds.and_then(|bounds| {
        draw_files_pane(
            context,
            bounds,
            files,
            environment_context,
            ash_scm::CHANGES_PANE,
            caret_visibility,
            dispatch,
            text_layout,
            palette,
        )
    })
}

fn draw_file_editor_inspector(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    view: FileEditorPresentationView<'_>,
    text_layout: &mut TextInputLayoutEngine,
    palette: UiTheme,
) -> Option<Rect> {
    draw_main_surface(context.scene_mut(), bounds, palette);
    let pane = FileEditorPane::new(
        bounds,
        view.host,
        view.style.clone(),
        palette,
        if view.dispatch.is_focused(FILE_EDITOR_DOCUMENT) {
            view.caret_visibility
        } else {
            CaretVisibility::Hidden
        },
    )
    .with_parent(WINDOW)
    .with_prompt(view.prompt)
    .with_diagnostics(view.diagnostics)
    .with_language_features(view.language_hover, view.language_completions)
    .with_completion_selection(view.completion_selection)
    .with_pointer_position(view.pointer_position)
    .with_search(
        view.search,
        text_layout,
        view.dispatch,
        view.caret_visibility,
    );
    let ime_cursor_area = if view.dispatch.is_focused(FILE_EDITOR_DOCUMENT) {
        pane.caret_bounds()
    } else {
        view.dispatch
            .focused()
            .and_then(|focused| pane.search_caret_bounds(focused))
    };
    context.draw_component(&pane);
    ime_cursor_area
}

/// Paints a Desktop-owned Workbench surface before feature content.
fn draw_main_surface(scene: &mut UiScene, bounds: Rect, palette: UiTheme) {
    scene.draw_rect(PaintRect::new(bounds, palette.side_bar_background));
}

/// Paints the Desktop-owned outer border of the Inspector Part after feature content.
///
/// This boundary separates the right Inspector slot from the main pane.
/// Files and SCM components own only their internal geometry and
/// must not redraw this edge.
pub fn draw_inspector_border(scene: &mut UiScene, bounds: Rect, palette: UiTheme) {
    scene.draw_rect(
        PaintRect::new(bounds, Color::TRANSPARENT).with_border(Border::new(
            zui::ui::Edges::new(0.0, 0.0, 0.0, 1.0),
            palette.border,
        )),
    );
}

fn draw_tab_container(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    viewport: Rect,
    view: TabContainerView<'_>,
    text_layout: &mut TextInputLayoutEngine,
    palette: UiTheme,
    typography: &ash_ui_theme::UiTypography,
) -> TabContainerDrawResult {
    let groups = sidebar_session_groups(view.sidebar_part, |input| {
        input.is_settings()
            || view
                .search
                .matches_session_name(view.sidebar_part.tab_name(input))
    });
    let mut tab_container = SidebarView::new(
        bounds,
        view.search.input(),
        view.caret_visibility,
        view.sidebar_part.mode(),
        groups,
        view.selected_id,
        crate::WorkbenchUiStyle::from_theme(palette, typography),
        text_layout,
        view.dispatch,
    )
    .with_viewport(viewport)
    .with_scroll_state(view.scroll)
    .with_scrollbar_presentation(view.scrollbar_presentation);
    if let Some(tab) = view
        .visible_action_bar_tab
        .and_then(|tab| mounted_sidebar_item_id(view.sidebar_part, tab))
    {
        tab_container = tab_container.with_visible_action_bar(tab);
    }
    let scroll_metrics = tab_container.scroll_metrics();
    let scroll_view = tab_container.scroll_view();
    let search_caret = tab_container.search_caret_bounds();
    context.draw_component(&tab_container);
    TabContainerDrawResult {
        search_caret: view
            .dispatch
            .is_focused(SESSION_SEARCH_INPUT)
            .then_some(search_caret)
            .flatten(),
        scroll_metrics: Some(scroll_metrics),
        scroll_view: Some(scroll_view),
    }
}

fn draw_sash(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    orientation: SashOrientation,
    state: SashState,
    identity: ElementId,
    name: &'static str,
    label: &'static str,
    palette: UiTheme,
) {
    let sash = Sash::new(bounds, orientation, state, SashStyle::new(palette.accent));
    context.draw_component(
        &InteractionRegion::new(
            name,
            identity,
            sash.interaction_bounds(),
            AccessibilityRole::Separator,
            label,
        )
        .with_parent(WINDOW)
        .with_cursor(CursorFeedback::ResizeHorizontal)
        .with_value(format!("{} pixels", bounds.origin.x.round())),
    );
    context.draw_component(&sash);
}

fn draw_main(
    context: &mut ComponentContext<'_, '_>,
    layout: WorkbenchSceneLayout,
    view: MainPresentationView<'_>,
    palette: UiTheme,
    text_layout: &mut TextInputLayoutEngine,
) -> MainDrawResult {
    let active_screen = match view.main_surface {
        MainSurfaceKind::Terminal => ScreenBuffer::Alternate,
        MainSurfaceKind::Agent | MainSurfaceKind::Editor => ScreenBuffer::Primary,
    };
    let main_label = match view.main_surface {
        MainSurfaceKind::Agent => "Agent",
        MainSurfaceKind::Editor => "Agent session with file inspector",
        MainSurfaceKind::Terminal => "Interactive terminal",
    };
    let main_surface = InteractionRegion::new(
        "MainSurface",
        MAIN_SURFACE,
        layout.main(),
        AccessibilityRole::Group,
        main_label,
    )
    .with_parent(WINDOW)
    .with_cursor(CursorFeedback::Text);
    context.with_component(&main_surface, |context, _| {
        context
            .scene_mut()
            .draw_rect(PaintRect::new(layout.main(), palette.workbench_background));
        context.with_clip(layout.main(), |context| {
            let mut ime_cursor_area = None;
            let active_file_input = view.active_pane.filter(|pane| {
                !matches!(view.main_surface, MainSurfaceKind::Editor)
                    && matches!(pane.kind(), PaneInputKind::Files | PaneInputKind::Diff)
            });
            if let Some(pane) = active_file_input {
                let pane_group_id = pane_group_element_id(pane.pane_id());
                let pane_group = InteractionRegion::new(
                    "PaneGroup",
                    pane_group_id,
                    layout.main(),
                    AccessibilityRole::Group,
                    match pane.kind() {
                        PaneInputKind::Files => "Files pane group",
                        PaneInputKind::Diff => "Changes pane group",
                        _ => unreachable!("file input kind was checked above"),
                    },
                )
                .with_parent(MAIN_SURFACE);
                ime_cursor_area =
                    context.with_component(&pane_group, |context, _| match pane.kind() {
                        PaneInputKind::Files => draw_files_pane(
                            context,
                            layout.main(),
                            view.files,
                            &view.environment_context,
                            pane_group_id,
                            view.caret_visibility,
                            view.dispatch,
                            text_layout,
                            palette,
                        ),
                        PaneInputKind::Diff => draw_changes_pane(
                            context,
                            layout.main(),
                            view.scm,
                            view.files_pane_expanded,
                            view.files,
                            &view.environment_context,
                            pane_group_id,
                            view.caret_visibility,
                            palette,
                            view.dispatch,
                            text_layout,
                        ),
                        _ => unreachable!("file input kind was checked above"),
                    });
            } else {
                match view.main_surface {
                    MainSurfaceKind::Terminal => {
                        let terminal_bounds = terminal_content_bounds(layout, active_screen);
                        if view.terminal_panes.is_empty() {
                            let terminal_region = InteractionRegion::new(
                                "TerminalOutput",
                                TERMINAL_OUTPUT,
                                terminal_bounds,
                                AccessibilityRole::Terminal,
                                "Interactive terminal",
                            )
                            .with_parent(MAIN_SURFACE)
                            .with_cursor(CursorFeedback::Text);
                            context.with_component(&terminal_region, |context, _| {
                                draw_terminal(
                                    context.scene_mut(),
                                    layout,
                                    view.terminal,
                                    active_screen,
                                    palette,
                                );
                            });
                        } else if let Some(group) = view.pane_group {
                            let pane_geometry =
                                PaneGroupLayout::for_tree(terminal_bounds, group.tree());
                            for pane in view.terminal_panes {
                                if pane.kind != PaneInputKind::Terminal {
                                    continue;
                                }
                                let Some(pane_id) = pane.pane_id else {
                                    continue;
                                };
                                let Some(bounds) =
                                    pane_geometry.leaf(pane_id).map(|leaf| leaf.bounds())
                                else {
                                    continue;
                                };
                                let terminal_region = InteractionRegion::new(
                                    "TerminalPane",
                                    pane_group_element_id(pane_id),
                                    bounds,
                                    AccessibilityRole::Terminal,
                                    "Interactive terminal Pane",
                                )
                                .with_parent(MAIN_SURFACE)
                                .with_cursor(CursorFeedback::Text);
                                context.with_component(&terminal_region, |context, _| {
                                    draw_terminal_in_bounds(
                                        context.scene_mut(),
                                        bounds,
                                        *pane,
                                        active_screen,
                                        palette,
                                    );
                                });
                            }
                            context.draw_component(&PanePartSashes::new(
                                &pane_geometry,
                                MAIN_SURFACE,
                                palette.border,
                                palette.accent,
                                view.dispatch,
                                view.terminal_pane_resize_split,
                            ));
                        }
                    }
                    MainSurfaceKind::Agent | MainSurfaceKind::Editor => {
                        ime_cursor_area = draw_session_pane(
                            context,
                            layout.session_pane_layout,
                            SessionPaneView {
                                title: view.session_title,
                                state: view.session_pane,
                                context: view.session_pane_context,
                                caret_visibility: view.caret_visibility,
                                dispatch: view.dispatch,
                                parent: MAIN_SURFACE,
                            },
                            text_layout,
                            ash_session::SessionPaneStyle::from_theme(palette),
                        );
                    }
                }
            }
            let ime_cursor_area = match view.main_surface {
                MainSurfaceKind::Terminal if !view.terminal_panes.is_empty() => {
                    let active_pane = view.pane_group.map(PanePart::active_pane);
                    let terminal_bounds = terminal_content_bounds(layout, active_screen);
                    view.terminal_panes
                        .iter()
                        .find(|pane| pane.pane_id == active_pane)
                        .and_then(|pane| {
                            pane.core.and_then(|terminal| {
                                terminal_cursor_area_for_bounds(
                                    terminal_bounds_for_pane(
                                        view.pane_group,
                                        terminal_bounds,
                                        pane.pane_id,
                                    )?,
                                    terminal,
                                    pane.scroll_offset,
                                )
                            })
                        })
                }
                MainSurfaceKind::Terminal => view.terminal.core.and_then(|terminal| {
                    terminal_cursor_area(layout, terminal, view.terminal.scroll_offset)
                }),
                MainSurfaceKind::Agent | MainSurfaceKind::Editor => ime_cursor_area,
            };
            MainDrawResult { ime_cursor_area }
        })
    })
}

fn draw_settings_dialog(
    context: &mut ComponentContext<'_, '_>,
    viewport: Rect,
    model: &WorkbenchPresentationModel<'_>,
    text_layout: &mut TextInputLayoutEngine,
) -> ash_settings::SettingsPaneDrawResult {
    let palette = model.palette;
    let dialog = Dialog::new(
        viewport,
        Size::new(SETTINGS_DIALOG_WIDTH, SETTINGS_DIALOG_HEIGHT),
        "Settings",
        DialogIds::new(WINDOW, SETTINGS_DIALOG),
        DialogStyle::new(Color::rgba(0, 0, 0, 72), palette.content_background)
            .with_border(Border::uniform(1.0, palette.border))
            .with_corner_radii(CornerRadii::uniform(10.0))
            .with_shadow(
                BoxShadow::new(Color::rgba(0, 0, 0, 64))
                    .with_offset(zui::ui::Point::new(0.0, 8.0))
                    .with_blur_radius(24.0),
            )
            .with_viewport_margin(24.0),
    );
    let parent = dialog.root_id();
    let platform = model.keybindings.platform();
    let keybinding_rows = ash_settings::settings_keybinding_rows(platform, |command| {
        model.keybindings.binding_for_command(command)
    });
    let surface_label = match model.main_surface {
        MainSurfaceKind::Agent => "Agent",
        MainSurfaceKind::Editor => "Editor",
        MainSurfaceKind::Terminal => "Terminal",
    };
    let theme_scheme = match model.theme_scheme {
        ash_ui_theme::ColorScheme::Dark | ash_ui_theme::ColorScheme::HighContrastDark => "Dark",
        ash_ui_theme::ColorScheme::Light | ash_ui_theme::ColorScheme::HighContrastLight => "Light",
    };
    dialog.draw_components(context, |context, bounds| {
        ash_settings::draw_settings_pane(
            context,
            bounds,
            TITLEBAR_HEIGHT,
            parent,
            SettingsPaneView {
                state: model.settings,
                keyboard_shortcuts_visible: model.quick_access.shortcuts_open(),
                features: SettingsFeatureSnapshot {
                    general: GeneralSettingsSnapshot {
                        directory_label: model.environment_context.working_directory,
                        connection_label: model.environment_context.location,
                        surface_label,
                    },
                    appearance: AppearanceSettingsSnapshot {
                        scheme: theme_scheme,
                        follows_system: model.theme_follows_system,
                    },
                    keybindings: KeybindingSettingsSnapshot {
                        keybinding_rows: &keybinding_rows,
                        keybinding_diagnostics: model.keybinding_diagnostics,
                    },
                    remote: RemoteSettingsSnapshot {
                        connection_manager: model.remote_connection_manager,
                    },
                },
                caret_visibility: model.caret_visibility,
                dispatch: model.dispatch,
            },
            SettingsPaneStyle::new(
                ash_settings::SettingsPageStyle::from_theme(palette, &model.typography),
                ash_settings::SettingsSectionStyle::from_theme(palette, &model.typography),
                ash_settings::RemoteUiStyle::from_theme(palette),
            ),
            text_layout,
        )
    })
}

fn terminal_content_bounds(layout: WorkbenchSceneLayout, active_screen: ScreenBuffer) -> Rect {
    let viewport = if active_screen == ScreenBuffer::Alternate {
        layout.main()
    } else {
        layout.output
    };
    ash_terminal_runtime::content_bounds(viewport)
}

fn terminal_cursor_area(
    layout: WorkbenchSceneLayout,
    terminal: &TerminalCore,
    scroll_offset: usize,
) -> Option<Rect> {
    let bounds = terminal_content_bounds(layout, ScreenBuffer::Alternate);
    terminal_cursor_area_for_bounds(bounds, terminal, scroll_offset)
}

fn terminal_cursor_area_for_bounds(
    bounds: Rect,
    terminal: &TerminalCore,
    scroll_offset: usize,
) -> Option<Rect> {
    ash_terminal_runtime::cursor_area(bounds, terminal, scroll_offset)
}

fn terminal_bounds_for_pane(
    group: Option<&PanePart>,
    bounds: Rect,
    pane_id: Option<PaneId>,
) -> Option<Rect> {
    let pane_id = pane_id?;
    PaneGroupLayout::for_tree(bounds, group?.tree())
        .leaf(pane_id)
        .map(|leaf| leaf.bounds())
}

pub fn terminal_pane_sash_for_viewport(
    viewport: LogicalViewport,
    active_screen: ScreenBuffer,
    tab_container: TabContainerState,
    inspector_part: InspectorPartState,
    group: &PanePart,
    point: zui::ui::Point,
) -> Option<(PaneSplitId, SplitViewOrientation, SplitViewResizeSnapshot)> {
    let layout = WorkbenchSceneLayout::for_viewport(viewport, tab_container, inspector_part)?;
    let pane_geometry =
        PaneGroupLayout::for_tree(terminal_content_bounds(layout, active_screen), group.tree());
    pane_geometry.sashes().iter().find_map(|sash| {
        let orientation = match sash.orientation() {
            SplitViewOrientation::Horizontal => SashOrientation::Vertical,
            SplitViewOrientation::Vertical => SashOrientation::Horizontal,
        };
        let component = Sash::new(
            sash.track_bounds(),
            orientation,
            SashState::Resting,
            SashStyle::new(Color::TRANSPARENT),
        );
        component.interaction_bounds().contains(point).then_some((
            sash.split_id(),
            sash.orientation(),
            sash.resize_snapshot(),
        ))
    })
}

fn draw_terminal(
    scene: &mut UiScene,
    layout: WorkbenchSceneLayout,
    view: PaneView<'_>,
    active_screen: ScreenBuffer,
    palette: UiTheme,
) {
    let bounds = terminal_content_bounds(layout, active_screen);
    draw_terminal_in_bounds(scene, bounds, view, active_screen, palette);
}

fn draw_terminal_in_bounds(
    scene: &mut UiScene,
    bounds: Rect,
    view: PaneView<'_>,
    active_screen: ScreenBuffer,
    palette: UiTheme,
) {
    ash_terminal_runtime::draw_terminal(
        scene,
        bounds,
        ash_terminal_runtime::TerminalPaneView::new(view.core).with_view_state(
            view.scroll_offset,
            view.scrollbar_presentation,
            view.selection,
        ),
        active_screen,
        palette,
    );
}

fn draw_compact_scene(
    scene: &mut UiScene,
    viewport: LogicalViewport,
    app_name: &str,
    palette: UiTheme,
) {
    let bounds = Rect::from_xywh(
        12.0,
        12.0,
        (viewport.width - 24.0).max(1.0),
        (viewport.height - 24.0).max(1.0),
    );
    scene.draw_rect(
        PaintRect::new(bounds, palette.content_background)
            .with_border(Border::uniform(1.0, palette.border))
            .with_corner_radii(CornerRadii::uniform(10.0)),
    );
    draw_text(
        scene,
        app_name,
        Rect::from_xywh(
            bounds.origin.x + 18.0,
            bounds.origin.y + 18.0,
            (bounds.size.width - 36.0).max(1.0),
            30.0,
        ),
        TextStyle::new(20.0, palette.foreground).with_weight(FontWeight::Bold),
    );
}

fn draw_text(scene: &mut UiScene, text: &str, bounds: Rect, style: TextStyle) {
    if bounds.is_empty() {
        return;
    }
    scene.draw_text(TextBlock::new(text, bounds.origin, bounds.size, style));
}
