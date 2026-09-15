use crate::CoreError;
use ash_attachments::Attachments;
use ash_protocol::ContentPart;
use std::sync::Arc;

pub(crate) fn prepare_tool_content(
    content: &mut [ContentPart],
    attachments: &Arc<Attachments>,
) -> Result<(), CoreError> {
    for part in content {
        let replacement = match part {
            ContentPart::AudioUrl { url } => attachments
                .import_audio_data_url(url)
                .map(|attachment| ContentPart::AudioAttachment { attachment }),
            ContentPart::AudioAttachment { attachment } => {
                attachments
                    .verify_audio(attachment)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                continue;
            }
            ContentPart::ImageUrl { url, detail } => {
                let reference = if url
                    .get(.."data:".len())
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
                {
                    attachments.import_data_url(url, *detail)
                } else if url.starts_with("https://") || url.starts_with("http://") {
                    attachments.import_remote_url(url, *detail)
                } else {
                    return Err(CoreError::InvalidInput(
                        "image input must use a data URL or an HTTP(S) URL".into(),
                    ));
                };
                reference.map(|attachment| ContentPart::ImageAttachment {
                    attachment,
                    detail: *detail,
                })
            }
            ContentPart::ImageAttachment { attachment, .. } => {
                attachments
                    .verify(attachment)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                continue;
            }
            ContentPart::Text(_) => continue,
        };
        *part = replacement.map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "attachment_preparation_tests.rs"]
mod tests;
