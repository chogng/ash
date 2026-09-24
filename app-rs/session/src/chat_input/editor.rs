use ash_editor::CodeEditor;
use ash_editor::CodeEditorCaretStyle;
use ash_editor::CodeEditorCommand;
use ash_editor::CodeEditorDocument;
use ash_editor::CodeEditorHeader;
use ash_editor::CodeEditorLanguage;
use ash_editor::CodeEditorNavigation;
use ash_editor::CodeEditorPresentation;
use ash_editor::CodeEditorRowSource;
use ash_editor::CodeEditorSelectionMode;
use ash_editor::CodeEditorStyle;
use ash_editor::CodeEditorTextEdit;
use ash_editor::CodeEditorViewport;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentElement;
use zui::ui::Element;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextBlock;
use zui::ui::TextInputCompositionEvent;
use zui::ui::UiScene;

const MAX_VISIBLE_ROWS: usize = 8;
const EDITOR_VERTICAL_PADDING: f32 = 12.0;

/// Focus state used by the compact ChatInput editor.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ChatInputFocus {
    #[default]
    Blurred,
    Focused(CaretVisibility),
}

/// Multiline document and retained viewport for one Session Pane ChatInput.
pub struct ChatInputEditor {
    document: CodeEditorDocument,
    viewport: CodeEditorViewport,
    style: CodeEditorStyle,
    ghost_text: Option<String>,
}

impl Default for ChatInputEditor {
    fn default() -> Self {
        Self {
            document: CodeEditorDocument::from_text(""),
            viewport: CodeEditorViewport::default(),
            style: CodeEditorStyle::light(),
            ghost_text: None,
        }
    }
}

impl ChatInputEditor {
    pub(crate) fn take_draft(&mut self) -> Self {
        let empty = Self {
            style: self.style.clone(),
            ..Self::default()
        };
        std::mem::replace(self, empty)
    }

    pub fn text(&self) -> &str {
        self.document.text()
    }

    pub fn selected_text(&self) -> Option<&str> {
        self.document.selected_text()
    }

    pub(crate) fn cursor(&self) -> usize {
        self.document.cursor()
    }

    pub(crate) fn has_active_composition(&self) -> bool {
        self.document.composition().is_some()
    }

