use crate::{
    Border, Color, Component, ComponentElement, CornerRadii, Edges, Element, PaintIcon, PaintRect,
    Point, Rect, TextBlock, TextSpan, TextStyle, UiScene,
};
use zui::ui::Icon;

use super::icon_label::{IconLabel, IconLabelStyle};

/// Visual interaction state selected by a button's host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ButtonState {
    #[default]
    Resting,
    Hovered,
    Focused,
    Pressed,
    Disabled,
}

/// Selection presentation projected by a button's host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ButtonSelection {
    #[default]
    Unselected,
    Selected,
}

/// State-dependent background colors for a button.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ButtonBackgrounds {
    resting: Color,
    hovered: Color,
    focused: Color,
    pressed: Color,
    disabled: Color,
}

impl ButtonBackgrounds {
    pub const fn new(resting: Color) -> Self {
        Self {
            resting,
            hovered: resting,
            focused: resting,
            pressed: resting,
            disabled: resting,
        }
    }

    pub const fn with_hovered(mut self, hovered: Color) -> Self {
        self.hovered = hovered;
        self
    }

    pub const fn with_focused(mut self, focused: Color) -> Self {
        self.focused = focused;
        self
    }

    pub const fn with_pressed(mut self, pressed: Color) -> Self {
        self.pressed = pressed;
        self
    }

    pub const fn with_disabled(mut self, disabled: Color) -> Self {
        self.disabled = disabled;
        self
    }

    const fn for_state(self, state: ButtonState) -> Color {
        match state {
            ButtonState::Resting => self.resting,
            ButtonState::Hovered => self.hovered,
            ButtonState::Focused => self.focused,
            ButtonState::Pressed => self.pressed,
            ButtonState::Disabled => self.disabled,
        }
    }
}

/// Presentation contract shared by text buttons and text-with-icon buttons.
#[derive(Clone, Debug, PartialEq)]
pub struct ButtonStyle {
    backgrounds: ButtonBackgrounds,
    selected_backgrounds: ButtonBackgrounds,
    border: Border,
    corner_radii: CornerRadii,
    padding: Edges,
    text_style: TextStyle,
    selected_text_style: TextStyle,
    hint_text_style: TextStyle,
    disabled_text_style: TextStyle,
    center_text: bool,
    icon_size: f32,
    content_gap: f32,
    hint_width: f32,
}

impl ButtonStyle {
    pub fn new(backgrounds: ButtonBackgrounds, text_style: TextStyle) -> Self {
        Self {
            backgrounds,
            selected_backgrounds: backgrounds,
            border: Border::default(),
            corner_radii: CornerRadii::uniform(0.0),
            padding: Edges::uniform(8.0),
            selected_text_style: text_style.clone(),
            hint_text_style: text_style.clone(),
            disabled_text_style: text_style.clone(),
            text_style,
            center_text: true,
            icon_size: 16.0,
            content_gap: 6.0,
            hint_width: 40.0,
        }
    }

    pub const fn with_selected_backgrounds(
        mut self,
        selected_backgrounds: ButtonBackgrounds,
    ) -> Self {
        self.selected_backgrounds = selected_backgrounds;
        self
    }

    pub fn with_disabled_text_style(mut self, disabled_text_style: TextStyle) -> Self {
        self.disabled_text_style = disabled_text_style;
        self
    }

    pub fn with_hint_text_style(mut self, hint_text_style: TextStyle) -> Self {
        self.hint_text_style = hint_text_style;
        self
    }

    pub fn with_text_style(mut self, text_style: TextStyle) -> Self {
        self.text_style = text_style;
        self
    }

    pub fn with_selected_text_style(mut self, selected_text_style: TextStyle) -> Self {
        self.selected_text_style = selected_text_style;
        self
    }

    pub const fn with_centered_text(mut self) -> Self {
        self.center_text = true;
        self
    }

    pub const fn with_leading_text(mut self) -> Self {
        self.center_text = false;
        self
    }

