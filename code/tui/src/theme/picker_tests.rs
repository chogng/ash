use std::collections::BTreeMap;

use super::ThemeSelectionAction;
use super::custom_theme_choices;
use super::theme_choices;
use crate::theme::ThemePickerCatalog;
use crate::theme::ThemePickerChoice;
use crate::theme::ThemePickerTarget;
use crate::theme::ThemePreviewPalette;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionState;
use ratatui::style::Color;

fn palette(focus: Color) -> ThemePreviewPalette {
    ThemePreviewPalette {
        background: Color::Black,
        border: Color::Gray,
        foreground: Color::White,
        muted: Color::DarkGray,
        focus,
        selection_foreground: focus,
        keyword: Color::Red,
        string: Color::Blue,
        function: Color::Magenta,
        r#type: Color::Cyan,
        variable: Color::Yellow,
        inserted_background: Color::Green,
        removed_background: Color::Red,
        inserted_marker: Color::LightGreen,
        removed_marker: Color::LightRed,
    }
}

fn catalog() -> ThemePickerCatalog {
    let labels = [
        "Auto (match terminal)",
        "Dark mode",
        "Light mode",
        "Dark mode (colorblind-friendly)",
        "Light mode (colorblind-friendly)",
        "Dark mode (ANSI colors only)",
        "Light mode (ANSI colors only)",
    ];
    let mut choices = labels
        .into_iter()
        .enumerate()
        .map(|(index, label)| ThemePickerChoice {
            label: label.into(),
            palette_label: format!("Palette {index}"),
            target: ThemePickerTarget::Preference(format!("theme-{index}")),
            palette: palette(Color::Indexed(index as u8)),
            selected: index == 1,
        })
        .collect::<Vec<_>>();
    choices.push(ThemePickerChoice {
        label: "Custom color theme".into(),
        palette_label: "User-defined".into(),
        target: ThemePickerTarget::CustomThemes,
        palette: palette(Color::Magenta),
        selected: false,
    });
    ThemePickerCatalog {
        choices,
        custom_choices: vec![ThemePickerChoice {
            label: "Aurora".into(),
            palette_label: "User-defined · Aurora".into(),
            target: ThemePickerTarget::Preference("aurora".into()),
            palette: palette(Color::Cyan),
            selected: false,
        }],
    }
}

#[test]
fn custom_row_opens_the_custom_theme_model() {
    let catalog = catalog();
    let view = theme_choices(&catalog);
    assert_eq!(
        view.actions.get(&ListSelectionItemId::new("theme-7")),
        Some(&ThemeSelectionAction::OpenCustomThemes)
    );

    let custom = custom_theme_choices(&catalog);
    let state = ListSelectionState::new(custom.model);
    assert_eq!(state.title(), "Custom color themes");
    assert_eq!(state.visible_items()[0].label(), "1. Aurora");
    assert_eq!(
        custom.actions,
        BTreeMap::from([(
            ListSelectionItemId::new("theme-0"),
            ThemeSelectionAction::SelectCustom {
                preference: "aurora".into(),
            },
        )])
    );
}
