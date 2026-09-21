use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_keybinding::HostPlatform;
use ash_keybinding::user_binding_diagnostics;
use ash_protocol::Patch;
use serde_json::Value;

use crate::client::new_command_id;
use crate::keymap::AppKeymap;
use crate::keymap::compile_app_user_bindings;

use super::KeymapChoices;
use super::keymap_choices;

const CONFIG_KEY: &str = "keybindings";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeymapCaptureMode {
    SingleKey,
    Chord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeymapEditIntent {
    ReplaceUser,
    AddAlternate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum KeymapEditKind {
    Set {
        key: String,
        intent: KeymapEditIntent,
    },
    ClearUser,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeymapEdit {
    pub(crate) expected_revision: u64,
    pub(crate) command_id: String,
    pub(crate) kind: KeymapEditKind,
}

pub(crate) struct KeymapSettings {
    pub(crate) keymap: AppKeymap,
    pub(crate) diagnostics: Vec<String>,
}

pub(crate) struct KeymapEditorUpdate {
    pub(crate) settings: KeymapSettings,
    pub(crate) choices: KeymapChoices,
    pub(crate) notice: Option<String>,
}

pub(crate) fn settings_from_tui(section: &FrontendConfigDto) -> Result<KeymapSettings, String> {
    let document = section
        .0
        .get(CONFIG_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if !document.is_array() {
        return Err("invalid [tui].keybindings: expected an array of shortcut rules".into());
    }
    compile_settings(&document)
}

pub(crate) fn read_keymap<T>(client: &mut AppServerClient<T>) -> Result<KeymapEditorUpdate, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    let settings = settings_from_tui(&config.tui)?;
    let choices = keymap_choices(
        settings.keymap.setup_actions(),
        &settings.diagnostics,
        config.revision,
    );
    Ok(KeymapEditorUpdate {
        settings,
        choices,
        notice: None,
    })
}

pub(crate) fn set_keymap<T>(
    client: &mut AppServerClient<T>,
    edit: KeymapEdit,
) -> Result<KeymapEditorUpdate, String>
where
    T: JsonRpcTransport,
{
    let config = client.read_config().map_err(|error| error.to_string())?;
    if config.revision != edit.expected_revision {
        return Err(
            "configuration changed after the shortcut editor opened; reopen /shortcuts and try again"
                .into(),
        );
    }

    let current = config
        .tui
        .0
        .get(CONFIG_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let (document, notice) = edited_document(current, &edit)?;
    compile_settings(&document)?;

    let mut tui = config.tui.0;
    tui.insert(CONFIG_KEY.into(), document);
    client
        .update_config(ConfigUpdateParams {
            advisor: Default::default(),
            time_context: Default::default(),
            features: Default::default(),
            command_id: new_command_id("keybindings"),
            expected_revision: config.revision,
            model: Patch::Missing,
            model_reasoning_effort: Patch::Missing,
            approval_review_model: Patch::Missing,
            commit_message_model: Patch::Missing,
            tool_mode: Patch::Missing,
            grep_backend: Patch::Missing,
            gui: Patch::Missing,
            tui: Patch::Value(FrontendConfigDto(tui)),
        })
        .map_err(|error| error.to_string())?;

    let config = client.read_config().map_err(|error| error.to_string())?;
    let settings = settings_from_tui(&config.tui)?;
    let choices = keymap_choices(
        settings.keymap.setup_actions(),
        &settings.diagnostics,
        config.revision,
    );
    Ok(KeymapEditorUpdate {
        settings,
        choices,
        notice: Some(notice),
    })
}

fn compile_settings(document: &Value) -> Result<KeymapSettings, String> {
    let platform = HostPlatform::current();
    let rules = compile_app_user_bindings(document, platform)
        .map_err(|error| format!("invalid [tui].keybindings: {error}"))?;
    let diagnostics = user_binding_diagnostics(&rules, platform);
    let mut keymap = AppKeymap::default();
    keymap
        .replace_user_bindings(rules)
        .map_err(|error| format!("invalid [tui].keybindings: {error}"))?;
    Ok(KeymapSettings {
        keymap,
        diagnostics,
    })
}

fn edited_document(mut document: Value, edit: &KeymapEdit) -> Result<(Value, String), String> {
    let entries = document.as_array_mut().ok_or_else(|| {
        "invalid [tui].keybindings: expected an array of shortcut rules".to_owned()
    })?;
    let command_matches = |entry: &Value| {
        entry.get("command").and_then(Value::as_str) == Some(edit.command_id.as_str())
    };

    let notice = match &edit.kind {
        KeymapEditKind::Set { key, intent } => {
            if matches!(intent, KeymapEditIntent::ReplaceUser) {
                entries.retain(|entry| !command_matches(entry));
            } else if entries.iter().any(|entry| {
                command_matches(entry)
                    && entry.get("key").and_then(Value::as_str) == Some(key.as_str())
                    && entry.get("when").is_none()
            }) {
                return Ok((
                    document,
                    format!("No change: `{}` already uses `{key}`.", edit.command_id),
                ));
            }
            entries.push(serde_json::json!({
                "key": key,
                "command": edit.command_id,
            }));
            match intent {
                KeymapEditIntent::ReplaceUser => format!("Set user shortcut to `{key}`."),
                KeymapEditIntent::AddAlternate => format!("Added user shortcut `{key}`."),
            }
        }
        KeymapEditKind::ClearUser => {
            let before = entries.len();
            entries.retain(|entry| !command_matches(entry));
            if entries.len() == before {
                return Ok((
                    document,
                    "No change: this action has no user shortcuts.".into(),
                ));
            }
            "Cleared user shortcuts.".into()
        }
    };
    Ok((document, notice))
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
