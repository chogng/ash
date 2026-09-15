use std::collections::BTreeMap;

use ash_protocol::ContentPart;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallId;
use ash_protocol::ToolSourceProvenance;
use serde_json::Value;

const SHELL_RESULT_MAX_BYTES: usize = 30 * 1024;
const MCP_RESULT_MAX_BYTES: usize = 25 * 1024;
const READ_RESULT_MAX_LINES: usize = 2_000;
const READ_RESULT_MAX_LINE_CHARS: usize = 2_000;
const READ_RESULT_MAX_BYTES: usize = 256 * 1024;
const SEARCH_RESULT_MAX_LINES: usize = 100;
const GREP_RESULT_MAX_LINE_CHARS: usize = 500;
const GLOB_RESULT_MAX_LINE_CHARS: usize = 2_000;
const SEARCH_RESULT_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct ToolCallContext {
    name: String,
    arguments: Value,
    binding: Option<ToolCallBinding>,
}

pub(super) fn limit_model_input_items(items: &[ThreadItem]) -> Vec<ThreadItem> {
    let calls = items
        .iter()
        .filter_map(|item| {
            let ThreadItem::ToolCall {
                tool_call_id,
                name,
                arguments_json,
                binding,
                ..
            } = item
            else {
                return None;
            };
            Some((
                tool_call_id.clone(),
                ToolCallContext {
                    name: name.as_str().to_owned(),
                    arguments: serde_json::from_str(arguments_json).unwrap_or(Value::Null),
                    binding: binding.clone(),
                },
            ))
        })
        .collect::<BTreeMap<ToolCallId, ToolCallContext>>();

    items
        .iter()
        .cloned()
        .map(|item| limit_item(item, &calls))
        .collect()
}

fn limit_item(item: ThreadItem, calls: &BTreeMap<ToolCallId, ToolCallContext>) -> ThreadItem {
    let ThreadItem::ToolResult {
        item_id,
        turn_id,
        tool_call_id,
        text,
        content,
        is_error,
    } = item
    else {
        return item;
    };
    let Some(call) = calls.get(&tool_call_id) else {
        return ThreadItem::ToolResult {
            item_id,
            turn_id,
            tool_call_id,
            text,
            content,
            is_error,
        };
    };
    let policy = policy_for(call);
    let limited_text = if content.is_some() && !matches!(policy, LimitPolicy::None) {
        "[structured Tool Result content follows]".into()
    } else {
        limit_text(&text, call, policy)
    };
    let limited_content = content.map(|content| limit_content(content, call, policy));
    ThreadItem::ToolResult {
        item_id,
        turn_id,
        tool_call_id,
        text: limited_text,
        content: limited_content,
        is_error,
    }
}

#[derive(Clone, Copy)]
enum LimitPolicy {
    None,
    Shell,
    Read,
    Grep,
    Glob,
    Mcp,
}

fn policy_for(call: &ToolCallContext) -> LimitPolicy {
    if call.binding.as_ref().is_some_and(|binding| {
        binding
            .source_chain
            .iter()
            .any(|source| matches!(source, ToolSourceProvenance::Mcp { .. }))
    }) {
        return LimitPolicy::Mcp;
    }
    match call.name.as_str() {
        "shell-command" => LimitPolicy::Shell,
        "read_file" => LimitPolicy::Read,
        "file-system"
            if call.arguments.get("operation").and_then(Value::as_str) == Some("read") =>
        {
            LimitPolicy::Read
        }
        "grep" => LimitPolicy::Grep,
        "glob" => LimitPolicy::Glob,
        _ => LimitPolicy::None,
    }
}

fn limit_text(text: &str, call: &ToolCallContext, policy: LimitPolicy) -> String {
    match policy {
        LimitPolicy::None => text.to_owned(),
        LimitPolicy::Shell => truncate_head_tail(
            text,
            SHELL_RESULT_MAX_BYTES,
            "re-run the command with narrower output, or redirect it to a file and read it in chunks",
        ),
        LimitPolicy::Read => limit_read_result(text, call),
        LimitPolicy::Grep => limit_search_result(
            text,
            GREP_RESULT_MAX_LINE_CHARS,
            "narrow the grep pattern, glob, or path to continue",
        ),
        LimitPolicy::Glob => limit_search_result(
            text,
            GLOB_RESULT_MAX_LINE_CHARS,
            "narrow the glob pattern or path to continue",
        ),
        LimitPolicy::Mcp => truncate_head_tail(
            text,
            MCP_RESULT_MAX_BYTES,
            "call the MCP tool again with narrower or paginated arguments when supported",
        ),
    }
}

