use super::ElementId;
use super::Point;
use super::Rect;

/// Presentation work required when an interaction state changes.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub enum DispatchInvalidation {
    /// The interaction state changed without requiring a presentation update.
    #[default]
    None,
    /// Rebuild the host's complete presentation.
    Paint,
    /// Rebuild only the host's retained presentation fragment.
    Fragment,
}

impl DispatchInvalidation {
    /// Combines invalidations from two interaction states.
    ///
    /// A full paint is required whenever one side changes outside a retained fragment. Two
    /// fragment-local changes can remain local and are resolved by the dispatch outcome's stable
    /// element ID.
    pub const fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Paint, _) | (_, Self::Paint) => Self::Paint,
            (Self::Fragment, _) | (_, Self::Fragment) => Self::Fragment,
            (Self::None, Self::None) => Self::None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CursorFeedback {
    #[default]
    Default,
    Text,
    Pointer,
    ResizeHorizontal,
    ResizeVertical,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FocusBehavior {
    #[default]
    None,
    TabStop,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct NavigationGroupId(ElementId);

impl NavigationGroupId {
    pub const fn new(element: ElementId) -> Self {
        Self(element)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NodeAction {
    #[default]
    None,
    Activate,
    /// Toggles view-local disclosure state retained by [`crate::ui::UiDispatch`].
    ToggleExpansion,
    /// Adjusts an integer view-local value retained by [`crate::ui::UiDispatch`].
    AdjustValue {
        target: ElementId,
        delta: i32,
        minimum: i32,
        maximum: i32,
    },
    StartWindowDrag,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UiIntent {
    Activate(ElementId),
    StartWindowDrag(ElementId),
}

impl UiIntent {
    pub const fn element_id(self) -> ElementId {
        match self {
            Self::Activate(id) | Self::StartWindowDrag(id) => id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessibilityRole {
    Window,
    Group,
    Separator,
    Toolbar,
    Button,
    TextInput,
    Terminal,
    List,
    ListItem,
    Tree,
    TreeItem,
    RadioGroup,
    RadioButton,
    ScrollBar,
    Menu,
    MenuItem,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AccessibilitySelection {
    #[default]
    NotApplicable,
    Selected,
    Unselected,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AccessibilityExpansion {
    #[default]
    NotApplicable,
    Collapsed,
    Expanded,
}

/// One backend-neutral interaction declaration produced by a component.
#[derive(Clone, Debug, PartialEq)]
pub struct UiNode {
    id: ElementId,
    parent: Option<ElementId>,
    bounds: Rect,
    cursor: CursorFeedback,
    focus: FocusBehavior,
    action: NodeAction,
    invalidation: DispatchInvalidation,
    navigation: Option<(NavigationGroupId, NavigationAxis)>,
    role: AccessibilityRole,
    label: String,
    value: Option<String>,
    selection: AccessibilitySelection,
    level: Option<usize>,
    expansion: AccessibilityExpansion,
}

impl UiNode {
    pub fn new(
        id: ElementId,
        bounds: Rect,
        role: AccessibilityRole,
        label: impl Into<String>,
    ) -> Self {
        Self {
            id,
            parent: None,
            bounds,
            cursor: CursorFeedback::Default,
            focus: FocusBehavior::None,
            action: NodeAction::None,
            invalidation: DispatchInvalidation::Paint,
            navigation: None,
            role,
            label: label.into(),
            value: None,
            selection: AccessibilitySelection::NotApplicable,
            level: None,
            expansion: AccessibilityExpansion::NotApplicable,
        }
    }

    pub const fn with_parent(mut self, parent: ElementId) -> Self {
        self.parent = Some(parent);
        self
    }

    pub const fn with_cursor(mut self, cursor: CursorFeedback) -> Self {
        self.cursor = cursor;
        self
    }

    pub const fn with_focus(mut self, focus: FocusBehavior) -> Self {
        self.focus = focus;
        self
    }

    pub const fn with_action(mut self, action: NodeAction) -> Self {
        self.action = action;
        self
    }

    /// Sets the minimum presentation invalidation for hover, focus, press, and activation state.
    pub const fn with_invalidation(mut self, invalidation: DispatchInvalidation) -> Self {
        self.invalidation = invalidation;
        self
    }

    pub const fn with_navigation(mut self, group: NavigationGroupId, axis: NavigationAxis) -> Self {
        self.navigation = Some((group, axis));
        self
    }

    pub fn with_value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub const fn with_selection(mut self, selection: AccessibilitySelection) -> Self {
        self.selection = selection;
        self
    }

    pub const fn with_level(mut self, level: usize) -> Self {
        self.level = Some(level);
        self
    }

    pub const fn with_expansion(mut self, expansion: AccessibilityExpansion) -> Self {
        self.expansion = expansion;
        self
    }

    pub const fn id(&self) -> ElementId {
        self.id
    }

    pub const fn parent(&self) -> Option<ElementId> {
        self.parent
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn cursor(&self) -> CursorFeedback {
        self.cursor
    }

    pub const fn focus_behavior(&self) -> FocusBehavior {
        self.focus
    }

    pub const fn action(&self) -> NodeAction {
        self.action
    }

    pub const fn invalidation(&self) -> DispatchInvalidation {
        self.invalidation
    }

    pub const fn navigation(&self) -> Option<(NavigationGroupId, NavigationAxis)> {
        self.navigation
    }

    pub const fn role(&self) -> AccessibilityRole {
        self.role
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn value(&self) -> Option<&str> {
        self.value.as_deref()
    }

    pub const fn selection(&self) -> AccessibilitySelection {
        self.selection
    }

    pub const fn level(&self) -> Option<usize> {
        self.level
    }

    pub const fn expansion(&self) -> AccessibilityExpansion {
        self.expansion
    }

    pub(crate) fn contains(&self, point: Point) -> bool {
        self.bounds.contains(point)
    }
}

/// Sink consumed by presentation composition to publish backend-neutral interaction nodes.
///
/// Runtime adapters implement this trait to retain nodes, route hit testing, and produce
/// accessibility snapshots. Presentation code depends only on this contract so runtime remains
/// independent from component layout and paint.
pub trait InteractionSink {
    fn register(&mut self, node: UiNode);

    /// Restricts hit testing and focus traversal to a registered modal subtree.
    ///
    /// Sinks that do not retain modal interaction state may keep the default no-op behavior.
    fn set_modal_root(&mut self, _root: ElementId) {}
}
