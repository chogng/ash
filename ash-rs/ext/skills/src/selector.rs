use std::collections::BTreeSet;

use ash_config::SkillEnablement;
use ash_protocol::SkillId;
use ash_protocol::SkillRef;
use ash_protocol::UserInput;
use ash_skills::SkillCompatibility;

use crate::SkillRuntimeEntry;
use crate::SkillRuntimeSnapshot;

const MAX_SELECTOR_INPUT_BYTES: usize = 16 * 1024;
const MIN_UNIQUE_SCORE: u64 = 60;

pub(crate) fn select(
    snapshot: &SkillRuntimeSnapshot,
    input: &[UserInput],
    excluded: &[SkillId],
) -> Option<SkillRef> {
    let text = selector_text(input);
    if text.is_empty() {
        return None;
    }
    let input_tokens = tokens(&text);
    let excluded = excluded.iter().collect::<BTreeSet<_>>();
    let mut candidates = snapshot
        .entries
        .iter()
        .filter(|entry| eligible(entry) && !excluded.contains(entry.catalog_entry.id()))
        .filter_map(|entry| {
            let score = score(entry, &text, &input_tokens);
            (score >= MIN_UNIQUE_SCORE).then_some((score, entry))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.catalog_entry.id().cmp(right.catalog_entry.id()))
    });
    let (best_score, best) = candidates.first()?;
    if candidates
        .get(1)
        .is_some_and(|(runner_up, _)| runner_up == best_score)
    {
        return None;
    }
    Some(SkillRef::pinned(
        best.catalog_entry.id().clone(),
        best.catalog_entry.content_digest().clone(),
    ))
}

fn eligible(entry: &SkillRuntimeEntry) -> bool {
    entry.enablement == SkillEnablement::Enabled
        && matches!(
            entry.catalog_entry.compatibility(),
            SkillCompatibility::Compatible
        )
        && entry.catalog_entry.source().allows_automatic_activation()
}

fn score(entry: &SkillRuntimeEntry, text: &str, input_tokens: &BTreeSet<String>) -> u64 {
    let name_phrase = normalize(
        entry
            .catalog_entry
            .id()
            .name
            .as_str()
            .replace('-', " ")
            .as_str(),
    );
    let name_tokens = tokens(&name_phrase);
    let description_tokens = tokens(entry.catalog_entry.metadata().description());
    let name_matches = name_tokens.intersection(input_tokens).count() as u64;
    let description_matches = description_tokens.intersection(input_tokens).count() as u64;
    let exact_name = contains_phrase(text, &name_phrase);
    let complete_name = name_tokens.len() >= 2 && name_matches == name_tokens.len() as u64;

    u64::from(exact_name) * 200
        + u64::from(complete_name) * 100
        + name_matches * 30
        + description_matches * 20
}

fn selector_text(input: &[UserInput]) -> String {
    let mut result = String::new();
    for text in input.iter().filter_map(|item| match item {
        UserInput::Text { text } => Some(text.as_str()),
        UserInput::Context { .. }
        | UserInput::ImageAttachment { .. }
        | UserInput::Image { .. }
        | UserInput::LocalImage { .. }
        | UserInput::Skill { .. }
        | UserInput::Mention { .. } => None,
        UserInput::Instruction { .. } => None,
    }) {
        if !result.is_empty() {
            if result.len() == MAX_SELECTOR_INPUT_BYTES {
                break;
            }
            result.push(' ');
        }
        let remaining = MAX_SELECTOR_INPUT_BYTES.saturating_sub(result.len());
        if remaining == 0 {
            break;
        }
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        result.push_str(&text[..end]);
    }
    normalize(&result)
}

fn contains_phrase(text: &str, phrase: &str) -> bool {
    format!(" {text} ").contains(&format!(" {phrase} "))
}

fn tokens(value: &str) -> BTreeSet<String> {
    normalize(value)
        .split_whitespace()
        .filter_map(canonical_token)
        .collect()
}

fn normalize(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut separated = true;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            normalized.push(character);
            separated = false;
        } else if !separated {
            normalized.push(' ');
            separated = true;
        }
    }
    normalized.trim().to_owned()
}

fn canonical_token(value: &str) -> Option<String> {
    const STOP_WORDS: &[&str] = &[
        "and", "are", "for", "from", "into", "that", "the", "this", "use", "user", "when", "with",
        "your",
    ];
    if value.len() < 3 || STOP_WORDS.contains(&value) {
        return None;
    }
    let mut token = value.to_owned();
    if token.len() > 4 && token.ends_with('s') && !token.ends_with("ss") {
        token.pop();
    }
    Some(token)
}

#[cfg(test)]
#[path = "selector_tests.rs"]
mod tests;
