use std::ops::Range;
use std::sync::Arc;

const EXTENTS_PER_LEAF: usize = 128;

/// Copy-on-write balanced sequence for variable item extents.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct VariableExtentTree {
    root: Option<Arc<ExtentNode>>,
}

impl VariableExtentTree {
    pub(super) fn new(item_extents: Vec<f32>) -> Self {
        let mut total_extent = 0.0;
        for &extent in &item_extents {
            total_extent += extent;
            assert!(
                total_extent.is_finite(),
                "Variable list cumulative extent must be finite"
            );
        }
        Self {
            root: build_extent_tree(item_extents),
        }
    }

    pub(super) fn item_count(&self) -> usize {
        self.root.as_deref().map_or(0, ExtentNode::item_count)
    }

    pub(super) fn item_extent(&self, index: usize) -> Option<f32> {
        self.root.as_deref()?.item_extent(index)
    }

    pub(super) fn extent_before(&self, index: usize) -> f32 {
        self.root
            .as_deref()
            .map_or(0.0, |root| root.extent_before(index))
    }

    pub(super) fn total_extent(&self) -> f32 {
        self.root.as_deref().map_or(0.0, ExtentNode::total_extent)
    }

    pub(super) fn extents(&self) -> Vec<f32> {
        let mut extents = Vec::with_capacity(self.item_count());
        if let Some(root) = &self.root {
            root.append_extents(&mut extents);
        }
        extents
    }

    pub(super) fn update(&mut self, index: usize, item_extent: f32) {
        let previous = self
            .item_extent(index)
            .expect("variable list item extent update index");
        let total = self.total_extent() + item_extent - previous;
        assert!(
            total.is_finite(),
            "Variable list cumulative extent must be finite"
        );
        let root = self.root.take().expect("variable list extent tree");
        self.root = Some(update_extent(root, index, item_extent));
    }

    pub(super) fn splice(&mut self, range: Range<usize>, replacements: Vec<f32>) {
        let root = self.root.take();
        let (before, rest) = split_extent_tree(root, range.start);
        let (_, after) = split_extent_tree(rest, range.end - range.start);
        self.root = concat_extent_trees(
            concat_extent_trees(before, build_extent_tree(replacements)),
            after,
        );
    }

    pub(super) fn prefix_count_at_most(&self, extent: f32, item_gap: f32) -> usize {
        if extent < 0.0 {
            return 0;
        }
        self.root
            .as_deref()
            .map_or(0, |root| root.prefix_count_at_most(extent, item_gap))
    }

    pub(super) fn first_prefix_at_or_after(&self, extent: f32, item_gap: f32) -> usize {
        self.root
            .as_deref()
            .map_or(0, |root| root.first_prefix_at_or_after(extent, item_gap))
    }
}

#[derive(Clone, Debug, PartialEq)]
enum ExtentNode {
    Leaf {
        extents: Arc<[f32]>,
        total_extent: f32,
    },
    Branch {
        left: Arc<Self>,
        right: Arc<Self>,
        item_count: usize,
        total_extent: f32,
        height: u8,
    },
}

impl ExtentNode {
    fn leaf(extents: Vec<f32>) -> Arc<Self> {
        assert!(!extents.is_empty(), "Extent leaves must not be empty");
        let total_extent: f32 = extents.iter().sum();
        assert!(
            total_extent.is_finite(),
            "Variable list cumulative extent must be finite"
        );
        Arc::new(Self::Leaf {
            extents: extents.into(),
            total_extent,
        })
    }

    fn branch(left: Arc<Self>, right: Arc<Self>) -> Arc<Self> {
        debug_assert!(left.height().abs_diff(right.height()) <= 1);
        let total_extent = left.total_extent() + right.total_extent();
        assert!(
            total_extent.is_finite(),
            "Variable list cumulative extent must be finite"
        );
        Arc::new(Self::Branch {
            item_count: left.item_count() + right.item_count(),
            total_extent,
            height: left.height().max(right.height()) + 1,
            left,
            right,
        })
    }

    fn item_count(&self) -> usize {
        match self {
            Self::Leaf { extents, .. } => extents.len(),
            Self::Branch { item_count, .. } => *item_count,
        }
    }

    fn total_extent(&self) -> f32 {
        match self {
            Self::Leaf { total_extent, .. } | Self::Branch { total_extent, .. } => *total_extent,
        }
    }

    fn height(&self) -> u8 {
        match self {
            Self::Leaf { .. } => 1,
            Self::Branch { height, .. } => *height,
        }
    }

