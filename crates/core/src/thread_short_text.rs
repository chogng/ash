use ash_protocol::ModelRequest;
use ash_protocol::ReasoningConfig;
use ash_protocol::ReasoningEffort;
use ash_protocol::ToolChoice;

pub(super) fn short_text_request(
    input: String,
    instructions: &str,
    concise_output_limit: u32,
    effort: Option<ReasoningEffort>,
) -> ModelRequest {
    let mut request = ModelRequest::text(input);
    request.instructions = Some(instructions.into());
    request.tool_choice = ToolChoice::None;
    request.parallel_tool_calls = false;
    // The output budget can include reasoning tokens. Let the selected model's
    // normal reservation cover higher efforts, while keeping the short reply prompt.
    request.max_output_tokens = match effort {
        None | Some(ReasoningEffort::None | ReasoningEffort::Minimal | ReasoningEffort::Low) => {
            Some(concise_output_limit)
        }
        Some(
            ReasoningEffort::Medium
            | ReasoningEffort::High
            | ReasoningEffort::ExtraHigh
            | ReasoningEffort::Max,
        ) => None,
    };
    request.reasoning = effort.map(|effort| ReasoningConfig {
        effort,
        summary: false,
    });
    request
}
