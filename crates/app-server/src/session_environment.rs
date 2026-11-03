//! Session-scoped child-process overrides backed by the execution host's secret store.
use ash_protocol::SessionId;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use core_api::CoreError;
use exec_server::execution::CommandEnvironment;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

#[derive(Default)]
pub(crate) struct SessionEnvironments {
    store: OnceLock<Arc<dyn SecretStore>>,
    writes: Mutex<()>,
}

impl SessionEnvironments {
    pub(crate) fn bind(&self, store: Arc<dyn SecretStore>) {
        assert!(
            self.store.set(store).is_ok(),
            "profile secret store bound twice"
        );
    }

    fn key(session_id: &SessionId) -> Result<SecretKey, CoreError> {
        SecretKey::new(format!("session.environment.v1:{}", session_id.as_str()))
            .map_err(|_| storage_error())
    }

    pub(crate) fn validate(&self, values: &BTreeMap<String, String>) -> Result<(), CoreError> {
        let mut names = std::collections::BTreeSet::new();
        let invalid = values.len() > 256
            || values
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>()
                > 128 * 1024
            || values.iter().any(|(name, value)| {
                let mut bytes = name.bytes();
                let upper = name.to_ascii_uppercase();
                !bytes
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                    || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    || name.len() > 256
                    || value.len() > 32 * 1024
                    || value.contains('\0')
                    || (cfg!(windows) && !names.insert(upper.clone()))
                    || upper == "AI_AGENT"
                    || upper.starts_with("ASH_")
                    || upper.starts_with("DYLD_")
                    || upper.starts_with("LD_")
                    || matches!(
                        upper.as_str(),
                        "TMPDIR"
                            | "TMP"
                            | "TEMP"
                            | "HTTP_PROXY"
                            | "HTTPS_PROXY"
                            | "ALL_PROXY"
                            | "NO_PROXY"
                    )
            });
        if invalid {
            return Err(CoreError::InvalidInput(
                "Session environment variables contain invalid or reserved entries".into(),
            ));
        }
        if !values.is_empty() {
            self.store
                .get()
                .ok_or_else(storage_error)?
                .check_availability()
                .map_err(|_| storage_error())?;
        }
        Ok(())
    }

    fn profile_key(id: &str) -> Result<SecretKey, CoreError> {
        let uuid = id
            .strip_prefix("sessions.environment.profile.")
            .filter(|uuid| {
                uuid.len() == 36
                    && uuid.bytes().enumerate().all(|(index, byte)| {
                        if matches!(index, 8 | 13 | 18 | 23) {
                            byte == b'-'
                        } else {
                            byte.is_ascii_hexdigit()
                        }
                    })
            })
            .ok_or_else(|| {
                CoreError::InvalidInput("Invalid Session environment profile ID".into())
            })?;
        SecretKey::new(format!("profile.session-environment.v1:{uuid}"))
            .map_err(|_| storage_error())
    }

    pub(crate) fn save_profile(
        &self,
        id: &str,
        values: &BTreeMap<String, String>,
    ) -> Result<(), CoreError> {
        let key = Self::profile_key(id)?;
        self.validate(values)?;
        let store = self.store.get().ok_or_else(storage_error)?;
        let encoded = serde_json::to_vec(values).map_err(|_| storage_error())?;
        store
            .store(&key, &SecretValue::new(encoded))
            .map_err(|_| storage_error())
    }

    pub(crate) fn read_profile(
        &self,
        id: &str,
    ) -> Result<Option<BTreeMap<String, String>>, CoreError> {
        let key = Self::profile_key(id)?;
        let store = self.store.get().ok_or_else(storage_error)?;
        store
            .load(&key)
            .map_err(|_| storage_error())?
            .map(|secret| serde_json::from_slice(secret.expose()).map_err(|_| storage_error()))
            .transpose()
    }

    pub(crate) fn install(
        &self,
        session_id: &SessionId,
        requested: Option<BTreeMap<String, String>>,
    ) -> Result<(), CoreError> {
        let Some(store) = self.store.get() else {
            return if requested.is_some() {
                Err(storage_error())
            } else {
                Ok(())
            };
        };
        let _guard = self.writes.lock().map_err(|_| storage_error())?;
        let key = Self::key(session_id)?;
        let requested = requested.filter(|values| !values.is_empty());
        if let Some(existing) = store.load(&key).map_err(|_| storage_error())? {
            let existing: BTreeMap<String, String> =
                serde_json::from_slice(existing.expose()).map_err(|_| storage_error())?;
            return if requested.as_ref() == Some(&existing) {
                Ok(())
            } else {
                Err(CoreError::CommandConflict)
            };
        }
        if let Some(values) = requested {
            let encoded = serde_json::to_vec(&values).map_err(|_| storage_error())?;
            store
                .store(&key, &SecretValue::new(encoded))
                .map_err(|_| storage_error())?;
        }
        Ok(())
    }

    pub(crate) fn load(
        &self,
        session_id: Option<&SessionId>,
    ) -> Result<CommandEnvironment, CoreError> {
        let (Some(store), Some(session_id)) = (self.store.get(), session_id) else {
            return Ok(CommandEnvironment::default());
        };
        let Some(value) = store
            .load(&Self::key(session_id)?)
            .map_err(|_| storage_error())?
        else {
            return Ok(CommandEnvironment::default());
        };
        serde_json::from_slice(value.expose())
            .map(CommandEnvironment)
            .map_err(|_| storage_error())
    }

    pub(crate) fn delete(&self, session_id: &SessionId) -> Result<(), CoreError> {
        if let Some(store) = self.store.get() {
            store
                .delete(&Self::key(session_id)?)
                .map_err(|_| storage_error())?;
        }
        Ok(())
    }
}

fn storage_error() -> CoreError {
    CoreError::Execution("Session environment secret storage is unavailable".into())
}

#[cfg(test)]
#[path = "session_environment_tests.rs"]
mod tests;
