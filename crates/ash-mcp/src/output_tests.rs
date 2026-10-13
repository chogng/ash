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

#[test]
fn embedded_resources_and_structured_results_retain_identity_bytes_and_digest() {
    use ash_protocol::ContentDigest;
    use ash_protocol::ToolOutputArtifactData;
    use ash_protocol::ToolOutputArtifactSource;
    let resource: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource", "resource":{"uri":"docs://guide/review.md","mimeType":"text/markdown","text":"# Review\r\n审阅 changes\r\n"}
    })).unwrap();
    let binary: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource", "resource":{"uri":"docs://bytes/data.bin","mimeType":"application/octet-stream","blob":"AAH/"}
    })).unwrap();
    let mut result = CallToolResult::success(vec![ContentBlock::text("before"), resource, binary]);
    result.structured_content =
        Some(serde_json::json!({"amount":1.0,"items":["<script>unsafe()</script>"]}));
    let output = project_tool_result(result, 4096).unwrap();
    assert_eq!(output.content().len(), 4);
    let ToolContent::Artifact(text) = &output.content()[1] else {
        panic!("expected text artifact");
    };
    assert_eq!(
        text.source,
        ToolOutputArtifactSource::EmbeddedResource {
            uri: "docs://guide/review.md".into()
        }
    );
    assert_eq!(
        text.data,
        ToolOutputArtifactData::Text {
            text: "# Review\r\n审阅 changes\r\n".into()
        }
    );
    assert_eq!(
        text.content_digest,
        ContentDigest::sha256("# Review\r\n审阅 changes\r\n".as_bytes())
    );
    let ToolContent::Artifact(binary) = &output.content()[2] else {
        panic!("expected binary artifact");
    };
    assert_eq!(
        binary.data,
        ToolOutputArtifactData::Binary {
            bytes: vec![0, 1, 255]
        }
    );
    assert!(!binary.model_text().contains("AAH/"));
    let ToolContent::Artifact(structured) = &output.content()[3] else {
        panic!("expected structured artifact");
    };
    let ToolOutputArtifactData::Json { json } = &structured.data else {
        panic!("expected JSON");
    };
    assert!(json.contains("1.0"));
    assert_eq!(
        structured.content_digest,
        ContentDigest::sha256(json.as_bytes())
    );
    assert!(!structured.truncated);
}

#[test]
fn resource_truncation_is_explicit_and_invalid_binary_never_enters_canonical_output() {
    use ash_protocol::ToolOutputArtifactData;
    let resource: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource", "resource":{"uri":"docs://long","text":"long data ".repeat(100)}
    }))
    .unwrap();
    let output = project_tool_result(CallToolResult::success(vec![resource]), 128).unwrap();
    let ToolContent::Artifact(artifact) = &output.content()[0] else {
        panic!("expected clipped artifact");
    };
    assert!(artifact.truncated);
    let ToolOutputArtifactData::Text { text } = &artifact.data else {
        panic!("expected text");
    };
    assert!(text.len() <= 128);
    assert!(text.contains("truncated output"));
    for blob in ["invalid!", "AAAAAAA="] {
        let resource: ContentBlock = serde_json::from_value(
            serde_json::json!({"type":"resource", "resource":{"uri":"docs://binary","blob":blob}}),
        )
        .unwrap();
        assert!(project_tool_result(CallToolResult::success(vec![resource]), 4).is_err());
    }
}

#[test]
fn resource_metadata_survives_output_and_text_truncation_without_entering_model_text() {
    let block: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource","resource":{"uri":"docs://metadata","mimeType":"application/vnd.example+json","text":"readable content ".repeat(100),"_meta":{"private":"view-only"}}
    })).unwrap();
    let output = project_tool_result(CallToolResult::success(vec![block.clone()]), 256).unwrap();
    let [ToolContent::Artifact(artifact)] = output.content() else {
        panic!("expected a resource artifact");
    };
    assert_eq!(
        artifact.resource_metadata.as_deref(),
        Some("{\"private\":\"view-only\"}")
    );
    assert!(artifact.truncated);
    assert!(!artifact.model_text().contains("view-only"));
    assert!(
        !artifact
            .truncated_text("later model budget".into())
            .model_text()
            .contains("view-only")
    );
    let oversized: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource","resource":{"uri":"docs://metadata","mimeType":"text/plain","text":"body","_meta":{"private":"a".repeat(1024)}}
    })).unwrap();
    assert!(project_tool_result(CallToolResult::success(vec![oversized]), 256).is_err());
}

#[test]
fn resource_links_remain_descriptors_until_the_user_reads_the_originating_server() {
    let link: ContentBlock = serde_json::from_value(serde_json::json!({
        "type":"resource_link","uri":"file:///server/report.md","name":"report.md","mimeType":"text/markdown","description":"Read results"
    })).unwrap();
    let output = project_tool_result(CallToolResult::success(vec![link]), 1024).unwrap();
    let [ToolContent::Artifact(artifact)] = output.content() else {
        panic!("expected a resource descriptor");
    };
    assert_eq!(
        artifact.source,
        ash_protocol::ToolOutputArtifactSource::ResourceLink {
            uri: "file:///server/report.md".into()
        }
    );
    let ash_protocol::ToolOutputArtifactData::Json { json } = &artifact.data else {
        panic!("expected inert link description");
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(json).unwrap()["name"],
        "report.md"
    );
    assert!(!artifact.truncated);
}

#[test]
fn content_metadata_retains_positions_without_exposing_private_link_or_text_data() {
    let blocks: Vec<ContentBlock> = serde_json::from_value(serde_json::json!([
        {"type":"text","text":"visible","annotations":{"audience":["user"],"priority":0.8},"_meta":{"private":"text-secret"}},
        {"type":"resource_link","uri":"docs://report","name":"report","_meta":{"private":"link-secret"}},
        {"type":"resource","resource":{"uri":"docs://body","text":"body","_meta":{"private":"resource-secret"}},"annotations":{"priority":0.4},"_meta":{"private":"block-secret"}}
    ])).unwrap();
    let output = project_tool_result(CallToolResult::success(blocks.clone()), 4096).unwrap();
    let [
        ToolContent::Text(text),
        ToolContent::Artifact(link),
        ToolContent::Artifact(resource),
        ToolContent::Artifact(metadata),
    ] = output.content()
    else {
        panic!("wrong content order")
    };
    assert_eq!(text, "visible");
    assert!(!link.model_text().contains("secret"));
    assert!(!resource.model_text().contains("secret"));
    assert_eq!(metadata.model_text(), "");
    assert_eq!(
        metadata.mime_type,
        "application/vnd.ash.mcp-content-metadata+json"
    );
    let ash_protocol::ToolOutputArtifactData::Json { json } = &metadata.data else {
        panic!("metadata must be JSON")
    };
    let entries: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(entries[0]["index"], 0);
    assert!((entries[0]["annotations"]["priority"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    assert_eq!(entries[1]["_meta"]["private"], "link-secret");
    assert_eq!(entries[2]["index"], 2);
    assert!(project_tool_result(CallToolResult::success(blocks), 64).is_err());
    let expected_metadata = ToolContent::Artifact(metadata.clone());
    let truncated = output.truncate_text(ash_tools::ToolOutputTruncationPolicy::Bytes(8));
    assert_eq!(truncated.content().last(), Some(&expected_metadata));
}
