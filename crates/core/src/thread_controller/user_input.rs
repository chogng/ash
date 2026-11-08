use ash_attachments::Attachments;
use ash_protocol::AudioAttachmentRef;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillVersionSelector;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::sync::Arc;

use super::ThreadController;
use crate::CoreError;
pub(super) enum ValidatedUserInput<'a> {
    Text(&'a str),
    Context {
        name: &'a str,
        content: &'a str,
        source_url: Option<&'a str>,
    },
    Image(&'a ImageAttachmentRef),
    Audio(&'a AudioAttachmentRef),
}

pub(super) fn normalize_attachments(
    input: &[UserInput],
    attachments: &Arc<Attachments>,
) -> Result<Vec<UserInput>, CoreError> {
    input
        .iter()
        .map(|input| match input {
            UserInput::AudioAttachment { attachment } => {
                attachments
                    .verify_audio(attachment)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                Ok(input.clone())
            }
            UserInput::Audio { url } => attachments
                .import_audio_data_url(url)
                .map(|attachment| UserInput::AudioAttachment { attachment })
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
            UserInput::ImageAttachment { attachment } => {
                attachments
                    .verify(attachment)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                Ok(input.clone())
            }
            UserInput::Image { url } if is_data_url(url) => attachments
                .import_data_url(url)
                .map(|attachment| UserInput::ImageAttachment { attachment })
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
            UserInput::Image { url } if is_remote_image_url(url) => attachments
                .import_remote_url(url)
                .map(|attachment| UserInput::ImageAttachment { attachment })
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
            UserInput::Image { .. } => Err(CoreError::InvalidInput(
                "image input must be a data URL, an HTTP(S) URL, or a durable attachment".into(),
            )),
            UserInput::Text { .. }
            | UserInput::Context { .. }
            | UserInput::ChatReference { .. }
            | UserInput::LocalImage { .. }
            | UserInput::Skill { .. }
            | UserInput::ToolSelection { .. }
            | UserInput::Mention { .. } => Ok(input.clone()),
        })
        .collect()
}

/// The source coordinates also bind the materialized item to its steering receipt.
pub(crate) fn chat_reference_source(session_id: &SessionId, thread_id: &ThreadId) -> String {
    format!(
        "Referenced conversation (session {:?}, thread {:?})\n\n",
        session_id.as_str(),
        thread_id.as_str()
    )
}

/// Keep the original reference in the command receipt. Only the transcript item holds
/// the materialized excerpt so retries and queue recovery compare stable input.
pub(super) fn resolve_chat_references<'a>(
    controller: &ThreadController,
    input: &'a [UserInput],
) -> Cow<'a, [UserInput]> {
    if !input
        .iter()
        .any(|item| matches!(item, UserInput::ChatReference { .. }))
    {
        return Cow::Borrowed(input);
    }
    Cow::Owned(
        input
            .iter()
            .map(|item| match item {
                UserInput::ChatReference {
                    name,
                    session_id,
                    thread_id,
                } => {
                    let mut content = chat_reference_source(session_id, thread_id);
                    let excerpt = controller.with_loaded_thread(thread_id, |loaded| {
                        let snapshot = &loaded.snapshot;
                        Ok((&snapshot.session_id == session_id)
                            .then(|| recent_chat_excerpt(snapshot)))
                    });
                    match excerpt {
                        Ok(Some(excerpt)) if !excerpt.is_empty() => content.push_str(&excerpt),
                        Ok(Some(_)) => content.push_str(
                            "The referenced conversation has no completed text messages.",
                        ),
                        _ => content.push_str("The referenced conversation is unavailable."),
                    }
                    UserInput::Context {
                        name: name.clone(),
                        content,
                        source_url: None,
                    }
                }
                _ => item.clone(),
            })
            .collect(),
    )
}

