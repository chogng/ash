use super::ChatComposerView;
use super::input;
use crate::render::RenderContext;
use crate::render::Renderable;
use crate::thread::composer as chat_input;
use crate::thread::composer::ChatInputCursor;
use crate::thread::composer::ChatInputFocus;
use ratatui::Frame;
use ratatui::layout::Rect;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatComposerPointerTarget {
    Input,
    CompletionSurface,
    CompletionItem(usize),
}

pub(crate) struct ChatComposerSurface<'a, 'view> {
    pub(crate) view: &'view ChatComposerView<'a>,
    pub(crate) cursor: ChatInputCursor,
    pub(crate) focus: ChatInputFocus,
    pub(crate) chrome: chat_input::ChatInputChrome,
}

impl Renderable for ChatComposerSurface<'_, '_> {
    fn desired_height(&self, width: u16, _context: RenderContext<'_>) -> u16 {
        self.view
            .input_desired_height(width.saturating_sub(self.chrome.inset(width)))
    }

    fn render(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>) {
        chat_input::draw_chat_input(
            frame,
            area,
            self.view.input(),
            self.view.input_cursor_width(),
            self.view.input_cursor_line(),
            self.view.input_selection(),
            self.view.input_scroll_row(),
            self.view.input_prompt(),
            if self.view.searching_history() {
                ChatInputCursor::Hidden
            } else {
                self.cursor
            },
            self.focus,
            self.chrome,
            self.view.argument_hint(),
            context,
        );
        if let Some(status) = self.view.history_status() {
            let content = match self.chrome {
                chat_input::ChatInputChrome::Rules => chat_input::content_area(area),
                chat_input::ChatInputChrome::Box => {
                    crate::render::horizontal_margin(self.chrome.border_area(area), 2)
                }
            };
            frame.render_widget(
                ratatui::widgets::Paragraph::new(status)
                    .style(ratatui::style::Style::default().fg(context.foreground())),
                Rect::new(content.x, area.y, content.width, 1),
            );
        }
    }
}

pub(crate) fn draw_completion_layer(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &ChatComposerView<'_>,
    hovered: Option<ChatComposerPointerTarget>,
    pressed: Option<ChatComposerPointerTarget>,
    context: RenderContext<'_>,
) {
    chat_input::draw_completion(
        frame,
        area,
        view.input_completion(),
        match hovered {
            Some(
                ChatComposerPointerTarget::Input | ChatComposerPointerTarget::CompletionSurface,
            ) => None,
            Some(ChatComposerPointerTarget::CompletionItem(index)) => Some(index),
            None => None,
        },
        match pressed {
            Some(
                ChatComposerPointerTarget::Input | ChatComposerPointerTarget::CompletionSurface,
            ) => None,
            Some(ChatComposerPointerTarget::CompletionItem(index)) => Some(index),
            None => None,
        },
        context,
    );
}

pub(crate) fn pointer_target_at(
    overlay_area: Rect,
    view: &ChatComposerView<'_>,
    completion_visible: bool,
    column: u16,
    row: u16,
    language: crate::nls::Language,
) -> Option<ChatComposerPointerTarget> {
    if !completion_visible {
        return None;
    }
    if let Some(index) = chat_input::completion_index_at(
        overlay_area,
        view.input_completion(),
        column,
        row,
        language,
    ) {
        return Some(ChatComposerPointerTarget::CompletionItem(index));
    }
    completion_contains(overlay_area, view, column, row, language)
        .then_some(ChatComposerPointerTarget::CompletionSurface)
}

pub(crate) fn completion_contains(
    overlay_area: Rect,
    view: &ChatComposerView<'_>,
    column: u16,
    row: u16,
    language: crate::nls::Language,
) -> bool {
    input::completion_contains(overlay_area, view.input_completion(), column, row, language)
}
