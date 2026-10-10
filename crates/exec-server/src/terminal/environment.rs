use std::collections::HashMap;
use std::ffi::OsString;

const CONTROLLED_TERMINAL_ENVIRONMENT: [(&str, &str); 3] = [
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "ash"),
];

/// Frozen developer environment inherited by interactive terminals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalEnvironment {
    variables: HashMap<String, String>,
}

impl TerminalEnvironment {
    pub(crate) fn from_process() -> Self {
        Self::from_variables(std::env::vars_os())
    }

    fn from_variables(variables: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        let mut environment = HashMap::new();
        for (key, value) in variables {
            // Filter before converting values: unrelated or unrepresentable process
            // variables cannot panic or become different child variables through lossy conversion.
            let Some(key) = key.to_str().and_then(normalized_environment_key) else {
                continue;
            };
            let Ok(value) = value.into_string() else {
                continue;
            };
            if is_valid_environment_value(&value) {
                environment.insert(key, value);
            }
        }
        for (key, value) in CONTROLLED_TERMINAL_ENVIRONMENT {
            environment.insert(key.into(), value.into());
        }
        Self {
            variables: environment,
        }
    }

    pub(crate) fn variables(&self) -> &HashMap<String, String> {
        &self.variables
    }
}

/// Returns Unicode developer process variables and controlled terminal identity.
/// Host authentication and Electron launcher controls are not inherited.
/// Variables with non-Unicode names or values are ignored.
pub fn safe_process_environment() -> HashMap<String, String> {
    TerminalEnvironment::from_process().variables
}

fn normalized_environment_key(key: &str) -> Option<String> {
    if !is_valid_environment_name(key) {
        return None;
    }
    #[cfg(windows)]
    {
        let normalized = key.to_ascii_uppercase();
        inherited_environment_key(&normalized).then_some(normalized)
    }
    #[cfg(not(windows))]
    {
        inherited_environment_key(key).then(|| key.to_owned())
    }
}

// These names carry host control-plane authority, rather than developer credentials.
// Keep the boundary independent of KEY/SECRET/TOKEN naming so ordinary SDKs work.
const PRIVATE_PROCESS_ENVIRONMENT_KEYS: [&str; 6] = [
    "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
    "NODE_REPL_AUTH_TOKEN",
    "CODEX_GUARDIAN_DECISIONS_API_KEY",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
];

/// Identifies launcher authentication that must also be excluded from explicit child overrides.
pub fn is_private_process_environment_key(key: &str) -> bool {
    PRIVATE_PROCESS_ENVIRONMENT_KEYS
        .iter()
        .any(|name| key.eq_ignore_ascii_case(name))
}

fn inherited_environment_key(key: &str) -> bool {
    !is_private_process_environment_key(key) && !key.starts_with("ELECTRON_")
}

fn is_valid_environment_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['=', '\0'])
}

fn is_valid_environment_value(value: &str) -> bool {
    !value.contains('\0')
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
