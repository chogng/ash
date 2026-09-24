//! Retained Settings page component implementation.

use super::DEFAULT_HEADER_HEIGHT;
use super::SETTINGS_CLOSE;
use super::SETTINGS_NAV_APPEARANCE;
use super::SETTINGS_NAV_GENERAL;
use super::SETTINGS_NAV_KEYBINDINGS;
use super::SETTINGS_NAV_REMOTE;
use super::SETTINGS_PAGE;
use super::SETTINGS_SEARCH_INPUT;
use super::SettingsPageLayout;
use super::SettingsPageSection;
use super::SettingsPageStyle;
use super::navigation::button_state;
use super::navigation::navigation_buttons;

use ash_icons::icons;
use ash_ui_components::Button;
use ash_ui_components::InputBoxState;
use ash_ui_components::InteractionRegion;
use ash_ui_components::SearchBox;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::CaretVisibility;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CursorFeedback;
use zui::ui::Edges;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::PaintRect;
use zui::ui::Rect;
use zui::ui::TextBlock;
use zui::ui::TextInput;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

/// Retained Settings page shell with left navigation, header, and a content slot.
pub struct SettingsPage {
    layout: SettingsPageLayout,
    style: SettingsPageStyle,
    section: SettingsPageSection,
    interaction_parent: Option<ElementId>,
    search_box: SearchBox,
    search_value: String,
    close_button: Button,
    navigation: [Button; 4],
}

impl SettingsPage {
    /// Creates a visible Settings page using the default titlebar-sized header.
    pub fn new(
        viewport: Rect,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        style: SettingsPageStyle,
        dispatch: &UiDispatch,
        text_layout: &mut TextInputLayoutEngine,
    ) -> Self {
        Self::new_with_header_height(
            viewport,
            DEFAULT_HEADER_HEIGHT,
            search_input,
            caret_visibility,
            style,
            dispatch,
            text_layout,
        )
    }

    /// Creates a Settings page whose header height is supplied by the hosting workbench.
    pub fn new_with_header_height(
        viewport: Rect,
        header_height: f32,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        style: SettingsPageStyle,
        dispatch: &UiDispatch,
        text_layout: &mut TextInputLayoutEngine,
    ) -> Self {
        Self::new_with_header_height_and_section(
            viewport,
            header_height,
            search_input,
            caret_visibility,
            style,
            SettingsPageSection::default(),
            dispatch,
            text_layout,
        )
    }

    /// Creates a Settings page with an explicitly selected navigation section.
    pub fn new_with_header_height_and_section(
        viewport: Rect,
        header_height: f32,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        style: SettingsPageStyle,
        section: SettingsPageSection,
        dispatch: &UiDispatch,
        text_layout: &mut TextInputLayoutEngine,
    ) -> Self {
        let layout = SettingsPageLayout::for_viewport_with_header_height(viewport, header_height);
        let search_state = if dispatch.is_focused(SETTINGS_SEARCH_INPUT) {
            InputBoxState::Focused(caret_visibility)
        } else if dispatch.is_hovered(SETTINGS_SEARCH_INPUT) {
            InputBoxState::Hovered
        } else {
            InputBoxState::Resting
        };
        let search_box = SearchBox::new(
            layout.search(),
            "Search",
            search_state,
            style.search_box.clone(),
            search_input,
            text_layout,
        );
        let close_button = Button::icon(
            layout.close(),
            icons::CLOSE,
            "Close settings",
            button_state(SETTINGS_CLOSE, true, dispatch),
            style.close_button.clone(),
        );
        let navigation = navigation_buttons(layout, section, dispatch, &style.nav_button);
        Self {
            layout,
            style,
            section,
            interaction_parent: None,
            search_box,
            search_value: search_input.text().to_owned(),
            close_button,
            navigation,
        }
    }

    pub const fn layout(&self) -> SettingsPageLayout {
        self.layout
    }

