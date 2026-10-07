use ash_protocol::CapabilitySupport;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;
use ash_protocol::InputItem;
use ash_protocol::ModelRequest;

// Apply endpoint capability to the outbound clone only. Durable image detail and
// attachment bytes remain unchanged. Unknown support does not permit Original.
pub(crate) fn normalize_image_details(
    request: &mut ModelRequest,
    original_support: CapabilitySupport,
) {
    if original_support == CapabilitySupport::Supported {
        return;
    }
    for item in &mut request.input {
        let content = match item {
            InputItem::Message(message) => &mut message.content,
            InputItem::ToolResult(result) => &mut result.content,
            InputItem::Reasoning(_) => continue,
        };
        for part in content {
            match part {
                ContentPart::ImageUrl { detail, .. }
                | ContentPart::ImageAttachment { detail, .. }
                    if *detail == ImageDetail::Original =>
                {
                    *detail = ImageDetail::Auto
                }
                ContentPart::ImageUrl { .. }
                | ContentPart::ImageAttachment { .. }
                | ContentPart::Text(_)
                | ContentPart::AudioAttachment { .. }
                | ContentPart::AudioUrl { .. } => {}
            }
        }
    }
}

#[cfg(test)]
#[path = "image_request_tests.rs"]
mod tests;
