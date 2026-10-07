use std::fmt;

use crate::Chord;
use crate::HostPlatform;
use crate::KeyIdentity;
use crate::KeySequence;
use crate::KeySequenceError;
use crate::ShortcutModifiers;
use crate::key::MAX_CHORDS;

/// A malformed portable keybinding string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeybindingParseError {
    Empty,
    TooManyChords { maximum: usize, actual: usize },
    MissingKey { chord: usize },
    MultipleKeys { chord: usize },
    DuplicateModifier { chord: usize, modifier: String },
    ConflictingPortableModifier { chord: usize },
    EmptyPhysicalKey { chord: usize },
}

impl fmt::Display for KeybindingParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("a keybinding requires at least one chord"),
            Self::TooManyChords { maximum, actual } => {
                write!(
                    formatter,
                    "a keybinding supports at most {maximum} chords, got {actual}"
                )
            }
            Self::MissingKey { chord } => write!(formatter, "chord {chord} does not declare a key"),
            Self::MultipleKeys { chord } => {
                write!(formatter, "chord {chord} declares more than one key")
            }
            Self::DuplicateModifier { chord, modifier } => {
                write!(formatter, "chord {chord} repeats modifier `{modifier}`")
            }
            Self::ConflictingPortableModifier { chord } => write!(
                formatter,
                "chord {chord} cannot combine `primary` with explicit `ctrl` or `meta`"
            ),
            Self::EmptyPhysicalKey { chord } => {
                write!(formatter, "chord {chord} contains an empty physical key")
            }
        }
    }
}

impl std::error::Error for KeybindingParseError {}

/// Parses one to four space-separated chords such as `primary+k primary+c`.
///
/// Logical keys use their host-reported name. Bracketed keys such as `[KeyK]` use a stable
/// physical code. `primary` maps to Command on macOS and Control on other supported hosts.
pub fn parse_key_sequence(value: &str) -> Result<KeySequence, KeybindingParseError> {
    let chord_values = value.split_whitespace().collect::<Vec<_>>();
    if chord_values.is_empty() {
        return Err(KeybindingParseError::Empty);
    }
    if chord_values.len() > MAX_CHORDS {
        return Err(KeybindingParseError::TooManyChords {
            maximum: MAX_CHORDS,
            actual: chord_values.len(),
        });
    }
    let chords = chord_values
        .into_iter()
        .enumerate()
        .map(|(index, value)| parse_chord(value, index + 1))
        .collect::<Result<Vec<_>, _>>()?;
    KeySequence::new(chords).map_err(|error| match error {
        KeySequenceError::Empty => KeybindingParseError::Empty,
        KeySequenceError::TooManyChords { maximum, actual } => {
            KeybindingParseError::TooManyChords { maximum, actual }
        }
    })
}

