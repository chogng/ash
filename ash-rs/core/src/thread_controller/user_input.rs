use ash_attachments::Attachments;
use ash_protocol::AudioAttachmentRef;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::ItemId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillVersionSelector;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use std::sync::Arc;

use crate::CoreError;
pub(super) enum ValidatedUserInput<'a> {
    Text(&'a str),
    Context { name: &'a str, content: &'a str },
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
            | UserInput::LocalImage { .. }
            | UserInput::Skill { .. }
            | UserInput::Mention { .. } => Ok(input.clone()),
        })
        .collect()
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

    let validated = input
        .iter()
        .filter_map(|input| match input {
            UserInput::Text { text } if !text.trim().is_empty() => {
                Some(Ok(ValidatedUserInput::Text(text)))
            }
            UserInput::Text { .. } => Some(Err(CoreError::InvalidInput(
                "Turn text input must not be empty".into(),
            ))),
            UserInput::Context { name, content }
                if !name.trim().is_empty() && !content.trim().is_empty() =>
            {
                Some(Ok(ValidatedUserInput::Context { name, content }))
            }
            UserInput::Context { .. } => Some(Err(CoreError::InvalidInput(
                "Turn context input must have a non-empty name and content".into(),
            ))),
            UserInput::AudioAttachment { attachment } => Some(Ok(ValidatedUserInput::Audio(attachment))),
            UserInput::Audio { .. } => Some(Err(CoreError::InvalidInput("audio input must be normalized before validation".into()))),
            UserInput::ImageAttachment { attachment } => {
                Some(Ok(ValidatedUserInput::Image(attachment)))
            }
            UserInput::Image { .. } => Some(Err(CoreError::InvalidInput(
                "legacy image input must be normalized before validation".into(),
            ))),
            UserInput::Skill { .. } => None,
            UserInput::LocalImage { .. } | UserInput::Mention { .. } => {
                Some(Err(CoreError::InvalidInput(
                    "this Thread controller currently accepts text, context, and validated attachments"
                        .into(),
                )))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_skill_activations(input, activated_skills)?;
    if validated.is_empty() {
        return Err(CoreError::InvalidInput(
            "Turn input must include text, context, or an attachment in addition to any Skill selection".into(),
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
            | UserInput::ImageAttachment { .. }
            | UserInput::AudioAttachment { .. }
            | UserInput::Audio { .. }
            | UserInput::Image { .. }
            | UserInput::LocalImage { .. }
            | UserInput::Mention { .. } => None,
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

pub(super) fn thread_items(
    input: &[ValidatedUserInput<'_>],
    turn_id: &TurnId,
    mut next_item_id: impl FnMut() -> ItemId,
) -> Vec<ThreadItem> {
    input
        .iter()
        .map(|input| match input {
            ValidatedUserInput::Text(text) => ThreadItem::UserMessage {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                text: (*text).to_owned(),
            },
            ValidatedUserInput::Context { name, content } => ThreadItem::UserContext {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                name: (*name).to_owned(),
                content: (*content).to_owned(),
            },
            ValidatedUserInput::Audio(attachment) => ThreadItem::UserAudioAttachment {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                attachment: (*attachment).clone(),
            },
            ValidatedUserInput::Image(attachment) => ThreadItem::UserImageAttachment {
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
