use super::InteractionState;
use super::InteractionTarget;
use super::interaction_style;
use super::selection_marker;
use crate::render::RenderContext;
use crate::render::RenderTheme;
use crate::render::ThemePalette;
use crate::render::test_context;
use ash_terminal_detection::ColorLevel;
use ratatui::style::Color;
use ratatui::style::Modifier;

#[test]
fn selected_items_use_the_standard_input_marker() {
    assert_eq!(selection_marker(true), "> ");
    assert_eq!(selection_marker(false), "  ");
}

#[test]
fn interaction_states_use_distinct_theme_pairs() {
    let context = test_context();

    let selected = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: true,
            hovered: false,
            pressed: false,
        },
    );
    let hovered = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: false,
            hovered: true,
            pressed: false,
        },
    );
    let pressed = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: false,
            hovered: false,
            pressed: true,
        },
    );
    let disabled = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Disabled,
            selected: true,
            hovered: true,
            pressed: true,
        },
    );

    assert_eq!(selected.fg, Some(context.selection_foreground()));
    assert_eq!(selected.bg, Some(context.selection_background()));
    assert_eq!(hovered.fg, Some(context.hover_foreground()));
    assert_eq!(hovered.bg, Some(context.hover_background()));
    assert_eq!(pressed.fg, Some(context.pressed_foreground()));
    assert_eq!(pressed.bg, Some(context.pressed_background()));
    assert_eq!(disabled.fg, Some(context.disabled_foreground()));
    assert!(disabled.add_modifier.contains(Modifier::DIM));
}

#[test]
fn pressed_feedback_overrides_selection_without_losing_selection_state() {
    let context = test_context();
    let state = InteractionState {
        target: InteractionTarget::Active,
        selected: true,
        hovered: true,
        pressed: true,
    };

    let style = interaction_style(context, state);

    assert!(state.selected);
    assert_eq!(style.fg, Some(context.pressed_foreground()));
    assert_eq!(style.bg, Some(context.pressed_background()));
    assert!(style.add_modifier.contains(Modifier::BOLD));
}

#[test]
fn monochrome_preserves_interaction_without_color() {
    let theme = RenderTheme::from_palette(ThemePalette::dark(), ColorLevel::Monochrome);
    let context = RenderContext::new(&theme, 0);

    let hovered = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: false,
            hovered: true,
            pressed: false,
        },
    );
    let selected = interaction_style(
        context,
        InteractionState {
            target: InteractionTarget::Rest,
            selected: true,
            hovered: false,
            pressed: false,
        },
    );

    assert_eq!(hovered.fg, Some(Color::Reset));
    assert!(hovered.add_modifier.contains(Modifier::UNDERLINED));
    assert!(selected.add_modifier.contains(Modifier::REVERSED));
}
