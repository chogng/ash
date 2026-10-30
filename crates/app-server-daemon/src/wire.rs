use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

use crate::ConnectionOptions;
use crate::ConnectionRole;
use crate::GrantSource;

pub(crate) const CONNECTION_PRELUDE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5);
pub(crate) const MAX_PRELUDE_BYTES: usize = 16 * 1024;
const PRELUDE_VERSION: u32 = 3;
const SSH_PRELUDE_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionPrelude {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) startup_trace: Option<crate::startup_trace::StartupTrace>,
    pub(crate) dir_root: Option<PathBuf>,
    pub(crate) dir_grant_source: ConnectionGrantSource,
    pub(crate) product_services: Option<PathBuf>,
    #[serde(default)]
    pub(crate) role: ConnectionRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) web: Option<ash_app_server_protocol::WebLaunchOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ssh: Option<SshConnectionPrelude>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshConnectionPrelude {
    host: String,
    root: Option<String>,
    runtime: String,
}

impl SshConnectionPrelude {
    pub(crate) fn options(&self) -> Result<crate::SshConnectionOptions, String> {
        crate::SshConnectionOptions::new(&self.host, self.root.as_deref(), &self.runtime)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionGrantSource {
    HostConfiguration,
    UserConfig,
}

impl ConnectionPrelude {
    pub(crate) fn from_options(options: &ConnectionOptions) -> Self {
        Self {
            version: if matches!(
                options.role(),
                ConnectionRole::Execution { .. } | ConnectionRole::Credentials
            ) {
                PRELUDE_VERSION
            } else if options.ssh().is_some() {
                SSH_PRELUDE_VERSION
            } else {
                1
            },
            startup_trace: crate::startup_trace::StartupTrace::current(),
            dir_root: options.dir_root().map(Path::to_path_buf),
            dir_grant_source: match options.dir_grant_source() {
                GrantSource::HostConfiguration => ConnectionGrantSource::HostConfiguration,
                GrantSource::UserConfig => ConnectionGrantSource::UserConfig,
            },
            product_services: options.product_services().map(Path::to_path_buf),
            role: options.role(),
            web: None,
            ssh: options.ssh().map(|ssh| SshConnectionPrelude {
                host: ssh.host().into(),
                root: ssh.root().map(str::to_owned),
                runtime: ssh.runtime().into(),
            }),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if let Some(trace) = &self.startup_trace {
            trace.validate()?;
        }
        if !(1..=PRELUDE_VERSION).contains(&self.version) {
            return Err("unsupported local App Server connection prelude version".into());
        }
        if let Some(ssh) = &self.ssh {
            if self.version < SSH_PRELUDE_VERSION
                || self.dir_root.is_some()
                || self.role != ConnectionRole::Workbench
                || self.web.is_some()
            {
                return Err("invalid SSH App Server connection scope".into());
            }
            ssh.options()?;
        }
        if let ConnectionRole::Execution { environment, .. } = &self.role {
            if self.version != PRELUDE_VERSION
                || self
                    .dir_root
                    .as_ref()
                    .is_none_or(|root| !root.is_absolute())
                || self.dir_grant_source != ConnectionGrantSource::HostConfiguration
                || self.web.is_some()
                || self.ssh.is_some()
                || self.product_services.is_some()
            {
                return Err("invalid execution connection scope".into());
            }
            exec_server_protocol::validate_id(environment)
                .map_err(|_| "invalid execution environment identity".to_owned())?;
        }
        if self.role == ConnectionRole::Credentials
            && (self.version != PRELUDE_VERSION
                || self.dir_root.is_some()
                || self.web.is_some()
                || self.ssh.is_some())
        {
            return Err("invalid native credential consumer scope".into());
        }
        Ok(())
    }

    pub(crate) fn grant_source(&self) -> GrantSource {
        match self.dir_grant_source {
            ConnectionGrantSource::HostConfiguration => GrantSource::HostConfiguration,
            ConnectionGrantSource::UserConfig => GrantSource::UserConfig,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ControlCommand {
    Status,
    Stop,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlPrelude {
    version: u32,
    kind: ControlPreludeKind,
    pub(crate) command: ControlCommand,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ControlPreludeKind {
    Control,
}

impl ControlPrelude {
    pub(crate) fn new(command: ControlCommand) -> Self {
        Self {
            // Lifecycle commands retain their original shape so a new controller can
            // inspect and stop an older backend before selecting another generation.
            version: 1,
            kind: ControlPreludeKind::Control,
            command,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if !(1..=PRELUDE_VERSION).contains(&self.version) {
            return Err("unsupported local App Server control prelude version".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum IncomingPrelude {
    Control(ControlPrelude),
    Connection(ConnectionPrelude),
}

impl IncomingPrelude {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Control(prelude) => prelude.validate(),
            Self::Connection(prelude) => prelude.validate(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ControlState {
    Running,
    Stopping,
}

/// Transport admission advertised by the running App Server owner after profile startup.
/// This does not advertise directory features or complete a client's initialize handshake.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ManagedConnectionContract {
    /// Agent RPC is available; the client still negotiates its required capabilities.
    Agent {
        #[serde(rename = "protocolVersion")]
        protocol_version: ash_app_server_protocol::protocol::initialize::ProtocolVersion,
    },
    /// Profile history has moved; this process accepts execution connections only.
    Execution,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlResponse {
    pub(crate) version: u32,
    pub(crate) state: ControlState,
    pub(crate) pid: u32,
    pub(crate) instance_id: String,
    pub(crate) daemon_version: String,
    pub(crate) schema_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) connection_contract: Option<ManagedConnectionContract>,
}

impl ControlResponse {
    pub(crate) fn validate_connection(&self, options: &ConnectionOptions) -> Result<(), String> {
        self.validate()?;
        let required_version = if matches!(
            options.role(),
            ConnectionRole::Execution { .. } | ConnectionRole::Credentials
        ) {
            PRELUDE_VERSION
        } else if options.ssh().is_some() {
            SSH_PRELUDE_VERSION
        } else {
            1
        };
        if self.version < required_version {
            return Err("running App Server does not support this connection scope; select an updated backend".into());
        }
        Ok(())
    }

    pub(crate) fn new(
        state: ControlState,
        pid: u32,
        instance_id: String,
        schema_hash: String,
        connection_contract: Option<ManagedConnectionContract>,
    ) -> Self {
        Self {
            version: PRELUDE_VERSION,
            state,
            pid,
            instance_id,
            daemon_version: build_info::VERSION.into(),
            schema_hash,
            connection_contract,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(1..=PRELUDE_VERSION).contains(&self.version) {
            return Err("unsupported local App Server control response version".into());
        }
        Ok(())
    }
}

pub(crate) fn decode_prelude(line: &[u8]) -> Result<IncomingPrelude, String> {
    if line.is_empty() || line.len() > MAX_PRELUDE_BYTES || !line.ends_with(b"\n") {
        return Err("local App Server connection prelude is missing or too large".into());
    }
    let prelude: IncomingPrelude =
        serde_json::from_slice(line).map_err(|error| error.to_string())?;
    prelude.validate()?;
    Ok(prelude)
}

pub(crate) fn write_json_line(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
