use super::text_match_score;
use fuzzy_match::FuzzyMatcher;

#[test]
fn text_match_scores_exact_prefix_word_substring_and_fuzzy_in_order() {
    let scores = [
        text_match_score("status", "status", &mut FuzzyMatcher::new("status")).unwrap(),
        text_match_score("status line", "status", &mut FuzzyMatcher::new("status")).unwrap(),
        text_match_score("show status", "status", &mut FuzzyMatcher::new("status")).unwrap(),
        text_match_score("appstatus", "status", &mut FuzzyMatcher::new("status")).unwrap(),
        text_match_score("s-t-a-t-u-s", "status", &mut FuzzyMatcher::new("status")).unwrap(),
    ];

    assert!(scores.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(text_match_score("settings", "status", &mut FuzzyMatcher::new("status")).is_none());
}
