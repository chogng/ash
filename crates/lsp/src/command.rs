use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// Whether a language-server process inherits the App Server environment.
///
/// Hosts launching package-provided runtimes should normally select [`Self::Clear`] and add back
/// only the variables required by that runtime. Direct user-configured executables retain the
/// historical inherited environment unless their resolver selects a stricter policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LanguageServerEnvironmentPolicy {
    #[default]
    Inherit,
    Clear,
}

/// A local language-server process command supplied by the product host.
///
/// Server discovery, executable verification, installation, sandboxing, and environment policy belong to
/// the caller. This value only preserves the resolved process launch contract.
#[derive(Clone, Debug)]
pub struct LanguageServerCommand {
    program: OsString,
    #[cfg(unix)]
    argv0: Option<OsString>,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    environment_policy: LanguageServerEnvironmentPolicy,
    current_dir: Option<PathBuf>,
}

impl LanguageServerCommand {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            #[cfg(unix)]
            argv0: None,
            arguments: Vec::new(),
            environment: BTreeMap::new(),
            environment_policy: LanguageServerEnvironmentPolicy::Inherit,
            current_dir: None,
        }
    }

    pub fn with_argument(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    pub fn with_arguments<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.arguments.extend(arguments.into_iter().map(Into::into));
        self
    }

    pub fn with_environment(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Self {
        self.environment.insert(name.into(), value.into());
        self
    }

    /// Prevents the child from inheriting ambient variables from the App Server process.
    pub fn with_clean_environment(mut self) -> Self {
        self.environment_policy = LanguageServerEnvironmentPolicy::Clear;
        self
    }

    pub fn with_current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    /// Preserves the executable invocation name independently from its resolved program path.
    ///
    /// Unix proxy executables such as rustup dispatch from `argv[0]`, while the program path can
    /// remain canonical and immutable after catalog validation.
    #[cfg(unix)]
    pub fn with_argv0(mut self, argv0: impl Into<OsString>) -> Self {
        self.argv0 = Some(argv0.into());
        self
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.environment
    }

    pub const fn environment_policy(&self) -> LanguageServerEnvironmentPolicy {
        self.environment_policy
    }

    pub fn current_dir(&self) -> Option<&Path> {
        self.current_dir.as_deref()
    }

    #[cfg(unix)]
    pub fn argv0(&self) -> Option<&OsStr> {
        self.argv0.as_deref()
    }

    pub(crate) fn into_tokio_command(self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(self.program);
        #[cfg(unix)]
        if let Some(argv0) = self.argv0 {
            command.arg0(argv0);
        }
        if self.environment_policy == LanguageServerEnvironmentPolicy::Clear {
            command.env_clear();
        }
        command
            .args(self.arguments)
            .envs(self.environment)
            .kill_on_drop(true);
        if let Some(current_dir) = self.current_dir {
            command.current_dir(current_dir);
        }
        command
    }
}
