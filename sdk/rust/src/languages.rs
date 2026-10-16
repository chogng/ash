use std::collections::BTreeMap;
use std::sync::Arc;

use external_ext_protocol::LanguageProviderOperation;
use external_ext_protocol::RegistrationDescriptor;
use external_ext_protocol::RegistrationKind;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::Handler;
use crate::HostErrorCode;
use crate::Registration;

pub use external_ext_protocol::LanguageProviderOperation as Operation;

/// Client-owned document observations used as immutable analysis input.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocumentEvent {
    Open {
        document: crate::client::DocumentSnapshot,
    },
    Change {
        document: crate::client::DocumentSnapshot,
    },
    Close {
        document: crate::client::DocumentSnapshot,
    },
}

/// Zero-based UTF-16 position, matching VS Code's public `Position` semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    #[serde(rename = "lineIndex")]
    pub line: u32,
    #[serde(rename = "columnIndex")]
    pub character: u32,
}

impl Position {
    pub fn new(line: u32, character: u32) -> Self {
        Self { line, character }
    }
}

/// Ordered, half-open range of zero-based UTF-16 positions.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    /// Like VS Code's Range constructor, normalize reversed endpoints into document order.
    pub fn new(start: Position, end: Position) -> Self {
        if start <= end {
            Self { start, end }
        } else {
            Self {
                start: end,
                end: start,
            }
        }
    }
}

/// Exact frontend document snapshot. The frontend remains the owner of edits and dirty state.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    #[serde(rename = "resource")]
    pub uri: Option<String>,
    pub language_id: String,
    pub version: u64,
    pub text: String,
}

impl TextDocument {
    pub fn get_text(&self) -> &str {
        &self.text
    }
}

/// Contents accepted by the editor hover bridge: Markdown text or a language-tagged code block.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MarkedString {
    Markdown(String),
    Code { language: String, value: String },
}

/// Hover result corresponding to VS Code's contents and optional range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Hover {
    pub contents: Vec<MarkedString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

/// Language registrations owned by the current activation, using the existing editor broker.
#[derive(Default)]
pub struct Languages {
    pub(crate) registrations: BTreeMap<String, Registration>,
}

impl Languages {
    pub fn observe_documents(
        &mut self,
        id: String,
        callback: impl Fn(DocumentEvent, CancellationToken) -> Result<(), ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        let registration = Registration::new(
            RegistrationDescriptor {
                registration_id: id.clone(),
                kind: RegistrationKind::TextDocumentEvents {},
            },
            "documentEvent",
            Arc::new(move |payload, token| {
                let event = serde_json::from_value(payload)
                    .map_err(|_| ExtensionError::invalid_request("invalid document event"))?;
                callback(event, token)?;
                Ok(serde_json::Value::Null)
            }),
        );
        if self.registrations.contains_key(&id) {
            return Err(ExtensionError::invalid_request(
                "document observer is already registered",
            ));
        }
        self.registrations.insert(id, registration);
        Ok(())
    }

    /// Registers one typed language operation. Payload decoding stays at the SDK boundary;
    /// document identity and operation-specific constraints belong to the provider.
    pub fn register_provider<Request, Response>(
        &mut self,
        registration_id: String,
        language_ids: Vec<String>,
        operation: Operation,
        completion_trigger_characters: Vec<String>,
        callback: impl Fn(Request, CancellationToken) -> Result<Response, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError>
    where
        Request: DeserializeOwned,
        Response: Serialize,
    {
        let operation_name = serde_json::to_value(operation)
            .map_err(|_| ExtensionError::invalid_request("invalid language operation"))?;
        let registration = Registration::new(
            RegistrationDescriptor {
                registration_id: registration_id.clone(),
                kind: RegistrationKind::LanguageProvider {
                    language_ids,
                    operations: vec![operation],
                    completion_trigger_characters,
                },
            },
            operation_name
                .as_str()
                .ok_or_else(|| ExtensionError::invalid_request("invalid language operation"))?,
            Arc::new(move |payload, token| {
                let request = serde_json::from_value(payload)
                    .map_err(|_| ExtensionError::invalid_request("invalid language request"))?;
                serde_json::to_value(callback(request, token)?).map_err(|_| {
                    ExtensionError::new(
                        HostErrorCode::Internal,
                        "language result could not be encoded",
                    )
                })
            }),
        );
        match self.registrations.entry(registration_id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(registration);
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "language provider is already registered",
            )),
        }
    }

    pub fn register_hover_provider(
        &mut self,
        registration_id: impl Into<String>,
        language_ids: Vec<String>,
        callback: impl Fn(
            TextDocument,
            Position,
            CancellationToken,
        ) -> Result<Option<Hover>, ExtensionError>
        + Send
        + Sync
        + 'static,
    ) -> Result<(), ExtensionError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            language_id: String,
            version: u64,
            text: String,
            resource: Option<String>,
            position: Position,
        }
        let id = registration_id.into();
        let selector = language_ids.clone();
        let handler: Handler = Arc::new(move |payload, token| {
            let request: Request = serde_json::from_value(payload)
                .map_err(|_| ExtensionError::invalid_request("invalid hover document snapshot"))?;
            if request.version == 0 || !selector.contains(&request.language_id) {
                return Err(ExtensionError::invalid_request(
                    "hover snapshot does not match its language selector or version",
                ));
            }
            let document = TextDocument {
                uri: request.resource,
                language_id: request.language_id,
                version: request.version,
                text: request.text,
            };
            let line = document
                .text
                .split('\n')
                .nth(request.position.line as usize)
                .ok_or_else(|| {
                    ExtensionError::invalid_request("hover position is outside the document")
                })?;
            let line = line.strip_suffix('\r').unwrap_or(line);
            if request.position.character as usize > line.encode_utf16().count() {
                return Err(ExtensionError::invalid_request(
                    "hover position is outside the document",
                ));
            }
            serde_json::to_value(callback(document, request.position, token)?).map_err(|_| {
                ExtensionError::new(HostErrorCode::Internal, "hover result could not be encoded")
            })
        });
        let descriptor = RegistrationDescriptor {
            registration_id: id.clone(),
            kind: RegistrationKind::LanguageProvider {
                completion_trigger_characters: Vec::new(),
                language_ids,
                operations: vec![LanguageProviderOperation::Hover],
            },
        };
        match self.registrations.entry(id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration::new(descriptor, "hover", handler));
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "language provider is already registered",
            )),
        }
    }
}
