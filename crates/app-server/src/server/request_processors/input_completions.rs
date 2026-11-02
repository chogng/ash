use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::environment::SessionDirSelector;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::fs::FsFileType;
use ash_app_server_protocol::protocol::fs::FsReadDirectoryParams;
use ash_app_server_protocol::protocol::input_completions::InputCompletionItem;
use ash_app_server_protocol::protocol::input_completions::InputCompletionValue;
use ash_app_server_protocol::protocol::input_completions::InputCompletionsCapability;
use ash_app_server_protocol::protocol::input_completions::InputCompletionsParams;
use ash_app_server_protocol::protocol::input_completions::InputCompletionsResult;
use ash_app_server_protocol::protocol::search::FileFuzzyParams;
use ash_app_server_protocol::protocol::search::FileGlobTarget;
use ash_async_utils::CancellationToken;
use ash_config::SkillEnablement;
use ash_protocol::SkillRef;
use ash_skills_extension::SkillCatalogReload;
use ash_skills_extension::SkillCompatibility;
use ash_slash_commands::SlashCommandInput;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

const MAX_ITEMS: usize = 100;

pub(super) fn capability(skills: bool) -> InputCompletionsCapability {
    let mut trigger_characters = vec!["/".into(), "@".into(), "#".into()];
    if skills {
        trigger_characters.push("$".into());
    }
    InputCompletionsCapability {
        version: 1,
        trigger_characters,
    }
}

impl AppServer {
    /// Coordinates existing catalogs and authorized discovery without retaining input or candidates.
    pub(super) fn input_completions(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: InputCompletionsParams = decode(params)?;
        if params.text.len() > 1024 * 1024
            || params.directories.len() > 32
            || params.thread_id.is_some() && params.session_id.is_none()
        {
            return Err(invalid_params());
        }
        let cursor = byte_offset(&params.text, params.offset).ok_or_else(invalid_params)?;
        if let Some(session_id) = &params.session_id {
            if let Some(thread_id) = &params.thread_id {
                self.agent_processor()
                    .read_session_thread(session_id, thread_id)?;
            } else {
                self.agent_processor().session_view(session_id)?;
            }
        }
        check_cancelled(cancellation)?;
        // Submission trims the draft before canonical command dispatch. Keep the
        // catalog grammar unchanged and translate its coordinates back to the editor.
        let leading = params.text.len() - params.text.trim_start().len();
        let input = SlashCommandInput::at_cursor(
            &params.text[leading..],
            cursor.saturating_sub(leading),
            &self.slash_commands,
        );
        if let Some(commands) = input.matching_commands() {
            let query = input.query().expect("matching commands have a query");
            let items = commands
                .into_iter()
                .take(MAX_ITEMS)
                .enumerate()
                .filter_map(|(index, command)| {
                    let completion = input.completion(&command)?;
                    Some(InputCompletionItem {
                        label: format!("/{}", command.name),
                        insert_text: completion.replacement,
                        start: utf16_offset(&params.text, leading + completion.range.start),
                        end: utf16_offset(&params.text, leading + completion.range.end),
                        detail: Some(command.description),
                        preselect: index == 0
                            && (query.text.is_empty()
                                || command.name.starts_with(&query.text.to_ascii_lowercase())),
                        value: InputCompletionValue::Command,
                    })
                })
                .collect();
            return result(&InputCompletionsResult { items });
        }
        let Some(token) = token_at_cursor(&params.text, cursor) else {
            return result(&InputCompletionsResult { items: vec![] });
        };
        let mut items = Vec::new();
        if token.leader == '$' {
            if let Some(runtime) = &self.skills {
                let snapshot = match &params.session_id {
                    Some(session) => runtime.list_for_session(session),
                    None => runtime.list(SkillCatalogReload::Cached),
                }
                .map_err(|_| RpcError::new(-32051, AppServerErrorName::SkillOperationFailed))?;
                let available = snapshot
                    .entries
                    .iter()
                    .filter(|entry| {
                        entry.enablement == SkillEnablement::Enabled
                            && matches!(
                                entry.catalog_entry.compatibility(),
                                SkillCompatibility::Compatible
                            )
                    })
                    .collect::<Vec<_>>();
                let mut names = BTreeMap::new();
                for entry in &available {
                    *names
                        .entry(entry.catalog_entry.id().name.as_str())
                        .or_insert(0) += 1;
                }
                for entry in available {
                    check_cancelled(cancellation)?;
                    let catalog = &entry.catalog_entry;
                    let name = catalog.id().name.as_str();
                    if names[name] != 1
                        || !name.starts_with(token.query)
                        || items.len() >= MAX_ITEMS
                    {
                        continue;
                    }
                    items.push(InputCompletionItem {
                        label: format!("${name}"),
                        insert_text: format!("${name} "),
                        start: utf16_offset(&params.text, token.start),
                        end: utf16_offset(&params.text, separator_end(&params.text, token.end)),
                        detail: Some(catalog.metadata().description().to_owned()),
                        preselect: items.is_empty(),
                        value: InputCompletionValue::Skill {
                            skill: SkillRef::pinned(
                                catalog.id().clone(),
                                catalog.content_digest().clone(),
                            ),
                        },
                    });
                }
            }
        } else {
            let (query, folders_only) = match token.query.strip_prefix("folder:") {
                Some(query) => (query, true),
                None => (
                    token.query.strip_prefix("file:").unwrap_or(token.query),
                    false,
                ),
            };
            if query.len() > 1024 || query.contains(':') {
                return result(&InputCompletionsResult { items });
            }
            for (directory, target) in params.directories.iter().enumerate() {
                check_cancelled(cancellation)?;
                if items.len() >= MAX_ITEMS {
                    break;
                }
                let found = self.search_processor().file_fuzzy_query(
                    FileFuzzyParams {
                        operation_id: params.operation_id.clone(),
                        target: target.clone(),
                        query: query.to_owned(),
                        include_patterns: None,
                        exclude_patterns: None,
                        max_results: 50,
                    },
                    cancellation,
                )?;
                if !folders_only {
                    for file in found.matches {
                        if items.len() >= MAX_ITEMS {
                            break;
                        }
                        items.push(resource_item(
                            &params.text,
                            &token,
                            directory,
                            file.path,
                            false,
                            items.is_empty(),
                        ));
                    }
                }
                // Direct directory discovery includes empty folders. It uses the same
                // filesystem grant owner as Browse, rather than inferring folders from files.
                let query = query.strip_prefix("./").unwrap_or(query);
                if query.starts_with('/') || query.split('/').any(|part| part == "..") {
                    continue;
                }
                let (parent, name) = query.rsplit_once('/').unwrap_or(("", query));
                let (dir_id, session_directory) = match target {
                    FileGlobTarget::Workspace { dir_id } => (Some(dir_id.clone()), None),
                    FileGlobTarget::Session { session_id, path } => (
                        None,
                        Some(SessionDirSelector {
                            session_id: session_id.clone(),
                            path: path.clone(),
                        }),
                    ),
                };
                let entries = self
                    .fs_processor()
                    .read_directory_query(FsReadDirectoryParams {
                        dir_id,
                        session_directory,
                        path: PathBuf::from(if parent.is_empty() { "." } else { parent }),
                    });
                if let Ok(mut entries) = entries {
                    entries
                        .entries
                        .sort_by(|left, right| left.name.cmp(&right.name));
                    for entry in entries.entries {
                        check_cancelled(cancellation)?;
                        if items.len() >= MAX_ITEMS {
                            break;
                        }
                        if entry.file_type == FsFileType::Directory
                            && entry.name.to_lowercase().starts_with(&name.to_lowercase())
                        {
                            let path = if parent.is_empty() {
                                entry.name
                            } else {
                                format!("{parent}/{}", entry.name)
                            };
                            items.push(resource_item(
                                &params.text,
                                &token,
                                directory,
                                path,
                                true,
                                items.is_empty(),
                            ));
                        }
                    }
                }
            }
        }
        check_cancelled(cancellation)?;
        result(&InputCompletionsResult { items })
    }
}

