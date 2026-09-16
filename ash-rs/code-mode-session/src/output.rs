use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeResponse;

/// Bounds the text in one observation without altering the cell's execution or resource ceiling.
/// UTF-8 bytes are a conservative token estimate when no provider tokenizer is available.
pub fn limit_output(response: &mut RuntimeResponse, max_tokens: Option<u32>) {
    let Some(max_tokens) = max_tokens else {
        return;
    };
    let mut remaining = max_tokens as usize;
    let (items, error) = match response {
        RuntimeResponse::Running { content_items, .. }
        | RuntimeResponse::Yielded { content_items, .. }
        | RuntimeResponse::Terminated { content_items, .. } => (content_items, None),
        RuntimeResponse::Result {
            content_items,
            error_text,
            ..
        } => (content_items, error_text.as_mut()),
        RuntimeResponse::Unknown {
            content_items,
            reason,
            ..
        } => (content_items, Some(reason)),
    };
    if let Some(error) = error {
        truncate(error, &mut remaining);
    }
    items.retain_mut(|item| match item {
        OutputItem::Text { text } => {
            truncate(text, &mut remaining);
            !text.is_empty()
        }
        // Image token costs depend on the provider and image detail, not base64 length.
        // Preserve the image; runtime max_output_bytes bounds its encoded payload.
        OutputItem::Image { .. } => true,
    });
}

fn truncate(text: &mut String, remaining: &mut usize) {
    if text.len() > *remaining {
        let suffix = " [truncated]";
        let mut end = remaining.saturating_sub(suffix.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        if *remaining >= suffix.len() {
            text.push_str(suffix);
        }
    }
    *remaining = remaining.saturating_sub(text.len());
}
