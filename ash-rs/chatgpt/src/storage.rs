use crate::credential::TokenCredential;
use crate::credential::TokenResponse;
use crate::oauth::ChatGptError;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use zeroize::Zeroize;
use zeroize::Zeroizing;

const MAX_AUTH_BYTES: u64 = 1024 * 1024;

/// Uses CODEX_HOME when configured, otherwise the user's ~/.codex directory.
pub fn codex_home() -> Result<PathBuf, ChatGptError> {
    if let Some(value) = std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.is_empty())
    {
        return configured_home(Path::new(&value));
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| ChatGptError::new("the user's Codex home is unavailable"))
}

fn configured_home(path: &Path) -> Result<PathBuf, ChatGptError> {
    // Codex requires an explicitly configured home to exist, and canonicalizes it.
    // Its default ~/.codex directory may be absent until the first login.
    if !fs::metadata(path)
        .map_err(|_| ChatGptError::new("CODEX_HOME must point to an existing directory"))?
        .is_dir()
    {
        return Err(ChatGptError::new("CODEX_HOME must point to a directory"));
    }
    path.canonicalize()
        .map_err(|_| ChatGptError::new("CODEX_HOME could not be resolved"))
}

/// Owns Codex-compatible storage and guarded credential updates.
pub(crate) struct CodexAuthStore {
    home: PathBuf,
}

#[derive(Clone, Eq, PartialEq)]
enum CredentialLocation {
    File,
    Keyring(String),
}

pub(crate) struct AuthWriteGuard {
    _file: fs::File,
}

pub(crate) struct AuthSnapshot {
    pub(crate) credential: TokenCredential,
    location: CredentialLocation,
    document: serde_json::Value,
}

impl Drop for AuthSnapshot {
    fn drop(&mut self) {
        clear_json(&mut self.document);
    }
}

fn clear_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => text.zeroize(),
        serde_json::Value::Array(values) => values.iter_mut().for_each(clear_json),
        serde_json::Value::Object(values) => values.values_mut().for_each(clear_json),
        _ => {}
    }
}

impl AuthSnapshot {
    pub(crate) fn refresh_token(&self) -> Option<&str> {
        self.document
            .get("tokens")?
            .get("refresh_token")?
            .as_str()
            .filter(|token| !token.trim().is_empty())
    }
}

#[derive(Clone, Copy)]
pub(crate) enum LoginWrite {
    Create,
    Replace { revision: [u8; 32] },
}

#[derive(Default, Deserialize)]
struct AuthConfig {
    #[serde(default)]
    cli_auth_credentials_store: StoreMode,
    #[serde(default)]
    features: AuthFeatures,
    forced_login_method: Option<String>,
    forced_chatgpt_workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct AuthFeatures {
    #[serde(default = "default_secret_storage")]
    secret_auth_storage: bool,
}

impl Default for AuthFeatures {
    fn default() -> Self {
        Self {
            secret_auth_storage: default_secret_storage(),
        }
    }
}

fn default_secret_storage() -> bool {
    cfg!(windows)
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum StoreMode {
    #[default]
    File,
    Keyring,
    Auto,
    Ephemeral,
}

// Compatibility contract: codex-rs/login/src/auth/storage.rs::AuthDotJson and
// login/src/token_data.rs::TokenData. Read only access/identity data; deliberately
// do not deserialize or retain the stored refresh token.
#[derive(Deserialize)]
struct AuthFile {
    auth_mode: Option<String>,
    last_refresh: Option<String>,
    #[serde(default, rename = "OPENAI_API_KEY", deserialize_with = "is_present")]
    has_api_key: bool,
    #[serde(
        default,
        rename = "personal_access_token",
        deserialize_with = "is_present"
    )]
    has_personal_token: bool,
    #[serde(default, rename = "bedrock_api_key", deserialize_with = "is_present")]
    has_bedrock_key: bool,
    #[serde(
        default,
        rename = "bedrock_access_keys",
        deserialize_with = "is_present"
    )]
    has_bedrock_access_keys: bool,
    tokens: Option<ReadTokens>,
}

