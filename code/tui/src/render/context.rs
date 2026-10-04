//! Explicit display inputs and frame annotation output shared by TUI surfaces.

use super::palette::RenderTheme;
#[cfg(test)]
use super::palette::ThemePalette;
use super::palette::ansi256_rgb;
use super::palette::nearest_ansi256;
#[cfg(test)]
use ash_terminal_detection::ColorLevel;
use ratatui::style::Color;

#[derive(Clone, Copy, Debug)]
pub(crate) struct RenderContext<'a> {
    theme: &'a RenderTheme,
    hyperlinks: Option<&'a std::cell::RefCell<super::links::FrameLinks>>,
    preview_links: Option<&'a super::links::PreviewLinks>,
    theme_revision: u64,
    language: crate::nls::Language,
}

impl<'a> RenderContext<'a> {
    pub(crate) fn fade_style(
        self,
        style: ratatui::style::Style,
        opacity: f32,
    ) -> ratatui::style::Style {
        if opacity >= 1.0 {
            return style;
        }
        let background = match (self.background(), self.theme.terminal_background()) {
            (Color::Reset, Some([r, g, b])) => Color::Rgb(r, g, b),
            (background, _) => background,
        };
        Self::interpolate_foreground(style, background, opacity)
    }

    /// Blends theme text colors while preserving terminal color depth and interaction backgrounds.
    pub(crate) fn blend_style(
        self,
        style: ratatui::style::Style,
        target: Color,
        amount: f32,
    ) -> ratatui::style::Style {
        Self::interpolate_foreground(style, target, 1.0 - amount)
    }

    fn interpolate_foreground(
        style: ratatui::style::Style,
        background: Color,
        opacity: f32,
    ) -> ratatui::style::Style {
        if opacity >= 1.0 {
            return style;
        }
        let blend = |foreground: [u8; 3], background: [u8; 3]| {
            std::array::from_fn(|index| {
                (f32::from(background[index])
                    + (f32::from(foreground[index]) - f32::from(background[index])) * opacity)
                    .round() as u8
            })
        };
        match (style.fg, background) {
            (Some(Color::Rgb(r, g, b)), Color::Rgb(br, bg, bb)) => {
                let [r, g, b] = blend([r, g, b], [br, bg, bb]);
                style.fg(Color::Rgb(r, g, b))
            }
            (Some(Color::Indexed(fg)), Color::Indexed(bg)) if fg >= 16 && bg >= 16 => style.fg(
                Color::Indexed(nearest_ansi256(blend(ansi256_rgb(fg), ansi256_rgb(bg)))),
            ),
            (Some(Color::Indexed(fg)), Color::Rgb(r, g, b)) if fg >= 16 => style.fg(
                Color::Indexed(nearest_ansi256(blend(ansi256_rgb(fg), [r, g, b]))),
            ),
            // Terminal-defined colors have no known RGB value to interpolate.
            _ if opacity < 0.5 => style.add_modifier(ratatui::style::Modifier::DIM),
            _ => style,
        }
    }

    pub(crate) fn with_hyperlinks(
        mut self,
        links: &'a std::cell::RefCell<super::links::FrameLinks>,
    ) -> Self {
        self.hyperlinks = Some(links);
        self
    }

    pub(crate) fn with_preview_links(mut self, previews: &'a super::links::PreviewLinks) -> Self {
        self.preview_links = Some(previews);
        self
    }

    pub(crate) fn mermaid_preview_url(self, source: &str) -> Option<String> {
        self.preview_links?.url(source).map(str::to_owned)
    }

    pub(crate) fn preview_revision(self) -> u64 {
        self.preview_links
            .map_or(0, super::links::PreviewLinks::revision)
    }