fn recent_chat_excerpt(snapshot: &crate::ThreadSnapshot) -> String {
    // Bound model context while preserving the existing Ash allowance for long references.
    const MAX_BYTES: usize = 100_000;
    let finished = snapshot
        .turns
        .iter()
        .filter_map(|turn| {
            matches!(
                turn.status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            )
            .then_some(&turn.turn_id)
        })
        .collect::<BTreeSet<_>>();
    let messages = snapshot.items.iter().rev().filter_map(|item| match item {
        ThreadItem::UserMessage { turn_id, text, .. } if finished.contains(turn_id) => {
            Some(("User", text))
        }
        ThreadItem::AgentMessage { turn_id, text, .. } if finished.contains(turn_id) => {
            Some(("Assistant", text))
        }
        _ => None,
    });
    let mut recent = Vec::new();
    let mut remaining = MAX_BYTES;
    let mut omitted = false;
    for (speaker, text) in messages.filter(|(_, text)| !text.trim().is_empty()) {
        let overhead = speaker.len() + 8; // role heading and paragraph separators
        if overhead >= remaining || (!recent.is_empty() && text.len() > remaining - overhead) {
            omitted = true;
            break;
        }
        let start = text.ceil_char_boundary(text.len().saturating_sub(remaining - overhead));
        recent.push(format!("### {speaker}\n\n{}", &text[start..]));
        remaining -= overhead + text.len() - start;
        omitted |= start > 0;
    }
    if omitted {
        recent.push("[Earlier text omitted]".into());
    }
    recent.reverse();
    recent.join("\n\n")
}

pub(super) fn validate<'a>(
    input: &'a [UserInput],
    activated_skills: &[FrozenSkillActivation],
) -> Result<Vec<ValidatedUserInput<'a>>, CoreError> {
    if input.is_empty() {
        return Err(CoreError::InvalidInput(
            "Turn input must contain at least one item".into(),
        ));
    }
    tool_selection(input)?;

    let validated = input
        .iter()
        .filter_map(|input| match input {
            UserInput::Text { text } if !text.trim().is_empty() => {
                Some(Ok(ValidatedUserInput::Text(text)))
            }
            UserInput::Text { .. } => Some(Err(CoreError::InvalidInput(
                "Turn text input must not be empty".into(),
            ))),
            UserInput::Context {
                name,
                content,
                source_url,
            } if !name.trim().is_empty() && !content.trim().is_empty() => {
                Some(Ok(ValidatedUserInput::Context {
                    name,
                    content,
                    source_url: source_url.as_deref(),
                }))
            }
            UserInput::Context { .. } => Some(Err(CoreError::InvalidInput(
                "Turn context input must have a non-empty name and content".into(),
            ))),
            UserInput::AudioAttachment { attachment } => {
                Some(Ok(ValidatedUserInput::Audio(attachment)))
            }
            UserInput::Audio { .. } => Some(Err(CoreError::InvalidInput(
                "audio input must be normalized before validation".into(),
            ))),
            UserInput::ImageAttachment { attachment } => {
                Some(Ok(ValidatedUserInput::Image(attachment)))
            }
            UserInput::Image { .. } => Some(Err(CoreError::InvalidInput(
                "legacy image input must be normalized before validation".into(),
            ))),
            UserInput::Skill { .. } | UserInput::ToolSelection { .. } => None,
            UserInput::LocalImage { .. }
            | UserInput::Mention { .. }
            | UserInput::ChatReference { .. } => Some(Err(CoreError::InvalidInput(
                "this Thread controller currently accepts text, context, and validated attachments"
                    .into(),
            ))),
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_skill_activations(input, activated_skills)?;
    if validated.is_empty() {
        return Err(CoreError::InvalidInput(
            "Turn input must include text, context, or an attachment in addition to Skill or tool selections".into(),
        ));
    }
    Ok(validated)
}

fn validate_skill_activations(
    input: &[UserInput],
    activated_skills: &[FrozenSkillActivation],
) -> Result<(), CoreError> {
    let selected = input
        .iter()
        .filter_map(|input| match input {
            UserInput::Skill { skill } => Some(skill),
            UserInput::Text { .. }
            | UserInput::Context { .. }
            | UserInput::ChatReference { .. }
            | UserInput::ImageAttachment { .. }
            | UserInput::AudioAttachment { .. }
            | UserInput::Audio { .. }
            | UserInput::Image { .. }
            | UserInput::LocalImage { .. }
            | UserInput::Mention { .. } => None,
            UserInput::ToolSelection { .. } => None,
        })
        .collect::<Vec<_>>();
    let explicit = activated_skills
        .iter()
        .filter(|activation| activation.reason == SkillActivationReason::Explicit)
        .collect::<Vec<_>>();
    if selected.len() != explicit.len() {
        return Err(CoreError::InvalidInput(
            "every selected Skill must have one frozen activation".into(),
        ));
    }
    for (selected, activated) in selected.into_iter().zip(explicit) {
        if selected.id != activated.id {
            return Err(CoreError::InvalidInput(
                "frozen Skill activation does not match its explicit selection".into(),
            ));
        }
        if let SkillVersionSelector::PinnedDigest { digest } = &selected.version
            && digest != &activated.content_digest
        {
            return Err(CoreError::InvalidInput(
                "frozen Skill activation does not match its pinned digest".into(),
            ));
        }
    }
    Ok(())
}

/// Borrowed, already resolved tool selection supplied at Turn admission.
pub(super) struct ToolSelection<'a> {
    pub disabled: &'a [ash_protocol::ToolName],
    pub allowed: Option<&'a [ash_protocol::ToolName]>,
}

