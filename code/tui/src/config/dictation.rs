use ash_config::ConfigCommandError;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ConfigStore;
use ash_config::PreferencesUpdate;
use ash_config::UserConfigCommand;
use ash_keybinding::parse_key_sequence;
use ash_keybinding::serialize_key_sequence;
use ash_protocol::Patch;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

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

/// Uses the profile beside this TUI process, even when its App Server is remote.
pub(crate) struct LocalDictationSettings {
    store: ConfigStore,
}

impl LocalDictationSettings {
    pub(crate) fn open(profile_root: &Path, database_path: &Path) -> Result<Self, String> {
        let store = ConfigStore::open_with_paths(database_path, profile_root.join("config.toml"))
            .map_err(|error| error.to_string())?;
        Ok(Self { store })
    }

    pub(crate) fn read(&self) -> Result<DictationShortcutSettings, String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        let mut settings = super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(snapshot.values.tui),
        )?
        .dictation;
        settings.revision = snapshot.revision;
        Ok(settings)
    }

    pub(crate) fn subscribe_changes(&self) -> std::sync::mpsc::Receiver<ash_config::ConfigChange> {
        self.store.subscribe_changes()
    }

    pub(crate) fn write(
        &self,
        candidate: DictationShortcutSettings,
    ) -> Result<DictationShortcutSettings, String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        if candidate.revision != snapshot.revision {
            return Err("local configuration changed; reopen Config and try again".into());
        }
        let mut tui = snapshot.values.tui;
        tui.insert(ENABLED_KEY.into(), Value::Bool(candidate.enabled));
        tui.insert(SHORTCUT_KEY.into(), Value::String(candidate.shortcut));
        super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(tui.clone()),
        )?;
        self.store
            .apply(ConfigCommandRequest {
                command_id: crate::client::new_command_id("tui-dictation-shortcut"),
                expected_revision: snapshot.revision,
                command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                    tui: Patch::Value(tui),
                    ..PreferencesUpdate::default()
                }),
            })
            .map_err(|error| match error {
                ConfigCommandError::Config(error) => error.to_string(),
                ConfigCommandError::CommandConflict => {
                    "dictation shortcut update conflicts with an earlier command".into()
                }
                ConfigCommandError::RevisionConflict { .. } => {
                    "local configuration changed; reopen Config and try again".into()
                }
            })?;
        self.read()
    }
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