    pub(crate) fn hyperlinks(self) -> Option<&'a std::cell::RefCell<super::links::FrameLinks>> {
        self.hyperlinks
    }

    pub(crate) fn clear_hyperlinks(self, area: ratatui::layout::Rect) {
        if let Some(links) = self.hyperlinks {
            links.borrow_mut().clear(area);
        }
    }

    pub(crate) const fn cursor_color(self) -> Option<[u8; 3]> {
        self.theme.cursor_color()
    }
    pub(crate) const fn new(theme: &'a RenderTheme, theme_revision: u64) -> Self {
        Self {
            theme,
            hyperlinks: None,
            preview_links: None,
            theme_revision,
            language: crate::nls::Language::English,
        }
    }

    pub(crate) const fn with_language(mut self, language: crate::nls::Language) -> Self {
        self.language = language;
        self
    }

    pub(crate) const fn language(self) -> crate::nls::Language {
        self.language
    }

    pub(crate) fn localize<'b>(self, source: &'b str) -> std::borrow::Cow<'b, str> {
        crate::nls::localize(self.language, source)
    }

    pub(crate) const fn accent(self) -> Color {
        self.theme.accent()
    }
    pub(crate) const fn identity_colors(self) -> [Color; 5] {
        self.theme.identity_colors()
    }
    pub(crate) const fn accent_surface_background(self) -> Color {
        self.theme.accent_surface_background()
    }
    pub(crate) const fn accent_surface_foreground(self) -> Color {
        self.theme.accent_surface_foreground()
    }
    pub(crate) const fn action_foreground(self) -> Color {
        self.theme.action_foreground()
    }
    pub(crate) const fn background(self) -> Color {
        self.theme.background()
    }
    pub(crate) const fn border(self) -> Color {
        self.theme.border()
    }
    pub(crate) const fn chat_input_chrome(self) -> Color {
        self.theme.chat_input_chrome()
    }

    pub(crate) const fn mode_color(self, mode: ash_protocol::CollaborationMode) -> Color {
        self.theme.mode_color(mode)
    }
    pub(crate) const fn danger(self) -> Color {
        self.theme.danger()
    }
    pub(crate) const fn disabled_foreground(self) -> Color {
        self.theme.disabled_foreground()
    }
    pub(crate) const fn focus(self) -> Color {
        self.theme.focus()
    }
    pub(crate) const fn foreground(self) -> Color {
        self.theme.foreground()
    }
    pub(crate) const fn function(self) -> Color {
        self.theme.function()
    }
    pub(crate) const fn hover_background(self) -> Color {
        self.theme.hover_background()
    }
    pub(crate) const fn hover_foreground(self) -> Color {
        self.theme.hover_foreground()
    }
    pub(crate) const fn inserted_marker(self) -> Color {
        self.theme.inserted_marker()
    }
    pub(crate) const fn modal_border(self) -> Color {
        self.theme.modal_border()
    }
    pub(crate) const fn muted(self) -> Color {
        self.theme.muted()
    }
    pub(crate) const fn pressed_background(self) -> Color {
        self.theme.pressed_background()
    }
    pub(crate) const fn pressed_foreground(self) -> Color {
        self.theme.pressed_foreground()
    }
    pub(crate) const fn removed_marker(self) -> Color {
        self.theme.removed_marker()
    }
    pub(crate) const fn segmented_active(self) -> Color {
        self.theme.segmented_active()
    }
    pub(crate) const fn segmented_inactive(self) -> Color {
        self.theme.segmented_inactive()
    }
    pub(crate) const fn overlay_background(self) -> Color {
        self.theme.overlay_background()
    }
    pub(crate) const fn keyword(self) -> Color {
        self.theme.keyword()
    }
    pub(crate) const fn string(self) -> Color {
        self.theme.string()
    }
    pub(crate) const fn success(self) -> Color {
        self.theme.success()
    }
    pub(crate) const fn selection_background(self) -> Color {
        self.theme.selection_background()
    }
    pub(crate) const fn selection_foreground(self) -> Color {
        self.theme.selection_foreground()
    }
    pub(crate) const fn screen_selection_background(self) -> Color {
        self.theme.screen_selection_background()
    }
    pub(crate) const fn screen_selection_foreground(self) -> Color {
        self.theme.screen_selection_foreground()
    }
    pub(crate) const fn r#type(self) -> Color {
        self.theme.r#type()
    }
    pub(crate) const fn transcript_jump_background(self) -> Color {
        self.theme.transcript_jump_background()
    }
    pub(crate) const fn user_message_background(self) -> Color {
        self.theme.user_message_background()
    }
    pub(crate) const fn variable(self) -> Color {
        self.theme.variable()
    }
    pub(crate) const fn warning(self) -> Color {
        self.theme.warning()
    }

    pub(crate) const fn theme_revision(self) -> u64 {
        self.theme_revision
    }
}

#[cfg(test)]
pub(crate) fn test_context() -> RenderContext<'static> {
    static THEME: std::sync::LazyLock<RenderTheme> = std::sync::LazyLock::new(|| {
        RenderTheme::from_palette(ThemePalette::initial(), ColorLevel::TrueColor)
    });
    RenderContext::new(&THEME, 0)
}
