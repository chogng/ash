use super::AppServerResourcesView;
use super::ProcessMemoryCurrent;
use super::ProcessResourcesView;
use super::RemainingContextWindow;
use super::StatusPanelOutcome;
use super::StatusViewData;
use super::status_panel;
use crate::memory::Status as MemoryDiagnosticsStatus;
use crate::render::horizontal_margin;
use crate::render::test_context;
use crate::status::AppServerProcessResourcesView;
use crate::status::ObservedProcessResourcesView;
use crate::status::ProcessCpuCurrent;
use crate::status::ProcessUsageView;
use ash_protocol::ModelMoneyAmount;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ModelUsageTotal;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;
use ratatui::style::Modifier;

#[test]
fn mouse_scroll_keeps_the_status_tab_and_clamps_to_its_content() {
    let usage = usage();
    let cost = reference_cost();
    let mut panel = panel(&usage, &cost);
    let area = Rect::new(0, 0, 80, 4);
    for _ in 0..100 {
        panel.scroll(crate::widgets::navigation::Navigation::Next, area);
    }
    assert_eq!(panel.tabs.active_index(), Some(0));
    assert_eq!(
        usize::from(panel.scroll[0]),
        panel.session.content_height(80) - 4
    );
    assert_eq!(panel.scroll[1], 0);
    for _ in 0..100 {
        panel.scroll(crate::widgets::navigation::Navigation::Previous, area);
    }
    assert_eq!(panel.scroll[0], 0);
}

#[test]
fn status_panel_exposes_model_accounting_context_and_conversation_identity() {
    let usage = usage();
    let reference_cost = reference_cost();
    let panel = panel(&usage, &reference_cost);

    assert_eq!(panel.title(), "Status");
    assert_eq!(
        panel
            .session
            .rows()
            .iter()
            .map(|row| (row.label(), row.value()))
            .collect::<Vec<_>>(),
        vec![
            ("Model", "openai/gpt"),
            ("Full context window", "1,000,000 tokens"),
            ("Available context window", "894,880 tokens"),
            ("Remaining context window", "~771,424 tokens (86.2%)"),
            ("Model calls", "4"),
            ("Input tokens", "10,000 tokens"),
            ("Cached input", "7,500 tokens"),
            ("Cached input share", "75.0%"),
            ("Cache writes", "500 tokens"),
            ("Output tokens", ">=1,200 tokens"),
            ("Reasoning output", "unknown"),
            ("Reference cost", "$0.01008"),
            ("Session ID", "session-1"),
            ("Thread ID", "thread-2"),
        ]
    );
}

#[test]
fn status_panel_requests_full_content_height_and_renders_bold_labels() {
    let usage = usage();
    let reference_cost = reference_cost();
    let panel = panel(&usage, &reference_cost);
    assert_eq!(desired_height(&panel, 100), 15);
    assert!(desired_height(&panel, 24) > desired_height(&panel, 100));
    let backend = TestBackend::new(100, desired_height(&panel, 100));
    let mut terminal = Terminal::new(backend).unwrap();

    terminal.draw(|frame| draw_panel(frame, &panel)).unwrap();

    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(3, 0)].symbol(), "T");
    assert_eq!(buffer[(2, 0)].symbol(), " ");
    assert_eq!(buffer[(10, 0)].symbol(), " ");
    assert_eq!(
        buffer[(3, 0)].fg,
        test_context().accent_surface_foreground()
    );
    assert_eq!(
        buffer[(3, 0)].bg,
        test_context().accent_surface_background()
    );
    assert_eq!(buffer[(2, 1)].symbol(), "M");
    assert!(buffer[(2, 1)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(7, 1)].symbol(), ":");
    assert!(buffer[(7, 1)].modifier.contains(Modifier::BOLD));
    assert_eq!(buffer[(28, 1)].symbol(), "o");
    assert!(!buffer[(28, 1)].modifier.contains(Modifier::BOLD));
}

