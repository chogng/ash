use crate::runtime::AccessibilityNode;
use crate::runtime::InteractionFrame;
use crate::runtime::UiDispatch;
use crate::ui::presentation::UiFrame;
use crate::ui::presentation::UiScene;

/// Scene and accessibility outputs resolved together at the application/window boundary.
///
/// Native and headless hosts consume this private value so neither can accept a painted scene and
/// an independently cached accessibility projection.
pub(crate) struct WindowFramePresentation<'a> {
    scene: &'a UiScene,
    accessibility: Vec<AccessibilityNode>,
}

impl<'a> WindowFramePresentation<'a> {
    pub(crate) fn resolve(frame: &'a UiFrame<InteractionFrame>, dispatch: &UiDispatch) -> Self {
        Self {
            scene: frame.scene(),
            accessibility: frame.interaction().accessibility_nodes(dispatch),
        }
    }

    pub(crate) const fn scene(&self) -> &UiScene {
        self.scene
    }

    pub(crate) fn accessibility(&self) -> &[AccessibilityNode] {
        &self.accessibility
    }
}
