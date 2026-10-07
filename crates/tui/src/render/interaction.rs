use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;

use super::RenderContext;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum InteractionTarget {
    #[default]
    Rest,
    Active,
    Disabled,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct InteractionState {
    pub(crate) target: InteractionTarget,
    pub(crate) selected: bool,
    pub(crate) hovered: bool,
    pub(crate) pressed: bool,
}

pub(crate) fn selection_marker(selected: bool) -> &'static str {
    if selected { "> " } else { "  " }
}

pub(crate) fn interaction_style(context: RenderContext<'_>, state: InteractionState) -> Style {
    if state.target == InteractionTarget::Disabled {
        return Style::default()
            .fg(context.disabled_foreground())
            .add_modifier(Modifier::DIM);
    }

    let mut style = if state.pressed {
        Style::default()
            .fg(context.pressed_foreground())
            .bg(context.pressed_background())
    } else if state.selected {
        Style::default()
            .fg(context.selection_foreground())
            .bg(context.selection_background())
    } else if state.hovered {
        Style::default()
            .fg(context.hover_foreground())
            .bg(context.hover_background())
    } else {
        match state.target {
            InteractionTarget::Active => Style::default()
                .fg(context.accent_surface_foreground())
                .bg(context.accent_surface_background()),
            InteractionTarget::Rest | InteractionTarget::Disabled => Style::default(),
        }
    };
    if state.target == InteractionTarget::Active || state.selected || state.pressed {
        style = style.add_modifier(Modifier::BOLD);
    }
    if interaction_colors_are_unavailable(context) {
        style = if state.pressed || state.selected || state.target == InteractionTarget::Active {
            style.add_modifier(Modifier::REVERSED)
        } else if state.hovered {
            style.add_modifier(Modifier::UNDERLINED)
        } else {
            style
        };
    }
    style
}

pub(crate) fn action_style(context: RenderContext<'_>) -> Style {
    Style::default()
        .fg(context.action_foreground())
        .add_modifier(Modifier::BOLD)
}

fn interaction_colors_are_unavailable(context: RenderContext<'_>) -> bool {
    context.focus() == Color::Reset
        && context.selection_background() == Color::Reset
        && context.hover_background() == Color::Reset
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
