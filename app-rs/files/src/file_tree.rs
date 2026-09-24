use std::collections::HashMap;
use std::path::PathBuf;

use ash_ui_components::TreeItem;
use ash_ui_components::TreeItemExpansion;
use zui::ui::ElementId;

use super::DirectoryEntry;
use super::DirectoryEntryKind;
use crate::FilesAction;

const FILE_TREE_SCOPE: u32 = 5;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct NodeId(usize);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilesEntry {
    id: NodeId,
    path: PathBuf,
    label: String,
    directory: bool,
    parent: Option<NodeId>,
    expanded: bool,
    children_loaded: bool,
    children: Vec<NodeId>,
}

impl FilesEntry {
    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn element_id(&self) -> ElementId {
        tree_element_id(self.id)
    }
}

#[derive(Clone, Copy)]
pub struct FilesTreeRow<'a> {
    entry: &'a FilesEntry,
}

impl<'a> FilesTreeRow<'a> {
    pub const fn entry(self) -> &'a FilesEntry {
        self.entry
    }
}

#[derive(Default)]
pub(super) struct FilesTree {
    nodes: Vec<FilesEntry>,
    roots: Vec<NodeId>,
    elements: HashMap<ElementId, NodeId>,
    visible_nodes: Vec<NodeId>,
    visible_items: Vec<TreeItem>,
    selected: Option<NodeId>,
}

impl FilesTree {
    pub(super) fn clear(&mut self) {
        self.nodes.clear();
        self.roots.clear();
        self.elements.clear();
        self.visible_nodes.clear();
        self.visible_items.clear();
        self.selected = None;
    }

    pub(super) fn replace_root(&mut self, entries: Vec<DirectoryEntry>) {
        self.clear();
        self.roots = self.allocate(entries_for(PathBuf::new(), entries), None);
        self.rebuild_visible();
    }

    pub(super) fn visible_items(&self) -> &[TreeItem] {
        &self.visible_items
    }

    pub(super) fn visible_len(&self) -> usize {
        self.visible_nodes.len()
    }

