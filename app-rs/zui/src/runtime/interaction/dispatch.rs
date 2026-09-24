use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::ui::foundation::Point;

use super::CursorFeedback;
use super::DispatchInvalidation;
use super::ElementId;
use super::FocusBehavior;
use super::InteractionFrame;
use super::NavigationAxis;
use super::NodeAction;
use super::UiIntent;

#[path = "dispatch_activation.rs"]
mod activation;
#[path = "dispatch_expansion.rs"]
mod expansion;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DispatchOutcome {
    pub invalidation: DispatchInvalidation,
    pub intent: Option<UiIntent>,
    /// Stable element ID whose retained fragment may be replaced for fragment invalidation.
    pub fragment: Option<ElementId>,
}

impl DispatchOutcome {
    const fn paint() -> Self {
        Self {
            invalidation: DispatchInvalidation::Paint,
            intent: None,
            fragment: None,
        }
    }

    const fn invalidation(invalidation: DispatchInvalidation) -> Self {
        Self {
            invalidation,
            intent: None,
            fragment: None,
        }
    }

    fn for_fragment(invalidation: DispatchInvalidation, fragment: Option<ElementId>) -> Self {
        fragment.map_or_else(
            || Self::invalidation(invalidation),
            |id| Self::invalidation_for(id, invalidation),
        )
    }

    const fn invalidation_for(id: ElementId, invalidation: DispatchInvalidation) -> Self {
        Self {
            invalidation,
            intent: None,
            fragment: match invalidation {
                DispatchInvalidation::Fragment => Some(id),
                DispatchInvalidation::None | DispatchInvalidation::Paint => None,
            },
        }
    }

