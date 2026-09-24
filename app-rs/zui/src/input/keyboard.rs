use std::fmt;

use winit::event;
use winit::keyboard;

use crate::window::ElementState;

/// Modifier keys active for the current input event.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct ModifiersState {
    alt: bool,
    control: bool,
    shift: bool,
    super_key: bool,
}

impl ModifiersState {
    pub const fn alt_key(self) -> bool {
        self.alt
    }

    pub const fn control_key(self) -> bool {
        self.control
    }

    pub const fn shift_key(self) -> bool {
        self.shift
    }

    pub const fn super_key(self) -> bool {
        self.super_key
    }

    pub const fn with_alt(mut self) -> Self {
        self.alt = true;
        self
    }

    pub const fn with_control(mut self) -> Self {
        self.control = true;
        self
    }

    pub const fn with_shift(mut self) -> Self {
        self.shift = true;
        self
    }

    pub const fn with_super(mut self) -> Self {
        self.super_key = true;
        self
    }

    pub(crate) fn from_native(state: keyboard::ModifiersState) -> Self {
        Self {
            alt: state.alt_key(),
            control: state.control_key(),
            shift: state.shift_key(),
            super_key: state.super_key(),
        }
    }
}

/// Modifier change payload retained for compatibility with window-event matching.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct Modifiers(ModifiersState);

impl Modifiers {
    pub const fn new(state: ModifiersState) -> Self {
        Self(state)
    }

    pub const fn state(self) -> ModifiersState {
        self.0
    }
}

/// Portable named keys used by application commands and text editing.
#[derive(Clone, Eq, Hash, PartialEq)]
pub enum NamedKey {
    Alt,
    AltGraph,
    Control,
    Fn,
    FnLock,
    Meta,
    Shift,
    Super,
    Enter,
    Tab,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    End,
    Home,
    PageDown,
    PageUp,
    Backspace,
    Delete,
    Insert,
    Escape,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    Other(String),
}

impl fmt::Debug for NamedKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Other(name) => formatter.write_str(name),
            key => formatter.write_str(key.name()),
        }
    }
}

impl NamedKey {
    fn name(&self) -> &'static str {
        match self {
            Self::Alt => "Alt",
            Self::AltGraph => "AltGraph",
            Self::Control => "Control",
            Self::Fn => "Fn",
            Self::FnLock => "FnLock",
            Self::Meta => "Meta",
            Self::Shift => "Shift",
            Self::Super => "Super",
            Self::Enter => "Enter",
            Self::Tab => "Tab",
            Self::ArrowDown => "ArrowDown",
            Self::ArrowLeft => "ArrowLeft",
            Self::ArrowRight => "ArrowRight",
            Self::ArrowUp => "ArrowUp",
            Self::End => "End",
            Self::Home => "Home",
            Self::PageDown => "PageDown",
            Self::PageUp => "PageUp",
            Self::Backspace => "Backspace",
            Self::Delete => "Delete",
            Self::Insert => "Insert",
            Self::Escape => "Escape",
            Self::F1 => "F1",
            Self::F2 => "F2",
            Self::F3 => "F3",
            Self::F4 => "F4",
            Self::F5 => "F5",
            Self::F6 => "F6",
            Self::F7 => "F7",
            Self::F8 => "F8",
            Self::F9 => "F9",
            Self::F10 => "F10",
            Self::F11 => "F11",
            Self::F12 => "F12",
            Self::Other(_) => unreachable!(),
        }
    }

    pub(crate) fn from_native(key: keyboard::NamedKey) -> Self {
        match key {
            keyboard::NamedKey::Alt => Self::Alt,
            keyboard::NamedKey::AltGraph => Self::AltGraph,
            keyboard::NamedKey::Control => Self::Control,
            keyboard::NamedKey::Fn => Self::Fn,
            keyboard::NamedKey::FnLock => Self::FnLock,
            keyboard::NamedKey::Meta => Self::Meta,
            keyboard::NamedKey::Shift => Self::Shift,
            keyboard::NamedKey::Super => Self::Super,
            keyboard::NamedKey::Enter => Self::Enter,
            keyboard::NamedKey::Tab => Self::Tab,
            keyboard::NamedKey::ArrowDown => Self::ArrowDown,
            keyboard::NamedKey::ArrowLeft => Self::ArrowLeft,
            keyboard::NamedKey::ArrowRight => Self::ArrowRight,
            keyboard::NamedKey::ArrowUp => Self::ArrowUp,
            keyboard::NamedKey::End => Self::End,
            keyboard::NamedKey::Home => Self::Home,
            keyboard::NamedKey::PageDown => Self::PageDown,
            keyboard::NamedKey::PageUp => Self::PageUp,
            keyboard::NamedKey::Backspace => Self::Backspace,
            keyboard::NamedKey::Delete => Self::Delete,
            keyboard::NamedKey::Insert => Self::Insert,
            keyboard::NamedKey::Escape => Self::Escape,
            keyboard::NamedKey::F1 => Self::F1,
            keyboard::NamedKey::F2 => Self::F2,
            keyboard::NamedKey::F3 => Self::F3,
            keyboard::NamedKey::F4 => Self::F4,
            keyboard::NamedKey::F5 => Self::F5,
            keyboard::NamedKey::F6 => Self::F6,
            keyboard::NamedKey::F7 => Self::F7,
            keyboard::NamedKey::F8 => Self::F8,
            keyboard::NamedKey::F9 => Self::F9,
            keyboard::NamedKey::F10 => Self::F10,
            keyboard::NamedKey::F11 => Self::F11,
            keyboard::NamedKey::F12 => Self::F12,
            key => Self::Other(format!("{key:?}")),
        }
    }
}

