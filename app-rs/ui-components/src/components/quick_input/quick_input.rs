use crate::{
    AccessibilityRole, Border, BoxShadow, CaretVisibility, Color, Component, ComponentContext,
    ComponentElement, ComputedElement, CornerRadii, CursorFeedback, Dialog, DialogIds, DialogStyle,
    ElementId, FocusBehavior, InteractionRegion, NodeAction, PaintRect, Point, Rect, SearchBox,
    SearchBoxStyle, Size, TextBlock, TextInput, TextInputLayoutEngine, TextStyle, UiDispatch,
    UiNode, UiScene,
};

const PANEL_WIDTH: f32 = 660.0;
const PANEL_HEIGHT: f32 = 470.0;
const TITLE_HEIGHT: f32 = 50.0;
const SEARCH_HEIGHT: f32 = 34.0;
const SEARCH_BOTTOM_GAP: f32 = 12.0;
const CONTENT_INSET: f32 = 16.0;
const FOOTER_HEIGHT: f32 = 44.0;

/// Stable host-owned identities used by one quick input surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QuickInputIds {
    parent: ElementId,
    root: ElementId,
    close: ElementId,
    search: ElementId,
}

impl QuickInputIds {
    pub const fn new(
        parent: ElementId,
        root: ElementId,
        close: ElementId,
        search: ElementId,
    ) -> Self {
        Self {
            parent,
            root,
            close,
            search,
        }
    }

    pub const fn root(self) -> ElementId {
        self.root
    }

    pub const fn dialog_ids(self) -> DialogIds {
        DialogIds::new(self.parent, self.root)
    }
}

/// Visual tokens for the shared quick input shell and its search field.
#[derive(Clone, Debug, PartialEq)]
pub struct QuickInputStyle {
    dialog: DialogStyle,
    text: Color,
    text_muted: Color,
    text_error: Color,
    close_hovered: Color,
    search_box: SearchBoxStyle,
}

impl QuickInputStyle {
    #[allow(clippy::too_many_arguments)]
    pub const fn new(
        scrim: Color,
        surface: Color,
        border: Color,
        text: Color,
        text_muted: Color,
        text_error: Color,
        close_hovered: Color,
        search_box: SearchBoxStyle,
    ) -> Self {
        Self {
            dialog: DialogStyle::new(scrim, surface)
                .with_border(Border::uniform(1.0, border))
                .with_corner_radii(CornerRadii::uniform(10.0))
                .with_shadow(
                    BoxShadow::new(Color::rgba(0, 0, 0, 64))
                        .with_offset(Point::new(0.0, 8.0))
                        .with_blur_radius(24.0),
                )
                .with_viewport_margin(24.0),
            text,
            text_muted,
            text_error,
            close_hovered,
            search_box,
        }
    }

    pub const fn text(&self) -> Color {
        self.text
    }

    pub const fn text_muted(&self) -> Color {
        self.text_muted
    }

    pub(crate) const fn dialog_style(&self) -> DialogStyle {
        self.dialog
    }
}

/// Severity used to present a short message below quick input content.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum QuickInputMessageKind {
    #[default]
    Status,
    Error,
}

/// Centered modal input composed from [`Dialog`] with a built-in search field and host-owned
/// content area.
///
/// QuickInput owns search presentation, close interaction, and content clipping. [`Dialog`] owns
/// modal geometry and interaction scope. The host owns the retained text input, keyboard and IME
/// routing, filtering, and content.
pub struct QuickInput<'a> {
    dialog: Dialog,
    title: String,
    search_box: SearchBox,
    search_value: String,
    message: Option<(String, QuickInputMessageKind)>,
    ids: QuickInputIds,
    style: QuickInputStyle,
    dispatch: &'a UiDispatch,
}

