use super::TerminalModeGuard;
use super::TerminalModeOperations;
use crate::terminal::MouseMode;
use crate::terminal::ScreenMode;
use std::cell::RefCell;
use std::io;
use std::rc::Rc;

const ENABLE_RAW_MODE: &str = "enable raw mode";
const BEGIN_SCREEN: &str = "begin screen";
const ENABLE_BRACKETED_PASTE: &str = "enable bracketed paste";
const ENABLE_FOCUS_CHANGE: &str = "enable focus change";
const ENABLE_MOUSE_CAPTURE: &str = "enable mouse capture";
const DISABLE_MOUSE_CAPTURE: &str = "disable mouse capture";
const DISABLE_FOCUS_CHANGE: &str = "disable focus change";
const DISABLE_BRACKETED_PASTE: &str = "disable bracketed paste";
const FINISH_SCREEN: &str = "finish screen";
const DISABLE_RAW_MODE: &str = "disable raw mode";

#[test]
fn startup_error_preserves_failure_kind_and_reports_terminal_facts() {
    use ash_terminal_detection::ColorLevel;
    use ash_terminal_detection::HostTerminal;
    use ash_terminal_detection::TerminalKind;
    use ash_terminal_detection::TerminalMultiplexer;
    let host = HostTerminal {
        kind: TerminalKind::WezTerm,
        program: Some("tmux".into()),
        version: Some("2026.1".into()),
        term: Some("xterm-256color".into()),
        multiplexer: Some(TerminalMultiplexer::Tmux {
            version: Some("3.5".into()),
        }),
        color_level: ColorLevel::Ansi256,
    };
    let error = super::startup_error(
        &host,
        "set terminal modes",
        io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
    );
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(
        std::error::Error::source(error.get_ref().unwrap())
            .unwrap()
            .to_string(),
        "denied"
    );
    crate::tui_assert_snapshot!(error.to_string(), @r###"cannot set terminal modes: denied; terminal=WezTerm, version=Some("2026.1"), multiplexer=Some(Tmux { version: Some("3.5") }), TERM=Some("xterm-256color"), color=Ansi256"###);
}

#[test]
fn main_screen_keeps_mouse_and_screen_with_the_terminal_across_resume() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut guard =
        TerminalModeGuard::acquire(FakeOperations::new(calls.clone(), None), ScreenMode::Inline)
            .unwrap();
    guard.set_mouse_mode(MouseMode::TuiCapture).unwrap();
    guard.restore();
    guard.reacquire().unwrap();
    drop(guard);
    let lifecycle = [
        ENABLE_RAW_MODE,
        ENABLE_BRACKETED_PASTE,
        ENABLE_FOCUS_CHANGE,
        DISABLE_FOCUS_CHANGE,
        DISABLE_BRACKETED_PASTE,
        DISABLE_RAW_MODE,
    ];
    assert_eq!(calls.borrow().as_slice(), lifecycle.repeat(2));
}

#[test]
fn main_screen_failure_restores_only_acquired_input_modes() {
    for (failure, expected) in [
        (ENABLE_RAW_MODE, vec![ENABLE_RAW_MODE]),
        (
            ENABLE_BRACKETED_PASTE,
            vec![ENABLE_RAW_MODE, ENABLE_BRACKETED_PASTE, DISABLE_RAW_MODE],
        ),
        (
            ENABLE_FOCUS_CHANGE,
            vec![
                ENABLE_RAW_MODE,
                ENABLE_BRACKETED_PASTE,
                ENABLE_FOCUS_CHANGE,
                DISABLE_BRACKETED_PASTE,
                DISABLE_RAW_MODE,
            ],
        ),
    ] {
        let calls = Rc::new(RefCell::new(Vec::new()));
        assert!(
            TerminalModeGuard::acquire(
                FakeOperations::new(calls.clone(), Some(failure)),
                ScreenMode::Inline
            )
            .is_err()
        );
        assert_eq!(*calls.borrow(), expected);
    }
}

