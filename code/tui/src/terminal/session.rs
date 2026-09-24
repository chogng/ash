use crate::terminal::MouseMode;
use crate::terminal::ScreenMode;
use crate::terminal::text::ScreenSelectionRange;
use crate::terminal::text::line_range_at;
use crate::terminal::text::text_in_range;
use crate::terminal::text::token_range_at;
use ash_terminal_detection::TerminalRgb;
use ash_terminal_detection::detect_host_terminal;
use crossterm::ExecutableCommand;
use crossterm::event::DisableBracketedPaste;
use crossterm::event::DisableFocusChange;
use crossterm::event::DisableMouseCapture;
use crossterm::event::EnableBracketedPaste;
use crossterm::event::EnableFocusChange;
use crossterm::event::EnableMouseCapture;
use crossterm::terminal::EnterAlternateScreen;
use crossterm::terminal::LeaveAlternateScreen;
use crossterm::terminal::disable_raw_mode;
use crossterm::terminal::enable_raw_mode;
use ratatui::Terminal;
use ratatui::TerminalOptions;
use ratatui::Viewport;
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use std::io;
use std::io::Stdout;
use std::io::Write;

// Preserve the host setting while preventing wheel input from becoming arrow keys inside the TUI.
const SAVE_ALTERNATE_SCROLL: &[u8] = b"\x1b[?1007s";
const DISABLE_ALTERNATE_SCROLL: &[u8] = b"\x1b[?1007l";
const RESTORE_ALTERNATE_SCROLL: &[u8] = b"\x1b[?1007r";

pub(crate) struct TerminalSession {
    background_color: Option<TerminalRgb>,
    terminal: Terminal<CrosstermBackend<Stdout>>,
    modes: TerminalModeGuard<CrosstermModeOperations>,
    rendered_frame: Option<Buffer>,
    hyperlinks: super::hyperlinks::FrameLinks,
    cursor_color: CursorColor,
    inline_height: u16,
    inline_active: bool,
}

impl TerminalSession {
    pub(crate) fn open(mode: ScreenMode) -> io::Result<Self> {
        let host_terminal = detect_host_terminal();
        let modes = TerminalModeGuard::acquire(CrosstermModeOperations, mode)
            .map_err(|source| startup_error(&host_terminal, "set terminal modes", source))?;
        let background_color = super::terminal_probe::query_background(&host_terminal);
        let terminal = new_terminal(mode, 1)
            .map_err(|source| startup_error(&host_terminal, "create terminal", source))?;
        let mut session = Self {
            background_color,
            terminal,
            modes,
            rendered_frame: None,
            hyperlinks: Default::default(),
            cursor_color: CursorColor::default(),
            inline_height: 1,
            inline_active: mode == ScreenMode::Inline,
        };
        session
            .terminal
            .clear()
            .map_err(|source| startup_error(&host_terminal, "clear terminal", source))?;
        Ok(session)
    }

    pub(crate) fn set_screen_mode(&mut self, mode: ScreenMode) -> io::Result<()> {
        if self.modes.mode == mode {
            return Ok(());
        }
        if self.modes.mode == ScreenMode::Inline {
            self.terminal.clear()?;
            let origin = self.terminal.get_frame().area().as_position();
            self.terminal.set_cursor_position(origin)?;
        }
        self.inline_active = false;
        self.modes.restore();
        self.modes.mode = mode;
        self.modes.mouse_mode = MouseMode::TerminalSelection;
        self.modes.reacquire()?;
        self.terminal = new_terminal(mode, self.inline_height)?;
        self.inline_active = mode == ScreenMode::Inline;
        self.terminal.clear()?;
        self.invalidate();
        Ok(())
    }

    pub(crate) fn set_inline_height(&mut self, height: u16) -> io::Result<()> {
        self.terminal.autoresize()?;
        let height = height.max(1).min(self.screen_area()?.height.max(1));
        if self.inline_height == height {
            return Ok(());
        }
        let origin = self.terminal.get_frame().area().as_position();
        self.terminal.clear()?;
        self.terminal.set_cursor_position(origin)?;
        self.terminal = new_terminal(ScreenMode::Inline, height)?;
        self.inline_height = height;
        self.invalidate();
        Ok(())
    }

