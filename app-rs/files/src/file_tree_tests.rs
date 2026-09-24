//! Behavioral tests for the retained file tree.

use super::DirectoryEntry;
use super::FilesTree;
use crate::FilesAction;
use ash_ui_components::TreeItemExpansion;

#[test]
fn directory_activation_loads_once_and_preserves_child_identity() {
    let mut tree = FilesTree::default();
    tree.replace_root(vec![
        DirectoryEntry::file("README.md"),
        DirectoryEntry::directory("src"),
    ]);

    let directory = tree.row(0).unwrap().entry().element_id();
    assert_eq!(
        tree.visible_items()[0].expansion(),
        TreeItemExpansion::Collapsed
    );
    assert_eq!(
        tree.activate(directory),
        Some(FilesAction::LoadChildren {
            element: directory,
            path: "src".into()
        })
    );
    assert_eq!(tree.selected_element(), Some(directory));

    assert!(tree.complete_directory_load(directory, vec![DirectoryEntry::file("lib.rs")]));
    let child = tree.row(1).unwrap().entry().element_id();
    assert_eq!(tree.activate(directory), Some(FilesAction::StateChanged));
    assert_eq!(tree.activate(directory), Some(FilesAction::StateChanged));
    assert_eq!(tree.row(1).unwrap().entry().element_id(), child);
    assert_eq!(
        tree.navigate_right(directory),
        Some(FilesAction::Focus(child))
    );
    assert_eq!(tree.selected_element(), Some(child));
}

#[test]
fn files_are_opened_without_an_unnecessary_directory_load() {
    let mut tree = FilesTree::default();
    tree.replace_root(vec![DirectoryEntry::file("alpha.txt")]);

    let file = tree.row(0).unwrap().entry().element_id();
    assert_eq!(
        tree.activate(file),
        Some(FilesAction::OpenFile {
            path: "alpha.txt".into()
        })
    );
    assert_eq!(tree.selected_element(), Some(file));
}
