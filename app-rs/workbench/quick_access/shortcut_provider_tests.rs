use ash_commands::AppCommandId;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::parse_key_sequence;

use super::QuickAccessProvider;
use super::ShortcutProvider;
use crate::presentation::WorkbenchKeybindings;

struct TestKeybindings {
    copy: KeySequence,
}

impl WorkbenchKeybindings for TestKeybindings {
    fn pending_keybinding(&self) -> Option<(&KeySequence, usize)> {
        None
    }

    fn platform(&self) -> HostPlatform {
        HostPlatform::MacOs
    }

    fn binding_for_command(&self, command: AppCommandId) -> Option<&KeySequence> {
        (command == AppCommandId::Copy).then_some(&self.copy)
    }
}

#[test]
fn shortcut_provider_filters_labels_and_formatted_shortcuts() {
    let keybindings = TestKeybindings {
        copy: parse_key_sequence("primary+c").expect("copy shortcut"),
    };
    let provider = ShortcutProvider::new(&keybindings);

    let label_matches = provider.items("copy");
    let shortcut_matches = provider.items("⌘c");

    assert_eq!(label_matches.len(), 1);
    assert_eq!(label_matches[0].row().command, AppCommandId::Copy);
    assert_eq!(shortcut_matches.len(), 1);
    assert_eq!(shortcut_matches[0].row().command, AppCommandId::Copy);
}