    pub(crate) fn append_history(
        &mut self,
        height: usize,
        mut render: impl FnMut(&mut Buffer, usize, &std::cell::RefCell<super::hyperlinks::FrameLinks>),
    ) -> io::Result<()> {
        super::scrollback::append(&mut self.terminal, height, |buffer, offset| {
            let links = std::cell::RefCell::default();
            render(buffer, offset, &links);
            links.into_inner().encode_history(buffer);
        })?;
        self.invalidate();
        Ok(())
    }

    fn invalidate(&mut self) {
        self.hyperlinks = Default::default();
        self.rendered_frame = None;
    }

    pub(crate) const fn background_color(&self) -> Option<TerminalRgb> {
        self.background_color
    }

    pub(crate) fn draw<F>(&mut self, render: F) -> io::Result<()>
    where
        F: FnOnce(&mut ratatui::Frame<'_>, &std::cell::RefCell<super::hyperlinks::FrameLinks>),
    {
        let links = std::cell::RefCell::default();
        let completed = self.terminal.draw(|frame| render(frame, &links))?;
        let buffer = completed.buffer.clone();
        let links = links.into_inner();
        links.write(
            &self.hyperlinks,
            &buffer,
            self.rendered_frame.as_ref(),
            self.terminal.backend_mut(),
        )?;
        self.hyperlinks = links;
        self.rendered_frame = Some(buffer);
        Ok(())
    }

    pub(crate) fn screen_area(&self) -> io::Result<Rect> {
        self.terminal
            .size()
            .map(|size| Rect::new(0, 0, size.width, size.height))
    }

    pub(crate) fn area(&self) -> io::Result<Rect> {
        self.rendered_frame
            .as_ref()
            .map_or_else(|| self.screen_area(), |frame| Ok(frame.area))
    }

    pub(crate) fn set_mouse_mode(&mut self, mode: MouseMode) -> io::Result<()> {
        self.modes.set_mouse_mode(mode)
    }

    pub(crate) fn set_cursor_color(&mut self, color: Option<[u8; 3]>) -> io::Result<()> {
        self.cursor_color.set(&mut io::stdout(), color)
    }

    pub(crate) fn selected_text(&self, range: ScreenSelectionRange) -> Option<String> {
        self.rendered_frame
            .as_ref()
            .and_then(|buffer| text_in_range(buffer, range))
    }

    pub(crate) fn token_range_at(&self, position: Position) -> Option<ScreenSelectionRange> {
        self.rendered_frame
            .as_ref()
            .and_then(|buffer| token_range_at(buffer, position))
    }

    pub(crate) fn line_range_at(&self, position: Position) -> Option<ScreenSelectionRange> {
        self.rendered_frame
            .as_ref()
            .and_then(|buffer| line_range_at(buffer, position))
    }

    /// Restores the parent terminal, suspends this process, and reacquires TUI modes on resume.
    pub(crate) fn suspend(&mut self) -> io::Result<()> {
        self.cursor_color.set(&mut io::stdout(), None)?;
        if self.modes.mode == ScreenMode::Inline {
            self.terminal.clear()?;
            let origin = self.terminal.get_frame().area().as_position();
            self.terminal.set_cursor_position(origin)?;
        }
        self.modes.restore();
        let _ = self.terminal.show_cursor();
        let suspend_result = suspend_process();
        let reacquire_result = self.modes.reacquire();
        suspend_result?;
        reacquire_result?;
        if self.modes.mode == ScreenMode::Inline {
            self.terminal = new_terminal(ScreenMode::Inline, self.inline_height)?;
        }
        self.invalidate();
        self.terminal.clear()
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.cursor_color.set(&mut io::stdout(), None);
        if self.inline_active {
            let _ = self.terminal.clear();
            let origin = self.terminal.get_frame().area().as_position();
            let _ = self.terminal.set_cursor_position(origin);
        }
        self.modes.restore();
        let _ = self.terminal.show_cursor();
    }
}

#[derive(Default)]
struct CursorColor {
    applied: Option<[u8; 3]>,
}

impl CursorColor {
    fn set(&mut self, output: &mut impl Write, color: Option<[u8; 3]>) -> io::Result<()> {
        if self.applied == color {
            return Ok(());
        }
        match color {
            Some([red, green, blue]) => {
                write!(output, "\x1b]12;#{red:02x}{green:02x}{blue:02x}\x1b\\")?
            }
            None => output.write_all(b"\x1b]112\x1b\\")?,
        }
        output.flush()?;
        self.applied = color;
        Ok(())
    }
}

trait TerminalModeOperations {
    fn enable_raw_mode(&mut self) -> io::Result<()>;
    fn begin_screen(&mut self) -> io::Result<()>;
    fn enable_bracketed_paste(&mut self) -> io::Result<()>;
    fn enable_focus_change(&mut self) -> io::Result<()>;
    fn enable_mouse_capture(&mut self) -> io::Result<()>;
    fn disable_mouse_capture(&mut self) -> io::Result<()>;
    fn disable_focus_change(&mut self) -> io::Result<()>;
    fn disable_bracketed_paste(&mut self) -> io::Result<()>;
    fn finish_screen(&mut self) -> io::Result<()>;
    fn disable_raw_mode(&mut self) -> io::Result<()>;
}

struct TerminalModeGuard<O: TerminalModeOperations> {
    operations: O,
    mode: ScreenMode,
    raw_mode: bool,
    screen_active: bool,
    bracketed_paste: bool,
    focus_change: bool,
    mouse_mode: MouseMode,
    mouse_capture: bool,
}

impl<O: TerminalModeOperations> TerminalModeGuard<O> {
    fn acquire(operations: O, mode: ScreenMode) -> io::Result<Self> {
        let mut guard = Self {
            operations,
            mode,
            raw_mode: false,
            screen_active: false,
            bracketed_paste: false,
            focus_change: false,
            mouse_mode: MouseMode::default(),
            mouse_capture: false,
        };

        guard.reacquire()?;
        Ok(guard)
    }

