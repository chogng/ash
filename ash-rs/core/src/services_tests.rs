use super::successful_read_paths;
use ash_protocol::ItemId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use std::path::PathBuf;

#[test]
fn only_successful_read_file_calls_supply_instruction_paths() {
    let turn = TurnId::new("turn").unwrap();
    let successful = ToolCallId::new("successful").unwrap();
    let failed = ToolCallId::new("failed").unwrap();
    let items = vec![
        ThreadItem::ToolCall {
            item_id: ItemId::new("call-successful").unwrap(),
            turn_id: turn.clone(),
            tool_call_id: successful.clone(),
            name: ToolName::new("read_file").unwrap(),
            arguments_json: r#"{"path":"src/lib.rs"}"#.into(),
            binding: None,
        },
        ThreadItem::ToolResult {
            item_id: ItemId::new("result-successful").unwrap(),
            turn_id: turn.clone(),
            tool_call_id: successful,
            text: "source".into(),
            content: None,
            is_error: false,
        },
        ThreadItem::ToolCall {
            item_id: ItemId::new("call-failed").unwrap(),
            turn_id: turn.clone(),
            tool_call_id: failed.clone(),
            name: ToolName::new("read_file").unwrap(),
            arguments_json: r#"{"path":"src/secret.rs"}"#.into(),
            binding: None,
        },
        ThreadItem::ToolResult {
            item_id: ItemId::new("result-failed").unwrap(),
            turn_id: turn,
            tool_call_id: failed,
            text: "denied".into(),
            content: None,
            is_error: true,
        },
    ];

    let paths = successful_read_paths(&items);
    assert_eq!(paths, [PathBuf::from("src/lib.rs")].into());
}
