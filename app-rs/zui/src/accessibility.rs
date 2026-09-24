use std::collections::HashMap;
use std::collections::HashSet;

use accesskit::Action;
use accesskit::ActionRequest;
use accesskit::Node;
use accesskit::NodeId;
use accesskit::Rect;
use accesskit::Role;
use accesskit::Tree;
use accesskit::TreeId;
use accesskit::TreeUpdate;

use crate::internal::ActiveEventLoop;
use crate::internal::NativeWindowEvent;
pub use crate::runtime::AccessibilityNode;
pub use crate::ui::foundation::AccessibilityExpansion;
pub use crate::ui::foundation::AccessibilityRole;
pub use crate::ui::foundation::AccessibilitySelection;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::NodeAction;
use crate::window::NativeWindow;
use crate::window::WindowId;

use crate::app::AppProxy;

/// Product-facing accessibility operation requested by assistive technology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccessibilityAction {
    window: WindowId,
    target: ElementId,
    kind: AccessibilityActionKind,
}

impl AccessibilityAction {
    /// Returns the window that owns the target element.
    pub const fn window(self) -> WindowId {
        self.window
    }

    /// Returns the stable UI element targeted by the request.
    pub const fn target(self) -> ElementId {
        self.target
    }

    /// Returns the backend-neutral requested operation.
    pub const fn kind(self) -> AccessibilityActionKind {
        self.kind
    }
}

/// Accessibility operations advertised by the current ZUI interaction model.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessibilityActionKind {
    Focus,
    Activate,
}

pub(crate) struct AccessibilityBridge {
    adapter: accesskit_platform::Adapter,
    snapshot: AccessibilitySnapshot,
}

impl AccessibilityBridge {
    pub(crate) fn new<T: Send + 'static>(
        event_loop: &ActiveEventLoop,
        window: &NativeWindow,
        proxy: &AppProxy<T>,
        title: String,
        scale_factor: f64,
    ) -> Self {
        let adapter = accesskit_platform::Adapter::with_event_loop_proxy(
            event_loop,
            window.accessibility_window(),
            proxy.inner.native(),
        );
        Self {
            adapter,
            snapshot: AccessibilitySnapshot::with_scale_factor(title, Vec::new(), scale_factor),
        }
    }

    pub(crate) fn process_window_event(
        &mut self,
        window: &NativeWindow,
        event: &NativeWindowEvent,
    ) {
        self.adapter
            .process_event(window.accessibility_window(), event);
    }

    pub(crate) fn update(&mut self, nodes: &[AccessibilityNode], scale_factor: f64) {
        self.snapshot = AccessibilitySnapshot::with_scale_factor(
            self.snapshot.title.clone(),
            nodes.to_vec(),
            scale_factor,
        );
        let update = self.snapshot.full_update();
        self.adapter.update_if_active(move || update);
    }

    pub(crate) fn handle_event(
        &mut self,
        window: WindowId,
        event: accesskit_platform::WindowEvent,
    ) -> Option<AccessibilityAction> {
        match event {
            accesskit_platform::WindowEvent::InitialTreeRequested => {
                let update = self.snapshot.full_update();
                self.adapter.update_if_active(move || update);
                None
            }
            accesskit_platform::WindowEvent::ActionRequested(request) => {
                requested_action(window, request, &self.snapshot)
            }
            accesskit_platform::WindowEvent::AccessibilityDeactivated => None,
        }
    }
}

#[derive(Clone)]
struct AccessibilitySnapshot {
    title: String,
    nodes: Vec<AccessibilityNode>,
    root: NodeId,
    scale_factor: f64,
}

impl AccessibilitySnapshot {
    fn with_scale_factor(title: String, nodes: Vec<AccessibilityNode>, scale_factor: f64) -> Self {
        let occupied = nodes
            .iter()
            .map(|node| node.id.into_raw())
            .collect::<HashSet<_>>();
        let root = (0..=u64::MAX)
            .rev()
            .find(|candidate| !occupied.contains(candidate))
            .map(NodeId)
            .expect("a finite accessibility snapshot always leaves a synthetic root identity");
        Self {
            title,
            nodes,
            root,
            scale_factor: valid_scale_factor(scale_factor),
        }
    }