#[test]
fn cursor_color_updates_once_and_resets_before_reapplication() {
    let mut color = super::CursorColor::default();
    let mut output = Vec::new();
    color.set(&mut output, Some([0x66, 0x58, 0xc7])).unwrap();
    color.set(&mut output, Some([0x66, 0x58, 0xc7])).unwrap();
    color.set(&mut output, None).unwrap();
    color.set(&mut output, None).unwrap();
    color.set(&mut output, Some([0x11, 0x22, 0x33])).unwrap();
    assert_eq!(
        output,
        b"\x1b]12;#6658c7\x1b\\\x1b]112\x1b\\\x1b]12;#112233\x1b\\"
    );
}

#[test]
fn acquired_terminal_modes_are_restored_in_reverse_order() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let guard = TerminalModeGuard::acquire(
        FakeOperations::new(calls.clone(), None),
        ScreenMode::Fullscreen,
    )
    .expect("acquire");

    drop(guard);

    assert_eq!(
        calls.borrow().as_slice(),
        [
            ENABLE_RAW_MODE,
            BEGIN_SCREEN,
            ENABLE_BRACKETED_PASTE,
            ENABLE_FOCUS_CHANGE,
            DISABLE_FOCUS_CHANGE,
            DISABLE_BRACKETED_PASTE,
            FINISH_SCREEN,
            DISABLE_RAW_MODE,
        ]
    );
}

#[test]
fn acquisition_failure_restores_only_modes_that_were_acquired() {
    let cases = [
        (ENABLE_RAW_MODE, vec![ENABLE_RAW_MODE]),
        (
            BEGIN_SCREEN,
            vec![ENABLE_RAW_MODE, BEGIN_SCREEN, DISABLE_RAW_MODE],
        ),
        (
            ENABLE_BRACKETED_PASTE,
            vec![
                ENABLE_RAW_MODE,
                BEGIN_SCREEN,
                ENABLE_BRACKETED_PASTE,
                FINISH_SCREEN,
                DISABLE_RAW_MODE,
            ],
        ),
        (
            ENABLE_FOCUS_CHANGE,
            vec![
                ENABLE_RAW_MODE,
                BEGIN_SCREEN,
                ENABLE_BRACKETED_PASTE,
                ENABLE_FOCUS_CHANGE,
                DISABLE_BRACKETED_PASTE,
                FINISH_SCREEN,
                DISABLE_RAW_MODE,
            ],
        ),
    ];

    for (failure, expected_calls) in cases {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let result = TerminalModeGuard::acquire(
            FakeOperations::new(calls.clone(), Some(failure)),
            ScreenMode::Fullscreen,
        );

        assert!(result.is_err(), "{failure} should fail");
        assert_eq!(
            calls.borrow().as_slice(),
            expected_calls,
            "unexpected rollback for {failure}"
        );
    }
}

#[test]
fn mouse_mode_is_applied_idempotently() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut guard = TerminalModeGuard::acquire(
        FakeOperations::new(calls.clone(), None),
        ScreenMode::Fullscreen,
    )
    .expect("acquire");

    guard
        .set_mouse_mode(MouseMode::TuiCapture)
        .expect("enable TUI pointer capture");
    guard
        .set_mouse_mode(MouseMode::TuiCapture)
        .expect("keep TUI pointer capture enabled");
    guard
        .set_mouse_mode(MouseMode::TerminalSelection)
        .expect("restore terminal selection");
    drop(guard);

    assert_eq!(
        calls.borrow().as_slice(),
        [
            ENABLE_RAW_MODE,
            BEGIN_SCREEN,
            ENABLE_BRACKETED_PASTE,
            ENABLE_FOCUS_CHANGE,
            ENABLE_MOUSE_CAPTURE,
            DISABLE_MOUSE_CAPTURE,
            DISABLE_FOCUS_CHANGE,
            DISABLE_BRACKETED_PASTE,
            FINISH_SCREEN,
            DISABLE_RAW_MODE,
        ]
    );
}

#[test]
fn explicit_restore_is_idempotent() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut guard = TerminalModeGuard::acquire(
        FakeOperations::new(calls.clone(), None),
        ScreenMode::Fullscreen,
    )
    .expect("acquire");

    guard.restore();
    guard.restore();
    drop(guard);

    assert_eq!(
        calls.borrow().as_slice(),
        [
            ENABLE_RAW_MODE,
            BEGIN_SCREEN,
            ENABLE_BRACKETED_PASTE,
            ENABLE_FOCUS_CHANGE,
            DISABLE_FOCUS_CHANGE,
            DISABLE_BRACKETED_PASTE,
            FINISH_SCREEN,
            DISABLE_RAW_MODE,
        ]
    );
}

