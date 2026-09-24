use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use zui::ui::Border;
use zui::ui::Color;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::Rect;
use zui::ui::TextStyle;

use crate::remote::remote_connection_manager::RemoteConnectionManagerField;
use crate::remote::style::RemoteUiStyle;

pub(crate) const PANEL_WIDTH: f32 = 720.0;
pub(crate) const PANEL_HEIGHT: f32 = 470.0;
pub(crate) const PANEL_MARGIN: f32 = 20.0;
pub(crate) const CONTENT_INSET: f32 = 22.0;
pub(crate) const TITLE_HEIGHT: f32 = 26.0;
const LIST_WIDTH: f32 = 210.0;
const LIST_TOP: f32 = 76.0;
const LIST_BOTTOM: f32 = 70.0;
const COLUMN_GAP: f32 = 24.0;
const INPUT_HEIGHT: f32 = 36.0;
const BUTTON_HEIGHT: f32 = 34.0;

pub(crate) fn list_bounds(panel: Rect) -> Rect {
    Rect::from_xywh(
        panel.origin.x + CONTENT_INSET,
        panel.origin.y + LIST_TOP,
        LIST_WIDTH.min((panel.size.width * 0.32).max(120.0)),
        (panel.size.height - LIST_TOP - LIST_BOTTOM).max(1.0),
    )
}

pub(crate) fn form_left(panel: Rect) -> f32 {
    let list = list_bounds(panel);
    list.right() + COLUMN_GAP
}

pub(crate) fn input_bounds(panel: Rect, field: RemoteConnectionManagerField) -> Rect {
    let top = match field {
        RemoteConnectionManagerField::Name => 100.0,
        RemoteConnectionManagerField::Host => 177.0,
        RemoteConnectionManagerField::Directory => 254.0,
    };
    let left = form_left(panel);
    Rect::from_xywh(
        left,
        panel.origin.y + top,
        (panel.right() - CONTENT_INSET - left).max(1.0),
        INPUT_HEIGHT,
    )
}

pub(crate) fn status_bounds(panel: Rect) -> Rect {
    let left = form_left(panel);
    Rect::from_xywh(
        left,
        panel.origin.y + 306.0,
        (panel.right() - CONTENT_INSET - left).max(1.0),
        40.0,
    )
}

pub(crate) fn close_bounds(panel: Rect) -> Rect {
    Rect::from_xywh(panel.right() - 48.0, panel.origin.y + 12.0, 32.0, 32.0)
}

pub(crate) fn new_bounds(panel: Rect) -> Rect {
    let list = list_bounds(panel);
    Rect::from_xywh(
        list.origin.x,
        panel.bottom() - 50.0,
        list.size.width,
        BUTTON_HEIGHT,
    )
}

pub(crate) fn delete_bounds(panel: Rect) -> Rect {
    Rect::from_xywh(
        form_left(panel),
        panel.bottom() - 50.0,
        120.0,
        BUTTON_HEIGHT,
    )
}

pub(crate) fn connect_bounds(panel: Rect) -> Rect {
    Rect::from_xywh(
        panel.right() - CONTENT_INSET - 104.0,
        panel.bottom() - 50.0,
        104.0,
        BUTTON_HEIGHT,
    )
}

pub(crate) fn save_bounds(panel: Rect) -> Rect {
    let connect = connect_bounds(panel);
    Rect::from_xywh(
        connect.origin.x - 90.0,
        connect.origin.y,
        78.0,
        BUTTON_HEIGHT,
    )
}

pub(crate) fn list_button_style(palette: RemoteUiStyle) -> ButtonStyle {
    let resting = ButtonBackgrounds::new(Color::TRANSPARENT)
        .with_hovered(palette.surface_hovered)
        .with_focused(palette.surface_hovered)
        .with_pressed(palette.border);
    let selected = ButtonBackgrounds::new(palette.session_tab_highlight)
        .with_hovered(palette.session_tab_highlight)
        .with_focused(palette.session_tab_highlight)
        .with_pressed(palette.border);
    ButtonStyle::new(
        resting,
        TextStyle::new(13.0, palette.text).with_line_height(18.0),
    )
    .with_selected_backgrounds(selected)
    .with_leading_text()
    .with_padding(Edges::new(0.0, 10.0, 0.0, 10.0))
}

pub(crate) fn input_style(palette: RemoteUiStyle) -> InputBoxStyle {
    InputBoxStyle::new(
        InputBoxStateColors::new(
            palette.surface_raised,
            palette.surface_raised,
            palette.surface_raised,
        ),
        InputBoxStateColors::new(palette.border, palette.text_muted, palette.accent),
        TextStyle::new(13.0, palette.text).with_line_height(18.0),
        TextStyle::new(13.0, palette.text_muted).with_line_height(18.0),
    )
    .with_border_width(1.0)
    .with_corner_radii(CornerRadii::uniform(4.0))
    .with_padding(Edges::new(7.0, 9.0, 7.0, 9.0))
    .with_selection_color(palette.terminal_selection)
    .with_caret_color(palette.accent)
    .with_preedit_underline_color(palette.accent)
}

pub(crate) fn action_button_style(palette: RemoteUiStyle, primary: bool) -> ButtonStyle {
    let base = if primary {
        palette.accent
    } else {
        palette.surface_raised
    };
    ButtonStyle::new(
        ButtonBackgrounds::new(base)
            .with_hovered(palette.surface_hovered)
            .with_focused(palette.surface_hovered)
            .with_pressed(palette.border)
            .with_disabled(palette.surface),
        TextStyle::new(12.0, palette.text).with_line_height(18.0),
    )
    .with_disabled_text_style(TextStyle::new(12.0, palette.text_muted).with_line_height(18.0))
    .with_border(Border::uniform(1.0, palette.border))
    .with_corner_radii(CornerRadii::uniform(4.0))
    .with_padding(Edges::new(0.0, 10.0, 0.0, 10.0))
}
