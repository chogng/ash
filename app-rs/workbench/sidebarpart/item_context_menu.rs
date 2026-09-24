use zui::ui::ElementId;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

use crate::TabGroupId;
use crate::TabInputKey;

#[path = "item_context_menu/view.rs"]
mod view;

pub use view::TabContextMenu;
pub use view::TabContextMenuStyle;
pub(crate) use view::tab_context_menu_groups_contain_pointer;
pub use view::update_tab_context_menu_pointer;

const TAB_CONTEXT_MENU_SCOPE: u32 = 22;
const TAB_CONTEXT_MENU_GROUP_ITEM_SCOPE: u32 = 26;
pub const TAB_CONTEXT_MENU: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 1);
pub const TAB_CONTEXT_MENU_GROUPS: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 6);
pub const TAB_RENAME_INPUT: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 8);
const TAB_CONTEXT_MENU_PIN: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 2);
const TAB_CONTEXT_MENU_DELETE: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 3);
const TAB_CONTEXT_MENU_MOVE_TO_GROUP: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 4);
const TAB_CONTEXT_MENU_RENAME: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 5);
const TAB_CONTEXT_MENU_ARCHIVE: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 9);
const TAB_CONTEXT_MENU_FORK: ElementId = ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 10);
pub const TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP: ElementId =
    ElementId::scoped(TAB_CONTEXT_MENU_SCOPE, 7);

/// Root action emitted by the Workbench tab context menu.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TabContextMenuAction {
    TogglePin,
    Rename,
    Fork,
    MoveToGroup,
    Archive,
    Delete,
}

impl TabContextMenuAction {
    #[cfg(test)]
    pub const ALL: [Self; 6] = [
        Self::TogglePin,
        Self::Rename,
        Self::Fork,
        Self::MoveToGroup,
        Self::Archive,
        Self::Delete,
    ];

    pub const fn element_id(self) -> ElementId {
        match self {
            Self::TogglePin => TAB_CONTEXT_MENU_PIN,
            Self::Rename => TAB_CONTEXT_MENU_RENAME,
            Self::Fork => TAB_CONTEXT_MENU_FORK,
            Self::MoveToGroup => TAB_CONTEXT_MENU_MOVE_TO_GROUP,
            Self::Archive => TAB_CONTEXT_MENU_ARCHIVE,
            Self::Delete => TAB_CONTEXT_MENU_DELETE,
        }
    }

    pub const fn label(self, pinned: bool, confirm_delete: bool) -> &'static str {
        match self {
            Self::TogglePin if pinned => "Unpin",
            Self::TogglePin => "Pin",
            Self::Rename => "Rename",
            Self::Fork => "Fork",
            Self::MoveToGroup => "Move to group",
            Self::Archive => "Archive",
            Self::Delete if confirm_delete => "Confirm delete",
            Self::Delete => "Delete",
        }
    }

    const fn menu_index(self) -> usize {
        match self {
            Self::TogglePin => 0,
            Self::Rename => 1,
            Self::Fork => 2,
            Self::MoveToGroup => 4,
            Self::Archive => 6,
            Self::Delete => 7,
        }
    }

    pub(crate) fn from_hint(text: &str) -> Option<Self> {
        match text {
            "p" | "P" => Some(Self::TogglePin),
            "r" | "R" => Some(Self::Rename),
            "f" | "F" => Some(Self::Fork),
            "m" | "M" => Some(Self::MoveToGroup),
            "a" | "A" => Some(Self::Archive),
            "d" | "D" => Some(Self::Delete),
            _ => None,
        }
    }

    pub const fn from_element_id(id: ElementId) -> Option<Self> {
        match id {
            TAB_CONTEXT_MENU_PIN => Some(Self::TogglePin),
            TAB_CONTEXT_MENU_RENAME => Some(Self::Rename),
            TAB_CONTEXT_MENU_FORK => Some(Self::Fork),
            TAB_CONTEXT_MENU_MOVE_TO_GROUP => Some(Self::MoveToGroup),
            TAB_CONTEXT_MENU_ARCHIVE => Some(Self::Archive),
            TAB_CONTEXT_MENU_DELETE => Some(Self::Delete),
            _ => None,
        }
    }

    pub fn is_menu_element(id: ElementId) -> bool {
        id == TAB_CONTEXT_MENU
            || id == TAB_CONTEXT_MENU_GROUPS
            || id == TAB_RENAME_INPUT
            || id == TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP
            || Self::from_element_id(id).is_some()
            || tab_group_for_menu_element(id).is_some()
    }
}

