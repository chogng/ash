use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::serialize_key_sequence;
use serde_json::Map;
use serde_json::Value;

use crate::catalog::KeybindingCatalog;
use crate::runtime::UserBinding;
use crate::runtime::UserBindingTarget;

/// Shared validation error for malformed user keybinding configuration.
pub type KeybindingsConfigError = ash_keybinding::UserBindingsError;

/// Compiles a complete product-owned keybinding value without mutating an active engine.
pub fn compile_user_bindings<C: KeybindingCatalog>(
    value: Option<&Value>,
    platform: HostPlatform,
) -> Result<Vec<UserBinding<C>>, KeybindingsConfigError> {
    let empty = Value::Array(Vec::new());
    let value = value.unwrap_or(&empty);
    ash_keybinding::compile_user_bindings(value, platform, C::command_from_id, C::parse_condition)
        .map(|rules| {
            rules
                .into_iter()
                .map(|rule| UserBinding {
                    keybinding: rule.keybinding,
                    target: match rule.target {
                        ash_keybinding::UserBindingTarget::Command(command) => {
                            UserBindingTarget::Command(command)
                        }
                        ash_keybinding::UserBindingTarget::Block => UserBindingTarget::Block,
                    },
                    when: rule.when,
                    when_source: rule.when_source,
                })
                .collect()
        })
}

/// Replaces one command's rules while preserving every unrelated configuration entry.
pub fn edited_user_bindings<C: KeybindingCatalog>(
    value: Option<&Value>,
    command: C::Command,
    keybinding: &KeySequence,
    platform: HostPlatform,
) -> Result<Value, String> {
    compile_user_bindings::<C>(value, platform)
        .map_err(|error| format!("cannot edit invalid keybindings: {error}"))?;

    let mut value = value.cloned().unwrap_or_else(|| Value::Array(Vec::new()));
    let bindings = value
        .as_array_mut()
        .ok_or_else(|| "cannot edit keybindings because the root is not an array".to_owned())?;
    bindings.retain(|entry| {
        entry
            .as_object()
            .and_then(|entry| entry.get("command"))
            .and_then(Value::as_str)
            != Some(C::command_id(command))
    });
    bindings.push(Value::Object(Map::from_iter([
        (
            "key".to_owned(),
            Value::String(serialize_key_sequence(keybinding)),
        ),
        (
            "command".to_owned(),
            Value::String(C::command_id(command).to_owned()),
        ),
    ])));
    compile_user_bindings::<C>(Some(&value), platform)
        .map_err(|error| format!("cannot save invalid keybindings: {error}"))?;
    Ok(value)
}

/// Produces non-fatal diagnostics for exact duplicate rules.
pub fn binding_diagnostics<C: KeybindingCatalog>(
    rules: &[UserBinding<C>],
    platform: HostPlatform,
) -> Vec<String> {
    let shared_rules = rules
        .iter()
        .map(|rule| ash_keybinding::UserBinding {
            keybinding: rule.keybinding.clone(),
            target: match rule.target {
                UserBindingTarget::Command(command) => {
                    ash_keybinding::UserBindingTarget::Command(command)
                }
                UserBindingTarget::Block => ash_keybinding::UserBindingTarget::Block,
            },
            when: rule.when.clone(),
            when_source: rule.when_source.clone(),
        })
        .collect::<Vec<_>>();
    ash_keybinding::user_binding_diagnostics(&shared_rules, platform)
}
