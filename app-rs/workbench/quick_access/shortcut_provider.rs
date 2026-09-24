use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::format_key_sequence;
use ash_settings::KeyboardShortcutRow;

use super::QuickAccessProvider;
use crate::presentation::WorkbenchKeybindings;

/// One shortcut candidate retained independently from the keybinding store.
pub(crate) struct ShortcutItem {
    command: AppCommandId,
    keybinding: Option<KeySequence>,
}

impl ShortcutItem {
    pub(crate) fn row(&self) -> KeyboardShortcutRow<'_, AppCommandId> {
        KeyboardShortcutRow::new(
            self.command,
            ash_settings::keyboard_shortcut_row_element(self.command),
            self.command.label(),
            self.keybinding.as_ref(),
        )
    }
}

/// Reads the command catalog and current keybindings for the shortcut quick-access entry.
pub(crate) struct ShortcutProvider<'a> {
    keybindings: &'a dyn WorkbenchKeybindings,
}

impl<'a> ShortcutProvider<'a> {
    pub(crate) const fn new(keybindings: &'a dyn WorkbenchKeybindings) -> Self {
        Self { keybindings }
    }

    pub(crate) fn command_for_element(element: zui::ui::ElementId) -> Option<AppCommandId> {
        AppCommandId::BINDABLE
            .into_iter()
            .find(|command| ash_settings::keyboard_shortcut_row_element(*command) == element)
    }

    fn matches(
        query: &str,
        command: AppCommandId,
        keybinding: Option<&KeySequence>,
        platform: HostPlatform,
    ) -> bool {
        if query.is_empty() {
            return true;
        }
        command.label().to_lowercase().contains(query)
            || keybinding.is_some_and(|keybinding| {
                let shortcut = format_key_sequence(keybinding, platform).to_lowercase();
                let shortcut = shortcut
                    .chars()
                    .filter(|character| !character.is_whitespace() && *character != '+')
                    .collect::<String>();
                let query = query
                    .chars()
                    .filter(|character| !character.is_whitespace() && *character != '+')
                    .collect::<String>();
                shortcut.contains(&query)
            })
    }
}

impl QuickAccessProvider for ShortcutProvider<'_> {
    type Item = ShortcutItem;

    fn items(&self, query: &str) -> Vec<Self::Item> {
        let query = query.trim().to_lowercase();
        let platform = self.keybindings.platform();
        AppCommandId::BINDABLE
            .into_iter()
            .filter_map(|command| {
                let keybinding = self.keybindings.binding_for_command(command);
                Self::matches(&query, command, keybinding, platform).then(|| ShortcutItem {
                    command,
                    keybinding: keybinding.cloned(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "shortcut_provider_tests.rs"]
mod tests;
