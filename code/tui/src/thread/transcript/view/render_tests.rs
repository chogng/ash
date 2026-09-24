use super::ChatHistoryPointerState;
use super::ChatHistoryPointerTarget;
use super::ChatHistoryView;
use super::first_scroll_target;
use super::message_lines;
use super::scroll_target;
use crate::render::Renderable;
use crate::render::test_context;
use crate::thread::transcript::CellView;
use crate::thread::transcript::ChatHistoryRenderCache;
use crate::thread::transcript::ChatHistoryScroll;
use crate::thread::transcript::CommandStatus;
use crate::thread::transcript::MessageRole;
use crate::thread::transcript::TranscriptScrollAnchor;
use crate::thread::transcript::TranscriptScrollDirection;
use crate::thread::transcript::TranscriptScrollTarget;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;

#[test]
fn tool_output_renders_ansi_as_styled_spans() {
    let messages = vec![
        CellView::local_command("shell · stdout".into(), CommandStatus::Running, None)
            .with_detail("plain \x1b[31mred\x1b[0m"),
    ];

    let lines = message_lines(&messages, test_context());
    let output = &lines[1];
    let visible = output
        .spans
        .iter()
        .map(|span| span.content.as_ref() as &str)
        .collect::<String>();

    assert_eq!(visible, "└─ plain red");
    assert!(
        output
            .spans
            .iter()
            .any(|span| span.content == "red" && span.style.fg == Some(Color::Red))
    );
    assert!(!visible.contains('\x1b'));
}

#[test]
fn renderable_measurement_uses_the_same_wrapped_message_rows_as_drawing() {
    let messages = vec![CellView::plain(
        MessageRole::Agent,
        "a response that wraps at narrow widths".into(),
    )];
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };

    assert!(view.desired_height(12, test_context()) > view.desired_height(80, test_context()));
}

#[test]
fn multiline_content_uses_the_same_continuation_prefix_for_measurement_and_drawing() {
    let messages = vec![CellView::plain(
        MessageRole::Agent,
        "first line\nsecond line".into(),
    )];

    let lines = message_lines(&messages, test_context());

    assert_eq!(lines[0].to_string(), "● first line");
    assert_eq!(lines[1].to_string(), "  second line");
}

#[test]
fn execution_output_uses_a_solid_circle_with_semantic_color() {
    let cases = [
        (
            CellView::plain(MessageRole::Agent, "answer".into()),
            test_context().muted(),
        ),
        (
            CellView::exec("shell", CommandStatus::Succeeded),
            test_context().success(),
        ),
        (
            CellView::exec("write_file", CommandStatus::Failed),
            test_context().danger(),
        ),
        (
            CellView::exec("write_file", CommandStatus::Succeeded),
            test_context().accent(),
        ),
        (
            CellView::exec("shell", CommandStatus::Running),
            test_context().warning(),
        ),
    ];

    for (message, color) in cases {
        let lines = message_lines(std::slice::from_ref(&message), test_context());
        assert_eq!(lines[0].spans[0].content, "● ");
        assert_eq!(lines[0].spans[0].style.fg, Some(color));
    }
}

#[test]
fn local_command_uses_the_user_marker_except_while_running() {
    let cases = [
        (CommandStatus::Submitted, "> ", test_context().muted()),
        (CommandStatus::Running, "● ", test_context().warning()),
        (CommandStatus::Succeeded, "> ", test_context().muted()),
        (CommandStatus::Failed, "> ", test_context().muted()),
    ];

    for (status, marker, color) in cases {
        let message = CellView::local_command("/theme ash-code-dark".into(), status, None);
        let messages = [message];
        let lines = message_lines(&messages, test_context());

        assert_eq!(lines[0].spans[0].content, marker);
        assert_eq!(lines[0].spans[0].style.fg, Some(color));
    }
}

#[test]
fn expanded_output_uses_its_detail_branch_instead_of_a_disclosure_marker() {
    let message = CellView::local_command("write_file".into(), CommandStatus::Succeeded, None)
        .with_detail("write_file [call]")
        .with_presentation(true, false);

    let messages = [message];
    let lines = message_lines(&messages, test_context());

    assert_eq!(lines[0].to_string(), "> write_file");
    assert_eq!(lines[1].to_string(), "└─ write_file [call]");
}

