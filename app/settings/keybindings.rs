mod state;
mod view;

pub use state::ShortcutCommit;
pub use view::KeyboardShortcutRow;

use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::format_key_sequence;
use ash_ui_components::QuickInputIds;
use state::KeyboardShortcutsState as ShortcutRecorderState;
use view::KeyboardShortcuts;
use zui::ui::CaretVisibility;
use zui::ui::ElementId;
use zui::ui::InteractionFrame;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;
use zui::ui::UiFrame;

use crate::SettingsKeybindingRow;

const SHORTCUT_SCOPE: u32 = 3;

pub const KEYBOARD_SHORTCUTS: ElementId = ElementId::scoped(SHORTCUT_SCOPE, 1);
pub const KEYBOARD_SHORTCUTS_CLOSE: ElementId = ElementId::scoped(SHORTCUT_SCOPE, 2);
pub const KEYBOARD_SHORTCUTS_SEARCH: ElementId = ElementId::scoped(SHORTCUT_SCOPE, 3);

pub type KeyboardShortcutsState = ShortcutRecorderState<AppCommandId>;

const fn keyboard_shortcuts_ids(parent: ElementId) -> QuickInputIds {
    QuickInputIds::new(
        parent,
        KEYBOARD_SHORTCUTS,
        KEYBOARD_SHORTCUTS_CLOSE,
        KEYBOARD_SHORTCUTS_SEARCH,
    )
}

pub fn draw_keyboard_shortcuts_overlay(
    frame: &mut UiFrame<InteractionFrame>,
    viewport: Rect,
    state: &KeyboardShortcutsState,
    search_input: &TextInput,
    rows: &[KeyboardShortcutRow<'_, AppCommandId>],
    diagnostics: &[String],
    parent: ElementId,
    platform: HostPlatform,
    caret_visibility: CaretVisibility,
    text_layout: &mut TextInputLayoutEngine,
    dispatch: &UiDispatch,
) -> Option<Rect> {
    let shortcuts = KeyboardShortcuts::new(
        viewport,
        state,
        search_input,
        rows,
        diagnostics,
        keyboard_shortcuts_ids(parent),
        platform,
        caret_visibility,
        text_layout,
        dispatch,
    );
    let caret = shortcuts.search_caret_bounds();
    frame.draw_component(&shortcuts);
    caret
}

pub fn keyboard_shortcut_rows<'a>(
    mut binding_for_command: impl FnMut(AppCommandId) -> Option<&'a KeySequence>,
) -> Vec<KeyboardShortcutRow<'a, AppCommandId>> {
    AppCommandId::BINDABLE
        .into_iter()
        .map(|command| {
            KeyboardShortcutRow::new(
                command,
                keyboard_shortcut_row_element(command),
                command.label(),
                binding_for_command(command),
            )
        })
        .collect()
}

pub fn settings_keybinding_rows<'a>(
    platform: HostPlatform,
    binding_for_command: impl FnMut(AppCommandId) -> Option<&'a KeySequence>,
) -> Vec<SettingsKeybindingRow> {
    keyboard_shortcut_rows(binding_for_command)
        .into_iter()
        .map(|row| SettingsKeybindingRow {
            element: row.element,
            label: row.label.to_owned(),
            value: row
                .keybinding
                .map(|binding| format_key_sequence(binding, platform))
                .unwrap_or_else(|| "Unassigned".to_owned()),
        })
        .collect()
}

pub fn keyboard_shortcut_row_element(command: AppCommandId) -> ElementId {
    let index = AppCommandId::BINDABLE
        .into_iter()
        .position(|candidate| candidate == command)
        .expect("bindable command must have a stable row");
    ElementId::scoped(SHORTCUT_SCOPE, 10 + index as u32)
}

pub(crate) fn command_for_keyboard_shortcut_row(id: ElementId) -> Option<AppCommandId> {
    AppCommandId::BINDABLE
        .into_iter()
        .find(|command| keyboard_shortcut_row_element(*command) == id)
}

#[cfg(test)]
#[path = "keybindings/keybindings_tests.rs"]
mod tests;
