use crate::ConfigError;
use serde::Deserialize;
use serde::Serialize;

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
            let url = url::Url::parse(endpoint)
                .map_err(|_| ConfigError("invalid messageBoard endpoint".into()))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(ConfigError("messageBoard endpoint must be an HTTP(S) URL without credentials, query or fragment".into()));
            }
            let mut bytes = credential_env.bytes();
            if !bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err(ConfigError(
                    "messageBoard credentialEnv must name a host environment variable".into(),
                ));
            }
        }
        Ok(())
    }
}