    #[cfg(test)]
    pub(crate) fn ghost_text(&self) -> Option<&str> {
        self.ghost_text.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn language(&self) -> CodeEditorLanguage {
        self.document.language()
    }

    pub(crate) fn row_count(&self) -> usize {
        self.document.row_count()
    }

    pub(crate) fn visible_row_count(&self) -> usize {
        self.row_count().clamp(1, MAX_VISIBLE_ROWS)
    }

    pub fn preferred_height(&self) -> f32 {
        self.visible_row_count() as f32 * self.style.row_height() + EDITOR_VERTICAL_PADDING * 2.0
    }

    pub(crate) fn apply(&mut self, command: CodeEditorCommand) {
        self.hide_ghost_text();
        self.document.apply_in_view(
            command,
            CodeEditorNavigation::LogicalLines {
                page_rows: MAX_VISIBLE_ROWS,
            },
        );
        self.reveal_caret();
    }

    pub(crate) fn apply_text_edit(&mut self, edit: CodeEditorTextEdit) -> bool {
        self.hide_ghost_text();
        let applied = self.document.apply_text_edit(edit);
        if applied {
            self.reveal_caret();
        }
        applied
    }

    pub(crate) fn apply_composition(&mut self, event: TextInputCompositionEvent) {
        self.hide_ghost_text();
        self.document.apply_composition(event);
        self.reveal_caret();
    }

    pub(crate) fn cancel_composition(&mut self) {
        self.document.cancel_composition();
    }

    pub(crate) fn clear(&mut self) {
        self.hide_ghost_text();
        self.document.replace_text("");
        self.viewport = CodeEditorViewport::default();
    }

    pub(crate) fn set_text(&mut self, text: impl Into<String>) {
        self.hide_ghost_text();
        self.document.replace_text(text);
        self.document.apply(CodeEditorCommand::SelectAll);
        self.document
            .apply(CodeEditorCommand::MoveRight(CodeEditorSelectionMode::Move));
        self.reveal_caret();
    }

    pub(crate) fn set_language(&mut self, language: CodeEditorLanguage) {
        self.document.set_language(language);
    }

    pub(crate) fn set_style(&mut self, style: CodeEditorStyle) {
        self.style = style;
    }

    pub(crate) fn show_ghost_text(&mut self, text: String) {
        self.ghost_text = (!text.is_empty()).then_some(text);
    }

    pub(crate) fn hide_ghost_text(&mut self) {
        self.ghost_text = None;
    }

    pub(crate) fn is_collapsed_at_first_row(&self) -> bool {
        self.document.anchor() == self.document.cursor()
            && self
                .document
                .caret()
                .is_some_and(|caret| caret.row_index == 0)
    }

    pub(crate) fn is_collapsed_at_last_row(&self) -> bool {
        self.document.anchor() == self.document.cursor()
            && self
                .document
                .caret()
                .is_some_and(|caret| caret.row_index + 1 == self.document.row_count())
    }

    pub(crate) fn move_caret_to_point(
        &mut self,
        bounds: Rect,
        point: Point,
        mode: CodeEditorSelectionMode,
    ) -> bool {
        self.hide_ghost_text();
        let editor = self.code_editor(bounds, CaretVisibility::Visible);
        let content_bounds = editor_content_bounds(bounds);
        let point = Point::new(
            point.x,
            point
                .y
                .clamp(content_bounds.origin.y, content_bounds.bottom() - 1.0),
        );
        let Some(position) = editor.text_position_at(point) else {
            return false;
        };
        self.document.move_to(position, mode);
        self.reveal_caret();
        true
    }

    pub fn view<'a>(
        &'a self,
        bounds: Rect,
        placeholder: &'a str,
        focus: ChatInputFocus,
        placeholder_color: Color,
    ) -> ChatInputView<'a> {
        ChatInputView {
            bounds,
            input: self,
            placeholder,
            focus,
            placeholder_color,
        }
    }

    fn reveal_caret(&mut self) {
        let Some(caret) = self.document.caret() else {
            return;
        };
        self.viewport
            .reveal_row(caret.row_index, self.document.row_count(), MAX_VISIBLE_ROWS);
    }

    fn code_editor(&self, bounds: Rect, caret_visibility: CaretVisibility) -> CodeEditor<'_> {
        CodeEditor::new(
            editor_content_bounds(bounds),
            &self.document,
            self.viewport,
            CodeEditorHeader::Hidden,
            self.style.clone(),
        )
        .with_presentation(CodeEditorPresentation::Compact)
        .with_content_horizontal_padding(0.0)
        .with_caret_visibility(caret_visibility)
        .with_caret_style(CodeEditorCaretStyle::Block)
    }
}

/// Compact CodeEditor view with ChatInput placeholder semantics.
pub struct ChatInputView<'a> {
    bounds: Rect,
    input: &'a ChatInputEditor,
    placeholder: &'a str,
    focus: ChatInputFocus,
    placeholder_color: Color,
}

impl ChatInputView<'_> {
    pub fn caret_bounds(&self) -> Option<Rect> {
        let ChatInputFocus::Focused(CaretVisibility::Visible) = self.focus else {
            return None;
        };
        self.input
            .code_editor(self.bounds, CaretVisibility::Visible)
            .caret_bounds()
    }
}

impl Component for ChatInputView<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("ChatInput").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        let caret_visibility = match self.focus {
            ChatInputFocus::Blurred => CaretVisibility::Hidden,
            ChatInputFocus::Focused(visibility) => visibility,
        };
        let mut editor = self.input.code_editor(self.bounds, caret_visibility);
        if matches!(self.focus, ChatInputFocus::Focused(_))
            && let Some(ghost_text) = self.input.ghost_text.as_deref()
        {
            editor = editor.with_ghost_text(ghost_text);
        }
        scene.draw_component(&editor);
        if self.input.text().is_empty() {
            scene.with_clip(self.bounds, |scene| {
                scene.draw_text(TextBlock::new(
                    self.placeholder,
                    Point::new(
                        self.bounds.origin.x,
                        self.bounds.origin.y + EDITOR_VERTICAL_PADDING,
                    ),
                    zui::ui::Size::new(
                        self.bounds.size.width,
                        (self.bounds.size.height - EDITOR_VERTICAL_PADDING * 2.0).max(0.0),
                    ),
                    self.input.style.text_with_color(self.placeholder_color),
                ));
            });
        }
    }
}

fn editor_content_bounds(bounds: Rect) -> Rect {
    Rect::from_xywh(
        bounds.origin.x,
        bounds.origin.y + EDITOR_VERTICAL_PADDING,
        bounds.size.width,
        (bounds.size.height - EDITOR_VERTICAL_PADDING * 2.0).max(0.0),
    )
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
