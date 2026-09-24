use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::io;
use std::mem;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;

use super::ApplicationHandle;

/// Overrides applied to one application relaunch request.
///
/// Omitted values preserve the current executable and command-line arguments. The working
/// directory is always captured when the request is scheduled.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RelaunchOptions {
    executable: Option<PathBuf>,
    arguments: Option<Vec<OsString>>,
}

impl RelaunchOptions {
    /// Creates a request that reuses the current executable and arguments.
    pub const fn new() -> Self {
        Self {
            executable: None,
            arguments: None,
        }
    }

    /// Replaces the executable used by the relaunched instance.
    pub fn with_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.executable = Some(executable.into());
        self
    }

    /// Replaces the arguments passed after the executable.
    ///
    /// Passing an empty iterator explicitly launches the new instance without arguments.
    pub fn with_arguments<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.arguments = Some(arguments.into_iter().map(Into::into).collect());
        self
    }

    /// Returns the executable override, if one was supplied.
    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    /// Returns the argument override, distinguishing an explicit empty list from no override.
    pub fn arguments(&self) -> Option<&[OsString]> {
        self.arguments.as_deref()
    }
}

impl<T: 'static> ApplicationHandle<T> {
    /// Schedules a new instance with this process's executable, arguments, and working directory.
    ///
    /// This does not request an exit; call [`Self::exit`] or [`Self::force_exit`] separately.
    pub fn relaunch(&self) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch()
    }

    /// Schedules a new instance using explicit executable or argument overrides.
    ///
    /// This does not request an exit. Every successful call schedules a separate instance.
    pub fn relaunch_with(&self, options: RelaunchOptions) -> Result<(), RelaunchError> {
        self.event_proxy.relaunch_with(options)
    }
}

/// Stable category for a failure to schedule an application relaunch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelaunchErrorCode {
    /// The current executable could not be resolved.
    CurrentExecutable,
    /// The current working directory could not be captured.
    CurrentDirectory,
    /// The selected executable path was empty.
    InvalidExecutable,
    /// The native application loop had already finished accepting relaunch requests.
    ApplicationExited,
}

/// Failure to capture or retain one application relaunch request.
#[derive(Debug)]
pub struct RelaunchError(RelaunchErrorKind);

#[derive(Debug)]
enum RelaunchErrorKind {
    CurrentExecutable(io::Error),
    CurrentDirectory(io::Error),
    InvalidExecutable,
    ApplicationExited,
}

impl RelaunchError {
    fn current_executable(source: io::Error) -> Self {
        Self(RelaunchErrorKind::CurrentExecutable(source))
    }

    fn current_directory(source: io::Error) -> Self {
        Self(RelaunchErrorKind::CurrentDirectory(source))
    }

    const fn invalid_executable() -> Self {
        Self(RelaunchErrorKind::InvalidExecutable)
    }

    const fn application_exited() -> Self {
        Self(RelaunchErrorKind::ApplicationExited)
    }

    /// Returns the backend-independent scheduling failure category.
    pub const fn code(&self) -> RelaunchErrorCode {
        match &self.0 {
            RelaunchErrorKind::CurrentExecutable(_) => RelaunchErrorCode::CurrentExecutable,
            RelaunchErrorKind::CurrentDirectory(_) => RelaunchErrorCode::CurrentDirectory,
            RelaunchErrorKind::InvalidExecutable => RelaunchErrorCode::InvalidExecutable,
            RelaunchErrorKind::ApplicationExited => RelaunchErrorCode::ApplicationExited,
        }
    }
}

impl fmt::Display for RelaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            RelaunchErrorKind::CurrentExecutable(source) => {
                write!(
                    formatter,
                    "could not resolve the current executable: {source}"
                )
            }
            RelaunchErrorKind::CurrentDirectory(source) => {
                write!(
                    formatter,
                    "could not capture the current directory: {source}"
                )
            }
            RelaunchErrorKind::InvalidExecutable => {
                formatter.write_str("the relaunch executable path cannot be empty")
            }
            RelaunchErrorKind::ApplicationExited => {
                formatter.write_str("the application has stopped accepting relaunch requests")
            }
        }
    }
}

impl Error for RelaunchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match &self.0 {
            RelaunchErrorKind::CurrentExecutable(source) => Some(source),
            RelaunchErrorKind::CurrentDirectory(source) => Some(source),
            RelaunchErrorKind::InvalidExecutable | RelaunchErrorKind::ApplicationExited => None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ApplicationRelauncher {
    inner: Arc<Mutex<RelaunchState>>,
}

impl Default for ApplicationRelauncher {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RelaunchState {
                accepting: true,
                requests: Vec::new(),
            })),
        }
    }
}

struct RelaunchState {
    accepting: bool,
    requests: Vec<RelaunchRequest>,
}

impl ApplicationRelauncher {
    pub(crate) fn schedule(&self, options: RelaunchOptions) -> Result<(), RelaunchError> {
        let request = RelaunchRequest::resolve(options)?;
        let mut state = self.inner.lock().expect("application relaunch queue lock");
        if !state.accepting {
            return Err(RelaunchError::application_exited());
        }
        state.requests.push(request);
        Ok(())
    }

    pub(crate) fn launch_all(&self) -> io::Result<()> {
        self.launch_all_with(RelaunchRequest::launch)
    }

    fn launch_all_with(
        &self,
        mut launch: impl FnMut(&RelaunchRequest) -> io::Result<()>,
    ) -> io::Result<()> {
        let requests = {
            let mut state = self.inner.lock().expect("application relaunch queue lock");
            state.accepting = false;
            mem::take(&mut state.requests)
        };
        let mut first_error = None;
        for request in requests {
            if let Err(error) = launch(&request)
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RelaunchRequest {
    executable: PathBuf,
    arguments: Vec<OsString>,
    working_directory: PathBuf,
}

impl RelaunchRequest {
    fn resolve(options: RelaunchOptions) -> Result<Self, RelaunchError> {
        let executable = match options.executable {
            Some(executable) => executable,
            None => std::env::current_exe().map_err(RelaunchError::current_executable)?,
        };
        if executable.as_os_str().is_empty() {
            return Err(RelaunchError::invalid_executable());
        }
        let arguments = options
            .arguments
            .unwrap_or_else(|| std::env::args_os().skip(1).collect());
        let working_directory =
            std::env::current_dir().map_err(RelaunchError::current_directory)?;
        Ok(Self {
            executable,
            arguments,
            working_directory,
        })
    }

    fn launch(&self) -> io::Result<()> {
        Command::new(&self.executable)
            .args(&self.arguments)
            .current_dir(&self.working_directory)
            .spawn()
            .map(|_| ())
            .map_err(|source| {
                io::Error::new(
                    source.kind(),
                    format!(
                        "could not launch relaunch executable {:?}: {source}",
                        self.executable
                    ),
                )
            })
    }
}

#[cfg(test)]
#[path = "relaunch_tests.rs"]
mod tests;