    /// Sets the host element that owns this page in the interaction tree.
    pub const fn with_parent(mut self, parent: ElementId) -> Self {
        self.interaction_parent = Some(parent);
        self
    }

    /// Returns the section selected in the navigation rail.
    pub const fn section(&self) -> SettingsPageSection {
        self.section
    }

    /// Returns the section content slot for the active settings page.
    pub const fn content_bounds(&self) -> Rect {
        self.layout.content()
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.search_box.caret_bounds()
    }

    fn child_interaction_regions(&self) -> Vec<InteractionRegion> {
        let mut regions = Vec::new();
        let navigation = NavigationGroupId::new(SETTINGS_PAGE);
        regions.push(
            InteractionRegion::new(
                "SettingsSearchInput",
                SETTINGS_SEARCH_INPUT,
                self.search_box.bounds(),
                AccessibilityRole::TextInput,
                "Search settings",
            )
            .with_cursor(CursorFeedback::Text)
            .with_focus(FocusBehavior::TabStop)
            .with_navigation(navigation, NavigationAxis::Horizontal)
            .with_value(self.search_value.clone()),
        );
        regions.push(self.button_region(
            SETTINGS_CLOSE,
            self.layout.close(),
            "Close settings",
            navigation,
            NavigationAxis::Horizontal,
        ));
        for (index, (id, label)) in [
            (SETTINGS_NAV_GENERAL, "General"),
            (SETTINGS_NAV_APPEARANCE, "Appearance"),
            (SETTINGS_NAV_KEYBINDINGS, "Keybindings"),
            (SETTINGS_NAV_REMOTE, "Remote"),
        ]
        .into_iter()
        .enumerate()
        {
            let selected = index == self.section.navigation_index();
            regions.push(
                InteractionRegion::new(
                    "SettingsNavigationItem",
                    id,
                    self.navigation[index].bounds(),
                    AccessibilityRole::Button,
                    label,
                )
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate)
                .with_navigation(navigation, NavigationAxis::Vertical)
                .with_selection(if selected {
                    AccessibilitySelection::Selected
                } else {
                    AccessibilitySelection::Unselected
                }),
            );
        }
        regions
    }

    fn button_region(
        &self,
        id: ElementId,
        bounds: Rect,
        label: &str,
        navigation: NavigationGroupId,
        axis: NavigationAxis,
    ) -> InteractionRegion {
        InteractionRegion::new(
            "SettingsButton",
            id,
            bounds,
            AccessibilityRole::Button,
            label,
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_navigation(navigation, axis)
    }
}

impl Component for SettingsPage {
    fn element(&self) -> ComponentElement {
        Element::leaf("SettingsPage")
            .in_bounds(self.layout.viewport())
            .with_identity(SETTINGS_PAGE)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        let node = UiNode::new(
            SETTINGS_PAGE,
            element.bounds(),
            AccessibilityRole::Group,
            "Settings",
        );
        Some(match self.interaction_parent {
            Some(parent) => node.with_parent(parent),
            None => node,
        })
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for region in self.child_interaction_regions() {
            context.draw_component(&region);
        }
        self.paint(context.scene_mut());
    }

    fn paint(&self, scene: &mut UiScene) {
        let viewport = self.layout.viewport();
        scene.draw_rect(PaintRect::new(viewport, self.style.background));
        scene.draw_rect(
            PaintRect::new(self.layout.rail(), self.style.rail_background).with_border(
                zui::ui::Border::new(Edges::new(0.0, 1.0, 0.0, 0.0), self.style.border),
            ),
        );
        draw_text(
            scene,
            "Settings",
            self.layout.navigation_label_bounds(),
            self.style.navigation_label.clone(),
        );
        for button in &self.navigation {
            scene.draw_component(button);
        }
        scene.draw_component(&self.search_box);
        scene.draw_component(&self.close_button);
    }
}

fn draw_text(scene: &mut UiScene, text: &str, bounds: Rect, style: TextStyle) {
    scene.draw_text(TextBlock::new(text, bounds.origin, bounds.size, style));
}
