//! Mapping from Workbench inputs into Sidebar Session item identities.

use std::path::PathBuf;

use zui::ui::ElementId;

use super::identity::{
    FIRST_TAB_CONTAINER_SESSION_TAB, TAB_CONTAINER_SETTINGS_ACTION, TAB_CONTAINER_SETTINGS_CLOSE,
    TAB_CONTAINER_SETTINGS_TAB, session_tab_action_id, session_tab_close_id, session_tab_id,
};
use super::mode_switcher::mode_for_element;
use crate::SidebarPart;
use crate::TabGroupId;
use crate::TabInput;
use crate::TabInputKey;
use crate::TabStatus;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SessionListItemKind {
    Session,
    Settings,
}

#[derive(Clone)]
pub struct SessionListItem<'a> {
    pub(super) id: ElementId,
    pub(super) action_id: ElementId,
    pub(super) close_id: ElementId,
    pub(super) kind: SessionListItemKind,
    pub(super) name: &'a str,
    pub(super) dirs: &'a [PathBuf],
    pub(super) status: TabStatus,
    pub(super) pinned: bool,
}

#[derive(Clone)]
pub struct SessionGroup<'a> {
    pub(super) id: TabGroupId,
    pub(super) label: Option<&'a str>,
    pub(super) collapsed: bool,
    pub(super) tabs: Vec<SessionListItem<'a>>,
}

impl<'a> SessionGroup<'a> {
    pub fn new(
        id: TabGroupId,
        label: Option<&'a str>,
        collapsed: bool,
        tabs: Vec<SessionListItem<'a>>,
    ) -> Self {
        Self {
            id,
            label,
            collapsed,
            tabs,
        }
    }
}

/// Resolves one presentation's element identity without leaking UI identity into Workbench state.
pub fn sidebar_selected_item_id(
    sidebar_part: &SidebarPart,
    selected: Option<&TabInputKey>,
) -> ElementId {
    let Some(selected) = selected else {
        return FIRST_TAB_CONTAINER_SESSION_TAB;
    };
    mounted_sidebar_item_id(sidebar_part, selected).unwrap_or(FIRST_TAB_CONTAINER_SESSION_TAB)
}

/// Resolves one mounted tab without substituting another tab when the input is absent.
pub fn mounted_sidebar_item_id(sidebar_part: &SidebarPart, tab: &TabInputKey) -> Option<ElementId> {
    if tab.is_settings() {
        return sidebar_part.input(tab).map(|_| TAB_CONTAINER_SETTINGS_TAB);
    }
    sidebar_part.tab_id(tab).map(session_tab_id)
}

/// Workbench-owned action resolved from one mounted tab element.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SidebarIntent {
    SetMode(crate::SidebarMode),
    ToggleGroup(TabGroupId),
    Activate(TabInputKey),
    Rename(TabInputKey),
    OpenActions(TabInputKey),
    Close(TabInputKey),
}

/// Resolves a tab or close-button identity without depending on current tab order.
pub fn sidebar_intent_for_element(
    sidebar_part: &SidebarPart,
    element: ElementId,
) -> Option<SidebarIntent> {
    if let Some(mode) = mode_for_element(element) {
        return Some(SidebarIntent::SetMode(mode));
    }
    if let Some(group) = super::identity::sidebar_group_for_root_element(element)
        && sidebar_part.group(group).is_some()
    {
        return Some(SidebarIntent::ToggleGroup(group));
    }
    if element == TAB_CONTAINER_SETTINGS_ACTION {
        return sidebar_part
            .input(&TabInputKey::Settings)
            .map(|_| SidebarIntent::OpenActions(TabInputKey::Settings));
    }
    if element == TAB_CONTAINER_SETTINGS_CLOSE {
        return sidebar_part
            .input(&TabInputKey::Settings)
            .map(|_| SidebarIntent::Close(TabInputKey::Settings));
    }
    if element == TAB_CONTAINER_SETTINGS_TAB {
        return Some(SidebarIntent::Activate(TabInputKey::Settings));
    }
    for input in sidebar_part.inputs().filter(|input| input.is_session()) {
        let tab_id = sidebar_part
            .tab_id(input.key())
            .expect("mounted Session TabInput must have a TabId");
        if element == session_tab_id(tab_id) {
            return Some(SidebarIntent::Activate(input.key().clone()));
        }
        if element == super::item_dirs_preview::dirs_preview_name_id(session_tab_id(tab_id)) {
            return Some(SidebarIntent::Rename(input.key().clone()));
        }
        if element == session_tab_action_id(tab_id) {
            return Some(SidebarIntent::OpenActions(input.key().clone()));
        }
        if element == session_tab_close_id(tab_id) {
            return Some(SidebarIntent::Close(input.key().clone()));
        }
    }
    None
}