    pub const fn with_border(mut self, border: Border) -> Self {
        self.border = border;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn with_padding(mut self, padding: Edges) -> Self {
        self.padding = padding;
        self
    }

    pub const fn with_icon_size(mut self, icon_size: f32) -> Self {
        self.icon_size = icon_size;
        self
    }

    pub const fn with_content_gap(mut self, content_gap: f32) -> Self {
        self.content_gap = content_gap;
        self
    }

    pub const fn with_hint_width(mut self, hint_width: f32) -> Self {
        self.hint_width = hint_width;
        self
    }

    /// Returns the preferred button width for a shaped label paired with the leading icon.
    pub fn preferred_icon_and_label_width(&self, text_width: f32) -> f32 {
        let text_width = if text_width.is_finite() {
            text_width.max(0.0)
        } else {
            0.0
        };
        self.padding.left.max(0.0)
            + self.icon_size.max(0.0)
            + if text_width > 0.0 {
                self.content_gap.max(0.0) + text_width
            } else {
                0.0
            }
            + self.padding.right.max(0.0)
    }

    const fn backgrounds_for(&self, selection: ButtonSelection) -> ButtonBackgrounds {
        match selection {
            ButtonSelection::Unselected => self.backgrounds,
            ButtonSelection::Selected => self.selected_backgrounds,
        }
    }

    fn text_style_for(&self, state: ButtonState, selection: ButtonSelection) -> &TextStyle {
        match state {
            ButtonState::Disabled => &self.disabled_text_style,
            ButtonState::Resting
            | ButtonState::Hovered
            | ButtonState::Focused
            | ButtonState::Pressed => match selection {
                ButtonSelection::Unselected => &self.text_style,
                ButtonSelection::Selected => &self.selected_text_style,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum ButtonContent {
    Label(String),
    LabelAndTrailingIcon {
        label: String,
        icon: Icon,
    },
    LabelAndHint {
        label: String,
        hint: String,
    },
    Icon {
        icon: Icon,
        accessible_label: String,
    },
    IconAndLabel {
        icon: Icon,
        label: String,
    },
    IconAndStyledLabel {
        icon: Icon,
        label: String,
        spans: Vec<TextSpan>,
    },
}

/// A reusable button that paints text, icon-only, or icon-and-label content.
#[derive(Clone, Debug, PartialEq)]
pub struct Button {
    bounds: Rect,
    content: ButtonContent,
    state: ButtonState,
    selection: ButtonSelection,
    style: ButtonStyle,
    measured_label_size: Option<crate::Size>,
}

impl Button {
    pub fn new(
        bounds: Rect,
        label: impl Into<String>,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::Label(label.into()),
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    /// Creates a text button with a trailing keyboard hint or disclosure marker.
    pub fn label_and_hint(
        bounds: Rect,
        label: impl Into<String>,
        hint: impl Into<String>,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::LabelAndHint {
                label: label.into(),
                hint: hint.into(),
            },
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    /// Creates a text button with a trailing disclosure or status icon.
    pub fn label_and_trailing_icon(
        bounds: Rect,
        label: impl Into<String>,
        icon: Icon,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::LabelAndTrailingIcon {
                label: label.into(),
                icon,
            },
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    /// Creates an icon-only button while retaining a non-visual label for host accessibility.
    pub fn icon(
        bounds: Rect,
        icon: Icon,
        accessible_label: impl Into<String>,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::Icon {
                icon,
                accessible_label: accessible_label.into(),
            },
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    /// Creates a button that paints a leading icon followed by a visible label.
    pub fn icon_and_label(
        bounds: Rect,
        icon: Icon,
        label: impl Into<String>,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::IconAndLabel {
                icon,
                label: label.into(),
            },
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    /// Creates an icon button with one accessible label and styled visible text runs.
    pub fn icon_and_styled_label(
        bounds: Rect,
        icon: Icon,
        accessible_label: impl Into<String>,
        spans: impl IntoIterator<Item = TextSpan>,
        state: ButtonState,
        style: ButtonStyle,
    ) -> Self {
        Self {
            bounds,
            content: ButtonContent::IconAndStyledLabel {
                icon,
                label: accessible_label.into(),
                spans: spans.into_iter().collect(),
            },
            state,
            selection: ButtonSelection::Unselected,
            style,
            measured_label_size: None,
        }
    }

    pub const fn with_selection(mut self, selection: ButtonSelection) -> Self {
        self.selection = selection;
        self
    }

    /// Supplies the shaped label size used by content-aware button layouts.
    pub fn with_measured_label_size(mut self, size: crate::Size) -> Self {
        assert!(
            size.width.is_finite()
                && size.width >= 0.0
                && size.height.is_finite()
                && size.height >= 0.0,
            "Button measured label size must be finite and non-negative"
        );
        self.measured_label_size = Some(size);
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    /// Returns the label that the host should expose to its accessibility adapter.
    pub fn accessible_label(&self) -> &str {
        match &self.content {
            ButtonContent::Label(label)
            | ButtonContent::LabelAndTrailingIcon { label, .. }
            | ButtonContent::LabelAndHint { label, .. }
            | ButtonContent::Icon {
                accessible_label: label,
                ..
            }
            | ButtonContent::IconAndLabel { label, .. }
            | ButtonContent::IconAndStyledLabel { label, .. } => label,
        }
    }
}

impl Component for Button {
    fn element(&self) -> ComponentElement {
        Element::leaf("Button")
            .padding(self.style.padding)
            .corner_radii(self.style.corner_radii)
            .in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(
                self.bounds,
                self.style
                    .backgrounds_for(self.selection)
                    .for_state(self.state),
            )
            .with_border(self.style.border)
            .with_corner_radii(self.style.corner_radii),
        );

        let content = content_bounds(self.bounds, self.style.padding);
        if content.is_empty() {
            return;
        }
        let text_style = self.style.text_style_for(self.state, self.selection);
        match &self.content {
            ButtonContent::Icon {
                icon,
                accessible_label: _,
            } => {
                let icon_size = self
                    .style
                    .icon_size
                    .max(0.0)
                    .min(content.size.width)
                    .min(content.size.height);
                if icon_size <= 0.0 {
                    return;
                }
                let icon_x = content.origin.x + (content.size.width - icon_size) * 0.5;
                let icon_y = content.origin.y + (content.size.height - icon_size) * 0.5;
                scene.draw_icon(PaintIcon::new(
                    *icon,
                    Rect::from_xywh(icon_x, icon_y, icon_size, icon_size),
                    text_style.color(),
                ));
                return;
            }
            ButtonContent::IconAndLabel { icon, label } => {
                let label = IconLabel::new(
                    content,
                    *icon,
                    label.clone(),
                    IconLabelStyle::new(text_style.clone())
                        .with_icon_size(self.style.icon_size)
                        .with_content_gap(self.style.content_gap),
                );
                let label = if let Some(size) = self.measured_label_size {
                    label.with_measured_label_size(size)
                } else {
                    label
                };
                scene.draw_component(&label);
                return;
            }
            ButtonContent::IconAndStyledLabel {
                icon,
                label: _,
                spans,
            } => {
                let label = IconLabel::from_spans(
                    content,
                    *icon,
                    spans.clone(),
                    IconLabelStyle::new(text_style.clone())
                        .with_icon_size(self.style.icon_size)
                        .with_content_gap(self.style.content_gap),
                );
                let label = if let Some(size) = self.measured_label_size {
                    label.with_measured_label_size(size)
                } else {
                    label
                };
                scene.draw_component(&label);
                return;
            }
            ButtonContent::LabelAndHint { label, hint } => {
                let hint_width = self.style.hint_width.max(0.0).min(content.size.width);
                let label_width =
                    (content.size.width - hint_width - self.style.content_gap.max(0.0)).max(0.0);
                let text_height = text_style.line_height().max(0.0).min(content.size.height);
                let text_y = content.origin.y + (content.size.height - text_height) * 0.5;
                if !label.is_empty() && label_width > 0.0 && text_height > 0.0 {
                    scene.draw_text(TextBlock::new(
                        label.clone(),
                        Point::new(content.origin.x, text_y),
                        crate::Size::new(label_width, text_height),
                        text_style.clone(),
                    ));
                }
                if !hint.is_empty() && hint_width > 0.0 && text_height > 0.0 {
                    let hint_style = if self.state == ButtonState::Disabled {
                        &self.style.disabled_text_style
                    } else {
                        &self.style.hint_text_style
                    };
                    scene.draw_text(TextBlock::new(
                        hint.clone(),
                        Point::new(content.right() - hint_width, text_y),
                        crate::Size::new(hint_width, text_height),
                        hint_style.clone(),
                    ));
                }
                return;
            }
            ButtonContent::LabelAndTrailingIcon { label, icon } => {
                let icon_size = self
                    .style
                    .icon_size
                    .max(0.0)
                    .min(content.size.width)
                    .min(content.size.height);
                let gap = self.style.content_gap.max(0.0);
                let label_width = (content.size.width - icon_size - gap).max(0.0);
                let text_height = text_style.line_height().max(0.0).min(content.size.height);
                let text_y = content.origin.y + (content.size.height - text_height) * 0.5;
                if !label.is_empty() && label_width > 0.0 && text_height > 0.0 {
                    scene.draw_text(TextBlock::new(
                        label.clone(),
                        Point::new(content.origin.x, text_y),
                        crate::Size::new(label_width, text_height),
                        text_style.clone(),
                    ));
                }
                if icon_size > 0.0 {
                    scene.draw_icon(PaintIcon::new(
                        *icon,
                        Rect::from_xywh(
                            content.right() - icon_size,
                            content.origin.y + (content.size.height - icon_size) * 0.5,
                            icon_size,
                            icon_size,
                        ),
                        text_style.color(),
                    ));
                }
                return;
            }
            ButtonContent::Label(_) => {}
        }
        let ButtonContent::Label(label) = &self.content else {
            return;
        };
        let text_x = content.origin.x;
        let text_width = content.size.width;
        let text_height = text_style.line_height().max(0.0).min(content.size.height);
        if label.is_empty() || text_width <= 0.0 || text_height <= 0.0 {
            return;
        }
        let text_y = content.origin.y + (content.size.height - text_height) * 0.5;
        let text = TextBlock::new(
            label.clone(),
            Point::new(text_x, text_y),
            crate::Size::new(text_width, text_height),
            text_style.clone(),
        );
        scene.draw_text(if self.style.center_text {
            text.with_centered_text()
        } else {
            text
        });
    }
}

fn content_bounds(bounds: Rect, padding: Edges) -> Rect {
    Rect::from_xywh(
        bounds.origin.x + padding.left,
        bounds.origin.y + padding.top,
        (bounds.size.width - padding.left - padding.right).max(0.0),
        (bounds.size.height - padding.top - padding.bottom).max(0.0),
    )
}

#[cfg(test)]
#[path = "button_tests.rs"]
mod tests;
