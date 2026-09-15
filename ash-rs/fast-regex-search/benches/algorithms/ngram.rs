use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;

const MAX_NGRAM_BYTES: usize = 32;
const BIGRAM_PAIR_COUNT: usize = 1 << 16;
const BIGRAM_FREQUENCY_ORDER: &[u8; 53_000] =
    include_bytes!("../../data/ascii-bigram-frequency-order-v1.bin");
static BIGRAM_RANKS: [u16; BIGRAM_PAIR_COUNT] = expand_bigram_frequency_order();

pub(crate) fn bigram_frequency_digest() -> [u8; 32] {
    Sha256::digest(BIGRAM_FREQUENCY_ORDER).into()
}

const fn expand_bigram_frequency_order() -> [u16; BIGRAM_PAIR_COUNT] {
    let mut ranks = [u16::MAX; BIGRAM_PAIR_COUNT];
    let mut offset = 0usize;
    while offset < BIGRAM_FREQUENCY_ORDER.len() {
        let pair = u16::from_le_bytes([
            BIGRAM_FREQUENCY_ORDER[offset],
            BIGRAM_FREQUENCY_ORDER[offset + 1],
        ]);
        assert!(ranks[pair as usize] == u16::MAX);
        ranks[pair as usize] = (offset / 2) as u16;
        offset += 2;
    }

    let mut next_rank = BIGRAM_FREQUENCY_ORDER.len() / 2;
    let mut pair = 0usize;
    while pair < ranks.len() {
        if ranks[pair] == u16::MAX {
            ranks[pair] = next_rank as u16;
            next_rank += 1;
        }
        pair += 1;
    }
    assert!(next_rank == BIGRAM_PAIR_COUNT);
    ranks
}

pub(crate) fn sparse_ngrams(bytes: &[u8]) -> Vec<u64> {
    let mut grams = Vec::with_capacity(bytes.len());
    visit_grams(bytes, |gram| grams.push(gram.hash));
    grams.sort_unstable();
    grams.dedup();
    grams
}

/// Returns a small set of sparse grams whose byte ranges cover the required literal.
///
/// Every returned gram is also emitted by [`sparse_ngrams`] when the literal occurs inside a
/// larger document. Intersecting their posting lists can therefore remove false candidates but
/// cannot remove a real match.
pub(crate) fn covering_ngrams(bytes: &[u8]) -> Vec<u64> {
    let spans = sparse_gram_spans(bytes);
    if spans.is_empty() {
        return Vec::new();
    }
    let mut selected = BTreeSet::new();
    let mut covered_until = 0usize;
    while covered_until < bytes.len() {
        let best = spans
            .iter()
            .filter(|gram| gram.start <= covered_until && gram.end > covered_until)
            .max_by_key(|gram| (gram.end, usize::MAX - gram.start));
        let Some(best) = best else {
            break;
        };
        selected.insert(best.hash);
        covered_until = best.end;
    }
    selected.into_iter().collect()
}

#[derive(Clone, Copy)]
struct SparseGram {
    start: usize,
    end: usize,
    hash: u64,
}

fn sparse_gram_spans(bytes: &[u8]) -> Vec<SparseGram> {
    let mut grams = Vec::new();
    visit_grams(bytes, |gram| grams.push(gram));
    grams.sort_by_key(|gram| gram.hash);
    grams.dedup_by_key(|gram| gram.hash);
    grams
}

fn visit_grams(bytes: &[u8], mut visit: impl FnMut(SparseGram)) {
    if bytes.len() < 3 {
        return;
    }
    let pair_weights = bytes
        .windows(2)
        .map(|pair| pair_weight(pair[0], pair[1]))
        .collect::<Vec<_>>();
    for left in 0..pair_weights.len().saturating_sub(1) {
        let mut internal_max = 0u64;
        let mut hash = hash_bytes(&bytes[left..left + 2]);
        let right_limit = (left + MAX_NGRAM_BYTES - 2).min(pair_weights.len() - 1);
        for right in left + 1..=right_limit {
            if right > left + 1 {
                internal_max = internal_max.max(pair_weights[right - 1]);
            }
            // Once the left boundary is no longer a maximum, extending this
            // span cannot restore it. Stop instead of checking every length.
            if pair_weights[left] <= internal_max {
                break;
            }
            hash = (hash ^ u64::from(bytes[right + 1])).wrapping_mul(0x100000001b3);
            if pair_weights[right] > internal_max {
                visit(SparseGram {
                    start: left,
                    end: right + 2,
                    hash,
                });
            }
        }
    }
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn pair_index(left: u8, right: u8) -> usize {
    usize::from(left) | (usize::from(right) << 8)
}

fn pair_weight(left: u8, right: u8) -> u64 {
    let pair = pair_index(left, right);
    if left.is_ascii() && right.is_ascii() {
        u64::from(BIGRAM_RANKS[pair])
    } else {
        (pair as u64) << 16
    }
}