fn limit_content(
    content: Vec<ContentPart>,
    call: &ToolCallContext,
    policy: LimitPolicy,
) -> Vec<ContentPart> {
    let combined_text = content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text(text) => Some(text.as_str()),
            ContentPart::ImageAttachment { .. }
            | ContentPart::ImageUrl { .. }
            | ContentPart::AudioAttachment { .. }
            | ContentPart::AudioUrl { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let limited_text = limit_text(&combined_text, call, policy);
    if limited_text == combined_text {
        return content;
    }
    let mut limited = vec![ContentPart::Text(limited_text)];
    limited.extend(content.into_iter().filter(|part| {
        matches!(
            part,
            ContentPart::ImageAttachment { .. }
                | ContentPart::ImageUrl { .. }
                | ContentPart::AudioAttachment { .. }
                | ContentPart::AudioUrl { .. }
        )
    }));
    limited
}

fn limit_read_result(text: &str, call: &ToolCallContext) -> String {
    let source_lines = text.lines().collect::<Vec<_>>();
    let mut rendered = Vec::new();
    let mut rendered_bytes = 0usize;
    let mut long_lines = 0usize;
    for line in source_lines.iter().take(READ_RESULT_MAX_LINES) {
        let (line, truncated) = truncate_chars(line, READ_RESULT_MAX_LINE_CHARS);
        long_lines += usize::from(truncated);
        let next_bytes = rendered_bytes
            .saturating_add(line.len())
            .saturating_add(usize::from(!rendered.is_empty()));
        if next_bytes > READ_RESULT_MAX_BYTES.saturating_sub(512) {
            break;
        }
        rendered_bytes = next_bytes;
        rendered.push(line);
    }
    let omitted_lines = source_lines.len().saturating_sub(rendered.len());
    if omitted_lines == 0 && long_lines == 0 && text.len() <= READ_RESULT_MAX_BYTES {
        return text.to_owned();
    }
    let offset = call
        .arguments
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let next_offset = offset.saturating_add(rendered.len() as u64);
    let path = call
        .arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("<same path>");
    let continuation = if call.name == "read_file" {
        format!("continue with read_file path={path:?} offset={next_offset}")
    } else {
        format!(
            "continue with a file-reading tool that supports offsets for path={path:?}, starting near line {next_offset}"
        )
    };
    rendered.push(format!(
        "[context truncated: original {} bytes/{} lines; omitted {} lines; {} overlong lines shortened; {continuation}]",
        text.len(),
        source_lines.len(),
        omitted_lines,
        long_lines,
    ));
    rendered.join("\n")
}

fn limit_search_result(text: &str, max_line_chars: usize, continuation: &str) -> String {
    let mut source_lines = text.lines().collect::<Vec<_>>();
    let reported_total = source_lines
        .last()
        .and_then(|line| parse_search_total_marker(line));
    if reported_total.is_some() {
        source_lines.pop();
    }
    let total_entries = reported_total.unwrap_or(source_lines.len());
    let mut rendered = Vec::new();
    let mut rendered_bytes = 0usize;
    let mut long_lines = 0usize;
    for line in source_lines.iter().take(SEARCH_RESULT_MAX_LINES) {
        let (line, truncated) = truncate_chars(line, max_line_chars);
        long_lines += usize::from(truncated);
        let next_bytes = rendered_bytes
            .saturating_add(line.len())
            .saturating_add(usize::from(!rendered.is_empty()));
        if next_bytes > SEARCH_RESULT_MAX_BYTES.saturating_sub(384) {
            break;
        }
        rendered_bytes = next_bytes;
        rendered.push(line);
    }
    let omitted_lines = total_entries.saturating_sub(rendered.len());
    if reported_total.is_none()
        && omitted_lines == 0
        && long_lines == 0
        && text.len() <= SEARCH_RESULT_MAX_BYTES
    {
        return text.to_owned();
    }
    rendered.push(format!(
        "[context truncated: original {} bytes/{} entries; showing {} entries; {} overlong entries shortened; {continuation}]",
        text.len(),
        total_entries,
        rendered.len(),
        long_lines,
    ));
    rendered.join("\n")
}

fn parse_search_total_marker(line: &str) -> Option<usize> {
    let marker = line.strip_prefix('[')?.strip_suffix(']')?;
    let (total, shown) = marker.split_once(" matches, showing first ")?;
    total
        .parse::<usize>()
        .ok()
        .filter(|total| shown.parse::<usize>().is_ok_and(|shown| shown <= *total))
}

fn truncate_head_tail(text: &str, max_bytes: usize, continuation: &str) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let marker = format!(
        "\n[context truncated: original {} bytes; middle omitted; {continuation}]\n",
        text.len()
    );
    let content_bytes = max_bytes.saturating_sub(marker.len());
    let head_end = floor_char_boundary(text, content_bytes / 2);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(content_bytes - head_end));
    let omitted = tail_start.saturating_sub(head_end);
    let marker = format!(
        "\n[context truncated: original {} bytes; omitted {} middle bytes; {continuation}]\n",
        text.len(),
        omitted
    );
    let mut result = String::with_capacity(max_bytes);
    result.push_str(&text[..head_end]);
    result.push_str(&marker);
    let available_tail = max_bytes.saturating_sub(result.len());
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(available_tail));
    result.push_str(&text[tail_start..]);
    result
}

fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    let total_chars = text.chars().count();
    if total_chars <= max_chars {
        return (text.to_owned(), false);
    }
    let marker = format!("… [{} chars truncated]", total_chars - max_chars);
    let marker_chars = marker.chars().count();
    let prefix_chars = max_chars.saturating_sub(marker_chars);
    let omitted = total_chars.saturating_sub(prefix_chars);
    let marker = format!("… [{omitted} chars truncated]");
    let prefix_chars = max_chars.saturating_sub(marker.chars().count());
    let mut result = text.chars().take(prefix_chars).collect::<String>();
    result.push_str(&marker);
    (result, true)
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use ash_protocol::ImageDetail;
    use ash_protocol::ItemId;
    use ash_protocol::ToolCallCaller;
    use ash_protocol::ToolName;
    use ash_protocol::TurnId;

    #[test]
    fn head_tail_limit_is_utf8_safe_and_bounded() {
        let input = "界".repeat(SHELL_RESULT_MAX_BYTES);
        let output = truncate_head_tail(&input, SHELL_RESULT_MAX_BYTES, "continue narrowly");
        assert!(output.len() <= SHELL_RESULT_MAX_BYTES);
        assert!(output.contains("context truncated"));
        assert!(output.contains("omitted"));
    }

    #[test]
    fn shell_limit_keeps_head_and_tail_without_mutating_the_source_items() {
        let original = format!("HEAD\n{}\nTAIL", "x".repeat(SHELL_RESULT_MAX_BYTES * 2));
        let items = tool_exchange("shell-command", "{}", None, original.clone(), None);

        let limited = limit_model_input_items(&items);

        assert_eq!(tool_result_text(&items), original);
        let selected = tool_result_text(&limited);
        assert!(selected.len() <= SHELL_RESULT_MAX_BYTES);
        assert!(selected.starts_with("HEAD"));
        assert!(selected.ends_with("TAIL"));
        assert!(selected.contains("original"));
        assert!(selected.contains("omitted"));
        assert!(selected.contains("narrower output"));
    }

    #[test]
    fn read_limit_caps_lines_and_characters_and_explains_the_next_offset() {
        let input = (0..2_100)
            .map(|index| format!("{index}:{}", "界".repeat(2_500)))
            .collect::<Vec<_>>()
            .join("\n");
        let items = tool_exchange(
            "read_file",
            r#"{"path":"/dir/large.txt","offset":51,"limit":null}"#,
            None,
            input.clone(),
            None,
        );

        let limited = limit_model_input_items(&items);
        let selected = tool_result_text(&limited);

        assert_eq!(tool_result_text(&items), input);
        assert!(selected.lines().count() <= READ_RESULT_MAX_LINES + 1);
        assert!(selected.lines().all(|line| {
            line.starts_with("[context truncated:")
                || line.chars().count() <= READ_RESULT_MAX_LINE_CHARS
        }));
        assert!(selected.contains("original"));
        assert!(selected.contains("continue with read_file"));
        assert!(selected.contains("offset="));
    }

    #[test]
    fn search_limit_reports_total_entries_and_a_narrowing_action() {
        let input = (0..150)
            .map(|index| format!("path-{index}:match"))
            .collect::<Vec<_>>()
            .join("\n");
        let items = tool_exchange("grep", "{}", None, input.clone(), None);

        let limited = limit_model_input_items(&items);
        let selected = tool_result_text(&limited);

        assert_eq!(tool_result_text(&items), input);
        assert_eq!(selected.lines().count(), SEARCH_RESULT_MAX_LINES + 1);
        assert!(selected.contains("150 entries"));
        assert!(selected.contains("showing 100 entries"));
        assert!(selected.contains("narrow the grep"));
    }

    #[test]
    fn search_limit_preserves_an_execution_side_total_match_marker() {
        let mut input = (0..100)
            .map(|index| format!("path-{index}:match"))
            .collect::<Vec<_>>()
            .join("\n");
        input.push_str("\n[375 matches, showing first 100]");
        let items = tool_exchange("glob", "{}", None, input, None);

        let limited = limit_model_input_items(&items);
        let selected = tool_result_text(&limited);

        assert_eq!(selected.lines().count(), SEARCH_RESULT_MAX_LINES + 1);
        assert!(selected.contains("375 entries"));
        assert!(selected.contains("showing 100 entries"));
    }

    #[test]
    fn mcp_limit_applies_to_structured_text_and_preserves_images() {
        let binding = ToolCallBinding {
            registry_incarnation: Some("registry".into()),
            registry_generation: 7,
            definition_digest: "sha256:test".into(),
            source_chain: vec![ToolSourceProvenance::Mcp {
                server_id: "docs".into(),
                remote_name: "lookup".into(),
                catalog_generation: 3,
                connection_generation: 4,
            }],
            caller: ToolCallCaller::Direct,
        };
        let image = ContentPart::ImageUrl {
            url: "data:image/png;base64,AA==".into(),
            detail: ImageDetail::High,
        };
        let content = vec![
            ContentPart::Text("a".repeat(MCP_RESULT_MAX_BYTES)),
            image.clone(),
            ContentPart::Text("b".repeat(MCP_RESULT_MAX_BYTES)),
        ];
        let items = tool_exchange(
            "docs_lookup",
            "{}",
            Some(binding),
            "structured fallback".into(),
            Some(content.clone()),
        );

        let limited = limit_model_input_items(&items);
        let selected_content = tool_result_content(&limited);
        let selected_text = selected_content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text) => Some(text.as_str()),
                ContentPart::ImageAttachment { .. }
                | ContentPart::ImageUrl { .. }
                | ContentPart::AudioAttachment { .. }
                | ContentPart::AudioUrl { .. } => None,
            })
            .collect::<String>();

        assert_eq!(tool_result_content(&items), &content);
        assert_eq!(
            tool_result_text(&limited),
            "[structured Tool Result content follows]"
        );
        assert!(selected_text.len() <= MCP_RESULT_MAX_BYTES);
        assert!(selected_text.contains("context truncated"));
        assert!(selected_text.contains("paginated arguments"));
        assert!(selected_content.contains(&image));
    }

    fn tool_exchange(
        name: &str,
        arguments_json: &str,
        binding: Option<ToolCallBinding>,
        text: String,
        content: Option<Vec<ContentPart>>,
    ) -> Vec<ThreadItem> {
        let turn_id = TurnId::new("turn").unwrap();
        let tool_call_id = ToolCallId::new("call").unwrap();
        vec![
            ThreadItem::ToolCall {
                item_id: ItemId::new("call-item").unwrap(),
                turn_id: turn_id.clone(),
                tool_call_id: tool_call_id.clone(),
                name: ToolName::new(name).unwrap(),
                arguments_json: arguments_json.into(),
                binding,
            },
            ThreadItem::ToolResult {
                item_id: ItemId::new("result-item").unwrap(),
                turn_id,
                tool_call_id,
                text,
                content,
                is_error: false,
            },
        ]
    }

    fn tool_result_text(items: &[ThreadItem]) -> &str {
        let ThreadItem::ToolResult { text, .. } = &items[1] else {
            panic!("test exchange must contain a Tool Result");
        };
        text
    }

    fn tool_result_content(items: &[ThreadItem]) -> &Vec<ContentPart> {
        let ThreadItem::ToolResult {
            content: Some(content),
            ..
        } = &items[1]
        else {
            panic!("test exchange must contain structured Tool Result content");
        };
        content
    }
}
