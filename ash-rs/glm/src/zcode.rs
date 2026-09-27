use super::Credential;
use super::GlmProvider;
use super::unavailable;
use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use aes_gcm::aead::Aead;
use aes_gcm::aead::KeyInit;
use ash_login::LoginError;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Reads ZCode's credential store without changing it or copying its key into Ash.
pub(super) struct ZCodeCredentials {
    path: PathBuf,
    secret_override: Option<String>,
}

impl ZCodeCredentials {
    pub(super) fn from_environment() -> Result<Self, LoginError> {
        let base = std::env::var("ZCODE_DATA_BASE_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .ok_or_else(unavailable)?;
        Ok(Self {
            path: base.join(".zcode/v2/credentials.json"),
            secret_override: None,
        })
    }

    #[cfg(test)]
    pub(super) fn at(path: PathBuf) -> Self {
        Self {
            path,
            secret_override: Some("test-secret".into()),
        }
    }

    /// ZCode is an optional credential source. Only a complete, readable subscription
    /// takes precedence over Ash's own login; an unusable ZCode record stays untouched.
    pub(super) fn reusable_credential(&self, provider: GlmProvider) -> Option<Credential> {
        self.read_candidate(provider).ok().flatten()
    }

    fn read_candidate(&self, provider: GlmProvider) -> Result<Option<Credential>, LoginError> {
        let raw = match std::fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(unavailable()),
        };
        let entries: BTreeMap<String, String> =
            serde_json::from_slice(&raw).map_err(|_| unavailable())?;
        let (provider_id, user_info_key) = match provider {
            GlmProvider::BigModel => (
                "account:bigmodel-individual-coding-plan",
                "oauth:bigmodel:user_info",
            ),
            GlmProvider::Zai => ("account:zai-individual-coding-plan", "oauth:zai:user_info"),
        };
        let identity_key = format!("account-provider:{provider_id}:identity");
        // ZCode CLI records the selected identity separately; Desktop can keep the same
        // account's key with only OAuth user_info. Both name the exact account key below.
        let (identity, email, display_name) = if let Some(identity) = entries.get(&identity_key) {
            (
                decrypt(identity, self.secret_override.as_deref())?,
                None,
                None,
            )
        } else if let Some(profile) = entries.get(user_info_key) {
            let profile: serde_json::Value =
                serde_json::from_str(&decrypt(profile, self.secret_override.as_deref())?)
                    .map_err(|_| unavailable())?;
            let id_field = match provider {
                GlmProvider::BigModel => "id",
                GlmProvider::Zai => "user_id",
            };
            let id = profile[id_field]
                .as_str()
                .ok_or_else(unavailable)?
                .to_owned();
            let user = match provider {
                GlmProvider::BigModel => &profile["rawProfile"],
                GlmProvider::Zai => &profile,
            };
            (
                id,
                user["email"].as_str().map(str::to_owned),
                user["name"].as_str().map(str::to_owned),
            )
        } else {
            return Ok(None);
        };
        let identity = identity.trim().to_owned();
        if identity.is_empty() {
            return Err(unavailable());
        }
        let encoded_identity = encode_component(&identity);
        let key_name = format!(
            "account-provider:coding-plan:{provider_id}:account:{encoded_identity}:api-key"
        );
        // ZCode may retain OAuth account metadata without a Coding Plan key. That account
        // is not a usable subscription and must not prevent Ash from starting its own login.
        let Some(model_key) = entries.get(&key_name) else {
            return Ok(None);
        };
        let model_key = decrypt(model_key, self.secret_override.as_deref())?
            .trim()
            .to_owned();
        if model_key.is_empty() {
            return Err(unavailable());
        }
        let fingerprint = Sha256::digest(model_key.as_bytes());
        let revision =
            u64::from_be_bytes(fingerprint[..8].try_into().expect("SHA-256 has 8 bytes"));
        Ok(Some(Credential {
            account_id: identity,
            email,
            display_name,
            model_key,
            revision,
        }))
    }
}

fn decrypt(raw: &str, secret_override: Option<&str>) -> Result<String, LoginError> {
    let Some(encoded) = raw.strip_prefix("enc:v1:") else {
        return Ok(raw.to_owned());
    };
    let mut parts = encoded.split('.');
    let iv = parts.next().ok_or_else(unavailable)?;
    let tag = parts.next().ok_or_else(unavailable)?;
    let ciphertext = parts.next().ok_or_else(unavailable)?;
    if parts.next().is_some() {
        return Err(unavailable());
    }
    let iv = URL_SAFE_NO_PAD.decode(iv).map_err(|_| unavailable())?;
    let tag = URL_SAFE_NO_PAD.decode(tag).map_err(|_| unavailable())?;
    let mut payload = URL_SAFE_NO_PAD
        .decode(ciphertext)
        .map_err(|_| unavailable())?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err(unavailable());
    }
    payload.extend_from_slice(&tag);
    let secret = match secret_override
        .map(str::to_owned)
        .or_else(|| std::env::var("ZCODE_CREDENTIAL_SECRET").ok())
    {
        Some(value) if !value.trim().is_empty() => value.trim().to_owned(),
        _ => format!(
            "zcode-credential-fallback:{}:{}:{}",
            node_platform(),
            dirs::home_dir().ok_or_else(unavailable)?.display(),
            whoami::username()
        ),
    };
    let key = Sha256::digest(secret.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| unavailable())?;
    let clear = cipher
        .decrypt(Nonce::from_slice(&iv), payload.as_slice())
        .map_err(|_| unavailable())?;
    String::from_utf8(clear).map_err(|_| unavailable())
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

// ZCode uses JavaScript encodeURIComponent for the account segment, including %20 for spaces.
fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