    fn item_extent(&self, index: usize) -> Option<f32> {
        if index >= self.item_count() {
            return None;
        }
        match self {
            Self::Leaf { extents, .. } => extents.get(index).copied(),
            Self::Branch { left, right, .. } => {
                let left_count = left.item_count();
                if index < left_count {
                    left.item_extent(index)
                } else {
                    right.item_extent(index - left_count)
                }
            }
        }
    }

    fn append_extents(&self, result: &mut Vec<f32>) {
        match self {
            Self::Leaf { extents, .. } => result.extend_from_slice(extents),
            Self::Branch { left, right, .. } => {
                left.append_extents(result);
                right.append_extents(result);
            }
        }
    }

    fn extent_before(&self, index: usize) -> f32 {
        debug_assert!(index <= self.item_count());
        match self {
            Self::Leaf { extents, .. } => extents[..index].iter().sum(),
            Self::Branch { left, right, .. } => {
                let left_count = left.item_count();
                if index <= left_count {
                    left.extent_before(index)
                } else {
                    left.total_extent() + right.extent_before(index - left_count)
                }
            }
        }
    }

    fn prefix_count_at_most(&self, extent: f32, item_gap: f32) -> usize {
        match self {
            Self::Leaf { extents, .. } => {
                let mut total = 0.0;
                extents
                    .iter()
                    .take_while(|item_extent| {
                        total += **item_extent + item_gap;
                        total <= extent
                    })
                    .count()
            }
            Self::Branch { left, right, .. } => {
                let left_extent = left.total_extent() + left.item_count() as f32 * item_gap;
                if left_extent > extent {
                    left.prefix_count_at_most(extent, item_gap)
                } else {
                    left.item_count() + right.prefix_count_at_most(extent - left_extent, item_gap)
                }
            }
        }
    }

    fn first_prefix_at_or_after(&self, extent: f32, item_gap: f32) -> usize {
        if extent <= 0.0 {
            return 0;
        }
        match self {
            Self::Leaf { extents, .. } => {
                let mut total = 0.0;
                for (index, item_extent) in extents.iter().enumerate() {
                    total += item_extent + item_gap;
                    if total >= extent {
                        return index + 1;
                    }
                }
                extents.len()
            }
            Self::Branch { left, right, .. } => {
                let left_extent = left.total_extent() + left.item_count() as f32 * item_gap;
                if left_extent >= extent {
                    left.first_prefix_at_or_after(extent, item_gap)
                } else {
                    left.item_count()
                        + right.first_prefix_at_or_after(extent - left_extent, item_gap)
                }
            }
        }
    }
}

fn build_extent_tree(extents: Vec<f32>) -> Option<Arc<ExtentNode>> {
    let leaves = extents
        .chunks(EXTENTS_PER_LEAF)
        .map(|chunk| ExtentNode::leaf(chunk.to_vec()))
        .collect::<Vec<_>>();
    build_extent_tree_from_leaves(&leaves)
}

fn build_extent_tree_from_leaves(leaves: &[Arc<ExtentNode>]) -> Option<Arc<ExtentNode>> {
    match leaves {
        [] => None,
        [leaf] => Some(Arc::clone(leaf)),
        _ => {
            let middle = leaves.len() / 2;
            let left = build_extent_tree_from_leaves(&leaves[..middle])
                .expect("non-empty left extent-tree leaves");
            let right = build_extent_tree_from_leaves(&leaves[middle..])
                .expect("non-empty right extent-tree leaves");
            Some(ExtentNode::branch(left, right))
        }
    }
}

fn update_extent(node: Arc<ExtentNode>, index: usize, extent: f32) -> Arc<ExtentNode> {
    match node.as_ref() {
        ExtentNode::Leaf { extents, .. } => {
            let mut updated = extents.to_vec();
            updated[index] = extent;
            ExtentNode::leaf(updated)
        }
        ExtentNode::Branch { left, right, .. } => {
            let left_count = left.item_count();
            if index < left_count {
                ExtentNode::branch(
                    update_extent(Arc::clone(left), index, extent),
                    Arc::clone(right),
                )
            } else {
                ExtentNode::branch(
                    Arc::clone(left),
                    update_extent(Arc::clone(right), index - left_count, extent),
                )
            }
        }
    }
}

