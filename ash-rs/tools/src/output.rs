use crate::ImageDetail;
use crate::ImageDetailCapabilities;
use crate::ImageDetailDecision;
use crate::ImageDetailSelection;
use crate::ImageSourceDetailPolicy;
use crate::normalize_image_detail;
use ash_utils_output_truncation::{ToolOutputTruncationPolicy, formatted_truncate_text};

/// The model-visible success classification returned by an executable tool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolOutputStatus {
    Success,
    Error,
}

/// One bounded piece of model-visible tool output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolContent {
    Text(String),
    Audio { url: String },
    Image { url: String, detail: ImageDetail },
}

/// Provider-neutral output returned after a tool reaches a trustworthy terminal result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolOutput {
    status: ToolOutputStatus,
    content: Vec<ToolContent>,
}

impl ToolOutput {
    pub fn success(content: Vec<ToolContent>) -> Self {
        Self {
            status: ToolOutputStatus::Success,
            content,
        }
    }

    pub fn error(content: Vec<ToolContent>) -> Self {
        Self {
            status: ToolOutputStatus::Error,
            content,
        }
    }

    pub fn status(&self) -> ToolOutputStatus {
        self.status
    }

    pub fn content(&self) -> &[ToolContent] {
        &self.content
    }

    /// Truncates the combined text content while preserving non-text content such as images.
    ///
    /// Text parts are joined only when truncation is required. This keeps ordinary multi-part
    /// output unchanged and follows the same model-facing behavior for every tool source.
    pub fn truncate_text(self, policy: ToolOutputTruncationPolicy) -> Self {
        let content = truncate_tool_content(&self.content, policy);
        Self {
            status: self.status,
            content,
        }
    }

    /// Applies the final model-capability image gate to every image in this output.
    pub fn sanitize_image_detail(
        &mut self,
        capabilities: ImageDetailCapabilities,
        source_policy: ImageSourceDetailPolicy,
    ) -> Vec<ImageDetailDecision> {
        let mut decisions = Vec::new();
        for content in &mut self.content {
            let ToolContent::Image { detail, .. } = content else {
                continue;
            };
            let decision = normalize_image_detail(
                ImageDetailSelection::Explicit(*detail),
                capabilities,
                source_policy,
            );
            *detail = match decision.effective {
                ImageDetailSelection::ProviderDefault => ImageDetail::Auto,
                ImageDetailSelection::Explicit(detail) => detail,
            };
            decisions.push(decision);
        }
        decisions
    }
}

fn truncate_tool_content(
    content: &[ToolContent],
    policy: ToolOutputTruncationPolicy,
) -> Vec<ToolContent> {
    let text_segments = content
        .iter()
        .filter_map(|content| match content {
            ToolContent::Text(text) => Some(text.as_str()),
            ToolContent::Image { .. } | ToolContent::Audio { .. } => None,
        })
        .collect::<Vec<_>>();

    if text_segments.is_empty() {
        return content.to_vec();
    }

    let mut combined = String::new();
    for text in &text_segments {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(text);
    }

    if combined.len() <= policy.byte_budget() {
        return content.to_vec();
    }

    let mut truncated = vec![ToolContent::Text(formatted_truncate_text(
        &combined, policy,
    ))];
    truncated.extend(content.iter().filter_map(|content| match content {
        ToolContent::Text(_) => None,
        ToolContent::Image { .. } | ToolContent::Audio { .. } => Some(content.clone()),
    }));
    truncated
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
