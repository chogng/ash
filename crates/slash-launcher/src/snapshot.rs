use std::collections::BTreeSet;

use crate::SlashLauncherError;
use crate::SlashLauncherItem;
use crate::SlashLauncherList;

/// Owned result of selecting one item from an immutable Slash Launcher snapshot.
///
/// Product adapters dispatch with `list_id` and `item_id`. The remaining fields freeze the visible
/// item so a later list refresh cannot change what the user selected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashLauncherSelection {
    list_id: String,
    list_title: String,
    item: SlashLauncherItem,
}

impl SlashLauncherSelection {
    pub fn list_id(&self) -> &str {
        &self.list_id
    }

    pub fn list_title(&self) -> &str {
        &self.list_title
    }

    pub fn item_id(&self) -> &str {
        self.item.id()
    }

    pub fn item(&self) -> &SlashLauncherItem {
        &self.item
    }
}

/// Immutable composition of the lists selected by one product surface.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SlashLauncherSnapshot {
    lists: Vec<SlashLauncherList>,
}

impl SlashLauncherSnapshot {
    /// Combines product-selected lists while preserving their order.
    ///
    /// List IDs must be unique because the selected `(list_id, item_id)` pair is the dispatch key.
    /// Item labels may overlap both within and across lists.
    pub fn compose(
        lists: impl IntoIterator<Item = SlashLauncherList>,
    ) -> Result<Self, SlashLauncherError> {
        let lists = lists.into_iter().collect::<Vec<_>>();
        let mut list_ids = BTreeSet::new();
        for list in &lists {
            if !list_ids.insert(list.id()) {
                return Err(SlashLauncherError(format!(
                    "duplicate Slash Launcher list id '{}'",
                    list.id()
                )));
            }
        }
        Ok(Self { lists })
    }

    pub fn lists(&self) -> &[SlashLauncherList] {
        &self.lists
    }

    pub fn matching(&self, query: &str) -> Vec<SlashLauncherSelection> {
        self.lists
            .iter()
            .flat_map(|list| {
                list.items()
                    .iter()
                    .filter(|item| item.matches(query))
                    .map(|item| SlashLauncherSelection {
                        list_id: list.id().to_owned(),
                        list_title: list.title().to_owned(),
                        item: item.clone(),
                    })
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
