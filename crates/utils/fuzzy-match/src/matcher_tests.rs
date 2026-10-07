use super::FuzzyMatcher;

#[test]
fn matching_and_highlighting_share_the_best_alignment() {
    let mut matcher = FuzzyMatcher::new("cofig");
    assert!(matcher.score("CONFIG").unwrap() > matcher.score("update-config").unwrap());
    assert_eq!(matcher.indices("CONFIG"), [0, 1, 3, 4, 5]);
    assert!(matcher.score("unrelated").is_none());
    assert!(matcher.indices("unrelated").is_empty());
}

#[test]
fn unicode_indices_address_original_scalar_positions() {
    let mut matcher = FuzzyMatcher::new("设置");
    assert_eq!(matcher.indices("🦀检查设置"), [3, 4]);
    let mut matcher = FuzzyMatcher::new("x");
    assert_eq!(matcher.indices("e\u{0301}X"), [2]);
    let mut matcher = FuzzyMatcher::new("É");
    assert_eq!(matcher.indices("检查é"), [2]);
    assert!(matcher.score("e").is_none());
}

#[test]
fn empty_query_has_no_highlight_and_reusing_a_query_drops_old_indices() {
    assert!(FuzzyMatcher::new("").indices("settings").is_empty());
    let mut matcher = FuzzyMatcher::new("st");
    assert_eq!(matcher.indices("status"), [0, 1]);
    assert_eq!(matcher.indices("test"), [2, 3]);
}
