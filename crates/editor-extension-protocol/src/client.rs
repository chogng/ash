use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::ProtocolError;
use crate::ProtocolLimits;
use crate::RequestContext;
use crate::validation::validate_encoded_size;

/// Calls are bound to an existing invocation, never to an arbitrary active window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionClientRequest {
    pub context: RequestContext,
    pub call_id: u64,
    pub operation: ExtensionClientOperation,
}

impl ExtensionClientRequest {
    pub fn validate(&self, limits: &ProtocolLimits) -> Result<(), ProtocolError> {
        self.context.validate()?;
        if self.call_id == 0 {
            return Err(ProtocolError::InvalidProtocol(
                "client call ID must be non-zero".into(),
            ));
        }
        validate_encoded_size(&self.operation, limits.maximum_payload_bytes)?;
        if let ExtensionClientOperation::OpenRemoteConnection { authority } = &self.operation {
            let valid = authority.split_once('+').is_some_and(|(prefix, target)| {
                !prefix.is_empty()
                    && prefix.len() <= 64
                    && prefix.as_bytes()[0].is_ascii_lowercase()
                    && prefix.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
                    && !target.is_empty()
            });
            if !valid
                || authority.len() > 2048
                || authority.bytes().any(|byte| byte <= 32 || byte == 127)
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid Remote connection authority".into(),
                ));
            }
        }
        if let ExtensionClientOperation::SetStatusBarEntries {
            registration_id,
            revision,
            entries,
        } = &self.operation
        {
            crate::validation::validate_identifier(registration_id)?;
            crate::statusbar::validate_entries(*revision, entries)?;
        }
        if let ExtensionClientOperation::SetDiagnostics {
            collection,
            entries,
        } = &self.operation
        {
            if collection.is_empty() || collection.len() > 256 || entries.len() > 1024 {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid diagnostic collection".into(),
                ));
            }
            let mut resources = std::collections::BTreeSet::new();
            let mut count = 0;
            for entry in entries {
                if entry.uri.is_empty()
                    || entry.uri.len() > 8192
                    || !resources.insert(&entry.uri)
                    || entry.version == Some(0)
                {
                    return Err(ProtocolError::InvalidProtocol(
                        "invalid diagnostic resource or version".into(),
                    ));
                }
                count += entry.diagnostics.len();
                for diagnostic in &entry.diagnostics {
                    if diagnostic.message.is_empty()
                        || (diagnostic.start.line, diagnostic.start.character)
                            > (diagnostic.end.line, diagnostic.end.character)
                    {
                        return Err(ProtocolError::InvalidProtocol(
                            "invalid diagnostic message or range".into(),
                        ));
                    }
                }
            }
            if count > 10_000 {
                return Err(ProtocolError::QuotaExceeded("diagnostics"));
            }
        }
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

/// Editor operations available to executable extensions. Documents, undo and UI remain client-owned.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation",
    deny_unknown_fields
)]
pub enum ExtensionClientOperation {
    /// The initiating client confirms the saved target before handing it to the connection host.
    OpenRemoteConnection {
        authority: String,
    },
    SetStatusBarEntries {
        registration_id: String,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        revision: u64,
        entries: Vec<crate::ExtensionStatusBarEntry>,
    },
    ExecuteCommand {
        command: String,
        arguments: Vec<Value>,
    },
    ReadDocument {
        uri: String,
    },
    /// Workspace-relative disk read. The App Server filesystem owner handles this, never the renderer.
    ReadWorkspaceFile {
        path: String,
    },
    ListDocuments,
    /// Replaces only this extension incarnation's named diagnostic collection.
    SetDiagnostics {
        collection: String,
        entries: Vec<ExtensionDiagnosticEntry>,
    },
    ApplyEdit {
        documents: Vec<ExtensionDocumentEdit>,
    },
    ReadConfiguration {
        section: String,
        resource: Option<String>,
    },
    UpdateConfiguration {
        section: String,
        value: Value,
        target: ExtensionConfigurationTarget,
    },
    ShowMessage {
        message: String,
        severity: ExtensionMessageSeverity,
    },
    ShowQuickPick {
        items: Vec<String>,
        placeholder: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionConfigurationTarget {
    User,
    Workspace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionMessageSeverity {
    Information,
    Warning,
    Error,
}

/// Zero-based UTF-16 edit coordinates.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionTextPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionTextEdit {
    pub start: ExtensionTextPosition,
    pub end: ExtensionTextPosition,
    pub text: String,
}

/// The version is mandatory: an extension cannot overwrite edits made since its snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDocumentEdit {
    pub uri: String,
    pub version: u32,
    pub edits: Vec<ExtensionTextEdit>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDocumentSnapshot {
    pub uri: String,
    pub version: u32,
    pub language_id: String,
    pub text: String,
}

/// Diagnostics carry the observed document version so old callbacks cannot mark newer text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDiagnosticEntry {
    pub uri: String,
    pub version: Option<u32>,
    pub diagnostics: Vec<ExtensionDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDiagnostic {
    pub start: ExtensionTextPosition,
    pub end: ExtensionTextPosition,
    pub message: String,
    pub severity: ExtensionDiagnosticSeverity,
    pub source: Option<String>,
    pub code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionDiagnosticSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "result",
    deny_unknown_fields
)]
pub enum ExtensionClientResult {
    Command {
        value: Value,
    },
    Document {
        document: ExtensionDocumentSnapshot,
    },
    File {
        text: String,
    },
    Documents {
        documents: Vec<ExtensionDocumentSnapshot>,
    },
    Applied {
        applied: bool,
    },
    Configuration {
        value: Value,
    },
    Selection {
        index: Option<u32>,
    },
    Done,
}

/// This is a response to a child call, not a new host invocation or an event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionClientResponse {
    pub context: RequestContext,
    pub call_id: u64,
    pub outcome: Result<ExtensionClientResult, crate::HostFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ExtensionHostStdinFrame {
    Request(crate::ExtensionHostRequest),
    ClientResponse(ExtensionClientResponse),
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
