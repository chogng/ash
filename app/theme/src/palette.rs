use crate::ThemeError;
use crate::ThemeSizeUnit;
use crate::ThemeSnapshot;
use crate::tokens;
use ash_icons::icons;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use ash_ui_components::ScrollViewStyle;
use ash_ui_components::ScrollbarStyle;
use ash_ui_components::SearchBoxStyle;
use zui::ui::Color;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::FontFamily;
use zui::ui::FontWeight;
use zui::ui::TextStyle;

const DEFAULT_EDITOR_LINE_HEIGHT: f32 = 20.0;
const DEFAULT_EDITOR_HEADER_HEIGHT: f32 = 32.0;

/// Resolved typography for one semantic UI text role.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypographyStyle {
    font_size: f32,
    line_height: f32,
    weight: FontWeight,
}

impl TypographyStyle {
    pub const fn new(font_size: f32, line_height: f32, weight: FontWeight) -> Self {
        Self {
            font_size,
            line_height,
            weight,
        }
    }

    pub fn text_style(self, color: Color) -> TextStyle {
        self.scaled_text_style(color, 1.0)
    }

    pub fn scaled_text_style(self, color: Color, scale: f32) -> TextStyle {
        TextStyle::new(self.font_size * scale, color)
            .with_line_height(self.line_height * scale)
            .with_weight(self.weight)
    }

    const fn scaled(self, scale: f32) -> Self {
        Self::new(
            self.font_size * scale,
            self.line_height * scale,
            self.weight,
        )
    }
}

/// Resolved interface typography after GUI preferences override theme role defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct UiTypography {
    family: FontFamily,
    body: TypographyStyle,
    control: TypographyStyle,
    label: TypographyStyle,
    metadata: TypographyStyle,
    heading: TypographyStyle,
}

impl UiTypography {
    /// Resolves one interface font family and base size while preserving theme role ratios.
    pub fn from_theme(theme: UiTheme, family: FontFamily, body_size: f32) -> Self {
        let scale = body_size / theme.interface_body.font_size;
        Self {
            family,
            body: theme.interface_body.scaled(scale),
            control: theme.interface_control.scaled(scale),
            label: theme.interface_label.scaled(scale),
            metadata: theme.interface_metadata.scaled(scale),
            heading: theme.interface_heading.scaled(scale),
        }
    }

    pub fn body_text(&self, color: Color) -> TextStyle {
        self.body.text_style(color).with_family(self.family.clone())
    }

    pub fn control_text(&self, color: Color) -> TextStyle {
        self.control
            .text_style(color)
            .with_family(self.family.clone())
    }

    pub fn label_text(&self, color: Color) -> TextStyle {
        self.label
            .text_style(color)
            .with_family(self.family.clone())
    }

    pub fn metadata_text(&self, color: Color) -> TextStyle {
        self.metadata
            .text_style(color)
            .with_family(self.family.clone())
    }

    pub fn heading_text(&self, color: Color) -> TextStyle {
        self.heading
            .text_style(color)
            .with_family(self.family.clone())
    }
}

/// Fully resolved syntax colors consumed by editor-owned style mappings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorSyntaxColors {
    pub attribute: Color,
    pub comment: Color,
    pub constant: Color,
    pub constructor: Color,
    pub embedded: Color,
    pub function: Color,
    pub keyword: Color,
    pub label: Color,
    pub module: Color,
    pub number: Color,
    pub operator: Color,
    pub property: Color,
    pub punctuation: Color,
    pub regexp: Color,
    pub string: Color,
    pub type_name: Color,
    pub variable: Color,
}

