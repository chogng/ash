//! Test-only descriptions of helper invocations in the current test executable.

use std::ffi::OsString;
use std::fmt::Display;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

/// Selects a helper in a test executable without depending on a product host or its dispatcher.
/// The consumer supplies the real helper implementation and owns its resources.
pub struct TestBinary {
    executable: PathBuf,
    arguments: Vec<OsString>,
    entry: Entry,
}

enum Entry {
    Test,
    Role,
}

impl TestBinary {
    /// Selects an ignored helper test, using `module_path!()` from its containing module.
    /// Libtest writes to stdout, so this form is for helpers with a separate IPC channel.
    pub fn test(module: &str, name: &str) -> io::Result<Self> {
        let module = module.split_once("::").map_or("", |(_, path)| path);
        let name = if module.is_empty() {
            name.to_owned()
        } else {
            format!("{module}::{name}")
        };
        Ok(Self {
            executable: std::env::current_exe()?,
            arguments: [
                "--exact",
                &name,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ]
            .map(OsString::from)
            .into(),
            entry: Entry::Test,
        })
    }

    /// Selects a role handled by an explicit `main` in a `harness = false` test target.
    /// Call [`Self::dispatch`] before starting its test runner to preserve helper stdio.
    pub fn role(argument: &str) -> io::Result<Self> {
        Ok(Self {
            executable: std::env::current_exe()?,
            arguments: vec![argument.into()],
            entry: Entry::Role,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Creates a child command. Set environment and working directory on this command;
    /// no process-wide environment or PATH changes are made by this crate.
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.arguments);
        command
    }

    /// Runs the supplied helper and exits only when this invocation selects it.
    /// A recognized role with extra arguments fails before the helper runs.
    pub fn dispatch<E: Display>(&self, run: impl FnOnce() -> Result<i32, E>) {
        let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
        if arguments != self.arguments {
            if matches!(self.entry, Entry::Role) && arguments.first() == self.arguments.first() {
                eprintln!("test helper accepts no additional arguments");
                std::process::exit(2);
            }
            return;
        }
        let code = match run() {
            Ok(code) => code,
            Err(error) => {
                eprintln!("test helper failed: {error}");
                1
            }
        };
        std::process::exit(code);
    }
}

#[cfg(test)]
#[path = "binary_tests.rs"]
mod tests;
