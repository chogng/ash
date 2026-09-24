use super::PaneKey;
use super::TabContextMenuOutcome;
use super::WorkbenchHost;
use crate::Color;
use crate::PaneInput;
use crate::PaneSplitDirection;
use crate::Rect;
use crate::ScrollAxis;
use crate::ScrollView;
use crate::ScrollViewStyle;
use crate::ScrollbarState;
use crate::ScrollbarStyle;
use crate::Size;
use crate::TabInput;
use crate::TabInputKey;
use crate::TabInputMetadata;
use crate::TabStatus;
use crate::TabStatusKind;
use std::time::Instant;
use zui::ui::Point;
use zui::ui::TextInputCommand;

fn session_id(value: &str) -> ash_protocol::SessionId {
    ash_protocol::SessionId::new(value).expect("valid session id")
}

fn session_input(id: ash_protocol::SessionId) -> TabInput {
    TabInput::session(
        id,
        TabInputMetadata::new("Session").with_status(TabStatus::new(TabStatusKind::Idle)),
    )
}

#[test]
fn host_mounts_binding_by_tab_pane_and_input_identity() {
    let session = session_id("session-1");
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(session.clone()),
        PaneInput::terminal(session),
        || "terminal",
    );
    let pane = host
        .workbench()
        .pane_part(&tab)
        .expect("session pane part")
        .root_group();

    let mount = host.mount(&tab, pane).expect("bound input should mount");

    assert_eq!(mount.key().tab(), &tab);
    assert_eq!(mount.pane_id(), pane);
    assert_eq!(*mount.binding(), "terminal");
}

#[test]
fn switching_group_inputs_preserves_each_binding() {
    let session = session_id("session-1");
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(session.clone()),
        PaneInput::terminal(session.clone()),
        || "terminal",
    );
    let pane = host
        .workbench()
        .pane_part(&tab)
        .expect("session pane part")
        .root_group();
    let terminal = host
        .mount(&tab, pane)
        .expect("terminal mount")
        .key()
        .clone();

    let opened = host
        .open_or_activate_input_with(&tab, pane, PaneInput::files("/dir".into()), || "files")
        .expect("files activation");
    assert_eq!(host.binding(&terminal), Some(&"terminal"));
    assert_eq!(host.binding(opened.current()), Some(&"files"));

    let activated = host
        .open_or_activate_input_with(&tab, pane, PaneInput::terminal(session), || {
            panic!("existing input must not create a replacement binding")
        })
        .expect("terminal activation");
    assert_eq!(activated.current(), &terminal);
    assert_eq!(host.binding(&terminal), Some(&"terminal"));
}

#[test]
fn ensuring_group_input_keeps_the_existing_input_active() {
    let session = session_id("session-1");
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(session.clone()),
        PaneInput::terminal(session),
        || "terminal",
    );
    let pane = host
        .workbench()
        .pane_part(&tab)
        .expect("session pane part")
        .root_group();

    let files = host
        .ensure_input_with(&tab, pane, PaneInput::files("/dir".into()), || "files")
        .expect("files input should be attached");

    assert_eq!(
        host.mount(&tab, pane).unwrap().kind(),
        crate::PaneInputKind::Terminal
    );
    assert_eq!(host.binding(&files), Some(&"files"));
    assert_eq!(
        host.workbench()
            .pane_part(&tab)
            .unwrap()
            .group(pane)
            .unwrap()
            .inputs()
            .count(),
        2
    );
}

#[test]
fn closing_a_pane_detaches_all_group_input_bindings() {
    let session = session_id("session-1");
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(session.clone()),
        PaneInput::terminal(session.clone()),
        || "root",
    );
    let split = host
        .try_split_active_with(
            PaneInput::terminal(session),
            PaneSplitDirection::Horizontal,
            || Ok::<_, std::convert::Infallible>("split-terminal"),
        )
        .expect("binding creation")
        .expect("split input");
    host.open_or_activate_input_with(
        &tab,
        split.pane(),
        PaneInput::files("/dir".into()),
        || "split-files",
    )
    .expect("second split input");

    let closed = host.close_active_pane().expect("active split pane");
    let active = closed.active_pane();
    let mut bindings = closed.into_bindings();
    bindings.sort_unstable();

    assert_eq!(bindings, vec!["split-files", "split-terminal"]);
    assert_ne!(active, split.pane());
}

#[test]
fn closing_a_tab_detaches_only_its_bindings() {
    let first = session_id("session-1");
    let second = session_id("session-2");
    let first_tab = TabInputKey::session(first.clone());
    let second_tab = TabInputKey::session(second.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(first.clone()),
        PaneInput::terminal(first),
        || "first",
    );
    host.upsert_session_input_with(
        session_input(second.clone()),
        PaneInput::terminal(second),
        || "second",
    );
    let second_key = host.active_mount().expect("second mount").key().clone();

    let (_, bindings) = host.close_tab(&first_tab).expect("first tab should close");

    assert_eq!(bindings, vec!["first"]);
    assert_eq!(host.binding(&second_key), Some(&"second"));
    assert_eq!(
        host.workbench().sidebar_part().active_tab_key(),
        Some(&second_tab)
    );
}

#[test]
fn pane_key_keeps_input_identity_distinct_inside_one_group() {
    let tab = TabInputKey::Settings;
    let first = PaneKey::new(
        tab.clone(),
        crate::PaneGroupId::ROOT,
        crate::PaneInputId::from_value(1),
    );
    let second = PaneKey::new(
        tab,
        crate::PaneGroupId::ROOT,
        crate::PaneInputId::from_value(2),
    );

    assert_ne!(first, second);
}

