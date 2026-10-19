//! Academy registers optional editor capabilities. Documents and history stay client-owned.

use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use serde::Deserialize;
use serde::Serialize;

/// A product-owned client component is selected through the shared extension transport.
/// Its independently built module requires verified package admission before client execution.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: Operation,
    language: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Operation {
    Describe,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Editor {
    editor_id: &'static str,
    display_name: String,
    selectors: &'static [&'static str],
    document_type: &'static str,
    content_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contribution {
    version: u8,
    client_module: &'static str,
    client_digest: &'static str,
    editors: Vec<Editor>,
}

pub struct AcademyExtension;

impl Extension for AcademyExtension {
    fn id(&self) -> &str {
        "ash.academic"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let english: serde_json::Value = serde_json::from_str(include_str!("../package.nls.json"))
            .map_err(|_| {
                ExtensionError::new(HostErrorCode::InvalidRequest, "Invalid Academy messages")
            })?;
        let chinese: serde_json::Value =
            serde_json::from_str(include_str!("../package.nls.zh-CN.json")).map_err(|_| {
                ExtensionError::new(HostErrorCode::InvalidRequest, "Invalid Academy messages")
            })?;
        context
            .data_channels
            .register("editor.client.v1", move |request: Request, token| {
                token.check_cancelled()?;
                let Request {
                    operation: Operation::Describe,
                    language,
                } = request;
                if language.is_empty() || language.len() > 64 {
                    return Err(ExtensionError::new(
                        HostErrorCode::InvalidRequest,
                        "Invalid client language",
                    ));
                }
                // The process can serve multiple windows; labels follow the initiating client.
                let messages = if language == "zh-CN" {
                    &chinese
                } else {
                    &english
                };
                let label = |key: &str| {
                    messages[key].as_str().map(str::to_owned).ok_or_else(|| {
                        ExtensionError::new(
                            HostErrorCode::InvalidRequest,
                            "Missing Academy editor label",
                        )
                    })
                };
                Ok(Contribution {
                    version: 1,
                    client_module: "dist/editor.js",
                    client_digest: env!("ASH_EDITOR_CLIENT_DIGEST"),
                    editors: vec![
                        Editor {
                            editor_id: "stanza.editor.document",
                            display_name: label("academic.editor")?,
                            selectors: &["*.ash-academic", "*.ash-paper"],
                            document_type: "academic",
                            content_type: "application/vnd.ash.academic-document+json",
                        },
                        Editor {
                            editor_id: "ash.editor.document",
                            display_name: label("academic.generalEditor")?,
                            selectors: &["*.ash-doc"],
                            document_type: "general",
                            content_type: "application/vnd.ash.document+json",
                        },
                        Editor {
                            editor_id: "ash.collaboration.notes",
                            display_name: label("academic.channelNotes")?,
                            selectors: &[],
                            document_type: "ash.collaboration.notes",
                            content_type: "application/vnd.ash.channel-notes+json",
                        },
                    ],
                })
            })
    }
}
