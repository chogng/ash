use ash_keybinding::Chord;
use ash_keybinding::KeySequence;
use ash_keybinding::KeyStroke;
use ash_keybinding::LogicalKey;
use ash_keybinding::Modifiers;
use ash_keybinding::ShortcutModifiers;
use ash_keybinding::parse_key_sequence;
use ash_keybinding::serialize_key_sequence;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

pub(crate) fn key_event_to_config_key(key: &KeyEvent) -> Result<String, String> {
    let normalized = normalized_key(key)
        .ok_or_else(|| "that terminal key cannot be stored in the Ash Code keymap".to_owned())?;
    let sequence = KeySequence::new(vec![normalized.chord]).map_err(|error| error.to_string())?;
    Ok(serialize_key_sequence(&sequence))
}

pub(crate) fn compose_config_chord(first: &str, second: &str) -> Result<String, String> {
    let sequence =
        parse_key_sequence(&format!("{first} {second}")).map_err(|error| error.to_string())?;
    Ok(serialize_key_sequence(&sequence))
}

pub(super) struct NormalizedKey {
    pub(super) stroke: KeyStroke,
    pub(super) chord: Chord,
}

pub(super) fn normalized_key(key: &KeyEvent) -> Option<NormalizedKey> {
    if key.modifiers.contains(KeyModifiers::HYPER) {
        return None;
    }
    let logical_key_name = logical_key_name(key.code)?;
    let logical_key = LogicalKey::new(logical_key_name.clone())?;
    let mut modifiers = Modifiers::none();
    let mut shortcut_modifiers = ShortcutModifiers::none();
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        modifiers = modifiers.with_control();
        shortcut_modifiers = shortcut_modifiers.with_control();
    }
    if key.modifiers.contains(KeyModifiers::SHIFT) || key.code == KeyCode::BackTab {
        modifiers = modifiers.with_shift();
        shortcut_modifiers = shortcut_modifiers.with_shift();
    }
    if key.modifiers.contains(KeyModifiers::ALT) {
        modifiers = modifiers.with_alt();
        shortcut_modifiers = shortcut_modifiers.with_alt();
    }
    if key
        .modifiers
        .intersects(KeyModifiers::SUPER | KeyModifiers::META)
    {
        modifiers = modifiers.with_meta();
        shortcut_modifiers = shortcut_modifiers.with_meta();
    }
    Some(NormalizedKey {
        stroke: KeyStroke::new(logical_key, None, modifiers),
        chord: Chord::logical(logical_key_name, shortcut_modifiers)?,
    })
}

fn logical_key_name(code: KeyCode) -> Option<String> {
    let name = match code {
        KeyCode::Backspace => "backspace",
        KeyCode::Enter => "enter",
        KeyCode::Left => "arrowleft",
        KeyCode::Right => "arrowright",
        KeyCode::Up => "arrowup",
        KeyCode::Down => "arrowdown",
        KeyCode::Home => "home",
        KeyCode::End => "end",
        KeyCode::PageUp => "pageup",
        KeyCode::PageDown => "pagedown",
        KeyCode::Tab | KeyCode::BackTab => "tab",
        KeyCode::Delete => "delete",
        KeyCode::Insert => "insert",
        KeyCode::Esc => "escape",
        KeyCode::Char(character) => return Some(character.to_string()),
        KeyCode::F(number) => return Some(format!("f{number}")),
        _ => return None,
    };
    Some(name.to_owned())
}
