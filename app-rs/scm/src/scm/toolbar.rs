use ash_editor::CodeEditor;
use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorDocument;
use ash_editor::CodeEditorHeader;
use ash_editor::CodeEditorPresentation;
use ash_editor::CodeEditorStyle;
use ash_editor::CodeEditorViewport;
use ash_icons::icons;
use ash_ui_components::ActionBar;
use ash_ui_components::ActionBarItem;
use ash_ui_components::ActionBarOrientation;
use ash_ui_components::ActionBarStyle;
use ash_ui_components::ActionViewItem;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonSelection;
use ash_ui_components::ButtonState;
use ash_ui_components::ButtonStyle;
use ash_ui_components::Dropdown;
use ash_ui_components::DropdownStyle;
use ash_ui_components::InteractionRegion;
use ash_ui_components::MenuIds;
use ash_ui_components::MenuItem;
use ash_ui_components::MenuSelection;
use ash_ui_components::MenuStyle;
use zui::ui::AccessibilityRole;
use zui::ui::Border;
use zui::ui::CaretVisibility;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::CursorFeedback;
use zui::ui::Edges;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::PaintRect;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInputCompositionEvent;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::CHANGES_TOOLBAR;
use crate::COMMIT_MESSAGE_EDITOR;
use crate::ScmPaneStyle;

const TOOLBAR_SCOPE: u32 = 29;
const SCOPE_MAIN: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 2);
const SCOPE_MORE: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 3);
const PRIMARY_MAIN: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 4);
const PRIMARY_MORE: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 5);
const OPEN_FILES: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 6);
const OPEN_MORE: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 7);
const SCOPE_MENU: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 64);
const PRIMARY_MENU: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 65);
const MORE_MENU: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 66);
const INCLUDE_UNSTAGED: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 61);
const SUBMIT_COMMIT: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 62);
const SUBMIT_COMMIT_AND_PUSH: ElementId = ElementId::scoped(TOOLBAR_SCOPE, 63);
const SCOPE_ITEM_START: u32 = 10;
const PRIMARY_ITEM_START: u32 = 20;
const MORE_ITEM_START: u32 = 40;
const TOOLBAR_HEIGHT: f32 = 40.0;
const BUTTON_HEIGHT: f32 = 28.0;
const ICON_BUTTON_WIDTH: f32 = 28.0;
const TOOLBAR_PADDING: f32 = 8.0;
const MENU_ITEM_HEIGHT: f32 = 28.0;
const SCOPE_WIDTH: f32 = 184.0;
const PRIMARY_WIDTH: f32 = 176.0;
const COMPOSER_WIDTH: f32 = 420.0;
const COMPOSER_HEIGHT: f32 = 224.0;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ChangesScope {
    #[default]
    CurrentTurn,
    BeforeCurrentTurn,
    PreviousTurn,
    Staged,
    Unstaged,
    Uncommitted,
}

