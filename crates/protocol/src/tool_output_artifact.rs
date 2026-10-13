//! Inert files and structured data returned by a tool, retained with their exact readable bytes.

use crate::ContentDigest;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Origin allowlists declared by one MCP App resource and validated by its provider boundary.
/// Empty lists preserve the isolated view's default denial of external access.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpAppResourceCsp {
    #[serde(default)]
    pub connect_domains: Vec<String>,
    #[serde(default)]
    pub resource_domains: Vec<String>,
    #[serde(default)]
    pub frame_domains: Vec<String>,
    #[serde(default)]
    pub base_uri_domains: Vec<String>,
}

/// Distinguishes a server-provided resource identity from a structured result without inventing a URI.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolOutputArtifactSource {
    EmbeddedResource { uri: String },
    ResourceLink { uri: String },
    McpApp { uri: String },
    StructuredResult,
    ViewMetadata,
}

/// The complete or explicitly truncated data carried by one tool artifact.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolOutputArtifactData {
    Text {
        text: String,
    },
    Binary {
        #[schemars(length(max = 262_144))]
        bytes: Vec<u8>,
    },
    Json {
        json: String,
    },
}

/// One inert artifact in canonical tool output. Its URI is descriptive and grants no file access.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputArtifact {
    pub source: ToolOutputArtifactSource,
    pub mime_type: String,
    pub data: ToolOutputArtifactData,
    pub content_digest: ContentDigest,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub app_csp: Option<McpAppResourceCsp>,
    /// Original resource metadata for interactive consumers; never included in model text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resource_metadata: Option<String>,
}

impl ToolOutputArtifact {
    /// Constructs a snapshot from already normalized output, hashing the exact readable bytes.
    pub fn new(
        source: ToolOutputArtifactSource,
        mime_type: String,
        data: ToolOutputArtifactData,
    ) -> Self {
        let bytes = match &data {
            ToolOutputArtifactData::Text { text } => text.as_bytes().to_vec(),
            ToolOutputArtifactData::Binary { bytes } => bytes.clone(),
            ToolOutputArtifactData::Json { json } => json.as_bytes().to_vec(),
        };
        Self {
            source,
            mime_type,
            data,
            content_digest: ContentDigest::sha256(&bytes),
            truncated: false,
            app_csp: None,
            resource_metadata: None,
        }
    }

    /// Exposes text to models without embedding binary data or executing document contents.
    pub fn model_text(&self) -> String {
        if matches!(
            self.source,
            ToolOutputArtifactSource::McpApp { .. } | ToolOutputArtifactSource::ViewMetadata
        ) {
            return String::new();
        }
        match &self.data {
            ToolOutputArtifactData::Text { text } => match &self.source {
                ToolOutputArtifactSource::EmbeddedResource { uri } | ToolOutputArtifactSource::ResourceLink { uri } => serde_json::json!({ "uri": uri, "mimeType": self.mime_type, "text": text, "truncated": self.truncated }).to_string(),
                ToolOutputArtifactSource::StructuredResult => text.clone(),
                ToolOutputArtifactSource::McpApp { .. } | ToolOutputArtifactSource::ViewMetadata => String::new(),
            },
            ToolOutputArtifactData::Json { json } => json.clone(),
            ToolOutputArtifactData::Binary { bytes } => serde_json::json!({
                "source": self.source,
                "mimeType": self.mime_type,
                "byteLength": bytes.len(),
            })
            .to_string(),
        }
    }

    /// Replaces only model-visible text when an output budget truncates this snapshot.
    pub fn truncated_text(&self, text: String) -> Self {
        let mut artifact = Self::new(
            self.source.clone(),
            self.mime_type.clone(),
            ToolOutputArtifactData::Text { text },
        );
        artifact.truncated = true;
        artifact.resource_metadata = self.resource_metadata.clone();
        artifact.app_csp = self.app_csp.clone();
        artifact
    }
}
