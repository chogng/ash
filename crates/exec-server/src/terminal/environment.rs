use std::collections::HashMap;

const CONTROLLED_TERMINAL_ENVIRONMENT: [(&str, &str); 3] = [
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "ash"),
];

/// Frozen, secret-excluding process environment inherited by interactive terminals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalEnvironment {
    variables: HashMap<String, String>,
}

impl TerminalEnvironment {
    pub(crate) fn from_process() -> Self {
        Self::from_variables(std::env::vars())
    }

    fn from_variables(variables: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut environment = HashMap::new();
        for (key, value) in variables {
            let Some(key) = normalized_allowed_environment_key(&key) else {
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

pub fn safe_process_environment() -> HashMap<String, String> {
    TerminalEnvironment::from_process().variables
}

fn normalized_allowed_environment_key(key: &str) -> Option<String> {
    if !is_valid_environment_name(key) {
        return None;
    }
    #[cfg(windows)]
    {
        let normalized = key.to_ascii_uppercase();
        allowed_environment_key(&normalized).then_some(normalized)
    }
    #[cfg(not(windows))]
    {
        allowed_environment_key(key).then(|| key.to_owned())
    }
}

fn allowed_environment_key(key: &str) -> bool {
    matches!(
        key,
        "ALLUSERSPROFILE"
            | "APPDATA"
            | "COMMONPROGRAMFILES"
            | "COMMONPROGRAMFILES(X86)"
            | "COMSPEC"
            | "HOME"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "LANG"
            | "LOCALAPPDATA"
            | "LOGNAME"
            | "NUMBER_OF_PROCESSORS"
            | "OS"
            | "PATH"
            | "PATHEXT"
            | "PROCESSOR_ARCHITECTURE"
            | "PROCESSOR_IDENTIFIER"
            | "PROCESSOR_LEVEL"
            | "PROCESSOR_REVISION"
            | "PROGRAMDATA"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "PROGRAMW6432"
            | "PSMODULEPATH"
            | "PUBLIC"
            | "SHELL"
            | "SYSTEMDRIVE"
            | "SYSTEMROOT"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "USER"
            | "USERDOMAIN"
            | "USERNAME"
            | "USERPROFILE"
            | "WINDIR"
            | "XDG_CACHE_HOME"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "XDG_RUNTIME_DIR"
            | "XDG_STATE_HOME"
    ) || key.starts_with("LC_")
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
