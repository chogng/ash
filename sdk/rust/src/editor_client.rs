//! Document-client declarations carried by the existing typed DataChannel transport.

use std::collections::BTreeSet;

use crate::ExtensionError;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;

/// DataChannel ID for describing a package-owned document editor client.
pub const DOCUMENT_CLIENT_CHANNEL: &str = "editor.client.v1";

/// The closed set of operations accepted by the document-client v1 channel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DescribeClientOperation {
    /// Return the client module and localized editor declarations.
    Describe,
}

/// A client description request; labels must follow this initiating client's language.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DescribeClientRequest {
    pub operation: DescribeClientOperation,
    #[serde(deserialize_with = "deserialize_language")]
    pub language: String,
}

fn deserialize_language<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let language = String::deserialize(deserializer)?;
    if !valid_text(&language, 64) {
        return Err(serde::de::Error::custom("invalid client language"));
    }
    Ok(language)
}

/// One document editor profile exported by the package's client module.
///
/// Selectors are filename glob patterns; an empty list permits MIME-only selection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentClientEditor {
    pub editor_id: String,
    pub display_name: String,
    pub document_type: String,
    pub content_type: String,
    pub selectors: Vec<String>,
}

/// Versioned declaration returned through [`DOCUMENT_CLIENT_CHANNEL`].
///
/// Construction validates author-supplied declarations, not package admission: the host
/// still verifies the module digest and package ownership before executing client code.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentClientContribution {
    version: u8,
    pub client_module: String,
    pub client_digest: String,
    pub editors: Vec<DocumentClientEditor>,
}

impl DocumentClientContribution {
    /// Bind a v1 declaration to a package-relative module and lowercase SHA-256 digest.
    ///
    /// Rejects unsafe paths, malformed digests, duplicate editor IDs, and declarations
    /// exceeding the v1 text or collection bounds with `HostErrorCode::InvalidRequest`.
    /// Text bounds are UTF-8 byte counts. Public fields remain author-owned; mutations
    /// after construction must preserve the same contract.
    pub fn new(
        module: impl Into<String>,
        digest: impl Into<String>,
        editors: Vec<DocumentClientEditor>,
    ) -> Result<Self, ExtensionError> {
        let client_module = module.into();
        let client_digest = digest.into();
        if !valid_text(&client_module, 512)
            || client_module.contains(['\\', ':'])
            || client_module
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ExtensionError::invalid_request(
                "client module must be a package-relative path",
            ));
        }
        if !client_digest.strip_prefix("sha256:").is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(ExtensionError::invalid_request("invalid client digest"));
        }
        if editors.is_empty() || editors.len() > 32 {
            return Err(ExtensionError::invalid_request(
                "client must declare between 1 and 32 editors",
            ));
        }
        let mut ids = BTreeSet::new();
        for editor in &editors {
            if !valid_text(&editor.editor_id, 256)
                || !ids.insert(editor.editor_id.as_str())
                || !valid_text(&editor.display_name, 512)
                || !valid_text(&editor.document_type, 256)
                || !valid_text(&editor.content_type, 256)
                || editor.selectors.len() > 64
                || editor.selectors.iter().any(|value| !valid_text(value, 512))
            {
                return Err(ExtensionError::invalid_request(
                    "invalid or duplicate client editor declaration",
                ));
            }
        }
        Ok(Self {
            version: 1,
            client_module,
            client_digest,
            editors,
        })
    }
}

fn valid_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "editor_client_tests.rs"]
mod tests;
