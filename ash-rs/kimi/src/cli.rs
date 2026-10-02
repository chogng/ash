//! Read-only access to Kimi Code CLI's own OAuth credential.

use crate::KimiError;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpHeader;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use zeroize::Zeroize;
use zeroize::Zeroizing;

const DEFAULT_BASE_URL: &str = "https://api.kimi.com/coding/v1";

/// Reads the CLI-owned token at request time so CLI logout and rotation take effect.
pub struct KimiCli {
    home: PathBuf,
}

impl KimiCli {
    pub fn production() -> Option<Self> {
        let home = std::env::var_os("KIMI_CODE_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".kimi-code")))?;
        Some(Self::at(home))
    }

    pub fn at(home: PathBuf) -> Self {
        Self { home }
    }

    pub fn is_ready(&self) -> bool {
        self.credential().is_ok()
    }

    pub fn api_target(&self) -> Result<ResolvedApiTarget, KimiError> {
        let (base_url, credential, device_id) = self.credential()?;
        // The token belongs to the CLI device; the requesting product identifies itself as Ash.
        Ok(ResolvedApiTarget::new(
            base_url,
            vec![
                HttpHeader::new(
                    "Authorization",
                    format!("Bearer {}", credential.access_token),
                ),
                HttpHeader::new("User-Agent", format!("Ash/{}", env!("CARGO_PKG_VERSION"))),
                HttpHeader::new("X-Msh-Platform", "Ash"),
                HttpHeader::new("X-Msh-Version", env!("CARGO_PKG_VERSION")),
                HttpHeader::new("X-Msh-Device-Name", "Ash"),
                HttpHeader::new("X-Msh-Device-Model", crate::device_model()),
                HttpHeader::new("X-Msh-Device-Id", &device_id),
            ],
            ash_client::RequestBinding::new(
                ash_client::RequestPurpose::Model,
                ash_client::RequestIdentity::connection(
                    "kimi-cli",
                    credential.access_token.as_bytes(),
                ),
            ),
        ))
    }

    pub fn catalog_identity(&self) -> Result<String, KimiError> {
        let (base_url, credential, device_id) = self.credential()?;
        let mut digest = Sha256::new();
        digest.update(base_url.as_bytes());
        digest.update(b":");
        digest.update(device_id.as_bytes());
        digest.update(b":");
        digest.update(credential.access_token.as_bytes());
        Ok(format!("{:x}", digest.finalize()))
    }

    fn credential(&self) -> Result<(String, CliCredential, String), KimiError> {
        let source = Zeroizing::new(
            fs::read_to_string(self.home.join("config.toml"))
                .map_err(|_| KimiError::new("Kimi Code CLI connection is unavailable"))?,
        );
        let config: CliConfig = toml::from_str(&source)
            .map_err(|_| KimiError::new("Kimi Code CLI connection is invalid"))?;
        let provider = config.providers.kimi_code;
        let base_url = provider.base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let base_url = base_url.trim_end_matches('/').to_owned();
        if provider.kind != "kimi"
            || !base_url.starts_with("https://")
            || provider.oauth.storage != "file"
        {
            return Err(KimiError::new("Kimi Code CLI connection is invalid"));
        }
        let name = provider
            .oauth
            .key
            .strip_prefix("oauth/")
            .unwrap_or(&provider.oauth.key);
        if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
            return Err(KimiError::new("Kimi Code CLI credential name is invalid"));
        }
        let source = Zeroizing::new(
            fs::read_to_string(self.home.join("credentials").join(format!("{name}.json")))
                .map_err(|_| KimiError::new("Kimi Code CLI is not signed in"))?,
        );
        let credential: CliCredential = serde_json::from_str(&source)
            .map_err(|_| KimiError::new("Kimi Code CLI credential is invalid"))?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| KimiError::new("System clock is invalid"))?
            .as_secs();
        if credential.access_token.is_empty() || credential.expires_at <= now + 30 {
            return Err(KimiError::new(
                "Kimi Code CLI token has expired; refresh it in Kimi Code",
            ));
        }
        let device_id = fs::read_to_string(self.home.join("device_id"))
            .map_err(|_| KimiError::new("Kimi Code CLI device identity is unavailable"))?;
        let device_id = device_id.trim();
        if device_id.is_empty()
            || !device_id.is_ascii()
            || device_id
                .chars()
                .any(|character| character.is_ascii_control())
        {
            return Err(KimiError::new("Kimi Code CLI device identity is invalid"));
        }
        Ok((base_url, credential, device_id.into()))
    }
}

#[derive(Deserialize)]
struct CliConfig {
    providers: CliProviders,
}

#[derive(Deserialize)]
struct CliProviders {
    #[serde(rename = "managed:kimi-code")]
    kimi_code: CliProvider,
}

#[derive(Deserialize)]
struct CliProvider {
    #[serde(rename = "type")]
    kind: String,
    base_url: Option<String>,
    oauth: CliOauth,
}

#[derive(Deserialize)]
struct CliOauth {
    storage: String,
    key: String,
}

#[derive(Deserialize)]
struct CliCredential {
    access_token: String,
    expires_at: u64,
}

impl Drop for CliCredential {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
