use super::*;
use crate::render::test_context;
use crate::thread::status_indicator::StatusTimer;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use std::time::Duration;
use std::time::Instant;

#[test]
fn status_indicator_renders_waiting_and_deterministic_activity() {
    let now = Instant::now();
    let mut timer = StatusTimer::default();
    timer.start(now);
    timer.tick(now + Duration::from_millis(65100));
    let mut terminal = Terminal::new(TestBackend::new(80, 3)).unwrap();
    terminal
        .draw(|frame| {
            for (row, activity) in [
                TurnActivity::Working,
                TurnActivity::WaitingForApproval,
                TurnActivity::Cancelling,
            ]
            .into_iter()
            .enumerate()
            {
                StatusIndicator {
                    activity,
                    timer: &timer,
                    interrupt_hint: (activity != TurnActivity::Cancelling).then(|| "ctrl+c".into()),
                    show_tips: false,
                }
                .draw(frame, Rect::new(0, row as u16, 80, 1), test_context());
            }
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    assert_eq!(buffer[(0, 0)].symbol(), "⠙");
    assert_eq!(buffer[(0, 1)].symbol(), "○");
    assert_eq!(buffer[(0, 0)].fg, test_context().accent());
    assert_eq!(buffer[(0, 1)].fg, test_context().warning());
    assert_eq!(buffer[(2, 0)].symbol(), "W");
    let text = (0..3)
        .map(|y| {
            (0..80)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("status_indicator_phases", text);
}

#[test]
fn status_indicator_narrow_row_preserves_interrupt_hint() {
    let timer = StatusTimer::default();
    let mut terminal = Terminal::new(TestBackend::new(32, 1)).unwrap();
    terminal
        .draw(|frame| {
            StatusIndicator {
                activity: TurnActivity::Working,
                timer: &timer,
                interrupt_hint: Some("ctrl+c".into()),
                show_tips: false,
            }
            .draw(frame, frame.area(), test_context())
        })
        .unwrap();
    let text = (0..32)
        .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
        .collect::<String>();
    assert!(text.contains("ctrl+c to interrupt"));
    assert!(!text.contains("total"));
}

#[test]
fn tips_appear_below_the_running_indicator_and_stop_while_waiting() {
    let started = Instant::now();
    let mut timer = StatusTimer::default();
    timer.start(started);
    timer.tick(started + Duration::from_secs(7));
    fn working(timer: &StatusTimer) -> StatusIndicator<'_> {
        StatusIndicator {
            activity: TurnActivity::Working,
            timer,
            interrupt_hint: Some("ctrl+c".into()),
            show_tips: true,
        }
    }
    assert_eq!(working(&timer).desired_height(), 1);
    timer.tick(started + Duration::from_secs(8));
    assert_eq!(working(&timer).desired_height(), 2);
    let mut terminal = Terminal::new(TestBackend::new(80, 2)).unwrap();
    terminal
        .draw(|frame| working(&timer).draw(frame, frame.area(), test_context()))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let first = (0..80).map(|x| buffer[(x, 0)].symbol()).collect::<String>();
    let second = (0..80).map(|x| buffer[(x, 1)].symbol()).collect::<String>();
    assert!(first.contains("Working"));
    assert!(second.starts_with("└ Tip: Ask Ash to list steps for complex tasks"));

    timer.tick(started + Duration::from_secs(120));
    assert_eq!(working(&timer).tip(), Some(crate::nls::Message::TipPlan));
    let waiting = StatusIndicator {
        activity: TurnActivity::WaitingForApproval,
        timer: &timer,
        interrupt_hint: None,
        show_tips: true,
    };
    assert_eq!(waiting.desired_height(), 1);
    assert_eq!(waiting.tip(), None);
    let disabled = StatusIndicator {
        show_tips: false,
        ..working(&timer)
    };
    assert_eq!(disabled.desired_height(), 1);

    for run in 2..=4 {
        timer.clear();
        let next_start = started + Duration::from_secs(run * 150);
        timer.start(next_start);
        timer.tick(next_start + Duration::from_secs(8));
        let expected = if run < 4 {
            crate::nls::Message::TipPlan
        } else {
            crate::nls::Message::TipHelp
        };
        assert_eq!(working(&timer).tip(), Some(expected));
    }
}
