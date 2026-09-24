//! Files Pane state, layout, interaction, and UI.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;

use ash_file_search::PathSearchHandle;
use ash_file_search::PathSearchOptions;
use ash_file_search::PathSearchSnapshot;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollDelta;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use ash_ui_components::SearchBoxStyle;
use ash_ui_components::TreeItem;
use ash_ui_components::VirtualListLayout;
use ash_ui_theme::UiTheme;
use zui::ui::Color;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::ElementId;
use zui::ui::Size;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;
use zui::ui::TextStyle;

mod file_icon;
mod file_tree;
mod layout;
mod pane;
mod toolbar;
mod tree_view;

pub use file_tree::FilesEntry;
use file_tree::FilesTree;
pub use file_tree::FilesTreeRow;
pub use layout::FilesLayout;
pub use pane::FilesPane;
pub use pane::FilesPaneStyle;
pub use toolbar::FilesToolbar;

pub const FILE_LIST_ROW_HEIGHT: f32 = 24.0;
pub const FILES_PANE: ElementId = ElementId::scoped(1, 28);
pub const FILES_ACTION_BAR: ElementId = ElementId::scoped(1, 36);
pub const FILES_REFRESH: ElementId = ElementId::scoped(1, 37);
pub const FILES_SEARCH: ElementId = ElementId::scoped(1, 38);
pub const FILE_SEARCH_INPUT: ElementId = ElementId::scoped(1, 39);
pub const FILES_TOOLBAR: ElementId = ElementId::scoped(1, 52);

/// A Files-pane interaction that requires host work or focus routing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FilesAction {
    Handled,
    StateChanged,
    Focus(ElementId),
    OpenFile { path: PathBuf },
    LoadChildren { element: ElementId, path: PathBuf },
}

/// Theme values required by the Files toolbar.
#[derive(Clone)]
pub struct FilesToolbarStyle {
    surface: Color,
    border: Color,
    text: Color,
    surface_hovered: Color,
    selected_background: Color,
    search: SearchBoxStyle,
}

impl FilesToolbarStyle {
    pub fn from_theme(theme: UiTheme) -> Self {
        Self::new(
            theme.side_bar_background,
            theme.border,
            theme.foreground,
            theme.list_hover_background,
            theme.list_active_background,
            theme.search_box_style(),
        )
    }

    pub fn new(
        surface: Color,
        border: Color,
        text: Color,
        surface_hovered: Color,
        selected_background: Color,
        search: SearchBoxStyle,
    ) -> Self {
        Self {
            surface,
            border,
            text,
            surface_hovered,
            selected_background,
            search,
        }
    }

    pub fn search_style(&self) -> SearchBoxStyle {
        self.search.clone()
    }

    pub const fn surface(&self) -> Color {
        self.surface
    }

    pub const fn border(&self) -> Color {
        self.border
    }

    pub fn button_style(&self) -> ButtonStyle {
        let backgrounds = ButtonBackgrounds::new(Color::TRANSPARENT)
            .with_hovered(self.surface_hovered)
            .with_focused(self.surface_hovered)
            .with_pressed(self.selected_background);
        let selected = ButtonBackgrounds::new(self.selected_background)
            .with_hovered(self.selected_background)
            .with_focused(self.selected_background)
            .with_pressed(self.selected_background);
        ButtonStyle::new(backgrounds, TextStyle::new(11.0, self.text))
            .with_selected_backgrounds(selected)
            .with_corner_radii(CornerRadii::uniform(4.0))
            .with_padding(Edges::uniform(4.0))
            .with_icon_size(16.0)
    }
}

/// A filesystem entry projected by the host into the Files pane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryEntry {
    name: String,
    kind: DirectoryEntryKind,
}

impl DirectoryEntry {
    pub fn file(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: DirectoryEntryKind::File,
        }
    }

    pub fn directory(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: DirectoryEntryKind::Directory,
        }
    }
}

/// The tree-relevant classification of a directory entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirectoryEntryKind {
    File,
    Directory,
}

/// Retained Files-pane state. The host supplies snapshots and executes actions.
pub struct FilesState {
    root: Option<PathBuf>,
    tree: FilesTree,
    search_input: TextInput,
    search_visible: bool,
    search_handle: Option<PathSearchHandle>,
    search_receiver: Option<Receiver<PathSearchSnapshot>>,
    search_revision: u64,
    search_matches: Vec<PathBuf>,
    search_pending: bool,
    scroll_state: ScrollState,
}

impl Default for FilesState {
    fn default() -> Self {
        Self {
            root: None,
            tree: FilesTree::default(),
            search_input: TextInput::new(),
            search_visible: false,
            search_handle: None,
            search_receiver: None,
            search_revision: 0,
            search_matches: Vec::new(),
            search_pending: false,
            scroll_state: ScrollState::default(),
        }
    }
}

