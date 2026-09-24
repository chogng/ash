mod event_source;
pub(crate) mod hyperlinks;
mod scrollback;
mod session;
mod terminal_probe;
pub(crate) mod text;

pub(crate) use event_source::TerminalEvent;
pub(crate) use event_source::TerminalEventSource;
pub(crate) use session::TerminalSession;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScreenMode {
    #[default]
    Fullscreen,
    Inline,
}

impl ScreenMode {
    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Fullscreen => Self::Inline,
            Self::Inline => Self::Fullscreen,
        }
    }

    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Fullscreen => "fullscreen",
            Self::Inline => "inline",
        }
    }
}

/// Declares whether pointer input belongs to the terminal or the full-screen TUI.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum MouseMode {
    #[default]
    TerminalSelection,
    TuiCapture,
}

impl MouseMode {
    pub(crate) const fn captures_terminal_input(self) -> bool {
        !matches!(self, Self::TerminalSelection)
    }

    pub(crate) const fn enables_pointer_actions(self) -> bool {
        matches!(self, Self::TuiCapture)
    }
}
