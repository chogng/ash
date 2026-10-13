use super::{ToolContent, ToolOutput, ToolOutputStatus};

#[test]
fn error_output_preserves_model_visible_content() {
    let output = ToolOutput::error(vec![ToolContent::Text("request denied".to_owned())]);

    assert_eq!(output.status(), ToolOutputStatus::Error);
    assert_eq!(
        output.content(),
        &[ToolContent::Text("request denied".to_owned())]
    );
}

#[test]
fn final_output_gate_sanitizes_every_image() {
    let mut output = ToolOutput::success(vec![ToolContent::Image {
        url: "data:image/png;base64,AA==".into(),
        detail: crate::ImageDetail::Original,
    }]);

    let decisions = output.sanitize_image_detail(
        crate::ImageDetailCapabilities { original: false },
        crate::ImageSourceDetailPolicy::Preserve,
    );

    assert_eq!(decisions.len(), 1);
    assert!(matches!(
        output.content(),
        [ToolContent::Image {
            detail: crate::ImageDetail::Auto,
            ..
        }]
    ));
}

#[test]
fn truncation_merges_text_and_preserves_images() {
    let output = ToolOutput::success(vec![
        ToolContent::Text("prefix".into()),
        ToolContent::Image {
            url: "data:image/png;base64,AA==".into(),
            detail: crate::ImageDetail::Auto,
        },
        ToolContent::Text("value ".repeat(200)),
        ToolContent::Text("suffix".into()),
    ]);

    let truncated = output.truncate_text(crate::ToolOutputTruncationPolicy::Bytes(256));
    assert_eq!(truncated.content().len(), 2);
    assert!(matches!(
        &truncated.content()[0],
        ToolContent::Text(text)
            if text.len() <= 256
                && text.contains("Warning: truncated output")
                && text.contains("original token count:")
                && text.contains("Total output lines: 3")
    ));
    assert!(matches!(
        &truncated.content()[1],
        ToolContent::Image { url, detail: crate::ImageDetail::Auto } if url == "data:image/png;base64,AA=="
    ));
}

#[test]
fn truncation_is_a_noop_when_output_has_no_text() {
    let output = ToolOutput::success(vec![ToolContent::Image {
        url: "data:image/png;base64,AA==".into(),
        detail: crate::ImageDetail::Auto,
    }]);

    assert_eq!(
        output
            .clone()
            .truncate_text(crate::ToolOutputTruncationPolicy::Bytes(0)),
        output
    );
}

#[test]
fn artifact_truncation_keeps_source_binary_and_a_shared_utf8_budget() {
    use ash_protocol::ContentDigest;
    use ash_protocol::ToolOutputArtifact;
    use ash_protocol::ToolOutputArtifactData;
    use ash_protocol::ToolOutputArtifactSource;
    let structured = ToolOutputArtifact::new(
        ToolOutputArtifactSource::StructuredResult,
        "application/json".into(),
        ToolOutputArtifactData::Json {
            json: format!("{{\"text\":\"{}\"}}", "中文".repeat(300)),
        },
    );
    let binary = ToolOutputArtifact::new(
        ToolOutputArtifactSource::EmbeddedResource {
            uri: "docs://data.bin".into(),
        },
        "application/octet-stream".into(),
        ToolOutputArtifactData::Binary {
            bytes: vec![0, 127, 255],
        },
    );
    let output = ToolOutput::success(vec![
        ToolContent::Text("before".into()),
        ToolContent::Artifact(structured.clone()),
        ToolContent::Artifact(binary.clone()),
        ToolContent::Text("after".into()),
    ])
    .truncate_text(crate::ToolOutputTruncationPolicy::Bytes(256));
    let [
        ToolContent::Text(before),
        ToolContent::Artifact(clipped),
        ToolContent::Artifact(bytes),
        ToolContent::Text(after),
    ] = output.content()
    else {
        panic!("lost ordered resource parts");
    };
    assert!(clipped.truncated);
    assert_eq!(clipped.source, structured.source);
    let ToolOutputArtifactData::Text { text } = &clipped.data else {
        panic!("truncated JSON cannot claim valid JSON");
    };
    assert_eq!(
        clipped.content_digest,
        ContentDigest::sha256(text.as_bytes())
    );
    assert_eq!(bytes, &binary);
    assert!(before.len() + text.len() + after.len() <= 256);
    assert_eq!(text.matches("Warning: truncated output").count(), 1);
}

#[test]
fn model_text_budget_keeps_view_only_payloads_intact_without_consuming_model_bytes() {
    let view = ash_protocol::ToolOutputArtifact::new(
        ash_protocol::ToolOutputArtifactSource::ViewMetadata,
        "application/json".into(),
        ash_protocol::ToolOutputArtifactData::Json {
            json: format!("{{\"private\":\"{}\"}}", "data".repeat(100)),
        },
    );
    let output = ToolOutput::success(vec![
        ToolContent::Artifact(view.clone()),
        ToolContent::Text("visible data ".repeat(100)),
    ])
    .truncate_text(crate::ToolOutputTruncationPolicy::Bytes(128));
    assert_eq!(output.content()[0], ToolContent::Artifact(view));
    assert!(
        matches!(&output.content()[1], ToolContent::Text(text) if text.len() <= 128 && text.contains("Warning: truncated output"))
    );
}
