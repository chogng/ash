use ash_ui_components::KeycapSequence;
use ash_ui_components::KeycapStyle;
use zui::ui::AccessibilityRole;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::Element;
use zui::ui::FontFamily;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextBlock;
use zui::ui::TextStyle;
use zui::ui::UiNode;

use crate::SessionPaneStyle;
use crate::interaction::COMPOSER_KEY_HINT_BAR;

use super::ComposerRoute;

const KEYCAP_SIZE: f32 = 16.0;
const KEYCAP_LABEL_GAP: f32 = 6.0;

pub(super) struct KeyHintBar<'a> {
    bounds: Rect,
    route: ComposerRoute,
    style: SessionPaneStyle,
    history_status: Option<&'a str>,
}

impl<'a> KeyHintBar<'a> {
    pub(super) const fn new(bounds: Rect, route: ComposerRoute, style: SessionPaneStyle) -> Self {
        Self {
            bounds,
            route,
            style,
            history_status: None,
        }
    }

    pub(super) fn with_history_status(mut self, status: Option<&'a str>) -> Self {
        self.history_status = status;
        self
    }

    fn accessibility_label(&self) -> &str {
        if let Some(status) = self.history_status {
            return status;
        }
        match self.route {
            ComposerRoute::Agent => {
                "/ for commands, Up and Down to recall inputs, Control R to search history"
            }
            ComposerRoute::Shell => "Up and Down for input history, Control R to search history",
        }
    }

    fn keys(&self) -> Vec<Vec<String>> {
        match self.route {
            ComposerRoute::Agent => vec![vec!["/".to_owned()]],
            ComposerRoute::Shell => vec![vec!["↑".to_owned(), "↓".to_owned()]],
        }
    }

    const fn label(&self) -> &'static str {
        match self.route {
            ComposerRoute::Agent => "commands · Ctrl+R history",
            ComposerRoute::Shell => "history · Ctrl+R search",
        }
    }
}

impl Component for KeyHintBar<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("KeyHintBar")
            .in_bounds(self.bounds)
            .with_identity(COMPOSER_KEY_HINT_BAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(UiNode::new(
            COMPOSER_KEY_HINT_BAR,
            element.bounds(),
            AccessibilityRole::Group,
            self.accessibility_label(),
        ))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        let bounds = element.bounds();
        if let Some(status) = self.history_status {
            context.scene_mut().draw_text(TextBlock::new(
                status,
                Point::new(bounds.origin.x, bounds.origin.y + 2.0),
                bounds.size,
                TextStyle::new(12.0, self.style.text_muted)
                    .with_family(FontFamily::Monospace)
                    .with_line_height(20.0),
            ));
            return;
        }
        let keycaps = KeycapSequence::new(
            Point::new(
                bounds.origin.x,
                bounds.origin.y + (bounds.size.height - KEYCAP_SIZE).max(0.0) * 0.5,
            ),
            self.keys(),
            keycap_style(self.style),
        );
        let label_x = keycaps.bounds().right() + KEYCAP_LABEL_GAP;
        context.draw_component(&keycaps);
        context.scene_mut().draw_text(TextBlock::new(
            self.label(),
            Point::new(label_x, bounds.origin.y + 2.0),
            Size::new((bounds.right() - label_x).max(1.0), 20.0),
            TextStyle::new(12.0, self.style.text_muted)
                .with_family(FontFamily::Monospace)
                .with_line_height(20.0),
        ));
    }
}

fn keycap_style(style: SessionPaneStyle) -> KeycapStyle {
    KeycapStyle::new(style.key_hint_background, style.key_hint_foreground)
        .with_text_style(
            TextStyle::new(10.0, style.key_hint_foreground)
                .with_family(FontFamily::Monospace)
                .with_line_height(12.0),
        )
        .with_corner_radii(CornerRadii::uniform(3.0))
        .with_height(KEYCAP_SIZE)
        .with_minimum_width(KEYCAP_SIZE)
        .with_horizontal_padding(3.0)
}

#[cfg(test)]
#[path = "key_hint_bar_tests.rs"]
mod tests;
