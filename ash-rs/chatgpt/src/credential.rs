use crate::oauth::ChatGptError;
use base64::Engine;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use zeroize::Zeroize;
use zeroize::Zeroizing;

/// The user and workspace that own a ChatGPT credential, independent of token rotation.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AccountIdentity {
    pub(crate) user_id: String,
    pub(crate) account_id: String,
}

#[derive(Clone)]
pub(crate) struct TokenCredential {
    pub(crate) access_token: String,
    pub(crate) expires_at: Option<u64>,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) user_id: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) is_fedramp: bool,
    pub(crate) credential_revision: u64,
    pub(crate) storage_revision: [u8; 32],
    pub(crate) last_refresh: Option<i64>,
    pub(crate) refresh_available: bool,
}

impl TokenCredential {
    pub(crate) fn identity(&self) -> Result<AccountIdentity, ChatGptError> {
        match (&self.user_id, &self.account_id) {
            (Some(user_id), Some(account_id))
                if !user_id.trim().is_empty() && !account_id.trim().is_empty() =>
            {
                Ok(AccountIdentity {
                    user_id: user_id.clone(),
                    account_id: account_id.clone(),
                })
            }
            _ => Err(ChatGptError::new(
                "ChatGPT credentials have incomplete account identity",
            )),
        }
    }

    pub(crate) fn from_parts(
        id_token: &str,
        access_token: String,
        account_id: Option<String>,
    ) -> Result<Self, ChatGptError> {
        let mut access_token = Zeroizing::new(access_token);
        if id_token.trim().is_empty() || access_token.trim().is_empty() {
            return Err(ChatGptError::new(
                "Codex returned incomplete ChatGPT credentials",
            ));
        }
        let claims: IdentityClaims = decode_jwt_payload(id_token)?;
        // Codex treats an opaque access token as having unknown expiry; the
        // provider still validates it, and last_refresh drives proactive renewal.
        let expires_at = decode_jwt_payload::<ExpirationClaims>(&access_token)
            .ok()
            .and_then(|claims| claims.exp)
            .and_then(|value| u64::try_from(value).ok());
        let auth = claims.auth.unwrap_or_default();
        use sha2::Digest;
        let digest = sha2::Sha256::digest(access_token.as_bytes());
        let credential_revision = u64::from_be_bytes(
            digest[..8]
                .try_into()
                .expect("SHA-256 prefix has eight bytes"),
        ) >> 16;
        Ok(Self {
            access_token: std::mem::take(&mut *access_token),
            expires_at,
            email: claims
                .email
                .or_else(|| claims.profile.and_then(|value| value.email)),
            plan: auth.chatgpt_plan_type,
            user_id: auth.chatgpt_user_id.or(auth.user_id),
            account_id: account_id.or(auth.chatgpt_account_id),
            is_fedramp: auth.chatgpt_account_is_fedramp,
            credential_revision,
            storage_revision: [0; 32],
            last_refresh: None,
            refresh_available: false,
        })
    }

    pub(crate) fn is_usable(&self) -> bool {
        self.expires_at
            .is_none_or(|expires_at| expires_at > now_epoch_seconds())
    }

    pub(crate) fn needs_refresh(&self) -> bool {
        // Same proactive rules as Codex AuthManager: five minutes before expiry;
        // only when expiry is unknown, use the eight-day last_refresh interval.
        match self.expires_at {
            Some(expiry) => expiry <= now_epoch_seconds().saturating_add(300),
            None => self
                .last_refresh
                .is_some_and(|last| last < now_epoch_seconds() as i64 - 8 * 24 * 60 * 60),
        }
    }
}

impl Drop for TokenCredential {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.email.zeroize();
        self.user_id.zeroize();
        self.account_id.zeroize();
    }
}

#[derive(Deserialize)]
pub(crate) struct TokenResponse {
    pub(crate) id_token: String,
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.id_token.zeroize();
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Deserialize)]
struct IdentityClaims {
    #[serde(default)]
    email: Option<String>,
    #[serde(rename = "https://api.openai.com/profile", default)]
    profile: Option<ProfileClaims>,
    #[serde(rename = "https://api.openai.com/auth", default)]
    auth: Option<AuthClaims>,
}

#[derive(Deserialize)]
struct ProfileClaims {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Default, Deserialize)]
struct AuthClaims {
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
    #[serde(default)]
    chatgpt_user_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    chatgpt_account_is_fedramp: bool,
}

#[derive(Deserialize)]
struct ExpirationClaims {
    #[serde(default)]
    exp: Option<i64>,
}

fn decode_jwt_payload<T: DeserializeOwned>(jwt: &str) -> Result<T, ChatGptError> {
    let mut parts = jwt.split('.');
    let payload = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature), None)
            if !header.is_empty() && !payload.is_empty() && !signature.is_empty() =>
        {
            payload
        }
        _ => return Err(ChatGptError::new("OpenAI returned an invalid token")),
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ChatGptError::new("OpenAI returned an invalid token"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ChatGptError::new("OpenAI returned an invalid token"))
}

pub(crate) fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
