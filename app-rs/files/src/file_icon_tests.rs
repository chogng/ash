use super::icon_for_search_result;
use super::icon_for_tree_item;
use ash_icons::icons;
use ash_ui_components::TreeItemExpansion;

#[test]
fn tree_items_use_file_text_for_leaves_and_files_for_branches() {
    assert_eq!(
        icon_for_tree_item(TreeItemExpansion::Leaf),
        icons::FILE_TEXT
    );
    assert_eq!(
        icon_for_tree_item(TreeItemExpansion::Collapsed),
        icons::FILES
    );
    assert_eq!(
        icon_for_tree_item(TreeItemExpansion::Expanded),
        icons::FILES
    );
}

#[test]
fn search_results_use_the_generic_file_icon() {
    assert_eq!(icon_for_search_result(), icons::FILE_TEXT);
}
