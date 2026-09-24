//! Container for the pane tree owned by one Workbench tab.

use crate::Pane;
use crate::PaneInput;
use crate::PanePart;

/// Complete pane state owned by one Workbench tab.
///
/// A container owns one pane-group layout. Switching Workbench tabs switches containers as a unit.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneContainer {
    pane_part: PanePart,
}

impl PaneContainer {
    #[cfg(test)]
    /// Creates a container with one empty root pane group.
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_input(input: PaneInput) -> Self {
        Self {
            pane_part: PanePart::with_input(input),
        }
    }

    /// Returns the pane-group topology owned by this container.
    pub const fn pane_part(&self) -> &PanePart {
        &self.pane_part
    }

    /// Returns the mutable pane-group topology owned by this container.
    pub(crate) const fn pane_part_mut(&mut self) -> &mut PanePart {
        &mut self.pane_part
    }

    /// Takes every pane from every group in visual tree order.
    pub(crate) fn take_panes(self) -> Vec<Pane> {
        self.pane_part.take_panes()
    }
}

#[cfg(test)]
#[path = "pane_container_tests.rs"]
mod tests;
