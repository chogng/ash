use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::ConnectorMcpRuntimeError;
use ash_core_plugins::LocalCapabilitySource;
use ash_mcp::McpServerTransport;
use ash_rmcp_client::BearerToken;
use ash_rmcp_client::StdioServerCommand;
use ash_rmcp_client::StreamableHttpServer;
use serde::Deserialize;
use url::Url;

use super::runtime_error;

const MAX_DEFINITION_BYTES: u64 = 64 * 1024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 16 * 1024;

pub(super) enum ExtensionsMcpTransport {
    Stdio {
        executable: PathBuf,
        args: Vec<String>,
        current_dir: PathBuf,
    },
    StreamableHttp {
        url: String,
    },
}

impl ExtensionsMcpTransport {
    pub(super) fn materialize(
        &self,
        credential: Option<&str>,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
        match self {
            Self::Stdio {
                executable,
                args,
                current_dir,
            } => {
                if credential.is_some() {
                    return Err(runtime_error(
                        "Extensions stdio MCP does not declare a credential injection slot",
                    ));
                }
                Ok(McpServerTransport::Stdio(
                    StdioServerCommand::new(executable)
                        .with_args(args)
                        .with_current_dir(current_dir),
                ))
            }
            Self::StreamableHttp { url } => {
                let endpoint = StreamableHttpServer::new(url)
                    .map_err(|error| runtime_error(error.to_string()))?;
                let endpoint = match credential {
                    Some(credential) => endpoint.with_bearer_token(
                        BearerToken::new(credential.to_string())
                            .map_err(|error| runtime_error(error.to_string()))?,
                    ),
                    None => endpoint,
                };
                Ok(McpServerTransport::StreamableHttp(endpoint))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase", deny_unknown_fields)]
enum ExtensionsMcpDefinition {
    Stdio {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        url: String,
    },
}

pub(super) fn parse_transport(
    source: &LocalCapabilitySource,
) -> Result<ExtensionsMcpTransport, String> {
    let definition: ExtensionsMcpDefinition = read_json(source.host_path())?;
    match definition {
        ExtensionsMcpDefinition::Stdio {
            schema_version: 1,
            command,
            args,
        } => Ok(ExtensionsMcpTransport::Stdio {
            executable: resolve_executable(source.package_root(), &command)?,
            args: validate_args(args)?,
            current_dir: source.package_root().to_path_buf(),
        }),
        ExtensionsMcpDefinition::Http {
            schema_version: 1,
            url,
        } => {
            let endpoint =
                Url::parse(&url).map_err(|_| "Extensions MCP endpoint is invalid".to_string())?;
            if endpoint.scheme() != "https"
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.fragment().is_some()
                || endpoint.host_str().is_none()
            {
                return Err("Extensions MCP endpoint must be credential-free HTTPS".into());
            }
            Ok(ExtensionsMcpTransport::StreamableHttp { url })
        }
        _ => Err("Extensions MCP contract version is unsupported".into()),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Extensions capability definition is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DEFINITION_BYTES {
        return Err("Extensions capability definition exceeds its file contract".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|_| "Extensions capability definition is unavailable".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Extensions capability definition is invalid".to_string())
}

fn resolve_executable(package_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.trim().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Extensions MCP executable path is invalid".into());
    }
    let executable = package_root
        .join(path)
        .canonicalize()
        .map_err(|_| "Extensions MCP executable is unavailable".to_string())?;
    if !executable.starts_with(package_root) || !executable.is_file() {
        return Err("Extensions MCP executable escaped its immutable package".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if executable
            .metadata()
            .map_err(|_| "Extensions MCP executable is unavailable".to_string())?
            .permissions()
            .mode()
            & 0o111
            == 0
        {
            return Err("Extensions MCP executable is not executable".into());
        }
    }
    Ok(executable)
}

fn validate_args(args: Vec<String>) -> Result<Vec<String>, String> {
    if args.len() > MAX_ARGUMENTS
        || args.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_BYTES
        || args
            .iter()
            .any(|argument| argument.contains('\0') || argument.contains(['\r', '\n']))
    {
        return Err("Extensions MCP arguments exceed safe limits".into());
    }
    Ok(args)
}