/// Produces a compact host label for a parsed sequence.
pub fn format_key_sequence(sequence: &KeySequence, platform: HostPlatform) -> String {
    sequence
        .chords()
        .iter()
        .map(|chord| format_chord(chord, platform))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Produces one display label per modifier and key for keycap-based UI.
pub fn keycap_labels(sequence: &KeySequence, platform: HostPlatform) -> Vec<Vec<String>> {
    sequence
        .chords()
        .iter()
        .map(|chord| keycap_labels_for_chord(chord, platform))
        .collect()
}

/// Serializes a sequence into the portable syntax accepted by [`parse_key_sequence`].
pub fn serialize_key_sequence(sequence: &KeySequence) -> String {
    sequence
        .chords()
        .iter()
        .map(serialize_chord)
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_chord(value: &str, chord: usize) -> Result<Chord, KeybindingParseError> {
    let mut modifiers = ModifierFlags::default();
    let mut key = None;
    for part in value.split('+') {
        if let Some(modifier) = modifier(part) {
            modifiers.insert(modifier, chord)?;
        } else if key.is_some() {
            return Err(KeybindingParseError::MultipleKeys { chord });
        } else {
            key = Some(part);
        }
    }
    if modifiers.primary && (modifiers.control || modifiers.meta) {
        return Err(KeybindingParseError::ConflictingPortableModifier { chord });
    }
    let key = key.ok_or(KeybindingParseError::MissingKey { chord })?;
    let modifiers = modifiers.into_modifiers();
    if key.starts_with('[') && key.ends_with(']') {
        let key = &key[1..key.len() - 1];
        return Chord::physical(key, modifiers)
            .ok_or(KeybindingParseError::EmptyPhysicalKey { chord });
    }
    Chord::logical(key, modifiers).ok_or(KeybindingParseError::MissingKey { chord })
}

fn format_chord(chord: &Chord, platform: HostPlatform) -> String {
    keycap_labels_for_chord(chord, platform).join("+")
}

fn serialize_chord(chord: &Chord) -> String {
    let modifiers = chord.modifiers();
    let mut parts = Vec::with_capacity(6);
    if modifiers.uses_primary() {
        parts.push("primary".to_owned());
    }
    if modifiers.uses_control() {
        parts.push("ctrl".to_owned());
    }
    if modifiers.uses_meta() {
        parts.push("meta".to_owned());
    }
    if modifiers.uses_alt() {
        parts.push("alt".to_owned());
    }
    if modifiers.uses_shift() {
        parts.push("shift".to_owned());
    }
    parts.push(match chord.key() {
        KeyIdentity::Logical(key) if key.as_str() == " " => "space".to_owned(),
        KeyIdentity::Logical(key) => key.as_str().to_owned(),
        KeyIdentity::Physical(key) => format!("[{}]", key.as_str()),
    });
    parts.join("+")
}

fn keycap_labels_for_chord(chord: &Chord, platform: HostPlatform) -> Vec<String> {
    let modifiers = chord.modifiers();
    let mut parts = Vec::with_capacity(6);
    if modifiers.uses_primary() {
        parts.push(if platform == HostPlatform::MacOs {
            "⌘".to_owned()
        } else {
            "Ctrl".to_owned()
        });
    }
    if modifiers.uses_control() {
        parts.push(if platform == HostPlatform::MacOs {
            "⌃".to_owned()
        } else {
            "Ctrl".to_owned()
        });
    }
    if modifiers.uses_meta() {
        parts.push(if platform == HostPlatform::MacOs {
            "⌘".to_owned()
        } else {
            "Meta".to_owned()
        });
    }
    if modifiers.uses_alt() {
        parts.push(if platform == HostPlatform::MacOs {
            "⌥".to_owned()
        } else {
            "Alt".to_owned()
        });
    }
    if modifiers.uses_shift() {
        parts.push(if platform == HostPlatform::MacOs {
            "⇧".to_owned()
        } else {
            "Shift".to_owned()
        });
    }
    parts.push(match chord.key() {
        KeyIdentity::Logical(key) if key.as_str() == " " => "Space".to_owned(),
        KeyIdentity::Logical(key) => display_key(key.as_str()),
        KeyIdentity::Physical(key) => format!("[{}]", key.as_str()),
    });
    parts
}

fn display_key(key: &str) -> String {
    match key {
        "arrowleft" => "←".to_owned(),
        "arrowright" => "→".to_owned(),
        "arrowup" => "↑".to_owned(),
        "arrowdown" => "↓".to_owned(),
        "enter" => "↵".to_owned(),
        "escape" => "Esc".to_owned(),
        "backspace" => "⌫".to_owned(),
        "tab" => "Tab".to_owned(),
        _ if key.chars().count() == 1 => key.to_uppercase(),
        _ => key.to_owned(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Modifier {
    Primary,
    Control,
    Shift,
    Alt,
    Meta,
}

fn modifier(value: &str) -> Option<Modifier> {
    match value.to_ascii_lowercase().as_str() {
        "primary" | "cmdorctrl" => Some(Modifier::Primary),
        "ctrl" | "control" => Some(Modifier::Control),
        "shift" => Some(Modifier::Shift),
        "alt" | "option" => Some(Modifier::Alt),
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Some(Modifier::Meta),
        _ => None,
    }
}

#[derive(Default)]
struct ModifierFlags {
    primary: bool,
    control: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

impl ModifierFlags {
    fn insert(&mut self, modifier: Modifier, chord: usize) -> Result<(), KeybindingParseError> {
        let (slot, name) = match modifier {
            Modifier::Primary => (&mut self.primary, "primary"),
            Modifier::Control => (&mut self.control, "ctrl"),
            Modifier::Shift => (&mut self.shift, "shift"),
            Modifier::Alt => (&mut self.alt, "alt"),
            Modifier::Meta => (&mut self.meta, "meta"),
        };
        if *slot {
            return Err(KeybindingParseError::DuplicateModifier {
                chord,
                modifier: name.to_owned(),
            });
        }
        *slot = true;
        Ok(())
    }

    fn into_modifiers(self) -> ShortcutModifiers {
        let mut modifiers = ShortcutModifiers::none();
        if self.primary {
            modifiers = modifiers.with_primary();
        }
        if self.control {
            modifiers = modifiers.with_control();
        }
        if self.shift {
            modifiers = modifiers.with_shift();
        }
        if self.alt {
            modifiers = modifiers.with_alt();
        }
        if self.meta {
            modifiers = modifiers.with_meta();
        }
        modifiers
    }
}
