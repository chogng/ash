//! Pane container ownership tests.

use super::PaneContainer;
use crate::PaneInput;
use crate::PaneInputKind;
use crate::PaneSplitDirection;
use ash_protocol::SessionId;

#[test]
fn container_owns_multiple_groups_and_each_group_owns_multiple_panes() {
    let mut container = PaneContainer::new();
    let root = container.pane_part().root_group();
    container
        .pane_part_mut()
        .open_input(root, PaneInput::settings());
    container
        .pane_part_mut()
        .open_input(root, PaneInput::files("/dir".into()));
    let (second_group, _) = container.pane_part_mut().split_active_with_input(
        PaneSplitDirection::Horizontal,
        Some(PaneInput::terminal(
            SessionId::new("session-1").expect("valid session ID"),
        )),
    );

    assert_eq!(container.pane_part().group_ids(), vec![root, second_group]);
    assert_eq!(
        container
            .pane_part()
            .group(root)
            .expect("root group")
            .inputs()
            .map(PaneInput::kind)
            .collect::<Vec<_>>(),
        vec![PaneInputKind::Settings, PaneInputKind::Files]
    );
    assert_eq!(
        container
            .pane_part()
            .group(second_group)
            .and_then(|group| group.active_input())
            .map(PaneInput::kind),
        Some(PaneInputKind::Terminal)
    );
}
