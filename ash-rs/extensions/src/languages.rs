use std::collections::BTreeMap;
use std::sync::Arc;

use extension_protocol::LanguageProviderOperation;
use extension_protocol::RegistrationDescriptor;
use extension_protocol::RegistrationKind;
use serde::Deserialize;
use serde::Serialize;

use crate::CancellationToken;
use crate::ExtensionError;
use crate::Handler;
use crate::HostErrorCode;
use crate::Registration;

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
                language_ids,
                operations: vec![LanguageProviderOperation::Hover],
            },
        };
        match self.registrations.entry(id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Registration {
                    descriptor,
                    operation: "hover",
                    handler,
                });
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(ExtensionError::new(
                HostErrorCode::ActivationFailed,
                "language provider is already registered",
            )),
        }
    }
}