#[test]
fn user_message_starts_in_the_symbol_column_and_fills_the_content_row() {
    let messages = vec![
        CellView::plain(MessageRole::User, "hello".into())
            .with_cell_id("user-message")
            .with_render_revision(1),
    ];
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(12, 2)).unwrap();

    terminal
        .draw(|frame| view.render(frame, frame.area(), test_context()))
        .unwrap();

    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), ">");
    assert_eq!(buffer[(0, 0)].fg, test_context().muted());
    assert_eq!(buffer[(2, 0)].symbol(), "h");
    assert_eq!(buffer[(0, 0)].bg, test_context().user_message_background());
    assert_eq!(buffer[(11, 0)].bg, test_context().user_message_background());
    assert_eq!(buffer[(0, 1)].bg, test_context().background());
    assert_eq!(buffer[(11, 1)].bg, test_context().background());
}

#[test]
fn local_command_fills_only_its_input_rows() {
    let messages = vec![
        CellView::local_command("/config".into(), CommandStatus::Succeeded, None)
            .with_detail("done")
            .with_cell_id("local-command")
            .with_render_revision(1),
    ];
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();

    terminal
        .draw(|frame| view.render(frame, frame.area(), test_context()))
        .unwrap();

    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), ">");
    assert_eq!(buffer[(0, 0)].bg, test_context().user_message_background());
    assert_eq!(buffer[(11, 0)].bg, test_context().user_message_background());
    assert_eq!(buffer[(0, 1)].symbol(), "└");
    assert_eq!(buffer[(0, 1)].bg, test_context().background());
    assert_eq!(buffer[(11, 1)].bg, test_context().background());
    assert_eq!(buffer[(0, 2)].bg, test_context().background());
}

#[test]
fn selected_transcript_cell_uses_the_shared_selection_style() {
    let messages =
        vec![CellView::plain(MessageRole::Agent, "selected".into()).with_presentation(false, true)];

    let lines = message_lines(&messages, test_context());
    let body = &lines[0].spans[1];

    assert_eq!(body.style.fg, Some(test_context().selection_foreground()));
    assert_eq!(body.style.bg, Some(test_context().selection_background()));
}

#[test]
fn transcript_actions_apply_hover_and_pressed_feedback_after_cache_reuse() {
    let messages = vec![
        CellView::plain(
            MessageRole::Reasoning,
            "first thought\nsecond thought".into(),
        )
        .with_cell_id("reasoning")
        .with_render_revision(1)
        .with_presentation(false, false),
    ];
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let mut terminal = Terminal::new(TestBackend::new(30, 4)).unwrap();

    let hovered = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState {
            hovered_toggle: Some("reasoning"),
            ..Default::default()
        },
    };
    assert_eq!(
        hovered.pointer_target_at(
            Rect::new(0, 0, 30, 4),
            ratatui::layout::Position::new(0, 0),
            test_context(),
        ),
        Some(ChatHistoryPointerTarget::Toggle("reasoning".into()))
    );
    terminal
        .draw(|frame| hovered.render(frame, frame.area(), test_context()))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].bg,
        test_context().hover_background()
    );

    let pressed = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        pointer: ChatHistoryPointerState {
            pressed_toggle: Some("reasoning"),
            ..Default::default()
        },
        ..hovered
    };
    terminal
        .draw(|frame| pressed.render(frame, frame.area(), test_context()))
        .unwrap();
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].bg,
        test_context().pressed_background()
    );
}

#[test]
fn multiline_command_output_keeps_detail_prefix_alignment() {
    let messages = vec![
        CellView::local_command("printf hi".into(), CommandStatus::Succeeded, None)
            .with_detail("one\ntwo"),
    ];

    let lines = message_lines(&messages, test_context());

    assert_eq!(lines[1].to_string(), "└─ one");
    assert_eq!(lines[2].to_string(), "   two");
}

