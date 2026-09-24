const DEFAULT_WIDTH: f32 = 520.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum InspectorPartVisibility {
    #[default]
    Collapsed,
    Expanded,
}

/// Visibility and preferred width for the right Workbench inspector.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InspectorPartState {
    visibility: InspectorPartVisibility,
    preferred_width: f32,
}

impl Default for InspectorPartState {
    fn default() -> Self {
        Self {
            visibility: InspectorPartVisibility::Collapsed,
            preferred_width: DEFAULT_WIDTH,
        }
    }
}

impl InspectorPartState {
    #[cfg(test)]
    pub const fn expanded() -> Self {
        Self {
            visibility: InspectorPartVisibility::Expanded,
            preferred_width: DEFAULT_WIDTH,
        }
    }

    pub const fn is_expanded(self) -> bool {
        matches!(self.visibility, InspectorPartVisibility::Expanded)
    }

    pub const fn preferred_width(self) -> f32 {
        self.preferred_width
    }

    pub fn set_preferred_width(&mut self, width: f32) -> bool {
        if !width.is_finite() || width < 0.0 || self.preferred_width == width {
            return false;
        }
        self.preferred_width = width;
        true
    }

    #[cfg(test)]
    pub fn toggle(&mut self) {
        self.visibility = match self.visibility {
            InspectorPartVisibility::Collapsed => InspectorPartVisibility::Expanded,
            InspectorPartVisibility::Expanded => InspectorPartVisibility::Collapsed,
        };
    }

    pub fn expand(&mut self) {
        self.visibility = InspectorPartVisibility::Expanded;
    }

    pub fn collapse(&mut self) {
        self.visibility = InspectorPartVisibility::Collapsed;
    }
}

#[cfg(test)]
#[path = "layout_inspector_tests.rs"]
mod tests;
