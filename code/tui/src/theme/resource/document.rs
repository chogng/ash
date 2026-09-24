use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use super::AvailableTheme;
use super::ThemeAppearance;
use super::ThemeSurface;
use crate::render::ThemePalette;
use crate::render::ThemeRgb;

const MAX_DOCUMENT_BYTES: u64 = 1_048_576;
const MAX_THEME_FILES: usize = 128;
const USER_THEME_VERSION: u8 = 2;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UserThemeDocument {
    schema_version: u8,
    id: String,
    label: String,
    appearance: ThemeAppearance,
    colors: BTreeMap<String, String>,
}

impl UserThemeDocument {
    fn parse(source: &str) -> Result<Self, String> {
        if source.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("TUI theme exceeds the 1 MiB limit".into());
        }
        let document: Self =
            serde_json::from_str(source).map_err(|error| format!("invalid JSON: {error}"))?;
        if document.schema_version != USER_THEME_VERSION {
            return Err(format!(
                "TUI theme schema version {} is unsupported",
                document.schema_version
            ));
        }
        if !valid_theme_id(&document.id) {
            return Err(format!(
                "TUI theme id '{}' must be lowercase kebab-case",
                document.id
            ));
        }
        if document.label.trim() != document.label
            || document.label.is_empty()
            || document.label.chars().count() > 80
        {
            return Err("TUI theme label must contain 1 to 80 trimmed characters".into());
        }
        if document.colors.len() > 64 {
            return Err("TUI theme contains more than 64 color overrides".into());
        }
        Ok(document)
    }

    fn into_theme(self) -> Result<AvailableTheme, String> {
        let mut palette = self.appearance.base_palette();
        for (name, value) in self.colors {
            apply_color(&mut palette, &name, ThemeRgb::parse(&value)?)?;
        }
        Ok(AvailableTheme {
            id: self.id,
            label: self.label,
            appearance: self.appearance,
            palette,
            surface: ThemeSurface::Palette,
            ansi_only: false,
            user_defined: true,
        })
    }
}

fn apply_color(palette: &mut ThemePalette, name: &str, color: ThemeRgb) -> Result<(), String> {
    let target = match name {
        "accent" => &mut palette.accent,
        "accentSurfaceBackground" => &mut palette.accent_surface_background,
        "accentSurfaceForeground" => &mut palette.accent_surface_foreground,
        "actionForeground" => &mut palette.action_foreground,
        "background" => &mut palette.background,
        "border" => &mut palette.border,
        "chatInputChrome" => &mut palette.chat_input_chrome,
        "danger" => &mut palette.danger,
        "disabledForeground" => &mut palette.disabled_foreground,
        "focus" => &mut palette.focus,
        "foreground" => &mut palette.foreground,
        "function" => &mut palette.function,
        "hoverBackground" => &mut palette.hover_background,
        "hoverForeground" => &mut palette.hover_foreground,
        "insertedBackground" => &mut palette.inserted_background,
        "insertedMarker" => &mut palette.inserted_marker,
        "keyword" => &mut palette.keyword,
        "modalBorder" => &mut palette.modal_border,
        "muted" => &mut palette.muted,
        "pressedBackground" => &mut palette.pressed_background,
        "pressedForeground" => &mut palette.pressed_foreground,
        "quickViewBackground" => &mut palette.overlay_background,
        "removedBackground" => &mut palette.removed_background,
        "removedMarker" => &mut palette.removed_marker,
        "string" => &mut palette.string,
        "success" => &mut palette.success,
        "selectionBackground" => &mut palette.selection_background,
        "selectionForeground" => &mut palette.selection_foreground,
        "screenSelectionBackground" => &mut palette.screen_selection_background,
        "screenSelectionForeground" => &mut palette.screen_selection_foreground,
        "type" => &mut palette.r#type,
        "transcriptJumpBackground" => &mut palette.transcript_jump_background,
        "userMessageBackground" => &mut palette.user_message_background,
        "variable" => &mut palette.variable,
        "warning" => &mut palette.warning,
        _ => return Err(format!("unknown TUI theme color '{name}'")),
    };
    *target = color;
    Ok(())
}

pub(super) fn read_user_themes(
    product_root: &Path,
    diagnostics: &mut Vec<String>,
) -> Vec<AvailableTheme> {
    let directory = product_root.join("themes");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            diagnostics.push(format!(
                "could not read TUI theme directory '{}': {error}",
                directory.display()
            ));
            return Vec::new();
        }
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let file_type = entry.file_type().ok()?;
            (file_type.is_file() && path.extension().is_some_and(|value| value == "json"))
                .then_some(path)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.truncate(MAX_THEME_FILES);
    let mut themes = Vec::<AvailableTheme>::new();
    for path in paths {
        let source = match read_bounded_text(&path) {
            Ok(source) => source,
            Err(error) => {
                diagnostics.push(format!(
                    "could not read TUI theme '{}': {error}",
                    path.display()
                ));
                continue;
            }
        };
        let theme =
            match UserThemeDocument::parse(&source).and_then(|document| document.into_theme()) {
                Ok(theme) => theme,
                Err(error) => {
                    diagnostics.push(format!(
                        "TUI theme '{}' is invalid: {error}",
                        path.display()
                    ));
                    continue;
                }
            };
        if themes.iter().any(|item| item.id == theme.id) {
            diagnostics.push(format!("duplicate custom TUI theme id '{}'", theme.id));
            continue;
        }
        themes.push(theme);
    }
    themes
}

fn read_bounded_text(path: &Path) -> std::io::Result<String> {
    let file = fs::File::open(path)?;
    let mut source = String::new();
    file.take(MAX_DOCUMENT_BYTES.saturating_add(1))
        .read_to_string(&mut source)?;
    if source.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds the 1 MiB limit",
        ));
    }
    Ok(source)
}

fn valid_theme_id(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}
