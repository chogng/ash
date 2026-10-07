use ash_rmcp_client::{CallToolResult, ContentBlock};
use ash_tools::{ToolContent, ToolOutputStatus};

use super::project_tool_result;
use crate::McpCallError;

#[test]
fn truncates_text_result_at_byte_limit() {
    let output = project_tool_result(
        CallToolResult::success(vec![ContentBlock::text("oversized output ".repeat(64))]),
        128,
    )
    .expect("oversized text should be truncated");

    assert!(matches!(
        output.content(),
        [ToolContent::Text(text)]
            if text.len() <= 128 && text.contains("Warning: truncated output")
    ));
}

#[test]
fn rejects_image_result_that_cannot_fit_the_byte_limit() {
    let error = project_tool_result(
        CallToolResult::success(vec![ContentBlock::image("AA==", "image/png")]),
        8,
    )
    .expect_err("an image must not be cut into an invalid data URL");

    assert!(matches!(
        error,
        McpCallError::InvalidResult(message) if message.contains("media byte limit")
    ));
}

#[test]
fn preserves_remote_tool_error_as_output_status() {
    let mut result = CallToolResult::success(vec![ContentBlock::text("remote failure")]);
    result.is_error = Some(true);

    let output = project_tool_result(result, 1024).expect("project remote error");

    assert_eq!(output.status(), ToolOutputStatus::Error);
}

#[test]
fn audio_results_preserve_validated_bytes_and_obey_the_media_budget() {
    let audio = audio::load_bytes(
        include_bytes!("../../utils/audio/tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        audio::AudioFormat::Wav,
    )
    .unwrap();
    let url = audio.data_url();
    let block: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"audio", "data":url.split_once(',').unwrap().1, "mimeType":"audio/x-wav"
    }))
    .unwrap();
    let output = project_tool_result(
        CallToolResult::success(vec![
            ContentBlock::text("before"),
            block.clone(),
            ContentBlock::text("after"),
        ]),
        url.len() + 100,
    )
    .unwrap();
    assert_eq!(
        output.content(),
        &[
            ToolContent::Text("before".into()),
            ToolContent::Audio { url: url.clone() },
            ToolContent::Text("after".into())
        ]
    );
    assert!(matches!(
        project_tool_result(CallToolResult::success(vec![block]), url.len() - 1),
        Err(McpCallError::InvalidResult(_))
    ));
    let invalid: ContentBlock = serde_json::from_value(
        serde_json::json!({"type":"audio","data":"AA==","mimeType":"audio/wav"}),
    )
    .unwrap();
    assert!(matches!(
        project_tool_result(CallToolResult::success(vec![invalid]), 1024),
        Err(McpCallError::InvalidResult(_))
    ));
}
