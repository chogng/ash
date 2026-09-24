use ash_icons::Icon;
use ash_icons::icons;
use ash_ui_components::TreeItemExpansion;

/// Selects the semantic icon for one visible file-tree item.
///
/// The tree owns directory expansion state, so branch expansion is the canonical presentation
/// signal for directories while leaf items use the generic file document icon. File-extension
/// matching remains a separate adapter boundary and does not belong to `IconLabel`.
pub(super) const fn icon_for_tree_item(expansion: TreeItemExpansion) -> Icon {
    match expansion {
        TreeItemExpansion::Leaf => icons::FILE_TEXT,
        TreeItemExpansion::Collapsed | TreeItemExpansion::Expanded => icons::FILES,
    }
}

/// Returns the generic file icon used by flat file-search results.
pub(super) const fn icon_for_search_result() -> Icon {
    icons::FILE_TEXT
}

#[cfg(test)]
#[path = "file_icon_tests.rs"]
mod tests;
