//! Stable interaction identities owned by the Session Pane.

use zui::ui::ElementId;

pub const SESSION_HEADER: ElementId = ElementId::scoped(16, 1);
pub const COMPOSER_PANEL: ElementId = ElementId::scoped(16, 2);
pub const COMPOSER: ElementId = ElementId::scoped(16, 3);
pub const CONTEXT_TOOLBAR: ElementId = ElementId::scoped(16, 4);
pub const THREAD_TIMELINE: ElementId = ElementId::scoped(16, 5);
pub const COMPOSER_INTERACTION: ElementId = ElementId::scoped(16, 6);
pub const COMPOSER_KEY_HINT_BAR: ElementId = ElementId::scoped(16, 7);

pub const CONTEXT_LOCATION: ElementId = ElementId::scoped(16, 8);
pub const CONTEXT_WORKING_DIRECTORY: ElementId = ElementId::scoped(16, 9);
pub const CONTEXT_GIT_BRANCH: ElementId = ElementId::scoped(16, 10);
pub const CONTEXT_DIFF: ElementId = ElementId::scoped(16, 11);
const FIRST_COMPOSER_INTERACTION_ITEM: u32 = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextAction {
    Location,
    WorkingDirectory,
    GitBranch,
    Diff,
}

impl ContextAction {
    pub const ALL: [Self; 4] = [
        Self::Location,
        Self::WorkingDirectory,
        Self::GitBranch,
        Self::Diff,
    ];

    pub const fn element_id(self) -> ElementId {
        match self {
            Self::Location => CONTEXT_LOCATION,
            Self::WorkingDirectory => CONTEXT_WORKING_DIRECTORY,
            Self::GitBranch => CONTEXT_GIT_BRANCH,
            Self::Diff => CONTEXT_DIFF,
        }
    }

    pub const fn from_element_id(id: ElementId) -> Option<Self> {
        match id {
            CONTEXT_LOCATION => Some(Self::Location),
            CONTEXT_WORKING_DIRECTORY => Some(Self::WorkingDirectory),
            CONTEXT_GIT_BRANCH => Some(Self::GitBranch),
            CONTEXT_DIFF => Some(Self::Diff),
            _ => None,
        }
    }
}

pub fn composer_interaction_item_id(index: usize) -> ElementId {
    let local = u32::try_from(index)
        .ok()
        .and_then(|index| FIRST_COMPOSER_INTERACTION_ITEM.checked_add(index))
        .expect("composer interaction item index must fit its element scope");
    ElementId::scoped(16, local)
}

pub fn composer_interaction_item_index(
    id: ElementId,
    mut visible_range: Range<usize>,
) -> Option<usize> {
    visible_range.find(|index| composer_interaction_item_id(*index) == id)
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
use std::ops::Range;
