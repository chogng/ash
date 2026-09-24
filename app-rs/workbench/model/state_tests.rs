//! Workbench tab and pane composition tests.

use super::{PaneInput, PaneSplitDirection, TabInputKey, Workbench};
use crate::PaneInputKind;
use crate::TabInput;
use crate::TabInputChange;
use crate::TabInputMetadata;
use crate::TabStatus;
use crate::TabStatusKind;
use ash_protocol::{Session, SessionId, SessionStatus, ThreadId};

fn session(id: &str, title: &str) -> Session {
    Session {
        session_id: SessionId::new(id).expect("test session ID is non-empty"),
        title: title.to_owned(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }
}

fn thread(id: &str) -> ThreadId {
    ThreadId::new(id).expect("test thread ID is non-empty")
}

fn upsert_session(workbench: &mut Workbench, session: &Session, dir: &str) -> TabInputChange {
    workbench.upsert_session_input(
        TabInput::session(
            session.session_id.clone(),
            TabInputMetadata::new(&session.title)
                .with_dirs([dir.into()])
                .with_status(TabStatus::new(TabStatusKind::Idle)),
        ),
        PaneInput::terminal(session.session_id.clone()),
    )
}

#[test]
fn workbench_initializes_one_container_for_its_settings_tab() {
    let workbench = Workbench::new();

    assert_eq!(workbench.sidebar_part().input_count(), 1);
    assert!(
        workbench
            .sidebar_part()
            .inputs()
            .next()
            .expect("Settings input")
            .is_settings()
    );
    assert_eq!(workbench.pane_container_keys().count(), 1);
    assert_eq!(
        workbench
            .pane_part(&TabInputKey::Settings)
            .and_then(|part| part.active_input(part.root_group()))
            .map(PaneInput::kind),
        Some(PaneInputKind::Settings)
    );
}

#[test]
fn tab_creation_initializes_the_matching_pane_container_terminal_pane() {
    let mut workbench = Workbench::new();
    let session = session("session-1", "Terminal");
    let key = TabInputKey::session(session.session_id.clone());

    upsert_session(&mut workbench, &session, "/dir");

    assert_eq!(workbench.sidebar_part().active_tab_key(), Some(&key));
    let panes = workbench
        .pane_container(&key)
        .expect("session pane container")
        .pane_part()
        .panes();
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id().value(), 1);
    assert_eq!(panes[0].input().kind(), PaneInputKind::Terminal);
    assert_eq!(
        panes[0].input().terminal_session_id(),
        Some(&session.session_id)
    );
}

#[test]
fn settings_tab_mounts_a_settings_pane_when_activated() {
    let mut workbench = Workbench::new();

    assert!(workbench.activate_settings());

    let key = TabInputKey::Settings;
    let pane = workbench
        .pane_part(&key)
        .expect("settings Pane Part")
        .panes()
        .pop()
        .expect("settings pane");
    assert_eq!(pane.input().kind(), PaneInputKind::Settings);
    assert_eq!(workbench.active_pane().expect("active settings pane"), pane);
}

#[test]
fn settings_tab_close_removes_its_container_and_activation_recreates_it() {
    let mut workbench = Workbench::new();
    assert!(workbench.activate_settings());

    let closed = workbench
        .close_tab(&TabInputKey::Settings)
        .expect("closed Settings tab");

    assert_eq!(closed.key(), &TabInputKey::Settings);
    assert!(
        workbench
            .sidebar_part()
            .input(&TabInputKey::Settings)
            .is_none()
    );
    assert!(workbench.pane_container(&TabInputKey::Settings).is_none());

    assert!(workbench.activate_settings());
    assert!(
        workbench
            .sidebar_part()
            .input(&TabInputKey::Settings)
            .is_some()
    );
    assert_eq!(
        workbench
            .pane_part(&TabInputKey::Settings)
            .and_then(|part| part.active_input(part.root_group()))
            .map(PaneInput::kind),
        Some(PaneInputKind::Settings)
    );
}

#[test]
fn session_and_settings_tabs_select_their_one_to_one_pane_containers() {
    let mut workbench = Workbench::new();
    let session = session("session-1", "Terminal");
    let session_key = TabInputKey::session(session.session_id.clone());
    upsert_session(&mut workbench, &session, "/dir");

    assert_eq!(
        workbench.active_pane().map(|pane| pane.input().kind()),
        Some(PaneInputKind::Terminal)
    );
    assert!(workbench.activate_settings());
    assert_eq!(
        workbench.active_pane().map(|pane| pane.input().kind()),
        Some(PaneInputKind::Settings)
    );
    assert!(workbench.activate_tab(session_key));
    assert_eq!(
        workbench.active_pane().map(|pane| pane.input().kind()),
        Some(PaneInputKind::Terminal)
    );
    assert_eq!(workbench.pane_container_keys().count(), 2);
}