impl FilesState {
    pub fn set_dir_root(&mut self, root: PathBuf) {
        self.root = Some(root);
        self.tree.clear();
        self.scroll_state = ScrollState::default();
    }
    pub fn refresh(&mut self, entries: Vec<DirectoryEntry>) {
        self.scroll_state = ScrollState::default();
        self.tree.replace_root(entries);
        let Some(root) = self.root.clone() else {
            return;
        };
        match ash_file_search::Service.start(root, PathSearchOptions::default()) {
            Ok((handle, receiver)) => {
                self.search_revision = handle.update_query(self.search_input.text());
                self.search_handle = Some(handle);
                self.search_receiver = Some(receiver);
                self.search_matches.clear();
                self.search_pending = true;
            }
            Err(_) => {
                self.search_handle = None;
                self.search_receiver = None;
                self.search_matches.clear();
                self.search_pending = false;
            }
        }
    }
    pub fn complete_directory_load(
        &mut self,
        element: ElementId,
        entries: Vec<DirectoryEntry>,
    ) -> bool {
        self.tree.complete_directory_load(element, entries)
    }
    pub const fn search_visible(&self) -> bool {
        self.search_visible
    }
    pub const fn search_input(&self) -> &TextInput {
        &self.search_input
    }
    pub fn search_matches(&self) -> &[PathBuf] {
        &self.search_matches
    }
    pub const fn scroll_state(&self) -> ScrollState {
        self.scroll_state
    }
    pub fn item_count(&self) -> usize {
        if self.search_visible && !self.search_input.text().trim().is_empty() {
            self.search_matches.len()
        } else {
            self.tree.visible_len()
        }
    }
    pub fn tree_items(&self) -> &[TreeItem] {
        self.tree.visible_items()
    }
    pub fn tree_row(&self, index: usize) -> Option<FilesTreeRow<'_>> {
        self.tree.row(index)
    }
    pub fn selected_element(&self) -> Option<ElementId> {
        self.tree.selected_element()
    }
    pub fn activate(&mut self, element: ElementId) -> Option<FilesAction> {
        self.tree.activate(element)
    }
    pub fn navigate_right(&mut self, element: ElementId) -> Option<FilesAction> {
        self.tree.navigate_right(element)
    }
    pub fn navigate_left(&mut self, element: ElementId) -> Option<FilesAction> {
        self.tree.navigate_left(element)
    }
    pub fn set_search_visible(&mut self, visible: bool) {
        self.search_visible = visible;
        self.scroll_state = ScrollState::default();
        if !visible {
            self.search_input.take_text();
            self.update_search();
        }
    }
    pub fn apply_search(&mut self, command: TextInputCommand) {
        self.search_input.apply(command);
        self.scroll_state = ScrollState::default();
        self.update_search();
    }
    pub fn apply_search_composition(&mut self, event: TextInputCompositionEvent) {
        self.search_input.apply_composition(event);
        self.scroll_state = ScrollState::default();
        self.update_search();
    }
    pub fn cancel_search_composition(&mut self) {
        self.search_input.cancel_composition();
    }
    pub fn clear_search(&mut self) {
        self.search_input.take_text();
        self.scroll_state = ScrollState::default();
        self.update_search();
    }
    pub fn selected_search_text(&self) -> Option<&str> {
        self.search_input.selected_text()
    }
    pub fn poll_search(&mut self) -> bool {
        let Some(receiver) = self.search_receiver.as_ref() else {
            return false;
        };
        let mut latest = None;
        loop {
            match receiver.try_recv() {
                Ok(snapshot) => latest = Some(snapshot),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.search_pending = false;
                    break;
                }
            }
        }
        let Some(snapshot) = latest else {
            return false;
        };
        if snapshot.query_revision != self.search_revision
            || snapshot.query != self.search_input.text()
        {
            return false;
        }
        let matches = snapshot
            .matches
            .into_iter()
            .map(|matched| matched.path)
            .collect::<Vec<_>>();
        let changed = matches != self.search_matches;
        self.search_matches = matches;
        self.search_pending = !snapshot.search_complete;
        changed
    }
    pub const fn search_pending(&self) -> bool {
        self.search_pending
    }
    pub fn scroll(&mut self, delta: f32, viewport: Size) -> bool {
        let content = VirtualListLayout::new(self.item_count(), FILE_LIST_ROW_HEIGHT)
            .content_size(viewport.width);
        self.scroll_state.apply(
            ScrollCommand::ByPixels(ScrollDelta::vertical(delta)),
            ScrollMetrics::new(viewport, content),
            ScrollAxis::Vertical,
        )
    }
    fn update_search(&mut self) {
        if let Some(handle) = self.search_handle.as_ref() {
            self.search_revision = handle.update_query(self.search_input.text());
            self.search_pending = true;
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod state_tests;
