//! Workbench Sidebar grouping and selection tests.

use super::SidebarMode;
use super::SidebarPart;
use crate::TabGroupId;
use crate::TabInput;
use crate::TabInputChange;
use crate::TabInputKey;
use crate::TabInputMetadata;
use crate::TabStatus;
use crate::TabStatusKind;
use ash_protocol::{Session, SessionId, SessionStatus};

fn session(id: &str, title: &str) -> Session {
    Session {
        session_id: SessionId::new(id).unwrap(),
        title: title.to_owned(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: Vec::new(),
    }
}

fn input(session: &Session, dir: &str) -> TabInput {
    TabInput::session(
        session.session_id.clone(),
        TabInputMetadata::new(&session.title)
            .with_dirs([dir.into()])
            .with_status(TabStatus::new(TabStatusKind::Idle)),
    )
}

fn upsert_session(part: &mut SidebarPart, session: &Session, dir: &str) -> TabInputChange {
    part.upsert_session_input(input(session, dir))
}

fn upsert_catalog_session(part: &mut SidebarPart, session: &Session, dir: &str) -> TabInputChange {
    part.upsert_catalog_session_input(input(session, dir))
}

#[test]
fn session_upsert_creates_inputs_and_selects_the_newest() {
    let first = session("session-1", "First terminal");
    let second = session("session-2", "Second terminal");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();

    assert_eq!(
        upsert_session(&mut part, &first, "~/first"),
        TabInputChange::Added(first_key)
    );
    assert_eq!(
        upsert_session(&mut part, &second, "~/second"),
        TabInputChange::Added(second_key.clone())
    );
    assert_eq!(part.session_count(), 2);
    assert_eq!(part.active_tab_key(), Some(&second_key));
    let inputs = part.inputs().collect::<Vec<_>>();
    assert_eq!(inputs[0].session_id(), Some(&first.session_id));
    assert_eq!(inputs[1].session_id(), Some(&second.session_id));
    assert!(inputs[2].is_settings());
}

#[test]
fn session_upsert_updates_an_existing_input_without_replacing_its_identity() {
    let first = session("session-1", "First terminal");
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");

    let mut renamed = first.clone();
    renamed.title = "First terminal renamed".to_owned();
    let key = TabInputKey::session(first.session_id.clone());

    assert_eq!(
        upsert_session(&mut part, &renamed, "~/first"),
        TabInputChange::Updated(key.clone())
    );
    assert_eq!(part.session_count(), 1);
    assert_eq!(part.active_tab_key(), Some(&key));
    assert_eq!(part.input(&key).unwrap().title(), "First terminal renamed");
}

#[test]
fn tab_rename_is_a_workbench_label_override_and_survives_session_refresh() {
    let original = session("session-1", "Original title");
    let key = TabInputKey::session(original.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &original, "~/first");

    assert!(part.rename_tab(&key, "Local tab name"));
    let mut refreshed = original.clone();
    refreshed.title = "Server title".to_owned();
    upsert_session(&mut part, &refreshed, "~/first");

    let input = part.input(&key).unwrap();
    assert_eq!(input.title(), "Server title");
    assert_eq!(part.tab_name(input), "Local tab name");
}

#[test]
fn catalog_upsert_does_not_change_the_active_input() {
    let active = session("session-active", "Active");
    let saved = session("session-saved", "Saved");
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &active, "~/ash");
    let active_before_catalog = part.active_tab_key().cloned();

    assert_eq!(
        upsert_catalog_session(&mut part, &saved, "~/ash"),
        TabInputChange::Added(TabInputKey::session(saved.session_id.clone()))
    );
    assert_eq!(part.active_tab_key().cloned(), active_before_catalog);
}

#[test]
fn activation_rejects_unknown_inputs_and_updates_known_inputs() {
    let known = session("session-known", "Known");
    let unknown = SessionId::new("session-unknown").unwrap();
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &known, "~/known");

    assert!(!part.activate_session(&unknown));
    assert_eq!(part.selected_session(), Some(&known.session_id));
    assert!(part.activate_session(&known.session_id));
    assert_eq!(
        part.active_tab_key(),
        Some(&TabInputKey::session(known.session_id.clone()))
    );
}

#[test]
fn pinning_reorders_within_the_group_without_changing_tab_identity() {
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");
    upsert_session(&mut part, &second, "~/second");
    let second_id = part.tab_id(&second_key).unwrap();

    assert_eq!(part.toggle_tab_pin(&second_key), Some(true));

    assert!(part.is_tab_pinned(&second_key));
    assert_eq!(part.tab_id(&second_key), Some(second_id));
    assert_eq!(
        part.inputs()
            .filter(|input| input.is_session())
            .map(TabInput::key)
            .collect::<Vec<_>>(),
        [&second_key, &first_key]
    );

    assert_eq!(part.toggle_tab_pin(&second_key), Some(false));
    assert!(!part.is_tab_pinned(&second_key));
    assert_eq!(part.tab_id(&second_key), Some(second_id));
}

#[test]
fn settings_uses_the_same_pinning_contract_as_other_tabs() {
    let first = session("session-1", "First");
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");

    assert_eq!(part.toggle_tab_pin(&TabInputKey::Settings), Some(true));
    assert!(part.is_tab_pinned(&TabInputKey::Settings));
    assert_eq!(part.inputs().next().unwrap().key(), &TabInputKey::Settings);

    assert_eq!(part.toggle_tab_pin(&TabInputKey::Settings), Some(false));
    assert!(!part.is_tab_pinned(&TabInputKey::Settings));
}