struct InputToken<'a> {
    leader: char,
    query: &'a str,
    start: usize,
    end: usize,
}

fn token_at_cursor(text: &str, cursor: usize) -> Option<InputToken<'_>> {
    let start = text[..cursor]
        .rfind(char::is_whitespace)
        .map_or(0, |offset| {
            offset
                + text[offset..]
                    .chars()
                    .next()
                    .expect("whitespace is a character")
                    .len_utf8()
        });
    let leader = text[start..cursor].chars().next()?;
    if !matches!(leader, '@' | '#' | '$') {
        return None;
    }
    let query = &text[start + 1..cursor];
    if query.contains(['@', '#', '$']) {
        return None;
    }
    let end = text[cursor..]
        .find(char::is_whitespace)
        .map_or(text.len(), |offset| cursor + offset);
    Some(InputToken {
        leader,
        query,
        start,
        end,
    })
}

fn separator_end(text: &str, end: usize) -> usize {
    end + usize::from(text[end..].starts_with(' '))
}

fn resource_item(
    text: &str,
    token: &InputToken<'_>,
    directory: usize,
    path: String,
    is_directory: bool,
    preselect: bool,
) -> InputCompletionItem {
    InputCompletionItem {
        label: format!(
            "{}{path}{}",
            token.leader,
            if is_directory { "/" } else { "" }
        ),
        insert_text: format!("{}{path} ", token.leader),
        start: utf16_offset(text, token.start),
        end: utf16_offset(text, token.end),
        detail: Some(path.clone()),
        preselect,
        value: InputCompletionValue::Resource {
            directory,
            path,
            is_directory,
        },
    }
}

fn byte_offset(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += character.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

fn utf16_offset(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}
fn invalid_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}
fn check_cancelled(token: &CancellationToken) -> Result<(), RpcError> {
    if token.is_cancelled() {
        Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled))
    } else {
        Ok(())
    }
}
