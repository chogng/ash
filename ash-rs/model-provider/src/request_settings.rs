use crate::ModelProviderError;
use ash_api::ApiProtocol;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContentPart;
use ash_protocol::InputItem;
use ash_protocol::Model;
use ash_protocol::ModelInputModality;
use ash_protocol::ModelReasoningSummary;
use ash_protocol::ModelRequest;
use ash_protocol::ModelToolOutputLimit;
use ash_utils_output_truncation::ToolOutputTruncationPolicy;
use ash_utils_output_truncation::formatted_truncate_text;

/// Applies one immutable model declaration to the outbound clone used by both counting and calls.
/// This does not mutate history, enable tools, or change user-selected execution permissions.
pub(crate) fn apply_settings(
    model: &Model,
    protocol: ApiProtocol,
    request: &mut ModelRequest,
) -> Result<(), ModelProviderError> {
    let settings = &model.settings;
    request.parallel_tool_calls &=
        model.capabilities.parallel_tool_calls != CapabilitySupport::Unsupported;
    if protocol == ApiProtocol::OpenAiResponses {
        request.verbosity = request.verbosity.or(settings.default_verbosity);
        request.reasoning_summary = request.reasoning_summary.or_else(|| {
            if request
                .reasoning
                .as_ref()
                .is_some_and(|reasoning| reasoning.summary)
            {
                Some(ModelReasoningSummary::Auto)
            } else {
                settings.default_reasoning_summary
            }
        });
    }
    if request.verbosity.is_some() && settings.verbosity == CapabilitySupport::Unsupported {
        return Err(ModelProviderError::InvalidRequest(
            "model does not support verbosity".into(),
        ));
    }
    if request
        .reasoning_summary
        .is_some_and(|summary| summary != ModelReasoningSummary::None)
        && settings.reasoning_summary == CapabilitySupport::Unsupported
    {
        return Err(ModelProviderError::InvalidRequest(
            "model does not accept reasoning summary parameters".into(),
        ));
    }
    if let (Some(tiers), Some(tier)) = (&settings.service_tiers, request.service_tier)
        && !tiers.contains(&tier)
    {
        return Err(ModelProviderError::InvalidRequest(
            "service tier is not declared for this model".into(),
        ));
    }
    let limit = settings.tool_output_limit.map(|limit| match limit {
        ModelToolOutputLimit::Bytes(bytes) => ToolOutputTruncationPolicy::Bytes(bytes as usize),
        ModelToolOutputLimit::Tokens(tokens) => {
            ToolOutputTruncationPolicy::ApproximateTokens(tokens as usize)
        }
    });
    for item in &mut request.input {
        let content = match item {
            InputItem::Message(message) => &mut message.content,
            InputItem::ToolResult(result) => {
                if let Some(limit) = limit {
                    // One tool result shares one text budget across all of its content parts.
                    // Images/audio and their order stay intact; allocating per part multiplies it.
                    let texts = result
                        .content
                        .iter()
                        .filter_map(|part| match part {
                            ContentPart::Text(text) => Some(text.as_str()),
                            ContentPart::ImageUrl { .. }
                            | ContentPart::ImageAttachment { .. }
                            | ContentPart::AudioUrl { .. }
                            | ContentPart::AudioAttachment { .. } => None,
                        })
                        .collect::<Vec<_>>();
                    let text = texts.join("\n");
                    if text.len() > limit.byte_budget() {
                        let truncated = formatted_truncate_text(&text, limit);
                        let mut first = true;
                        result.content.retain_mut(|part| match part {
                            ContentPart::Text(text) if first => {
                                *text = truncated.clone();
                                first = false;
                                true
                            }
                            ContentPart::Text(_) => false,
                            ContentPart::ImageUrl { .. }
                            | ContentPart::ImageAttachment { .. }
                            | ContentPart::AudioUrl { .. }
                            | ContentPart::AudioAttachment { .. } => true,
                        });
                    }
                }
                &mut result.content
            }
            InputItem::Reasoning(_) => continue,
        };
        if let Some(modalities) = &settings.input_modalities {
            for part in content {
                let modality = match part {
                    ContentPart::Text(_) => ModelInputModality::Text,
                    ContentPart::ImageUrl { .. } | ContentPart::ImageAttachment { .. } => {
                        ModelInputModality::Image
                    }
                    ContentPart::AudioUrl { .. } | ContentPart::AudioAttachment { .. } => {
                        ModelInputModality::Audio
                    }
                };
                if !modalities.contains(&modality) {
                    return Err(ModelProviderError::InvalidRequest(format!(
                        "model does not support {modality:?} input"
                    )));
                }
            }
        }
    }
    Ok(())
}
