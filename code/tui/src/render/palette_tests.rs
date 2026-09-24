use ash_terminal_detection::ColorLevel;
use ratatui::style::Color;

use super::RenderTheme;
use super::ThemePalette;
use super::ThemeRgb;

#[test]
fn theme_rgb_accepts_exact_six_digit_hex_colors() {
    assert_eq!(
        ThemeRgb::parse("#09aF10"),
        Ok(ThemeRgb::from_hex("#09af10"))
    );

    for value in ["09af10", "#09af1", "#09af100", "#09ag10", "#fff"] {
        assert_eq!(
            ThemeRgb::parse(value),
            Err(format!(
                "invalid TUI theme color '{value}'; expected #RRGGBB"
            ))
        );
    }
}

#[test]
fn render_theme_maps_its_colors_for_each_terminal_capability() {
    let palette = ThemePalette::dark();
    let true_color = RenderTheme::from_palette(palette, ColorLevel::TrueColor);
    let ansi256 = RenderTheme::from_palette(palette, ColorLevel::Ansi256);
    let ansi16 = RenderTheme::from_palette(palette, ColorLevel::Ansi16);
    let monochrome = RenderTheme::from_palette(palette, ColorLevel::Monochrome);
    assert_eq!(
        super::RenderContext::new(&true_color, 0).cursor_color(),
        Some([154, 145, 235])
    );
    assert_eq!(
        super::RenderContext::new(&monochrome, 0).cursor_color(),
        None
    );

    assert!(matches!(true_color.accent(), Color::Rgb(..)));
    assert_eq!(true_color.focus(), Color::Rgb(154, 145, 235));
    assert_eq!(true_color.action_foreground(), Color::Rgb(88, 166, 255));
    assert_eq!(true_color.selection_foreground(), Color::Rgb(240, 237, 255));
    assert_eq!(true_color.selection_background(), Color::Rgb(47, 43, 82));
    assert_eq!(true_color.hover_background(), Color::Rgb(37, 35, 58));
    assert_eq!(true_color.pressed_background(), Color::Rgb(59, 53, 104));
    assert_eq!(
        true_color.screen_selection_foreground(),
        Color::Rgb(13, 17, 23)
    );
    assert_eq!(
        true_color.screen_selection_background(),
        Color::Rgb(135, 206, 235)
    );
    assert_eq!(true_color.overlay_background(), Color::Rgb(37, 37, 38));
    assert_eq!(true_color.modal_border(), true_color.chat_input_chrome());
    assert_eq!(
        true_color.transcript_jump_background(),
        Color::Rgb(48, 48, 48)
    );
    assert!(matches!(ansi256.accent(), Color::Indexed(..)));
    assert!(!matches!(
        ansi16.accent(),
        Color::Rgb(..) | Color::Indexed(..)
    ));
    assert_eq!(monochrome.accent(), Color::Reset);

    let light = RenderTheme::from_palette(ThemePalette::light(), ColorLevel::TrueColor);
    assert_eq!(light.background(), Color::Rgb(255, 255, 255));
    assert_eq!(light.foreground(), Color::Rgb(31, 35, 40));
    assert_eq!(light.overlay_background(), Color::Rgb(248, 248, 248));
    assert_eq!(light.modal_border(), light.chat_input_chrome());
    assert_eq!(
        light.transcript_jump_background(),
        Color::Rgb(229, 229, 229)
    );
}

#[test]
fn built_in_palettes_keep_the_documented_semantic_colors() {
    let cases = [
        (
            ThemePalette::dark(),
            Color::Rgb(88, 166, 255),
            Color::Rgb(154, 145, 235),
            Color::Rgb(47, 43, 82),
            Color::Rgb(37, 35, 58),
            Color::Rgb(59, 53, 104),
            Color::Rgb(48, 48, 48),
            Color::Rgb(22, 27, 34),
        ),
        (
            ThemePalette::light(),
            Color::Rgb(9, 105, 218),
            Color::Rgb(102, 88, 199),
            Color::Rgb(233, 229, 255),
            Color::Rgb(242, 240, 255),
            Color::Rgb(216, 209, 255),
            Color::Rgb(229, 229, 229),
            Color::Rgb(240, 240, 240),
        ),
        (
            ThemePalette::colorblind_dark(),
            Color::Rgb(88, 166, 255),
            Color::Rgb(88, 166, 255),
            Color::Rgb(18, 41, 75),
            Color::Rgb(23, 42, 70),
            Color::Rgb(31, 79, 133),
            Color::Rgb(48, 48, 48),
            Color::Rgb(22, 27, 34),
        ),
        (
            ThemePalette::colorblind_light(),
            Color::Rgb(9, 105, 218),
            Color::Rgb(9, 105, 218),
            Color::Rgb(221, 244, 255),
            Color::Rgb(238, 248, 255),
            Color::Rgb(182, 227, 255),
            Color::Rgb(229, 229, 229),
            Color::Rgb(240, 240, 240),
        ),
    ];

    for (palette, action, focus, selection, hover, pressed, transcript_jump, user_message) in cases
    {
        let theme = RenderTheme::from_palette(palette, ColorLevel::TrueColor);
        assert_eq!(theme.action_foreground(), action);
        assert_eq!(theme.focus(), focus);
        assert_eq!(theme.selection_background(), selection);
        assert_eq!(theme.hover_background(), hover);
        assert_eq!(theme.pressed_background(), pressed);
        assert_eq!(theme.transcript_jump_background(), transcript_jump);
        assert_eq!(theme.user_message_background(), user_message);
    }
}

#[test]
fn terminal_defaults_only_replace_the_base_surface_colors() {
    let palette = ThemePalette::light();
    let themed = RenderTheme::from_palette(palette, ColorLevel::TrueColor);
    let terminal = themed.with_terminal_defaults();

    assert_eq!(terminal.background(), Color::Reset);
    assert_eq!(terminal.foreground(), Color::Reset);
    assert_eq!(terminal.focus(), themed.focus());
    assert_eq!(
        terminal.selection_background(),
        themed.selection_background()
    );
    assert_eq!(
        terminal.user_message_background(),
        themed.user_message_background()
    );
    assert_eq!(
        terminal.transcript_jump_background(),
        themed.transcript_jump_background()
    );
}