/// Logical keyboard identity after applying the active keyboard layout.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Key {
    Named(NamedKey),
    Character(String),
    Unidentified(String),
    Dead(Option<char>),
}

impl Key {
    fn from_native(key: keyboard::Key) -> Self {
        match key {
            keyboard::Key::Named(key) => Self::Named(NamedKey::from_native(key)),
            keyboard::Key::Character(text) => Self::Character(text.to_string()),
            keyboard::Key::Unidentified(key) => Self::Unidentified(format!("{key:?}")),
            keyboard::Key::Dead(character) => Self::Dead(character),
        }
    }
}

/// Stable debug identity for a physical keyboard key.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct KeyCode(String);

impl KeyCode {
    pub fn new(code: impl Into<String>) -> Self {
        Self(code.into())
    }
}

impl fmt::Debug for KeyCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Physical keyboard identity independent of the active keyboard layout.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum PhysicalKey {
    Code(KeyCode),
    Unidentified(String),
}

impl PhysicalKey {
    pub(crate) fn from_native(key: keyboard::PhysicalKey) -> Self {
        match key {
            keyboard::PhysicalKey::Code(code) => Self::Code(KeyCode(format!("{code:?}"))),
            keyboard::PhysicalKey::Unidentified(code) => Self::Unidentified(format!("{code:?}")),
        }
    }
}

/// One normalized keyboard event delivered to a ZUI application.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct KeyEvent {
    pub physical_key: PhysicalKey,
    pub logical_key: Key,
    pub text: Option<String>,
    pub state: ElementState,
    pub repeat: bool,
}

impl KeyEvent {
    /// Creates a normalized key event with an unidentified physical key.
    pub fn new(logical_key: Key, state: ElementState) -> Self {
        Self {
            physical_key: PhysicalKey::Unidentified("unknown".to_owned()),
            logical_key,
            text: None,
            state,
            repeat: false,
        }
    }

    /// Associates a physical key identity with this event.
    pub fn with_physical_key(mut self, physical_key: PhysicalKey) -> Self {
        self.physical_key = physical_key;
        self
    }

    /// Associates text produced by the keyboard layout with this event.
    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// Marks this event as an operating-system key repeat.
    pub const fn repeated(mut self) -> Self {
        self.repeat = true;
        self
    }

    pub(crate) fn from_native(event: event::KeyEvent) -> Self {
        Self {
            physical_key: PhysicalKey::from_native(event.physical_key),
            logical_key: Key::from_native(event.logical_key),
            text: event.text.map(|text| text.to_string()),
            state: ElementState::from_native(event.state),
            repeat: event.repeat,
        }
    }
}
