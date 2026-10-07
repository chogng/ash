use std::fmt;

pub const MAX_CHORDS: usize = 4;

/// Host family used to resolve the portable primary modifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostPlatform {
    MacOs,
    Windows,
    Linux,
    Other,
}

impl HostPlatform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// Exact modifier state carried by one platform keyboard event.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct Modifiers {
    control: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

impl Modifiers {
    pub const fn none() -> Self {
        Self {
            control: false,
            shift: false,
            alt: false,
            meta: false,
        }
    }

    pub const fn with_control(mut self) -> Self {
        self.control = true;
        self
    }

    pub const fn with_shift(mut self) -> Self {
        self.shift = true;
        self
    }

    pub const fn with_alt(mut self) -> Self {
        self.alt = true;
        self
    }

    pub const fn with_meta(mut self) -> Self {
        self.meta = true;
        self
    }
}

/// Modifier declaration stored by a shortcut before host-specific resolution.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct ShortcutModifiers {
    primary: bool,
    control: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

impl ShortcutModifiers {
    pub const fn none() -> Self {
        Self {
            primary: false,
            control: false,
            shift: false,
            alt: false,
            meta: false,
        }
    }

    pub const fn primary() -> Self {
        Self {
            primary: true,
            ..Self::none()
        }
    }

    pub const fn control() -> Self {
        Self {
            control: true,
            ..Self::none()
        }
    }

    pub const fn meta() -> Self {
        Self {
            meta: true,
            ..Self::none()
        }
    }

    pub const fn with_primary(mut self) -> Self {
        self.primary = true;
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

    pub const fn with_alt(mut self) -> Self {
        self.alt = true;
        self
    }

    pub const fn with_meta(mut self) -> Self {
        self.meta = true;
        self
    }

    pub const fn uses_primary(self) -> bool {
        self.primary
    }

    pub const fn uses_control(self) -> bool {
        self.control
    }

    pub const fn uses_shift(self) -> bool {
        self.shift
    }

    pub const fn uses_alt(self) -> bool {
        self.alt
    }

    pub const fn uses_meta(self) -> bool {
        self.meta
    }

    fn resolve(self, platform: HostPlatform) -> Modifiers {
        let mut resolved = Modifiers::none();
        if self.control || (self.primary && platform != HostPlatform::MacOs) {
            resolved = resolved.with_control();
        }
        if self.shift {
            resolved = resolved.with_shift();
        }
        if self.alt {
            resolved = resolved.with_alt();
        }
        if self.meta || (self.primary && platform == HostPlatform::MacOs) {
            resolved = resolved.with_meta();
        }
        resolved
    }
}

/// Layout-aware key name matched against the logical key reported by the host.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LogicalKey(String);

impl LogicalKey {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        normalize_key(value.into()).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Layout-independent key code matched against the physical key reported by the host.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PhysicalKey(String);

impl PhysicalKey {
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum KeyIdentity {
    Logical(LogicalKey),
    Physical(PhysicalKey),
}

/// One shortcut chord before portable modifiers are resolved for a host.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Chord {
    key: KeyIdentity,
    modifiers: ShortcutModifiers,
}

impl Chord {
    pub const fn new(key: KeyIdentity, modifiers: ShortcutModifiers) -> Self {
        Self { key, modifiers }
    }

    pub fn logical(key: impl Into<String>, modifiers: ShortcutModifiers) -> Option<Self> {
        LogicalKey::new(key).map(|key| Self::new(KeyIdentity::Logical(key), modifiers))
    }

    pub fn physical(key: impl Into<String>, modifiers: ShortcutModifiers) -> Option<Self> {
        PhysicalKey::new(key).map(|key| Self::new(KeyIdentity::Physical(key), modifiers))
    }

    pub const fn key(&self) -> &KeyIdentity {
        &self.key
    }

    pub const fn modifiers(&self) -> ShortcutModifiers {
        self.modifiers
    }

    fn matches(&self, event: &KeyStroke, platform: HostPlatform) -> bool {
        let key_matches = match &self.key {
            KeyIdentity::Logical(key) => key == &event.logical_key,
            KeyIdentity::Physical(key) => event.physical_key.as_ref() == Some(key),
        };
        key_matches && self.modifiers.resolve(platform) == event.modifiers
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeySequenceError {
    Empty,
    TooManyChords { maximum: usize, actual: usize },
}

impl fmt::Display for KeySequenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("a key sequence requires at least one chord"),
            Self::TooManyChords { maximum, actual } => {
                write!(
                    formatter,
                    "a key sequence supports at most {maximum} chords, got {actual}"
                )
            }
        }
    }
}

impl std::error::Error for KeySequenceError {}

/// One shortcut consisting of one to four ordered chords.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct KeySequence {
    chords: Vec<Chord>,
}

impl KeySequence {
    pub fn new(chords: Vec<Chord>) -> Result<Self, KeySequenceError> {
        if chords.is_empty() {
            return Err(KeySequenceError::Empty);
        }
        if chords.len() > MAX_CHORDS {
            return Err(KeySequenceError::TooManyChords {
                maximum: MAX_CHORDS,
                actual: chords.len(),
            });
        }
        Ok(Self { chords })
    }

    pub fn single(chord: Chord) -> Self {
        Self {
            chords: vec![chord],
        }
    }

    pub fn chords(&self) -> &[Chord] {
        &self.chords
    }

    pub(crate) fn matches_prefix(&self, events: &[KeyStroke], platform: HostPlatform) -> bool {
        events.len() <= self.chords.len()
            && events
                .iter()
                .zip(&self.chords)
                .all(|(event, chord)| chord.matches(event, platform))
    }
}

/// Normalized platform event consumed by shortcut resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyStroke {
    logical_key: LogicalKey,
    physical_key: Option<PhysicalKey>,
    modifiers: Modifiers,
}

impl KeyStroke {
    pub const fn new(
        logical_key: LogicalKey,
        physical_key: Option<PhysicalKey>,
        modifiers: Modifiers,
    ) -> Self {
        Self {
            logical_key,
            physical_key,
            modifiers,
        }
    }
}

fn normalize_key(value: String) -> Option<String> {
    if value == " " || value.trim().eq_ignore_ascii_case("space") {
        return Some(" ".to_owned());
    }
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_lowercase())
}
