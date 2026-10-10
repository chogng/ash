//! Public typed capability callbacks on the existing extension transport.

use crate::CancellationToken;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;
use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Activation-owned channels. Each channel has a closed request and response type.
#[derive(Default)]
pub struct DataChannels {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl DataChannels {
    pub fn register<Req, Res>(
        &mut self,
        id: impl Into<String>,
        callback: impl Fn(Req, CancellationToken) -> Result<Res, ExtensionError> + Send + Sync + 'static,
    ) -> Result<(), ExtensionError>
    where
        Req: DeserializeOwned,
        Res: Serialize,
    {
        let id = id.into();
        if self.registrations.contains_key(&id) {
            return Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "channel is already registered",
            ));
        }
        let descriptor = RegistrationDescriptor {
            registration_id: id.clone(),
            kind: RegistrationKind::DataChannel {
                channel_id: id.clone(),
            },
        };
        self.registrations.insert(
            id,
            Registration {
                descriptor,
                operation: "receiveData",
                handler: Arc::new(move |payload, token| {
                    let request = serde_json::from_value(payload).map_err(|_| {
                        ExtensionError::invalid_request("invalid capability request")
                    })?;
                    serde_json::to_value(callback(request, token)?).map_err(|_| {
                        ExtensionError::new(HostErrorCode::Internal, "invalid capability response")
                    })
                }),
            },
        );
        Ok(())
    }
}
