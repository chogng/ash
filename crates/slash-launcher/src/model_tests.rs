use crate::SlashLauncherItem;
use crate::SlashLauncherList;

fn item(id: &str) -> SlashLauncherItem {
    SlashLauncherItem::new(id, "Commit", "Commit the current changes").unwrap()
}

#[test]
fn list_rejects_duplicate_item_ids_but_not_duplicate_labels() {
    let duplicate =
        SlashLauncherList::new("skills", "Skills", [item("commit"), item("commit")]).unwrap_err();
    assert_eq!(
        duplicate.0,
        "duplicate Slash Launcher item id 'commit' in list 'skills'"
    );

    SlashLauncherList::new("skills", "Skills", [item("first"), item("second")]).unwrap();
}

#[test]
fn model_rejects_blank_presentation_and_unstable_ids() {
    assert_eq!(
        SlashLauncherItem::new("has spaces", "Commit", "")
            .unwrap_err()
            .0,
        "Slash Launcher item id must be a non-empty opaque token"
    );
    assert_eq!(
        SlashLauncherItem::new("commit", "  ", "").unwrap_err().0,
        "Slash Launcher item label must not be blank"
    );
    assert_eq!(
        SlashLauncherList::new("skills", "", []).unwrap_err().0,
        "Slash Launcher list title must not be blank"
    );
}

#[test]
fn keywords_are_search_aliases_and_duplicate_aliases_are_collapsed() {
    let item = item("commit")
        .with_keywords(["git", "version-control", "git"])
        .unwrap();

    assert_eq!(item.keywords(), ["git", "version-control"]);
    assert!(item.matches("GIT"));
    assert!(!item.matches("control"));
}
