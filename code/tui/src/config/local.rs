//! Local profile persistence shared by TUI preferences, independent of the active App Server.

use super::DictationShortcutSettings;
use ash_config::ConfigCommandError;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigStore;
use ash_config::PreferencesUpdate;
use ash_config::UserConfigCommand;
use ash_protocol::Patch;
use serde_json::Value;
use std::path::Path;

/// Uses the profile beside this TUI process, even when its App Server is remote.
pub(crate) struct LocalTuiSettings {
    store: ConfigStore,
}

impl LocalTuiSettings {
    pub(crate) fn read_punctuation(&self) -> Result<super::PunctuationSettings, String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        let mut settings = super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(snapshot.values.tui),
        )?
        .punctuation;
        settings.revision = snapshot.revision;
        Ok(settings)
    }

    pub(crate) fn write_punctuation(
        &self,
        candidate: super::PunctuationSettings,
    ) -> Result<super::PunctuationSettings, String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        if candidate.revision != snapshot.revision {
            return Err("local configuration changed; reopen Config and try again".into());
        }
        let mut tui = snapshot.values.tui;
        tui.insert("englishPunctuation".into(), Value::Bool(candidate.enabled));
        super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(tui.clone()),
        )?;
        let saved = self
            .store
            .apply(ConfigCommandRequest {
                command_id: crate::client::new_command_id("tui-english-punctuation"),
                expected_revision: snapshot.revision,
                command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                    tui: Patch::Value(tui),
                    ..PreferencesUpdate::default()
                }),
            })
            .map_err(|error| match error {
                ConfigCommandError::Config(error) => error.to_string(),
                ConfigCommandError::CommandConflict => {
                    "local configuration update conflicts with an earlier command".into()
                }
                ConfigCommandError::RevisionConflict { .. } => {
                    "local configuration changed; reopen Config and try again".into()
                }
            })?;
        Ok(super::PunctuationSettings {
            revision: saved.revision,
            ..candidate
        })
    }

    pub(crate) fn read_grouping(&self) -> Result<crate::sessions::SessionGrouping, String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        let settings = super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(snapshot.values.tui),
        )?;
        Ok(settings.session_grouping)
    }

    pub(crate) fn write_grouping(
        &self,
        grouping: crate::sessions::SessionGrouping,
    ) -> Result<(), String> {
        let snapshot = self
            .store
            .read_snapshot()
            .map_err(|error| error.to_string())?;
        let mut tui = snapshot.values.tui;
        tui.insert(
            crate::sessions::GROUPING_KEY.into(),
            serde_json::to_value(grouping).map_err(|error| error.to_string())?,
        );
        super::TuiSettings::from_tui(
            &ash_app_server_protocol::protocol::config::FrontendConfigDto(tui.clone()),
        )?;
        self.store
            .apply(ConfigCommandRequest {
                command_id: crate::client::new_command_id("tui-session-grouping"),
                expected_revision: snapshot.revision,
                command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                    tui: Patch::Value(tui),
                    ..PreferencesUpdate::default()
                }),
            })
            .map_err(|error| match error {
                ConfigCommandError::Config(error) => error.to_string(),
                ConfigCommandError::CommandConflict => {
                    "local configuration update conflicts with an earlier command".into()
                }
                ConfigCommandError::RevisionConflict { .. } => {
                    "local configuration changed; reopen Config and try again".into()
                }
            })?;
        Ok(())
    }

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
        tui.insert(
            "dictationShortcutEnabled".into(),
            Value::Bool(candidate.enabled),
        );
        tui.insert(
            "dictationShortcut".into(),
            Value::String(candidate.shortcut),
        );
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
#[path = "local_tests.rs"]
mod tests;
