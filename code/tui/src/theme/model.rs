use ratatui::style::Color;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ThemePreviewPalette {
    pub(crate) background: Color,
    pub(crate) border: Color,
    pub(crate) foreground: Color,
    pub(crate) muted: Color,
    pub(crate) focus: Color,
    pub(crate) selection_foreground: Color,
    pub(crate) keyword: Color,
    pub(crate) string: Color,
    pub(crate) function: Color,
    pub(crate) r#type: Color,
    pub(crate) variable: Color,
    pub(crate) inserted_background: Color,
    pub(crate) removed_background: Color,
    pub(crate) inserted_marker: Color,
    pub(crate) removed_marker: Color,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ThemePickerTarget {
    Preference(String),
    CustomThemes,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ThemePickerChoice {
    pub(crate) label: String,
    pub(crate) palette_label: String,
    pub(crate) target: ThemePickerTarget,
    pub(crate) palette: ThemePreviewPalette,
    pub(crate) selected: bool,
}

pub(crate) struct ThemePickerCatalog {
    pub(crate) choices: Vec<ThemePickerChoice>,
    pub(crate) custom_choices: Vec<ThemePickerChoice>,
}
