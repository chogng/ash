use crate::AccessibilityRole;
use crate::AccessibilitySelection;
use crate::ButtonBackgrounds;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::Color;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::CornerRadii;
use crate::CursorFeedback;
use crate::Edges;
use crate::Element;
use crate::ElementId;
use crate::FocusBehavior;
use crate::InteractionRegion;
use crate::NavigationAxis;
use crate::NavigationGroupId;
use crate::NodeAction;
use crate::Radio;
use crate::RadioGroup;
use crate::RadioGroupOrientation;
use crate::RadioGroupStyle;
use crate::RadioSelection;
use crate::Rect;
use crate::Size;
use crate::TextInputLayoutEngine;
use crate::UiDispatch;
use crate::UiNode;
use crate::UiScene;
use ash_icons::icons;
use zui::ui::Icon;

use super::WorkbenchUiStyle;
use super::identity::CODE_MODE;
use super::identity::COWORK_MODE;
use super::identity::SIDEBAR_MODE_SWITCH;
use super::identity::TAB_CONTAINER;
use crate::SidebarMode;

pub(super) const MODE_SWITCHER_HEIGHT: f32 = 28.0;
const MODE_GAP: f32 = 4.0;
const MODE_ICON_SIZE: f32 = 14.0;
const MODE_LABEL_GAP: f32 = 6.0;

/// Workbench product-mode selector composed from a single-choice [`RadioGroup`].
pub struct ModeSwitcher {
    bounds: Rect,
    radios: RadioGroup,
    mode: SidebarMode,
}

impl ModeSwitcher {
    pub fn new(
        bounds: Rect,
        mode: SidebarMode,
        style: WorkbenchUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let radio_width = ((bounds.size.width - MODE_GAP) * 0.5).max(1.0);
        let backgrounds = ButtonBackgrounds::new(Color::TRANSPARENT)
            .with_hovered(style.colors.control_hover_background)
            .with_focused(style.colors.control_hover_background)
            .with_pressed(style.colors.border);
        let text_style = style.control_text.clone();
        let button_style = ButtonStyle::new(backgrounds, text_style.clone())
            .with_selected_backgrounds(ButtonBackgrounds::new(style.colors.content_background))
            .with_centered_text()
            .with_icon_size(MODE_ICON_SIZE)
            .with_content_gap(MODE_LABEL_GAP)
            .with_corner_radii(CornerRadii::uniform(6.0))
            .with_padding(Edges::new(5.0, 8.0, 5.0, 8.0));
        let radios = [SidebarMode::Cowork, SidebarMode::Code]
            .into_iter()
            .map(|candidate| {
                Radio::new(
                    mode_label(candidate),
                    button_state(dispatch, mode_element_id(candidate)),
                )
                .with_icon(mode_icon(candidate))
                .with_measured_label_size(
                    text_layout.measure_text(mode_label(candidate), &text_style),
                )
                .with_selection(if candidate == mode {
                    RadioSelection::Selected
                } else {
                    RadioSelection::Unselected
                })
            })
            .collect();
        Self {
            bounds,
            radios: RadioGroup::new(
                bounds,
                RadioGroupOrientation::Horizontal,
                radios,
                RadioGroupStyle::new(button_style, Size::new(radio_width, MODE_SWITCHER_HEIGHT))
                    .with_gap(MODE_GAP),
            ),
            mode,
        }
    }

    fn region(&self, mode: SidebarMode, index: usize) -> InteractionRegion {
        InteractionRegion::new(
            "ModeRadio",
            mode_element_id(mode),
            self.radios.radio_bounds(index).expect("ModeSwitcher radio"),
            AccessibilityRole::RadioButton,
            mode_label(mode),
        )
        .with_parent(SIDEBAR_MODE_SWITCH)
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_navigation(
            NavigationGroupId::new(SIDEBAR_MODE_SWITCH),
            NavigationAxis::Horizontal,
        )
        .with_selection(if mode == self.mode {
            AccessibilitySelection::Selected
        } else {
            AccessibilitySelection::Unselected
        })
    }
}

impl Component for ModeSwitcher {
    fn element(&self) -> ComponentElement {
        Element::leaf("ModeSwitcher")
            .in_bounds(self.bounds)
            .with_identity(SIDEBAR_MODE_SWITCH)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                SIDEBAR_MODE_SWITCH,
                element.bounds(),
                AccessibilityRole::RadioGroup,
                "Product mode switcher",
            )
            .with_parent(TAB_CONTAINER),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.draw_component(&self.radios);
        context.draw_component(&self.region(SidebarMode::Cowork, 0));
        context.draw_component(&self.region(SidebarMode::Code, 1));
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.radios);
    }
}

pub fn mode_for_element(id: ElementId) -> Option<SidebarMode> {
    if id == COWORK_MODE {
        Some(SidebarMode::Cowork)
    } else if id == CODE_MODE {
        Some(SidebarMode::Code)
    } else {
        None
    }
}

const fn mode_element_id(mode: SidebarMode) -> ElementId {
    match mode {
        SidebarMode::Cowork => COWORK_MODE,
        SidebarMode::Code => CODE_MODE,
    }
}

const fn mode_label(mode: SidebarMode) -> &'static str {
    match mode {
        SidebarMode::Cowork => "Cowork",
        SidebarMode::Code => "Code",
    }
}

const fn mode_icon(mode: SidebarMode) -> Icon {
    match mode {
        SidebarMode::Cowork => icons::COWORK,
        SidebarMode::Code => icons::CODE,
    }
}

fn button_state(dispatch: &UiDispatch, id: ElementId) -> ButtonState {
    if dispatch.is_pressed(id) {
        ButtonState::Pressed
    } else if dispatch.is_focused(id) {
        ButtonState::Focused
    } else if dispatch.is_hovered(id) {
        ButtonState::Hovered
    } else {
        ButtonState::Resting
    }
}
