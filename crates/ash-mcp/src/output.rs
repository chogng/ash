use ash_rmcp_client::{CallToolResult, ContentBlock, ResourceContents};
use ash_tools::{ImageDetail, ToolContent, ToolOutput, ToolOutputTruncationPolicy};

use ash_protocol::ToolOutputArtifact;
use ash_protocol::ToolOutputArtifactData;
use ash_protocol::ToolOutputArtifactSource;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::McpCallError;

pub(crate) fn project_tool_result(
    result: CallToolResult,
    maximum_bytes: usize,
) -> Result<ToolOutput, McpCallError> {
    let presentation = result
        .meta
        .as_ref()
        .and_then(|meta| meta.get("ash/resultPresentation"))
        .map(|value| {
            if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
                return Err(McpCallError::InvalidResult(
                    "unsupported result presentation version".into(),
                ));
            }
            let target: ash_protocol::ToolResultPresentation = serde_json::from_value(
                value.get("target").cloned().unwrap_or_default(),
            )
            .map_err(|error| {
                McpCallError::InvalidResult(format!("invalid result presentation: {error}"))
            })?;
            let (label, id) = match &target {
                ash_protocol::ToolResultPresentation::SessionTarget {
                    label, thread_id, ..
                } => (label, thread_id.as_str()),
                ash_protocol::ToolResultPresentation::AutomationConfigured {
                    label,
                    automation_id,
                } => (label, automation_id.as_str()),
            };
            if label.trim().is_empty()
                || label.len() > 512
                || id.trim().is_empty()
                || id.len() > 256
            {
                return Err(McpCallError::InvalidResult(
                    "result presentation has an invalid label or identity".into(),
                ));
            }
            let mut artifact = ToolOutputArtifact::new(
                ToolOutputArtifactSource::ViewMetadata,
                "application/vnd.ash.tool-result+json".into(),
                ToolOutputArtifactData::Text {
                    text: String::new(),
                },
            );
            artifact.presentation = Some(target);
            Ok(artifact)
        })
        .transpose()?;
    // This is an Ash protocol extension requested by the producing tool, not a policy heuristic.
    let result_review = result
        .meta
        .as_ref()
        .and_then(|meta| meta.get("ash/resultReview"))
        .map(|value| {
            let object = value.as_object().ok_or_else(|| {
                McpCallError::InvalidResult("result review must be an object".into())
            })?;
            if object.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
                return Err(McpCallError::InvalidResult(
                    "unsupported result review version".into(),
                ));
            }
            let reason = object
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .filter(|reason| !reason.trim().is_empty() && reason.len() <= 8192)
                .ok_or_else(|| {
                    McpCallError::InvalidResult("result review needs a bounded reason".into())
                })?;
            Ok(reason.to_owned())
        })
        .transpose()?;
    if result.content.len() > 128 {
        return Err(McpCallError::InvalidResult(
            "tool output has too many content parts".into(),
        ));
    }
    // Sidecar positions refer to the canonical content list, including persisted media.
    // Keeping protocol metadata out of text prevents private App data reaching a model.
    let content_metadata: Vec<_> = result
        .content
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let (annotations, meta) = match block {
                ContentBlock::Text(block) => (&block.annotations, &block.meta),
                ContentBlock::Image(block) => (&block.annotations, &block.meta),
                ContentBlock::Audio(block) => (&block.annotations, &block.meta),
                ContentBlock::Resource(block) => (&block.annotations, &block.meta),
                ContentBlock::ResourceLink(block) => (&block.annotations, &block.meta),
                _ => return None,
            };
            if annotations.is_none() && meta.is_none() {
                return None;
            }
            let mut entry = serde_json::Map::new();
            entry.insert("index".into(), index.into());
            if let Some(annotations) = annotations {
                entry.insert(
                    "annotations".into(),
                    serde_json::to_value(annotations).expect("MCP annotations are JSON"),
                );
            }
            if let Some(meta) = meta {
                entry.insert(
                    "_meta".into(),
                    serde_json::to_value(meta).expect("MCP metadata is JSON"),
                );
            }
            Some(serde_json::Value::Object(entry))
        })
        .collect();
    let metadata = (!content_metadata.is_empty()).then(|| {
        ToolOutputArtifact::new(
            ToolOutputArtifactSource::ViewMetadata,
            "application/vnd.ash.mcp-content-metadata+json".into(),
            ToolOutputArtifactData::Json {
                json: serde_json::to_string(&content_metadata).expect("MCP metadata is JSON"),
            },
        )
    });
    let mut artifact_metadata_bytes = metadata
        .as_ref()
        .map_or(0, |artifact| {
            let ToolOutputArtifactData::Json { json } = &artifact.data else {
                unreachable!()
            };
            json.len() + artifact.mime_type.len()
        })
        .saturating_add(presentation.as_ref().map_or(0, |artifact| {
            serde_json::to_vec(artifact)
                .expect("presentation is JSON")
                .len()
        }));
    if artifact_metadata_bytes > maximum_bytes {
        return Err(McpCallError::InvalidResult(
            "content metadata byte limit exceeded".into(),
        ));
    }
    let mut content = Vec::new();
    let mut media_bytes = 0usize;
    for block in result.content {
        let projected = match block {
            ContentBlock::Resource(resource) => {
                let (uri, mime_type, data, resource_metadata) = match resource.resource {
                    ResourceContents::TextResourceContents {
                        uri,
                        mime_type,
                        text,
                        meta,
                        ..
                    } => (
                        uri,
                        mime_type.unwrap_or_else(|| "text/plain".into()),
                        ToolOutputArtifactData::Text { text },
                        meta.map(|meta| {
                            serde_json::to_string(&meta).expect("MCP metadata is JSON")
                        }),
                    ),
                    ResourceContents::BlobResourceContents {
                        uri,
                        mime_type,
                        blob,
                        meta,
                        ..
                    } => {
                        if blob.len() > maximum_bytes.min(262_144).div_ceil(3) * 4 + 4 {
                            return Err(McpCallError::InvalidResult(
                                "resource byte limit exceeded".into(),
                            ));
                        }
                        let bytes = STANDARD.decode(&blob).map_err(|_| {
                            McpCallError::InvalidResult("resource contains invalid base64".into())
                        })?;
                        if bytes.len() > maximum_bytes.min(262_144) {
                            return Err(McpCallError::InvalidResult(
                                "resource byte limit exceeded".into(),
                            ));
                        }
                        media_bytes = media_bytes.checked_add(bytes.len()).ok_or_else(|| {
                            McpCallError::InvalidResult("output byte count overflow".into())
                        })?;
                        (
                            uri,
                            mime_type.unwrap_or_else(|| "application/octet-stream".into()),
                            ToolOutputArtifactData::Binary { bytes },
                            meta.map(|meta| {
                                serde_json::to_string(&meta).expect("MCP metadata is JSON")
                            }),
                        )
                    }
                    _ => {
                        return Err(McpCallError::InvalidResult(
                            "unsupported resource contents".into(),
                        ));
                    }
                };
                if uri.is_empty()
                    || uri.len() > 4096
                    || uri.contains('\0')
                    || mime_type.is_empty()
                    || mime_type.len() > 128
                    || mime_type.chars().any(char::is_control)
                {
                    return Err(McpCallError::InvalidResult(
                        "invalid resource identity or media type".into(),
                    ));
                }
                artifact_metadata_bytes = artifact_metadata_bytes
                    .checked_add(
                        uri.len()
                            + mime_type.len()
                            + resource_metadata.as_ref().map_or(0, String::len),
                    )
                    .ok_or_else(|| {
                        McpCallError::InvalidResult("resource metadata byte count overflow".into())
                    })?;
                if artifact_metadata_bytes > maximum_bytes {
                    return Err(McpCallError::InvalidResult(
                        "resource metadata byte limit exceeded".into(),
                    ));
                }
                let mut artifact = ToolOutputArtifact::new(
                    ToolOutputArtifactSource::EmbeddedResource { uri },
                    mime_type,
                    data,
                );
                artifact.resource_metadata = resource_metadata;
                ToolContent::Artifact(artifact)
            }
            ContentBlock::ResourceLink(mut link) => {
                // Private metadata is restored only by the interactive consumer from the sidecar.
                link.meta = None;
                link.annotations = None;
                let uri = link.uri.clone();
                let mime = link
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into());
                if uri.is_empty()
                    || uri.len() > 4096
                    || uri.chars().any(char::is_control)
                    || mime.is_empty()
                    || mime.len() > 128
                    || mime.chars().any(char::is_control)
                {
                    return Err(McpCallError::InvalidResult("invalid resource link".into()));
                }
                artifact_metadata_bytes =
                    artifact_metadata_bytes.saturating_add(uri.len() + mime.len());
                if artifact_metadata_bytes > maximum_bytes {
                    return Err(McpCallError::InvalidResult(
                        "resource metadata byte limit exceeded".into(),
                    ));
                }
                ToolContent::Artifact(ToolOutputArtifact::new(
                    ToolOutputArtifactSource::ResourceLink { uri },
                    mime,
                    ToolOutputArtifactData::Json {
                        json: serde_json::to_string(&link)
                            .map_err(|error| McpCallError::InvalidResult(error.to_string()))?,
                    },
                ))
            }
            ContentBlock::Text(text) => ToolContent::Text(text.text),
            ContentBlock::Audio(audio) => {
                let url = format!("data:{};base64,{}", audio.mime_type, audio.data);
                let audio = audio::load_data_url(&url)
                    .map_err(|error| McpCallError::InvalidResult(error.to_string()))?;
                ToolContent::Audio {
                    url: audio.data_url(),
                }
            }
            ContentBlock::Image(image) if valid_image_mime(&image.mime_type) => {
                ToolContent::Image {
                    url: format!("data:{};base64,{}", image.mime_type, image.data),
                    detail: ImageDetail::Auto,
                }
            }
            block => ToolContent::Text(
                serde_json::to_string(&block)
                    .map_err(|error| McpCallError::InvalidResult(error.to_string()))?,
            ),
        };
        if let ToolContent::Image { url, .. } | ToolContent::Audio { url } = &projected {
            media_bytes = media_bytes
                .checked_add(url.len())
                .ok_or_else(|| McpCallError::InvalidResult("output byte count overflow".into()))?;
        }
        content.push(projected);
    }
    if let Some(structured) = result.structured_content {
        content.push(ToolContent::Artifact(ToolOutputArtifact::new(
            ToolOutputArtifactSource::StructuredResult,
            "application/json".into(),
            ToolOutputArtifactData::Json {
                json: structured.to_string(),
            },
        )));
    }

    if media_bytes.saturating_add(artifact_metadata_bytes) > maximum_bytes {
        return Err(McpCallError::InvalidResult(
            "tool output media byte limit exceeded".into(),
        ));
    }
    if let Some(metadata) = metadata {
        content.push(ToolContent::Artifact(metadata));
    }
    if let Some(presentation) = presentation {
        content.push(ToolContent::Artifact(presentation));
    }
    let mut output = if result.is_error.unwrap_or(false) {
        ToolOutput::error(content)
    } else {
        ToolOutput::success(content)
    };
    if let Some(reason) = result_review {
        output = output
            .require_result_confirmation(reason)
            .map_err(|error| McpCallError::InvalidResult(error.to_string()))?;
    }
    let text_budget = maximum_bytes
        .saturating_sub(media_bytes)
        .saturating_sub(artifact_metadata_bytes);
    Ok(output.truncate_text(ToolOutputTruncationPolicy::Bytes(text_budget)))
}

fn valid_image_mime(mime: &str) -> bool {
    mime.starts_with("image/")
        && mime
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'.' | b'-'))
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