/// Fully resolved colors and standard sizes used by the graphical UI.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UiTheme {
    pub workbench_background: Color,
    pub content_background: Color,
    pub side_bar_background: Color,
    pub border: Color,
    pub foreground: Color,
    pub muted_foreground: Color,
    pub accent: Color,
    pub success: Color,
    pub error: Color,
    pub warning: Color,
    pub text_selection_background: Color,
    pub hover_foreground: Color,
    pub hover_background: Color,
    pub hover_border: Color,
    pub hover_shadow: Color,
    pub list_hover_background: Color,
    pub list_active_background: Color,
    pub menu_foreground: Color,
    pub menu_background: Color,
    pub menu_hover_background: Color,
    pub action_bar_background: Color,
    pub key_hint_foreground: Color,
    pub key_hint_background: Color,
    pub tab_hover_background: Color,
    pub tab_active_background: Color,
    pub title_bar_background: Color,
    pub title_bar_foreground: Color,
    pub title_bar_action_foreground: Color,
    pub title_bar_hover_background: Color,
    pub editor_foreground: Color,
    pub editor_syntax: EditorSyntaxColors,
    pub editor_text: TypographyStyle,
    pub editor_header: TypographyStyle,
    pub compact_action_label: TypographyStyle,
    pub interface_body: TypographyStyle,
    pub interface_control: TypographyStyle,
    pub interface_label: TypographyStyle,
    pub interface_metadata: TypographyStyle,
    pub interface_heading: TypographyStyle,
    pub(crate) font_size_body: f32,
    pub(crate) font_size_label: f32,
    pub(crate) scrollbar_size: f32,
    pub(crate) scrollbar: Color,
    pub(crate) scrollbar_hovered: Color,
    pub(crate) scrollbar_active: Color,
    pub diff_removed_line: Color,
    pub diff_inserted_line: Color,
    pub diff_removed_text: Color,
    pub diff_inserted_text: Color,
    pub diff_missing_line: Color,
    pub diff_unchanged_region: Color,
    pub diff_unchanged_region_foreground: Color,
    pub diff_removed_marker: Color,
    pub diff_inserted_marker: Color,
    terminal_colors: [Color; 16],
}

pub const DEFAULT_UI_THEME: UiTheme = UiTheme {
    workbench_background: Color::rgb(252, 252, 253),
    content_background: Color::WHITE,
    side_bar_background: Color::rgb(248, 248, 249),
    border: Color::rgb(222, 222, 224),
    foreground: Color::rgb(38, 38, 41),
    muted_foreground: Color::rgb(126, 126, 132),
    accent: Color::rgb(15, 110, 96),
    success: Color::rgb(16, 124, 16),
    error: Color::rgb(180, 38, 38),
    warning: Color::rgb(154, 103, 0),
    text_selection_background: Color::rgba(68, 139, 202, 72),
    hover_foreground: Color::rgb(245, 245, 247),
    hover_background: Color::rgb(45, 46, 51),
    hover_border: Color::rgba(255, 255, 255, 24),
    hover_shadow: Color::rgba(0, 0, 0, 48),
    list_hover_background: Color::rgb(232, 232, 232),
    list_active_background: Color::rgb(235, 235, 237),
    menu_foreground: Color::rgb(0, 0, 0),
    menu_background: Color::WHITE,
    menu_hover_background: Color::rgb(226, 226, 228),
    action_bar_background: Color::rgb(245, 245, 246),
    key_hint_foreground: Color::WHITE,
    key_hint_background: Color::rgb(96, 97, 102),
    tab_hover_background: Color::rgb(226, 226, 228),
    tab_active_background: Color::rgb(235, 235, 237),
    title_bar_background: Color::WHITE,
    title_bar_foreground: Color::rgb(31, 31, 31),
    title_bar_action_foreground: Color::rgb(66, 66, 66),
    title_bar_hover_background: Color::rgb(229, 229, 229),
    editor_foreground: Color::rgb(51, 51, 51),
    editor_syntax: EditorSyntaxColors {
        attribute: Color::rgb(51, 51, 51),
        comment: Color::rgb(0, 128, 0),
        constant: Color::rgb(9, 134, 88),
        constructor: Color::rgb(38, 127, 153),
        embedded: Color::rgb(51, 51, 51),
        function: Color::rgb(121, 94, 38),
        keyword: Color::rgb(175, 0, 219),
        label: Color::rgb(175, 0, 219),
        module: Color::rgb(38, 127, 153),
        number: Color::rgb(9, 134, 88),
        operator: Color::rgb(51, 51, 51),
        property: Color::rgb(51, 51, 51),
        punctuation: Color::rgb(51, 51, 51),
        regexp: Color::rgb(129, 31, 63),
        string: Color::rgb(163, 21, 21),
        type_name: Color::rgb(38, 127, 153),
        variable: Color::rgb(51, 51, 51),
    },
    editor_text: TypographyStyle::new(13.0, DEFAULT_EDITOR_LINE_HEIGHT, FontWeight::Normal),
    editor_header: TypographyStyle::new(12.0, DEFAULT_EDITOR_HEADER_HEIGHT, FontWeight::Bold),
    compact_action_label: TypographyStyle::new(12.0, 16.0, FontWeight::SemiBold),
    interface_body: TypographyStyle::new(13.0, 18.0, FontWeight::Normal),
    interface_control: TypographyStyle::new(13.0, 18.0, FontWeight::Medium),
    interface_label: TypographyStyle::new(12.0, 18.0, FontWeight::Normal),
    interface_metadata: TypographyStyle::new(11.0, 16.0, FontWeight::Normal),
    interface_heading: TypographyStyle::new(18.0, 24.0, FontWeight::SemiBold),
    font_size_body: 13.0,
    font_size_label: 12.0,
    scrollbar_size: 10.0,
    scrollbar: Color::rgba(100, 100, 100, 51),
    scrollbar_hovered: Color::rgba(100, 100, 100, 89),
    scrollbar_active: Color::rgba(0, 0, 0, 51),
    diff_removed_line: Color::rgb(255, 235, 233),
    diff_inserted_line: Color::rgb(218, 251, 225),
    diff_removed_text: Color::rgb(255, 198, 194),
    diff_inserted_text: Color::rgb(166, 235, 183),
    diff_missing_line: Color::rgb(248, 248, 249),
    diff_unchanged_region: Color::rgb(241, 246, 252),
    diff_unchanged_region_foreground: Color::rgb(126, 126, 132),
    diff_removed_marker: Color::rgb(161, 38, 13),
    diff_inserted_marker: Color::rgb(16, 124, 16),
    terminal_colors: [
        Color::rgb(36, 41, 47),
        Color::rgb(207, 34, 46),
        Color::rgb(17, 99, 41),
        Color::rgb(154, 103, 0),
        Color::rgb(9, 105, 218),
        Color::rgb(130, 80, 223),
        Color::rgb(27, 124, 131),
        Color::rgb(38, 38, 41),
        Color::rgb(110, 119, 129),
        Color::rgb(164, 14, 38),
        Color::rgb(26, 127, 55),
        Color::rgb(191, 135, 0),
        Color::rgb(33, 139, 255),
        Color::rgb(164, 117, 249),
        Color::rgb(49, 146, 170),
        Color::rgb(140, 149, 159),
    ],
};

