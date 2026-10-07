use crate::CursorKeyMode;

/// One logical key accepted by the terminal input encoder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalKey<'a> {
    Text(&'a str),
    Enter,
    Tab,
    Backspace,
    Escape,
    ArrowUp,
    ArrowDown,
    ArrowRight,
    ArrowLeft,
    Home,
    End,
    Insert,
    Delete,
    PageUp,
    PageDown,
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
}

/// Modifier set applied to one terminal key without platform-specific key types.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct KeyModifiers(u8);

impl KeyModifiers {
    pub const NONE: Self = Self(0);
    const SHIFT: u8 = 1;
    const ALT: u8 = 2;
    const CONTROL: u8 = 4;

    pub const fn with_shift(self) -> Self {
        Self(self.0 | Self::SHIFT)
    }

    pub const fn with_alt(self) -> Self {
        Self(self.0 | Self::ALT)
    }

    pub const fn with_control(self) -> Self {
        Self(self.0 | Self::CONTROL)
    }

    const fn shift(self) -> bool {
        self.0 & Self::SHIFT != 0
    }

    const fn alt(self) -> bool {
        self.0 & Self::ALT != 0
    }

    const fn control(self) -> bool {
        self.0 & Self::CONTROL != 0
    }

    const fn xterm_parameter(self) -> u8 {
        1 + self.shift() as u8 + 2 * self.alt() as u8 + 4 * self.control() as u8
    }
}

pub(crate) fn encode_key(
    key: TerminalKey<'_>,
    modifiers: KeyModifiers,
    cursor_mode: CursorKeyMode,
) -> Vec<u8> {
    match key {
        TerminalKey::Text(text) => encode_text(text, modifiers),
        TerminalKey::Enter => with_alt_prefix(b"\r", modifiers),
        TerminalKey::Tab if modifiers.shift() => with_alt_prefix(b"\x1b[Z", modifiers),
        TerminalKey::Tab => with_alt_prefix(b"\t", modifiers),
        TerminalKey::Backspace => with_alt_prefix(b"\x7f", modifiers),
        TerminalKey::Escape => b"\x1b".to_vec(),
        TerminalKey::ArrowUp => encode_cursor_key(b'A', modifiers, cursor_mode),
        TerminalKey::ArrowDown => encode_cursor_key(b'B', modifiers, cursor_mode),
        TerminalKey::ArrowRight => encode_cursor_key(b'C', modifiers, cursor_mode),
        TerminalKey::ArrowLeft => encode_cursor_key(b'D', modifiers, cursor_mode),
        TerminalKey::Home => encode_cursor_key(b'H', modifiers, cursor_mode),
        TerminalKey::End => encode_cursor_key(b'F', modifiers, cursor_mode),
        TerminalKey::Insert => encode_tilde_key(2, modifiers),
        TerminalKey::Delete => encode_tilde_key(3, modifiers),
        TerminalKey::PageUp => encode_tilde_key(5, modifiers),
        TerminalKey::PageDown => encode_tilde_key(6, modifiers),
        TerminalKey::F1 => encode_function_key(b'P', modifiers),
        TerminalKey::F2 => encode_function_key(b'Q', modifiers),
        TerminalKey::F3 => encode_function_key(b'R', modifiers),
        TerminalKey::F4 => encode_function_key(b'S', modifiers),
        TerminalKey::F5 => encode_tilde_key(15, modifiers),
        TerminalKey::F6 => encode_tilde_key(17, modifiers),
        TerminalKey::F7 => encode_tilde_key(18, modifiers),
        TerminalKey::F8 => encode_tilde_key(19, modifiers),
        TerminalKey::F9 => encode_tilde_key(20, modifiers),
        TerminalKey::F10 => encode_tilde_key(21, modifiers),
        TerminalKey::F11 => encode_tilde_key(23, modifiers),
        TerminalKey::F12 => encode_tilde_key(24, modifiers),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PasteEncoding {
    Literal,
    Bracketed,
}

pub(crate) fn encode_paste(text: &str, encoding: PasteEncoding) -> Vec<u8> {
    match encoding {
        PasteEncoding::Literal => text.as_bytes().to_vec(),
        PasteEncoding::Bracketed => {
            let mut encoded = Vec::with_capacity(text.len() + 12);
            encoded.extend_from_slice(b"\x1b[200~");
            encoded.extend_from_slice(text.as_bytes());
            encoded.extend_from_slice(b"\x1b[201~");
            encoded
        }
    }
}

fn encode_text(text: &str, modifiers: KeyModifiers) -> Vec<u8> {
    let mut encoded = if modifiers.control() {
        encode_control_character(text).unwrap_or_else(|| text.as_bytes().to_vec())
    } else {
        text.as_bytes().to_vec()
    };
    if modifiers.alt() {
        encoded.insert(0, b'\x1b');
    }
    encoded
}

fn encode_control_character(text: &str) -> Option<Vec<u8>> {
    let mut characters = text.chars();
    let character = characters.next()?;
    if characters.next().is_some() || !character.is_ascii() {
        return None;
    }
    let byte = match character {
        ' ' | '@' => 0,
        'a'..='z' => character as u8 - b'a' + 1,
        'A'..='Z' => character as u8 - b'A' + 1,
        '[' => 27,
        '\\' => 28,
        ']' => 29,
        '^' => 30,
        '_' => 31,
        '?' => 127,
        _ => return None,
    };
    Some(vec![byte])
}

fn with_alt_prefix(bytes: &[u8], modifiers: KeyModifiers) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(bytes.len() + modifiers.alt() as usize);
    if modifiers.alt() {
        encoded.push(b'\x1b');
    }
    encoded.extend_from_slice(bytes);
    encoded
}

fn encode_cursor_key(
    final_byte: u8,
    modifiers: KeyModifiers,
    cursor_mode: CursorKeyMode,
) -> Vec<u8> {
    if modifiers == KeyModifiers::NONE {
        let prefix = match cursor_mode {
            CursorKeyMode::Normal => b'[',
            CursorKeyMode::Application => b'O',
        };
        return vec![b'\x1b', prefix, final_byte];
    }
    format!(
        "\x1b[1;{}{}",
        modifiers.xterm_parameter(),
        final_byte as char
    )
    .into_bytes()
}

fn encode_function_key(final_byte: u8, modifiers: KeyModifiers) -> Vec<u8> {
    if modifiers == KeyModifiers::NONE {
        vec![b'\x1b', b'O', final_byte]
    } else {
        format!(
            "\x1b[1;{}{}",
            modifiers.xterm_parameter(),
            final_byte as char
        )
        .into_bytes()
    }
}

fn encode_tilde_key(number: u8, modifiers: KeyModifiers) -> Vec<u8> {
    if modifiers == KeyModifiers::NONE {
        format!("\x1b[{number}~").into_bytes()
    } else {
        format!("\x1b[{number};{}~", modifiers.xterm_parameter()).into_bytes()
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
