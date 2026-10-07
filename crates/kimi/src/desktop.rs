//! Read-only access to the Kimi Desktop app's separate Kimi Code gateway connection.

use crate::KimiError;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpHeader;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use zeroize::Zeroize;
use zeroize::Zeroizing;

const DESKTOP_GATEWAY: &str = "https://agent-gw.kimi.com/coding/v1";
const DESKTOP_CONFIG: &str = "kimi-desktop/daimon-share/daimon/runtime/kimi-code/config.toml";

/// Reads the desktop-owned gateway credential afresh for each model request.
/// Kimi Desktop remains responsible for rotating and deleting that credential.
pub struct KimiDesktop {
    config_path: PathBuf,
}

impl KimiDesktop {
    pub fn production() -> Option<Self> {
        dirs::data_dir().map(|data_dir| Self::at(data_dir.join(DESKTOP_CONFIG)))
    }

    pub fn at(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    pub fn is_ready(&self) -> bool {
        self.credential().is_ok()
    }

    pub fn api_target(&self) -> Result<ResolvedApiTarget, KimiError> {
        let credential = self.credential()?;
        Ok(ResolvedApiTarget::new(
            DESKTOP_GATEWAY,
            vec![
                HttpHeader::new("Authorization", format!("Bearer {}", credential.api_key)),
                HttpHeader::new("User-Agent", format!("Ash/{}", env!("CARGO_PKG_VERSION"))),
            ],
            ash_client::RequestBinding::new(
                ash_client::RequestPurpose::Model,
                ash_client::RequestIdentity::connection(
                    "kimi-desktop",
                    credential.api_key.as_bytes(),
                ),
            ),
        ))
    }

    /// A digest separates model catalogs across credential rotations without storing the key.
    pub fn catalog_identity(&self) -> Result<String, KimiError> {
        let credential = self.credential()?;
        Ok(format!(
            "{:x}",
            Sha256::digest(credential.api_key.as_bytes())
        ))
    }

    fn credential(&self) -> Result<DesktopProvider, KimiError> {
        let source = Zeroizing::new(
            fs::read_to_string(&self.config_path)
                .map_err(|_| KimiError::new("Kimi Desktop connection is unavailable"))?,
        );
        let config: DesktopConfig = toml::from_str(&source)
            .map_err(|_| KimiError::new("Kimi Desktop connection is invalid"))?;
        let provider = config.providers.daimon_kimi_code;
        if provider.kind != "kimi"
            || provider.base_url.trim_end_matches('/') != DESKTOP_GATEWAY
            || provider.api_key.trim().is_empty()
        {
            return Err(KimiError::new("Kimi Desktop connection is invalid"));
        }
        Ok(provider)
    }
}

#[derive(Deserialize)]
struct DesktopConfig {
    providers: DesktopProviders,
}

#[derive(Deserialize)]
struct DesktopProviders {
    #[serde(rename = "daimon-kimi-code")]
    daimon_kimi_code: DesktopProvider,
}

#[derive(Deserialize)]
struct DesktopProvider {
    #[serde(rename = "type")]
    kind: String,
    base_url: String,
    api_key: String,
}

impl Drop for DesktopProvider {
    fn drop(&mut self) {
        self.api_key.zeroize();
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
