use ash_rmcp_client::{CallToolResult, ContentBlock};
use ash_tools::{ImageDetail, ToolContent, ToolOutput, ToolOutputTruncationPolicy};

use crate::McpCallError;

pub(crate) fn project_tool_result(
    result: CallToolResult,
    maximum_bytes: usize,
) -> Result<ToolOutput, McpCallError> {
    let mut content = Vec::new();
    let mut media_bytes = 0usize;
    for block in result.content {
        let projected = match block {
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
        let structured = serde_json::to_string(&structured)
            .map_err(|error| McpCallError::InvalidResult(error.to_string()))?;
        content.push(ToolContent::Text(structured));
    }

    if media_bytes > maximum_bytes {
        return Err(McpCallError::InvalidResult(
            "tool output media byte limit exceeded".into(),
        ));
    }
    let output = if result.is_error.unwrap_or(false) {
        ToolOutput::error(content)
    } else {
        ToolOutput::success(content)
    };
    let text_budget = maximum_bytes.saturating_sub(media_bytes);
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