#[test]
fn moving_tabs_to_a_group_preserves_its_pinned_prefix() {
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");
    upsert_session(&mut part, &second, "~/second");
    assert!(part.pin_tab(&second_key));
    let group = part.create_group("Work");

    assert!(part.move_tab_to_group(&first_key, group, 0));
    assert!(part.move_tab_to_group(&second_key, group, usize::MAX));

    assert_eq!(
        part.group(group)
            .unwrap()
            .inputs()
            .iter()
            .map(TabInput::key)
            .collect::<Vec<_>>(),
        [&second_key, &first_key]
    );
}

#[test]
fn settings_is_a_first_class_input_and_preserves_the_last_session() {
    let first = session("session-1", "First");
    let mut part = SidebarPart::default();

    assert_eq!(part.input_count(), 1);
    assert!(part.inputs().next().unwrap().is_settings());
    assert!(part.activate_settings());
    upsert_session(&mut part, &first, "~/first");

    assert!(part.is_settings());
    assert_eq!(part.active_tab_key(), Some(&TabInputKey::Settings));
    assert_eq!(part.selected_session(), Some(&first.session_id));

    assert!(part.activate_last_session());
    assert_eq!(
        part.active_tab_key(),
        Some(&TabInputKey::session(first.session_id.clone()))
    );
    assert!(!part.is_settings());
}

#[test]
fn browser_style_grouping_preserves_global_selection_and_input_identity() {
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");
    upsert_session(&mut part, &second, "~/second");

    let grouped = part
        .group_tabs([first_key.clone(), second_key.clone()], "Terminal work")
        .expect("created browser-style group");

    assert_ne!(grouped, TabGroupId::DEFAULT);
    assert_eq!(part.groups().len(), 2);
    assert_eq!(part.group(grouped).unwrap().label(), Some("Terminal work"));
    assert_eq!(
        part.group(grouped)
            .unwrap()
            .inputs()
            .iter()
            .map(|input| input.key())
            .collect::<Vec<_>>(),
        [&first_key, &second_key]
    );
    assert_eq!(part.active_tab_key(), Some(&second_key));
    assert_eq!(part.input_group(&first_key), Some(grouped));
    assert_eq!(part.input_group(&second_key), Some(grouped));
}

#[test]
fn groups_can_merge_without_changing_the_active_tab() {
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");
    upsert_session(&mut part, &second, "~/second");
    let first_group = part.group_tabs([first_key.clone()], "First group").unwrap();
    let second_group = part
        .group_tabs([second_key.clone()], "Second group")
        .unwrap();

    assert!(part.merge_groups(second_group, first_group));

    assert!(part.group(second_group).is_none());
    assert_eq!(part.input_group(&second_key), Some(first_group));
    assert_eq!(part.active_tab_key(), Some(&second_key));
}

#[test]
fn removing_an_active_session_selects_the_nearest_remaining_tab() {
    let first = session("session-1", "First");
    let second = session("session-2", "Second");
    let third = session("session-3", "Third");
    let first_key = TabInputKey::session(first.session_id.clone());
    let second_key = TabInputKey::session(second.session_id.clone());
    let third_key = TabInputKey::session(third.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &first, "~/first");
    upsert_session(&mut part, &second, "~/second");
    upsert_session(&mut part, &third, "~/third");
    assert!(part.activate_tab(first_key.clone()));

    assert!(part.close_tab(&first_key).is_some());
    assert_eq!(part.active_tab_key(), Some(&second_key));
    assert_eq!(part.selected_session(), Some(&second.session_id));

    assert!(part.close_tab(&second_key).is_some());
    assert_eq!(part.active_tab_key(), Some(&third_key));
    assert_eq!(part.selected_session(), Some(&third.session_id));
}

#[test]
fn settings_can_close_and_reopen_as_the_same_logical_input_type() {
    let only = session("session-1", "Only");
    let key = TabInputKey::session(only.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &only, "~/only");

    assert!(part.close_tab(&key).is_some());
    assert_eq!(part.active_tab_key(), Some(&TabInputKey::Settings));
    assert_eq!(part.selected_session(), None);
    assert_eq!(part.input_count(), 1);
    assert!(part.inputs().next().unwrap().is_settings());
    assert!(part.close_tab(&TabInputKey::Settings).is_some());
    assert_eq!(part.input_count(), 0);
    assert_eq!(part.active_tab_key(), None);

    assert!(part.activate_settings());
    assert_eq!(part.input_count(), 1);
    assert_eq!(part.active_tab_key(), Some(&TabInputKey::Settings));
}

#[test]
fn sidebar_mode_and_named_group_expansion_are_owned_by_the_part() {
    let session = session("session-1", "Grouped");
    let key = TabInputKey::session(session.session_id.clone());
    let mut part = SidebarPart::default();
    upsert_session(&mut part, &session, "~/grouped");
    let group = part.group_tabs([key], "Code").unwrap();

    assert_eq!(part.mode(), SidebarMode::Code);
    assert!(part.set_mode(SidebarMode::Cowork));
    assert_eq!(part.mode(), SidebarMode::Cowork);
    assert!(!part.set_mode(SidebarMode::Cowork));
    assert!(!part.group(group).unwrap().is_collapsed());

    assert!(part.toggle_group(group));
    assert!(part.group(group).unwrap().is_collapsed());
    assert!(part.toggle_group(group));
    assert!(!part.group(group).unwrap().is_collapsed());
    assert!(!part.toggle_group(TabGroupId::DEFAULT));
}
