use crate::SlashLauncherItem;
use crate::SlashLauncherList;
use crate::SlashLauncherSnapshot;

fn item(id: &str, label: &str) -> SlashLauncherItem {
    SlashLauncherItem::new(id, label, format!("Run {label}")).unwrap()
}

fn list(id: &str, title: &str, items: &[(&str, &str)]) -> SlashLauncherList {
    SlashLauncherList::new(
        id,
        title,
        items.iter().map(|(item_id, label)| item(item_id, label)),
    )
    .unwrap()
}

#[test]
fn snapshot_composes_only_the_lists_selected_by_the_product() {
    let snapshot = SlashLauncherSnapshot::compose([
        list(
            "slash-commands",
            "Commands",
            &[("status", "Status"), ("commit", "Commit")],
        ),
        list(
            "skills",
            "Skills",
            &[("builtin:commit", "Commit"), ("review", "Review")],
        ),
    ])
    .unwrap();

    let matches = snapshot.matching("com");
    assert_eq!(
        matches
            .iter()
            .map(|selection| (selection.list_id(), selection.item_id()))
            .collect::<Vec<_>>(),
        vec![("slash-commands", "commit"), ("skills", "builtin:commit")]
    );
}

#[test]
fn snapshot_rejects_duplicate_list_ids() {
    let error = SlashLauncherSnapshot::compose([
        list("skills", "Workspace Skills", &[]),
        list("skills", "Personal Skills", &[]),
    ])
    .unwrap_err();

    assert_eq!(error.0, "duplicate Slash Launcher list id 'skills'");
}

#[test]
fn matching_preserves_list_and_item_order() {
    let snapshot = SlashLauncherSnapshot::compose([
        list("commands", "Commands", &[("one", "One"), ("only", "Only")]),
        list("actions", "Actions", &[("open", "Open")]),
    ])
    .unwrap();

    assert_eq!(
        snapshot
            .matching("o")
            .iter()
            .map(|selection| selection.item_id())
            .collect::<Vec<_>>(),
        vec!["one", "only", "open"]
    );
}
