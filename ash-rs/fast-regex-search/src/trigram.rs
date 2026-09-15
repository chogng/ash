//! Next-byte filter design adapted from microsoft/tgrep (MIT); see
//! `../THIRD_PARTY_NOTICES.md` for the upstream notice.
//!
//! ASCII-folded three-byte keys with an eight-bit filter for following bytes.
//! Packed grams use the low byte for the mask; packed postings use the low
//! byte for the same mask and the remaining bits for the document ID.

use sha2::Digest;
use sha2::Sha256;
use std::collections::HashMap;
use std::hash::BuildHasherDefault;
use std::hash::Hasher;

#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = self.0.wrapping_mul(0x100000001b3) ^ u64::from(*byte);
        }
    }
    fn write_u32(&mut self, key: u32) {
        let value = u64::from(key).wrapping_mul(0x9e3779b97f4a7c15);
        self.0 = value ^ (value >> 32);
    }
}

pub(crate) fn format_digest() -> [u8; 32] {
    Sha256::digest(b"ascii-folded-trigram-next-byte-mask-v1").into()
}

fn bit(byte: u8) -> u8 {
    1 << ((byte.wrapping_mul(0x9e) >> 5) & 7)
}

pub(crate) fn extract(bytes: &[u8]) -> Vec<u64> {
    let mut grams: HashMap<u32, u8, BuildHasherDefault<KeyHasher>> = HashMap::default();
    for (offset, window) in bytes.windows(3).enumerate() {
        let key = u32::from_be_bytes([0, window[0], window[1], window[2]]);
        let next = bytes.get(offset + 3).copied().map_or(0, bit);
        *grams.entry(key).or_default() |= next;
    }
    let mut result = grams
        .into_iter()
        .map(|(key, mask)| (u64::from(key) << 8) | u64::from(mask))
        .collect::<Vec<_>>();
    result.sort_unstable();
    result
}

pub(crate) fn key(gram: u64) -> u64 {
    gram >> 8
}
pub(crate) fn mask(gram: u64) -> u8 {
    gram as u8
}
pub(crate) fn posting(id: u32, mask: u8) -> u64 {
    (u64::from(id) << 8) | u64::from(mask)
}
pub(crate) fn document_id(posting: u64) -> u32 {
    (posting >> 8) as u32
}
pub(crate) fn accepts(posting: u64, required: u8) -> bool {
    mask(posting) & required == required
}

#[cfg(test)]
#[path = "trigram_tests.rs"]
mod tests;
