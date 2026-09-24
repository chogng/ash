use crate::TabGroupId;
use crate::TabId;
use zui::ui::ElementId;

const SHELL_SCOPE: u32 = 1;
const TAB_CONTAINER_SCOPE: u32 = 14;
const TAB_CONTAINER_GROUP_SCOPE: u32 = 18;
const TAB_CONTAINER_CLOSE_SCOPE: u32 = 20;
const TAB_CONTAINER_ACTION_SCOPE: u32 = 24;
const SIDEBAR_GROUP_ROOT_SCOPE: u32 = 34;
const FIRST_SESSION_TAB: u32 = 100;

pub const WINDOW: ElementId = ElementId::scoped(SHELL_SCOPE, 1);
pub const TAB_CONTAINER_TOGGLE: ElementId = ElementId::scoped(SHELL_SCOPE, 12);
pub const TAB_CONTAINER: ElementId = ElementId::scoped(SHELL_SCOPE, 13);
pub const TAB_CONTAINER_SETTINGS_TAB: ElementId = ElementId::scoped(TAB_CONTAINER_SCOPE, 4);
pub const TAB_CONTAINER_SETTINGS_CLOSE: ElementId = ElementId::scoped(TAB_CONTAINER_CLOSE_SCOPE, 4);
pub const TAB_CONTAINER_SETTINGS_ACTION: ElementId =
    ElementId::scoped(TAB_CONTAINER_ACTION_SCOPE, 4);
pub const CHANGES_PANE_BUTTON: ElementId = ElementId::scoped(SHELL_SCOPE, 22);
pub const TAB_CONTAINER_TOOLBAR: ElementId = ElementId::scoped(SHELL_SCOPE, 24);
pub const SESSION_SEARCH_INPUT: ElementId = ElementId::scoped(SHELL_SCOPE, 25);
pub const TAB_CONTAINER_ACTION_BAR: ElementId = ElementId::scoped(SHELL_SCOPE, 26);
pub const ADD_SESSION: ElementId = ElementId::scoped(SHELL_SCOPE, 27);
pub const SIDEBAR_MODE_SWITCH: ElementId = ElementId::scoped(SHELL_SCOPE, 28);
pub const COWORK_MODE: ElementId = ElementId::scoped(SHELL_SCOPE, 29);
pub const CODE_MODE: ElementId = ElementId::scoped(SHELL_SCOPE, 30);
pub const FIRST_TAB_CONTAINER_SESSION_TAB: ElementId = ElementId::scoped(TAB_CONTAINER_SCOPE, 2);
pub const TAB_CONTAINER_LIST: ElementId = ElementId::scoped(TAB_CONTAINER_GROUP_SCOPE, 1);

pub fn session_tab_id(id: TabId) -> ElementId {
    if id.value() == TabId::FIRST.value() {
        return FIRST_TAB_CONTAINER_SESSION_TAB;
    }
    tab_element_id(TAB_CONTAINER_SCOPE, FIRST_SESSION_TAB, id, "session tab")
}

pub fn session_tab_close_id(id: TabId) -> ElementId {
    tab_element_id(
        TAB_CONTAINER_CLOSE_SCOPE,
        FIRST_SESSION_TAB,
        id,
        "session tab close button",
    )
}

pub fn session_tab_action_id(id: TabId) -> ElementId {
    tab_element_id(
        TAB_CONTAINER_ACTION_SCOPE,
        FIRST_SESSION_TAB,
        id,
        "session tab action button",
    )
}

pub fn tab_group_list_id(group: TabGroupId) -> ElementId {
    if group == TabGroupId::DEFAULT {
        return TAB_CONTAINER_LIST;
    }
    tab_group_element_id(TAB_CONTAINER_GROUP_SCOPE, group, "tab group list")
}

pub fn sidebar_group_root_id(group: TabGroupId) -> ElementId {
    tab_group_element_id(SIDEBAR_GROUP_ROOT_SCOPE, group, "Sidebar group root")
}

pub fn sidebar_group_for_root_element(id: ElementId) -> Option<TabGroupId> {
    let raw = id.into_raw();
    ((raw >> 32) == u64::from(SIDEBAR_GROUP_ROOT_SCOPE))
        .then(|| TabGroupId::from_value(raw & u64::from(u32::MAX)))
}

fn tab_element_id(scope: u32, first: u32, id: TabId, label: &str) -> ElementId {
    let local = id
        .value()
        .checked_sub(TabId::FIRST.value())
        .and_then(|offset| first.checked_add(offset))
        .unwrap_or_else(|| panic!("{label} index must fit its element scope"));
    ElementId::scoped(scope, local)
}

fn tab_group_element_id(scope: u32, group: TabGroupId, label: &str) -> ElementId {
    let local = u32::try_from(group.value())
        .unwrap_or_else(|_| panic!("{label} identity must fit its element scope"));
    ElementId::scoped(scope, local)
}