/// Result requested after one menu item is activated.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TabContextMenuActivation {
    Ignored,
    OpenGroupMenu,
    TogglePin(TabInputKey),
    Fork(TabInputKey),
    Archive(TabInputKey),
    ConfirmDelete,
    Delete(TabInputKey),
    MoveToGroup(TabInputKey, TabGroupId),
    MoveToNewGroup(TabInputKey),
    BeginRename(TabInputKey),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum TabContextMenuView {
    #[default]
    Actions,
    Groups,
    Rename,
}

#[derive(Clone, Debug, PartialEq)]
struct OpenTabContextMenu {
    target_tab: TabInputKey,
    anchor: Rect,
    restore_focus: Option<ElementId>,
    pinned: bool,
    view: TabContextMenuView,
    rename: TextInput,
    confirm_delete: bool,
}

/// Workbench-owned transient state for tab actions, group selection, and tab-name editing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabContextMenuState {
    open: Option<OpenTabContextMenu>,
}

impl TabContextMenuState {
    pub fn open_pinned(
        &mut self,
        target_tab: TabInputKey,
        position: Point,
        restore_focus: Option<ElementId>,
    ) {
        self.open(target_tab, position, restore_focus, true);
    }

    pub fn open_unpinned(
        &mut self,
        target_tab: TabInputKey,
        position: Point,
        restore_focus: Option<ElementId>,
    ) {
        self.open(target_tab, position, restore_focus, false);
    }

    fn open(
        &mut self,
        target_tab: TabInputKey,
        position: Point,
        restore_focus: Option<ElementId>,
        pinned: bool,
    ) {
        self.open = Some(OpenTabContextMenu {
            target_tab,
            anchor: Rect::from_xywh(position.x, position.y, 1.0, 1.0),
            restore_focus,
            pinned,
            view: TabContextMenuView::Actions,
            rename: TextInput::new(),
            confirm_delete: false,
        });
    }

    pub fn open_rename(
        &mut self,
        target_tab: TabInputKey,
        anchor: Rect,
        restore_focus: Option<ElementId>,
        pinned: bool,
        title: &str,
    ) {
        let mut rename = TextInput::new();
        rename.apply(TextInputCommand::Insert(title.to_owned()));
        rename.apply(TextInputCommand::SelectAll);
        self.open = Some(OpenTabContextMenu {
            target_tab,
            anchor,
            restore_focus,
            pinned,
            view: TabContextMenuView::Rename,
            rename,
            confirm_delete: false,
        });
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn is_renaming(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.view == TabContextMenuView::Rename)
    }

