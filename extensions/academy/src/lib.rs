//! Academy registers optional editor capabilities. Documents and history stay client-owned.

use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::editor_client::DOCUMENT_CLIENT_CHANNEL;
use external_ext_sdk::editor_client::DescribeClientOperation;
use external_ext_sdk::editor_client::DescribeClientRequest;
use external_ext_sdk::editor_client::DocumentClientContribution;
use external_ext_sdk::editor_client::DocumentClientEditor;

pub struct AcademyExtension;

impl Extension for AcademyExtension {
    fn id(&self) -> &str {
        "ash.academy"
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
        context.data_channels.register(
            DOCUMENT_CLIENT_CHANNEL,
            move |request: DescribeClientRequest, token| {
                token.check_cancelled()?;
                let DescribeClientRequest {
                    operation: DescribeClientOperation::Describe,
                    language,
                } = request;
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
                DocumentClientContribution::new(
                    "dist/editor.js",
                    env!("ASH_EDITOR_CLIENT_DIGEST"),
                    vec![
                        DocumentClientEditor {
                            editor_id: "stanza.editor.document".into(),
                            display_name: label("academy.editor")?,
                            selectors: vec!["*.ash-academy".into(), "*.ash-paper".into()],
                            document_type: "academy".into(),
                            content_type: "application/vnd.ash.academy-document+json".into(),
                        },
                        DocumentClientEditor {
                            editor_id: "ash.editor.document".into(),
                            display_name: label("academy.generalEditor")?,
                            selectors: vec!["*.ash-doc".into()],
                            document_type: "general".into(),
                            content_type: "application/vnd.ash.document+json".into(),
                        },
                        DocumentClientEditor {
                            editor_id: "ash.collaboration.notes".into(),
                            display_name: label("academy.channelNotes")?,
                            selectors: vec![],
                            document_type: "ash.collaboration.notes".into(),
                            content_type: "application/vnd.ash.channel-notes+json".into(),
                        },
                    ],
                )
            },
        )
    }
}
