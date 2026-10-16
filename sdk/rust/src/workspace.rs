//! Workspace capability registrations. The host owns saved connections and execution authority.

use std::collections::BTreeMap;
use std::sync::Arc;

use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Deserialize;
use serde::Serialize;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInvocation {
    pub authority: String,
}

/// An existing connection reference; credentials and connection tasks stay with the host.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub connection_name: String,
}

/// Workspace identities confer no filesystem access by themselves.
#[derive(Deserialize)]
pub struct WorkspaceFolder {
    pub uri: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceEvent {
    Workspace {
        workspace_folders: Vec<WorkspaceFolder>,
    },
    Configuration {},
}

#[derive(Default)]
pub struct Workspace {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl Workspace {
    pub fn observe(
        &mut self,
        id: String,
        callback: impl Fn(WorkspaceEvent, CancellationToken) -> Result<(), ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let registration = Registration::new(
            RegistrationDescriptor {
                registration_id: id.clone(),
                kind: RegistrationKind::WorkspaceEvents {},
            },
            "workspaceEvent",
            Arc::new(move |payload, token| {
                let event = serde_json::from_value(payload)
                    .map_err(|_| ExtensionError::invalid_request("invalid workspace event"))?;
                callback(event, token)?;
                Ok(serde_json::Value::Null)
            }),
        );
        if self.registrations.contains_key(&id) {
            return Err(ExtensionError::invalid_request(
                "workspace observer is already registered",
            ));
        }
        self.registrations.insert(id, registration);
        Ok(())
    }

    /// Registers the existing saved-connection capability, distinct from transport resolvers.
    pub fn register_connection_resolver(
        &mut self,
        prefix: impl Into<String>,
        callback: impl Fn(
            ConnectionInvocation,
            CancellationToken,
        ) -> Result<SavedConnection, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let prefix = prefix.into();
        let id = format!("remote:{prefix}");
        let descriptor = RegistrationDescriptor {
            registration_id: id.clone(),
            kind: RegistrationKind::RemoteConnectionResolver {
                authority_prefix: prefix.clone(),
            },
        };
        let handler = Arc::new(move |payload, token| {
            let invocation: ConnectionInvocation = serde_json::from_value(payload)
                .map_err(|_| ExtensionError::invalid_request("invalid connection invocation"))?;
            if !invocation.authority.starts_with(&format!("{prefix}+"))
                || invocation.authority.len() <= prefix.len() + 1
                || invocation.authority.len() > 2048
                || invocation.authority.chars().any(char::is_control)
            {
                return Err(ExtensionError::invalid_request(
                    "connection authority has the wrong prefix",
                ));
            }
            serde_json::to_value(callback(invocation, token)?)
                .map_err(|_| ExtensionError::invalid_request("invalid connection reference"))
        });
        match self.registrations.entry(id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration::new(descriptor, "resolveConnection", handler));
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "connection resolver is already registered",
            )),
        }
    }
}
