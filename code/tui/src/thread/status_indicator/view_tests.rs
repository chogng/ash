use super::*;
use crate::render::test_context;
use crate::thread::TurnActivity;
use crate::thread::status_indicator::StatusTimer;
use ash_protocol::TurnId;
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
fn status_indicator_localizes_every_activity() {
    let mut terminal = Terminal::new(TestBackend::new(80, 6)).unwrap();
    let timer = StatusTimer::default();
    terminal
        .draw(|frame| {
            for (row, activity) in [
                TurnActivity::Starting,
                TurnActivity::Working,
                TurnActivity::WaitingForApproval,
                TurnActivity::WaitingForUserInput,
                TurnActivity::WaitingForCapability,
                TurnActivity::Cancelling,
            ]
            .into_iter()
            .enumerate()
            {
                StatusIndicator {
                    activity,
                    timer: &timer,
                    interrupt_hint: None,
                    show_tips: false,
                }
                .draw(
                    frame,
                    Rect::new(0, row as u16, 80, 1),
                    test_context().with_language(crate::nls::Language::Chinese),
                );
            }
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let text = (0..6)
        .map(|y| {
            let mut line = String::new();
            let mut continuation = 0;
            for x in 0..80 {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                line.push_str(symbol);
                continuation = unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
            }
            line.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("status_indicator_chinese_activities", text);
}

#[test]
fn spinner_verb_changes_between_turns_and_stays_fixed_during_a_turn() {
    let now = Instant::now();
    let mut timer = StatusTimer::default();
    let word_count = crate::nls::spinner_verb_count();
    let mut terminal = Terminal::new(TestBackend::new(80, word_count as u16)).unwrap();
    terminal
        .draw(|frame| {
            for row in 0..word_count {
                let expected = crate::nls::spinner_verb(row);
                let started = now + Duration::from_secs(row as u64 * 90);
                timer.bind_turn(&TurnId::new(format!("word-{row}")).unwrap(), started);
                let indicator = StatusIndicator {
                    activity: TurnActivity::Working,
                    timer: &timer,
                    interrupt_hint: None,
                    show_tips: false,
                };
                assert_eq!(indicator.label().0, expected);
                for language in [
                    crate::nls::Language::Japanese,
                    crate::nls::Language::Chinese,
                    crate::nls::Language::French,
                ] {
                    assert_ne!(crate::nls::localize(language, expected), expected);
                }
                indicator.draw(
                    frame,
                    Rect::new(0, row as u16, 80, 1),
                    test_context().with_language(crate::nls::Language::Chinese),
                );
                timer.tick(started + Duration::from_secs(65));
                assert_eq!(
                    StatusIndicator {
                        activity: TurnActivity::Working,
                        timer: &timer,
                        interrupt_hint: None,
                        show_tips: false,
                    }
                    .label()
                    .0,
                    expected
                );
            }
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let text = (0..word_count as u16)
        .map(|y| {
            let mut line = String::new();
            let mut continuation = 0;
            for x in 0..80 {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                line.push_str(symbol);
                continuation = unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
            }
            line.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("spinner_verbs_across_turns_chinese", text);
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
fn long_spinner_verb_keeps_interrupt_hint_visible() {
    let now = Instant::now();
    let mut timer = StatusTimer::default();
    let index = (0..crate::nls::spinner_verb_count())
        .find(|&index| crate::nls::spinner_verb(index) == "Brainstorming")
        .unwrap();
    for run in 0..=index {
        timer.bind_turn(&TurnId::new(format!("long-word-{run}")).unwrap(), now);
    }
    let mut terminal = Terminal::new(TestBackend::new(32, 1)).unwrap();
    terminal
        .draw(|frame| {
            StatusIndicator {
                activity: TurnActivity::Working,
                timer: &timer,
                interrupt_hint: Some("ctrl+c".into()),
                show_tips: false,
            }
            .draw(frame, frame.area(), test_context());
        })
        .unwrap();
    let rendered = (0..32)
        .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
        .collect::<String>();
    assert!(rendered.contains("… · ctrl+c to interrupt"), "{rendered}");
    crate::tui_assert_snapshot!("long_spinner_verb_narrow", rendered.trim_end());
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
