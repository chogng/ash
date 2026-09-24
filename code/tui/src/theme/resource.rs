use std::path::Path;
use std::path::PathBuf;

use ash_terminal_detection::BackgroundAppearance;
use ash_terminal_detection::ColorLevel;
use ash_terminal_detection::TerminalRgb;
use ash_terminal_detection::detect_host_terminal;
use ash_terminal_detection::resolve_background;
use serde::Deserialize;

mod document;

use document::read_user_themes;

use super::ThemePickerCatalog;
use super::ThemePickerChoice;
use super::ThemePickerTarget;
use super::ThemePreviewPalette;
use crate::render::RenderTheme;
use crate::render::ThemePalette;

const ASH_CODE_THEMES: [(&str, &str); 7] = [
    ("Auto (match terminal)", "system"),
    ("Dark mode", "ash-code-dark"),
    ("Light mode", "ash-code-light"),
    (
        "Dark mode (colorblind-friendly)",
        "ash-code-colorblind-dark",
    ),
    (
        "Light mode (colorblind-friendly)",
        "ash-code-colorblind-light",
    ),
    ("Dark mode (ANSI colors only)", "ash-code-ansi-dark"),
    ("Light mode (ANSI colors only)", "ash-code-ansi-light"),
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ThemeAppearance {
    Dark,
    Light,
}

#[derive(Clone, Copy)]
pub(super) enum ThemeSurface {
    Palette,
    Terminal,
}

impl ThemeAppearance {
    const fn base_palette(self) -> ThemePalette {
        match self {
            Self::Dark => ThemePalette::dark(),
            Self::Light => ThemePalette::light(),
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Dark => "Dark",
            Self::Light => "Light",
        }
    }
}

#[derive(Clone)]
pub(super) struct AvailableTheme {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) appearance: ThemeAppearance,
    pub(super) palette: ThemePalette,
    pub(super) surface: ThemeSurface,
    pub(super) ansi_only: bool,
    pub(super) user_defined: bool,
}