pub const DEFAULT_UI_TYPOGRAPHY: UiTypography = UiTypography {
    family: FontFamily::SansSerif,
    body: DEFAULT_UI_THEME.interface_body,
    control: DEFAULT_UI_THEME.interface_control,
    label: DEFAULT_UI_THEME.interface_label,
    metadata: DEFAULT_UI_THEME.interface_metadata,
    heading: DEFAULT_UI_THEME.interface_heading,
};

impl UiTheme {
    pub const fn font_size_body(self) -> f32 {
        self.font_size_body
    }

    pub const fn font_size_label(self) -> f32 {
        self.font_size_label
    }

    pub fn from_snapshot(theme: &ThemeSnapshot) -> Result<Self, ThemeError> {
        let mut terminal_colors = [Color::TRANSPARENT; 16];
        for (index, token) in tokens::TERMINAL_ANSI.iter().enumerate() {
            terminal_colors[index] = theme_color(theme, token)?;
        }
        Ok(Self {
            workbench_background: theme_color(theme, tokens::WORKBENCH_BACKGROUND)?,
            content_background: theme_color(theme, tokens::EDITOR_BACKGROUND)?,
            side_bar_background: theme_color(theme, tokens::SIDE_BAR_BACKGROUND)?,
            border: theme_color(theme, tokens::BORDER)?,
            foreground: theme_color(theme, tokens::FOREGROUND)?,
            muted_foreground: theme_color(theme, tokens::MUTED_FOREGROUND)?,
            accent: theme_color(theme, tokens::ACCENT_FOREGROUND)?,
            success: theme_color(theme, tokens::SUCCESS_FOREGROUND)?,
            error: theme_color(theme, tokens::ERROR_FOREGROUND)?,
            warning: theme_color(theme, tokens::WARNING_FOREGROUND)?,
            text_selection_background: theme_color(theme, tokens::SELECTION_BACKGROUND)?,
            hover_foreground: theme_color(theme, tokens::HOVER_FOREGROUND)?,
            hover_background: theme_color(theme, tokens::HOVER_BACKGROUND)?,
            hover_border: theme_color(theme, tokens::HOVER_BORDER)?,
            hover_shadow: theme_color(theme, tokens::HOVER_SHADOW)?,
            list_hover_background: theme_color(theme, tokens::LIST_HOVER_BACKGROUND)?,
            list_active_background: theme_color(theme, tokens::LIST_ACTIVE_SELECTION_BACKGROUND)?,
            menu_foreground: theme_color(theme, tokens::MENU_FOREGROUND)?,
            menu_background: theme_color(theme, tokens::MENU_BACKGROUND)?,
            menu_hover_background: theme_color(theme, tokens::MENU_HOVER_BACKGROUND)?,
            action_bar_background: theme_color(theme, tokens::ACTION_BAR_BACKGROUND)?,
            key_hint_foreground: theme_color(theme, tokens::KEYBINDING_LABEL_FOREGROUND)?,
            key_hint_background: theme_color(theme, tokens::KEYBINDING_LABEL_BACKGROUND)?,
            tab_hover_background: theme_color(theme, tokens::TAB_LIST_HOVER_BACKGROUND)?,
            tab_active_background: theme_color(theme, tokens::TAB_LIST_ACTIVE_BACKGROUND)?,
            title_bar_background: theme_color(theme, tokens::TITLE_BAR_BACKGROUND)?,
            title_bar_foreground: theme_color(theme, tokens::TITLE_BAR_FOREGROUND)?,
            title_bar_action_foreground: theme_color(theme, tokens::TITLE_BAR_ACTION_FOREGROUND)?,
            title_bar_hover_background: theme_color(theme, tokens::TITLE_BAR_HOVER_BACKGROUND)?,
            editor_foreground: theme_color(theme, tokens::EDITOR_FOREGROUND)?,
            editor_syntax: EditorSyntaxColors {
                attribute: theme_color(theme, tokens::EDITOR_TOKEN_ATTRIBUTE)?,
                comment: theme_color(theme, tokens::EDITOR_TOKEN_COMMENT)?,
                constant: theme_color(theme, tokens::EDITOR_TOKEN_CONSTANT)?,
                constructor: theme_color(theme, tokens::EDITOR_TOKEN_CONSTRUCTOR)?,
                embedded: theme_color(theme, tokens::EDITOR_TOKEN_EMBEDDED)?,
                function: theme_color(theme, tokens::EDITOR_TOKEN_FUNCTION)?,
                keyword: theme_color(theme, tokens::EDITOR_TOKEN_KEYWORD)?,
                label: theme_color(theme, tokens::EDITOR_TOKEN_LABEL)?,
                module: theme_color(theme, tokens::EDITOR_TOKEN_MODULE)?,
                number: theme_color(theme, tokens::EDITOR_TOKEN_NUMBER)?,
                operator: theme_color(theme, tokens::EDITOR_TOKEN_OPERATOR)?,
                property: theme_color(theme, tokens::EDITOR_TOKEN_PROPERTY)?,
                punctuation: theme_color(theme, tokens::EDITOR_TOKEN_PUNCTUATION)?,
                regexp: theme_color(theme, tokens::EDITOR_TOKEN_REGEXP)?,
                string: theme_color(theme, tokens::EDITOR_TOKEN_STRING)?,
                type_name: theme_color(theme, tokens::EDITOR_TOKEN_TYPE)?,
                variable: theme_color(theme, tokens::EDITOR_TOKEN_VARIABLE)?,
            },
            editor_text: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_BODY1)?,
                DEFAULT_EDITOR_LINE_HEIGHT,
                FontWeight::Normal,
            ),
            editor_header: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_LABEL1)?,
                DEFAULT_EDITOR_HEADER_HEIGHT,
                FontWeight::Bold,
            ),
            compact_action_label: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_LABEL1)?,
                16.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_SEMI_BOLD)?,
            ),
            interface_body: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_BODY1)?,
                18.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_REGULAR)?,
            ),
            interface_control: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_BODY1)?,
                18.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_MEDIUM)?,
            ),
            interface_label: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_LABEL1)?,
                18.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_REGULAR)?,
            ),
            interface_metadata: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_LABEL2)?,
                16.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_REGULAR)?,
            ),
            interface_heading: TypographyStyle::new(
                theme.required_pixel_size(tokens::FONT_SIZE_HEADING2)?,
                24.0,
                theme_font_weight(theme, tokens::FONT_WEIGHT_SEMI_BOLD)?,
            ),
            font_size_body: theme.required_pixel_size(tokens::FONT_SIZE_BODY1)?,
            font_size_label: theme.required_pixel_size(tokens::FONT_SIZE_LABEL1)?,
            scrollbar_size: theme.required_pixel_size(tokens::SCROLLBAR_SIZE)?,
            scrollbar: theme_color(theme, tokens::SCROLLBAR_SLIDER_BACKGROUND)?,
            scrollbar_hovered: theme_color(theme, tokens::SCROLLBAR_SLIDER_HOVER_BACKGROUND)?,
            scrollbar_active: theme_color(theme, tokens::SCROLLBAR_SLIDER_ACTIVE_BACKGROUND)?,
            diff_removed_line: theme_color(theme, tokens::DIFF_REMOVED_LINE_BACKGROUND)?,
            diff_inserted_line: theme_color(theme, tokens::DIFF_INSERTED_LINE_BACKGROUND)?,
            diff_removed_text: theme_color(theme, tokens::DIFF_REMOVED_TEXT_BACKGROUND)?,
            diff_inserted_text: theme_color(theme, tokens::DIFF_INSERTED_TEXT_BACKGROUND)?,
            diff_missing_line: theme_color(theme, tokens::DIFF_MISSING_LINE_BACKGROUND)?,
            diff_unchanged_region: theme_color(theme, tokens::DIFF_UNCHANGED_REGION_BACKGROUND)?,
            diff_unchanged_region_foreground: theme_color(
                theme,
                tokens::DIFF_UNCHANGED_REGION_FOREGROUND,
            )?,
            diff_removed_marker: theme_color(theme, tokens::DIFF_REMOVED_LINE_MARKER)?,
            diff_inserted_marker: theme_color(theme, tokens::DIFF_INSERTED_LINE_MARKER)?,
            terminal_colors,
        })
    }

    pub fn terminal_indexed_color(self, index: u8) -> Color {
        self.terminal_colors
            .get(usize::from(index))
            .copied()
            .unwrap_or(self.foreground)
    }

    pub fn search_box_style(self) -> SearchBoxStyle {
        self.search_box_style_with_typography(&DEFAULT_UI_TYPOGRAPHY)
    }

    pub fn search_box_style_with_typography(self, typography: &UiTypography) -> SearchBoxStyle {
        let input_box = InputBoxStyle::new(
            InputBoxStateColors::new(Color::TRANSPARENT, Color::TRANSPARENT, Color::TRANSPARENT),
            InputBoxStateColors::new(Color::TRANSPARENT, Color::TRANSPARENT, Color::TRANSPARENT),
            typography
                .label_text(self.foreground)
                .with_line_height(16.0),
            typography
                .label_text(self.muted_foreground)
                .with_line_height(16.0),
        )
        .with_border_width(0.0)
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_padding(Edges::new(4.0, 8.0, 4.0, 8.0))
        .with_selection_color(self.text_selection_background)
        .with_caret_color(self.accent)
        .with_preedit_underline_color(self.accent);
        SearchBoxStyle::new(input_box, icons::SEARCH, self.muted_foreground).with_icon_size(18.0)
    }

    pub fn terminal_scroll_view_style(self) -> ScrollViewStyle {
        self.overlay_scroll_view_style()
    }

    pub fn file_list_scroll_view_style(self) -> ScrollViewStyle {
        self.overlay_scroll_view_style()
    }

    pub fn picker_scroll_view_style(self) -> ScrollViewStyle {
        self.overlay_scroll_view_style()
    }

    pub fn tab_container_scroll_view_style(self) -> ScrollViewStyle {
        self.overlay_scroll_view_style()
    }

    pub(crate) fn overlay_scroll_view_style(self) -> ScrollViewStyle {
        ScrollViewStyle::new(
            ScrollbarStyle::new(Color::TRANSPARENT, self.scrollbar)
                .with_thickness(self.scrollbar_size)
                .with_hovered_colors(Color::TRANSPARENT, self.scrollbar_hovered)
                .with_active_colors(Color::TRANSPARENT, self.scrollbar_active),
        )
    }
}

pub(crate) fn theme_color(theme: &ThemeSnapshot, token: &str) -> Result<Color, ThemeError> {
    let [red, green, blue, alpha] = theme.required_color(token)?.components();
    Ok(Color::rgba(red, green, blue, alpha))
}

fn theme_font_weight(theme: &ThemeSnapshot, token: &str) -> Result<FontWeight, ThemeError> {
    let size = theme.required_size(token)?;
    let Some(value) = size.as_unitless() else {
        return Err(ThemeError::SizeUnitMismatch {
            token: token.to_owned(),
            expected: ThemeSizeUnit::Unitless,
            actual: size.unit(),
        });
    };
    match value {
        400.0 => Ok(FontWeight::Normal),
        500.0 => Ok(FontWeight::Medium),
        600.0 => Ok(FontWeight::SemiBold),
        _ => Err(ThemeError::InvalidSizeValue {
            token: token.to_owned(),
            value: value.to_string(),
        }),
    }
}

#[cfg(test)]
#[path = "palette_tests.rs"]
mod tests;