fn split_extent_tree(
    node: Option<Arc<ExtentNode>>,
    index: usize,
) -> (Option<Arc<ExtentNode>>, Option<Arc<ExtentNode>>) {
    let Some(node) = node else {
        debug_assert_eq!(index, 0);
        return (None, None);
    };
    if index == 0 {
        return (None, Some(node));
    }
    if index == node.item_count() {
        return (Some(node), None);
    }
    match node.as_ref() {
        ExtentNode::Leaf { extents, .. } => (
            Some(ExtentNode::leaf(extents[..index].to_vec())),
            Some(ExtentNode::leaf(extents[index..].to_vec())),
        ),
        ExtentNode::Branch { left, right, .. } => {
            let left_count = left.item_count();
            if index < left_count {
                let (before, left_rest) = split_extent_tree(Some(Arc::clone(left)), index);
                (
                    before,
                    concat_extent_trees(left_rest, Some(Arc::clone(right))),
                )
            } else if index == left_count {
                (Some(Arc::clone(left)), Some(Arc::clone(right)))
            } else {
                let (right_before, after) =
                    split_extent_tree(Some(Arc::clone(right)), index - left_count);
                (
                    concat_extent_trees(Some(Arc::clone(left)), right_before),
                    after,
                )
            }
        }
    }
}

fn concat_extent_trees(
    left: Option<Arc<ExtentNode>>,
    right: Option<Arc<ExtentNode>>,
) -> Option<Arc<ExtentNode>> {
    let (left, right) = match (left, right) {
        (None, right) => return right,
        (left, None) => return left,
        (Some(left), Some(right)) => (left, right),
    };
    if let (
        ExtentNode::Leaf {
            extents: left_extents,
            ..
        },
        ExtentNode::Leaf {
            extents: right_extents,
            ..
        },
    ) = (left.as_ref(), right.as_ref())
    {
        if left_extents.len() + right_extents.len() <= EXTENTS_PER_LEAF {
            let mut extents = Vec::with_capacity(left_extents.len() + right_extents.len());
            extents.extend_from_slice(left_extents);
            extents.extend_from_slice(right_extents);
            return Some(ExtentNode::leaf(extents));
        }
    }
    Some(join_extent_nodes(left, right))
}

fn join_extent_nodes(left: Arc<ExtentNode>, right: Arc<ExtentNode>) -> Arc<ExtentNode> {
    if left.height() > right.height() + 1 {
        let ExtentNode::Branch {
            left: outer,
            right: inner,
            ..
        } = left.as_ref()
        else {
            unreachable!("an unbalanced left extent tree must be a branch");
        };
        let joined = join_extent_nodes(Arc::clone(inner), right);
        return balance_extent_nodes(Arc::clone(outer), joined);
    }
    if right.height() > left.height() + 1 {
        let ExtentNode::Branch {
            left: inner,
            right: outer,
            ..
        } = right.as_ref()
        else {
            unreachable!("an unbalanced right extent tree must be a branch");
        };
        let joined = join_extent_nodes(left, Arc::clone(inner));
        return balance_extent_nodes(joined, Arc::clone(outer));
    }
    ExtentNode::branch(left, right)
}

fn balance_extent_nodes(left: Arc<ExtentNode>, right: Arc<ExtentNode>) -> Arc<ExtentNode> {
    if left.height() > right.height() + 1 {
        let ExtentNode::Branch {
            left: outer,
            right: inner,
            ..
        } = left.as_ref()
        else {
            unreachable!("an unbalanced left extent node must be a branch");
        };
        if outer.height() >= inner.height() {
            return ExtentNode::branch(
                Arc::clone(outer),
                ExtentNode::branch(Arc::clone(inner), right),
            );
        }
        let ExtentNode::Branch {
            left: inner_left,
            right: inner_right,
            ..
        } = inner.as_ref()
        else {
            unreachable!("a double left rotation requires an inner branch");
        };
        return ExtentNode::branch(
            ExtentNode::branch(Arc::clone(outer), Arc::clone(inner_left)),
            ExtentNode::branch(Arc::clone(inner_right), right),
        );
    }
    if right.height() > left.height() + 1 {
        let ExtentNode::Branch {
            left: inner,
            right: outer,
            ..
        } = right.as_ref()
        else {
            unreachable!("an unbalanced right extent node must be a branch");
        };
        if outer.height() >= inner.height() {
            return ExtentNode::branch(
                ExtentNode::branch(left, Arc::clone(inner)),
                Arc::clone(outer),
            );
        }
        let ExtentNode::Branch {
            left: inner_left,
            right: inner_right,
            ..
        } = inner.as_ref()
        else {
            unreachable!("a double right rotation requires an inner branch");
        };
        return ExtentNode::branch(
            ExtentNode::branch(left, Arc::clone(inner_left)),
            ExtentNode::branch(Arc::clone(inner_right), Arc::clone(outer)),
        );
    }
    ExtentNode::branch(left, right)
}
