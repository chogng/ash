use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use ash_app_server_transport::DeadlineStream;
use serde::Deserialize;
use serde::Serialize;

use crate::ConnectionOptions;
use crate::GrantSource;

pub(crate) const CONNECTION_PRELUDE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5);
const MAX_PRELUDE_BYTES: usize = 16 * 1024;
const PRELUDE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionPrelude {
    version: u32,
    pub(crate) dir_root: Option<PathBuf>,
    pub(crate) dir_grant_source: ConnectionGrantSource,
    pub(crate) product_services: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) web: Option<ash_app_server_protocol::WebLaunchOptions>,
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
            version: PRELUDE_VERSION,
            dir_root: options.dir_root().map(Path::to_path_buf),
            dir_grant_source: match options.dir_grant_source() {
                GrantSource::HostConfiguration => ConnectionGrantSource::HostConfiguration,
                GrantSource::UserConfig => ConnectionGrantSource::UserConfig,
            },
            product_services: options.product_services().map(Path::to_path_buf),
            web: None,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != PRELUDE_VERSION {
            return Err("unsupported local App Server connection prelude version".into());
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
            version: PRELUDE_VERSION,
            kind: ControlPreludeKind::Control,
            command,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != PRELUDE_VERSION {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlResponse {
    pub(crate) version: u32,
    pub(crate) state: ControlState,
    pub(crate) pid: u32,
    pub(crate) instance_id: String,
    pub(crate) daemon_version: String,
    pub(crate) schema_hash: String,
}

impl ControlResponse {
    pub(crate) fn new(
        state: ControlState,
        pid: u32,
        instance_id: String,
        schema_hash: String,
    ) -> Self {
        Self {
            version: PRELUDE_VERSION,
            state,
            pid,
            instance_id,
            daemon_version: build_info::VERSION.into(),
            schema_hash,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != PRELUDE_VERSION {
            return Err("unsupported local App Server control response version".into());
        }
        Ok(())
    }
}

pub(crate) fn read_prelude(
    reader: &mut BufReader<DeadlineStream>,
) -> Result<IncomingPrelude, String> {
    let mut line = String::new();
    let read = reader
        .by_ref()
        .take((MAX_PRELUDE_BYTES + 1) as u64)
        .read_line(&mut line)
        .map_err(io_error)?;
    if read == 0 || read > MAX_PRELUDE_BYTES || !line.ends_with('\n') {
        return Err("local App Server connection prelude is missing or too large".into());
    }
    let prelude: IncomingPrelude =
        serde_json::from_str(&line).map_err(|error| error.to_string())?;
    prelude.validate()?;
    Ok(prelude)
}

pub(crate) fn write_json_line(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}
