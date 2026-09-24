use super::DispatchOutcome;
use super::ElementId;
use super::InteractionFrame;
use super::NodeAction;
use super::UiDispatch;
use super::UiIntent;

impl UiDispatch {
    pub fn activate_focused(&mut self, frame: &InteractionFrame) -> DispatchOutcome {
        let Some(target) = self.focused else {
            return DispatchOutcome::default();
        };
        if !frame.is_in_active_scope(target) {
            return DispatchOutcome::default();
        }
        self.activate_target(frame, target)
    }

    /// Activates one accessible element when it remains actionable in the current frame.
    pub fn activate_element(&mut self, frame: &InteractionFrame, id: ElementId) -> DispatchOutcome {
        if !frame.is_in_active_scope(id) {
            return DispatchOutcome::default();
        }
        self.activate_target(frame, id)
    }

    fn activate_target(&mut self, frame: &InteractionFrame, id: ElementId) -> DispatchOutcome {
        let Some(node) = frame.node(id) else {
            return DispatchOutcome::default();
        };
        match node.action() {
            NodeAction::Activate => {
                DispatchOutcome::with_intent(UiIntent::Activate(id), node.invalidation())
            }
            NodeAction::ToggleExpansion => {
                self.toggle_expansion(id);
                DispatchOutcome::invalidation_for(id, node.invalidation())
            }
            NodeAction::AdjustValue {
                target,
                delta,
                minimum,
                maximum,
            } => {
                self.adjust_value(target, delta, minimum, maximum);
                DispatchOutcome::invalidation_for(id, node.invalidation())
            }
            NodeAction::None | NodeAction::StartWindowDrag => DispatchOutcome::default(),
        }
    }
}
