use crate::InputClassification;
use crate::InputClassificationContext;
use crate::InputClassificationSource;
use crate::InputRoute;

const NATURAL_LANGUAGE_ONE_OFFS: &[&str] = &[
    "hello",
    "hi",
    "hey",
    "hola",
    "thanks",
    "explain",
    "yes",
    "no",
    "what",
    "nice",
    "1. ",
    "thank you",
    "你好",
    "您好",
    "多谢",
    "谢谢",
];

const AGENT_FOLLOW_UP_INPUTS: &[&str] = &["yes", "continue", "do it", "approve"];

const SHELL_COMMAND_KEYWORDS: &[&str] = &[
    "#", "agy", "claude", "codex", "echo", "gemini", "man", "omp", "sudo", "warp", "ash",
];

pub(super) fn classify_contextual_input(
    input: &str,
    context: InputClassificationContext,
) -> Option<InputClassification> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Some(InputClassification {
            route: context.current_route,
            confidence: 0.0,
            source: InputClassificationSource::EmptyInput,
        });
    }
    let normalized = trimmed.to_lowercase();
    if context.conversation == crate::InputConversation::AgentFollowUp
        && AGENT_FOLLOW_UP_INPUTS.contains(&normalized.as_str())
    {
        return Some(InputClassification::deterministic(
            InputRoute::Agent,
            InputClassificationSource::AgentFollowUp,
        ));
    }
    None
}

pub(super) fn classify_current_route_input(
    word_tokens: &[String],
    context: InputClassificationContext,
) -> Option<InputClassification> {
    let first_word_is_natural_language = word_tokens
        .first()
        .is_some_and(|word| is_natural_language_one_off(&word.to_lowercase()));
    (first_word_is_natural_language && context.current_route == InputRoute::Agent).then(|| {
        InputClassification::deterministic(
            InputRoute::Agent,
            InputClassificationSource::NaturalLanguageOneOff,
        )
    })
}

pub(super) fn classify_allowlisted_input(word_tokens: &[String]) -> Option<InputClassification> {
    if word_tokens.len() == 1
        && word_tokens
            .first()
            .is_some_and(|word| is_natural_language_one_off(&word.to_lowercase()))
    {
        return Some(InputClassification::deterministic(
            InputRoute::Agent,
            InputClassificationSource::NaturalLanguageOneOff,
        ));
    }
    if word_tokens
        .first()
        .is_some_and(|word| is_shell_command_keyword(&word.to_lowercase()))
    {
        return Some(InputClassification::deterministic(
            InputRoute::Shell,
            InputClassificationSource::ShellAllowlist,
        ));
    }
    None
}

pub(super) fn is_natural_language_one_off(input: &str) -> bool {
    NATURAL_LANGUAGE_ONE_OFFS.contains(&input)
}

pub(super) fn is_natural_language_one_off_or_prefix(input: &str) -> bool {
    is_natural_language_one_off(input)
        || (!input.is_empty()
            && NATURAL_LANGUAGE_ONE_OFFS
                .iter()
                .any(|candidate| candidate.starts_with(input)))
}

pub(super) fn is_shell_command_keyword(input: &str) -> bool {
    SHELL_COMMAND_KEYWORDS.contains(&input)
}