    const fn with_intent(intent: UiIntent, invalidation: DispatchInvalidation) -> Self {
        Self {
            invalidation,
            fragment: match invalidation {
                DispatchInvalidation::Fragment => Some(intent.element_id()),
                DispatchInvalidation::None | DispatchInvalidation::Paint => None,
            },
            intent: Some(intent),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FocusDirection {
    Previous,
    Next,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UiDispatch {
    hovered_path: Vec<ElementId>,
    hovered_invalidation: DispatchInvalidation,
    hovered_fragment: Option<ElementId>,
    pressed: Option<ElementId>,
    pressed_invalidation: DispatchInvalidation,
    captured: Option<ElementId>,
    focused: Option<ElementId>,
    expanded: BTreeSet<ElementId>,
    values: BTreeMap<ElementId, i32>,
    window_active: bool,
}

impl Default for UiDispatch {
    fn default() -> Self {
        Self {
            hovered_path: Vec::new(),
            hovered_invalidation: DispatchInvalidation::None,
            hovered_fragment: None,
            pressed: None,
            pressed_invalidation: DispatchInvalidation::None,
            captured: None,
            focused: None,
            expanded: BTreeSet::new(),
            values: BTreeMap::new(),
            window_active: true,
        }
    }
}

impl UiDispatch {
    pub fn pointer_moved(&mut self, point: Point, frame: &InteractionFrame) -> DispatchOutcome {
        let target = frame.target_at(point);
        let hovered_path = target
            .map(|target| frame.ancestry(target))
            .unwrap_or_default();
        let invalidation = target
            .and_then(|target| frame.node(target))
            .map(|node| node.invalidation())
            .unwrap_or(DispatchInvalidation::None);
        self.set_hovered_path(hovered_path, target, invalidation)
    }

    /// Projects a host-resolved pointer target after geometry changes without another pointer
    /// event.
    ///
    /// Scroll hosts use this when they can map the retained pointer position to a stable element
    /// before rebuilding the next interaction frame. The target must exist in the active scope of
    /// `frame`; invalid targets leave the current hover path unchanged.
    pub fn hover_element(
        &mut self,
        target: ElementId,
        frame: &InteractionFrame,
    ) -> DispatchOutcome {
        if !frame.is_in_active_scope(target) || frame.node(target).is_none() {
            return DispatchOutcome::default();
        }
        self.set_hovered_path(
            frame.ancestry(target),
            Some(target),
            frame
                .node(target)
                .map(|node| node.invalidation())
                .unwrap_or(DispatchInvalidation::None),
        )
    }

    fn set_hovered_path(
        &mut self,
        hovered_path: Vec<ElementId>,
        target: Option<ElementId>,
        invalidation: DispatchInvalidation,
    ) -> DispatchOutcome {
        if self.hovered_path == hovered_path {
            return DispatchOutcome::default();
        }
        let previous_fragment = self.hovered_fragment;
        let previous_invalidation = self.hovered_invalidation;
        let incoming_fragment = (invalidation == DispatchInvalidation::Fragment)
            .then_some(target)
            .flatten();
        let merged = previous_invalidation.merge(invalidation);
        let fragment = if merged == DispatchInvalidation::Fragment {
            match (previous_fragment, incoming_fragment) {
                (Some(previous), Some(incoming)) if previous != incoming => {
                    self.hovered_path = hovered_path;
                    self.hovered_invalidation = invalidation;
                    self.hovered_fragment = incoming_fragment;
                    return DispatchOutcome::paint();
                }
                (Some(previous), _) => Some(previous),
                (None, Some(incoming)) => Some(incoming),
                (None, None) => None,
            }
        } else {
            None
        };
        self.hovered_path = hovered_path;
        self.hovered_invalidation = invalidation;
        self.hovered_fragment = incoming_fragment;
        fragment.map_or_else(
            || DispatchOutcome::invalidation(merged),
            |id| DispatchOutcome::invalidation_for(id, merged),
        )
    }

    pub fn pointer_left(&mut self) -> DispatchOutcome {
        if self.hovered_path.is_empty() {
            return DispatchOutcome::default();
        }
        self.hovered_path.clear();
        let invalidation = self.hovered_invalidation;
        let fragment = self.hovered_fragment.take();
        self.hovered_invalidation = DispatchInvalidation::None;
        DispatchOutcome::for_fragment(invalidation, fragment)
    }

    pub fn press_primary(&mut self, frame: &InteractionFrame) -> DispatchOutcome {
        let Some(target) = self.hovered_path.last().copied() else {
            return DispatchOutcome::default();
        };
        if !frame.is_in_active_scope(target) {
            return DispatchOutcome::default();
        }
        let Some(node) = frame.node(target) else {
            return DispatchOutcome::default();
        };
        let focus_changed =
            node.focus_behavior() == FocusBehavior::TabStop && self.focused != Some(target);
        let focus_requires_paint = focus_changed && self.focused.is_some();
        if node.focus_behavior() == FocusBehavior::TabStop {
            self.focused = Some(target);
        }
        match node.action() {
            NodeAction::StartWindowDrag => DispatchOutcome::with_intent(
                UiIntent::StartWindowDrag(target),
                if focus_requires_paint {
                    DispatchInvalidation::Paint
                } else {
                    node.invalidation()
                },
            ),
            NodeAction::Activate | NodeAction::ToggleExpansion | NodeAction::AdjustValue { .. } => {
                self.pressed = Some(target);
                self.pressed_invalidation = node.invalidation();
                self.captured = Some(target);
                if focus_requires_paint {
                    DispatchOutcome::paint()
                } else {
                    DispatchOutcome::invalidation_for(target, node.invalidation())
                }
            }
            NodeAction::None if focus_requires_paint => DispatchOutcome::paint(),
            NodeAction::None if focus_changed => {
                DispatchOutcome::invalidation_for(target, node.invalidation())
            }
            NodeAction::None => DispatchOutcome::default(),
        }
    }

    pub fn release_primary(&mut self, point: Point, frame: &InteractionFrame) -> DispatchOutcome {
        let captured = self.captured.take();
        let pressed = self.pressed.take();
        let pressed_invalidation = std::mem::take(&mut self.pressed_invalidation);
        let captured_invalidation = captured
            .or(pressed)
            .and_then(|target| frame.node(target))
            .map(|node| node.invalidation())
            .unwrap_or(DispatchInvalidation::None)
            .merge(pressed_invalidation);
        let captured_fragment = (captured_invalidation == DispatchInvalidation::Fragment)
            .then_some(captured.or(pressed))
            .flatten();
        let (invalidation, fragment) = if let Some(fragment) = captured_fragment {
            let merged = captured_invalidation.merge(self.hovered_invalidation);
            if merged == DispatchInvalidation::Fragment
                && self
                    .hovered_fragment
                    .is_some_and(|hovered| hovered != fragment)
            {
                (DispatchInvalidation::Paint, None)
            } else {
                (merged, Some(fragment))
            }
        } else {
            (captured_invalidation.merge(self.hovered_invalidation), None)
        };
        let action = captured
            .filter(|captured| frame.target_at(point) == Some(*captured))
            .and_then(|target| frame.node(target).map(|node| (target, node.action())));
        if let Some((target, NodeAction::ToggleExpansion)) = action {
            self.toggle_expansion(target);
            return DispatchOutcome::for_fragment(invalidation, fragment);
        }
        if let Some((
            _,
            NodeAction::AdjustValue {
                target,
                delta,
                minimum,
                maximum,
            },
        )) = action
        {
            self.adjust_value(target, delta, minimum, maximum);
            return DispatchOutcome::for_fragment(invalidation, fragment);
        }
        let intent = action.and_then(|(target, action)| {
            (action == NodeAction::Activate).then_some(UiIntent::Activate(target))
        });
        match (pressed, intent) {
            (Some(_), Some(intent)) => DispatchOutcome::with_intent(intent, invalidation),
            (Some(_), None) => DispatchOutcome::for_fragment(invalidation, fragment),
            (None, Some(intent)) => DispatchOutcome::with_intent(intent, invalidation),
            (None, None) => DispatchOutcome::default(),
        }
    }

    pub fn reconcile_focus(
        &mut self,
        frame: &InteractionFrame,
        preferred: ElementId,
    ) -> DispatchOutcome {
        let view_state_changed = self.retain_mounted_view_state(frame);
        let focused_is_valid = self.focused.is_some_and(|focused| {
            frame.is_in_active_scope(focused)
                && frame
                    .node(focused)
                    .is_some_and(|node| node.focus_behavior() == FocusBehavior::TabStop)
        });
        if focused_is_valid {
            return if view_state_changed {
                DispatchOutcome::paint()
            } else {
                DispatchOutcome::default()
            };
        }
        let next = frame
            .node(preferred)
            .filter(|node| {
                frame.is_in_active_scope(node.id())
                    && node.focus_behavior() == FocusBehavior::TabStop
            })
            .map(|node| node.id())
            .or_else(|| frame.focus_order().next());
        if self.focused == next {
            return if view_state_changed {
                DispatchOutcome::paint()
            } else {
                DispatchOutcome::default()
            };
        }
        self.focused = next;
        DispatchOutcome::paint()
    }

    pub fn focus_in_order(
        &mut self,
        frame: &InteractionFrame,
        direction: FocusDirection,
    ) -> DispatchOutcome {
        let order = frame.focus_order().collect::<Vec<_>>();
        if order.is_empty() {
            return DispatchOutcome::default();
        }
        let current = self
            .focused
            .and_then(|focused| order.iter().position(|id| *id == focused));
        let index = match (current, direction) {
            (Some(0), FocusDirection::Previous) | (None, FocusDirection::Previous) => {
                order.len() - 1
            }
            (Some(index), FocusDirection::Previous) => index - 1,
            (Some(index), FocusDirection::Next) => (index + 1) % order.len(),
            (None, FocusDirection::Next) => 0,
        };
        self.set_focus(order[index])
    }

    pub fn focus_element(&mut self, frame: &InteractionFrame, id: ElementId) -> DispatchOutcome {
        let is_focusable = frame.is_in_active_scope(id)
            && frame
                .node(id)
                .is_some_and(|node| node.focus_behavior() == FocusBehavior::TabStop);
        if is_focusable {
            self.set_focus(id)
        } else {
            DispatchOutcome::default()
        }
    }

    pub fn focus_within_group(
        &mut self,
        frame: &InteractionFrame,
        direction: FocusDirection,
        axis: NavigationAxis,
    ) -> DispatchOutcome {
        let Some(focused) = self.focused else {
            return DispatchOutcome::default();
        };
        let Some((group, focused_axis)) = frame.node(focused).and_then(|node| node.navigation())
        else {
            return DispatchOutcome::default();
        };
        if focused_axis != axis {
            return DispatchOutcome::default();
        }
        let order = frame
            .focus_order()
            .filter(|id| {
                frame
                    .node(*id)
                    .and_then(|node| node.navigation())
                    .is_some_and(|(candidate, candidate_axis)| {
                        candidate == group && candidate_axis == axis
                    })
            })
            .collect::<Vec<_>>();
        let Some(index) = order.iter().position(|id| *id == focused) else {
            return DispatchOutcome::default();
        };
        let next = match direction {
            FocusDirection::Previous if index == 0 => order.len() - 1,
            FocusDirection::Previous => index - 1,
            FocusDirection::Next => (index + 1) % order.len(),
        };
        self.set_focus(order[next])
    }

    pub fn window_focused(&mut self) -> DispatchOutcome {
        if self.window_active {
            return DispatchOutcome::default();
        }
        self.window_active = true;
        DispatchOutcome::paint()
    }

    pub fn window_blurred(&mut self) -> DispatchOutcome {
        let had_visual_state = self.window_active
            || !self.hovered_path.is_empty()
            || self.pressed.is_some()
            || self.captured.is_some();
        let invalidation = if had_visual_state {
            DispatchInvalidation::Paint
        } else {
            DispatchInvalidation::None
        };
        self.window_active = false;
        self.hovered_path.clear();
        self.hovered_invalidation = DispatchInvalidation::None;
        self.hovered_fragment = None;
        self.pressed = None;
        self.pressed_invalidation = DispatchInvalidation::None;
        self.captured = None;
        DispatchOutcome::invalidation(invalidation)
    }

    pub fn is_hovered(&self, id: ElementId) -> bool {
        self.hovered_path.contains(&id)
    }

    pub fn is_pressed(&self, id: ElementId) -> bool {
        self.window_active && self.pressed == Some(id) && self.hovered_path.last() == Some(&id)
    }

    pub fn is_focused(&self, id: ElementId) -> bool {
        self.window_active && matches!(self.focused, Some(focused) if focused == id)
    }

    pub const fn focused(&self) -> Option<ElementId> {
        self.focused
    }

    pub const fn window_active(&self) -> bool {
        self.window_active
    }

    pub fn pointer_feedback(&self, frame: &InteractionFrame) -> CursorFeedback {
        self.hovered_path
            .last()
            .filter(|id| frame.is_in_active_scope(**id))
            .and_then(|id| frame.node(*id))
            .map(|node| node.cursor())
            .unwrap_or_default()
    }

    fn set_focus(&mut self, id: ElementId) -> DispatchOutcome {
        if self.focused == Some(id) {
            return DispatchOutcome::default();
        }
        self.focused = Some(id);
        DispatchOutcome::paint()
    }
}