    pub fn is_group_menu_open(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.view == TabContextMenuView::Groups)
    }

    pub fn open_group_menu(&mut self) -> bool {
        let Some(open) = self
            .open
            .as_mut()
            .filter(|open| open.view == TabContextMenuView::Actions)
        else {
            return false;
        };
        open.confirm_delete = false;
        open.view = TabContextMenuView::Groups;
        true
    }

    pub(crate) fn close_group_menu(&mut self) -> bool {
        let Some(open) = self
            .open
            .as_mut()
            .filter(|open| open.view == TabContextMenuView::Groups)
        else {
            return false;
        };
        open.view = TabContextMenuView::Actions;
        true
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub fn target_tab(&self) -> Option<&TabInputKey> {
        self.open.as_ref().map(|open| &open.target_tab)
    }

    #[cfg(test)]
    pub fn target_is_pinned(&self) -> bool {
        self.open.as_ref().is_some_and(|open| open.pinned)
    }

    pub fn activate(&mut self, id: ElementId) -> TabContextMenuActivation {
        let Some(open) = self.open.as_mut() else {
            return TabContextMenuActivation::Ignored;
        };
        if let Some(group) = tab_group_for_menu_element(id) {
            return TabContextMenuActivation::MoveToGroup(open.target_tab.clone(), group);
        }
        if id == TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP {
            return TabContextMenuActivation::MoveToNewGroup(open.target_tab.clone());
        }
        match TabContextMenuAction::from_element_id(id) {
            Some(TabContextMenuAction::TogglePin) => {
                TabContextMenuActivation::TogglePin(open.target_tab.clone())
            }
            Some(TabContextMenuAction::Fork) if open.target_tab.session_id().is_some() => {
                open.confirm_delete = false;
                TabContextMenuActivation::Fork(open.target_tab.clone())
            }
            Some(TabContextMenuAction::Fork) => TabContextMenuActivation::Ignored,
            Some(TabContextMenuAction::MoveToGroup) => {
                open.confirm_delete = false;
                open.view = TabContextMenuView::Groups;
                TabContextMenuActivation::OpenGroupMenu
            }
            Some(TabContextMenuAction::Rename) => {
                open.confirm_delete = false;
                open.view = TabContextMenuView::Rename;
                TabContextMenuActivation::BeginRename(open.target_tab.clone())
            }
            Some(TabContextMenuAction::Archive) if open.target_tab.session_id().is_some() => {
                open.confirm_delete = false;
                TabContextMenuActivation::Archive(open.target_tab.clone())
            }
            Some(TabContextMenuAction::Archive) => TabContextMenuActivation::Ignored,
            Some(TabContextMenuAction::Delete)
                if open.target_tab.session_id().is_some() && open.confirm_delete =>
            {
                TabContextMenuActivation::Delete(open.target_tab.clone())
            }
            Some(TabContextMenuAction::Delete) if open.target_tab.session_id().is_some() => {
                open.confirm_delete = true;
                TabContextMenuActivation::ConfirmDelete
            }
            Some(TabContextMenuAction::Delete) => TabContextMenuActivation::Ignored,
            None => TabContextMenuActivation::Ignored,
        }
    }

    pub fn set_rename_text(&mut self, title: &str) -> bool {
        let Some(open) = self.open.as_mut() else {
            return false;
        };
        open.rename = TextInput::new();
        open.rename
            .apply(TextInputCommand::Insert(title.to_owned()));
        open.rename.apply(TextInputCommand::SelectAll);
        true
    }

    pub fn apply_rename(&mut self, command: TextInputCommand) -> bool {
        let Some(open) = self
            .open
            .as_mut()
            .filter(|open| open.view == TabContextMenuView::Rename)
        else {
            return false;
        };
        open.rename.apply(command);
        true
    }

    pub fn apply_rename_composition(&mut self, event: TextInputCompositionEvent) -> bool {
        let Some(open) = self
            .open
            .as_mut()
            .filter(|open| open.view == TabContextMenuView::Rename)
        else {
            return false;
        };
        open.rename.apply_composition(event);
        true
    }

    pub fn take_rename(&self) -> Option<(TabInputKey, String)> {
        let open = self
            .open
            .as_ref()
            .filter(|open| open.view == TabContextMenuView::Rename)?;
        let title = open.rename.text().trim();
        (!title.is_empty()).then(|| (open.target_tab.clone(), title.to_owned()))
    }
}

pub fn tab_group_menu_element_id(group: TabGroupId) -> ElementId {
    let local = u32::try_from(group.value()).expect("tab group identity must fit menu scope");
    ElementId::scoped(TAB_CONTEXT_MENU_GROUP_ITEM_SCOPE, local)
}

pub fn tab_group_for_menu_element(id: ElementId) -> Option<TabGroupId> {
    let raw = id.into_raw();
    ((raw >> 32) == u64::from(TAB_CONTEXT_MENU_GROUP_ITEM_SCOPE))
        .then(|| TabGroupId::from_value(raw & u64::from(u32::MAX)))
}

#[cfg(test)]
#[path = "item_context_menu_tests.rs"]
mod tests;
