//! Bounded helper environment transport; workload environment stays in the request.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fmt;

const PREFIX: &str = "ASH_MXC_PTY_LAUNCH_";
const COUNT: &str = "ASH_MXC_PTY_LAUNCH_COUNT";
const LENGTH: &str = "ASH_MXC_PTY_LAUNCH_BYTES";
const CHUNK_BYTES: usize = 8 * 1024;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_CHUNKS: usize = MAX_BYTES / (CHUNK_BYTES - 3) + 1;

#[derive(Debug, Eq, PartialEq)]
pub(super) enum Error {
    Missing,
    Invalid,
    TooLarge,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Missing => "missing PTY launch request",
            Self::Invalid => "invalid PTY launch request",
            Self::TooLarge => "PTY launch request exceeds limit",
        })
    }
}

pub(super) fn encode(payload: &str, env: &mut HashMap<String, String>) -> Result<(), Error> {
    if payload.len() > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    if payload.is_empty() || payload.contains('\0') {
        return Err(Error::Invalid);
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < payload.len() {
        let mut end = (start + CHUNK_BYTES).min(payload.len());
        while !payload.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(payload[start..end].to_owned());
        start = end;
    }
    env.retain(|key, _| !is_key(key.as_ref()));
    env.insert(COUNT.into(), chunks.len().to_string());
    env.insert(LENGTH.into(), payload.len().to_string());
    for (index, chunk) in chunks.into_iter().enumerate() {
        env.insert(format!("{PREFIX}{index}"), chunk);
    }
    Ok(())
}

pub(super) fn decode<K: AsRef<OsStr>, V: AsRef<OsStr>>(
    env: impl IntoIterator<Item = (K, V)>,
) -> Result<String, Error> {
    let mut encoded = HashMap::new();
    for (key, value) in env {
        let key = key.as_ref();
        if !is_key(key) {
            continue;
        }
        let key = key.to_str().ok_or(Error::Invalid)?;
        if key.len() > PREFIX.len() + 16 || encoded.len() >= MAX_CHUNKS + 2 {
            return Err(Error::TooLarge);
        }
        let key = key.to_ascii_uppercase();
        let value = value.as_ref().to_str().ok_or(Error::Invalid)?;
        if value.len() > CHUNK_BYTES {
            return Err(Error::TooLarge);
        }
        if value.contains('\0') || encoded.insert(key, value.to_owned()).is_some() {
            return Err(Error::Invalid);
        }
    }
    let count = encoded.get(COUNT).ok_or(Error::Missing)?;
    let count = count.parse::<usize>().map_err(|_| Error::Invalid)?;
    let length = encoded.get(LENGTH).ok_or(Error::Invalid)?;
    let length = length.parse::<usize>().map_err(|_| Error::Invalid)?;
    if count > MAX_CHUNKS || length > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    if count == 0 || length == 0 || encoded.len() != count + 2 {
        return Err(Error::Invalid);
    }
    let mut payload = String::with_capacity(length);
    for index in 0..count {
        let chunk = encoded
            .get(&format!("{PREFIX}{index}"))
            .ok_or(Error::Invalid)?;
        if chunk.is_empty() || payload.len() + chunk.len() > length {
            return Err(Error::Invalid);
        }
        payload.push_str(chunk);
    }
    if payload.len() != length {
        return Err(Error::Invalid);
    }
    Ok(payload)
}

fn is_key(key: &OsStr) -> bool {
    key.as_encoded_bytes()
        .get(..PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(PREFIX.as_bytes()))
}

#[cfg(test)]
#[path = "pty_transport_tests.rs"]
mod tests;
