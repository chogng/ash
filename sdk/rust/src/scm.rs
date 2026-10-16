//! Source control contributions rendered by the client, with provider-owned callbacks.

use std::collections::BTreeMap;
use std::sync::Arc;

use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde_json::Value;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;

#[derive(Default)]
pub struct SourceControl {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl SourceControl {
    /// Registers the initial snapshot atomically with the callback. Later snapshots use
    /// `Client::update_source_control` and are fenced by this activation's identity.
    pub fn register(
        &mut self,
        id: impl Into<String>,
        providers: Vec<Value>,
        callback: impl Fn(Value, CancellationToken) -> Result<Value, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let id = id.into();
        match self.registrations.entry(id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration::new(
                    RegistrationDescriptor {
                        registration_id: id,
                        kind: RegistrationKind::SourceControl {
                            revision: 1,
                            providers,
                        },
                    },
                    "scm",
                    Arc::new(callback),
                ));
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "source control is already registered",
            )),
        }
    }
}
