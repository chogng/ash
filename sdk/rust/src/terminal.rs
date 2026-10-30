//! Activation-owned terminal environment contributions.
use crate::CancellationToken;
use crate::ExtensionError;
use crate::Registration;
use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

/// A terminal owned by this activation; user closure is reported by `read_terminal`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalHandle {
    pub id: String,
}

/// Bounded output since the caller's cursor, including closure without new output.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalRead {
    pub output: String,
    pub next_sequence: u64,
    pub output_gap: bool,
    pub closed: bool,
}

#[derive(Default)]
pub struct Terminal {
    pub(crate) registrations: BTreeMap<String, Registration>,
}
impl Terminal {
    /// The terminal owner requests a fresh, nonpersistent environment when creating a shell.
    /// Removing the provider retires its collection rather than persisting broker credentials.
    pub fn register_environment(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(CancellationToken) -> Result<Value, ExtensionError> + Send + Sync + 'static,
    ) -> Result<(), ExtensionError> {
        let id = id.into();
        if self.registrations.contains_key(&id) {
            return Err(ExtensionError::invalid_request(
                "terminal environment is already registered",
            ));
        }
        self.registrations.insert(
            id.clone(),
            Registration::new(
                RegistrationDescriptor {
                    registration_id: id,
                    kind: RegistrationKind::TerminalEnvironment {},
                },
                "getTerminalEnvironment",
                Arc::new(move |_, token| callback(token)),
            ),
        );
        Ok(())
    }
}
