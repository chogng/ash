use super::MAX_VIEWPORTS;
use super::Viewports;
use crate::thread::TranscriptCellId;
use crate::thread::transcript::TranscriptScrollAnchor;
use crate::thread::transcript::TranscriptScrollTarget;
use ash_protocol::ThreadId;

fn thread_id(value: &str) -> ThreadId {
    ThreadId::new(value).unwrap()
}

#[test]
fn switching_threads_restores_scroll() {
    let main = thread_id("main");
    let mut store = Viewports::new(main.clone());
    let scroll_anchor = TranscriptScrollAnchor::Cell {
        cell_id: "main-message".into(),
        line_offset: 2,
    };
    store
        .active_mut()
        .scroll
        .apply(TranscriptScrollTarget::Anchor(scroll_anchor.clone()));

    store.switch(thread_id("child"));
    assert_eq!(store.active().scroll.anchor(), None);
    store.switch(main);
    assert_eq!(store.active().scroll.anchor(), Some(&scroll_anchor));
}

#[test]
fn switching_threads_restores_cell_selection_and_expansion_together() {
    let main = thread_id("main");
    let child = thread_id("child");
    let mut store = Viewports::new(main.clone());
    let main_cell = TranscriptCellId::from_render_key("entry:main-entry");
    let child_cell = TranscriptCellId::from_render_key("entry:child-entry");
    assert!(store.active_mut().toggle_cell(&main_cell));

    store.switch(child);
    assert!(store.active().selected_cell.is_none());
    assert!(store.active().expanded_cells.is_empty());
    assert!(
        store
            .active_mut()
            .select_next_cell(std::slice::from_ref(&child_cell))
    );

    store.switch(main);
    assert_eq!(store.active().selected_cell.as_ref(), Some(&main_cell));
    assert!(store.active().expanded_cells.contains(&main_cell));
}

#[test]
fn mode_viewports_evict_the_least_recent_inactive_thread() {
    let first = thread_id("thread-0");
    let retained = thread_id("thread-1");
    let mut store = Viewports::new(first.clone());
    for index in 1..MAX_VIEWPORTS {
        store.switch(thread_id(&format!("thread-{index}")));
    }
    store.switch(retained.clone());
    store.switch(thread_id(&format!("thread-{MAX_VIEWPORTS}")));
    assert_eq!(store.len(), MAX_VIEWPORTS);
    assert!(!store.contains(&first));
    assert!(store.contains(&retained));
}

#[test]
fn removed_messages_release_their_selection_expansion_and_scroll_anchor() {
    let mut viewport = super::Viewport::default();
    let removed = TranscriptCellId::from_render_key("removed");
    let retained = TranscriptCellId::from_render_key("retained");
    viewport.toggle_cell(&retained);
    viewport.toggle_cell(&removed);
    viewport.reconcile(&std::collections::BTreeSet::from([retained.clone()]));
    assert!(viewport.selected_cell.is_none());
    assert!(viewport.scroll.anchor().is_none());
    assert_eq!(
        viewport.expanded_cells,
        std::collections::BTreeSet::from([retained])
    );
}
