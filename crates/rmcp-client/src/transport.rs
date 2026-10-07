use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::RmcpClientError;

/// Local child-process command used by the stdio convenience connector.
#[derive(Clone, Debug)]
pub struct StdioServerCommand {
    program: OsString,
    args: Vec<OsString>,
    env: BTreeMap<OsString, OsString>,
    current_dir: Option<PathBuf>,
}

impl StdioServerCommand {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            current_dir: None,
        }
    }

    pub fn with_arg(mut self, argument: impl Into<OsString>) -> Self {
        self.args.push(argument.into());
        self
    }

    pub fn with_args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }

    pub fn with_current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub(crate) fn into_command(self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(self.program);
        command.args(self.args).envs(self.env).kill_on_drop(true);
        if let Some(current_dir) = self.current_dir {
            command.current_dir(current_dir);
        }
        command
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn current_dir(&self) -> Option<&Path> {
        self.current_dir.as_deref()
    }
}

/// Secret bearer token material supplied by the host at connection time.
///
/// This type intentionally does not implement `Clone` or expose `Debug` content.
pub struct BearerToken(String);

impl BearerToken {
    pub fn new(value: impl Into<String>) -> Result<Self, RmcpClientError> {
        let value = value.into();
        if value.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err(RmcpClientError::InvalidBearerToken);
        }
        Ok(Self(value))
    }

    pub(crate) fn into_inner(self) -> String {
        self.0
    }
}

impl std::fmt::Debug for BearerToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BearerToken([REDACTED])")
    }
}

/// Authorization material for one Streamable HTTP connection.
#[derive(Debug, Default)]
pub enum HttpAuthorization {
    #[default]
    Unauthenticated,
    Bearer(BearerToken),
}

/// Streamable HTTP endpoint and connection-time authorization.
#[derive(Debug)]
pub struct StreamableHttpServer {
    uri: String,
    authorization: HttpAuthorization,
}

impl StreamableHttpServer {
    pub fn new(uri: impl Into<String>) -> Result<Self, RmcpClientError> {
        let uri = uri.into();
        if !(uri.starts_with("https://") || uri.starts_with("http://"))
            || uri.contains(['\r', '\n'])
        {
            return Err(RmcpClientError::InvalidHttpEndpoint);
        }
        Ok(Self {
            uri,
            authorization: HttpAuthorization::Unauthenticated,
        })
    }

    pub fn with_bearer_token(mut self, token: BearerToken) -> Self {
        self.authorization = HttpAuthorization::Bearer(token);
        self
    }

    pub fn uri(&self) -> &str {
        &self.uri
    }

    pub(crate) fn into_parts(self) -> (String, HttpAuthorization) {
        (self.uri, self.authorization)
    }
}
