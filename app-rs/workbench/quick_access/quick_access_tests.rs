use zui::ui::TextInputCommand;

use super::QuickAccess;

#[test]
fn shortcut_lifecycle_owns_and_clears_its_query() {
    let mut quick_access = QuickAccess::default();

    quick_access.open_shortcuts();
    quick_access.apply_query(TextInputCommand::Insert("copy".to_owned()));
    assert!(quick_access.shortcuts_open());
    assert_eq!(quick_access.query_input().text(), "copy");

    quick_access.close();
    assert!(!quick_access.shortcuts_open());
    assert!(quick_access.query_input().text().is_empty());
}