impl ChangesScope {
    pub const ALL: [Self; 6] = [
        Self::CurrentTurn,
        Self::BeforeCurrentTurn,
        Self::PreviousTurn,
        Self::Staged,
        Self::Unstaged,
        Self::Uncommitted,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::CurrentTurn => "Current turn",
            Self::BeforeCurrentTurn => "All before current turn",
            Self::PreviousTurn => "Previous turn",
            Self::Staged => "Staged",
            Self::Unstaged => "Unstaged",
            Self::Uncommitted => "Uncommitted",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BranchActions {
    Primary,
    Topic,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PullRequestMode {
    Default,
    AutoMerge,
    AutoSquash,
    AutoRebase,
    Draft,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangesActivation {
    Ignored,
    Changed,
    Focus(ElementId),
    OpenFile(String),
    OpenFiles,
    Stage(Vec<String>),
    Unstage(Vec<String>),
    Discard(Vec<String>),
    GenerateAndCommit,
    Commit {
        message: String,
        include_unstaged: bool,
        push: bool,
    },
    Push,
    CreatePullRequest(PullRequestMode),
    ScopeChanged(ChangesScope),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChangesToolbarAction {
    ScopeMain,
    ScopeMore,
    SelectScope(ChangesScope),
    PrimaryMain,
    PrimaryMore,
    PrimaryMenu(usize),
    OpenFiles,
    OpenMore,
    CollapseAll,
    ExpandAll,
    StageAll,
    DiscardAll,
    ToggleIncludeUnstaged,
    SubmitCommit,
    SubmitCommitAndPush,
}

impl ChangesToolbarAction {
    pub fn from_element_id(id: ElementId) -> Option<Self> {
        if id == SCOPE_MAIN {
            return Some(Self::ScopeMain);
        }
        if id == SCOPE_MORE {
            return Some(Self::ScopeMore);
        }
        if id == PRIMARY_MAIN {
            return Some(Self::PrimaryMain);
        }
        if id == PRIMARY_MORE {
            return Some(Self::PrimaryMore);
        }
        if id == OPEN_FILES {
            return Some(Self::OpenFiles);
        }
        if id == OPEN_MORE {
            return Some(Self::OpenMore);
        }
        if id == INCLUDE_UNSTAGED {
            return Some(Self::ToggleIncludeUnstaged);
        }
        if id == SUBMIT_COMMIT {
            return Some(Self::SubmitCommit);
        }
        if id == SUBMIT_COMMIT_AND_PUSH {
            return Some(Self::SubmitCommitAndPush);
        }
        for (index, scope) in ChangesScope::ALL.into_iter().enumerate() {
            if id == scope_item_id(index) {
                return Some(Self::SelectScope(scope));
            }
        }
        if let Some(index) = (0..4).find(|index| id == primary_item_id(*index)) {
            return Some(Self::PrimaryMenu(index));
        }
        [
            Self::CollapseAll,
            Self::ExpandAll,
            Self::StageAll,
            Self::DiscardAll,
        ]
        .into_iter()
        .enumerate()
        .find_map(|(index, action)| (id == more_item_id(index)).then_some(action))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenMenu {
    Scope,
    Primary,
    More,
    Commit,
}

pub struct ChangesToolbarState {
    scope: ChangesScope,
    branch_actions: BranchActions,
    open: Option<OpenMenu>,
    commit_message: CodeEditorDocument,
    include_unstaged: bool,
}

impl Default for ChangesToolbarState {
    fn default() -> Self {
        Self {
            scope: ChangesScope::default(),
            branch_actions: BranchActions::Unavailable,
            open: None,
            commit_message: CodeEditorDocument::default(),
            include_unstaged: false,
        }
    }
}

impl ChangesToolbarState {
    pub const fn scope(&self) -> ChangesScope {
        self.scope
    }

    pub fn set_branch(&mut self, branch: Option<&str>) {
        self.branch_actions = match branch {
            Some("main" | "master") => BranchActions::Primary,
            Some(_) => BranchActions::Topic,
            None => BranchActions::Unavailable,
        };
    }

    pub fn apply_commit_message(&mut self, command: CodeEditorCommand) {
        self.commit_message.apply(command);
    }

    pub fn apply_commit_composition(&mut self, event: TextInputCompositionEvent) {
        self.commit_message.apply_composition(event);
    }

    pub fn cancel_commit_composition(&mut self) {
        self.commit_message.cancel_composition();
    }

    pub fn dismiss_menus(&mut self) {
        self.open = None;
    }

    pub fn activate(&mut self, action: Option<ChangesToolbarAction>) -> ChangesActivation {
        let Some(action) = action else {
            return ChangesActivation::Ignored;
        };
        match action {
            ChangesToolbarAction::ScopeMain | ChangesToolbarAction::ScopeMore => {
                self.open = toggle_menu(self.open, OpenMenu::Scope);
                ChangesActivation::Changed
            }
            ChangesToolbarAction::SelectScope(scope) => {
                self.scope = scope;
                self.open = None;
                ChangesActivation::ScopeChanged(scope)
            }
            ChangesToolbarAction::PrimaryMain => match self.branch_actions {
                BranchActions::Primary => ChangesActivation::GenerateAndCommit,
                BranchActions::Topic => {
                    ChangesActivation::CreatePullRequest(PullRequestMode::Default)
                }
                BranchActions::Unavailable => ChangesActivation::Ignored,
            },
            ChangesToolbarAction::PrimaryMore => {
                self.open = toggle_menu(self.open, OpenMenu::Primary);
                ChangesActivation::Changed
            }
            ChangesToolbarAction::PrimaryMenu(index) => {
                self.open = None;
                match (self.branch_actions, index) {
                    (BranchActions::Primary, 0 | 1) => {
                        self.open = Some(OpenMenu::Commit);
                        ChangesActivation::Focus(COMMIT_MESSAGE_EDITOR)
                    }
                    (BranchActions::Primary, 2) => ChangesActivation::Push,
                    (BranchActions::Topic, 0) => {
                        ChangesActivation::CreatePullRequest(PullRequestMode::AutoMerge)
                    }
                    (BranchActions::Topic, 1) => {
                        ChangesActivation::CreatePullRequest(PullRequestMode::AutoSquash)
                    }
                    (BranchActions::Topic, 2) => {
                        ChangesActivation::CreatePullRequest(PullRequestMode::AutoRebase)
                    }
                    (BranchActions::Topic, 3) => {
                        ChangesActivation::CreatePullRequest(PullRequestMode::Draft)
                    }
                    _ => ChangesActivation::Ignored,
                }
            }
            ChangesToolbarAction::OpenFiles => ChangesActivation::OpenFiles,
            ChangesToolbarAction::OpenMore => {
                self.open = toggle_menu(self.open, OpenMenu::More);
                ChangesActivation::Changed
            }
            ChangesToolbarAction::CollapseAll
            | ChangesToolbarAction::ExpandAll
            | ChangesToolbarAction::StageAll
            | ChangesToolbarAction::DiscardAll => {
                self.open = None;
                ChangesActivation::Changed
            }
            ChangesToolbarAction::ToggleIncludeUnstaged => {
                self.include_unstaged = !self.include_unstaged;
                ChangesActivation::Changed
            }
            ChangesToolbarAction::SubmitCommit => self.commit(false),
            ChangesToolbarAction::SubmitCommitAndPush => self.commit(true),
        }
    }

    fn commit(&mut self, push: bool) -> ChangesActivation {
        let message = self.commit_message.text().trim().to_owned();
        if message.is_empty() {
            return ChangesActivation::Focus(COMMIT_MESSAGE_EDITOR);
        }
        self.open = None;
        ChangesActivation::Commit {
            message,
            include_unstaged: self.include_unstaged,
            push,
        }
    }
}

fn toggle_menu(current: Option<OpenMenu>, target: OpenMenu) -> Option<OpenMenu> {
    (current != Some(target)).then_some(target)
}

pub struct ChangesToolbar<'a> {
    bounds: Rect,
    viewport: Rect,
    state: &'a ChangesToolbarState,
    style: ScmPaneStyle,
    parent: ElementId,
    dispatch: &'a UiDispatch,
}

impl<'a> ChangesToolbar<'a> {
    pub const fn new(
        bounds: Rect,
        viewport: Rect,
        state: &'a ChangesToolbarState,
        style: ScmPaneStyle,
        parent: ElementId,
        dispatch: &'a UiDispatch,
    ) -> Self {
        Self {
            bounds,
            viewport,
            state,
            style,
            parent,
            dispatch,
        }
    }

    pub const fn height() -> f32 {
        TOOLBAR_HEIGHT
    }

    fn button_style(&self) -> ButtonStyle {
        ButtonStyle::new(
            ButtonBackgrounds::new(self.style.surface)
                .with_hovered(self.style.hover)
                .with_focused(self.style.active)
                .with_pressed(self.style.active),
            TextStyle::new(12.0, self.style.text),
        )
        .with_selected_backgrounds(ButtonBackgrounds::new(self.style.active))
        .with_border(Border::new(Edges::uniform(1.0), self.style.border))
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_padding(Edges::new(5.0, 8.0, 5.0, 8.0))
        .with_icon_size(14.0)
    }

    fn button_state(&self, id: ElementId, enabled: bool) -> ButtonState {
        if !enabled {
            ButtonState::Disabled
        } else if self.dispatch.is_pressed(id) {
            ButtonState::Pressed
        } else if self.dispatch.is_focused(id) {
            ButtonState::Focused
        } else if self.dispatch.is_hovered(id) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        }
    }

    fn bars(&self) -> (ActionBar, ActionBar) {
        let y = self.bounds.origin.y + (self.bounds.size.height - BUTTON_HEIGHT) * 0.5;
        let left_bounds = Rect::from_xywh(
            self.bounds.origin.x + TOOLBAR_PADDING,
            y,
            SCOPE_WIDTH,
            BUTTON_HEIGHT,
        );
        let right_width = PRIMARY_WIDTH + ICON_BUTTON_WIDTH * 3.0 + 8.0;
        let right_bounds = Rect::from_xywh(
            (self.bounds.right() - TOOLBAR_PADDING - right_width).max(self.bounds.origin.x),
            y,
            right_width.min(self.bounds.size.width),
            BUTTON_HEIGHT,
        );
        let style = self.button_style();
        let left = ActionBar::new(
            left_bounds,
            ActionBarOrientation::Horizontal,
            vec![
                ActionBarItem::Action(
                    ActionViewItem::label(
                        self.state.scope.label(),
                        self.button_state(SCOPE_MAIN, true),
                    )
                    .with_main_axis_extent(SCOPE_WIDTH - ICON_BUTTON_WIDTH),
                ),
                ActionBarItem::Action(ActionViewItem::icon(
                    icons::CHEVRON_DOWN,
                    "Choose changes scope",
                    self.button_state(SCOPE_MORE, true),
                )),
            ],
            ActionBarStyle::new(style.clone(), Size::new(ICON_BUTTON_WIDTH, BUTTON_HEIGHT)),
        );
        let primary_enabled = self.state.branch_actions != BranchActions::Unavailable;
        let primary_label = match self.state.branch_actions {
            BranchActions::Primary => "Commit",
            BranchActions::Topic => "Create Pull Request",
            BranchActions::Unavailable => "No repository",
        };
        let right = ActionBar::new(
            right_bounds,
            ActionBarOrientation::Horizontal,
            vec![
                ActionBarItem::Action(
                    ActionViewItem::label(
                        primary_label,
                        self.button_state(PRIMARY_MAIN, primary_enabled),
                    )
                    .with_main_axis_extent(PRIMARY_WIDTH - ICON_BUTTON_WIDTH),
                ),
                ActionBarItem::Action(ActionViewItem::icon(
                    icons::CHEVRON_DOWN,
                    "More repository actions",
                    self.button_state(PRIMARY_MORE, primary_enabled),
                )),
                ActionBarItem::Action(ActionViewItem::icon(
                    icons::FILES,
                    "Open Files",
                    self.button_state(OPEN_FILES, true),
                )),
                ActionBarItem::Action(ActionViewItem::icon(
                    icons::ELLIPSIS,
                    "More changes actions",
                    self.button_state(OPEN_MORE, true),
                )),
            ],
            ActionBarStyle::new(style, Size::new(ICON_BUTTON_WIDTH, BUTTON_HEIGHT)).with_gap(2.0),
        );
        (left, right)
    }

    fn menu_style(&self, width: f32) -> DropdownStyle {
        DropdownStyle::new(MenuStyle::new(
            self.style.menu,
            self.button_style(),
            Size::new(width, MENU_ITEM_HEIGHT),
        ))
    }

    fn draw_menu(
        &self,
        context: &mut ComponentContext<'_, '_>,
        anchor: Rect,
        root: ElementId,
        accessibility_label: &str,
        labels: &[&str],
        ids: impl Fn(usize) -> ElementId,
        width: f32,
    ) {
        let menu = Dropdown::new(
            self.viewport,
            anchor,
            accessibility_label,
            labels
                .iter()
                .enumerate()
                .map(|(index, label)| {
                    let id = ids(index);
                    MenuItem::action(
                        id,
                        ActionViewItem::label(*label, self.button_state(id, true)),
                    )
                })
                .collect(),
            MenuIds::new(CHANGES_TOOLBAR, root),
            self.menu_style(width),
        )
        .with_selection(MenuSelection::None);
        context.draw_component(&menu);
    }

    fn draw_commit_composer(&self, context: &mut ComponentContext<'_, '_>, anchor: Rect) {
        let x = (anchor.right() - COMPOSER_WIDTH)
            .max(self.viewport.origin.x + TOOLBAR_PADDING)
            .min(self.viewport.right() - COMPOSER_WIDTH - TOOLBAR_PADDING);
        let y = anchor.bottom() + 4.0;
        let bounds = Rect::from_xywh(x, y, COMPOSER_WIDTH, COMPOSER_HEIGHT);
        context.scene_mut().draw_rect(
            PaintRect::new(bounds, self.style.menu)
                .with_border(Border::new(Edges::uniform(1.0), self.style.border))
                .with_corner_radii(CornerRadii::uniform(6.0)),
        );
        let editor_bounds = Rect::from_xywh(
            bounds.origin.x + 12.0,
            bounds.origin.y + 12.0,
            bounds.size.width - 24.0,
            116.0,
        );
        context.draw_component(
            &InteractionRegion::new(
                "CommitMessageEditorInput",
                COMMIT_MESSAGE_EDITOR,
                editor_bounds,
                AccessibilityRole::TextInput,
                "Commit message",
            )
            .with_cursor(CursorFeedback::Text)
            .with_focus(FocusBehavior::TabStop)
            .with_value(self.state.commit_message.text()),
        );
        context.draw_component(
            &CodeEditor::new(
                editor_bounds,
                &self.state.commit_message,
                CodeEditorViewport::default(),
                CodeEditorHeader::Hidden,
                CodeEditorStyle::light(),
            )
            .with_presentation(CodeEditorPresentation::Compact)
            .with_caret_visibility(
                if self.dispatch.is_focused(COMMIT_MESSAGE_EDITOR) {
                    CaretVisibility::Visible
                } else {
                    CaretVisibility::Hidden
                },
            ),
        );
        let checkbox_bounds = Rect::from_xywh(
            bounds.origin.x + 12.0,
            editor_bounds.bottom() + 8.0,
            210.0,
            BUTTON_HEIGHT,
        );
        let checkbox = ActionBar::new(
            checkbox_bounds,
            ActionBarOrientation::Horizontal,
            vec![ActionBarItem::Action(
                ActionViewItem::icon_and_label(
                    if self.state.include_unstaged {
                        icons::CHECK
                    } else {
                        icons::REMOVE
                    },
                    "Include unstaged changes",
                    self.button_state(INCLUDE_UNSTAGED, true),
                )
                .with_selection(if self.state.include_unstaged {
                    ButtonSelection::Selected
                } else {
                    ButtonSelection::Unselected
                })
                .with_main_axis_extent(210.0),
            )],
            ActionBarStyle::new(self.button_style(), Size::new(210.0, BUTTON_HEIGHT)),
        );
        let submit_bounds = Rect::from_xywh(
            bounds.right() - 222.0,
            bounds.bottom() - BUTTON_HEIGHT - 12.0,
            210.0,
            BUTTON_HEIGHT,
        );
        let submit = ActionBar::new(
            submit_bounds,
            ActionBarOrientation::Horizontal,
            vec![
                ActionBarItem::Action(
                    ActionViewItem::label("Commit", self.button_state(SUBMIT_COMMIT, true))
                        .with_main_axis_extent(82.0),
                ),
                ActionBarItem::Action(
                    ActionViewItem::label(
                        "Commit and Push",
                        self.button_state(SUBMIT_COMMIT_AND_PUSH, true),
                    )
                    .with_main_axis_extent(124.0),
                ),
            ],
            ActionBarStyle::new(self.button_style(), Size::new(82.0, BUTTON_HEIGHT)).with_gap(4.0),
        );
        context.draw_component(&checkbox);
        context.draw_component(&submit);
        for (id, action_bar, index, label) in [
            (INCLUDE_UNSTAGED, &checkbox, 0, "Include unstaged changes"),
            (SUBMIT_COMMIT, &submit, 0, "Commit"),
            (SUBMIT_COMMIT_AND_PUSH, &submit, 1, "Commit and Push"),
        ] {
            if let Some(bounds) = action_bar.interactive_item_bounds(index) {
                context.draw_component(
                    &InteractionRegion::new(
                        "CommitComposerAction",
                        id,
                        bounds,
                        AccessibilityRole::Button,
                        label,
                    )
                    .with_cursor(CursorFeedback::Pointer)
                    .with_focus(FocusBehavior::TabStop)
                    .with_action(NodeAction::Activate),
                );
            }
        }
    }
}

impl Component for ChangesToolbar<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("ChangesToolbar")
            .in_bounds(self.bounds)
            .with_identity(CHANGES_TOOLBAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                CHANGES_TOOLBAR,
                element.bounds(),
                AccessibilityRole::Toolbar,
                "Changes toolbar",
            )
            .with_parent(self.parent),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context
            .scene_mut()
            .draw_rect(
                PaintRect::new(self.bounds, self.style.surface).with_border(Border::new(
                    Edges::new(0.0, 0.0, 1.0, 0.0),
                    self.style.border,
                )),
            );
        let (left, right) = self.bars();
        context.draw_component(&left);
        context.draw_component(&right);
        let navigation = NavigationGroupId::new(CHANGES_TOOLBAR);
        let ids = [
            (SCOPE_MAIN, &left, 0, "Selected changes scope"),
            (SCOPE_MORE, &left, 1, "Choose changes scope"),
            (PRIMARY_MAIN, &right, 0, "Run primary repository action"),
            (PRIMARY_MORE, &right, 1, "More repository actions"),
            (OPEN_FILES, &right, 2, "Open Files"),
            (OPEN_MORE, &right, 3, "More changes actions"),
        ];
        for (id, bar, index, label) in ids {
            if let Some(bounds) = bar.interactive_item_bounds(index) {
                context.draw_component(
                    &InteractionRegion::new(
                        "ChangesToolbarAction",
                        id,
                        bounds,
                        AccessibilityRole::Button,
                        label,
                    )
                    .with_parent(CHANGES_TOOLBAR)
                    .with_cursor(CursorFeedback::Pointer)
                    .with_focus(FocusBehavior::TabStop)
                    .with_action(NodeAction::Activate)
                    .with_navigation(navigation, NavigationAxis::Horizontal),
                );
            }
        }
        match self.state.open {
            Some(OpenMenu::Scope) => self.draw_menu(
                context,
                left.bounds(),
                SCOPE_MENU,
                "Changes scope",
                &ChangesScope::ALL.map(ChangesScope::label),
                scope_item_id,
                SCOPE_WIDTH,
            ),
            Some(OpenMenu::Primary) => {
                let labels: &[&str] = match self.state.branch_actions {
                    BranchActions::Primary => &["Commit", "Commit and Push", "Push"],
                    BranchActions::Topic => &[
                        "Auto Merge",
                        "Auto Squash",
                        "Auto Rebase",
                        "Create Draft PR",
                    ],
                    BranchActions::Unavailable => &[],
                };
                self.draw_menu(
                    context,
                    right.bounds(),
                    PRIMARY_MENU,
                    "Repository actions",
                    labels,
                    primary_item_id,
                    PRIMARY_WIDTH,
                );
            }
            Some(OpenMenu::More) => self.draw_menu(
                context,
                Rect::from_xywh(
                    right.bounds().right() - ICON_BUTTON_WIDTH,
                    right.bounds().origin.y,
                    ICON_BUTTON_WIDTH,
                    right.bounds().size.height,
                ),
                MORE_MENU,
                "Changes actions",
                &["Collapse All", "Expand All", "Stage All", "Discard All"],
                more_item_id,
                168.0,
            ),
            Some(OpenMenu::Commit) => self.draw_commit_composer(context, right.bounds()),
            None => {}
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.surface).with_border(Border::new(
                Edges::new(0.0, 0.0, 1.0, 0.0),
                self.style.border,
            )),
        );
        let (left, right) = self.bars();
        scene.draw_component(&left);
        scene.draw_component(&right);
    }
}

const fn scope_item_id(index: usize) -> ElementId {
    ElementId::scoped(TOOLBAR_SCOPE, SCOPE_ITEM_START + index as u32)
}

const fn primary_item_id(index: usize) -> ElementId {
    ElementId::scoped(TOOLBAR_SCOPE, PRIMARY_ITEM_START + index as u32)
}

const fn more_item_id(index: usize) -> ElementId {
    ElementId::scoped(TOOLBAR_SCOPE, MORE_ITEM_START + index as u32)
}

#[cfg(test)]
#[path = "toolbar_tests.rs"]
mod tests;