#[test]
fn status_panel_updates_process_rows_without_resetting_each_tab_scroll() {
    let usage = usage();
    let reference_cost = reference_cost();
    let mut panel = panel(&usage, &reference_cost);
    panel.scroll = [7, 3];

    panel.apply_process_resources(ProcessResourcesView {
        local: ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(240 * 1024 * 1024),
            cpu: ProcessCpuCurrent::Available(124),
        },
        tui: ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(140 * 1024 * 1024),
            cpu: ProcessCpuCurrent::Available(84),
        },
        app_server: AppServerResourcesView::Local(AppServerProcessResourcesView {
            total: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(100 * 1024 * 1024),
                cpu: ProcessCpuCurrent::Available(40),
            },
            process: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(100 * 1024 * 1024),
                cpu: ProcessCpuCurrent::Available(40),
            },
            descendants: Vec::new(),
        }),
        observed_peak_bytes: Some(180 * 1024 * 1024),
        one_minute_change_bytes: Some(3 * 1024 * 1024),
        five_minute_change_bytes: None,
    });

    assert_eq!(panel.scroll, [7, 3]);
    panel.handle_key(
        KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
        Rect::new(2, 1, 76, 7),
    );
    assert_eq!(
        row_value(panel.processes.rows(), "Memory diagnostics"),
        "Disabled"
    );
    assert_eq!(
        row_value(panel.processes.rows(), "TUI resident memory"),
        "140.0 MiB"
    );
    assert_eq!(
        row_value(panel.processes.rows(), "Local total CPU"),
        "12.4%"
    );
    assert_eq!(
        row_value(panel.processes.rows(), "1 minute memory change"),
        "+3.0 MiB"
    );
    assert_eq!(
        row_value(panel.processes.rows(), "App Server total memory"),
        "100.0 MiB"
    );
    assert_eq!(
        row_value(panel.processes.rows(), "5 minute memory change"),
        "collecting"
    );
}

#[test]
fn process_tab_renders_local_total_and_owned_process_details() {
    let usage = usage();
    let reference_cost = reference_cost();
    let mut panel = panel(&usage, &reference_cost);
    panel.apply_process_resources(ProcessResourcesView {
        local: ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(240 * 1024 * 1024),
            cpu: ProcessCpuCurrent::Available(124),
        },
        tui: ProcessUsageView {
            memory: ProcessMemoryCurrent::Available(140 * 1024 * 1024),
            cpu: ProcessCpuCurrent::Available(84),
        },
        app_server: AppServerResourcesView::Local(AppServerProcessResourcesView {
            total: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(100 * 1024 * 1024),
                cpu: ProcessCpuCurrent::Available(40),
            },
            process: ProcessUsageView {
                memory: ProcessMemoryCurrent::Available(40 * 1024 * 1024),
                cpu: ProcessCpuCurrent::Available(10),
            },
            descendants: vec![
                ObservedProcessResourcesView {
                    process_id: 101,
                    depth: 1,
                    name: "rust-analyzer".into(),
                    usage: ProcessUsageView {
                        memory: ProcessMemoryCurrent::Available(50 * 1024 * 1024),
                        cpu: ProcessCpuCurrent::Available(25),
                    },
                },
                ObservedProcessResourcesView {
                    process_id: 102,
                    depth: 2,
                    name: "proc-macro-srv".into(),
                    usage: ProcessUsageView {
                        memory: ProcessMemoryCurrent::Available(10 * 1024 * 1024),
                        cpu: ProcessCpuCurrent::Available(5),
                    },
                },
            ],
        }),
        observed_peak_bytes: Some(260 * 1024 * 1024),
        one_minute_change_bytes: Some(3 * 1024 * 1024),
        five_minute_change_bytes: Some(-8 * i128::from(1024 * 1024)),
    });
    panel.apply_memory_diagnostics(MemoryDiagnosticsStatus::Recording);
    panel.handle_key(
        KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
        Rect::new(2, 1, 76, 7),
    );
    let backend = TestBackend::new(80, 15);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal.draw(|frame| draw_panel(frame, &panel)).unwrap();

    crate::tui_assert_snapshot!("status_processes_tab", terminal.backend().to_string());
}

#[test]
fn status_panel_scrolls_when_allocated_height_is_shorter_than_content() {
    let usage = usage();
    let reference_cost = reference_cost();
    let mut panel = panel(&usage, &reference_cost);
    let backend = TestBackend::new(80, 8);
    let mut terminal = Terminal::new(backend).unwrap();

    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    terminal.draw(|frame| draw_panel(frame, &panel)).unwrap();

    let rendered = terminal.backend().to_string();
    assert!(rendered.contains("Thread ID:"));
    assert!(!rendered.contains("Thread version:"));
    assert!(!rendered.contains("Full context window"));
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::Home, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Dismiss
    );
}

