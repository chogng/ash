//! Registers optional text-editor features through the shared extension capability transport.

use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use serde::Deserialize;
use serde::Serialize;

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
struct Contribution {
    version: u8,
    client_module: &'static str,
    client_digest: &'static str,
}

pub struct CodeExtension;

impl Extension for CodeExtension {
    fn id(&self) -> &str {
        "ash.code"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        context
            .data_channels
            .register("editor.contributions.v1", |request: Request, token| {
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
                Ok(Contribution {
                    version: 1,
                    client_module: "browser/editor.ts",
                    client_digest: env!("ASH_EDITOR_CLIENT_DIGEST"),
                })
            })
    }
}
