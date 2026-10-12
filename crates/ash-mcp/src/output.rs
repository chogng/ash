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
    if result.content.len() > 128 {
        return Err(McpCallError::InvalidResult(
            "tool output has too many content parts".into(),
        ));
    }
    let mut artifact_metadata_bytes = 0usize;
    let mut content = Vec::new();
    let mut media_bytes = 0usize;
    for block in result.content {
        let projected = match block {
            ContentBlock::Resource(resource) => {
                let (uri, mime_type, data) = match resource.resource {
                    ResourceContents::TextResourceContents {
                        uri,
                        mime_type,
                        text,
                        ..
                    } => (
                        uri,
                        mime_type.unwrap_or_else(|| "text/plain".into()),
                        ToolOutputArtifactData::Text { text },
                    ),
                    ResourceContents::BlobResourceContents {
                        uri,
                        mime_type,
                        blob,
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
                    .checked_add(uri.len() + mime_type.len())
                    .ok_or_else(|| {
                        McpCallError::InvalidResult("resource metadata byte count overflow".into())
                    })?;
                if artifact_metadata_bytes > maximum_bytes {
                    return Err(McpCallError::InvalidResult(
                        "resource metadata byte limit exceeded".into(),
                    ));
                }
                ToolContent::Artifact(ToolOutputArtifact::new(
                    ToolOutputArtifactSource::EmbeddedResource { uri },
                    mime_type,
                    data,
                ))
            }
            ContentBlock::ResourceLink(link) => {
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
    let output = if result.is_error.unwrap_or(false) {
        ToolOutput::error(content)
    } else {
        ToolOutput::success(content)
    };
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
