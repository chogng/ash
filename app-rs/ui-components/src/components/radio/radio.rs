use crate::Button;
use crate::ButtonSelection;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::Element;
use crate::ElementLength;
use crate::Rect;
use crate::Size;
use crate::UiScene;
use zui::ui::Icon;

/// Selection projected onto one [`Radio`] by its host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum RadioSelection {
    #[default]
    Unselected,
    Selected,
}

impl RadioSelection {
    const fn button_selection(self) -> ButtonSelection {
        match self {
            Self::Unselected => ButtonSelection::Unselected,
            Self::Selected => ButtonSelection::Selected,
        }
    }
}

/// One single-choice button presented inside a [`RadioGroup`].
///
/// `Radio` owns no identity or authoritative value. It maps its selection onto the shared
/// [`Button`] surface while the host owns activation and the selected value.
#[derive(Clone, Debug, PartialEq)]
pub struct Radio {
    label: String,
    icon: Option<Icon>,
    measured_label_size: Option<Size>,
    state: ButtonState,
    selection: RadioSelection,
}

impl Radio {
    pub fn new(label: impl Into<String>, state: ButtonState) -> Self {
        Self {
            label: label.into(),
            icon: None,
            measured_label_size: None,
            state,
            selection: RadioSelection::Unselected,
        }
    }

    pub const fn with_icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn with_measured_label_size(mut self, size: Size) -> Self {
        assert!(
            size.width.is_finite()
                && size.width >= 0.0
                && size.height.is_finite()
                && size.height >= 0.0,
            "Radio measured label size must be finite and non-negative"
        );
        self.measured_label_size = Some(size);
        self
    }

    pub const fn with_selection(mut self, selection: RadioSelection) -> Self {
        self.selection = selection;
        self
    }

    pub fn accessible_label(&self) -> &str {
        &self.label
    }

    pub const fn state(&self) -> ButtonState {
        self.state
    }

    pub const fn selection(&self) -> RadioSelection {
        self.selection
    }

    fn button(&self, bounds: Rect, style: &ButtonStyle) -> Button {
        let button = if let Some(icon) = self.icon {
            Button::icon_and_label(bounds, icon, self.label.clone(), self.state, style.clone())
        } else {
            Button::new(bounds, self.label.clone(), self.state, style.clone())
        };
        let button = if let Some(size) = self.measured_label_size {
            button.with_measured_label_size(size)
        } else {
            button
        };
        button.with_selection(self.selection.button_selection())
    }
}

/// Axis along which a [`RadioGroup`] arranges its single-choice buttons.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum RadioGroupOrientation {
    #[default]
    Horizontal,
    Vertical,
}

/// Shared button presentation and geometry for a [`RadioGroup`].
#[derive(Clone, Debug, PartialEq)]
pub struct RadioGroupStyle {
    button_style: ButtonStyle,
    item_size: Size,
    gap: f32,
}

impl RadioGroupStyle {
    pub const fn new(button_style: ButtonStyle, item_size: Size) -> Self {
        Self {
            button_style,
            item_size,
            gap: 0.0,
        }
    }

    pub const fn with_gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }
}

/// Presentation-only single-choice button group.
///
/// The group owns arrangement and rejects multiple selected radios. Product identity,
/// accessibility nodes, activation, and the authoritative selected value remain with its host.
#[derive(Clone, Debug, PartialEq)]
pub struct RadioGroup {
    bounds: Rect,
    orientation: RadioGroupOrientation,
    radios: Vec<Radio>,
    style: RadioGroupStyle,
}

impl RadioGroup {
    pub fn new(
        bounds: Rect,
        orientation: RadioGroupOrientation,
        radios: Vec<Radio>,
        style: RadioGroupStyle,
    ) -> Self {
        assert!(
            radios
                .iter()
                .filter(|radio| radio.selection() == RadioSelection::Selected)
                .count()
                <= 1,
            "RadioGroup cannot contain multiple selected radios"
        );
        Self {
            bounds,
            orientation,
            radios,
            style,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn radios(&self) -> &[Radio] {
        &self.radios
    }

    pub fn selected_index(&self) -> Option<usize> {
        self.radios
            .iter()
            .position(|radio| radio.selection() == RadioSelection::Selected)
    }

    pub fn radio_bounds(&self, index: usize) -> Option<Rect> {
        self.radios.get(index)?;
        self.element_tree()
            .compute()
            .child(index)
            .map(ComputedElement::bounds)
    }

    fn element_tree(&self) -> ComponentElement {
        let children = self.radios.iter().map(|_| {
            Element::leaf("Radio")
                .width(ElementLength::px(self.style.item_size.width))
                .height(ElementLength::px(self.style.item_size.height))
        });
        match self.orientation {
            RadioGroupOrientation::Horizontal => Element::row("RadioGroup"),
            RadioGroupOrientation::Vertical => Element::column("RadioGroup"),
        }
        .gap(self.style.gap)
        .children(children)
        .in_bounds(self.bounds)
    }

    fn paint_layout(&self, scene: &mut UiScene, layout: &ComputedElement) {
        scene.with_clip(self.bounds, |scene| {
            for (index, radio) in self.radios.iter().enumerate() {
                let Some(bounds) = layout.child(index).map(ComputedElement::bounds) else {
                    continue;
                };
                scene.draw_component(&radio.button(bounds, &self.style.button_style));
            }
        });
    }
}

impl Component for RadioGroup {
    fn element(&self) -> ComponentElement {
        self.element_tree()
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        for (index, radio) in self.radios.iter().enumerate() {
            let Some(bounds) = element.child(index).map(ComputedElement::bounds) else {
                continue;
            };
            context.draw_component(&RadioSurface {
                bounds,
                radio,
                style: &self.style.button_style,
            });
        }
    }

    fn paint_element(&self, scene: &mut UiScene, element: &ComputedElement) {
        self.paint_layout(scene, element);
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_layout(scene, &self.element_tree().compute());
    }
}

struct RadioSurface<'a> {
    bounds: Rect,
    radio: &'a Radio,
    style: &'a ButtonStyle,
}

impl Component for RadioSurface<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("Radio")
            .in_bounds(self.bounds)
            .with_inspection_label(self.radio.accessible_label())
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.draw_component(&self.radio.button(self.bounds, self.style));
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.radio.button(self.bounds, self.style));
    }
}

#[cfg(test)]
#[path = "radio_tests.rs"]
mod tests;