    pub(super) fn row(&self, index: usize) -> Option<FilesTreeRow<'_>> {
        let node_id = *self.visible_nodes.get(index)?;
        Some(FilesTreeRow {
            entry: self.nodes.get(node_id.0)?,
        })
    }

    pub(super) fn selected_element(&self) -> Option<ElementId> {
        self.selected.map(tree_element_id)
    }

    pub(super) fn activate(&mut self, element: ElementId) -> Option<FilesAction> {
        let node = self.elements.get(&element).copied()?;
        self.selected = Some(node);
        if !self.nodes[node.0].directory {
            return Some(FilesAction::OpenFile {
                path: self.nodes[node.0].path.clone(),
            });
        }
        if self.nodes[node.0].expanded {
            self.nodes[node.0].expanded = false;
        } else if self.nodes[node.0].children_loaded {
            self.nodes[node.0].expanded = true;
        } else {
            return Some(FilesAction::LoadChildren {
                element,
                path: self.nodes[node.0].path.clone(),
            });
        }
        self.rebuild_visible();
        Some(FilesAction::StateChanged)
    }

    pub(super) fn navigate_right(&mut self, element: ElementId) -> Option<FilesAction> {
        let node = self.elements.get(&element).copied()?;
        if !self.nodes[node.0].directory {
            return Some(FilesAction::Handled);
        }
        if !self.nodes[node.0].expanded {
            if self.nodes[node.0].children_loaded {
                self.nodes[node.0].expanded = true;
                self.rebuild_visible();
                return Some(FilesAction::StateChanged);
            }
            return Some(FilesAction::LoadChildren {
                element,
                path: self.nodes[node.0].path.clone(),
            });
        }
        let Some(child) = self.nodes[node.0].children.first().copied() else {
            return Some(FilesAction::Handled);
        };
        self.selected = Some(child);
        Some(FilesAction::Focus(tree_element_id(child)))
    }

    pub(super) fn navigate_left(&mut self, element: ElementId) -> Option<FilesAction> {
        let node = self.elements.get(&element).copied()?;
        if self.nodes[node.0].directory && self.nodes[node.0].expanded {
            self.nodes[node.0].expanded = false;
            self.rebuild_visible();
            return Some(FilesAction::StateChanged);
        }
        let Some(parent) = self.nodes[node.0].parent else {
            return Some(FilesAction::Handled);
        };
        self.selected = Some(parent);
        Some(FilesAction::Focus(tree_element_id(parent)))
    }

    pub(super) fn complete_directory_load(
        &mut self,
        element: ElementId,
        entries: Vec<DirectoryEntry>,
    ) -> bool {
        let Some(node) = self.elements.get(&element).copied() else {
            return false;
        };
        if !self.nodes[node.0].directory || self.nodes[node.0].children_loaded {
            return false;
        }
        let children = self.allocate(
            entries_for(self.nodes[node.0].path.clone(), entries),
            Some(node),
        );
        let entry = &mut self.nodes[node.0];
        entry.children = children;
        entry.children_loaded = true;
        entry.expanded = true;
        self.rebuild_visible();
        true
    }

    fn allocate(&mut self, entries: Vec<EntrySpec>, parent: Option<NodeId>) -> Vec<NodeId> {
        entries
            .into_iter()
            .filter_map(|entry| {
                let index = self.nodes.len();
                let local = u32::try_from(index).ok()?.checked_add(1)?;
                let id = NodeId(index);
                self.nodes.push(FilesEntry {
                    id,
                    path: entry.path,
                    label: entry.label,
                    directory: entry.directory,
                    parent,
                    expanded: false,
                    children_loaded: false,
                    children: Vec::new(),
                });
                self.elements
                    .insert(ElementId::scoped(FILE_TREE_SCOPE, local), id);
                Some(id)
            })
            .collect()
    }

    fn rebuild_visible(&mut self) {
        let mut nodes = Vec::new();
        let mut items = Vec::new();
        append_visible(&self.nodes, &self.roots, 0, &mut nodes, &mut items);
        self.visible_nodes = nodes;
        self.visible_items = items;
    }
}

fn append_visible(
    nodes: &[FilesEntry],
    ids: &[NodeId],
    depth: usize,
    visible_nodes: &mut Vec<NodeId>,
    visible_items: &mut Vec<TreeItem>,
) {
    for id in ids {
        let Some(node) = nodes.get(id.0) else {
            continue;
        };
        visible_nodes.push(*id);
        visible_items.push(TreeItem::new(
            depth,
            if !node.directory {
                TreeItemExpansion::Leaf
            } else if node.expanded {
                TreeItemExpansion::Expanded
            } else {
                TreeItemExpansion::Collapsed
            },
        ));
        if node.expanded {
            append_visible(
                nodes,
                &node.children,
                depth.saturating_add(1),
                visible_nodes,
                visible_items,
            );
        }
    }
}

struct EntrySpec {
    path: PathBuf,
    label: String,
    directory: bool,
}

fn entries_for(parent: PathBuf, entries: Vec<DirectoryEntry>) -> Vec<EntrySpec> {
    let mut result = entries
        .into_iter()
        .map(|entry| EntrySpec {
            path: parent.join(&entry.name),
            label: entry.name,
            directory: entry.kind == DirectoryEntryKind::Directory,
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| {
        right
            .directory
            .cmp(&left.directory)
            .then_with(|| left.label.cmp(&right.label))
    });
    result
}

fn tree_element_id(id: NodeId) -> ElementId {
    ElementId::scoped(
        FILE_TREE_SCOPE,
        u32::try_from(id.0).unwrap_or(u32::MAX).saturating_add(1),
    )
}

#[cfg(test)]
#[path = "file_tree_tests.rs"]
mod tests;