#[test]
fn suspend_cycle_reacquires_fullscreen_mouse_capture() {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let mut guard = TerminalModeGuard::acquire(
        FakeOperations::new(calls.clone(), None),
        ScreenMode::Fullscreen,
    )
    .expect("acquire");

    guard
        .set_mouse_mode(MouseMode::TuiCapture)
        .expect("enable fullscreen mouse capture");
    guard.restore();
    guard.reacquire().expect("reacquire");
    drop(guard);

    assert_eq!(
        calls.borrow().as_slice(),
        [
            ENABLE_RAW_MODE,
            BEGIN_SCREEN,
            ENABLE_BRACKETED_PASTE,
            ENABLE_FOCUS_CHANGE,
            ENABLE_MOUSE_CAPTURE,
            DISABLE_MOUSE_CAPTURE,
            DISABLE_FOCUS_CHANGE,
            DISABLE_BRACKETED_PASTE,
            FINISH_SCREEN,
            DISABLE_RAW_MODE,
            ENABLE_RAW_MODE,
            BEGIN_SCREEN,
            ENABLE_BRACKETED_PASTE,
            ENABLE_FOCUS_CHANGE,
            ENABLE_MOUSE_CAPTURE,
            DISABLE_MOUSE_CAPTURE,
            DISABLE_FOCUS_CHANGE,
            DISABLE_BRACKETED_PASTE,
            FINISH_SCREEN,
            DISABLE_RAW_MODE,
        ]
    );
}

struct FakeOperations {
    calls: Rc<RefCell<Vec<&'static str>>>,
    failure: Option<&'static str>,
}

impl FakeOperations {
    fn new(calls: Rc<RefCell<Vec<&'static str>>>, failure: Option<&'static str>) -> Self {
        Self { calls, failure }
    }

    fn call(&self, operation: &'static str) -> io::Result<()> {
        self.calls.borrow_mut().push(operation);
        if self.failure == Some(operation) {
            Err(io::Error::other(format!("{operation} failed")))
        } else {
            Ok(())
        }
    }
}

impl TerminalModeOperations for FakeOperations {
    fn enable_raw_mode(&mut self) -> io::Result<()> {
        self.call(ENABLE_RAW_MODE)
    }

    fn begin_screen(&mut self) -> io::Result<()> {
        self.call(BEGIN_SCREEN)
    }

    fn enable_bracketed_paste(&mut self) -> io::Result<()> {
        self.call(ENABLE_BRACKETED_PASTE)
    }

    fn enable_focus_change(&mut self) -> io::Result<()> {
        self.call(ENABLE_FOCUS_CHANGE)
    }

    fn enable_mouse_capture(&mut self) -> io::Result<()> {
        self.call(ENABLE_MOUSE_CAPTURE)
    }

    fn disable_mouse_capture(&mut self) -> io::Result<()> {
        self.call(DISABLE_MOUSE_CAPTURE)
    }

    fn disable_focus_change(&mut self) -> io::Result<()> {
        self.call(DISABLE_FOCUS_CHANGE)
    }

    fn disable_bracketed_paste(&mut self) -> io::Result<()> {
        self.call(DISABLE_BRACKETED_PASTE)
    }

    fn finish_screen(&mut self) -> io::Result<()> {
        self.call(FINISH_SCREEN)
    }

    fn disable_raw_mode(&mut self) -> io::Result<()> {
        self.call(DISABLE_RAW_MODE)
    }
}

#[test]
fn screen_protocol_disables_alternate_scroll_while_active_and_on_exit() {
    let mut output = Vec::new();
    super::enter_screen(&mut output).unwrap();
    super::leave_screen(&mut output).unwrap();
    assert_eq!(
        output,
        b"\x1b[?1049h\x1b[?1007s\x1b[?1007l\x1b[?1007r\x1b[?1049l"
    );
    assert!(!output.contains(&b'\n'));
}
