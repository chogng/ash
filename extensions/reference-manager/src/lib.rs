//! Reference library resources stay client-owned; the SDK runtime describes their editor.

use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use serde::Deserialize;
use serde::Serialize;

/// Client execution requires verified admission of the independently installed package.
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

pub struct ReferenceManagerExtension;

impl Extension for ReferenceManagerExtension {
    fn id(&self) -> &str {
        "ash.reference-manager"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let english: serde_json::Value = serde_json::from_str(include_str!("../package.nls.json"))
            .map_err(|_| {
                ExtensionError::new(
                    HostErrorCode::InvalidRequest,
                    "Invalid Reference Manager messages",
                )
            })?;
        let chinese: serde_json::Value =
            serde_json::from_str(include_str!("../package.nls.zh-CN.json")).map_err(|_| {
                ExtensionError::new(
                    HostErrorCode::InvalidRequest,
                    "Invalid Reference Manager messages",
                )
            })?;
        context
            .data_channels
            .register("editor.resource.v1", move |request: Request, token| {
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
                // A runtime may serve several windows with different client languages.
                let messages = if language == "zh-CN" {
                    &chinese
                } else {
                    &english
                };
                let display_name = messages["referenceManager.editor"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        ExtensionError::new(
                            HostErrorCode::InvalidRequest,
                            "Missing Reference Manager editor label",
                        )
                    })?;
                Ok(Contribution {
                    version: 1,
                    client_module: "dist/editor.js",
                    client_digest: env!("ASH_EDITOR_CLIENT_DIGEST"),
                    editors: vec![Editor {
                        editor_id: "ash.workbench.referenceLibrary",
                        display_name,
                        selectors: &["*.ash-library", "*.ris"],
                        content_type: "application/vnd.ash.reference-library+json",
                    }],
                })
            })
    }
}
