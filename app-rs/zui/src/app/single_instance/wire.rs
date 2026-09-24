use std::ffi::OsStr;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

use super::SecondInstance;

const MAGIC: &[u8; 8] = b"ZUI-SI\0\x01";
pub(super) const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_ARGUMENTS: usize = 16_384;

pub(super) fn encode(event: &SecondInstance) -> io::Result<Vec<u8>> {
    if event.arguments().len() > MAX_ARGUMENTS {
        return Err(invalid_input("too many secondary arguments"));
    }
    let mut encoded = Vec::new();
    encoded.extend_from_slice(MAGIC);
    push_u32(
        &mut encoded,
        u32::try_from(event.arguments().len())
            .map_err(|_| invalid_input("too many secondary arguments"))?,
    );
    for argument in event.arguments() {
        push_field(&mut encoded, &encode_os(argument))?;
    }
    push_field(
        &mut encoded,
        &encode_os(event.working_directory().as_os_str()),
    )?;
    push_field(&mut encoded, event.additional_data())?;
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err(invalid_input("secondary invocation exceeds 1 MiB"));
    }
    Ok(encoded)
}

pub(super) fn decode(encoded: &[u8]) -> io::Result<SecondInstance> {
    if encoded.len() > MAX_MESSAGE_BYTES {
        return Err(invalid_data("secondary invocation exceeds 1 MiB"));
    }
    let mut cursor = Cursor::new(encoded);
    if cursor.take(MAGIC.len())? != MAGIC {
        return Err(invalid_data("invalid secondary invocation header"));
    }
    let argument_count = usize::try_from(cursor.read_u32()?)
        .map_err(|_| invalid_data("invalid secondary argument count"))?;
    if argument_count > MAX_ARGUMENTS {
        return Err(invalid_data("too many secondary arguments"));
    }
    let mut arguments = Vec::with_capacity(argument_count);
    for _ in 0..argument_count {
        arguments.push(decode_os(cursor.read_field()?)?);
    }
    let working_directory = PathBuf::from(decode_os(cursor.read_field()?)?);
    let additional_data = cursor.read_field()?.to_vec();
    if !cursor.is_finished() {
        return Err(invalid_data("trailing secondary invocation bytes"));
    }
    Ok(SecondInstance::new(arguments, working_directory).with_additional_data(additional_data))
}

fn push_field(encoded: &mut Vec<u8>, field: &[u8]) -> io::Result<()> {
    let length = u32::try_from(field.len())
        .map_err(|_| invalid_input("secondary invocation field is too large"))?;
    let projected = encoded
        .len()
        .checked_add(4)
        .and_then(|length| length.checked_add(field.len()))
        .ok_or_else(|| invalid_input("secondary invocation size overflow"))?;
    if projected > MAX_MESSAGE_BYTES {
        return Err(invalid_input("secondary invocation exceeds 1 MiB"));
    }
    push_u32(encoded, length);
    encoded.extend_from_slice(field);
    Ok(())
}

fn push_u32(encoded: &mut Vec<u8>, value: u32) {
    encoded.extend_from_slice(&value.to_le_bytes());
}

struct Cursor<'a> {
    encoded: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    const fn new(encoded: &'a [u8]) -> Self {
        Self { encoded, offset: 0 }
    }

    fn read_u32(&mut self) -> io::Result<u32> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| invalid_data("truncated secondary invocation integer"))?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_field(&mut self) -> io::Result<&'a [u8]> {
        let length = usize::try_from(self.read_u32()?)
            .map_err(|_| invalid_data("invalid secondary invocation field length"))?;
        self.take(length)
    }

    fn take(&mut self, length: usize) -> io::Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| invalid_data("secondary invocation offset overflow"))?;
        let value = self
            .encoded
            .get(self.offset..end)
            .ok_or_else(|| invalid_data("truncated secondary invocation"))?;
        self.offset = end;
        Ok(value)
    }

    const fn is_finished(&self) -> bool {
        self.offset == self.encoded.len()
    }
}

#[cfg(unix)]
fn encode_os(value: &OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    value.as_bytes().to_vec()
}

#[cfg(unix)]
fn decode_os(value: &[u8]) -> io::Result<OsString> {
    use std::os::unix::ffi::OsStringExt;

    Ok(OsString::from_vec(value.to_vec()))
}

#[cfg(windows)]
fn encode_os(value: &OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().flat_map(u16::to_le_bytes).collect()
}

#[cfg(windows)]
fn decode_os(value: &[u8]) -> io::Result<OsString> {
    use std::os::windows::ffi::OsStringExt;

    if !value.len().is_multiple_of(2) {
        return Err(invalid_data("invalid Windows secondary invocation text"));
    }
    let wide = value
        .chunks_exact(2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    Ok(OsString::from_wide(&wide))
}

fn invalid_input(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
