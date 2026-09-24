use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use zui::ui::Border;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::TextStyle;

use crate::remote::style::RemoteUiStyle;

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
    ButtonStyle::new(
        ButtonBackgrounds::new(if primary {
            palette.accent
        } else {
            palette.surface_raised
        })
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
