use super::CHATGPT_PLAN_PROVIDER_ID;
use super::failure;
use crate::ChatGptError;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::AccountStatus;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use std::collections::BTreeMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::Arc;
use zeroize::Zeroize;

pub(super) struct PlanStore {
    secrets: Arc<dyn SecretStore>,
    lock_path: PathBuf,
}

impl PlanStore {
    pub(super) fn new(secrets: Arc<dyn SecretStore>, lock_path: PathBuf) -> Self {
        Self { secrets, lock_path }
    }

    pub(super) fn lock(&self) -> Result<File, ChatGptError> {
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&self.lock_path)
            .map_err(|_| failure("ChatGPT plan session lock is unavailable"))?;
        file.lock_exclusive()
            .map_err(|_| failure("ChatGPT plan session could not be locked"))?;
        Ok(file)
    }

    fn key() -> SecretKey {
        SecretKey::new("provider/chatgpt-plan/registrations-v1").expect("constant secret key")
    }

    pub(super) fn load(&self) -> Result<State, ChatGptError> {
        self.secrets
            .load(&Self::key())
            .map_err(|_| failure("ChatGPT plan credentials could not be read"))?
            .map(|value| {
                serde_json::from_slice(value.expose())
                    .map_err(|_| failure("ChatGPT plan credentials are invalid"))
            })
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub(super) fn save(&self, state: &State) -> Result<(), ChatGptError> {
        let bytes = serde_json::to_vec(state)
            .map_err(|_| failure("ChatGPT plan credentials could not be encoded"))?;
        self.secrets
            .store(&Self::key(), &SecretValue::new(bytes))
            .map_err(|_| failure("ChatGPT plan credentials could not be saved"))
    }
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct State {
    pub(super) host_id: String,
    pub(super) selection_revision: u64,
    pub(super) active: Option<String>,
    pub(super) accounts: BTreeMap<String, Registration>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Registration {
    pub(super) client_id: String,
    pub(super) subject: String,
    pub(super) email: Option<String>,
    pub(super) revision: u64,
    pub(super) tokens: Option<Tokens>,
}

impl Registration {
    pub(super) fn id(&self) -> String {
        let hash = sha2::Sha256::digest(format!(
            "{}\0{}\0{}",
            super::ISSUER,
            self.client_id,
            self.subject
        ));
        format!("{hash:x}")
    }

    pub(super) fn ready(&self) -> bool {
        self.tokens.as_ref().is_some_and(|tokens| {
            tokens.has_plan_scope()
                && (tokens.expires_at > now() || !tokens.refresh_token.is_empty())
        })
    }

    pub(super) fn snapshot(&self) -> AccountSnapshot {
        AccountSnapshot {
            account: AccountRef {
                provider: CHATGPT_PLAN_PROVIDER_ID.into(),
                account_id: self.id(),
            },
            email: self.email.clone(),
            // Registration IDs distinguish two workspaces with the same email. Workspace names
            // and plan names are not exposed by this API and must remain unknown.
            display_name: Some(format!(
                "{} · {}",
                self.email.as_deref().unwrap_or("ChatGPT"),
                self.client_id
            )),
            organization: None,
            plan: None,
            status: if self.ready() {
                AccountStatus::Ready
            } else {
                AccountStatus::ReauthenticationRequired
            },
            credential_revision: self.revision,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Tokens {
    pub(super) access_token: String,
    pub(super) refresh_token: String,
    pub(super) id_token: String,
    pub(super) scopes: Vec<String>,
    pub(super) expires_at: u64,
    pub(super) earliest_refresh_at: u64,
}

impl Tokens {
    pub(super) fn has_plan_scope(&self) -> bool {
        ["chatgpt.tokens.use.direct", "resource.invoke"]
            .iter()
            .all(|scope| self.scopes.iter().any(|granted| granted == scope))
    }
}

impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}

pub(super) fn now() -> u64 {
    crate::credential::now_epoch_seconds()
}

pub(super) fn new_host_id() -> Result<String, ChatGptError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| failure("ChatGPT plan host randomness is unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
