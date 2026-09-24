use ash_ui_components::InteractionRegion;
use zui::ui::{AccessibilityRole, CursorFeedback, FocusBehavior, UiDispatch};
use zui::ui::{
    Border, CaretVisibility, Component, ComponentContext, ComponentElement, Edges, Element,
    ElementId, PaintRect, Rect, TextInputLayoutEngine,
};

use crate::SessionPaneContext;
use crate::SessionPaneStyle;
use crate::interaction::{COMPOSER, COMPOSER_PANEL};

use super::ChatInput;
use super::ComposerPanelLayout;
use super::ComposerRoute;
use super::editor::ChatInputFocus;
use super::interaction_view::draw_chat_input_interaction;
use super::key_hint_bar::KeyHintBar;
use super::toolbar::ChatInputToolbar;

#[derive(Clone, Copy)]
pub(crate) struct ChatInputView<'a> {
    pub(crate) input: &'a ChatInput,
    pub(crate) context: &'a SessionPaneContext,
    pub(crate) caret_visibility: CaretVisibility,
    pub(crate) dispatch: &'a UiDispatch,
    pub(crate) parent: ElementId,
}

struct ComposerContent {
    bounds: Rect,
}

impl Component for ComposerContent {
    fn element(&self) -> ComponentElement {
        Element::column("ComposerContent").in_bounds(self.bounds)
    }
}

pub(crate) fn draw_chat_input(
    context: &mut ComponentContext<'_, '_>,
    layout: ComposerPanelLayout,
    view: ChatInputView<'_>,
    text_layout: &mut TextInputLayoutEngine,
    style: SessionPaneStyle,
) -> Option<Rect> {
    let panel = InteractionRegion::new(
        "ComposerPanel",
        COMPOSER_PANEL,
        layout.panel(),
        AccessibilityRole::Group,
        "Command composer",
    )
    .with_parent(view.parent);
    context.with_component(&panel, |context, _| {
        context.scene_mut().draw_rect(
            PaintRect::new(layout.panel(), style.surface)
                .with_border(Border::new(Edges::new(1.0, 0.0, 0.0, 0.0), style.border)),
        );
        if let (Some(bounds), Some(interaction)) =
            (layout.interaction(), view.input.interaction().view())
        {
            draw_chat_input_interaction(
                context,
                bounds,
                interaction,
                view.input.interaction_scroll(),
                view.dispatch,
                style,
            );
        }
        context
            .scene_mut()
            .draw_rect(PaintRect::new(layout.hint_editor_separator(), style.border));
        context.with_component(
            &ComposerContent {
                bounds: layout.content(),
            },
            |context, _| {
                let history_status = view.input.history_status();
                context.draw_component(
                    &KeyHintBar::new(layout.key_hint_bar(), view.input.route(), style)
                        .with_history_status(history_status.as_deref()),
                );
                context.draw_component(
                    &InteractionRegion::new(
                        "ComposerInput",
                        COMPOSER,
                        layout.editor(),
                        AccessibilityRole::TextInput,
                        "Command input",
                    )
                    .with_parent(COMPOSER_PANEL)
                    .with_cursor(CursorFeedback::Text)
                    .with_focus(FocusBehavior::TabStop)
                    .with_value(view.input.input().text()),
                );
                let editor_focus = if view.dispatch.is_focused(COMPOSER) {
                    ChatInputFocus::Focused(view.caret_visibility)
                } else {
                    ChatInputFocus::Blurred
                };
                let placeholder = match view.input.route() {
                    ComposerRoute::Agent => "Ask Ash anything…",
                    ComposerRoute::Shell => "Enter a shell command…",
                };
                let editor = view.input.input().view(
                    layout.editor(),
                    placeholder,
                    editor_focus,
                    style.text_muted,
                );
                let caret_bounds = editor.caret_bounds();
                context.draw_component(&editor);
                let toolbar = ChatInputToolbar::new(
                    layout.toolbar(),
                    view.context,
                    style,
                    text_layout,
                    view.dispatch,
                );
                context.draw_component(&toolbar);
                caret_bounds
            },
        )
    })
}
