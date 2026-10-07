use crate::ImageGenerationBackend;
use crate::ImageGenerationRequest;
use crate::artifact::Artifacts;
use extension_api::ExtensionItemStore;
use serde_json::json;
use std::sync::Arc;
use tools::ToolConcurrency;
use tools::ToolContent;
use tools::ToolDefinition;
use tools::ToolExecutionFuture;
use tools::ToolExecutionOutcome;
use tools::ToolExecutor;
use tools::ToolInputSchema;
use tools::ToolInvocation;
use tools::ToolLoading;
use tools::ToolName;
use tools::ToolOutput;
use tools::ToolOutputSchema;
use tools::ToolPayload;
use tools::ToolSchemaMode;

pub(crate) struct ImageTool {
    backend: Arc<dyn ImageGenerationBackend>,
    artifacts: Arc<Artifacts>,
    items: Arc<ExtensionItemStore>,
    references: Arc<dyn crate::ImageReferenceSource>,
}
impl ImageTool {
    pub(crate) fn new(
        backend: Arc<dyn ImageGenerationBackend>,
        artifacts: Arc<Artifacts>,
        items: Arc<ExtensionItemStore>,
        references: Arc<dyn crate::ImageReferenceSource>,
    ) -> Self {
        Self {
            backend,
            artifacts,
            items,
            references,
        }
    }
    fn run(&self, invocation: &ToolInvocation) -> Result<Vec<ToolContent>, String> {
        if invocation.binding().exposed_name().as_str() != "imagegen" {
            return Err("image tool binding mismatch".into());
        }
        let token = invocation.context().cancellation();
        token.check().map_err(|e| e.reason().to_string())?;
        let session = invocation
            .context()
            .session_id()
            .ok_or("image generation requires a bound Session")?;
        let thread = invocation
            .context()
            .thread_id()
            .ok_or("image generation requires a bound Thread")?;
        let ToolPayload::FunctionArguments(args) = invocation.payload() else {
            return Err("imagegen requires function arguments".into());
        };
        let mut request: ImageGenerationRequest =
            serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
        if request.prompt.trim().is_empty()
            || request.prompt.len() > 32_000
            || request.reference_images.len() > 5
        {
            return Err(
                "imagegen requires a bounded prompt and at most five reference images".into(),
            );
        }
        request.reference_images = request
            .reference_images
            .iter()
            .map(|path| {
                if path.starts_with("attachment:") {
                    self.references.read(session, thread, path)
                } else {
                    self.artifacts.read(session, thread, path)
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        if request
            .reference_images
            .iter()
            .any(|data| data.len() > 7_000_000)
        {
            return Err("reference image exceeds upload limits".into());
        }
        token.check().map_err(|e| e.reason().to_string())?;
        let image = self.backend.generate(&request, token)?;
        token.check().map_err(|e| e.reason().to_string())?;
        let path = self.artifacts.save(session, thread, &image, token)?;
        self.items
            .publish(
                session,
                thread,
                extension_items::ExtensionItem {
                    extension: "image-generation".into(),
                    id: invocation.call_id().as_str().into(),
                    title: "Generated image".into(),
                    body: image.revised_prompt.clone(),
                    status: extension_items::ExtensionItemStatus::Completed,
                    content: extension_items::ExtensionItemContent::Image {
                        mime_type: image.mime_type.clone(),
                        saved_path: path.to_string_lossy().into_owned(),
                    },
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(vec![
            ToolContent::Text(
                json!({"saved_path":path,"revised_prompt":image.revised_prompt}).to_string(),
            ),
            ToolContent::Image {
                url: format!("data:{};base64,{}", image.mime_type, image.base64),
                detail: tools::ImageDetail::Auto,
            },
        ])
    }
}
impl ToolExecutor for ImageTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(ToolName::new("imagegen").unwrap(),"Generate an image from a prompt, or edit up to five attached or previously generated images in this Thread. reference_images accepts attachment IDs from the input image catalog or saved_path values returned by this tool; use an empty array for a new image.",ToolInputSchema::parse(json!({"type":"object","properties":{"prompt":{"type":"string","maxLength":32000},"reference_images":{"type":"array","maxItems":5,"items":{"type":"string"}}},"required":["prompt","reference_images"],"additionalProperties":false})).unwrap(),ToolOutputSchema::Unspecified,ToolSchemaMode::Strict,ToolLoading::Eager).expect("valid image tool definition")
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }
    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            match self.run(&invocation) {
                Ok(content) => ToolExecutionOutcome::Returned(ToolOutput::success(content)),
                Err(error) => {
                    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ToolContent::Text(
                        error,
                    )]))
                }
            }
        })
    }
}
