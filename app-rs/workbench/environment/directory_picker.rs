use std::path::{Path, PathBuf};

use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::Picker;
use ash_ui_components::PickerIds;
use ash_ui_components::PickerItem;
use ash_ui_components::PickerStyle;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use ash_ui_theme::UiTheme;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::environment_context::display_working_directory;

const WINDOW: ElementId = ElementId::scoped(1, 1);

#[path = "directory_picker_path.rs"]
mod path_support;
use path_support::{
    canonical_directory, directory_name, home_directory, read_child_directories,
    resolve_directory_query,
};

const DIRECTORY_PICKER_SCOPE: u32 = 2;
const DIRECTORY_PICKER: ElementId = ElementId::scoped(DIRECTORY_PICKER_SCOPE, 1);
pub const DIRECTORY_SEARCH_INPUT: ElementId = ElementId::scoped(DIRECTORY_PICKER_SCOPE, 2);
const FIRST_DIRECTORY_ITEM: u32 = 3;
const PICKER_VISIBLE_ITEM_COUNT: usize = 8;
const PICKER_CONTENT_WIDTH: f32 = 320.0;
pub const PICKER_ITEM_HEIGHT: f32 = 30.0;

#[derive(Clone, Debug, Eq, PartialEq)]
enum DirectoryPickerAction {
    Select(PathBuf),
    Browse(PathBuf),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DirectoryPickerItem {
    label: String,
    action: Option<DirectoryPickerAction>,
}

#[derive(Clone, Debug, PartialEq)]
struct OpenDirectoryPicker {
    anchor: Rect,
    directory: PathBuf,
    repository_root: Option<PathBuf>,
    directories: Vec<PathBuf>,
    restore_focus: Option<ElementId>,
}

/// Application-owned directory browsing state for the directory picker.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DirectoryPickerState {
    open: Option<OpenDirectoryPicker>,
    search_input: TextInput,
    scroll: ScrollState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectoryPickerActivation {
    BrowseChanged,
    SelectDirectory(PathBuf),
}

impl DirectoryPickerState {
    pub fn open(
        &mut self,
        anchor: Rect,
        directory: &Path,
        repository_root: Option<&Path>,
        restore_focus: Option<ElementId>,
    ) -> std::io::Result<()> {
        let directory = canonical_directory(directory)?;
        let repository_root = repository_root
            .and_then(|root| canonical_directory(root).ok())
            .filter(|root| directory.starts_with(root));
        let directories = read_child_directories(&directory)?;
        self.search_input.take_text();
        self.open = Some(OpenDirectoryPicker {
            anchor,
            directory,
            repository_root,
            directories,
            restore_focus,
        });
        self.scroll = ScrollState::default();
        Ok(())
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub const fn search_input(&self) -> &TextInput {
        &self.search_input
    }

    pub fn apply_search(&mut self, command: TextInputCommand) {
        self.search_input.apply(command);
        self.search_changed();
    }

    pub fn apply_search_composition(&mut self, event: TextInputCompositionEvent) {
        self.search_input.apply_composition(event);
        self.search_changed();
    }

    pub fn cancel_search_composition(&mut self) {
        self.search_input.cancel_composition();
    }

    pub fn selected_search_text(&self) -> Option<&str> {
        self.search_input.selected_text()
    }

    pub const fn scroll_state(&self) -> ScrollState {
        self.scroll
    }

    pub fn apply_scroll(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.scroll.apply(command, metrics, ScrollAxis::Vertical)
    }

    pub fn ensure_item_visible(&mut self, index: usize, metrics: ScrollMetrics) -> bool {
        self.apply_scroll(
            ScrollCommand::EnsureVisible(Rect::from_xywh(
                0.0,
                index as f32 * PICKER_ITEM_HEIGHT,
                metrics.content().width,
                PICKER_ITEM_HEIGHT,
            )),
            metrics,
        )
    }

    pub fn first_action_id(&self) -> Option<ElementId> {
        self.items()
            .iter()
            .enumerate()
            .find_map(|(index, item)| item.action.as_ref().map(|_| directory_item_id(index)))
    }

    pub fn is_picker_element(&self, id: ElementId) -> bool {
        id == DIRECTORY_PICKER
            || id == DIRECTORY_SEARCH_INPUT
            || self
                .items()
                .iter()
                .enumerate()
                .any(|(index, _)| directory_item_id(index) == id)
    }

    pub fn item_index(&self, id: ElementId) -> Option<usize> {
        self.items()
            .iter()
            .enumerate()
            .find_map(|(index, _)| (directory_item_id(index) == id).then_some(index))
    }

    pub fn activate(&mut self, index: usize) -> std::io::Result<Option<DirectoryPickerActivation>> {
        let Some(item) = self.items().get(index).cloned() else {
            return Ok(None);
        };
        let Some(action) = item.action else {
            return Ok(None);
        };
        match action {
            DirectoryPickerAction::Select(directory) => {
                Ok(Some(DirectoryPickerActivation::SelectDirectory(directory)))
            }
            DirectoryPickerAction::Browse(directory) => {
                self.browse(&directory)?;
                Ok(Some(DirectoryPickerActivation::BrowseChanged))
            }
        }
    }

    fn browse(&mut self, directory: &Path) -> std::io::Result<()> {
        let directory = canonical_directory(directory)?;
        let directories = read_child_directories(&directory)?;
        let Some(open) = self.open.as_mut() else {
            return Ok(());
        };
        open.directory = directory;
        open.directories = directories;
        self.search_input.take_text();
        self.scroll = ScrollState::default();
        Ok(())
    }

    fn items(&self) -> Vec<DirectoryPickerItem> {
        let Some(open) = self.open.as_ref() else {
            return Vec::new();
        };
        let raw_query = self.search_input.text().trim();
        if let Some(directory) = resolve_directory_query(&open.directory, raw_query) {
            return vec![DirectoryPickerItem {
                label: format!(
                    "Use path · {}",
                    display_working_directory(&directory, home_directory().as_deref())
                ),
                action: Some(DirectoryPickerAction::Select(directory)),
            }];
        }
        let query = raw_query.to_lowercase();
        let directories = open
            .directories
            .iter()
            .filter(|directory| {
                query.is_empty() || directory_name(directory).to_lowercase().contains(&query)
            })
            .collect::<Vec<_>>();
        if !query.is_empty() {
            if directories.is_empty() {
                return vec![DirectoryPickerItem {
                    label: "No matching folders".to_string(),
                    action: None,
                }];
            }
            return directories
                .into_iter()
                .map(directory_item)
                .collect::<Vec<_>>();
        }
        let home = home_directory();
        let mut items = vec![DirectoryPickerItem {
            label: format!(
                "Use this folder · {}",
                display_working_directory(&open.directory, home.as_deref())
            ),
            action: Some(DirectoryPickerAction::Select(open.directory.clone())),
        }];
        if let Some(repository_root) = open
            .repository_root
            .as_ref()
            .filter(|root| *root != &open.directory)
        {
            items.push(DirectoryPickerItem {
                label: format!(
                    "Git repository root · {}",
                    display_working_directory(repository_root, home.as_deref())
                ),
                action: Some(DirectoryPickerAction::Select(repository_root.clone())),
            });
        }
        if let Some(parent) = open.directory.parent() {
            items.push(DirectoryPickerItem {
                label: format!("↑ Parent · {}", directory_name(parent)),
                action: Some(DirectoryPickerAction::Browse(parent.to_path_buf())),
            });
        }
        items.extend(directories.into_iter().map(directory_item));
        items
    }

    fn search_changed(&mut self) {
        self.scroll = ScrollState::default();
    }
}

pub struct DirectoryPicker {
    picker: Picker,
}

impl DirectoryPicker {
    pub fn new(
        viewport: Rect,
        state: &DirectoryPickerState,
        caret_visibility: CaretVisibility,
        palette: UiTheme,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Option<Self> {
        let open = state.open.as_ref()?;
        let items = state.items();
        let selected_backgrounds = ButtonBackgrounds::new(palette.list_active_background)
            .with_hovered(palette.list_active_background)
            .with_focused(palette.list_active_background)
            .with_pressed(palette.border);
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(13.0, palette.foreground).with_line_height(18.0),
        )
        .with_selected_backgrounds(selected_backgrounds)
        .with_corner_radii(CornerRadii::uniform(2.0))
        .with_padding(Edges::new(0.0, 10.0, 0.0, 10.0));
        let picker_items = items
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let item = PickerItem::new(directory_item_id(index), entry.label.clone());
                if entry.action.is_some() {
                    item
                } else {
                    item.disabled()
                }
            })
            .collect();
        let picker = Picker::new(
            viewport,
            open.anchor,
            "Choose folder",
            "Search folders...",
            state.search_input(),
            caret_visibility,
            picker_items,
            state.scroll_state(),
            PickerIds::new(WINDOW, DIRECTORY_PICKER, DIRECTORY_SEARCH_INPUT),
            PickerStyle::new(
                palette.content_background,
                button_style,
                palette.search_box_style(),
                palette.picker_scroll_view_style(),
                Size::new(PICKER_CONTENT_WIDTH, PICKER_ITEM_HEIGHT),
                PICKER_VISIBLE_ITEM_COUNT,
            ),
            text_layout,
            dispatch,
        );
        Some(Self { picker })
    }

    #[cfg(test)]
    pub const fn bounds(&self) -> Rect {
        self.picker.bounds()
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.picker.search_caret_bounds()
    }

    pub const fn item_viewport_bounds(&self) -> Rect {
        self.picker.item_viewport_bounds()
    }

    pub fn scroll_metrics(&self) -> Option<ScrollMetrics> {
        self.picker.scroll_metrics()
    }

    #[cfg(test)]
    fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.picker.item_bounds(index)
    }
}

impl Component for DirectoryPicker {
    fn element(&self) -> ComponentElement {
        self.picker.element()
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        self.picker.interaction_node(element)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        self.picker.compose(context, element);
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.picker);
    }
}

pub fn directory_item_id(index: usize) -> ElementId {
    ElementId::scoped(
        DIRECTORY_PICKER_SCOPE,
        FIRST_DIRECTORY_ITEM.saturating_add(index as u32),
    )
}

fn directory_item(directory: &PathBuf) -> DirectoryPickerItem {
    DirectoryPickerItem {
        label: format!("› {}/", directory_name(directory)),
        action: Some(DirectoryPickerAction::Browse(directory.clone())),
    }
}

#[cfg(test)]
#[path = "directory_picker_tests.rs"]
mod tests;