    fn reacquire(&mut self) -> io::Result<()> {
        let result = (|| {
            self.operations.enable_raw_mode()?;
            self.raw_mode = true;
            if self.mode == ScreenMode::Fullscreen {
                self.operations.begin_screen()?;
                self.screen_active = true;
            }
            self.operations.enable_bracketed_paste()?;
            self.bracketed_paste = true;
            self.operations.enable_focus_change()?;
            self.focus_change = true;
            if self.mode == ScreenMode::Fullscreen && self.mouse_mode.captures_terminal_input() {
                self.operations.enable_mouse_capture()?;
                self.mouse_capture = true;
            }
            Ok(())
        })();
        if result.is_err() {
            self.restore();
        }
        result
    }

    fn set_mouse_mode(&mut self, mode: MouseMode) -> io::Result<()> {
        let mode = if self.mode == ScreenMode::Inline {
            MouseMode::TerminalSelection
        } else {
            mode
        };
        if self.mouse_mode == mode {
            return Ok(());
        }
        match mode {
            MouseMode::TerminalSelection => {
                if self.mouse_capture {
                    self.operations.disable_mouse_capture()?;
                    self.mouse_capture = false;
                }
            }
            MouseMode::TuiCapture => {
                if self.screen_active && !self.mouse_capture {
                    self.operations.enable_mouse_capture()?;
                    self.mouse_capture = true;
                }
            }
        }
        self.mouse_mode = mode;
        Ok(())
    }

