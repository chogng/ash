use ash_app_server_protocol::protocol::git::GitBranchDto as GitBranch;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::Picker;
use ash_ui_components::PickerIds;
use ash_ui_components::PickerItem;
use ash_ui_components::PickerStyle;
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

const WINDOW: ElementId = ElementId::scoped(1, 1);

const BRANCH_PICKER_SCOPE: u32 = 3;
const GIT_BRANCH_PICKER: ElementId = ElementId::scoped(BRANCH_PICKER_SCOPE, 1);
pub const GIT_BRANCH_SEARCH_INPUT: ElementId = ElementId::scoped(BRANCH_PICKER_SCOPE, 2);
const FIRST_GIT_BRANCH_ITEM: u32 = 3;
const BRANCH_PAGE_SIZE: usize = 10;
const PICKER_CONTENT_WIDTH: f32 = 260.0;
const PICKER_ITEM_HEIGHT: f32 = 30.0;

#[derive(Clone, Debug, Eq, PartialEq)]
enum GitBranchPickerAction {
    Select(GitBranch),
    PreviousPage,
    NextPage,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GitBranchPickerItem {
    label: String,
    action: Option<GitBranchPickerAction>,
    current: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct OpenGitBranchPicker {
    anchor: Rect,
    branches: Vec<GitBranch>,
    page: usize,
    error: Option<String>,
    restore_focus: Option<ElementId>,
}

/// Product-owned branch list and transient error state for the Git branch picker.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitBranchPickerState {
    open: Option<OpenGitBranchPicker>,
    search_input: TextInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitBranchPickerActivation {
    PageChanged,
    SelectBranch(GitBranch),
}

impl GitBranchPickerState {
    pub fn open(
        &mut self,
        anchor: Rect,
        mut branches: Vec<GitBranch>,
        restore_focus: Option<ElementId>,
    ) {
        self.search_input.take_text();
        branches.sort_by(|left, right| {
            right
                .is_current()
                .cmp(&left.is_current())
                .then_with(|| left.name().to_lowercase().cmp(&right.name().to_lowercase()))
                .then_with(|| left.name().cmp(right.name()))
        });
        self.open = Some(OpenGitBranchPicker {
            anchor,
            branches,
            page: 0,
            error: None,
            restore_focus,
        });
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub fn set_switch_error(&mut self) {
        if let Some(open) = self.open.as_mut() {
            open.error = Some("Switch failed · working tree unchanged".to_string());
        }
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

    pub fn first_action_id(&self) -> Option<ElementId> {
        self.items().iter().enumerate().find_map(|(index, item)| {
            item.action
                .as_ref()
                .map(|_| git_branch_picker_item_id(index))
        })
    }

    pub fn is_picker_element(&self, id: ElementId) -> bool {
        id == GIT_BRANCH_PICKER || self.item_index(id).is_some()
    }

    pub fn item_index(&self, id: ElementId) -> Option<usize> {
        self.items()
            .iter()
            .enumerate()
            .find_map(|(index, _)| (git_branch_picker_item_id(index) == id).then_some(index))
    }

    pub fn activate(&mut self, index: usize) -> Option<GitBranchPickerActivation> {
        let action = self.items().get(index)?.action.clone()?;
        match action {
            GitBranchPickerAction::Select(branch) => {
                Some(GitBranchPickerActivation::SelectBranch(branch))
            }
            GitBranchPickerAction::PreviousPage => {
                if let Some(open) = self.open.as_mut() {
                    open.page = open.page.saturating_sub(1);
                    open.error = None;
                }
                Some(GitBranchPickerActivation::PageChanged)
            }
            GitBranchPickerAction::NextPage => {
                if let Some(open) = self.open.as_mut() {
                    let query = self.search_input.text().trim().to_lowercase();
                    let branch_count = open
                        .branches
                        .iter()
                        .filter(|branch| {
                            query.is_empty() || branch.name().to_lowercase().contains(&query)
                        })
                        .count();
                    let maximum_page = branch_count.saturating_sub(1) / BRANCH_PAGE_SIZE;
                    open.page = (open.page + 1).min(maximum_page);
                    open.error = None;
                }
                Some(GitBranchPickerActivation::PageChanged)
            }
        }
    }

    fn items(&self) -> Vec<GitBranchPickerItem> {
        let Some(open) = self.open.as_ref() else {
            return Vec::new();
        };
        let mut items = Vec::new();
        if let Some(error) = open.error.as_ref() {
            items.push(GitBranchPickerItem {
                label: error.clone(),
                action: None,
                current: false,
            });
        }
        let query = self.search_input.text().trim().to_lowercase();
        let branches = open
            .branches
            .iter()
            .filter(|branch| query.is_empty() || branch.name().to_lowercase().contains(&query))
            .collect::<Vec<_>>();
        if branches.is_empty() {
            items.push(GitBranchPickerItem {
                label: if open.branches.is_empty() {
                    "No local branches".to_string()
                } else {
                    "No matching branches".to_string()
                },
                action: None,
                current: false,
            });
            return items;
        }
        if open.page > 0 {
            items.push(GitBranchPickerItem {
                label: "← Previous branches".to_string(),
                action: Some(GitBranchPickerAction::PreviousPage),
                current: false,
            });
        }
        let start = open.page.saturating_mul(BRANCH_PAGE_SIZE);
        let end = (start + BRANCH_PAGE_SIZE).min(branches.len());
        items.extend(
            branches[start..end]
                .iter()
                .map(|branch| GitBranchPickerItem {
                    label: if branch.is_current() {
                        format!("✓ {}", branch.name())
                    } else {
                        branch.name().to_string()
                    },
                    action: Some(GitBranchPickerAction::Select((*branch).clone())),
                    current: branch.is_current(),
                }),
        );
        if end < branches.len() {
            items.push(GitBranchPickerItem {
                label: "More branches →".to_string(),
                action: Some(GitBranchPickerAction::NextPage),
                current: false,
            });
        }
        items
    }

    fn search_changed(&mut self) {
        if let Some(open) = self.open.as_mut() {
            open.page = 0;
            open.error = None;
        }
    }
}

pub struct GitBranchPicker {
    picker: Picker,
}

impl GitBranchPicker {
    pub fn new(
        viewport: Rect,
        state: &GitBranchPickerState,
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
            .map(|(index, item)| {
                let picker_item =
                    PickerItem::new(git_branch_picker_item_id(index), item.label.clone());
                let picker_item = if item.action.is_some() {
                    picker_item
                } else {
                    picker_item.disabled()
                };
                if item.current {
                    picker_item.selected()
                } else {
                    picker_item
                }
            })
            .collect();
        let picker = Picker::new(
            viewport,
            open.anchor,
            "Switch Git branch",
            "Search branches...",
            state.search_input(),
            caret_visibility,
            picker_items,
            ScrollState::default(),
            PickerIds::new(WINDOW, GIT_BRANCH_PICKER, GIT_BRANCH_SEARCH_INPUT),
            PickerStyle::new(
                palette.content_background,
                button_style,
                palette.search_box_style(),
                palette.picker_scroll_view_style(),
                Size::new(PICKER_CONTENT_WIDTH, PICKER_ITEM_HEIGHT),
                BRANCH_PAGE_SIZE + 3,
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
}

impl Component for GitBranchPicker {
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
        self.picker.paint(scene);
    }
}

fn git_branch_picker_item_id(index: usize) -> ElementId {
    ElementId::scoped(
        BRANCH_PICKER_SCOPE,
        FIRST_GIT_BRANCH_ITEM.saturating_add(index as u32),
    )
}

#[cfg(test)]
#[path = "branch_picker_tests.rs"]
mod tests;
