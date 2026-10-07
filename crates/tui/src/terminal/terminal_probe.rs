//! Short terminal-response probes run before the crossterm event reader starts.

use ash_terminal_detection::HostTerminal;
use ash_terminal_detection::TerminalRgb;
use std::io;
use std::io::IsTerminal;
#[cfg(unix)]
use std::io::Write;
#[cfg(any(windows, test))]
use std::ops::Range;
#[cfg(any(unix, windows))]
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

#[cfg(windows)]
#[path = "terminal_probe/windows.rs"]
mod windows;

#[cfg(unix)]
const OSC_BACKGROUND_QUERY: &[u8] = b"\x1b]11;?\x07";
const QUERY_TIMEOUT: Duration = Duration::from_millis(120);
#[cfg(unix)]
const RETRY_INTERVAL: Duration = Duration::from_millis(4);
#[cfg(any(windows, test))]
const MAX_RESPONSE_BYTES: usize = 1_024;
#[cfg(any(windows, test))]
const PASTE_START: &[u8] = b"\x1b[200~";
#[cfg(any(windows, test))]
const PASTE_END: &[u8] = b"\x1b[201~";

pub(super) fn query_background(host: &HostTerminal) -> Option<TerminalRgb> {
    if host.is_dumb() || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return None;
    }
    query_platform()
}

#[cfg(unix)]
fn query_platform() -> Option<TerminalRgb> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(OSC_BACKGROUND_QUERY).ok()?;
    stdout.flush().ok()?;

    let stdin = rustix::stdio::stdin();
    let original_flags = rustix::fs::fcntl_getfl(stdin).ok()?;
    rustix::fs::fcntl_setfl(stdin, original_flags | rustix::fs::OFlags::NONBLOCK).ok()?;
    let guard = NonblockingGuard { original_flags };
    let deadline = Instant::now() + QUERY_TIMEOUT;
    let mut response = Vec::with_capacity(64);
    let mut chunk = [0_u8; 64];

    while Instant::now() < deadline {
        match rustix::io::read(stdin, &mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&chunk[..count]);
                if let Some(color) = parse_osc_11_response(&response) {
                    drop(guard);
                    return Some(color);
                }
                if response.len() >= 512 {
                    break;
                }
            }
            Err(error) if error == rustix::io::Errno::AGAIN => {
                std::thread::sleep(RETRY_INTERVAL);
            }
            Err(_) => break,
        }
    }
    drop(guard);
    None
}

#[cfg(windows)]
fn query_platform() -> Option<TerminalRgb> {
    windows::query_background(QUERY_TIMEOUT)
}

#[cfg(not(any(unix, windows)))]
fn query_platform() -> Option<TerminalRgb> {
    None
}

#[cfg(unix)]
struct NonblockingGuard {
    original_flags: rustix::fs::OFlags,
}

#[cfg(unix)]
impl Drop for NonblockingGuard {
    fn drop(&mut self) {
        let _ = rustix::fs::fcntl_setfl(rustix::stdio::stdin(), self.original_flags);
    }
}

#[cfg(any(unix, windows, test))]
fn parse_osc_11_response(bytes: &[u8]) -> Option<TerminalRgb> {
    let payload = osc_11_payload(bytes)?;
    let components = if let Some(rgb) = payload.strip_prefix(b"rgb:") {
        parse_rgb_components(rgb)?
    } else {
        parse_hex_triplet(payload.strip_prefix(b"#")?)?
    };
    Some(components.into())
}

#[cfg(any(windows, test))]
fn osc_11_response_ranges(input: &[u8]) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut cursor = 0;

    while cursor < input.len() {
        if input[cursor..].starts_with(PASTE_START) {
            let payload_start = cursor + PASTE_START.len();
            let Some(payload_end) = find_bytes(&input[payload_start..], PASTE_END) else {
                break;
            };
            cursor = payload_start + payload_end + PASTE_END.len();
            continue;
        }

        let prefix_len = if input[cursor..].starts_with(b"\x1b]11;") {
            b"\x1b]11;".len()
        } else if input[cursor..].starts_with(b"\x9d11;") {
            b"\x9d11;".len()
        } else {
            cursor += 1;
            continue;
        };

        let payload_start = cursor + prefix_len;
        let bounded_end = input.len().min(cursor.saturating_add(MAX_RESPONSE_BYTES));
        let Some((payload_len, terminator_len)) =
            osc_payload_end(&input[payload_start..bounded_end])
        else {
            cursor = payload_start;
            continue;
        };
        let end = payload_start + payload_len + terminator_len;
        if parse_osc_11_response(&input[cursor..end]).is_some() {
            ranges.push(cursor..end);
        }
        cursor = end;
    }

    ranges
}

#[cfg(any(windows, test))]
fn osc_11_background(input: &[u8]) -> Option<TerminalRgb> {
    osc_11_response_ranges(input)
        .into_iter()
        .find_map(|range| parse_osc_11_response(&input[range]))
}

#[cfg(any(windows, test))]
fn osc_payload_end(input: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            0x07 => return Some((index, 1)),
            0x1b if input.get(index + 1) == Some(&b'\\') => return Some((index, 2)),
            _ => index += 1,
        }
    }
    None
}

#[cfg(any(unix, windows, test))]
fn osc_11_payload(bytes: &[u8]) -> Option<&[u8]> {
    for introducer in [b"\x1b]11;".as_slice(), b"\x9d11;".as_slice()] {
        let Some(start) = find_bytes(bytes, introducer) else {
            continue;
        };
        let payload = &bytes[start + introducer.len()..];
        let bell = payload.iter().position(|byte| *byte == b'\x07');
        let string_terminator = find_bytes(payload, b"\x1b\\");
        let end = match (bell, string_terminator) {
            (Some(bell), Some(string_terminator)) => bell.min(string_terminator),
            (Some(bell), None) => bell,
            (None, Some(string_terminator)) => string_terminator,
            (None, None) => continue,
        };
        return Some(&payload[..end]);
    }
    None
}

#[cfg(any(unix, windows, test))]
fn parse_rgb_components(value: &[u8]) -> Option<[u8; 3]> {
    let mut components = value.split(|byte| *byte == b'/');
    let red = scale_hex_component(components.next()?)?;
    let green = scale_hex_component(components.next()?)?;
    let blue = scale_hex_component(components.next()?)?;
    components.next().is_none().then_some([red, green, blue])
}

#[cfg(any(unix, windows, test))]
fn parse_hex_triplet(value: &[u8]) -> Option<[u8; 3]> {
    if value.len() != 6 {
        return None;
    }
    Some([
        u8::from_str_radix(std::str::from_utf8(&value[0..2]).ok()?, 16).ok()?,
        u8::from_str_radix(std::str::from_utf8(&value[2..4]).ok()?, 16).ok()?,
        u8::from_str_radix(std::str::from_utf8(&value[4..6]).ok()?, 16).ok()?,
    ])
}

#[cfg(any(unix, windows, test))]
fn scale_hex_component(value: &[u8]) -> Option<u8> {
    if value.is_empty() || value.len() > 4 {
        return None;
    }
    let component = u32::from_str_radix(std::str::from_utf8(value).ok()?, 16).ok()?;
    let maximum = 16_u32.pow(value.len() as u32) - 1;
    Some(((component * 255 + maximum / 2) / maximum) as u8)
}

#[cfg(any(unix, windows, test))]
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

#[cfg(test)]
#[path = "terminal_probe_tests.rs"]
mod tests;
