//! Runtime keymap resolution for the Ash Code TUI.
//!
//! This file is the module entry and runtime owner. Binding declarations,
//! chord lifecycle, and terminal key conversion live in focused submodules.

pub(crate) mod bindings;
mod chords;
mod input;

use ash_keybinding::BindingSet;
use ash_keybinding::HostPlatform;
use ash_keybinding::UserBinding;
use bindings::AppKeymapCondition;
use chords::PendingChord;

#[cfg(test)]
use bindings::AppKeybindingSpec;
pub(crate) use bindings::AppKeymapAction;
pub(crate) use bindings::AppKeymapContext;
pub(crate) use bindings::KeymapActionSnapshot;
pub(crate) use bindings::compile_app_user_bindings;
pub(crate) use bindings::fixed_bindings;
pub(crate) use chords::AppChordMatch;
#[cfg(test)]
use chords::KEY_CHORD_TIMEOUT;
pub(crate) use input::compose_config_chord;
pub(crate) use input::key_event_to_config_key;

/// Application-level shortcuts that sit above individual TUI components.
#[derive(Debug)]
pub(super) struct AppKeymap {
    single_bindings: BindingSet<AppKeymapCondition, AppKeymapAction>,
    chord_bindings: BindingSet<AppKeymapCondition, AppKeymapAction>,
    platform: HostPlatform,
    pending: Option<PendingChord>,
    user_bindings: Vec<AppUserBinding>,
}

pub(super) type AppUserBinding = UserBinding<AppKeymapAction, AppKeymapCondition>;

#[cfg(test)]
#[path = "keymap/keymap_tests.rs"]
mod tests;
