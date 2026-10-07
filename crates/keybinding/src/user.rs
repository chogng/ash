//! Product-neutral compilation of user-authored keybinding configuration.

use std::fmt;

use serde_json::Map;
use serde_json::Value;

use crate::HostPlatform;
use crate::KeySequence;
use crate::format_key_sequence;
use crate::parse_key_sequence;

/// Maximum number of entries accepted from one user keybinding value.
pub const MAX_USER_BINDINGS: usize = 1_024;

/// A validated user-provided command or blocker rule.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserBinding<Command, Condition> {
    pub keybinding: KeySequence,
    pub target: UserBindingTarget<Command>,
    pub when: Condition,
    pub when_source: Option<String>,
}

/// The action contributed by one user keybinding rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserBindingTarget<Command> {
    Command(Command),
    Block,
}

/// A malformed or unsupported entry in user keybinding configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UserBindingsError {
    ExpectedArray,
    TooManyBindings { maximum: usize, actual: usize },
    ExpectedObject { index: usize },
    UnknownField { index: usize, field: String },
    MissingField { index: usize, field: &'static str },
    InvalidField { index: usize, field: &'static str },
    InvalidTarget { index: usize },
    InvalidKey { index: usize, message: String },
    UnknownCommand { index: usize, command: String },
    UnknownCondition { index: usize, condition: String },
}

impl fmt::Display for UserBindingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExpectedArray => formatter.write_str("the root value must be an array"),
            Self::TooManyBindings { maximum, actual } => {
                write!(
                    formatter,
                    "at most {maximum} bindings are allowed, got {actual}"
                )
            }
            Self::ExpectedObject { index } => {
                write!(formatter, "binding {index} must be an object")
            }
            Self::UnknownField { index, field } => {
                write!(
                    formatter,
                    "binding {index} contains unknown field `{field}`"
                )
            }
            Self::MissingField { index, field } => {
                write!(formatter, "binding {index} is missing `{field}`")
            }
            Self::InvalidField { index, field } => {
                write!(formatter, "binding {index} has an invalid `{field}`")
            }
            Self::InvalidTarget { index } => write!(
                formatter,
                "binding {index} must contain either a string `command` or `block = true`"
            ),
            Self::InvalidKey { index, message } => {
                write!(formatter, "binding {index} has an invalid key: {message}")
            }
            Self::UnknownCommand { index, command } => {
                write!(
                    formatter,
                    "binding {index} uses unknown command `{command}`"
                )
            }
            Self::UnknownCondition { index, condition } => {
                write!(
                    formatter,
                    "binding {index} uses unknown condition: {condition}"
                )
            }
        }
    }
}

impl std::error::Error for UserBindingsError {}

