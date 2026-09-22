use super::COMMAND_OVERLAP;
use super::DEVELOPER_TERMS;
use super::ENGLISH_STEMS;
use super::classify_with_fallback_heuristic;
use super::natural_language_words_score;
use crate::InputClassificationSource;
use crate::InputRoute;
use crate::parser::parse_query_into_tokens;
use crate::shell::ShellContext;
use sha2::Digest;
use sha2::Sha256;

fn fallback(input: &str) -> crate::InputClassification {
    let shell = ShellContext::new(".").analyze(input);
    classify_with_fallback_heuristic(
        input,
        parse_query_into_tokens(input),
        &shell,
        InputRoute::Shell,
    )
}

#[test]
fn dictionary_fallback_recognizes_short_natural_language() {
    for input in ["fix this", "What's the reason", "What went wrong?"] {
        let classification = fallback(input);
        assert_eq!(classification.route, InputRoute::Agent, "input: {input}");
        assert_eq!(
            classification.source,
            InputClassificationSource::HeuristicFallback
        );
    }
}

#[test]
fn quoted_shell_syntax_does_not_reduce_natural_language_score() {
    assert_eq!(fallback("The type is \"<>\"").route, InputRoute::Agent);
}

#[test]
fn command_overlap_counts_as_language_until_shell_resolution_confirms_a_command() {
    let words = vec!["act".to_owned(), "now".to_owned()];

    assert_eq!(natural_language_words_score(&words, false), 2);
    assert_eq!(natural_language_words_score(&words, true), 1);
}

#[test]
fn embedded_ash_dictionaries_match_the_approved_bundle() {
    let dictionaries = [
        (
            ENGLISH_STEMS,
            4_131,
            "13858a67dd3893e1552a91ffce56c82d09b766299232da671f5fd8ccc956d0ac",
        ),
        (
            DEVELOPER_TERMS,
            2_381,
            "7f7707f853b826c495b04b4209dbbdf442431455975d16439a4db40be3b7a29f",
        ),
        (
            COMMAND_OVERLAP,
            608,
            "bee2a5a3730eee7eb972976a2b60bbee4cf1456d9bb0240e266de83c62767357",
        ),
    ];

    for (dictionary, expected_lines, expected_sha256) in dictionaries {
        let lines = dictionary.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), expected_lines);
        assert!(lines.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(format!("{:x}", Sha256::digest(dictionary)), expected_sha256);
    }
}
