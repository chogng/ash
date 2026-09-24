use std::time::Instant;

use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybindings_host::recording_chord;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollState;
use ash_ui_components::ScrollbarController;
use ash_ui_components::ScrollbarPresentation;
use zui::input::ElementState;
use zui::input::Key;
use zui::input::KeyEvent;
use zui::input::ModifiersState;
use zui::input::NamedKey;
use zui::ui::ElementId;
use zui::ui::Point;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

use crate::KeyboardShortcutsState;
use crate::SETTINGS_CLOSE;
use crate::SETTINGS_NAV_APPEARANCE;
use crate::SETTINGS_NAV_GENERAL;
use crate::SETTINGS_NAV_KEYBINDINGS;
use crate::SETTINGS_NAV_REMOTE;
use crate::SettingsKeybindingsViewport;
use crate::SettingsPageSection;
use crate::SettingsScrollbarPointerOutcome;
use crate::keybindings::ShortcutCommit;
use crate::keybindings::command_for_keyboard_shortcut_row;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsActivation {
    Ignored,
    Changed,
    OpenRemote,
    Close,
}

pub struct SettingsState {
    section: SettingsPageSection,
    search: TextInput,
    keyboard_shortcuts: KeyboardShortcutsState,
    keybindings_scroll: ScrollState,
    keybindings_scrollbar: ScrollbarController,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            section: SettingsPageSection::default(),
            search: TextInput::default(),
            keyboard_shortcuts: KeyboardShortcutsState::default(),
            keybindings_scroll: ScrollState::default(),
            keybindings_scrollbar: ScrollbarController::default(),
        }
    }
}

impl SettingsState {
    pub const fn section(&self) -> SettingsPageSection {
        self.section
    }

    pub const fn search_input(&self) -> &TextInput {
        &self.search
    }

    pub const fn keybindings_scroll_state(&self) -> ScrollState {
        self.keybindings_scroll
    }

    pub fn keybindings_scrollbar_presentation(&self) -> ScrollbarPresentation {
        self.keybindings_scrollbar.presentation()
    }

    pub fn scroll_keybindings(
        &mut self,
        command: ScrollCommand,
        viewport: SettingsKeybindingsViewport,
        now: Instant,
    ) -> bool {
        let previous_presentation = self.keybindings_scrollbar.presentation();
        let previous_deadline = self.keybindings_scrollbar.next_deadline();
        let view = viewport.list(self.keybindings_scroll, previous_presentation);
        let changed = self.keybindings_scroll.apply(
            command,
            view.scroll_view().metrics(),
            ScrollAxis::Vertical,
        );
        self.keybindings_scrollbar.activity(now);
        changed
            || self.keybindings_scrollbar.presentation() != previous_presentation
            || self.keybindings_scrollbar.next_deadline() != previous_deadline
    }

    pub fn ensure_keybinding_visible(
        &mut self,
        element: ElementId,
        viewport: SettingsKeybindingsViewport,
        now: Instant,
    ) -> bool {
        let Some(command) = command_for_keyboard_shortcut_row(element) else {
            return false;
        };
        let Some(index) = AppCommandId::BINDABLE
            .into_iter()
            .position(|candidate| candidate == command)
        else {
            return false;
        };
        let list = viewport.list(
            self.keybindings_scroll,
            self.keybindings_scrollbar.presentation(),
        );
        let Some(command) = list.ensure_visible_command(index) else {
            return false;
        };
        self.scroll_keybindings(command, viewport, now)
    }

    pub fn keybindings_scrollbar_pointer_moved(
        &mut self,
        point: Point,
        viewport: SettingsKeybindingsViewport,
        now: Instant,
    ) -> SettingsScrollbarPointerOutcome {
        let view = viewport
            .list(
                self.keybindings_scroll,
                self.keybindings_scrollbar.presentation(),
            )
            .scroll_view();
        self.keybindings_scrollbar
            .pointer_moved(view, &mut self.keybindings_scroll, point, now)
    }

    pub fn press_keybindings_scrollbar(
        &mut self,
        point: Point,
        viewport: SettingsKeybindingsViewport,
        now: Instant,
    ) -> SettingsScrollbarPointerOutcome {
        let view = viewport.list(
            self.keybindings_scroll,
            self.keybindings_scrollbar.presentation(),
        );
        let scroll_view = view.scroll_view();
        self.keybindings_scrollbar
            .press(scroll_view, &mut self.keybindings_scroll, point, now)
    }