#[test]
fn status_panel_switches_tabs_with_keyboard() {
    let usage = usage();
    let reference_cost = reference_cost();
    let mut panel = panel(&usage, &reference_cost);
    let height_before = desired_height(&panel, 80);

    assert_eq!(panel.tabs.active_index(), Some(0));
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    assert_eq!(panel.tabs.active_index(), Some(1));
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::Left, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    assert_eq!(panel.tabs.active_index(), Some(0));
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    assert_eq!(panel.tabs.active_index(), Some(1));
    assert_eq!(
        panel.handle_key(
            KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
            Rect::new(2, 1, 76, 7)
        ),
        StatusPanelOutcome::Consumed
    );
    assert_eq!(panel.tabs.active_index(), Some(0));
    assert_eq!(desired_height(&panel, 80), height_before);
    assert_eq!(panel.key_hints().text(), "Tab to switch · Esc to close");
}

#[test]
fn status_panel_does_not_invent_a_cache_share_or_exact_cost() {
    let mut usage = usage();
    usage.cached_input_tokens.complete = false;
    let reference_cost = ModelReferenceCostSummary {
        known_amounts: vec![ModelMoneyAmount {
            currency: "USD".into(),
            pico_units: "1000000000".into(),
        }],
        complete: false,
    };
    let panel = panel(&usage, &reference_cost);
    let rows = panel.session.rows();

    assert_eq!(row_value(rows, "Cached input"), ">=7,500 tokens");
    assert_eq!(row_value(rows, "Cached input share"), "unknown");
    assert_eq!(row_value(rows, "Reference cost"), "≥$0.001");
}

fn panel<'a>(
    usage: &'a ModelUsageSummary,
    reference_cost: &'a ModelReferenceCostSummary,
) -> super::StatusPanel {
    status_panel(StatusViewData {
        model: "openai/gpt",
        full_context_window: Some(1_000_000),
        available_context_window: Some(894_880),
        remaining_context_window: RemainingContextWindow::Estimated {
            remaining_tokens: 771_424,
            available_tokens: 894_880,
        },
        usage,
        reference_cost,
        session_id: "thread:session-1",
        thread_id: "thread-2",
    })
}

fn desired_height(panel: &super::StatusPanel, width: u16) -> u16 {
    let content_width = width.saturating_sub(4);
    panel
        .tab_rows(content_width)
        .saturating_add(panel.body_rows(content_width))
}

fn draw_panel(frame: &mut Frame<'_>, panel: &super::StatusPanel) {
    let content = horizontal_margin(frame.area(), 2);
    let tab_rows = panel.tab_rows(content.width).min(content.height);
    let tabs = Rect::new(content.x, content.y, content.width, tab_rows);
    let body = Rect::new(
        content.x,
        content.y.saturating_add(tab_rows),
        content.width,
        content.height.saturating_sub(tab_rows),
    );
    panel.draw_tabs(frame, tabs, None, None, test_context());
    panel.draw_body(frame, body, test_context());
}

fn row_value<'a>(rows: &'a [crate::widgets::detail_list::DetailListRow], label: &str) -> &'a str {
    rows.iter()
        .find(|row| row.label() == label)
        .unwrap()
        .value()
}

fn reference_cost() -> ModelReferenceCostSummary {
    ModelReferenceCostSummary {
        known_amounts: vec![ModelMoneyAmount {
            currency: "USD".into(),
            pico_units: "10080000000".into(),
        }],
        complete: true,
    }
}

fn usage() -> ModelUsageSummary {
    ModelUsageSummary {
        model_invocations: 4,
        input_tokens: ModelUsageTotal {
            reported: 10_000,
            complete: true,
        },
        output_tokens: ModelUsageTotal {
            reported: 1_200,
            complete: false,
        },
        cached_input_tokens: ModelUsageTotal {
            reported: 7_500,
            complete: true,
        },
        cache_write_input_tokens: ModelUsageTotal {
            reported: 500,
            complete: true,
        },
        reasoning_tokens: ModelUsageTotal {
            reported: 0,
            complete: false,
        },
    }
}

#[test]
fn status_navigation_repeats_pages_by_the_viewport_and_keeps_each_tab_position() {
    let mut panel = panel(&usage(), &reference_cost());
    let area = Rect::new(0, 0, 80, 4);
    panel.handle_key(
        KeyEvent::new_with_kind(
            KeyCode::Char('j'),
            KeyModifiers::NONE,
            crossterm::event::KeyEventKind::Repeat,
        ),
        area,
    );
    assert_eq!(panel.scroll[0], 1);
    panel.handle_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE), area);
    assert_eq!(panel.scroll[0], 5);
    panel.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), area);
    panel.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT), area);
    assert_eq!(panel.scroll[0], 5);
    assert_eq!(
        panel.handle_key(
            KeyEvent::new_with_kind(
                KeyCode::Esc,
                KeyModifiers::NONE,
                crossterm::event::KeyEventKind::Repeat
            ),
            area
        ),
        StatusPanelOutcome::Consumed
    );
}
