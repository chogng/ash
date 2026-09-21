use crate::credential::AccountIdentity;
use crate::credential::TokenCredential;
use crate::oauth::CLIENT_ID;
use crate::oauth::ChatGptError;
use crate::storage::CodexAuthStore;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::sync::Mutex;
use zeroize::Zeroize;

/// Selects who maintains shared ChatGPT credentials. Production hosts use Automatic;
/// tests explicitly select an owner so real credentials can never be refreshed by a fixture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatGptAuthManagement {
    Automatic,
    Codex,
    Ash,
}

impl ChatGptAuthManagement {
    pub(crate) fn is_ash(self) -> bool {
        match self {
            Self::Automatic => !codex_installed(),
            Self::Codex => false,
            Self::Ash => true,
        }
    }
}

pub(crate) enum RefreshReason {
    Proactive,
    Unauthorized {
        identity: AccountIdentity,
        revision: [u8; 32],
    },
}

pub(crate) struct AuthMaintenance {
    pub(crate) management: ChatGptAuthManagement,
    failed: Mutex<Option<[u8; 32]>>,
}

impl AuthMaintenance {
    pub(crate) fn new(management: ChatGptAuthManagement) -> Self {
        Self {
            management,
            failed: Mutex::new(None),
        }
    }

    pub(crate) fn requires_login(&self, credential: &TokenCredential) -> bool {
        self.failed
            .lock()
            .map(|failed| *failed == Some(credential.storage_revision))
            .unwrap_or(true)
    }

    pub(crate) fn reject(&self, credential: &TokenCredential) {
        if let Ok(mut failed) = self.failed.lock() {
            *failed = Some(credential.storage_revision);
        }
    }

    pub(crate) fn resolve(
        &self,
        store: &CodexAuthStore,
        client: &dyn OperationClient,
        reason: RefreshReason,
    ) -> Result<Option<TokenCredential>, ChatGptError> {
        let Some(observed) = store.load()? else {
            return Ok(None);
        };
        let owner = observed.identity()?;
        if let RefreshReason::Unauthorized { identity, revision } = &reason {
            if owner != *identity {
                return Err(ChatGptError::new("ChatGPT account changed before recovery"));
            }
            if observed.storage_revision != *revision {
                return Ok(Some(observed));
            }
        }
        if self.requires_login(&observed) {
            return if matches!(reason, RefreshReason::Proactive) && observed.is_usable() {
                Ok(Some(observed))
            } else {
                Err(reauthenticate())
            };
        }
        if !self.management.is_ash()
            || (!observed.needs_refresh() && matches!(reason, RefreshReason::Proactive))
        {
            return Ok(Some(observed));
        }
        let guard = store.lock_updates()?;
        let mut snapshot = store
            .snapshot()?
            .ok_or_else(|| ChatGptError::new("ChatGPT credentials were removed before refresh"))?;
        if snapshot.credential.identity()? != owner {
            return Err(ChatGptError::new(
                "ChatGPT account changed before refresh; retry with the current account",
            ));
        }
        if snapshot.credential.storage_revision != observed.storage_revision
            || !self.management.is_ash()
        {
            return Ok(Some(snapshot.credential.clone()));
        }
        if self.requires_login(&snapshot.credential) {
            return if matches!(reason, RefreshReason::Proactive) && snapshot.credential.is_usable()
            {
                Ok(Some(snapshot.credential.clone()))
            } else {
                Err(reauthenticate())
            };
        }
        let Some(token) = snapshot.refresh_token() else {
            self.reject(&snapshot.credential);
            return if matches!(reason, RefreshReason::Proactive) && snapshot.credential.is_usable()
            {
                Ok(Some(snapshot.credential.clone()))
            } else {
                Err(reauthenticate())
            };
        };
        match request_refresh(client, token) {
            Ok(mut response) => store
                .save_refresh(&guard, &mut snapshot, &mut response)
                .map(Some),
            Err(failure) => {
                // Another credential owner may have completed rotation while our request
                // was in flight. Adopt only a changed record for the same account.
                if let Some(latest) = store.load()? {
                    if latest.identity()? != snapshot.credential.identity()? {
                        return Err(ChatGptError::new("ChatGPT account changed during refresh"));
                    }
                    if latest.storage_revision != snapshot.credential.storage_revision {
                        return Ok(Some(latest));
                    }
                }
                match failure {
                    RefreshFailure::Permanent => {
                        self.reject(&snapshot.credential);
                        if matches!(reason, RefreshReason::Proactive)
                            && snapshot.credential.is_usable()
                        {
                            Ok(Some(snapshot.credential.clone()))
                        } else {
                            Err(reauthenticate())
                        }
                    }
                    RefreshFailure::Transient
                        if matches!(reason, RefreshReason::Proactive)
                            && snapshot.credential.is_usable() =>
                    {
                        // Codex also keeps an unexpired token usable when proactive
                        // refresh fails temporarily. No credential is discarded or changed.
                        Ok(Some(snapshot.credential.clone()))
                    }
                    RefreshFailure::Transient => Err(ChatGptError::new(
                        "ChatGPT token refresh is temporarily unavailable; retry later",
                    )),
                }
            }
        }
    }
}

