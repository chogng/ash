use crate::ADD_SESSION;
use crate::{
    FIRST_TAB_CONTAINER_SESSION_TAB, SESSION_SEARCH_INPUT, TAB_CONTAINER_ACTION_BAR,
    TAB_CONTAINER_LIST, TAB_CONTAINER_TOOLBAR, TAB_CONTEXT_MENU, TabContextMenuAction,
};
use ash_files::{FILE_SEARCH_INPUT, FILES_TOOLBAR};
use ash_session::interaction::SESSION_HEADER;

#[test]
fn sessions_toolbar_elements_have_stable_unique_identities() {
    let ids = [
        TAB_CONTAINER_TOOLBAR,
        SESSION_SEARCH_INPUT,
        TAB_CONTAINER_ACTION_BAR,
        ADD_SESSION,
    ];

    assert_eq!(
        ids.into_iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        4
    );
}

#[test]
fn session_identity_namespace_does_not_overlap_capability_elements() {
    let session_ids = [
        TAB_CONTAINER_LIST,
        FIRST_TAB_CONTAINER_SESSION_TAB,
        SESSION_HEADER,
    ];
    let capability_ids = [FILE_SEARCH_INPUT, FILES_TOOLBAR];

    assert!(
        session_ids
            .into_iter()
            .all(|session| !capability_ids.contains(&session))
    );
}

#[test]
fn tab_context_menu_actions_have_stable_labels_and_identities() {
    let ids = TabContextMenuAction::ALL.map(TabContextMenuAction::element_id);
    let labels = TabContextMenuAction::ALL.map(|action| action.label(false, false));

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
        ids.into_iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        6
    );
    assert_eq!(
        TabContextMenuAction::from_element_id(ids[3]),
        Some(TabContextMenuAction::MoveToGroup)
    );
    assert_eq!(
        TabContextMenuAction::from_hint("r"),
        Some(TabContextMenuAction::Rename)
    );
    assert!(TabContextMenuAction::is_menu_element(TAB_CONTEXT_MENU));
}