#[test]
fn workbench_creates_or_destroys_active_panes() {
    let mut workbench = Workbench::new();
    let session = session("session-1", "Terminal");
    let session_id = session.session_id.clone();
    let key = TabInputKey::session(session_id.clone());
    upsert_session(&mut workbench, &session, "/dir");

    let pane = workbench
        .create_pane_with_direction(
            PaneInput::agent(session_id, thread("thread-1")),
            PaneSplitDirection::Vertical,
        )
        .expect("created pane");
    assert_eq!(pane.value(), 2);
    let pane_ids = workbench
        .pane_part(&key)
        .expect("session Pane Part")
        .group_ids();
    assert_eq!(pane_ids.len(), 2);
    assert_eq!(pane_ids[1], pane);

    let second_input = workbench
        .pane_part_mut(&key)
        .expect("session Pane Part")
        .open_input(pane, PaneInput::files("/dir".into()))
        .expect("opened group input");
    assert_eq!(second_input.value(), 2);

    let removed = workbench.destroy_pane().expect("active split pane");
    assert_eq!(removed.len(), 2);
    assert_eq!(removed[0].id().value(), 2);
    assert_eq!(removed[0].input().kind(), PaneInputKind::Agent);
    assert_eq!(removed[1].input().kind(), PaneInputKind::Files);
    assert!(
        workbench.destroy_pane().is_none(),
        "the root pane is retained"
    );
}

#[test]
fn pane_part_routes_group_input_changes_by_stable_ids() {
    let mut workbench = Workbench::new();
    let session = session("session-1", "Terminal");
    let key = TabInputKey::session(session.session_id.clone());
    upsert_session(&mut workbench, &session, "/dir");

    let group_id = workbench
        .pane_part(&key)
        .expect("session Pane Part")
        .active_group();
    let first_input_id = workbench
        .pane_part(&key)
        .and_then(|part| part.active_input_id(group_id))
        .expect("initial input");
    let second_input_id = workbench
        .pane_part_mut(&key)
        .expect("session Pane Part")
        .open_input(
            group_id,
            PaneInput::agent(session.session_id.clone(), thread("thread-1")),
        )
        .expect("second input");

    assert!(
        workbench
            .pane_part_mut(&key)
            .expect("session Pane Part")
            .activate_input(group_id, first_input_id)
    );
    assert_eq!(
        workbench
            .pane_part(&key)
            .and_then(|part| part.group(group_id))
            .and_then(|group| group.active_input_id()),
        Some(first_input_id)
    );

    let replaced = workbench
        .pane_part_mut(&key)
        .expect("session Pane Part")
        .replace_input(group_id, first_input_id, PaneInput::files("/dir".into()));
    assert_eq!(
        replaced.map(|input| input.kind()),
        Some(PaneInputKind::Terminal)
    );

    let closed = workbench
        .pane_part_mut(&key)
        .expect("session Pane Part")
        .close_input(group_id, second_input_id)
        .expect("closed input");
    assert_eq!(closed.input_id(), second_input_id);
    assert_eq!(
        workbench
            .pane_part(&key)
            .and_then(|part| part.group(group_id))
            .and_then(|group| group.active_input_id()),
        Some(first_input_id)
    );
}

#[test]
fn switching_tabs_switches_their_complete_pane_containers() {
    let mut workbench = Workbench::new();
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());

    upsert_session(&mut workbench, &first, "/first");
    workbench.create_pane(PaneInput::files("/first".into()));
    upsert_session(&mut workbench, &second, "/second");
    assert_eq!(
        workbench
            .active_pane_container()
            .expect("second pane container")
            .pane_part()
            .group_ids()
            .len(),
        1
    );

    assert!(workbench.activate_tab(first_key.clone()));
    assert_eq!(
        workbench
            .active_pane_container()
            .expect("first pane container")
            .pane_part()
            .group_ids()
            .len(),
        2
    );
    assert_eq!(
        workbench.active_pane().unwrap().input().kind(),
        PaneInputKind::Files
    );
    assert!(workbench.pane_container(&second_key).is_some());
}

#[test]
fn closing_a_tab_removes_its_pane_container_and_selects_the_next_tab() {
    let mut workbench = Workbench::new();
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    upsert_session(&mut workbench, &first, "/first");
    upsert_session(&mut workbench, &second, "/second");
    assert!(workbench.activate_tab(first_key.clone()));

    let closed = workbench.close_tab(&first_key).expect("closed session tab");
    assert_eq!(closed.key(), &first_key);
    assert_eq!(closed.panes().len(), 1);
    assert_eq!(closed.active_tab(), Some(&second_key));
    assert!(workbench.pane_container(&first_key).is_none());
    assert!(workbench.pane_container(&second_key).is_some());
    assert_eq!(workbench.sidebar_part().active_tab_key(), Some(&second_key));
}

#[test]
fn workbench_routes_pane_changes_by_logical_ids() {
    let mut workbench = Workbench::new();
    let session = session("session-1", "Terminal");
    let tab_key = TabInputKey::session(session.session_id.clone());
    upsert_session(&mut workbench, &session, "/dir");
    let root = workbench.active_pane_for(&tab_key).expect("root pane").id();
    let input_id = workbench
        .pane(&tab_key, root)
        .expect("root input")
        .input_id();

    assert!(workbench.activate_pane(&tab_key, root));
    assert!(workbench.activate_input(&tab_key, root, input_id));
    assert_eq!(
        workbench
            .pane_input(&tab_key, root)
            .expect("active input")
            .kind(),
        PaneInputKind::Terminal
    );
}
