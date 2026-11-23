use crate::ConfigError;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;

/// Deployment choice for task discussion storage. Credential values remain outside configuration.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MessageBoardConfig {
    #[default]
    Local,
    Remote {
        endpoint: String,
        credential_env: String,
    },
}
impl MessageBoardConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if let Self::Remote {
            endpoint,
            credential_env,
        } = self
        {
            validate_location("messageBoard", endpoint, credential_env)?;
        }
        Ok(())
    }
}

/// Routes explicitly identified, permanently deleted Sessions to a former board deployment.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageBoardCleanupConfig {
    pub endpoint: String,
    pub credential_env: String,
    pub deleted_sessions: BTreeSet<SessionId>,
}

impl MessageBoardCleanupConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        validate_location("messageBoardCleanup", &self.endpoint, &self.credential_env)?;
        if self.deleted_sessions.is_empty() {
            return Err(ConfigError(
                "messageBoardCleanup deletedSessions must name at least one Session".into(),
            ));
        }
        Ok(())
    }
}

fn validate_location(field: &str, endpoint: &str, credential_env: &str) -> Result<(), ConfigError> {
    let url =
        url::Url::parse(endpoint).map_err(|_| ConfigError(format!("invalid {field} endpoint")))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ConfigError(format!(
            "{field} endpoint must be an HTTP(S) URL without credentials, query or fragment"
        )));
    }
    let mut bytes = credential_env.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(ConfigError(format!(
            "{field} credentialEnv must name a host environment variable"
        )));
    }
    Ok(())
}