#[test]
fn wrapped_details_link_remains_visible_in_a_narrow_terminal() {
    let messages = vec![
        CellView::plain(MessageRole::Reasoning, "line\n".repeat(14))
            .with_cell_id("reasoning")
            .with_render_revision(1)
            .with_presentation(true, false),
    ];
    let area = Rect::new(0, 0, 8, 60);
    let scroll = ChatHistoryScroll::default();
    let cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &cache,
        pointer: Default::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| view.render(frame, area, test_context()))
        .unwrap();
    let row = (0..area.height)
        .find(|&row| {
            (0..area.width)
                .map(|column| terminal.backend().buffer()[(column, row)].symbol())
                .collect::<String>()
                .starts_with("   view")
        })
        .expect("the details link is visible");
    assert_eq!(
        view.pointer_target_at(
            area,
            ratatui::layout::Position::new(area.right() - 1, row),
            test_context(),
        ),
        Some(ChatHistoryPointerTarget::Details("reasoning".into()))
    );
}

#[test]
fn long_transcripts_buffer_only_visible_cells() {
    let messages = (0..300)
        .map(|index| {
            CellView::plain(MessageRole::Agent, format!("message {index}"))
                .with_cell_id(format!("agent-{index}"))
                .with_render_revision(1)
        })
        .collect::<Vec<_>>();
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();

    terminal
        .draw(|frame| view.render(frame, frame.area(), test_context()))
        .unwrap();

    assert!(render_cache.entry_count() <= 3);
}

#[test]
fn follow_latest_reaches_content_beyond_the_u16_row_range() {
    let mut text = "line\n".repeat(usize::from(u16::MAX) + 10);
    text.push_str("visible tail");
    let messages = vec![
        CellView::plain(MessageRole::Agent, text)
            .with_cell_id("long-agent")
            .with_render_revision(1),
    ];
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(40, 3)).unwrap();

    terminal
        .draw(|frame| view.render(frame, frame.area(), test_context()))
        .unwrap();
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();

    assert!(rendered.contains("visible tail"));
}

#[test]
fn scrolled_transcript_draws_a_themed_jump_control_inside_its_bottom_row() {
    let messages = (0..8)
        .map(|index| {
            CellView::plain(MessageRole::Agent, format!("message {index}"))
                .with_cell_id(format!("message-{index}"))
        })
        .collect::<Vec<_>>();
    let mut scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let area = Rect::new(0, 0, 40, 6);
    let target = scroll_target(
        area,
        0,
        &messages,
        &scroll,
        &render_cache,
        test_context(),
        TranscriptScrollDirection::Up,
        5,
    )
    .unwrap();
    assert!(scroll.apply(target));
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: None,
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();

    terminal
        .draw(|frame| view.render(frame, area, test_context()))
        .unwrap();

    let label = "Ctrl+End to jump to bottom ↓";
    let start = (area.width - u16::try_from(label.chars().count()).unwrap()) / 2;
    let buffer = terminal.backend().buffer();
    let row = (0..area.width)
        .map(|x| buffer[(x, area.bottom() - 1)].symbol())
        .collect::<String>();
    assert!(row.contains(label));
    assert_eq!(
        buffer[(start, area.bottom() - 1)].bg,
        test_context().transcript_jump_background()
    );
}

#[test]
fn scrolling_to_the_start_reveals_the_history_header_before_messages() {
    let area = Rect::new(0, 0, 40, 6);
    let mut header = Buffer::empty(Rect::new(0, 0, area.width, 3));
    header.set_string(0, 0, "welcome header", Color::Reset);
    let messages = (0..8)
        .map(|index| {
            CellView::plain(MessageRole::Agent, format!("message {index}"))
                .with_cell_id(format!("message-{index}"))
        })
        .collect::<Vec<_>>();
    let mut scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();

    assert_eq!(
        first_scroll_target(true, &messages),
        Some(TranscriptScrollTarget::Anchor(
            TranscriptScrollAnchor::Header { line_offset: 0 }
        ))
    );
    scroll.apply(first_scroll_target(true, &messages).unwrap());
    let view = ChatHistoryView {
        jump_label: "Ctrl+End to jump to bottom ↓",
        header: Some(&header),
        messages: &messages,
        scroll: &scroll,
        render_cache: &render_cache,
        pointer: ChatHistoryPointerState::default(),
    };
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();

    terminal
        .draw(|frame| view.render(frame, area, test_context()))
        .unwrap();

    let first_row = (0..area.width)
        .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
        .collect::<String>();
    assert!(first_row.starts_with("welcome header"));
}