impl<'a> QuickInput<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        viewport: Rect,
        title: impl Into<String>,
        placeholder: impl Into<String>,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        ids: QuickInputIds,
        style: QuickInputStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
    ) -> Self {
        let title = title.into();
        let dialog = Dialog::new(
            viewport,
            Size::new(PANEL_WIDTH, PANEL_HEIGHT),
            title.clone(),
            ids.dialog_ids(),
            style.dialog_style(),
        );
        let panel = dialog.bounds();
        let search_bounds = Rect::from_xywh(
            panel.origin.x + CONTENT_INSET,
            panel.origin.y + TITLE_HEIGHT,
            panel.size.width - CONTENT_INSET * 2.0,
            SEARCH_HEIGHT,
        );
        let search_state = if dispatch.is_focused(ids.search) {
            crate::InputBoxState::Focused(caret_visibility)
        } else if dispatch.is_hovered(ids.search) {
            crate::InputBoxState::Hovered
        } else {
            crate::InputBoxState::Resting
        };
        let search_box = SearchBox::new(
            search_bounds,
            placeholder,
            search_state,
            style.search_box.clone(),
            search_input,
            text_layout,
        );
        Self {
            dialog,
            title,
            search_box,
            search_value: search_input.text().to_owned(),
            message: None,
            ids,
            style,
            dispatch,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>, kind: QuickInputMessageKind) -> Self {
        self.message = Some((message.into(), kind));
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.dialog.bounds()
    }

    pub fn content_bounds(&self) -> Rect {
        let panel = self.dialog.bounds();
        let top = panel.origin.y + TITLE_HEIGHT + SEARCH_HEIGHT + SEARCH_BOTTOM_GAP;
        Rect::from_xywh(
            panel.origin.x + CONTENT_INSET,
            top,
            panel.size.width - CONTENT_INSET * 2.0,
            (panel.bottom() - FOOTER_HEIGHT - top).max(0.0),
        )
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.search_box.caret_bounds()
    }

    pub const fn style(&self) -> &QuickInputStyle {
        &self.style
    }

    pub const fn root_id(&self) -> ElementId {
        self.dialog.root_id()
    }

    fn close_bounds(&self) -> Rect {
        let panel = self.dialog.bounds();
        Rect::from_xywh(panel.right() - 42.0, panel.origin.y + 11.0, 28.0, 28.0)
    }

    fn close_region(&self) -> InteractionRegion {
        InteractionRegion::new(
            "QuickInputClose",
            self.ids.close,
            self.close_bounds(),
            AccessibilityRole::Button,
            format!("Close {}", self.title),
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
    }

    fn search_region(&self) -> InteractionRegion {
        InteractionRegion::new(
            "QuickInputSearch",
            self.ids.search,
            self.search_box.bounds(),
            AccessibilityRole::TextInput,
            format!("Search {}", self.title),
        )
        .with_cursor(CursorFeedback::Text)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_value(self.search_value.clone())
    }

    fn paint_shell(&self, scene: &mut UiScene) {
        self.dialog.paint_shell(scene);
        let panel = self.dialog.bounds();
        draw_label(
            scene,
            &self.title,
            Point::new(panel.origin.x + 20.0, panel.origin.y + 14.0),
            Size::new(panel.size.width - 80.0, 24.0),
            TextStyle::new(17.0, self.style.text).with_line_height(22.0),
        );
        let close = self.close_bounds();
        if self.dispatch.is_hovered(self.ids.close) || self.dispatch.is_focused(self.ids.close) {
            scene.draw_rect(
                PaintRect::new(close, self.style.close_hovered)
                    .with_corner_radii(CornerRadii::uniform(4.0)),
            );
        }
        draw_label(
            scene,
            "×",
            close.origin,
            close.size,
            TextStyle::new(18.0, self.style.text_muted).with_line_height(24.0),
        );
        scene.draw_component(&self.search_box);
        if let Some((message, kind)) = &self.message {
            let color = match kind {
                QuickInputMessageKind::Status => self.style.text_muted,
                QuickInputMessageKind::Error => self.style.text_error,
            };
            draw_label(
                scene,
                message,
                Point::new(panel.origin.x + 20.0, panel.bottom() - 32.0),
                Size::new(panel.size.width - 40.0, 18.0),
                TextStyle::new(12.0, color).with_line_height(18.0),
            );
        }
    }

    pub fn draw_components(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_content: impl FnOnce(&mut ComponentContext<'_, '_>, Rect),
    ) {
        context.with_component(self, |context, _element| {
            context.set_modal_root(self.dialog.root_id());
            self.paint_shell(context.scene_mut());
            context.draw_component(&self.close_region());
            context.draw_component(&self.search_region());
            context.with_clip(self.content_bounds(), |context| {
                draw_content(context, self.content_bounds());
            });
        });
    }

    pub fn paint_content(
        &self,
        scene: &mut UiScene,
        paint_content: impl FnOnce(&mut UiScene, Rect),
    ) {
        scene.with_element(self.element(), |scene, _element| {
            self.paint_shell(scene);
            scene.with_clip(self.content_bounds(), |scene| {
                paint_content(scene, self.content_bounds());
            });
        });
    }
}

impl Component for QuickInput<'_> {
    fn element(&self) -> ComponentElement {
        self.dialog.element_with_name("QuickInput")
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(self.dialog.root_interaction_node(element))
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.set_modal_root(self.dialog.root_id());
        self.paint_shell(context.scene_mut());
        context.draw_component(&self.close_region());
        context.draw_component(&self.search_region());
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.paint_shell(scene);
    }
}

fn draw_label(scene: &mut UiScene, label: &str, origin: Point, size: Size, style: TextStyle) {
    scene.draw_text(TextBlock::new(label.to_owned(), origin, size, style));
}

#[cfg(test)]
#[path = "quick_input_tests.rs"]
mod tests;
