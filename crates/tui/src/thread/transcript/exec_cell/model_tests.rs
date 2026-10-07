use super::ExecCell;
use super::ExecGroup;
use crate::nls::Language;
use crate::thread::transcript::CommandStatus;
use ash_protocol::ToolActivity;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;

#[test]
fn exploration_calls_group_by_declared_activity_instead_of_name() {
    let mut cell = ExecCell::start(
        "read-entry".into(),
        call_id("read"),
        &tool_name("opaque_one"),
        "{}".into(),
        Some(ToolActivity::Read {
            target: "file".into(),
        }),
    );
    assert!(cell.can_accept(Some(&ToolActivity::Search {
        target: "files".into()
    })));
    cell.push_call(
        "search-entry".into(),
        call_id("search"),
        &tool_name("opaque_two"),
        "{}".into(),
        Some(ToolActivity::Search {
            target: "files".into(),
        }),
    );

    assert_eq!(cell.group, ExecGroup::ExploreGroup);
    assert_eq!(cell.summary(Language::English), "Exploring 2 operations");

    let unclassified = ExecCell::start(
        "unclassified".into(),
        call_id("unclassified"),
        &tool_name("read_file"),
        "{}".into(),
        None,
    );
    assert_eq!(unclassified.group, ExecGroup::SingleExec);
    assert!(!unclassified.can_accept(Some(&ToolActivity::Read {
        target: "file".into()
    })));

    let named_like_target = ExecCell::start(
        "literal-name".into(),
        call_id("literal-name"),
        &tool_name("file"),
        "{}".into(),
        None,
    );
    assert_eq!(
        named_like_target.summary(Language::Chinese),
        "正在运行 file"
    );
}

#[test]
fn output_and_result_route_to_the_exact_tool_call() {
    let first = call_id("first");
    let second = call_id("second");
    let mut cell = ExecCell::start(
        "first-entry".into(),
        first.clone(),
        &tool_name("read"),
        "{}".into(),
        Some(ToolActivity::Read {
            target: "file".into(),
        }),
    );
    cell.push_call(
        "second-entry".into(),
        second.clone(),
        &tool_name("search"),
        "{}".into(),
        Some(ToolActivity::Search {
            target: "files".into(),
        }),
    );
    cell.apply_output(
        "second-output".into(),
        &second,
        ToolOutputStream::Stdout,
        "second only".into(),
    );
    cell.complete("first-result".into(), &first, "first done".into(), false);
    cell.complete("second-result".into(), &second, "second done".into(), true);

    assert_eq!(cell.status(), CommandStatus::Failed);
    assert_eq!(
        cell.summary(Language::Chinese),
        "已探查 2 项操作 · 1 项失败"
    );
    let detail = cell.full_details();
    assert!(detail.contains("second only"));
    assert!(detail.contains("first done"));
    assert!(detail.contains("second done"));
}

#[test]
fn live_output_is_bounded_with_an_omission_marker() {
    let call = call_id("bounded");
    let mut cell = ExecCell::start(
        "entry".into(),
        call.clone(),
        &tool_name("exec"),
        "{}".into(),
        Some(ToolActivity::Run),
    );
    let output = (0..500)
        .map(|index| format!("line {index} {}", "x".repeat(500)))
        .collect::<Vec<_>>()
        .join("\n");
    cell.apply_output("output".into(), &call, ToolOutputStream::Stdout, output);

    let detail = cell.full_details();
    assert!(detail.len() < 70 * 1024);
    assert!(detail.contains("omitted"));
}

#[test]
fn history_tools_are_grouped_with_read_operations() {
    let mut cell = ExecCell::start(
        "list-entry".into(),
        call_id("history-list"),
        &tool_name("history_list"),
        "{}".into(),
        Some(ToolActivity::List {
            target: "history".into(),
        }),
    );
    assert!(cell.can_accept(Some(&ToolActivity::Read {
        target: "history".into()
    })));
    cell.push_call(
        "read-entry".into(),
        call_id("history-read"),
        &tool_name("history_read"),
        "{}".into(),
        Some(ToolActivity::Read {
            target: "history".into(),
        }),
    );
    assert_eq!(cell.summary(Language::Chinese), "正在探查 2 项操作");
}

fn call_id(value: &str) -> ToolCallId {
    ToolCallId::new(value).expect("the test ToolCall ID is valid")
}

fn tool_name(value: &str) -> ToolName {
    ToolName::new(value).expect("the test Tool name is valid")
}

#[test]
fn advisor_results_present_advice_and_usage_without_json() {
    let text=super::advisor_text(serde_json::json!({"status":"reviewed","model":{"provider":"test","model":"reviewer"},"question":"Check cancellation","advice":"Check the token before writing.","sourceSequence":12,"usage":{"inputTokens":120,"outputTokens":8}}).to_string());
    crate::tui_assert_snapshot!(&text, @"
    Advisor · test/reviewer
    Question: Check cancellation

    Check the token before writing.

    Conversation sequence 12
    Tokens: 120 input · 8 output
    ");
    assert_eq!(
        super::advisor_text("outcome unknown".into()),
        "outcome unknown"
    );
}

#[test]
fn a_nonzero_process_exit_is_visible_even_when_the_tool_returned_successfully() {
    let first = call_id("first-command");
    let second = call_id("second-command");
    let activity = ToolActivity::Command {
        program: "just".into(),
        arguments: vec!["test".into(), "a b".into()],
        working_directory: ".".into(),
    };
    let mut cell = ExecCell::start(
        "first".into(),
        first.clone(),
        &tool_name("opaque-command"),
        "{}".into(),
        Some(activity.clone()),
    );
    cell.complete(
        "first-result".into(),
        &first,
        r#"{"exit_code":0,"stdout":"done"}"#.into(),
        false,
    );
    assert_eq!(cell.status(), CommandStatus::Succeeded);
    assert!(cell.can_accept(Some(&activity)));
    cell.push_call(
        "second".into(),
        second.clone(),
        &tool_name("opaque-command"),
        "{}".into(),
        Some(activity.clone()),
    );
    cell.complete(
        "second-result".into(),
        &second,
        r#"{"result":{"exit_code":1,"stderr":"assertion failed\nfull error"}}"#.into(),
        false,
    );
    assert_eq!(cell.status(), CommandStatus::Failed);
    assert_eq!(
        cell.summary(Language::Chinese),
        "已完成 2 条命令 · 1 条失败"
    );
    assert!(!cell.can_accept(Some(&activity)));
    let view = crate::thread::transcript::history_cell::CellView::plain(
        crate::thread::transcript::MessageRole::Command,
        String::new(),
    );
    let rendered = crate::thread::transcript::history_cell::HistoryCell::lines(
        &cell,
        &view,
        crate::render::test_context().with_language(Language::Chinese),
        None,
        80,
    );
    let visible = rendered
        .lines
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("just test 'a b'"));
    assert!(visible.contains("退出码 1 · assertion failed"));
    assert!(!visible.contains("full error"));
    assert!(cell.full_details().contains("full error"));
}
