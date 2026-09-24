//! Chat content and ChatInput composition owned by one Session Pane.

use std::path::PathBuf;

use ash_ui_components::InteractionRegion;
use zui::ui::AccessibilityRole;
use zui::ui::CaretVisibility;
use zui::ui::ComponentContext;
use zui::ui::CursorFeedback;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;

use crate::ComposerPanelLayout;
use crate::SessionPaneContext;
use crate::SessionPaneStyle;
use crate::ThreadTimeline;
use crate::ThreadTimelineScroll;
use crate::ThreadTimelineStyle;
use crate::TranscriptState;
use crate::chat_input::ChatInput;
use crate::chat_input::ChatInputView;
use crate::chat_input::draw_chat_input;
use crate::interaction::THREAD_TIMELINE;

/// Complete retained state for the chat content and ChatInput surfaces.
pub(crate) struct ChatWidgetState {
    transcript: TranscriptState,
    timeline_scroll: ThreadTimelineScroll,
    input: ChatInput,
}

impl ChatWidgetState {
    pub(crate) fn for_working_directory(working_directory: impl Into<PathBuf>) -> Self {
        Self {
            transcript: TranscriptState::default(),
            timeline_scroll: ThreadTimelineScroll::default(),
            input: ChatInput::for_working_directory(working_directory),
        }
    }

    pub(crate) const fn transcript(&self) -> &TranscriptState {
        &self.transcript
    }

    pub(crate) fn transcript_mut(&mut self) -> &mut TranscriptState {
        &mut self.transcript
    }

    pub(crate) const fn timeline_scroll(&self) -> &ThreadTimelineScroll {
        &self.timeline_scroll
    }

    pub(crate) fn timeline_scroll_mut(&mut self) -> &mut ThreadTimelineScroll {
        &mut self.timeline_scroll
    }

    pub(crate) const fn input(&self) -> &ChatInput {
        &self.input
    }

    pub(crate) fn input_mut(&mut self) -> &mut ChatInput {
        &mut self.input
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ChatWidgetLayout {
    timeline: Rect,
    input: ComposerPanelLayout,
}

impl ChatWidgetLayout {
    pub(crate) const fn new(timeline: Rect, input: ComposerPanelLayout) -> Self {
        Self { timeline, input }
    }

    pub(crate) const fn timeline(self) -> Rect {
        self.timeline
    }

    pub(crate) const fn input(self) -> ComposerPanelLayout {
        self.input
    }
}

pub(crate) struct ChatWidgetView<'a> {
    pub(crate) state: &'a ChatWidgetState,
    pub(crate) context: &'a SessionPaneContext,
    pub(crate) caret_visibility: CaretVisibility,
    pub(crate) dispatch: &'a UiDispatch,
    pub(crate) parent: ElementId,
}

pub(crate) fn draw_chat_widget(
    component_context: &mut ComponentContext<'_, '_>,
    layout: ChatWidgetLayout,
    view: ChatWidgetView<'_>,
    text_layout: &mut TextInputLayoutEngine,
    style: SessionPaneStyle,
) -> Option<Rect> {
    let timeline = InteractionRegion::new(
        "ThreadTimeline",
        THREAD_TIMELINE,
        layout.timeline(),
        AccessibilityRole::Group,
        "Agent Thread timeline",
    )
    .with_parent(view.parent)
    .with_cursor(CursorFeedback::Text);
    component_context.with_component(&timeline, |component_context, _| {
        component_context.draw_component(&ThreadTimeline::new(
            layout.timeline(),
            view.state.transcript(),
            view.state.timeline_scroll().offset(),
            ThreadTimelineStyle::new(
                style.surface_raised,
                style.text,
                style.text_muted,
                style.error,
            ),
        ));
    });
    draw_chat_input(
        component_context,
        layout.input(),
        ChatInputView {
            input: view.state.input(),
            context: view.context,
            caret_visibility: view.caret_visibility,
            dispatch: view.dispatch,
            parent: view.parent,
        },
        text_layout,
        style,
    )
}