/// Resolves the Session tab owning a mounted tab element.
pub fn sidebar_item_key_for_element(
    sidebar_part: &SidebarPart,
    element: ElementId,
) -> Option<&TabInputKey> {
    sidebar_part.inputs().find_map(|input| {
        if input.is_settings() {
            return (TAB_CONTAINER_SETTINGS_TAB == element
                || TAB_CONTAINER_SETTINGS_ACTION == element)
                .then_some(input.key());
        }
        let tab_id = sidebar_part.tab_id(input.key())?;
        (session_tab_id(tab_id) == element
            || session_tab_action_id(tab_id) == element
            || super::item_dirs_preview::dirs_preview_name_id(session_tab_id(tab_id)) == element)
            .then_some(input.key())
    })
}

pub fn sidebar_session_groups<'a>(
    sidebar_part: &'a SidebarPart,
    include: impl Fn(&TabInput) -> bool,
) -> Vec<SessionGroup<'a>> {
    sidebar_part
        .groups()
        .iter()
        .filter_map(|group| {
            let tabs = group
                .inputs()
                .iter()
                .filter(|input| include(input))
                .map(|input| SessionListItem::from_input(sidebar_part, input))
                .collect::<Vec<_>>();
            (!tabs.is_empty())
                .then(|| SessionGroup::new(group.id(), group.label(), group.is_collapsed(), tabs))
        })
        .collect()
}

impl<'a> SessionListItem<'a> {
    pub fn from_input(sidebar_part: &'a SidebarPart, input: &'a TabInput) -> Self {
        if input.is_settings() {
            Self::settings(
                TAB_CONTAINER_SETTINGS_TAB,
                TAB_CONTAINER_SETTINGS_ACTION,
                TAB_CONTAINER_SETTINGS_CLOSE,
                sidebar_part.tab_name(input),
            )
        } else {
            let tab_id = sidebar_part
                .tab_id(input.key())
                .expect("mounted Session TabInput must have a TabId");
            Self::new(
                session_tab_id(tab_id),
                session_tab_action_id(tab_id),
                session_tab_close_id(tab_id),
                sidebar_part.tab_name(input),
                input.status().clone(),
                sidebar_part.is_tab_pinned(input.key()),
            )
            .with_dirs(input.dirs())
        }
    }

    pub fn new(
        id: ElementId,
        action_id: ElementId,
        close_id: ElementId,
        name: &'a str,
        status: TabStatus,
        pinned: bool,
    ) -> Self {
        Self {
            id,
            action_id,
            close_id,
            kind: SessionListItemKind::Session,
            name,
            dirs: &[],
            status,
            pinned,
        }
    }

    pub fn with_dirs(mut self, dirs: &'a [PathBuf]) -> Self {
        self.dirs = dirs;
        self
    }

    pub fn settings(
        id: ElementId,
        action_id: ElementId,
        close_id: ElementId,
        name: &'a str,
    ) -> Self {
        Self {
            id,
            action_id,
            close_id,
            kind: SessionListItemKind::Settings,
            name,
            dirs: &[],
            status: TabStatus::default(),
            pinned: false,
        }
    }
}
