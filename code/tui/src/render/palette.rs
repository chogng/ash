use ash_terminal_detection::ColorLevel;
use ratatui::style::Color;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ThemeRgb {
    red: u8,
    green: u8,
    blue: u8,
}

impl ThemeRgb {
    pub(crate) const fn from_hex(value: &str) -> Self {
        match Self::decode(value) {
            Some(color) => color,
            None => panic!("theme color must use the #RRGGBB format"),
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        Self::decode(value)
            .ok_or_else(|| format!("invalid TUI theme color '{value}'; expected #RRGGBB"))
    }

    const fn decode(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 7 || bytes[0] != b'#' {
            return None;
        }
        let red = match hex_pair(bytes[1], bytes[2]) {
            Some(component) => component,
            None => return None,
        };
        let green = match hex_pair(bytes[3], bytes[4]) {
            Some(component) => component,
            None => return None,
        };
        let blue = match hex_pair(bytes[5], bytes[6]) {
            Some(component) => component,
            None => return None,
        };
        Some(Self { red, green, blue })
    }

    const fn components(self) -> [u8; 3] {
        [self.red, self.green, self.blue]
    }

    const fn true_color(self) -> Color {
        Color::Rgb(self.red, self.green, self.blue)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ThemePalette {
    pub(crate) accent: ThemeRgb,
    pub(crate) accent_surface_background: ThemeRgb,
    pub(crate) accent_surface_foreground: ThemeRgb,
    pub(crate) action_foreground: ThemeRgb,
    pub(crate) background: ThemeRgb,
    pub(crate) border: ThemeRgb,
    pub(crate) chat_input_chrome: ThemeRgb,
    pub(crate) danger: ThemeRgb,
    pub(crate) disabled_foreground: ThemeRgb,
    pub(crate) focus: ThemeRgb,
    pub(crate) foreground: ThemeRgb,
    pub(crate) function: ThemeRgb,
    pub(crate) hover_background: ThemeRgb,
    pub(crate) hover_foreground: ThemeRgb,
    pub(crate) inserted_background: ThemeRgb,
    pub(crate) inserted_marker: ThemeRgb,
    pub(crate) keyword: ThemeRgb,
    pub(crate) modal_border: ThemeRgb,
    pub(crate) muted: ThemeRgb,
    pub(crate) overlay_background: ThemeRgb,
    pub(crate) pressed_background: ThemeRgb,
    pub(crate) pressed_foreground: ThemeRgb,
    pub(crate) removed_background: ThemeRgb,
    pub(crate) removed_marker: ThemeRgb,
    pub(crate) string: ThemeRgb,
    pub(crate) success: ThemeRgb,
    pub(crate) selection_background: ThemeRgb,
    pub(crate) selection_foreground: ThemeRgb,
    pub(crate) screen_selection_background: ThemeRgb,
    pub(crate) screen_selection_foreground: ThemeRgb,
    pub(crate) r#type: ThemeRgb,
    pub(crate) transcript_jump_background: ThemeRgb,
    pub(crate) user_message_background: ThemeRgb,
    pub(crate) variable: ThemeRgb,
    pub(crate) warning: ThemeRgb,
}

impl ThemePalette {
    pub(crate) const fn dark() -> Self {
        Self {
            accent: ThemeRgb::from_hex("#58a6ff"),
            accent_surface_background: ThemeRgb::from_hex("#6658c7"),
            accent_surface_foreground: ThemeRgb::from_hex("#ffffff"),
            action_foreground: ThemeRgb::from_hex("#58a6ff"),
            background: ThemeRgb::from_hex("#0d1117"),
            border: ThemeRgb::from_hex("#2b2b2b"),
            chat_input_chrome: ThemeRgb::from_hex("#8b949e"),
            danger: ThemeRgb::from_hex("#f85149"),
            disabled_foreground: ThemeRgb::from_hex("#8b949e"),
            focus: ThemeRgb::from_hex("#9a91eb"),
            foreground: ThemeRgb::from_hex("#e6edf3"),
            function: ThemeRgb::from_hex("#d2a8ff"),
            hover_background: ThemeRgb::from_hex("#25233a"),
            hover_foreground: ThemeRgb::from_hex("#f0edff"),
            inserted_background: ThemeRgb::from_hex("#132d1d"),
            inserted_marker: ThemeRgb::from_hex("#3fb950"),
            keyword: ThemeRgb::from_hex("#ff7b72"),
            modal_border: ThemeRgb::from_hex("#8b949e"),
            muted: ThemeRgb::from_hex("#8b949e"),
            overlay_background: ThemeRgb::from_hex("#252526"),
            pressed_background: ThemeRgb::from_hex("#3b3568"),
            pressed_foreground: ThemeRgb::from_hex("#ffffff"),
            removed_background: ThemeRgb::from_hex("#351b1b"),
            removed_marker: ThemeRgb::from_hex("#f85149"),
            string: ThemeRgb::from_hex("#a5d6ff"),
            success: ThemeRgb::from_hex("#3fb950"),
            selection_background: ThemeRgb::from_hex("#2f2b52"),
            selection_foreground: ThemeRgb::from_hex("#f0edff"),
            screen_selection_background: ThemeRgb::from_hex("#87ceeb"),
            screen_selection_foreground: ThemeRgb::from_hex("#0d1117"),
            r#type: ThemeRgb::from_hex("#d2a8ff"),
            transcript_jump_background: ThemeRgb::from_hex("#303030"),
            user_message_background: ThemeRgb::from_hex("#161b22"),
            variable: ThemeRgb::from_hex("#ffa657"),
            warning: ThemeRgb::from_hex("#ffa657"),
        }
    }

    pub(crate) const fn light() -> Self {
        Self {
            accent: ThemeRgb::from_hex("#0969da"),
            accent_surface_background: ThemeRgb::from_hex("#6658c7"),
            accent_surface_foreground: ThemeRgb::from_hex("#ffffff"),
            action_foreground: ThemeRgb::from_hex("#0969da"),
            background: ThemeRgb::from_hex("#ffffff"),
            border: ThemeRgb::from_hex("#e5e5e5"),
            chat_input_chrome: ThemeRgb::from_hex("#57606a"),
            danger: ThemeRgb::from_hex("#cf222e"),
            disabled_foreground: ThemeRgb::from_hex("#57606a"),
            focus: ThemeRgb::from_hex("#6658c7"),
            foreground: ThemeRgb::from_hex("#1f2328"),
            function: ThemeRgb::from_hex("#8250df"),
            hover_background: ThemeRgb::from_hex("#f2f0ff"),
            hover_foreground: ThemeRgb::from_hex("#342b72"),
            inserted_background: ThemeRgb::from_hex("#dafbe1"),
            inserted_marker: ThemeRgb::from_hex("#1a7f37"),
            keyword: ThemeRgb::from_hex("#cf222e"),
            modal_border: ThemeRgb::from_hex("#57606a"),
            muted: ThemeRgb::from_hex("#57606a"),
            overlay_background: ThemeRgb::from_hex("#f8f8f8"),
            pressed_background: ThemeRgb::from_hex("#d8d1ff"),
            pressed_foreground: ThemeRgb::from_hex("#271f63"),
            removed_background: ThemeRgb::from_hex("#ffebe9"),
            removed_marker: ThemeRgb::from_hex("#cf222e"),
            string: ThemeRgb::from_hex("#0a3069"),
            success: ThemeRgb::from_hex("#1a7f37"),
            selection_background: ThemeRgb::from_hex("#e9e5ff"),
            selection_foreground: ThemeRgb::from_hex("#342b72"),
            screen_selection_background: ThemeRgb::from_hex("#87ceeb"),
            screen_selection_foreground: ThemeRgb::from_hex("#0d1117"),
            r#type: ThemeRgb::from_hex("#8250df"),
            transcript_jump_background: ThemeRgb::from_hex("#e5e5e5"),
            user_message_background: ThemeRgb::from_hex("#f0f0f0"),
            variable: ThemeRgb::from_hex("#953800"),
            warning: ThemeRgb::from_hex("#953800"),
        }
    }

    pub(crate) const fn colorblind_dark() -> Self {
        Self {
            accent_surface_background: ThemeRgb::from_hex("#0969da"),
            action_foreground: ThemeRgb::from_hex("#58a6ff"),
            danger: ThemeRgb::from_hex("#d47616"),
            focus: ThemeRgb::from_hex("#58a6ff"),
            hover_background: ThemeRgb::from_hex("#172a46"),
            hover_foreground: ThemeRgb::from_hex("#ddf4ff"),
            inserted_background: ThemeRgb::from_hex("#12294b"),
            inserted_marker: ThemeRgb::from_hex("#58a6ff"),
            keyword: ThemeRgb::from_hex("#ec8e2c"),
            pressed_background: ThemeRgb::from_hex("#1f4f85"),
            removed_background: ThemeRgb::from_hex("#402810"),
            removed_marker: ThemeRgb::from_hex("#d47616"),
            success: ThemeRgb::from_hex("#58a6ff"),
            selection_background: ThemeRgb::from_hex("#12294b"),
            selection_foreground: ThemeRgb::from_hex("#ddf4ff"),
            screen_selection_background: ThemeRgb::from_hex("#80ccff"),
            variable: ThemeRgb::from_hex("#fdac54"),
            warning: ThemeRgb::from_hex("#fdac54"),
            ..Self::dark()
        }
    }

    pub(crate) const fn colorblind_light() -> Self {
        Self {
            accent_surface_background: ThemeRgb::from_hex("#0969da"),
            action_foreground: ThemeRgb::from_hex("#0969da"),
            danger: ThemeRgb::from_hex("#b35900"),
            focus: ThemeRgb::from_hex("#0969da"),
            hover_background: ThemeRgb::from_hex("#eef8ff"),
            hover_foreground: ThemeRgb::from_hex("#034b7a"),
            inserted_background: ThemeRgb::from_hex("#ddf4ff"),
            inserted_marker: ThemeRgb::from_hex("#0969da"),
            keyword: ThemeRgb::from_hex("#b35900"),
            pressed_background: ThemeRgb::from_hex("#b6e3ff"),
            pressed_foreground: ThemeRgb::from_hex("#033d66"),
            removed_background: ThemeRgb::from_hex("#fff1e5"),
            removed_marker: ThemeRgb::from_hex("#b35900"),
            success: ThemeRgb::from_hex("#0969da"),
            selection_background: ThemeRgb::from_hex("#ddf4ff"),
            selection_foreground: ThemeRgb::from_hex("#034b7a"),
            screen_selection_background: ThemeRgb::from_hex("#80ccff"),
            variable: ThemeRgb::from_hex("#8a4600"),
            warning: ThemeRgb::from_hex("#8a4600"),
            ..Self::light()
        }
    }
}

const fn hex(value: &str) -> Color {
    ThemeRgb::from_hex(value).true_color()
}

const fn hex_pair(high: u8, low: u8) -> Option<u8> {
    match (hex_digit(high), hex_digit(low)) {
        (Some(high), Some(low)) => Some((high << 4) | low),
        _ => None,
    }
}

const fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RenderTheme {
    cursor_color: Option<[u8; 3]>,
    terminal_background: Option<[u8; 3]>,
    accent: Color,
    accent_surface_background: Color,
    accent_surface_foreground: Color,
    action_foreground: Color,
    background: Color,
    border: Color,
    chat_input_chrome: Color,
    danger: Color,
    disabled_foreground: Color,
    focus: Color,
    foreground: Color,
    function: Color,
    hover_background: Color,
    hover_foreground: Color,
    inserted_background: Color,
    inserted_marker: Color,
    keyword: Color,
    modal_border: Color,
    muted: Color,
    pressed_background: Color,
    pressed_foreground: Color,
    removed_background: Color,
    removed_marker: Color,
    overlay_background: Color,
    string: Color,
    success: Color,
    selection_background: Color,
    selection_foreground: Color,
    screen_selection_background: Color,
    screen_selection_foreground: Color,
    r#type: Color,
    transcript_jump_background: Color,
    user_message_background: Color,
    variable: Color,
    warning: Color,
}

impl RenderTheme {
    pub(crate) fn from_palette(palette: ThemePalette, capability: ColorLevel) -> Self {
        let projected = |color| terminal_color(color, capability);
        Self {
            cursor_color: (capability != ColorLevel::Monochrome)
                .then(|| palette.focus.components()),
            terminal_background: None,
            accent: projected(palette.accent),
            accent_surface_background: projected(palette.accent_surface_background),
            accent_surface_foreground: projected(palette.accent_surface_foreground),
            action_foreground: projected(palette.action_foreground),
            background: projected(palette.background),
            border: projected(palette.border),
            chat_input_chrome: projected(palette.chat_input_chrome),
            danger: projected(palette.danger),
            disabled_foreground: projected(palette.disabled_foreground),
            focus: projected(palette.focus),
            foreground: projected(palette.foreground),
            function: projected(palette.function),
            hover_background: projected(palette.hover_background),
            hover_foreground: projected(palette.hover_foreground),
            inserted_background: projected(palette.inserted_background),
            inserted_marker: projected(palette.inserted_marker),
            keyword: projected(palette.keyword),
            modal_border: projected(palette.modal_border),
            muted: projected(palette.muted),
            pressed_background: projected(palette.pressed_background),
            pressed_foreground: projected(palette.pressed_foreground),
            removed_background: projected(palette.removed_background),
            removed_marker: projected(palette.removed_marker),
            overlay_background: projected(palette.overlay_background),
            string: projected(palette.string),
            success: projected(palette.success),
            selection_background: projected(palette.selection_background),
            selection_foreground: projected(palette.selection_foreground),
            screen_selection_background: projected(palette.screen_selection_background),
            screen_selection_foreground: projected(palette.screen_selection_foreground),
            r#type: projected(palette.r#type),
            transcript_jump_background: projected(palette.transcript_jump_background),
            user_message_background: projected(palette.user_message_background),
            variable: projected(palette.variable),
            warning: projected(palette.warning),
        }
    }

    pub(crate) const fn with_terminal_defaults(mut self) -> Self {
        self.background = Color::Reset;
        self.foreground = Color::Reset;
        self
    }

    pub(crate) const fn with_terminal_background(mut self, background: [u8; 3]) -> Self {
        self.terminal_background = Some(background);
        self
    }

    pub(crate) const fn fallback() -> Self {
        Self {
            cursor_color: Some(ThemePalette::dark().focus.components()),
            terminal_background: None,
            accent: hex("#69aaff"),
            accent_surface_background: hex("#6658c7"),
            accent_surface_foreground: hex("#ffffff"),
            action_foreground: hex("#69aaff"),
            background: hex("#0d1117"),
            border: hex("#808080"),
            chat_input_chrome: hex("#9b9b9b"),
            danger: hex("#f56969"),
            disabled_foreground: hex("#808080"),
            focus: hex("#9a91eb"),
            foreground: hex("#ffffff"),
            function: hex("#d2a8ff"),
            hover_background: hex("#25233a"),
            hover_foreground: hex("#f0edff"),
            inserted_background: hex("#13301c"),
            inserted_marker: hex("#3fb950"),
            keyword: hex("#ff7b72"),
            modal_border: hex("#9b9b9b"),
            muted: hex("#808080"),
            pressed_background: hex("#3b3568"),
            pressed_foreground: hex("#ffffff"),
            removed_background: hex("#37191b"),
            removed_marker: hex("#f85149"),
            overlay_background: hex("#252526"),
            string: hex("#a5d6ff"),
            success: hex("#5fd28c"),
            selection_background: hex("#2f2b52"),
            selection_foreground: hex("#f0edff"),
            screen_selection_background: hex("#87ceeb"),
            screen_selection_foreground: hex("#0d1117"),
            r#type: hex("#d2a8ff"),
            transcript_jump_background: hex("#303030"),
            user_message_background: hex("#161b22"),
            variable: hex("#ffa657"),
            warning: hex("#f5be50"),
        }
    }

    pub(crate) const fn accent(self) -> Color {
        self.accent
    }
    pub(crate) const fn accent_surface_background(self) -> Color {
        self.accent_surface_background
    }
    pub(crate) const fn accent_surface_foreground(self) -> Color {
        self.accent_surface_foreground
    }
    pub(crate) const fn action_foreground(self) -> Color {
        self.action_foreground
    }
    pub(crate) const fn background(self) -> Color {
        self.background
    }
    pub(crate) const fn border(self) -> Color {
        self.border
    }
    pub(crate) const fn chat_input_chrome(self) -> Color {
        self.chat_input_chrome
    }
    pub(crate) const fn danger(self) -> Color {
        self.danger
    }
    pub(crate) const fn disabled_foreground(self) -> Color {
        self.disabled_foreground
    }
    pub(crate) const fn focus(self) -> Color {
        self.focus
    }
    pub(crate) const fn foreground(self) -> Color {
        self.foreground
    }
    pub(crate) const fn function(self) -> Color {
        self.function
    }
    pub(crate) const fn hover_background(self) -> Color {
        self.hover_background
    }
    pub(crate) const fn hover_foreground(self) -> Color {
        self.hover_foreground
    }
    pub(crate) const fn inserted_background(self) -> Color {
        self.inserted_background
    }
    pub(crate) const fn inserted_marker(self) -> Color {
        self.inserted_marker
    }
    pub(crate) const fn keyword(self) -> Color {
        self.keyword
    }
    pub(crate) const fn modal_border(self) -> Color {
        self.modal_border
    }
    pub(crate) const fn muted(self) -> Color {
        self.muted
    }
    pub(crate) const fn pressed_background(self) -> Color {
        self.pressed_background
    }
    pub(crate) const fn pressed_foreground(self) -> Color {
        self.pressed_foreground
    }
    pub(crate) const fn removed_background(self) -> Color {
        self.removed_background
    }
    pub(crate) const fn removed_marker(self) -> Color {
        self.removed_marker
    }
    pub(crate) const fn overlay_background(self) -> Color {
        self.overlay_background
    }
    pub(crate) const fn string(self) -> Color {
        self.string
    }
    pub(crate) const fn success(self) -> Color {
        self.success
    }
    pub(crate) const fn selection_background(self) -> Color {
        self.selection_background
    }
    pub(crate) const fn selection_foreground(self) -> Color {
        self.selection_foreground
    }
    pub(crate) const fn screen_selection_background(self) -> Color {
        self.screen_selection_background
    }
    pub(crate) const fn screen_selection_foreground(self) -> Color {
        self.screen_selection_foreground
    }
    pub(crate) const fn r#type(self) -> Color {
        self.r#type
    }
    pub(crate) const fn transcript_jump_background(self) -> Color {
        self.transcript_jump_background
    }
    pub(crate) const fn user_message_background(self) -> Color {
        self.user_message_background
    }
    pub(crate) const fn variable(self) -> Color {
        self.variable
    }
    pub(crate) const fn warning(self) -> Color {
        self.warning
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RenderContext<'a> {
    theme: &'a RenderTheme,
    hyperlinks: Option<&'a std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>>,
    mermaid_previews: Option<&'a super::MermaidPreviews>,
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
        let blend = |foreground: [u8; 3], background: [u8; 3]| {
            std::array::from_fn(|index| {
                (f32::from(background[index])
                    + (f32::from(foreground[index]) - f32::from(background[index])) * opacity)
                    .round() as u8
            })
        };
        let background = match (self.background(), self.theme.terminal_background) {
            (Color::Reset, Some([r, g, b])) => Color::Rgb(r, g, b),
            (background, _) => background,
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
        links: &'a std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
    ) -> Self {
        self.hyperlinks = Some(links);
        self
    }

    pub(crate) fn with_mermaid_previews(mut self, previews: &'a super::MermaidPreviews) -> Self {
        self.mermaid_previews = Some(previews);
        self
    }

    pub(crate) fn mermaid_preview_url(self, source: &str) -> Option<String> {
        self.mermaid_previews?.url(source)
    }

    pub(crate) fn hyperlinks(
        self,
    ) -> Option<&'a std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>> {
        self.hyperlinks
    }

    pub(crate) fn clear_hyperlinks(self, area: ratatui::layout::Rect) {
        if let Some(links) = self.hyperlinks {
            links.borrow_mut().clear(area);
        }
    }

    pub(crate) const fn cursor_color(self) -> Option<[u8; 3]> {
        self.theme.cursor_color
    }
    pub(crate) const fn new(theme: &'a RenderTheme, theme_revision: u64) -> Self {
        Self {
            theme,
            hyperlinks: None,
            mermaid_previews: None,
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
    static THEME: RenderTheme = RenderTheme::fallback();
    RenderContext::new(&THEME, 0)
}

fn terminal_color(color: ThemeRgb, capability: ColorLevel) -> Color {
    let rgb = color.components();
    match capability {
        ColorLevel::TrueColor => Color::Rgb(rgb[0], rgb[1], rgb[2]),
        ColorLevel::Ansi256 => Color::Indexed(nearest_ansi256(rgb)),
        ColorLevel::Ansi16 => nearest_ansi16(rgb),
        ColorLevel::Monochrome => Color::Reset,
    }
}

fn nearest_ansi256(rgb: [u8; 3]) -> u8 {
    let mut best = (0_u8, u32::MAX);
    for index in 16_u8..=255 {
        let candidate = ansi256_rgb(index);
        let distance = color_distance(rgb, candidate);
        if distance < best.1 {
            best = (index, distance);
        }
    }
    best.0
}

fn ansi256_rgb(index: u8) -> [u8; 3] {
    if index >= 232 {
        let gray = 8 + (index - 232) * 10;
        return [gray, gray, gray];
    }
    let cube = index - 16;
    let channel = |value: u8| if value == 0 { 0 } else { 55 + value * 40 };
    [
        channel(cube / 36),
        channel((cube % 36) / 6),
        channel(cube % 6),
    ]
}

fn nearest_ansi16(rgb: [u8; 3]) -> Color {
    const COLORS: [([u8; 3], Color); 16] = [
        ([0, 0, 0], Color::Black),
        ([128, 0, 0], Color::Red),
        ([0, 128, 0], Color::Green),
        ([128, 128, 0], Color::Yellow),
        ([0, 0, 128], Color::Blue),
        ([128, 0, 128], Color::Magenta),
        ([0, 128, 128], Color::Cyan),
        ([192, 192, 192], Color::Gray),
        ([128, 128, 128], Color::DarkGray),
        ([255, 0, 0], Color::LightRed),
        ([0, 255, 0], Color::LightGreen),
        ([255, 255, 0], Color::LightYellow),
        ([0, 0, 255], Color::LightBlue),
        ([255, 0, 255], Color::LightMagenta),
        ([0, 255, 255], Color::LightCyan),
        ([255, 255, 255], Color::White),
    ];
    COLORS
        .iter()
        .min_by_key(|(candidate, _)| color_distance(rgb, *candidate))
        .map(|(_, color)| *color)
        .unwrap_or(Color::Reset)
}

fn color_distance(left: [u8; 3], right: [u8; 3]) -> u32 {
    left.into_iter()
        .zip(right)
        .map(|(left, right)| {
            let difference = i32::from(left) - i32::from(right);
            difference.unsigned_abs().pow(2)
        })
        .sum()
}

#[cfg(test)]
#[path = "palette_tests.rs"]
mod tests;
