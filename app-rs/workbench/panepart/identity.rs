use zui::ui::ElementId;

use crate::PaneGroupId;
use crate::PaneSplitId;

const PANE_PART_SCOPE: u32 = 15;
const FIRST_PANE_GROUP: u32 = 100;
const FIRST_PANE_SASH: u32 = 1;

/// Returns the stable interaction identity for one visible pane group.
pub fn pane_group_element_id(pane: PaneGroupId) -> ElementId {
    let local = u32::try_from(pane.value())
        .ok()
        .and_then(|value| FIRST_PANE_GROUP.checked_add(value))
        .expect("pane group identity must fit its element scope");
    ElementId::scoped(PANE_PART_SCOPE, local)
}

/// Returns the stable interaction identity for one pane split sash.
pub fn pane_sash_element_id(split: PaneSplitId) -> ElementId {
    let local = u32::try_from(split.value())
        .ok()
        .and_then(|value| FIRST_PANE_SASH.checked_add(value))
        .expect("pane split identity must fit its element scope");
    ElementId::scoped(PANE_PART_SCOPE, local)
}
