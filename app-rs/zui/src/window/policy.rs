use winit::window::CursorGrabMode as NativeCursorGrabMode;
use winit::window::ResizeDirection as NativeResizeDirection;
use winit::window::UserAttentionType as NativeUserAttentionType;
use winit::window::WindowButtons as NativeWindowButtons;

/// Native titlebar buttons that remain enabled for a window.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WindowButtons {
    close: bool,
    minimize: bool,
    maximize: bool,
}

impl WindowButtons {
    /// Enables every standard native window button.
    pub const ALL: Self = Self::new(true, true, true);
    /// Disables every standard native window button.
    pub const NONE: Self = Self::new(false, false, false);

    /// Creates an explicit native-button policy.
    pub const fn new(close: bool, minimize: bool, maximize: bool) -> Self {
        Self {
            close,
            minimize,
            maximize,
        }
    }

    /// Returns whether the native close button is enabled.
    pub const fn close(self) -> bool {
        self.close
    }

    /// Returns whether the native minimize button is enabled.
    pub const fn minimize(self) -> bool {
        self.minimize
    }

    /// Returns whether the native maximize button is enabled.
    pub const fn maximize(self) -> bool {
        self.maximize
    }

    /// Changes whether the native close button is enabled.
    pub const fn with_close(mut self, enabled: bool) -> Self {
        self.close = enabled;
        self
    }

    /// Changes whether the native minimize button is enabled.
    pub const fn with_minimize(mut self, enabled: bool) -> Self {
        self.minimize = enabled;
        self
    }

    /// Changes whether the native maximize button is enabled.
    pub const fn with_maximize(mut self, enabled: bool) -> Self {
        self.maximize = enabled;
        self
    }

    pub(crate) fn into_native(self) -> NativeWindowButtons {
        let mut buttons = NativeWindowButtons::empty();
        if self.close {
            buttons.insert(NativeWindowButtons::CLOSE);
        }
        if self.minimize {
            buttons.insert(NativeWindowButtons::MINIMIZE);
        }
        if self.maximize {
            buttons.insert(NativeWindowButtons::MAXIMIZE);
        }
        buttons
    }

    pub(crate) fn from_native(buttons: NativeWindowButtons) -> Self {
        Self::new(
            buttons.contains(NativeWindowButtons::CLOSE),
            buttons.contains(NativeWindowButtons::MINIMIZE),
            buttons.contains(NativeWindowButtons::MAXIMIZE),
        )
    }
}

impl Default for WindowButtons {
    fn default() -> Self {
        Self::ALL
    }
}

/// Platform presentation requested when an unfocused window needs attention.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum UserAttentionType {
    Critical,
    Informational,
}

impl UserAttentionType {
    pub(crate) const fn into_native(self) -> NativeUserAttentionType {
        match self {
            Self::Critical => NativeUserAttentionType::Critical,
            Self::Informational => NativeUserAttentionType::Informational,
        }
    }
}

/// Edge or corner used for an operating-system managed window resize gesture.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ResizeDirection {
    East,
    North,
    NorthEast,
    NorthWest,
    South,
    SouthEast,
    SouthWest,
    West,
}

impl ResizeDirection {
    pub(crate) const fn into_native(self) -> NativeResizeDirection {
        match self {
            Self::East => NativeResizeDirection::East,
            Self::North => NativeResizeDirection::North,
            Self::NorthEast => NativeResizeDirection::NorthEast,
            Self::NorthWest => NativeResizeDirection::NorthWest,
            Self::South => NativeResizeDirection::South,
            Self::SouthEast => NativeResizeDirection::SouthEast,
            Self::SouthWest => NativeResizeDirection::SouthWest,
            Self::West => NativeResizeDirection::West,
        }
    }
}

/// Constraint applied to the pointer relative to one native window.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum CursorGrabMode {
    #[default]
    None,
    Confined,
    Locked,
}

/// Semantic hint describing the text entered through the platform IME.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ImePurpose {
    #[default]
    Normal,
    Password,
    Terminal,
}

impl ImePurpose {
    pub(crate) const fn into_native(self) -> winit::window::ImePurpose {
        match self {
            Self::Normal => winit::window::ImePurpose::Normal,
            Self::Password => winit::window::ImePurpose::Password,
            Self::Terminal => winit::window::ImePurpose::Terminal,
        }
    }
}

impl CursorGrabMode {
    pub(crate) const fn into_native(self) -> NativeCursorGrabMode {
        match self {
            Self::None => NativeCursorGrabMode::None,
            Self::Confined => NativeCursorGrabMode::Confined,
            Self::Locked => NativeCursorGrabMode::Locked,
        }
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
