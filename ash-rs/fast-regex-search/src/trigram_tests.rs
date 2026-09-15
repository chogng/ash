use super::*;

#[test]
fn every_embedded_literal_retains_all_required_following_bytes() {
    let source = b"fn authentication_token(Abca,abcx) { abcabc; return\xc3\xa9 }";
    let grams = extract(source);
    for start in 0..source.len() {
        for end in start + 3..=source.len() {
            for required in extract(&source[start..end]) {
                let index = grams
                    .binary_search_by_key(&key(required), |g| key(*g))
                    .unwrap();
                assert!(accepts(grams[index], mask(required)), "{start}..{end}");
            }
        }
    }
}

#[test]
fn masks_merge_repeated_grams_and_do_not_constrain_terminal_grams() {
    let grams = extract(b"abcx abcy abc");
    let required = extract(b"abc");
    assert_eq!(mask(required[0]), 0);
    let index = grams
        .binary_search_by_key(&key(required[0]), |g| key(*g))
        .unwrap();
    assert_eq!(mask(grams[index]), bit(b'x') | bit(b'y'));
    assert!(accepts(grams[index], mask(required[0])));
    assert_eq!(document_id(posting(u32::MAX, 255)), u32::MAX);
}
