use std::fs;
use std::path::{Path, PathBuf};

use ash_install_context::{HostExecutableName, InstallContext};
use ash_lsp::LanguageServerCommand;

use crate::{
    BASH_LANGUAGE_SERVER_ID, JSON_LANGUAGE_SERVER_ID, LanguageServerDefinition,
    LspServerResolverError, RUST_ANALYZER_SERVER_ID, TYPESCRIPT_LANGUAGE_SERVER_ID,
};

/// Supplies frozen executable candidates without granting authority to start them.
///
/// Implementations should preserve source precedence and must not perform process execution.
/// The resolver validates and canonicalizes every returned candidate before producing a launch
/// definition.
pub trait LanguageServerExecutableCandidates {
    fn candidates(&self, executable_name: &str) -> Result<Vec<PathBuf>, LspServerResolverError>;
}

impl LanguageServerExecutableCandidates for InstallContext {
    fn candidates(&self, executable_name: &str) -> Result<Vec<PathBuf>, LspServerResolverError> {
        let name = HostExecutableName::new(executable_name)?;
        Ok(self.host_path_candidates(&name))
    }
}

/// User intent for one built-in language server.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LanguageServerMode {
    Disabled,
    #[default]
    Enabled,
}

/// Product policy governing whether resolution may produce executable definitions.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LanguageServerExecutionPolicy {
    #[default]
    Disallowed,
    Allowed,
}

/// Desired mode and executable source for one language server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LanguageServerPreference {
    mode: LanguageServerMode,
    explicit_executable: Option<PathBuf>,
}

impl LanguageServerPreference {
    pub fn disabled() -> Self {
        Self {
            mode: LanguageServerMode::Disabled,
            explicit_executable: None,
        }
    }

    pub fn enabled() -> Self {
        Self {
            mode: LanguageServerMode::Enabled,
            explicit_executable: None,
        }
    }

    pub fn with_explicit_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.explicit_executable = Some(path.into());
        self
    }

    pub const fn mode(&self) -> LanguageServerMode {
        self.mode
    }
}

impl Default for LanguageServerPreference {
    fn default() -> Self {
        Self::enabled()
    }
}

/// Resolution state of one built-in server for the current directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspServerAvailability {
    Disabled,
    ExecutionDisallowed,
    ExecutableUnavailable,
    Resolved { executable: PathBuf },
}

/// Product-visible resolution entry without any live runtime state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspServerResolutionEntry {
    name: &'static str,
    mode: LanguageServerMode,
    state: LspServerAvailability,
}

impl LspServerResolutionEntry {
    pub const fn name(&self) -> &'static str {
        self.name
    }

    pub const fn mode(&self) -> LanguageServerMode {
        self.mode
    }

    pub fn state(&self) -> &LspServerAvailability {
        &self.state
    }
}

/// Frozen resolved definitions and availability facts for one directory.
#[derive(Clone, Debug)]
pub struct LspServerResolution {
    definitions: Vec<LanguageServerDefinition>,
    entries: Vec<LspServerResolutionEntry>,
}

impl LspServerResolution {
    pub fn definitions(&self) -> &[LanguageServerDefinition] {
        &self.definitions
    }

    pub fn entries(&self) -> &[LspServerResolutionEntry] {
        &self.entries
    }

    pub fn into_definitions(self) -> Vec<LanguageServerDefinition> {
        self.definitions
    }
}

/// Built-in language-server resolver and its user-selected preferences.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LspServerResolver {
    rust_analyzer: LanguageServerPreference,
    json_language_server: LanguageServerPreference,
    bash_language_server: LanguageServerPreference,
    typescript_language_server: LanguageServerPreference,
}

impl LspServerResolver {
    /// Creates a resolver that cannot resolve a server until persisted configuration enables one.
    pub fn disabled() -> Self {
        Self {
            rust_analyzer: LanguageServerPreference::disabled(),
            json_language_server: LanguageServerPreference::disabled(),
            bash_language_server: LanguageServerPreference::disabled(),
            typescript_language_server: LanguageServerPreference::disabled(),
        }
    }

    pub fn new(rust_analyzer: LanguageServerPreference) -> Self {
        Self {
            rust_analyzer,
            ..Self::default()
        }
    }

    pub fn with_json_language_server(mut self, preference: LanguageServerPreference) -> Self {
        self.json_language_server = preference;
        self
    }

    pub fn with_bash_language_server(mut self, preference: LanguageServerPreference) -> Self {
        self.bash_language_server = preference;
        self
    }

    pub fn with_typescript_language_server(mut self, preference: LanguageServerPreference) -> Self {
        self.typescript_language_server = preference;
        self
    }