#[test]
fn transcript_changes_do_not_move_a_manually_scrolled_viewport() {
    let mut messages = (0..12)
        .map(|index| {
            CellView::plain(MessageRole::Agent, format!("message {index}"))
                .with_cell_id(format!("message-{index}"))
        })
        .collect::<Vec<_>>();
    let area = Rect::new(0, 0, 40, 6);
    let render_cache = ChatHistoryRenderCache::default();
    let mut scroll = ChatHistoryScroll::default();
    let target = scroll_target(
        area,
        0,
        &messages,
        &scroll,
        &render_cache,
        test_context(),
        TranscriptScrollDirection::Up,
        5,
    )
    .unwrap();
    assert!(scroll.apply(target));

    let first_row = render_first_row(area, &messages, &scroll, &render_cache);
    messages.extend((12..16).map(|index| {
        CellView::plain(MessageRole::Agent, format!("message {index}"))
            .with_cell_id(format!("message-{index}"))
    }));
    let first_row_after_append = render_first_row(area, &messages, &scroll, &render_cache);
    messages.splice(
        0..0,
        (0..4).map(|index| {
            CellView::plain(MessageRole::Agent, format!("older {index}"))
                .with_cell_id(format!("older-{index}"))
        }),
    );
    let first_row_after_prepend = render_first_row(area, &messages, &scroll, &render_cache);
    let first_row_after_resize = render_first_row(
        Rect::new(0, 0, 16, area.height),
        &messages,
        &scroll,
        &render_cache,
    );

    assert!(first_row.contains("message 7"));
    assert_eq!(first_row_after_append, first_row);
    assert_eq!(first_row_after_prepend, first_row);
    assert!(first_row_after_resize.contains("message 7"));
}

#[test]
fn manual_scroll_keeps_the_anchored_line_visible_during_streaming_growth() {
    let area = Rect::new(0, 0, 40, 6);
    let render_cache = ChatHistoryRenderCache::default();
    let mut scroll = ChatHistoryScroll::default();
    let mut messages = vec![
        CellView::plain(
            MessageRole::Agent,
            (0..20)
                .map(|index| format!("line {index}"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .with_cell_id("streaming-message"),
    ];
    let target = scroll_target(
        area,
        0,
        &messages,
        &scroll,
        &render_cache,
        test_context(),
        TranscriptScrollDirection::Up,
        5,
    )
    .unwrap();
    assert!(scroll.apply(target));

    let first_row = render_first_row(area, &messages, &scroll, &render_cache);
    messages[0] = CellView::plain(
        MessageRole::Agent,
        (0..30)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .with_cell_id("streaming-message");

    assert!(first_row.contains("line 10"));
    assert_eq!(
        render_first_row(area, &messages, &scroll, &render_cache),
        first_row
    );
}

#[test]
fn jump_control_is_hidden_while_following_the_latest_content() {
    let messages = (0..8)
        .map(|index| CellView::plain(MessageRole::Agent, format!("message {index}")))
        .collect::<Vec<_>>();
    let scroll = ChatHistoryScroll::default();
    let render_cache = ChatHistoryRenderCache::default();
    let area = Rect::new(0, 0, 40, 6);
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            ChatHistoryView {
                jump_label: "Ctrl+End to jump to bottom ↓",
                header: None,
                messages: &messages,
                scroll: &scroll,
                render_cache: &render_cache,
                pointer: Default::default(),
            }
            .render(frame, area, test_context())
        })
        .unwrap();
    assert!(!terminal.backend().to_string().contains("jump to bottom"));
}

fn render_first_row(
    area: Rect,
    messages: &[CellView<'_>],
    scroll: &ChatHistoryScroll,
    render_cache: &ChatHistoryRenderCache,
) -> String {
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| {
            ChatHistoryView {
                jump_label: "Ctrl+End to jump to bottom ↓",
                header: None,
                messages,
                scroll,
                render_cache,
                pointer: ChatHistoryPointerState::default(),
            }
            .render(frame, area, test_context())
        })
        .unwrap();
    (0..area.width)
        .map(|column| terminal.backend().buffer()[(column, 0)].symbol())
        .collect()
}
