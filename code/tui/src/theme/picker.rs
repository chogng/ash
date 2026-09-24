use crate::keymap::bindings;
use std::collections::BTreeMap;

use crate::render::SyntaxPalette;
use crate::render::highlight_code;
use crate::theme::ThemePickerCatalog;
use crate::theme::ThemePickerChoice;
use crate::theme::ThemePickerTarget;
use crate::theme::ThemePreviewPalette;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionPreview;
use crate::widgets::list_selection::ListSelectionSpec;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ThemeSelectionAction {
    Select { preference: String },
    SelectCustom { preference: String },
    OpenCustomThemes,
}

#[derive(Clone, Copy)]
enum ThemePickerLevel {
    Main,
    Custom,
}

pub(crate) type ThemeChoices = ListSelectionSpec<ThemeSelectionAction>;

#[derive(Debug)]
pub(crate) struct ThemePicker {
    pages: Vec<ListSelection<ThemeSelectionAction>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ThemePickerOutcome {
    Select { preference: String },
    SelectCustom { preference: String },
    OpenCustomThemes,
    Consumed,
    Dismiss,
}

impl ThemePicker {
    pub(crate) fn new(spec: ThemeChoices) -> Self {
        Self {
            pages: vec![ListSelection::new(spec.model, spec.actions)],
        }
    }

    pub(crate) fn push_custom(&mut self, spec: ThemeChoices) {
        self.pages
            .push(ListSelection::new(spec.model, spec.actions));
    }

    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.pages
            .last()
            .expect("a theme picker always has a selection page")
            .key_hints()
    }

    pub(crate) fn selection(&self) -> &crate::widgets::list_selection::ListSelectionState {
        self.pages
            .last()
            .expect("a theme picker always has a selection page")
            .state()
    }

    pub(crate) fn handle_key(&mut self, key: crossterm::event::KeyEvent) -> ThemePickerOutcome {
        let outcome = self
            .pages
            .last_mut()
            .expect("a theme picker always has a selection page")
            .handle_key(key);
        self.apply_selection_outcome(outcome)
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        self.pages
            .last_mut()
            .expect("a theme picker always has a selection page")
            .handle_paste(pasted);
    }

    pub(crate) fn selection_mut(
        &mut self,
    ) -> &mut crate::widgets::list_selection::ListSelectionState {
        self.pages
            .last_mut()
            .expect("a theme picker always has a selection page")
            .state_mut()
    }

    fn apply_selection_outcome(
        &mut self,
        outcome: ListSelectionOutcome<ThemeSelectionAction>,
    ) -> ThemePickerOutcome {
        match outcome {
            ListSelectionOutcome::Activate(ThemeSelectionAction::Select { preference }) => {
                ThemePickerOutcome::Select { preference }
            }
            ListSelectionOutcome::Activate(ThemeSelectionAction::SelectCustom { preference }) => {
                ThemePickerOutcome::SelectCustom { preference }
            }
            ListSelectionOutcome::Activate(ThemeSelectionAction::OpenCustomThemes) => {
                ThemePickerOutcome::OpenCustomThemes
            }
            ListSelectionOutcome::Adjust(_, _)
            | ListSelectionOutcome::Consumed
            | ListSelectionOutcome::FocusPrevious => ThemePickerOutcome::Consumed,
            ListSelectionOutcome::Dismiss if self.pages.len() > 1 => {
                self.pages.pop();
                ThemePickerOutcome::Consumed
            }
            ListSelectionOutcome::Dismiss => ThemePickerOutcome::Dismiss,
        }
    }
}

pub(crate) fn theme_choices(catalog: &ThemePickerCatalog) -> ThemeChoices {
    list_selection("Theme", &catalog.choices, ThemePickerLevel::Main)
}

pub(crate) fn custom_theme_choices(catalog: &ThemePickerCatalog) -> ThemeChoices {
    list_selection(
        "Custom color themes",
        &catalog.custom_choices,
        ThemePickerLevel::Custom,
    )
}

fn list_selection(
    title: &str,
    choices: &[ThemePickerChoice],
    level: ThemePickerLevel,
) -> ThemeChoices {
    let mut actions = BTreeMap::new();
    let mut selected = 0;
    let items = if choices.is_empty() {
        vec![ListSelectionItem::new("No custom color themes found")]
    } else {
        choices
            .iter()
            .enumerate()
            .map(|(index, choice)| {
                if choice.selected {
                    selected = index;
                }
                theme_item(index, choice, level, &mut actions)
            })
            .collect()
    };
    ThemeChoices {
        model: ListSelectionModel::new(title, vec![ListSelectionGroup::new("Themes", items)])
            .with_activation(bindings::THEME_APPLY)
            .with_dismiss(match level {
                ThemePickerLevel::Main => bindings::DISMISS_LIST,
                ThemePickerLevel::Custom => bindings::RETURN_LIST,
            })
            .without_tab_bar()
            .with_initial_selected(selected)
            .with_empty_message("No color themes available"),
        actions,
    }
}

fn theme_item(
    index: usize,
    choice: &ThemePickerChoice,
    level: ThemePickerLevel,
    actions: &mut BTreeMap<ListSelectionItemId, ThemeSelectionAction>,
) -> ListSelectionItem {
    let item_id = ListSelectionItemId::new(format!("theme-{index}"));
    let action = match &choice.target {
        ThemePickerTarget::Preference(preference) => match level {
            ThemePickerLevel::Main => ThemeSelectionAction::Select {
                preference: preference.clone(),
            },
            ThemePickerLevel::Custom => ThemeSelectionAction::SelectCustom {
                preference: preference.clone(),
            },
        },
        ThemePickerTarget::CustomThemes => ThemeSelectionAction::OpenCustomThemes,
    };
    actions.insert(item_id.clone(), action);
    ListSelectionItem::new(format!("{}. {}", index + 1, choice.label))
        .with_id(item_id)
        .with_selection_foreground(choice.palette.selection_foreground)
        .with_presentation_focus(choice.palette.focus)
        .with_preview(
            ListSelectionPreview::new("Diff preview", diff_preview(choice.palette))
                .with_caption(Line::from(Span::styled(
                    format!("Syntax palette: {}", choice.palette_label),
                    Style::default().fg(choice.palette.muted),
                )))
                .with_separator_color(choice.palette.muted)
                .with_margins(1, 0),
        )
}

fn diff_preview(palette: ThemePreviewPalette) -> Vec<Line<'static>> {
    let syntax = SyntaxPalette {
        foreground: palette.foreground,
        function: palette.function,
        keyword: palette.keyword,
        muted: palette.muted,
        string: palette.string,
        r#type: palette.r#type,
        variable: palette.variable,
    };
    let mut lines = highlight_code(
        "fn greet(ash: &str) -> String {\n  format!(\"Hello, {}!\", ash)\n  format!(\"Hello, {ash}!\")\n}",
        "rust",
        syntax,
    );
    let prefixes = [
        ("1   ", palette.muted, palette.background),
        ("2  -  ", palette.removed_marker, palette.removed_background),
        (
            "2  +  ",
            palette.inserted_marker,
            palette.inserted_background,
        ),
        ("3   ", palette.muted, palette.background),
    ];
    for (line, (prefix, marker, background)) in lines.iter_mut().zip(prefixes) {
        line.spans
            .insert(0, Span::styled(prefix, Style::default().fg(marker)));
        line.style = Style::default().fg(palette.foreground).bg(background);
    }
    lines
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