pub(super) fn tool_selection(input: &[UserInput]) -> Result<Option<ToolSelection<'_>>, CoreError> {
    let mut selections = input.iter().filter_map(|item| match item {
        UserInput::ToolSelection { disabled, allowed } => Some(ToolSelection {
            disabled,
            allowed: allowed.as_deref(),
        }),
        _ => None,
    });
    let selected = selections.next();
    let valid_names = |names: &[ash_protocol::ToolName]| {
        names.len() <= 4096
            && names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == names.len()
    };
    if selections.next().is_some()
        || selected.as_ref().is_some_and(|selection| {
            !valid_names(selection.disabled)
                || selection.allowed.is_some_and(|names| !valid_names(names))
        })
    {
        return Err(CoreError::InvalidInput(
            "Tool selection must occur once with at most 4096 unique names per scope".into(),
        ));
    }
    Ok(selected)
}

pub(super) fn thread_items(
    input: &[ValidatedUserInput<'_>],
    turn_id: &TurnId,
    command_id: &ash_protocol::CommandId,
    mut next_item_id: impl FnMut() -> ItemId,
) -> Vec<ThreadItem> {
    input
        .iter()
        .map(|input| match input {
            ValidatedUserInput::Text(text) => ThreadItem::UserMessage {
                client_id: Some(command_id.clone()),
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                text: (*text).to_owned(),
            },
            ValidatedUserInput::Context {
                name,
                content,
                source_url,
            } => ThreadItem::UserContext {
                source_url: source_url.map(str::to_owned),
                client_id: Some(command_id.clone()),
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                name: (*name).to_owned(),
                content: (*content).to_owned(),
            },
            ValidatedUserInput::Audio(attachment) => ThreadItem::UserAudioAttachment {
                client_id: Some(command_id.clone()),
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                attachment: (*attachment).clone(),
            },
            ValidatedUserInput::Image(attachment) => ThreadItem::UserImageAttachment {
                client_id: Some(command_id.clone()),
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                attachment: (*attachment).clone(),
            },
        })
        .collect()
}

fn is_remote_image_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn is_data_url(url: &str) -> bool {
    url.get(.."data:".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

#[cfg(test)]
#[path = "user_input_tests.rs"]
mod tests;