#[test]
fn tab_menu_routes_group_selection_and_rename_through_the_workbench_host() {
    let first = session_id("session-1");
    let second = session_id("session-2");
    let first_tab = TabInputKey::session(first.clone());
    let second_tab = TabInputKey::session(second.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(first.clone()),
        PaneInput::terminal(first),
        || (),
    );
    host.upsert_session_input_with(
        session_input(second.clone()),
        PaneInput::terminal(second),
        || (),
    );
    let group = host
        .move_tab_to_new_group(&second_tab, "Review")
        .expect("second tab group");

    assert!(host.open_tab_context_menu(first_tab.clone(), Point::new(20.0, 30.0), None));
    assert_eq!(
        host.activate_tab_context_menu(crate::TabContextMenuAction::MoveToGroup.element_id()),
        TabContextMenuOutcome::Focus(crate::tab_group_menu_element_id(group))
    );
    assert_eq!(
        host.activate_tab_context_menu(crate::tab_group_menu_element_id(group)),
        TabContextMenuOutcome::Changed
    );
    assert_eq!(
        host.workbench().sidebar_part().input_group(&first_tab),
        Some(group)
    );

    assert!(host.open_tab_context_menu(first_tab.clone(), Point::new(20.0, 30.0), None));
    assert_eq!(
        host.activate_tab_context_menu(crate::TabContextMenuAction::Rename.element_id()),
        TabContextMenuOutcome::Focus(crate::TAB_RENAME_INPUT)
    );
    assert!(host.apply_tab_rename(TextInputCommand::Insert("Build fixes".to_owned())));
    assert!(host.commit_tab_rename());
    let input = host.workbench().sidebar_part().input(&first_tab).unwrap();
    assert_eq!(
        host.workbench().sidebar_part().tab_name(input),
        "Build fixes"
    );
}

#[test]
fn session_name_editor_opens_directly_at_the_preview_name() {
    let session = session_id("session-rename");
    let tab = TabInputKey::session(session.clone());
    let mut host = WorkbenchHost::new();
    host.upsert_session_input_with(
        session_input(session.clone()),
        PaneInput::terminal(session),
        || (),
    );

    assert!(host.open_tab_rename(tab.clone(), Rect::from_xywh(220.0, 80.0, 180.0, 22.0), None,));
    assert!(host.tab_context_menu().is_renaming());
    assert!(host.apply_tab_rename(TextInputCommand::Insert("Release summary".to_owned())));
    assert!(host.commit_tab_rename());

    let input = host.workbench().sidebar_part().input(&tab).unwrap();
    assert_eq!(
        host.workbench().sidebar_part().tab_name(input),
        "Release summary"
    );
}

#[test]
fn tab_container_scrollbar_follows_viewport_hover_and_keeps_drag_geometry() {
    let now = Instant::now();
    let mut host = WorkbenchHost::<()>::new();
    let view = ScrollView::new(
        Rect::from_xywh(0.0, 0.0, 100.0, 100.0),
        Size::new(100.0, 400.0),
        host.tab_container_state().scroll_state(),
        ScrollAxis::Vertical,
        ScrollViewStyle::new(ScrollbarStyle::new(
            Color::TRANSPARENT,
            Color::rgb(100, 100, 100),
        )),
    );

    assert_eq!(
        host.tab_container_state()
            .scrollbar_presentation()
            .opacity(),
        0.0
    );
    assert!(
        host.tab_container_scrollbar_pointer_moved(view, Point::new(50.0, 50.0), now)
            .presentation_changed
    );
    assert_eq!(
        host.tab_container_state().scrollbar_presentation().state(),
        ScrollbarState::Hovered
    );
    let mut visible_at = now;
    while let Some(deadline) = host.tab_container_scrollbar_deadline() {
        visible_at = deadline;
        host.advance_tab_container_scrollbar(deadline);
    }
    assert_eq!(
        host.tab_container_state()
            .scrollbar_presentation()
            .opacity(),
        1.0
    );

    let scrollbar = view.vertical_scrollbar().expect("overflowing viewport");
    assert_eq!(scrollbar.track_bounds().right(), view.bounds().right());
    let thumb = scrollbar.thumb_bounds();
    let pointer = Point::new(thumb.origin.x + 1.0, thumb.origin.y + 1.0);
    assert!(
        host.press_tab_container_scrollbar(view, pointer, visible_at)
            .handled
    );
    assert!(
        host.tab_container_scrollbar_pointer_moved(
            view,
            Point::new(pointer.x, scrollbar.track_bounds().bottom() - 1.0),
            visible_at,
        )
        .handled
    );
    assert_eq!(
        host.tab_container_state().scroll_state().vertical_offset(),
        300.0
    );

    host.release_tab_container_scrollbar(view, Point::new(101.0, 50.0), visible_at);
    assert_eq!(
        host.tab_container_state().scrollbar_presentation().state(),
        ScrollbarState::Resting
    );
    while let Some(deadline) = host.tab_container_scrollbar_deadline() {
        host.advance_tab_container_scrollbar(deadline);
    }
    assert_eq!(
        host.tab_container_state()
            .scrollbar_presentation()
            .opacity(),
        0.0
    );
}
