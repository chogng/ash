use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::OnceLock;

use rust_stemmers::Algorithm;
use rust_stemmers::Stemmer;

use crate::InputClassification;
use crate::InputClassificationSource;
use crate::InputRoute;
use crate::rules::is_natural_language_one_off_or_prefix;
use crate::shell::ShellTokenSnapshot;

const MINIMUM_DETECTION_TOKEN_LENGTH: usize = 2;
const END_TOKEN_COMPLETE_KEYS: &[char] = &[' ', '?', '!', '.', '"', ','];
const ENGLISH_STEMS: &str = include_str!("../dictionaries/ash_english_stems.txt");
const DEVELOPER_TERMS: &str = include_str!("../dictionaries/ash_developer_terms.txt");
const COMMAND_OVERLAP: &str = include_str!("../dictionaries/ash_command_overlap.txt");

static ENGLISH_STEM_LIST: OnceLock<HashSet<&'static str>> = OnceLock::new();
static DEVELOPER_TERM_LIST: OnceLock<HashSet<&'static str>> = OnceLock::new();
static COMMAND_OVERLAP_LIST: OnceLock<HashSet<&'static str>> = OnceLock::new();

pub(super) fn classify_with_fallback_heuristic(
    input: &str,
    word_tokens: Vec<String>,
    shell_snapshot: &ShellTokenSnapshot,
    current_route: InputRoute,
) -> InputClassification {
    if word_tokens.len() == 1
        && word_tokens
            .first()
            .is_some_and(|word| is_natural_language_one_off_or_prefix(&word.to_lowercase()))
    {
        return classification(InputRoute::Agent);
    }
    if shell_snapshot.is_likely_shell_command(word_tokens.len()) {
        return classification(InputRoute::Shell);
    }
    let without_incomplete_last = natural_language_detection_heuristic(
        input,
        word_tokens.clone(),
        shell_snapshot.first_token_is_command(),
        current_route,
        LastToken::ExcludeIfIncomplete,
    );
    if without_incomplete_last == InputRoute::Agent {
        return classification(InputRoute::Agent);
    }
    classification(natural_language_detection_heuristic(
        input,
        word_tokens,
        shell_snapshot.first_token_is_command(),
        current_route,
        LastToken::Include,
    ))
}

#[derive(Clone, Copy)]
enum LastToken {
    ExcludeIfIncomplete,
    Include,
}

fn natural_language_detection_heuristic(
    input: &str,
    mut word_tokens: Vec<String>,
    first_token_is_command: bool,
    current_route: InputRoute,
    last_token: LastToken,
) -> InputRoute {
    let minimum_token_length = match current_route {
        InputRoute::Agent | InputRoute::Shell => MINIMUM_DETECTION_TOKEN_LENGTH,
    };
    if word_tokens.len() < minimum_token_length {
        return InputRoute::Shell;
    }
    let last_token_is_complete = input.ends_with(END_TOKEN_COMPLETE_KEYS);
    if matches!(last_token, LastToken::ExcludeIfIncomplete)
        && !last_token_is_complete
        && word_tokens.len() > 2
    {
        word_tokens.pop();
    }
    let token_count = word_tokens.len();
    let likely_english_count = natural_language_words_score(&word_tokens, first_token_is_command);
    let threshold = if token_count <= 3 {
        1.0
    } else if token_count <= 4 {
        0.8
    } else {
        0.6
    };
    if likely_english_count >= (token_count as f32 * threshold) as usize {
        InputRoute::Agent
    } else {
        InputRoute::Shell
    }
}

fn natural_language_words_score(words: &[String], first_token_is_command: bool) -> usize {
    let stemmer = Stemmer::create(Algorithm::English);
    let mut natural_language_count = 0usize;

    for (index, token) in words.iter().enumerate() {
        let token = preprocess_token(token);
        if index == 0 && first_token_is_command && token != "what" {
            continue;
        }
        if is_developer_term(&token) || is_command_overlap(&token) {
            natural_language_count += 1;
            continue;
        }
        let stemmed = stemmer.stem(&token);
        if is_english_stem(&stemmed) || is_developer_term(&stemmed) || is_command_overlap(&stemmed)
        {
            natural_language_count += 1;
        } else if !wrapped_in_quotes(&token) && has_shell_syntax(&token) {
            natural_language_count = natural_language_count.saturating_sub(1);
        }
    }
    natural_language_count
}

fn preprocess_token(token: &str) -> Cow<'_, str> {
    let lowercase = token.to_lowercase();
    if lowercase == "can't" {
        return Cow::Borrowed("can");
    }
    for suffix in ["'re", "n't", "'ve", "'ll", "'s", "'t", "'m"] {
        if let Some(root) = lowercase.strip_suffix(suffix) {
            return Cow::Owned(root.to_owned());
        }
    }
    Cow::Owned(lowercase)
}

fn is_english_stem(word: &str) -> bool {
    ENGLISH_STEM_LIST
        .get_or_init(|| ENGLISH_STEMS.lines().collect())
        .contains(word)
}

fn is_developer_term(word: &str) -> bool {
    DEVELOPER_TERM_LIST
        .get_or_init(|| DEVELOPER_TERMS.lines().collect())
        .contains(word)
}

fn is_command_overlap(word: &str) -> bool {
    COMMAND_OVERLAP_LIST
        .get_or_init(|| COMMAND_OVERLAP.lines().collect())
        .contains(word)
}

fn has_shell_syntax(word: &str) -> bool {
    !word.contains(' ')
        && word.contains([
            '$', '=', '{', '}', '[', ']', '>', '<', '*', '~', '&', '(', ')', '|', '/', '-',
        ])
}

fn wrapped_in_quotes(word: &str) -> bool {
    (word.starts_with('"') && word.ends_with('"'))
        || (word.starts_with('\'') && word.ends_with('\''))
}

const fn classification(route: InputRoute) -> InputClassification {
    InputClassification::deterministic(route, InputClassificationSource::HeuristicFallback)
}

#[cfg(test)]
#[path = "natural_language_tests.rs"]
mod tests;