    pub fn resolve(
        &self,
        executable_candidates: &dyn LanguageServerExecutableCandidates,
        execution_policy: LanguageServerExecutionPolicy,
        dir_root: &Path,
    ) -> Result<LspServerResolution, LspServerResolverError> {
        let mut definitions = Vec::new();
        let rust_state = self.resolve_builtin(
            BuiltinServer::rust_analyzer(),
            &self.rust_analyzer,
            executable_candidates,
            execution_policy,
            dir_root,
            &mut definitions,
        )?;
        let json_state = self.resolve_builtin(
            BuiltinServer::json(),
            &self.json_language_server,
            executable_candidates,
            execution_policy,
            dir_root,
            &mut definitions,
        )?;
        let bash_state = self.resolve_builtin(
            BuiltinServer::bash(),
            &self.bash_language_server,
            executable_candidates,
            execution_policy,
            dir_root,
            &mut definitions,
        )?;
        let typescript_state = self.resolve_builtin(
            BuiltinServer::typescript(),
            &self.typescript_language_server,
            executable_candidates,
            execution_policy,
            dir_root,
            &mut definitions,
        )?;
        Ok(LspServerResolution {
            definitions,
            entries: vec![
                LspServerResolutionEntry {
                    name: RUST_ANALYZER_SERVER_ID,
                    mode: self.rust_analyzer.mode,
                    state: rust_state,
                },
                LspServerResolutionEntry {
                    name: TYPESCRIPT_LANGUAGE_SERVER_ID,
                    mode: self.typescript_language_server.mode,
                    state: typescript_state,
                },
                LspServerResolutionEntry {
                    name: JSON_LANGUAGE_SERVER_ID,
                    mode: self.json_language_server.mode,
                    state: json_state,
                },
                LspServerResolutionEntry {
                    name: BASH_LANGUAGE_SERVER_ID,
                    mode: self.bash_language_server.mode,
                    state: bash_state,
                },
            ],
        })
    }

    fn resolve_builtin(
        &self,
        builtin: BuiltinServer,
        preference: &LanguageServerPreference,
        executable_candidates: &dyn LanguageServerExecutableCandidates,
        execution_policy: LanguageServerExecutionPolicy,
        dir_root: &Path,
        definitions: &mut Vec<LanguageServerDefinition>,
    ) -> Result<LspServerAvailability, LspServerResolverError> {
        if preference.mode == LanguageServerMode::Disabled {
            return Ok(LspServerAvailability::Disabled);
        }
        if execution_policy == LanguageServerExecutionPolicy::Disallowed {
            return Ok(LspServerAvailability::ExecutionDisallowed);
        }
        let executable = if let Some(explicit) = &preference.explicit_executable {
            valid_executable(explicit)
        } else {
            executable_candidates
                .candidates(builtin.executable)?
                .into_iter()
                .find_map(|candidate| valid_executable(&candidate))
        };
        let Some(executable) = executable else {
            return Ok(LspServerAvailability::ExecutableUnavailable);
        };
        let command = LanguageServerCommand::new(executable.canonical.clone())
            .with_arguments(builtin.arguments)
            .with_current_dir(dir_root.to_path_buf());
        #[cfg(unix)]
        let command = command.with_argv0(executable.argv0);
        definitions.push(LanguageServerDefinition::new(
            builtin.identity,
            builtin.language_ids.iter().copied(),
            command,
        )?);
        Ok(LspServerAvailability::Resolved {
            executable: executable.canonical,
        })
    }
}

#[derive(Clone, Copy)]
struct BuiltinServer {
    identity: &'static str,
    executable: &'static str,
    language_ids: &'static [&'static str],
    arguments: &'static [&'static str],
}

impl BuiltinServer {
    const fn rust_analyzer() -> Self {
        Self {
            identity: RUST_ANALYZER_SERVER_ID,
            executable: RUST_ANALYZER_SERVER_ID,
            language_ids: &["rust"],
            arguments: &[],
        }
    }

    const fn json() -> Self {
        Self {
            identity: JSON_LANGUAGE_SERVER_ID,
            executable: JSON_LANGUAGE_SERVER_ID,
            language_ids: &["json", "jsonc"],
            arguments: &["--stdio"],
        }
    }

    const fn bash() -> Self {
        Self {
            identity: BASH_LANGUAGE_SERVER_ID,
            executable: BASH_LANGUAGE_SERVER_ID,
            language_ids: &["shellscript"],
            arguments: &["start"],
        }
    }

    const fn typescript() -> Self {
        Self {
            identity: TYPESCRIPT_LANGUAGE_SERVER_ID,
            executable: TYPESCRIPT_LANGUAGE_SERVER_ID,
            language_ids: &[
                "javascript",
                "javascriptreact",
                "typescript",
                "typescriptreact",
            ],
            arguments: &["--stdio"],
        }
    }
}

struct ValidatedExecutable {
    canonical: PathBuf,
    #[cfg(unix)]
    argv0: PathBuf,
}

fn valid_executable(path: &Path) -> Option<ValidatedExecutable> {
    let canonical = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() || !has_executable_permission(&metadata) {
        return None;
    }
    #[cfg(unix)]
    let argv0 = std::path::absolute(path).ok()?;
    Some(ValidatedExecutable {
        canonical,
        #[cfg(unix)]
        argv0,
    })
}

#[cfg(unix)]
fn has_executable_permission(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_permission(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(test)]
#[path = "resolver_tests.rs"]
mod tests;
