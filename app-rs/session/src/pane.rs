//! Layout and presentation for one Agent Session Pane.

use zui::ui::CaretVisibility;
use zui::ui::ComponentContext;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;

mod canvas;
mod chat_widget;
mod context;
pub mod interaction;
mod state;
mod style;
mod timeline;
mod timeline_scroll;
mod transcript;

pub use canvas::SessionCanvasLayout;
pub use canvas::SessionHeader;
pub use canvas::SessionHeaderStyle;
pub use context::SessionPaneContext;
pub use state::SessionPaneState;
pub use style::SessionPaneStyle;
pub(crate) use timeline::ThreadTimeline;
pub(crate) use timeline::ThreadTimelineStyle;
pub(crate) use timeline::line_capacity;
pub(crate) use timeline::line_count;
pub use timeline_scroll::ThreadTimelineScroll;
pub use timeline_scroll::TimelineScrollDelta;
pub(crate) use transcript::TranscriptState;

use crate::ComposerPanelLayout;
use chat_widget::ChatWidgetLayout;
use chat_widget::ChatWidgetView;
use chat_widget::draw_chat_widget;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SessionPaneLayout {
    chat_widget: ChatWidgetLayout,
    canvas: SessionCanvasLayout,
}

impl SessionPaneLayout {
    pub fn for_bounds(
        bounds: Rect,
        preferred_composer_height: f32,
        preferred_interaction_height: f32,
    ) -> Self {
        let input = ComposerPanelLayout::for_main(
            bounds,
            preferred_composer_height,
            preferred_interaction_height,
        );
        let canvas = SessionCanvasLayout::for_output(input.output());
        Self {
            chat_widget: ChatWidgetLayout::new(canvas.timeline(), input),
            canvas,
        }
    }

    pub const fn header(self) -> Rect {
        self.canvas.header()
    }

    pub const fn timeline(self) -> Rect {
        self.chat_widget.timeline()
    }

    pub const fn composer(self) -> ComposerPanelLayout {
        self.chat_widget.input()
    }
}

pub struct SessionPaneView<'a> {
    pub title: &'a str,
    pub state: &'a SessionPaneState,
    pub context: &'a SessionPaneContext,
    pub caret_visibility: CaretVisibility,
    pub dispatch: &'a UiDispatch,
    pub parent: ElementId,
}

pub fn draw_session_pane(
    component_context: &mut ComponentContext<'_, '_>,
    layout: SessionPaneLayout,
    view: SessionPaneView<'_>,
    text_layout: &mut TextInputLayoutEngine,
    style: SessionPaneStyle,
) -> Option<Rect> {
    component_context.draw_component(&SessionHeader::new(
        layout.header(),
        view.title,
        view.context.metadata(),
        view.state.thread(),
        SessionHeaderStyle::new(
            style.surface,
            style.border,
            style.surface_raised,
            style.text,
            style.text_muted,
            style.success,
            style.accent,
            style.warning,
            style.error,
        ),
        view.parent,
    ));
    draw_chat_widget(
        component_context,
        layout.chat_widget,
        ChatWidgetView {
            state: view.state.chat_widget(),
            context: view.context,
            caret_visibility: view.caret_visibility,
            dispatch: view.dispatch,
            parent: view.parent,
        },
        text_layout,
        style,
    )
}
