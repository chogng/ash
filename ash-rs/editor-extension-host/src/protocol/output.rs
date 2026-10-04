use serde::Deserialize;
use serde::Serialize;

use super::PROTOCOL_VERSION;
use super::validation::protocol_error;
use super::validation::validate_encoded_size;
use super::validation::validate_identifier;
use super::validation::validate_short_text;
use crate::ExtensionHostError;
use crate::ExtensionHostLimits;

const MAXIMUM_CHANNEL_LABEL_BYTES: usize = 512;
const MAXIMUM_CATEGORY_BYTES: usize = 128;

/// Correlation-free stale-process fence carried by every unsolicited host event.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEventContext {
    pub protocol_version: u16,
    pub incarnation: u64,
    pub activation_generation: u64,
}

impl HostEventContext {
    pub fn new(incarnation: u64, activation_generation: u64) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            incarnation,
            activation_generation,
        }
    }

    pub fn validate(self) -> Result<(), ExtensionHostError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(protocol_error("unsupported protocol version"));
        }
        if self.incarnation == 0 || self.activation_generation == 0 {
            return Err(protocol_error(
                "event incarnation and activation generation must be non-zero",
            ));
        }
        Ok(())
    }
}

/// Presentation class selected when an extension creates a named Output channel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostOutputChannelKind {
    Output,
    Log,
}

/// Structured severity attached to extension-owned Output entries.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostOutputSeverity {
    Trace,
    Debug,
    Information,
    Warning,
    Error,
    Log,
}

/// Ordered mutation emitted by an extension-owned named Output channel.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation",
    deny_unknown_fields
)]
pub enum HostOutputOperation {
    Create {
        channel_id: String,
        label: String,
        kind: HostOutputChannelKind,
    },
    Append {
        channel_id: String,
        text: String,
        severity: HostOutputSeverity,
        category: Option<String>,
    },
    Replace {
        channel_id: String,
        text: String,
        severity: HostOutputSeverity,
        category: Option<String>,
    },
    Clear {
        channel_id: String,
    },
    Show {
        channel_id: String,
        preserve_focus: bool,
    },
    Dispose {
        channel_id: String,
    },
}

/// Unsolicited, process-fenced Output event carried on the Host RPC stdout stream.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostOutputEvent {
    #[serde(flatten)]
    pub context: HostEventContext,
    #[serde(flatten)]
    pub operation: HostOutputOperation,
}

impl<'de> Deserialize<'de> for ExtensionHostOutputEvent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            protocol_version: u16,
            incarnation: u64,
            activation_generation: u64,
            #[serde(flatten)]
            operation: serde_json::Map<String, serde_json::Value>,
        }
        // Decode the tagged operation separately to preserve strict fields on the flattened wire shape.
        let wire = Wire::deserialize(deserializer)?;
        let operation = serde_json::from_value(serde_json::Value::Object(wire.operation))
            .map_err(serde::de::Error::custom)?;
        Ok(Self {
            context: HostEventContext {
                protocol_version: wire.protocol_version,
                incarnation: wire.incarnation,
                activation_generation: wire.activation_generation,
            },
            operation,
        })
    }
}

impl ExtensionHostOutputEvent {
    pub fn validate(&self, limits: &ExtensionHostLimits) -> Result<(), ExtensionHostError> {
        self.context.validate()?;
        let (channel_id, text, category) = match &self.operation {
            HostOutputOperation::Create {
                channel_id, label, ..
            } => {
                validate_short_text(label, MAXIMUM_CHANNEL_LABEL_BYTES, "Output channel label")?;
                (channel_id, None, None)
            }
            HostOutputOperation::Append {
                channel_id,
                text,
                category,
                ..
            }
            | HostOutputOperation::Replace {
                channel_id,
                text,
                category,
                ..
            } => (channel_id, Some(text), category.as_deref()),
            HostOutputOperation::Clear { channel_id }
            | HostOutputOperation::Show { channel_id, .. }
            | HostOutputOperation::Dispose { channel_id } => (channel_id, None, None),
        };
        validate_identifier(channel_id)?;
        if let Some(text) = text {
            if text.len() > limits.maximum_payload_bytes {
                return Err(ExtensionHostError::QuotaExceeded("Output entry bytes"));
            }
            if text.contains('\0') {
                return Err(protocol_error("Output entry contains a null byte"));
            }
        }
        if let Some(category) = category {
            validate_short_text(category, MAXIMUM_CATEGORY_BYTES, "Output category")?;
        }
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

/// Retained event sequence assigned by the supervisor after process validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SequencedExtensionHostOutputEvent {
    pub sequence: u64,
    pub event: ExtensionHostOutputEvent,
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
