//! ChatInput layout owned by one Agent Session Pane.

use ash_ui_components::ScrollCommand;
use ash_ui_components::VirtualListLayout;
use zui::ui::{Rect, Size};

const CONTENT_HORIZONTAL_INSET: f32 = 24.0;
const PANEL_TOP_INSET: f32 = 8.0;
const PANEL_BOTTOM_INSET: f32 = 12.0;
const PANEL_SECTION_GAP: f32 = 8.0;
const KEY_HINT_BAR_HEIGHT: f32 = 24.0;
const HINT_EDITOR_SEPARATOR_HEIGHT: f32 = 1.0;
const TOOLBAR_HEIGHT: f32 = 24.0;
const MIN_OUTPUT_HEIGHT: f32 = 40.0;
const INTERACTION_HEADER_HEIGHT: f32 = 30.0;
const MAX_VISIBLE_INTERACTION_ROWS: usize = 8;

/// Logical height of one ChatInput interaction item.
pub const INTERACTION_ROW_HEIGHT: f32 = 34.0;

/// Resolved geometry for the ChatInput mounted at the bottom of a chat surface.
///
/// The layout keeps the editor, information bar, and toolbar fixed while the interaction area
/// list grows upward. The host owns the preferred heights and decides how to paint and register
/// each returned region.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ComposerPanelLayout {
    panel: Rect,
    interaction: Option<Rect>,
    content: Rect,
    key_hint_bar: Rect,
    hint_editor_separator: Rect,
    editor: Rect,
    toolbar: Rect,
    output: Rect,
}

impl ComposerPanelLayout {
    /// Resolves ChatInput regions inside `main` while preserving a minimum output surface.
    pub fn for_main(
        main: Rect,
        preferred_editor_height: f32,
        preferred_interaction_height: f32,
    ) -> Self {
        let editor_height = preferred_editor_height.max(1.0);
        let base_height = PANEL_TOP_INSET
            + KEY_HINT_BAR_HEIGHT
            + PANEL_SECTION_GAP
            + editor_height
            + PANEL_SECTION_GAP
            + TOOLBAR_HEIGHT
            + PANEL_BOTTOM_INSET;
        let requested_interaction_gap = if preferred_interaction_height > 0.0 {
            PANEL_SECTION_GAP
        } else {
            0.0
        };
        let maximum_interaction_height =
            (main.size.height - base_height - requested_interaction_gap - MIN_OUTPUT_HEIGHT)
                .max(0.0);
        let interaction_height = preferred_interaction_height
            .max(0.0)
            .min(maximum_interaction_height);
        let interaction_gap = if interaction_height > 0.0 {
            PANEL_SECTION_GAP
        } else {
            0.0
        };
        let panel_height = base_height + interaction_height + interaction_gap;
        let panel = Rect::from_xywh(
            main.origin.x,
            main.bottom() - panel_height,
            main.size.width,
            panel_height,
        );
        let content_x = main.origin.x + CONTENT_HORIZONTAL_INSET;
        let content_width = (main.size.width - CONTENT_HORIZONTAL_INSET * 2.0).max(1.0);
        let interaction = (interaction_height > 0.0).then(|| {
            Rect::from_xywh(
                content_x,
                panel.origin.y + PANEL_TOP_INSET,
                content_width,
                interaction_height,
            )
        });
        let toolbar = Rect::from_xywh(
            content_x,
            panel.bottom() - PANEL_BOTTOM_INSET - TOOLBAR_HEIGHT,
            content_width,
            TOOLBAR_HEIGHT,
        );
        let editor = Rect::from_xywh(
            content_x,
            toolbar.origin.y - PANEL_SECTION_GAP - editor_height,
            content_width,
            editor_height,
        );
        let key_hint_bar = Rect::from_xywh(
            content_x,
            editor.origin.y - PANEL_SECTION_GAP - KEY_HINT_BAR_HEIGHT,
            content_width,
            KEY_HINT_BAR_HEIGHT,
        );
        let content = Rect::from_xywh(
            content_x,
            key_hint_bar.origin.y,
            content_width,
            toolbar.bottom() - key_hint_bar.origin.y,
        );
        let hint_editor_separator = Rect::from_xywh(
            panel.origin.x,
            editor.origin.y - HINT_EDITOR_SEPARATOR_HEIGHT,
            panel.size.width,
            HINT_EDITOR_SEPARATOR_HEIGHT,
        );
        let output = Rect::from_xywh(
            main.origin.x,
            main.origin.y,
            main.size.width,
            (panel.origin.y - main.origin.y).max(1.0),
        );
        Self {
            panel,
            interaction,
            content,
            key_hint_bar,
            hint_editor_separator,
            editor,
            toolbar,
            output,
        }
    }

    /// Returns the full ChatInput bounds.
    pub const fn panel(self) -> Rect {
        self.panel
    }

    /// Returns the optional interaction-list bounds.
    pub const fn interaction(self) -> Option<Rect> {
        self.interaction
    }

    /// Returns the shared content bounds containing the key hints, editor, and toolbar.
    pub const fn content(self) -> Rect {
        self.content
    }

    /// Returns the key-hint bar bounds.
    pub const fn key_hint_bar(self) -> Rect {
        self.key_hint_bar
    }

    /// Returns the one-pixel separator between the key hints and editor.
    pub const fn hint_editor_separator(self) -> Rect {
        self.hint_editor_separator
    }

    /// Returns the editor bounds.
    pub const fn editor(self) -> Rect {
        self.editor
    }

    /// Returns the input toolbar bounds.
    pub const fn toolbar(self) -> Rect {
        self.toolbar
    }

    /// Returns the chat content bounds above the ChatInput.
    pub const fn output(self) -> Rect {
        self.output
    }
}

/// Computes the preferred height for an interaction list with `item_count` entries.
pub fn interaction_preferred_height(item_count: usize) -> f32 {
    let rows = item_count.clamp(1, MAX_VISIBLE_INTERACTION_ROWS);
    INTERACTION_HEADER_HEIGHT + rows as f32 * INTERACTION_ROW_HEIGHT
}

/// Returns the content viewport below an interaction list header and inside its border.
pub fn interaction_list_bounds(bounds: Rect) -> Rect {
    Rect::from_xywh(
        bounds.origin.x + 1.0,
        bounds.origin.y + INTERACTION_HEADER_HEIGHT,
        (bounds.size.width - 2.0).max(1.0),
        (bounds.size.height - INTERACTION_HEADER_HEIGHT - 1.0).max(1.0),
    )
}

/// Computes the scrollable content size for a fixed-height interaction list.
pub fn interaction_content_size(viewport: Rect, item_count: usize) -> Size {
    VirtualListLayout::new(item_count, INTERACTION_ROW_HEIGHT).content_size(viewport.size.width)
}

/// Creates the scroll command that reveals one interaction item, if `index` is valid.
pub fn interaction_selection_scroll_command(
    index: usize,
    item_count: usize,
    content_width: f32,
) -> Option<ScrollCommand> {
    VirtualListLayout::new(item_count, INTERACTION_ROW_HEIGHT)
        .ensure_visible_command(index, content_width)
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
