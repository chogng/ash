//! Host-resolved colors and shared component styles for Remote overlays.

use ash_icons::icons;
use ash_ui_components::{InputBoxStateColors, InputBoxStyle, ScrollViewStyle, SearchBoxStyle};
use ash_ui_theme::UiTheme;
use zui::ui::{CornerRadii, Edges, TextStyle};

/// Colors and shared component styles needed by Remote overlays.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RemoteUiStyle {
    pub surface: zui::ui::Color,
    pub surface_raised: zui::ui::Color,
    pub surface_hovered: zui::ui::Color,
    pub border: zui::ui::Color,
    pub text: zui::ui::Color,
    pub text_muted: zui::ui::Color,
    pub accent: zui::ui::Color,
    pub error: zui::ui::Color,
    pub terminal_selection: zui::ui::Color,
    pub session_tab_highlight: zui::ui::Color,
    file_list_scroll_view: ScrollViewStyle,
    picker_scroll_view: ScrollViewStyle,
}

impl RemoteUiStyle {
    pub fn from_theme(theme: UiTheme) -> Self {
        Self::new(
            theme.content_background,
            theme.side_bar_background,
            theme.list_hover_background,
            theme.border,
            theme.foreground,
            theme.muted_foreground,
            theme.accent,
            theme.error,
            theme.text_selection_background,
            theme.list_active_background,
            theme.file_list_scroll_view_style(),
            theme.picker_scroll_view_style(),
        )
    }

    /// Creates resolved style values for all Remote overlays.
    #[allow(clippy::too_many_arguments)]
    pub const fn new(
        surface: zui::ui::Color,
        surface_raised: zui::ui::Color,
        surface_hovered: zui::ui::Color,
        border: zui::ui::Color,
        text: zui::ui::Color,
        text_muted: zui::ui::Color,
        accent: zui::ui::Color,
        error: zui::ui::Color,
        terminal_selection: zui::ui::Color,
        session_tab_highlight: zui::ui::Color,
        file_list_scroll_view: ScrollViewStyle,
        picker_scroll_view: ScrollViewStyle,
    ) -> Self {
        Self {
            surface,
            surface_raised,
            surface_hovered,
            border,
            text,
            text_muted,
            accent,
            error,
            terminal_selection,
            session_tab_highlight,
            file_list_scroll_view,
            picker_scroll_view,
        }
    }

    pub(crate) const fn file_list_scroll_view_style(self) -> ScrollViewStyle {
        self.file_list_scroll_view
    }

    pub(crate) const fn picker_scroll_view_style(self) -> ScrollViewStyle {
        self.picker_scroll_view
    }

    pub(crate) fn session_search_style(self) -> SearchBoxStyle {
        let input_box = InputBoxStyle::new(
            InputBoxStateColors::new(
                zui::ui::Color::TRANSPARENT,
                zui::ui::Color::TRANSPARENT,
                zui::ui::Color::TRANSPARENT,
            ),
            InputBoxStateColors::new(
                zui::ui::Color::TRANSPARENT,
                zui::ui::Color::TRANSPARENT,
                zui::ui::Color::TRANSPARENT,
            ),
            TextStyle::new(11.0, self.text).with_line_height(16.0),
            TextStyle::new(11.0, self.text_muted).with_line_height(16.0),
        )
        .with_border_width(0.0)
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_padding(Edges::new(4.0, 8.0, 4.0, 8.0))
        .with_selection_color(self.terminal_selection)
        .with_caret_color(self.accent)
        .with_preedit_underline_color(self.accent);
        SearchBoxStyle::new(input_box, icons::SEARCH, self.text_muted).with_icon_size(18.0)
    }
}