    fn full_update(&self) -> TreeUpdate {
        let ids = self
            .nodes
            .iter()
            .map(|node| node.id)
            .collect::<HashSet<_>>();
        let mut children = HashMap::<ElementId, Vec<NodeId>>::new();
        let mut root_children = Vec::new();
        for node in &self.nodes {
            let id = NodeId(node.id.into_raw());
            match node.parent.filter(|parent| ids.contains(parent)) {
                Some(parent) => children.entry(parent).or_default().push(id),
                None => root_children.push(id),
            }
        }

        let mut root = Node::new(Role::Window);
        root.set_label(self.title.clone());
        root.set_children(root_children);
        let mut nodes = Vec::with_capacity(self.nodes.len() + 1);
        nodes.push((self.root, root));
        nodes.extend(self.nodes.iter().map(|source| {
            let mut node = Node::new(map_role(source.role));
            node.set_label(source.label.clone());
            if let Some(value) = &source.value {
                node.set_value(value.clone());
            }
            node.set_bounds(Rect {
                x0: f64::from(source.bounds.origin.x) * self.scale_factor,
                y0: f64::from(source.bounds.origin.y) * self.scale_factor,
                x1: f64::from(source.bounds.right()) * self.scale_factor,
                y1: f64::from(source.bounds.bottom()) * self.scale_factor,
            });
            node.set_children(children.remove(&source.id).unwrap_or_default());
            if source.focusable {
                node.add_action(Action::Focus);
            }
            if matches!(
                source.action,
                NodeAction::Activate | NodeAction::ToggleExpansion | NodeAction::AdjustValue { .. }
            ) {
                node.add_action(Action::Click);
            }
            match source.selection {
                AccessibilitySelection::Selected => node.set_selected(true),
                AccessibilitySelection::Unselected => node.set_selected(false),
                AccessibilitySelection::NotApplicable => {}
            }
            if let Some(level) = source.level {
                node.set_level(level);
            }
            match source.expansion {
                AccessibilityExpansion::Collapsed => node.set_expanded(false),
                AccessibilityExpansion::Expanded => node.set_expanded(true),
                AccessibilityExpansion::NotApplicable => {}
            }
            (NodeId(source.id.into_raw()), node)
        }));
        let focus = self
            .nodes
            .iter()
            .find(|node| node.focused)
            .map(|node| NodeId(node.id.into_raw()))
            .unwrap_or(self.root);
        let mut tree = Tree::new(self.root);
        tree.toolkit_name = Some("ZUI".to_owned());
        tree.toolkit_version = Some(env!("CARGO_PKG_VERSION").to_owned());
        TreeUpdate {
            nodes,
            tree: Some(tree),
            tree_id: TreeId::ROOT,
            focus,
        }
    }
}

fn requested_action(
    window: WindowId,
    request: ActionRequest,
    snapshot: &AccessibilitySnapshot,
) -> Option<AccessibilityAction> {
    if request.target_tree != TreeId::ROOT {
        return None;
    }
    let node = snapshot
        .nodes
        .iter()
        .find(|node| node.id.into_raw() == request.target_node.0)?;
    let kind = match request.action {
        Action::Focus if node.focusable => AccessibilityActionKind::Focus,
        Action::Click
            if matches!(
                node.action,
                NodeAction::Activate | NodeAction::ToggleExpansion | NodeAction::AdjustValue { .. }
            ) =>
        {
            AccessibilityActionKind::Activate
        }
        _ => return None,
    };
    Some(AccessibilityAction {
        window,
        target: ElementId::from_raw(request.target_node.0),
        kind,
    })
}

fn valid_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

const fn map_role(role: AccessibilityRole) -> Role {
    match role {
        AccessibilityRole::Window => Role::Window,
        AccessibilityRole::Group => Role::Group,
        AccessibilityRole::Separator => Role::Splitter,
        AccessibilityRole::Toolbar => Role::Toolbar,
        AccessibilityRole::Button => Role::Button,
        AccessibilityRole::TextInput => Role::TextInput,
        AccessibilityRole::Terminal => Role::Terminal,
        AccessibilityRole::List => Role::List,
        AccessibilityRole::ListItem => Role::ListItem,
        AccessibilityRole::Tree => Role::Tree,
        AccessibilityRole::TreeItem => Role::TreeItem,
        AccessibilityRole::RadioGroup => Role::RadioGroup,
        AccessibilityRole::RadioButton => Role::RadioButton,
        AccessibilityRole::ScrollBar => Role::ScrollBar,
        AccessibilityRole::Menu => Role::Menu,
        AccessibilityRole::MenuItem => Role::MenuItem,
    }
}

#[cfg(test)]
#[path = "accessibility/tests.rs"]
mod tests;
