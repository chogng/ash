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
    assert_eq!(cell.status(), CommandStatus::Succeeded);
    assert_eq!(
        cell.summary(Language::English),
        "Finished 2 commands · 1 nonzero exit"
    );
    assert_eq!(
        cell.summary(Language::Chinese),
        "已完成 2 条命令 · 1 条非零退出"
    );
    assert!(cell.can_accept(Some(&activity)));
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
    assert!(visible.contains("已退出（状态码 1）"));
    assert!(!visible.contains("full error"));
    assert!(cell.full_details().contains("full error"));
}

#[test]
fn command_exit_status_stays_neutral_until_the_tool_reports_an_error() {
    let call = call_id("query");
    let mut cell = ExecCell::start(
        "query-entry".into(),
        call.clone(),
        &tool_name("exec"),
        "{}".into(),
        Some(ToolActivity::Command {
            program: "rg".into(),
            arguments: vec!["missing".into()],
            working_directory: ".".into(),
        }),
    );
    cell.complete(
        "query-result".into(),
        &call,
        r#"{"exit_code":1}"#.into(),
        false,
    );
    assert_eq!(cell.status(), CommandStatus::Succeeded);
    for (language, expected) in [
        (Language::English, "Exited (status 1)"),
        (Language::Chinese, "已退出（状态码 1）"),
        (Language::Japanese, "終了（ステータス 1）"),
        (Language::French, "Terminé (code 1)"),
    ] {
        assert_eq!(cell.summary(language), expected);
    }
    let mut snapshots = Vec::new();
    for language in [Language::English, Language::Chinese] {
        let buffer = render_cell(&cell, language);
        assert_eq!(buffer[(0, 0)].symbol(), "●");
        assert_eq!(buffer[(0, 0)].fg, crate::render::test_context().muted());
        snapshots.push(visible_buffer(&buffer));
    }
    cell.complete(
        "query-result".into(),
        &call,
        r#"{"exit_code":1,"stderr":"permission denied"}"#.into(),
        true,
    );
    assert_eq!(cell.status(), CommandStatus::Failed);
    assert_eq!(cell.summary(Language::English), "Command failed");
    assert!(!cell.can_accept(Some(&ToolActivity::Run)));
    let buffer = render_cell(&cell, Language::English);
    assert_eq!(buffer[(0, 0)].fg, crate::render::test_context().danger());
    snapshots.push(visible_buffer(&buffer));
    crate::tui_assert_snapshot!("command_exit_status", snapshots.join("\n\n"));
}

#[test]
fn command_groups_count_nonzero_exits_separately_from_tool_errors() {
    let mut cell = ExecCell::start(
        "first".into(),
        call_id("first"),
        &tool_name("exec"),
        "{}".into(),
        Some(ToolActivity::Run),
    );
    cell.complete(
        "first-result".into(),
        &call_id("first"),
        r#"{"exit_code":1}"#.into(),
        false,
    );
    assert!(cell.can_accept(Some(&ToolActivity::Run)));
    cell.push_call(
        "second".into(),
        call_id("second"),
        &tool_name("exec"),
        "{}".into(),
        Some(ToolActivity::Run),
    );
    assert_eq!(cell.status(), CommandStatus::Running);
    assert_eq!(
        cell.summary(Language::English),
        "Running 2 commands · 1 nonzero exit"
    );
    cell.complete(
        "second-result".into(),
        &call_id("second"),
        r#"{"exit_code":2}"#.into(),
        false,
    );
    assert_eq!(
        cell.summary(Language::English),
        "Finished 2 commands · 2 nonzero exits"
    );
    assert!(cell.can_accept(Some(&ToolActivity::Run)));
    cell.push_call(
        "third".into(),
        call_id("third"),
        &tool_name("exec"),
        "{}".into(),
        Some(ToolActivity::Run),
    );
    assert_eq!(cell.status(), CommandStatus::Running);
    assert_eq!(
        cell.summary(Language::English),
        "Running 3 commands · 2 nonzero exits"
    );
    cell.complete(
        "third-result".into(),
        &call_id("third"),
        "could not start process".into(),
        true,
    );
    assert_eq!(cell.status(), CommandStatus::Failed);
    assert_eq!(
        cell.summary(Language::English),
        "Finished 3 commands · 1 failed · 2 nonzero exits"
    );
    assert_eq!(
        cell.summary(Language::Chinese),
        "已完成 3 条命令 · 1 条失败 · 2 条非零退出"
    );
    assert!(!cell.can_accept(Some(&ToolActivity::Run)));
    let buffer = render_cell(&cell, Language::English);
    assert_eq!(buffer[(0, 0)].fg, crate::render::test_context().muted());
    for (label, color) in [
        ("Exited (status 1)", crate::render::test_context().muted()),
        ("Exited (status 2)", crate::render::test_context().muted()),
        ("Command failed", crate::render::test_context().danger()),
    ] {
        let row = (0..buffer.area.height)
            .find(|&y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .contains(label)
            })
            .expect("each command's status is visible");
        assert_eq!(buffer[(4, row)].fg, color);
    }
    crate::tui_assert_snapshot!("command_group_exit_status", visible_buffer(&buffer));
}

fn render_cell(cell: &ExecCell, language: Language) -> ratatui::buffer::Buffer {
    let view = crate::thread::transcript::history_cell::CellView::plain(
        crate::thread::transcript::MessageRole::Command,
        String::new(),
    );
    let rendered = crate::thread::transcript::history_cell::HistoryCell::lines(
        cell,
        &view,
        crate::render::test_context().with_language(language),
        None,
        60,
    );
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 16)).unwrap();
    terminal
        .draw(|frame| {
            frame.render_widget(
                ratatui::widgets::Paragraph::new(rendered.lines),
                frame.area(),
            )
        })
        .unwrap();
    terminal.backend().buffer().clone()
}

fn visible_buffer(buffer: &ratatui::buffer::Buffer) -> String {
    crate::terminal::text::text_in_range(
        buffer,
        crate::terminal::text::ScreenSelectionRange::new(
            ratatui::layout::Position::new(0, 0),
            ratatui::layout::Position::new(buffer.area.right() - 1, buffer.area.bottom() - 1),
        ),
    )
    .unwrap()
    .trim_end()
    .to_owned()
}