fn reauthenticate() -> ChatGptError {
    ChatGptError::new(
        "ChatGPT sign-in is no longer valid; sign in again using the credential manager",
    )
}

#[derive(Deserialize)]
pub(crate) struct RefreshResponse {
    pub(crate) id_token: Option<String>,
    pub(crate) access_token: Option<String>,
    pub(crate) refresh_token: Option<String>,
}

impl Drop for RefreshResponse {
    fn drop(&mut self) {
        self.id_token.zeroize();
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

enum RefreshFailure {
    Permanent,
    Transient,
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    client_id: &'a str,
    grant_type: &'static str,
    refresh_token: &'a str,
}

fn request_refresh(
    client: &dyn OperationClient,
    token: &str,
) -> Result<RefreshResponse, RefreshFailure> {
    let body = serde_json::to_vec(&RefreshRequest {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: token,
    })
    .map_err(|_| RefreshFailure::Transient)?;
    let request = ClientRequest::post(
        "https://auth.openai.com/oauth/token",
        vec![
            HttpHeader::new("Content-Type", "application/json"),
            HttpHeader::new("Accept", "application/json"),
            HttpHeader::new("Originator", "ash"),
            HttpHeader::new("User-Agent", crate::oauth::user_agent()),
        ],
        body,
        RetryPolicy::never(),
    )
    .map_err(|_| RefreshFailure::Transient)?;
    let response = client
        .execute(&request)
        .map_err(|_| RefreshFailure::Transient)?;
    if response.is_success() {
        return serde_json::from_slice(response.body()).map_err(|_| RefreshFailure::Transient);
    }
    // Match Codex's terminal error classification without logging the response body.
    let body: serde_json::Value = serde_json::from_slice(response.body()).unwrap_or_default();
    let code = body
        .pointer("/error/code")
        .or_else(|| body.get("code"))
        .or_else(|| body.get("error"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if response.status() == 401
        || matches!(
            code.as_str(),
            "refresh_token_expired" | "refresh_token_reused" | "refresh_token_invalidated"
        )
        || (response.status() == 400 && code == "invalid_grant")
    {
        Err(RefreshFailure::Permanent)
    } else {
        Err(RefreshFailure::Transient)
    }
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_in(directory: &Path, depth: u8) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(entries) = directory.read_dir() else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        matches!(entry.file_name().to_str(), Some("codex" | "codex.exe")) && executable(&path)
            || path.is_dir() && executable_in(&path, depth - 1)
    })
}

fn codex_installed() -> bool {
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex.bat"]
    } else {
        &["codex"]
    };
    if std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths)
            .any(|dir| names.iter().any(|name| executable(&dir.join(name))))
    }) {
        return true;
    }
    let home = dirs::home_dir();
    #[cfg(target_os = "macos")]
    for root in [
        Some(PathBuf::from("/Applications")),
        home.as_ref().map(|home| home.join("Applications")),
    ]
    .into_iter()
    .flatten()
    {
        for app in ["Codex.app", "ChatGPT.app"] {
            if executable(&root.join(app).join("Contents/Resources/codex")) {
                return true;
            }
        }
    }
    if let Some(home) = home {
        for editor in [".vscode", ".vscode-insiders"] {
            if let Ok(entries) = home.join(editor).join("extensions").read_dir() {
                if entries.flatten().any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("openai.chatgpt-")
                        && executable_in(&entry.path().join("bin"), 4)
                }) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
#[path = "maintenance_tests.rs"]
mod tests;
