use crate::{GridSize, TerminalGrid};

/// The terminal screen buffer currently projected to the renderer.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ScreenBuffer {
    #[default]
    Primary,
    Alternate,
}

/// Encoding selected by DEC application cursor-key mode.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CursorKeyMode {
    #[default]
    Normal,
    Application,
}

/// Mouse events requested by the application through DEC private modes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MouseTrackingMode {
    #[default]
    Disabled,
    Press,
    ButtonEvent,
    AnyEvent,
}

/// Mouse coordinate encoding requested by the application.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MouseEncoding {
    #[default]
    Legacy,
    Sgr,
}

/// Observable terminal modes that affect input routing or presentation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalModes {
    cursor_keys: CursorKeyMode,
    cursor_visible: bool,
    bracketed_paste: bool,
    mouse_press: bool,
    mouse_button_event: bool,
    mouse_any_event: bool,
    mouse_encoding: MouseEncoding,
}

impl Default for TerminalModes {
    fn default() -> Self {
        Self {
            cursor_keys: CursorKeyMode::Normal,
            cursor_visible: true,
            bracketed_paste: false,
            mouse_press: false,
            mouse_button_event: false,
            mouse_any_event: false,
            mouse_encoding: MouseEncoding::Legacy,
        }
    }
}

impl TerminalModes {
    pub const fn cursor_keys(self) -> CursorKeyMode {
        self.cursor_keys
    }

    pub const fn cursor_visible(self) -> bool {
        self.cursor_visible
    }

    pub const fn bracketed_paste(self) -> bool {
        self.bracketed_paste
    }

    pub const fn mouse_tracking(self) -> MouseTrackingMode {
        if self.mouse_any_event {
            MouseTrackingMode::AnyEvent
        } else if self.mouse_button_event {
            MouseTrackingMode::ButtonEvent
        } else if self.mouse_press {
            MouseTrackingMode::Press
        } else {
            MouseTrackingMode::Disabled
        }
    }

    pub const fn mouse_encoding(self) -> MouseEncoding {
        self.mouse_encoding
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModeChange {
    Set,
    Reset,
}

pub(crate) struct TerminalScreen {
    primary: TerminalGrid,
    alternate: TerminalGrid,
    active: ScreenBuffer,
    modes: TerminalModes,
}

impl TerminalScreen {
    pub(crate) fn new(size: GridSize) -> Self {
        Self {
            primary: TerminalGrid::new(size),
            alternate: TerminalGrid::transient(size),
            active: ScreenBuffer::Primary,
            modes: TerminalModes::default(),
        }
    }

    pub(crate) const fn active(&self) -> ScreenBuffer {
        self.active
    }

    pub(crate) const fn modes(&self) -> TerminalModes {
        self.modes
    }

    pub(crate) const fn grid(&self) -> &TerminalGrid {
        match self.active {
            ScreenBuffer::Primary => &self.primary,
            ScreenBuffer::Alternate => &self.alternate,
        }
    }

    pub(crate) fn grid_mut(&mut self) -> &mut TerminalGrid {
        match self.active {
            ScreenBuffer::Primary => &mut self.primary,
            ScreenBuffer::Alternate => &mut self.alternate,
        }
    }

    pub(crate) fn resize(&mut self, size: GridSize) {
        self.primary.resize(size);
        self.alternate.resize(size);
    }

    pub(crate) fn reset(&mut self) {
        let size = self.primary.size();
        *self = Self::new(size);
    }

    pub(crate) fn process_exited(&mut self) {
        if self.active == ScreenBuffer::Alternate {
            self.active = ScreenBuffer::Primary;
        }
        self.modes = TerminalModes::default();
    }

    pub(crate) fn apply_private_mode(&mut self, mode: u16, change: ModeChange) {
        match (mode, change) {
            (1, ModeChange::Set) => self.modes.cursor_keys = CursorKeyMode::Application,
            (1, ModeChange::Reset) => self.modes.cursor_keys = CursorKeyMode::Normal,
            (6, ModeChange::Set) => self.grid_mut().enable_origin_mode(),
            (6, ModeChange::Reset) => self.grid_mut().disable_origin_mode(),
            (25, ModeChange::Set) => self.modes.cursor_visible = true,
            (25, ModeChange::Reset) => self.modes.cursor_visible = false,
            (47, ModeChange::Set) => self.active = ScreenBuffer::Alternate,
            (47, ModeChange::Reset) => self.active = ScreenBuffer::Primary,
            (1000, change) => self.modes.mouse_press = change == ModeChange::Set,
            (1002, change) => self.modes.mouse_button_event = change == ModeChange::Set,
            (1003, change) => self.modes.mouse_any_event = change == ModeChange::Set,
            (1006, ModeChange::Set) => self.modes.mouse_encoding = MouseEncoding::Sgr,
            (1006, ModeChange::Reset) => self.modes.mouse_encoding = MouseEncoding::Legacy,
            (1047, ModeChange::Set) => self.enter_cleared_alternate(),
            (1047, ModeChange::Reset) => self.active = ScreenBuffer::Primary,
            (1048, ModeChange::Set) => self.grid_mut().save_cursor(),
            (1048, ModeChange::Reset) => self.grid_mut().restore_cursor(),
            (1049, ModeChange::Set) => {
                self.primary.save_cursor();
                self.enter_cleared_alternate();
            }
            (1049, ModeChange::Reset) => {
                self.active = ScreenBuffer::Primary;
                self.primary.restore_cursor();
            }
            (2004, ModeChange::Set) => self.modes.bracketed_paste = true,
            (2004, ModeChange::Reset) => self.modes.bracketed_paste = false,
            _ => {}
        }
    }

    fn enter_cleared_alternate(&mut self) {
        self.alternate.reset();
        self.active = ScreenBuffer::Alternate;
    }
}
