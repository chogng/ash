use crate::keymap::KeyEvent;
use ash_config::ConfigRevision;
use ash_keybinding::parse_key_sequence;
use ash_keybinding::serialize_key_sequence;
use crossterm::event::KeyEventKind;
use serde_json::Value;
use std::collections::BTreeMap;

const ENABLED_KEY: &str = "dictationShortcutEnabled";
const SHORTCUT_KEY: &str = "dictationShortcut";
const DEFAULT_SHORTCUT: &str = "ctrl+g";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DictationShortcutSettings {
    pub(crate) enabled: bool,
    pub(crate) shortcut: String,
    pub(crate) revision: ConfigRevision,
}

impl Default for DictationShortcutSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            shortcut: DEFAULT_SHORTCUT.into(),
            revision: ConfigRevision::INITIAL,
        }
    }
}

impl DictationShortcutSettings {
    pub(super) fn from_tui(values: &BTreeMap<String, Value>) -> Result<Self, String> {
        let enabled = match values.get(ENABLED_KEY) {
            Some(Value::Bool(enabled)) => *enabled,
            Some(_) => {
                return Err("invalid [tui].dictationShortcutEnabled: expected boolean".into());
            }
            None => false,
        };
        let shortcut = match values.get(SHORTCUT_KEY) {
            Some(Value::String(shortcut)) => shortcut.as_str(),
            Some(_) => return Err("invalid [tui].dictationShortcut: expected a key".into()),
            None => DEFAULT_SHORTCUT,
        };
        Ok(Self {
            enabled,
            shortcut: normalize_shortcut(shortcut)?,
            revision: ConfigRevision::INITIAL,
        })
    }

    pub(crate) fn with_shortcut(mut self, shortcut: &str) -> Result<Self, String> {
        self.shortcut = normalize_shortcut(shortcut)?;
        Ok(self)
    }

    pub(crate) fn matches(&self, key: &KeyEvent) -> bool {
        key.kind == KeyEventKind::Press
            && crate::keymap::key_event_to_config_key(key)
                .is_ok_and(|shortcut| shortcut == self.shortcut)
    }
}

fn normalize_shortcut(shortcut: &str) -> Result<String, String> {
    let sequence = parse_key_sequence(shortcut).map_err(|error| error.to_string())?;
    if sequence.chords().len() != 1 {
        return Err("dictation shortcut must be one key combination".into());
    }
    let shortcut = serialize_key_sequence(&sequence);
    if !shortcut.contains('+') {
        return Err("dictation shortcut must include a modifier".into());
    }
    Ok(shortcut)
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
