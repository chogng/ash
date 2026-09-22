use std::sync::Arc;

use ash_async_utils::CancellationToken;
use ash_attachments::Attachments;
use ash_protocol::ContentPart;
use ash_protocol::InputItem;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ReasoningConfig;

use crate::ContextBudget;
use crate::ContextTokenMeasurementCapability;
use crate::ContextTokenMeasurementOutcome;
use crate::CoreError;
use crate::ModelSelection;
use crate::ModelService;
use crate::ModelStreamSink;

pub(crate) struct AttachmentModelService {
    inner: Arc<dyn ModelService>,
    attachments: Arc<Attachments>,
}

impl AttachmentModelService {
    pub(crate) fn new(inner: Arc<dyn ModelService>, attachments: Arc<Attachments>) -> Self {
        Self { inner, attachments }
    }

    fn materialize(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
    ) -> Result<ModelRequest, CoreError> {
        let policy = self.inner.image_input_policy(selection)?;
        let mut materialized = request.clone();
        for item in &mut materialized.input {
            let content = match item {
                InputItem::Message(message) => &mut message.content,
                InputItem::ToolResult(result) => &mut result.content,
                InputItem::Reasoning(_) => continue,
            };
            for part in content {
                let replacement = match part {
                    ContentPart::AudioAttachment { attachment } => Some(ContentPart::AudioUrl {
                        url: self
                            .attachments
                            .materialize_audio_data_url(attachment)
                            .map_err(|error| CoreError::Context(error.to_string()))?,
                    }),
                    ContentPart::AudioUrl { url } => Some(ContentPart::AudioUrl {
                        url: self
                            .attachments
                            .prepare_audio_data_url(url)
                            .map_err(|error| CoreError::Context(error.to_string()))?,
                    }),
                    ContentPart::ImageAttachment { attachment, detail } => {
                        let limits = policy.limits_for(*detail);
                        let data_url = self
                            .attachments
                            .materialize_data_url_with_limits(
                                attachment,
                                ash_utils_image::PromptImageResizeLimits {
                                    max_dimension: limits.max_dimension,
                                    max_patches: limits.max_patches,
                                },
                            )
                            .map_err(|error| CoreError::Context(error.to_string()))?;
                        Some(ContentPart::ImageUrl {
                            url: data_url,
                            detail: *detail,
                        })
                    }
                    ContentPart::ImageUrl { url, detail } if is_data_url(url) => {
                        let limits = policy.limits_for(*detail);
                        let data_url = self
                            .attachments
                            .prepare_data_url_with_limits(
                                url,
                                ash_utils_image::PromptImageResizeLimits {
                                    max_dimension: limits.max_dimension,
                                    max_patches: limits.max_patches,
                                },
                            )
                            .map_err(|error| CoreError::Context(error.to_string()))?;
                        Some(ContentPart::ImageUrl {
                            url: data_url,
                            detail: *detail,
                        })
                    }
                    ContentPart::Text(_) | ContentPart::ImageUrl { .. } => None,
                };
                if let Some(replacement) = replacement {
                    *part = replacement;
                }
            }
        }
        Ok(materialized)
    }
}

fn is_data_url(url: &str) -> bool {
    url.get(.."data:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

impl ModelService for AttachmentModelService {
    fn billing_scope(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<ash_protocol::ModelBillingScope, CoreError> {
        self.inner.billing_scope(selection)
    }

    fn context_budget(&self, selection: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        self.inner.context_budget(selection)
    }

    fn image_input_policy(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<crate::ModelImageInputPolicy, CoreError> {
        self.inner.image_input_policy(selection)
    }

    fn input_token_measurement_capability(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        self.inner.input_token_measurement_capability(selection)
    }

    fn reasoning_config(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<Option<ReasoningConfig>, CoreError> {
        self.inner.reasoning_config(selection)
    }

    fn measure_input(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        self.inner.measure_input(
            selection,
            &self.materialize(selection, request)?,
            cancellation,
        )
    }

    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.inner.invoke(
            selection,
            &self.materialize(selection, request)?,
            cancellation,
        )
    }

    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        self.inner.stream(
            selection,
            &self.materialize(selection, request)?,
            cancellation,
            sink,
        )
    }
}

#[cfg(test)]
#[path = "attachment_model_service_tests.rs"]
mod tests;