/// Compiles a complete configuration value without performing I/O or mutating an active resolver.
pub fn compile_user_bindings<Command, Condition>(
    value: &Value,
    platform: HostPlatform,
    mut command_from_id: impl FnMut(&str) -> Option<Command>,
    mut parse_condition: impl FnMut(Option<&str>) -> Result<Condition, String>,
) -> Result<Vec<UserBinding<Command, Condition>>, UserBindingsError> {
    let values = value.as_array().ok_or(UserBindingsError::ExpectedArray)?;
    if values.len() > MAX_USER_BINDINGS {
        return Err(UserBindingsError::TooManyBindings {
            maximum: MAX_USER_BINDINGS,
            actual: values.len(),
        });
    }
    values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            match compile_user_binding(
                value,
                index + 1,
                platform,
                &mut command_from_id,
                &mut parse_condition,
            ) {
                Ok(Some(rule)) => Some(Ok(rule)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}

/// Produces non-fatal diagnostics for exact duplicate user rules.
pub fn user_binding_diagnostics<Command, Condition: Eq>(
    rules: &[UserBinding<Command, Condition>],
    platform: HostPlatform,
) -> Vec<String> {
    let mut diagnostics = Vec::new();
    for (later_index, later) in rules.iter().enumerate() {
        for (earlier_index, earlier) in rules[..later_index].iter().enumerate() {
            if earlier.keybinding == later.keybinding && earlier.when == later.when {
                let key = format_key_sequence(&later.keybinding, platform);
                let condition = later.when_source.as_deref().unwrap_or("always");
                diagnostics.push(format!(
                    "Rule {} conflicts with rule {} for {key} when {condition}; the later rule wins",
                    later_index + 1,
                    earlier_index + 1
                ));
            }
        }
    }
    diagnostics
}

fn compile_user_binding<Command, Condition>(
    value: &Value,
    index: usize,
    platform: HostPlatform,
    command_from_id: &mut impl FnMut(&str) -> Option<Command>,
    parse_condition: &mut impl FnMut(Option<&str>) -> Result<Condition, String>,
) -> Result<Option<UserBinding<Command, Condition>>, UserBindingsError> {
    let object = value
        .as_object()
        .ok_or(UserBindingsError::ExpectedObject { index })?;
    reject_unknown_fields(object, index)?;
    validate_platform_overrides(object, index)?;
    let key = selected_key(object, index, platform)?;
    let Some(key) = key else {
        return Ok(None);
    };
    let keybinding = parse_key_sequence(key).map_err(|error| UserBindingsError::InvalidKey {
        index,
        message: error.to_string(),
    })?;
    let target = match (object.get("command"), object.get("block")) {
        (Some(command), None) => {
            let command = command.as_str().ok_or(UserBindingsError::InvalidField {
                index,
                field: "command",
            })?;
            command_from_id(command)
                .map(UserBindingTarget::Command)
                .ok_or_else(|| UserBindingsError::UnknownCommand {
                    index,
                    command: command.to_owned(),
                })?
        }
        (None, Some(Value::Bool(true))) => UserBindingTarget::Block,
        _ => return Err(UserBindingsError::InvalidTarget { index }),
    };
    if object.get("when").is_some_and(|value| !value.is_string()) {
        return Err(UserBindingsError::InvalidField {
            index,
            field: "when",
        });
    }
    let when_source = object
        .get("when")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let when = parse_condition(when_source.as_deref()).map_err(|error| {
        UserBindingsError::UnknownCondition {
            index,
            condition: error,
        }
    })?;
    Ok(Some(UserBinding {
        keybinding,
        target,
        when,
        when_source,
    }))
}

fn selected_key(
    object: &Map<String, Value>,
    index: usize,
    platform: HostPlatform,
) -> Result<Option<&str>, UserBindingsError> {
    let key = object
        .get("key")
        .ok_or(UserBindingsError::MissingField {
            index,
            field: "key",
        })?
        .as_str()
        .ok_or(UserBindingsError::InvalidField {
            index,
            field: "key",
        })?;
    let field = match platform {
        HostPlatform::MacOs => "mac",
        HostPlatform::Windows => "win",
        HostPlatform::Linux => "linux",
        HostPlatform::Other => return Ok(Some(key)),
    };
    let Some(value) = object.get(field) else {
        return Ok(Some(key));
    };
    if value == &Value::Bool(false) {
        return Ok(None);
    }
    value
        .as_str()
        .map(Some)
        .ok_or(UserBindingsError::InvalidField { index, field })
}

fn reject_unknown_fields(
    object: &Map<String, Value>,
    index: usize,
) -> Result<(), UserBindingsError> {
    for field in object.keys() {
        if !matches!(
            field.as_str(),
            "key" | "command" | "block" | "when" | "mac" | "linux" | "win"
        ) {
            return Err(UserBindingsError::UnknownField {
                index,
                field: field.clone(),
            });
        }
    }
    Ok(())
}

fn validate_platform_overrides(
    object: &Map<String, Value>,
    index: usize,
) -> Result<(), UserBindingsError> {
    for field in ["mac", "linux", "win"] {
        if let Some(value) = object.get(field)
            && value != &Value::Bool(false)
            && !value.is_string()
        {
            return Err(UserBindingsError::InvalidField { index, field });
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "user_tests.rs"]
mod tests;
