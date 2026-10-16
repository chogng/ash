//! Custom text editor providers. The client retains the document, history and webview.

use std::collections::BTreeMap;
use std::sync::Arc;

use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::HostErrorCode;
use crate::Registration;

/// A versioned view of a client-owned document, including its current readonly policy.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub uri: String,
    pub version: u64,
    pub language_id: String,
    pub text: String,
    #[serde(default)]
    pub read_only: bool,
}

/// Resources are package-relative paths resolved by the host for this provider's package.
#[derive(Clone, Serialize)]
pub struct Resources {
    pub script: String,
    pub style: String,
}

/// Initial HTML and optional live content. Large documents belong in `update`, once.
#[derive(Serialize)]
pub struct Content {
    pub html: String,
    /// Live previews receive updates without accepting document edits.
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Resources>,
}

/// Custom editors registered atomically during activation and released on deactivation.
#[derive(Default)]
pub struct Editors {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl Editors {
    pub fn register_custom_text_editor(
        &mut self,
        view_type: String,
        display_name: String,
        selectors: Vec<String>,
        priority: String,
        callback: impl Fn(TextDocument, CancellationToken) -> Result<Content, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        #[derive(Deserialize)]
        struct Request {
            document: TextDocument,
        }
        let registration = Registration {
            descriptor: RegistrationDescriptor {
                registration_id: view_type.clone(),
                kind: RegistrationKind::CustomTextEditor {
                    view_type: view_type.clone(),
                    display_name,
                    selectors,
                    priority,
                },
            },
            operation: "resolveCustomTextEditor".into(),
            handler: Arc::new(move |payload, token| {
                let request: Request = serde_json::from_value(payload)
                    .map_err(|_| ExtensionError::invalid_request("invalid editor document"))?;
                if request.document.version == 0 || request.document.uri.is_empty() {
                    return Err(ExtensionError::invalid_request(
                        "invalid editor document identity",
                    ));
                }
                serde_json::to_value(callback(request.document, token)?).map_err(|_| {
                    ExtensionError::new(
                        HostErrorCode::Internal,
                        "editor content could not be encoded",
                    )
                })
            }),
        };
        match self.registrations.entry(view_type) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(registration);
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "custom editor is already registered",
            )),
        }
    }
}
