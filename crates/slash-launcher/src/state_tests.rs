use crate::SlashLauncherItem;
use crate::SlashLauncherList;
use crate::SlashLauncherSnapshot;
use crate::SlashLauncherState;

fn snapshot(items: &[(&str, &str)]) -> SlashLauncherSnapshot {
    let list = SlashLauncherList::new(
        "skills",
        "Skills",
        items.iter().map(|(id, label)| {
            SlashLauncherItem::new(*id, *label, format!("Run {label}")).unwrap()
        }),
    )
    .unwrap();
    SlashLauncherSnapshot::compose([list]).unwrap()
}

#[test]
fn state_filters_selects_wraps_and_dismisses() {
    let mut state = SlashLauncherState::new(snapshot(&[
        ("commit", "Commit"),
        ("compare", "Compare"),
        ("review", "Review"),
    ]));
    state.sync_input("/com", 4);

    assert_eq!(state.view().unwrap().items.len(), 2);
    assert_eq!(state.selected_item().unwrap().item_id(), "commit");
    state.select_previous();
    assert_eq!(state.selected_item().unwrap().item_id(), "compare");
    state.select_next();
    assert_eq!(state.selected_item().unwrap().item_id(), "commit");

    state.dismiss();
    assert!(state.view().is_none());
    state.sync_input("/comp", 5);
    assert_eq!(state.selected_item().unwrap().item_id(), "compare");
}

#[test]
fn selected_value_is_frozen_across_later_snapshot_refreshes() {
    let mut state = SlashLauncherState::new(snapshot(&[("commit:v1", "Commit")]));
    state.sync_input("/com", 4);
    let selected = state.selected_item().unwrap().clone();

    state.set_snapshot(snapshot(&[("commit:v2", "Commit version two")]));

    assert_eq!(selected.item_id(), "commit:v1");
    assert_eq!(selected.item().label(), "Commit");
    assert_eq!(state.selected_item().unwrap().item_id(), "commit:v2");
}

#[test]
fn snapshot_refresh_preserves_the_selected_stable_key_when_it_still_exists() {
    let mut state =
        SlashLauncherState::new(snapshot(&[("commit", "Commit"), ("compare", "Compare")]));
    state.sync_input("/com", 4);
    state.select_next();
    assert_eq!(state.selected_item().unwrap().item_id(), "compare");

    state.set_snapshot(snapshot(&[
        ("compose", "Compose"),
        ("commit", "Commit"),
        ("compare", "Compare"),
    ]));

    assert_eq!(state.selected_item().unwrap().item_id(), "compare");
}

#[test]
fn leaving_the_first_token_closes_and_clears_the_launcher() {
    let mut state = SlashLauncherState::new(snapshot(&[("commit", "Commit")]));
    state.sync_input("/", 1);
    assert!(state.view().is_some());

    state.sync_input("/commit now", 11);
    assert!(state.view().is_none());
    assert!(state.selected_item().is_none());
}