impl AvailableTheme {
    fn render(&self, capability: ColorLevel) -> RenderTheme {
        let capability = if self.ansi_only {
            ColorLevel::Ansi16
        } else {
            capability
        };
        let theme = RenderTheme::from_palette(self.palette, capability);
        match self.surface {
            ThemeSurface::Palette => theme,
            ThemeSurface::Terminal => theme.with_terminal_defaults(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ThemeResource {
    product_root: PathBuf,
    capability: ColorLevel,
    system_appearance: ThemeAppearance,
    terminal_background: Option<TerminalRgb>,
}

pub(crate) struct ThemeLoad {
    pub(crate) theme: RenderTheme,
    pub(crate) diagnostics: Vec<String>,
}

pub(crate) struct ThemeSelection {
    pub(crate) label: String,
    pub(crate) theme: RenderTheme,
}

impl ThemeResource {
    pub(crate) fn in_product_root(
        product_root: PathBuf,
        terminal_background: Option<TerminalRgb>,
    ) -> Self {
        Self {
            product_root,
            capability: detect_host_terminal().color_level,
            system_appearance: detect_system_appearance(terminal_background),
            terminal_background,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        product_root: PathBuf,
        capability: ColorLevel,
        system_appearance: ThemeAppearance,
    ) -> Self {
        Self {
            product_root,
            capability,
            system_appearance,
            terminal_background: None,
        }
    }

    pub(crate) fn load(&self, preference: &str) -> Result<ThemeLoad, String> {
        let mut diagnostics = Vec::new();
        let themes = available_themes(&self.product_root, &mut diagnostics);
        let selected = match resolve_theme(&themes, preference, self.system_appearance) {
            Some(theme) => theme,
            None => {
                diagnostics.push(format!(
                    "TUI theme '{preference}' is unavailable; using Auto"
                ));
                system_theme(self.system_appearance)
            }
        };
        Ok(ThemeLoad {
            theme: self.render(&selected),
            diagnostics,
        })
    }

    pub(crate) fn catalog(&self, preference: &str) -> Result<ThemePickerCatalog, String> {
        let mut diagnostics = Vec::new();
        let themes = available_themes(&self.product_root, &mut diagnostics);
        let selected = resolve_theme(&themes, preference, self.system_appearance)
            .map(|_| preference)
            .unwrap_or("system");
        let selected_is_custom = themes
            .iter()
            .any(|theme| theme.user_defined && theme.id == selected);
        let choices = ASH_CODE_THEMES
            .into_iter()
            .map(|(label, preference)| {
                let theme = resolve_theme(&themes, preference, self.system_appearance)
                    .expect("every built-in TUI theme preference is available");
                picker_choice(
                    label,
                    preference,
                    &theme,
                    selected == preference,
                    self.capability,
                )
            })
            .chain(std::iter::once(ThemePickerChoice {
                label: "Custom color theme".into(),
                palette_label: "User-defined".into(),
                target: ThemePickerTarget::CustomThemes,
                palette: preview_palette(
                    resolve_theme(&themes, selected, self.system_appearance)
                        .unwrap_or_else(|| system_theme(self.system_appearance))
                        .render(self.capability),
                ),
                selected: selected_is_custom,
            }))
            .collect();
        let custom_choices = themes
            .iter()
            .filter(|theme| theme.user_defined)
            .map(|theme| {
                picker_choice(
                    &theme.label,
                    &theme.id,
                    theme,
                    selected == theme.id,
                    self.capability,
                )
            })
            .collect();
        Ok(ThemePickerCatalog {
            choices,
            custom_choices,
        })
    }

    pub(crate) fn resolve(&self, preference: &str) -> Result<ThemeSelection, String> {
        if preference.is_empty() || preference.split_whitespace().count() != 1 {
            return Err("usage: /theme <theme-id>".into());
        }
        let mut diagnostics = Vec::new();
        let themes = available_themes(&self.product_root, &mut diagnostics);
        let theme = resolve_theme(&themes, preference, self.system_appearance)
            .ok_or_else(|| format!("theme '{preference}' is not a Ash Code theme"))?;
        let rendered = self.render(&theme);
        Ok(ThemeSelection {
            label: theme.label,
            theme: rendered,
        })
    }

    fn render(&self, theme: &AvailableTheme) -> RenderTheme {
        let theme = theme.render(self.capability);
        match self.terminal_background {
            Some(rgb) => theme.with_terminal_background([rgb.red, rgb.green, rgb.blue]),
            None => theme,
        }
    }
}

fn built_in_themes() -> Vec<AvailableTheme> {
    vec![
        built_in(
            "ash-code-dark",
            "Ash Code Dark",
            ThemeAppearance::Dark,
            ThemePalette::dark(),
            false,
        ),
        built_in(
            "ash-code-light",
            "Ash Code Light",
            ThemeAppearance::Light,
            ThemePalette::light(),
            false,
        ),
        built_in(
            "ash-code-colorblind-dark",
            "Ash Code Colorblind Dark",
            ThemeAppearance::Dark,
            ThemePalette::colorblind_dark(),
            false,
        ),
        built_in(
            "ash-code-colorblind-light",
            "Ash Code Colorblind Light",
            ThemeAppearance::Light,
            ThemePalette::colorblind_light(),
            false,
        ),
        built_in(
            "ash-code-ansi-dark",
            "Ash Code ANSI Dark",
            ThemeAppearance::Dark,
            ThemePalette::dark(),
            true,
        ),
        built_in(
            "ash-code-ansi-light",
            "Ash Code ANSI Light",
            ThemeAppearance::Light,
            ThemePalette::light(),
            true,
        ),
    ]
}

fn built_in(
    id: &str,
    label: &str,
    appearance: ThemeAppearance,
    palette: ThemePalette,
    ansi_only: bool,
) -> AvailableTheme {
    AvailableTheme {
        id: id.into(),
        label: label.into(),
        appearance,
        palette,
        surface: ThemeSurface::Palette,
        ansi_only,
        user_defined: false,
    }
}

fn system_theme(appearance: ThemeAppearance) -> AvailableTheme {
    AvailableTheme {
        id: "system".into(),
        label: format!("Ash Code {}", appearance.label()),
        appearance,
        palette: appearance.base_palette(),
        surface: ThemeSurface::Terminal,
        ansi_only: false,
        user_defined: false,
    }
}

fn available_themes(product_root: &Path, diagnostics: &mut Vec<String>) -> Vec<AvailableTheme> {
    let mut themes = built_in_themes();
    let mut user_themes = read_user_themes(product_root, diagnostics);
    user_themes.retain(|theme| {
        let reserved = theme.id == "system" || themes.iter().any(|item| item.id == theme.id);
        if reserved {
            diagnostics.push(format!("custom TUI theme id '{}' is reserved", theme.id));
        }
        !reserved
    });
    themes.extend(user_themes);
    themes
}

fn resolve_theme(
    themes: &[AvailableTheme],
    preference: &str,
    system_appearance: ThemeAppearance,
) -> Option<AvailableTheme> {
    if preference == "system" {
        return Some(system_theme(system_appearance));
    }
    themes.iter().find(|theme| theme.id == preference).cloned()
}

fn picker_choice(
    label: &str,
    preference: &str,
    theme: &AvailableTheme,
    selected: bool,
    capability: ColorLevel,
) -> ThemePickerChoice {
    let palette_label = if theme.user_defined {
        format!("User-defined · {}", theme.appearance.label())
    } else if theme.id.contains("colorblind") {
        format!("GitHub {} Colorblind", theme.appearance.label())
    } else if theme.id.contains("ansi") {
        format!("GitHub {} · ANSI 16 colors", theme.appearance.label())
    } else {
        format!("GitHub {}", theme.appearance.label())
    };
    ThemePickerChoice {
        label: label.into(),
        palette_label,
        target: ThemePickerTarget::Preference(preference.into()),
        palette: preview_palette(theme.render(capability)),
        selected,
    }
}

fn preview_palette(theme: RenderTheme) -> ThemePreviewPalette {
    ThemePreviewPalette {
        background: theme.background(),
        border: theme.border(),
        foreground: theme.foreground(),
        muted: theme.muted(),
        focus: theme.focus(),
        selection_foreground: theme.selection_foreground(),
        keyword: theme.keyword(),
        string: theme.string(),
        function: theme.function(),
        r#type: theme.r#type(),
        variable: theme.variable(),
        inserted_background: theme.inserted_background(),
        removed_background: theme.removed_background(),
        inserted_marker: theme.inserted_marker(),
        removed_marker: theme.removed_marker(),
    }
}

fn detect_system_appearance(terminal_background: Option<TerminalRgb>) -> ThemeAppearance {
    match resolve_background(terminal_background).appearance {
        BackgroundAppearance::Dark => ThemeAppearance::Dark,
        BackgroundAppearance::Light => ThemeAppearance::Light,
    }
}

#[cfg(test)]
#[path = "resource_tests.rs"]
mod tests;
