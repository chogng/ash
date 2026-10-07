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