fn is_present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Option::<serde::de::IgnoredAny>::deserialize(deserializer).map(|value| value.is_some())
}

#[derive(Deserialize)]
struct ReadTokens {
    #[serde(default, rename = "refresh_token", deserialize_with = "is_present")]
    refresh_available: bool,
    id_token: String,
    access_token: String,
    account_id: Option<String>,
}

impl Drop for ReadTokens {
    fn drop(&mut self) {
        self.id_token.zeroize();
        self.access_token.zeroize();
        self.account_id.zeroize();
    }
}

#[derive(Serialize)]
struct NewAuth<'a> {
    auth_mode: &'static str,
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<&'static str>,
    tokens: NewTokens<'a>,
    last_refresh: String,
}

#[derive(Serialize)]
struct NewTokens<'a> {
    id_token: &'a str,
    access_token: &'a str,
    refresh_token: &'a str,
    account_id: Option<&'a str>,
}

impl CodexAuthStore {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn config(&self) -> Result<AuthConfig, ChatGptError> {
        let Some(bytes) = read_file(&self.home.join("config.toml"))? else {
            return Ok(AuthConfig::default());
        };
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| ChatGptError::new("Codex auth configuration is invalid"))?;
        toml::from_str(text).map_err(|_| ChatGptError::new("Codex auth configuration is invalid"))
    }

    fn read_location(
        &self,
        config: &AuthConfig,
    ) -> Result<(CredentialLocation, Option<Zeroizing<Vec<u8>>>), ChatGptError> {
        match config.cli_auth_credentials_store {
            StoreMode::File => Ok((
                CredentialLocation::File,
                read_file(&self.home.join("auth.json"))?,
            )),
            StoreMode::Ephemeral => Err(ChatGptError::new(
                "Codex uses process-only authentication; it has no reusable local credential",
            )),
            StoreMode::Keyring | StoreMode::Auto => {
                if config.features.secret_auth_storage {
                    return Err(ChatGptError::new(
                        "Codex encrypted auth storage is not supported for read-only reuse",
                    ));
                }
                let canonical = self
                    .home
                    .canonicalize()
                    .unwrap_or_else(|_| self.home.clone());
                let digest = sha2::Sha256::digest(canonical.to_string_lossy().as_bytes());
                let key = format!("cli|{}", &format!("{digest:x}")[..16]);
                let value = ash_keyring_store::read_credential("Codex Auth", &key)
                    .map_err(|_| ChatGptError::new("Codex keyring credentials could not be read; no other credential store was used"))?;
                match value {
                    Some(value) => Ok((
                        CredentialLocation::Keyring(key),
                        Some(Zeroizing::new(value.expose().to_vec())),
                    )),
                    None if config.cli_auth_credentials_store == StoreMode::Auto => Ok((
                        CredentialLocation::File,
                        read_file(&self.home.join("auth.json"))?,
                    )),
                    None => Ok((CredentialLocation::Keyring(key), None)),
                }
            }
        }
    }

    pub(crate) fn load(&self) -> Result<Option<TokenCredential>, ChatGptError> {
        let config = self.config()?;
        let (_, bytes) = self.read_location(&config)?;
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        parse_credential(&bytes, &config).map(Some)
    }

    pub(crate) fn lock_updates(&self) -> Result<AuthWriteGuard, ChatGptError> {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(self.home.join("ash-auth.lock"))
            .map_err(|_| ChatGptError::new("ChatGPT credential update lock is unavailable"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(AuthWriteGuard { _file: file }),
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(_) => {
                    return Err(ChatGptError::new(
                        "another process is updating ChatGPT credentials; retry shortly",
                    ));
                }
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Result<Option<AuthSnapshot>, ChatGptError> {
        let config = self.config()?;
        let (location, bytes) = self.read_location(&config)?;
        let Some(bytes) = bytes else {
            return Ok(None);
        };
        let credential = parse_credential(&bytes, &config)?;
        let document = serde_json::from_slice(&bytes)
            .map_err(|_| ChatGptError::new("Codex credentials are invalid"))?;
        Ok(Some(AuthSnapshot {
            credential,
            location,
            document,
        }))
    }

    fn replace_bytes(
        &self,
        _guard: &AuthWriteGuard,
        expected: &AuthSnapshot,
        bytes: &[u8],
    ) -> Result<(), ChatGptError> {
        let config = self.config()?;
        let (location, current) = self.read_location(&config)?;
        let current = current.ok_or_else(|| {
            ChatGptError::new("ChatGPT credentials were removed during the update")
        })?;
        if location != expected.location
            || <[u8; 32]>::from(sha2::Sha256::digest(&*current))
                != expected.credential.storage_revision
        {
            return Err(ChatGptError::new(
                "ChatGPT credentials changed during the update; the newer record was preserved",
            ));
        }
        match location {
            CredentialLocation::File => {
                let mut temporary = tempfile::NamedTempFile::new_in(&self.home).map_err(|_| {
                    ChatGptError::new("ChatGPT credential update could not be prepared")
                })?;
                temporary
                    .write_all(bytes)
                    .and_then(|_| temporary.as_file().sync_all())
                    .map_err(|_| {
                        ChatGptError::new("ChatGPT credential update could not be written")
                    })?;
                // Recheck after preparing the file, then atomically publish. Codex does
                // not take our lock; preserve every external change already observable.
                let latest = read_file(&self.home.join("auth.json"))?;
                if latest
                    .as_deref()
                    .map(|value| <[u8; 32]>::from(sha2::Sha256::digest(value)))
                    != Some(expected.credential.storage_revision)
                {
                    return Err(ChatGptError::new(
                        "ChatGPT credentials changed before commit; the newer record was preserved",
                    ));
                }
                temporary
                    .persist(self.home.join("auth.json"))
                    .map_err(|_| {
                        ChatGptError::new("ChatGPT credential update could not be committed")
                    })?;
            }
            CredentialLocation::Keyring(key) => ash_keyring_store::write_credential(
                "Codex Auth",
                &key,
                &ash_secrets::SecretValue::new(bytes.to_vec()),
            )
            .map_err(|_| ChatGptError::new("ChatGPT keyring credentials could not be updated"))?,
        }
        Ok(())
    }

    pub(crate) fn save_refresh(
        &self,
        guard: &AuthWriteGuard,
        snapshot: &mut AuthSnapshot,
        response: &mut crate::maintenance::RefreshResponse,
    ) -> Result<TokenCredential, ChatGptError> {
        if let Some(id_token) = &response.id_token {
            let identity = TokenCredential::from_parts(
                id_token,
                snapshot.credential.access_token.clone(),
                None,
            )?;
            if identity.identity()? != snapshot.credential.identity()? {
                return Err(ChatGptError::new(
                    "ChatGPT account changed in the refresh response",
                ));
            }
        }
        let tokens = snapshot
            .document
            .get_mut("tokens")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| ChatGptError::new("ChatGPT token record is missing"))?;
        for (field, value) in [
            ("id_token", &mut response.id_token),
            ("access_token", &mut response.access_token),
            ("refresh_token", &mut response.refresh_token),
        ] {
            if value
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            {
                return Err(ChatGptError::new(
                    "OpenAI returned an empty refreshed token",
                ));
            }
            if let Some(value) = value.take() {
                if let Some(mut previous) = tokens.insert(field.into(), value.into()) {
                    clear_json(&mut previous);
                }
            }
        }
        snapshot.document["last_refresh"] = chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
            .into();
        let encoded = Zeroizing::new(
            serde_json::to_vec_pretty(&snapshot.document)
                .map_err(|_| ChatGptError::new("ChatGPT refresh could not be encoded"))?,
        );
        let credential = parse_credential(&encoded, &self.config()?)?;
        if !credential.is_usable() {
            return Err(ChatGptError::new(
                "OpenAI returned an expired refreshed token",
            ));
        }
        self.replace_bytes(guard, snapshot, &encoded)?;
        Ok(credential)
    }

    pub(crate) fn write_login(
        &self,
        tokens: &TokenResponse,
        write: LoginWrite,
    ) -> Result<TokenCredential, ChatGptError> {
        let LoginWrite::Replace { revision } = write else {
            return self.create(tokens);
        };
        let guard = self.lock_updates()?;
        let snapshot = self
            .snapshot()?
            .ok_or_else(|| ChatGptError::new("ChatGPT credentials were removed during login"))?;
        if snapshot.credential.storage_revision != revision {
            return Err(ChatGptError::new(
                "ChatGPT credentials changed during login; they were not overwritten",
            ));
        }
        let credential =
            TokenCredential::from_parts(&tokens.id_token, tokens.access_token.clone(), None)?;
        validate_account(&self.config()?, &credential)?;
        if !credential.is_usable() || tokens.refresh_token.trim().is_empty() {
            return Err(ChatGptError::new(
                "OpenAI returned unusable ChatGPT credentials",
            ));
        }
        let encoded = encode_new_auth(tokens, &credential)?;
        self.replace_bytes(&guard, &snapshot, &encoded)?;
        parse_credential(&encoded, &self.config()?)
    }

    pub(crate) fn logout(
        &self,
        _guard: &AuthWriteGuard,
        account_id: &str,
    ) -> Result<(), ChatGptError> {
        let Some(snapshot) = self.snapshot()? else {
            return Ok(());
        };
        if snapshot
            .credential
            .account_id
            .as_deref()
            .unwrap_or("current")
            != account_id
        {
            return Err(ChatGptError::new(
                "ChatGPT account changed; its credentials were not removed",
            ));
        }
        match &snapshot.location {
            CredentialLocation::File => {
                let current = read_file(&self.home.join("auth.json"))?;
                if current
                    .as_deref()
                    .map(|value| <[u8; 32]>::from(sha2::Sha256::digest(value)))
                    != Some(snapshot.credential.storage_revision)
                {
                    return Err(ChatGptError::new(
                        "ChatGPT credentials changed before logout",
                    ));
                }
                fs::remove_file(self.home.join("auth.json"))
                    .map_err(|_| ChatGptError::new("ChatGPT credentials could not be removed"))?;
            }
            CredentialLocation::Keyring(key) => {
                ash_keyring_store::delete_credential("Codex Auth", key).map_err(|_| {
                    ChatGptError::new("ChatGPT keyring credentials could not be removed")
                })?;
                // Codex clears the file cache with keyring logout. Only remove a
                // compatible file for this same account, never another auth mode.
                if let Some(bytes) = read_file(&self.home.join("auth.json"))? {
                    if let Ok(file_account) = parse_credential(&bytes, &self.config()?) {
                        if file_account.account_id == snapshot.credential.account_id {
                            fs::remove_file(self.home.join("auth.json")).map_err(|_| {
                                ChatGptError::new("ChatGPT file cache could not be removed")
                            })?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn ensure_creatable(&self) -> Result<(), ChatGptError> {
        let config = self.config()?;
        if config
            .forced_login_method
            .as_deref()
            .is_some_and(|method| method != "chatgpt")
        {
            return Err(ChatGptError::new(
                "Codex configuration does not allow ChatGPT login",
            ));
        }
        if config.cli_auth_credentials_store == StoreMode::Keyring {
            return Err(ChatGptError::new(
                "Codex requires keyring storage; complete the first login in Codex",
            ));
        }
        if self.read_location(&config)?.1.is_some()
            || self.home.join("auth.json").symlink_metadata().is_ok()
        {
            return Err(ChatGptError::new(
                "Codex credentials already exist; Ash will not replace them",
            ));
        }
        Ok(())
    }

    pub(crate) fn create(&self, tokens: &TokenResponse) -> Result<TokenCredential, ChatGptError> {
        let credential =
            TokenCredential::from_parts(&tokens.id_token, tokens.access_token.clone(), None)?;
        if !credential.is_usable() || tokens.refresh_token.trim().is_empty() {
            return Err(ChatGptError::new(
                "OpenAI returned unusable ChatGPT credentials",
            ));
        }
        validate_account(&self.config()?, &credential)?;
        self.ensure_creatable()?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&self.home)
            .map_err(|_| ChatGptError::new("Codex home could not be created"))?;
        let encoded = encode_new_auth(tokens, &credential)?;
        // tempfile creates a 0600 file. persist_noclobber atomically refuses a
        // competing Codex login; no existing auth.json or config is rewritten.
        let mut temporary = tempfile::NamedTempFile::new_in(&self.home)
            .map_err(|_| ChatGptError::new("Codex credential file could not be created"))?;
        temporary
            .write_all(&encoded)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| ChatGptError::new("Codex credential file could not be written"))?;
        self.ensure_creatable()?;
        temporary
            .persist_noclobber(self.home.join("auth.json"))
            .map_err(|_| {
                ChatGptError::new(
                    "Codex credentials could not be created without replacing an existing file",
                )
            })?;
        Ok(credential)
    }
}

fn validate_account(config: &AuthConfig, credential: &TokenCredential) -> Result<(), ChatGptError> {
    if config
        .forced_login_method
        .as_deref()
        .is_some_and(|method| method != "chatgpt")
    {
        return Err(ChatGptError::new(
            "Codex configuration does not allow ChatGPT authentication",
        ));
    }
    if config
        .forced_chatgpt_workspace_id
        .as_deref()
        .is_some_and(|workspace| credential.account_id.as_deref() != Some(workspace))
    {
        return Err(ChatGptError::new(
            "Codex credentials do not match its required ChatGPT workspace",
        ));
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Option<Zeroizing<Vec<u8>>>, ChatGptError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(ChatGptError::new(
                "Codex authentication files could not be read",
            ));
        }
    };
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_AUTH_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ChatGptError::new("Codex authentication files could not be read"))?;
    if bytes.len() as u64 > MAX_AUTH_BYTES {
        return Err(ChatGptError::new(
            "Codex authentication file exceeds the size limit",
        ));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;

fn encode_new_auth(
    tokens: &TokenResponse,
    credential: &TokenCredential,
) -> Result<Zeroizing<Vec<u8>>, ChatGptError> {
    credential.identity()?;
    Ok(Zeroizing::new(
        serde_json::to_vec_pretty(&NewAuth {
            auth_mode: "chatgpt",
            api_key: None,
            tokens: NewTokens {
                id_token: &tokens.id_token,
                access_token: &tokens.access_token,
                refresh_token: &tokens.refresh_token,
                account_id: credential.account_id.as_deref(),
            },
            last_refresh: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
        })
        .map_err(|_| ChatGptError::new("Codex credentials could not be encoded"))?,
    ))
}

fn parse_credential(bytes: &[u8], config: &AuthConfig) -> Result<TokenCredential, ChatGptError> {
    let file: AuthFile = serde_json::from_slice(&bytes)
        .map_err(|_| ChatGptError::new("Codex auth.json is invalid; it was left unchanged"))?;
    // Codex's resolved_mode gives explicit auth_mode precedence; legacy files
    // with other credential material must not silently select ChatGPT tokens.
    let legacy_other_mode = file.auth_mode.is_none()
        && (file.has_api_key
            || file.has_personal_token
            || file.has_bedrock_key
            || file.has_bedrock_access_keys);
    if legacy_other_mode
        || file
            .auth_mode
            .as_deref()
            .is_some_and(|mode| mode != "chatgpt")
    {
        return Err(ChatGptError::new(
            "Codex is not using ChatGPT subscription authentication; switch accounts in Codex",
        ));
    }
    let mut tokens = file.tokens.ok_or_else(|| {
        ChatGptError::new(
            "Codex has no ChatGPT subscription tokens; its credentials were left unchanged",
        )
    })?;
    let mut credential = TokenCredential::from_parts(
        &tokens.id_token,
        std::mem::take(&mut tokens.access_token),
        tokens.account_id.take(),
    )?;
    credential.refresh_available = tokens.refresh_available;
    credential.last_refresh = file
        .last_refresh
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(&value)
                .map(|date| date.timestamp())
                .map_err(|_| ChatGptError::new("Codex last_refresh is invalid"))
        })
        .transpose()?;
    credential.storage_revision = sha2::Sha256::digest(bytes).into();
    validate_account(config, &credential)?;
    Ok(credential)
}