    fn restore(&mut self) {
        if self.mouse_capture {
            let _ = self.operations.disable_mouse_capture();
            self.mouse_capture = false;
        }
        if self.focus_change {
            let _ = self.operations.disable_focus_change();
            self.focus_change = false;
        }
        if self.bracketed_paste {
            let _ = self.operations.disable_bracketed_paste();
            self.bracketed_paste = false;
        }
        if self.screen_active {
            let _ = self.operations.finish_screen();
            self.screen_active = false;
        }
        if self.raw_mode {
            let _ = self.operations.disable_raw_mode();
            self.raw_mode = false;
        }
    }
}

impl<O: TerminalModeOperations> Drop for TerminalModeGuard<O> {
    fn drop(&mut self) {
        self.restore();
    }
}

struct CrosstermModeOperations;

fn new_terminal(mode: ScreenMode, height: u16) -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    Terminal::with_options(
        CrosstermBackend::new(io::stdout()),
        TerminalOptions {
            viewport: match mode {
                ScreenMode::Fullscreen => Viewport::Fullscreen,
                ScreenMode::Inline => Viewport::Inline(height),
            },
        },
    )
}

impl TerminalModeOperations for CrosstermModeOperations {
    fn enable_raw_mode(&mut self) -> io::Result<()> {
        enable_raw_mode()
    }

    fn begin_screen(&mut self) -> io::Result<()> {
        enter_screen(&mut io::stdout())
    }

    fn enable_bracketed_paste(&mut self) -> io::Result<()> {
        io::stdout().execute(EnableBracketedPaste).map(|_| ())
    }

    fn enable_focus_change(&mut self) -> io::Result<()> {
        io::stdout().execute(EnableFocusChange).map(|_| ())
    }

    fn enable_mouse_capture(&mut self) -> io::Result<()> {
        io::stdout().execute(EnableMouseCapture).map(|_| ())
    }

    fn disable_mouse_capture(&mut self) -> io::Result<()> {
        io::stdout().execute(DisableMouseCapture).map(|_| ())
    }

    fn disable_focus_change(&mut self) -> io::Result<()> {
        io::stdout().execute(DisableFocusChange).map(|_| ())
    }

    fn disable_bracketed_paste(&mut self) -> io::Result<()> {
        io::stdout().execute(DisableBracketedPaste).map(|_| ())
    }

    fn finish_screen(&mut self) -> io::Result<()> {
        leave_screen(&mut io::stdout())
    }

    fn disable_raw_mode(&mut self) -> io::Result<()> {
        disable_raw_mode()
    }
}

fn enter_screen(output: &mut impl Write) -> io::Result<()> {
    output.execute(EnterAlternateScreen)?;
    if let Err(error) = prepare_alternate_scroll(output) {
        let _ = restore_alternate_scroll(output);
        let _ = output.execute(LeaveAlternateScreen);
        return Err(error);
    }
    Ok(())
}

fn leave_screen(output: &mut impl Write) -> io::Result<()> {
    let alternate_scroll = restore_alternate_scroll(output);
    let alternate_screen = output.execute(LeaveAlternateScreen).map(|_| ());
    alternate_scroll.and(alternate_screen)
}

fn prepare_alternate_scroll(output: &mut impl Write) -> io::Result<()> {
    output.write_all(SAVE_ALTERNATE_SCROLL)?;
    output.write_all(DISABLE_ALTERNATE_SCROLL)?;
    output.flush()
}

fn restore_alternate_scroll(output: &mut impl Write) -> io::Result<()> {
    output.write_all(RESTORE_ALTERNATE_SCROLL)?;
    output.flush()
}

#[cfg(unix)]
fn suspend_process() -> io::Result<()> {
    rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::TSTP)
        .map_err(io::Error::from)
}

#[cfg(not(unix))]
fn suspend_process() -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process suspension is unsupported on this platform",
    ))
}

#[derive(Debug)]
struct StartupError {
    host: ash_terminal_detection::HostTerminal,
    operation: &'static str,
    source: io::Error,
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "cannot {}: {}; terminal={:?}, version={:?}, multiplexer={:?}, TERM={:?}, color={:?}",
            self.operation,
            self.source,
            self.host.kind,
            self.host.version,
            self.host.multiplexer,
            self.host.term,
            self.host.color_level
        )
    }
}

impl std::error::Error for StartupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

fn startup_error(
    host: &ash_terminal_detection::HostTerminal,
    operation: &'static str,
    source: io::Error,
) -> io::Error {
    io::Error::new(
        source.kind(),
        StartupError {
            host: host.clone(),
            operation,
            source,
        },
    )
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
