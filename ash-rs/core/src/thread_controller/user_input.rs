use ash_attachments::ImageAttachments;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::ImageAttachmentRef;
use ash_protocol::InstructionRef;
use ash_protocol::ItemId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillVersionSelector;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use std::path::PathBuf;
use std::sync::Arc;

use crate::CoreError;
pub(super) enum ValidatedUserInput<'a> {
    Text(&'a str),
    Context {
        name: &'a str,
        content: &'a str,
        file_path: Option<&'a PathBuf>,
    },
    Image(&'a ImageAttachmentRef),
    Instruction(&'a InstructionRef),
}

pub(super) fn normalize_images(
    input: &[UserInput],
    attachments: &Arc<ImageAttachments>,
) -> Result<Vec<UserInput>, CoreError> {
    input
        .iter()
        .map(|input| match input {
            UserInput::ImageAttachment { attachment } => {
                attachments
                    .verify(attachment)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                Ok(input.clone())
            }
            UserInput::Image { url } if is_data_url(url) => attachments
                .import_data_url(url, ash_protocol::ImageDetail::Auto)
                .map(|attachment| UserInput::ImageAttachment { attachment })
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
            UserInput::Image { url } if is_remote_image_url(url) => attachments
                .import_remote_url(url, ash_protocol::ImageDetail::Auto)
                .map(|attachment| UserInput::ImageAttachment { attachment })
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
            UserInput::Image { .. } => Err(CoreError::InvalidInput(
                "image input must be a data URL, an HTTP(S) URL, or a durable attachment".into(),
            )),
            UserInput::Text { .. }
            | UserInput::Context { .. }
            | UserInput::LocalImage { .. }
            | UserInput::Skill { .. }
            | UserInput::Instruction { .. }
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
            UserInput::Context {
                name,
                content,
                file_path,
            } if !name.trim().is_empty() && !content.trim().is_empty() => {
                Some(Ok(ValidatedUserInput::Context {
                    name,
                    content,
                    file_path: file_path.as_ref(),
                }))
            }
            UserInput::Context { .. } => Some(Err(CoreError::InvalidInput(
                "Turn context input must have a non-empty name and content".into(),
            ))),
            UserInput::ImageAttachment { attachment } => {
                Some(Ok(ValidatedUserInput::Image(attachment)))
            }
            UserInput::Image { .. } => Some(Err(CoreError::InvalidInput(
                "legacy image input must be normalized before validation".into(),
            ))),
            UserInput::Skill { .. } => None,
            UserInput::Instruction { reference } => {
                Some(Ok(ValidatedUserInput::Instruction(reference)))
            }
            UserInput::LocalImage { .. } | UserInput::Mention { .. } => {
                Some(Err(CoreError::InvalidInput(
                    "this Thread controller currently accepts text and normalized image URLs only"
                        .into(),
                )))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_skill_activations(input, activated_skills)?;
    if validated.is_empty() {
        return Err(CoreError::InvalidInput(
            "Turn input must include text or an image in addition to any selection".into(),
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
            | UserInput::Image { .. }
            | UserInput::LocalImage { .. }
            | UserInput::Mention { .. } => None,
            UserInput::Instruction { .. } => None,
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
            ValidatedUserInput::Context {
                name,
                content,
                file_path,
            } => ThreadItem::UserContext {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                name: (*name).to_owned(),
                content: (*content).to_owned(),
                file_path: file_path.map(|path| (*path).clone()),
            },
            ValidatedUserInput::Image(attachment) => ThreadItem::UserImageAttachment {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                attachment: (*attachment).clone(),
            },
            ValidatedUserInput::Instruction(reference) => ThreadItem::UserInstruction {
                item_id: next_item_id(),
                turn_id: turn_id.clone(),
                reference: (*reference).clone(),
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