    pub fn release_keybindings_scrollbar(
        &mut self,
        point: Point,
        viewport: SettingsKeybindingsViewport,
        now: Instant,
    ) -> SettingsScrollbarPointerOutcome {
        let view = viewport
            .list(
                self.keybindings_scroll,
                self.keybindings_scrollbar.presentation(),
            )
            .scroll_view();
        self.keybindings_scrollbar.release(view, point, now)
    }

    pub fn keybindings_scrollbar_pointer_left(&mut self, now: Instant) -> bool {
        self.keybindings_scrollbar.pointer_left(now)
    }

    pub fn cancel_keybindings_scrollbar(&mut self) {
        self.keybindings_scrollbar.cancel();
    }

    pub fn advance_keybindings_scrollbar(&mut self, now: Instant) -> bool {
        self.keybindings_scrollbar.advance(now)
    }

    pub const fn keybindings_scrollbar_deadline(&self) -> Option<Instant> {
        self.keybindings_scrollbar.next_deadline()
    }

    pub fn selected_search_text(&self) -> Option<&str> {
        self.search.selected_text()
    }

    pub fn apply_search(&mut self, command: TextInputCommand) {
        self.search.apply(command);
    }

    pub fn apply_search_composition(&mut self, event: TextInputCompositionEvent) {
        self.search.apply_composition(event);
    }

    pub fn cancel_search_composition(&mut self) {
        self.search.cancel_composition();
    }

    pub const fn keyboard_shortcuts(&self) -> &KeyboardShortcutsState {
        &self.keyboard_shortcuts
    }

    pub fn reopen(&mut self) {
        self.keyboard_shortcuts.reset();
        self.cancel_keybindings_scrollbar();
    }

    pub fn reset_keyboard_shortcut_recording(&mut self) {
        self.keyboard_shortcuts.reset();
    }

    pub fn start_keyboard_shortcut_recording(&mut self, command: AppCommandId) {
        self.keyboard_shortcuts.start_recording(command);
    }

    pub fn close(&mut self) {
        self.search.cancel_composition();
        self.keyboard_shortcuts.reset();
        self.cancel_keybindings_scrollbar();
    }

    pub fn activate(&mut self, id: ElementId) -> SettingsActivation {
        match id {
            SETTINGS_CLOSE => SettingsActivation::Close,
            SETTINGS_NAV_GENERAL => self.select(SettingsPageSection::General),
            SETTINGS_NAV_APPEARANCE => self.select(SettingsPageSection::Appearance),
            SETTINGS_NAV_KEYBINDINGS => self.select(SettingsPageSection::Keybindings),
            SETTINGS_NAV_REMOTE => {
                self.section = SettingsPageSection::Remote;
                SettingsActivation::OpenRemote
            }
            _ => {
                let Some(command) = command_for_keyboard_shortcut_row(id) else {
                    return SettingsActivation::Ignored;
                };
                if self.section != SettingsPageSection::Keybindings {
                    return SettingsActivation::Ignored;
                }
                self.keyboard_shortcuts.start_recording(command);
                SettingsActivation::Changed
            }
        }
    }

    pub fn route_keyboard_shortcut_input(
        &mut self,
        event: &KeyEvent,
        modifiers: ModifiersState,
        platform: HostPlatform,
        now: Instant,
    ) -> bool {
        if event.state != ElementState::Pressed || !self.keyboard_shortcuts.is_recording() {
            return false;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.keyboard_shortcuts.cancel_recording();
            return true;
        }
        if !event.repeat
            && let Some(chord) = recording_chord(event, modifiers, platform)
        {
            self.keyboard_shortcuts.record(chord, now);
        }
        true
    }

    pub fn advance_keyboard_shortcuts(
        &mut self,
        now: Instant,
    ) -> Option<ShortcutCommit<AppCommandId>> {
        self.keyboard_shortcuts.advance(now)
    }

    pub fn keyboard_shortcuts_saved(&mut self, command: AppCommandId) {
        self.keyboard_shortcuts.saved(command.label());
    }

    pub fn keyboard_shortcuts_save_failed(&mut self, error: impl Into<String>) {
        self.keyboard_shortcuts.save_failed(error);
    }

    pub fn keyboard_shortcuts_window_blurred(&mut self) {
        self.keyboard_shortcuts.window_blurred();
        self.cancel_keybindings_scrollbar();
    }

    pub fn keyboard_shortcuts_deadline(&self) -> Option<Instant> {
        self.keyboard_shortcuts.deadline()
    }

    fn select(&mut self, section: SettingsPageSection) -> SettingsActivation {
        if section != SettingsPageSection::Keybindings {
            self.cancel_keybindings_scrollbar();
        }
        self.section = section;
        SettingsActivation::Changed
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
