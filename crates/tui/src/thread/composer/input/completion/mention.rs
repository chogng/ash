//! Context mention query and completion state owned by `ChatInput`.

use super::super::state::ChatInputItem;
use ash_file_search::PathSearchSnapshot;
use ash_protocol::Session;
use ash_protocol::SessionStatus;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_utils_plugins::mention_syntax::PLUGIN_TEXT_MENTION_SIGIL;
use std::ops::Range;
use std::path::Path;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ActiveMention<'a> {
    pub(super) range: Range<usize>,
    pub(super) query: &'a str,
}

/// Resolves the editable whitespace-delimited `@token` touching the cursor.
pub(super) fn active_mention(text: &str, cursor: usize) -> Option<ActiveMention<'_>> {
    if cursor > text.len() || !text.is_char_boundary(cursor) {
        return None;
    }

    let start = text[..cursor]
        .char_indices()
        .rfind(|(_, character)| character.is_whitespace())
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    let end = text[cursor..]
        .char_indices()
        .find(|(_, character)| character.is_whitespace())
        .map(|(offset, _)| cursor + offset)
        .unwrap_or(text.len());
    let token = text.get(start..end)?;
    let query = token.strip_prefix(PLUGIN_TEXT_MENTION_SIGIL)?;
    Some(ActiveMention {
        range: start..end,
        query,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MentionMatchKind {
    Conversation,
    File,
    Folder,
    Plugin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MentionMatch {
    pub(crate) label: String,
    pub(super) completion: MentionValue,
    pub(crate) kind: MentionMatchKind,
    pub(crate) indices: Vec<usize>,
    pub(crate) score: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum MentionValue {
    Plugin(String),
    Context(ChatInputItem),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MentionPluginItem {
    id: String,
}

impl MentionPluginItem {
    pub(crate) fn new(id: String) -> Self {
        Self { id }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct MentionPopupView<'a> {
    pub(crate) matches: &'a [MentionMatch],
    pub(crate) selected: usize,
    pub(crate) searching: bool,
    pub(crate) show_groups: bool,
}

pub(super) struct MentionCompletion {
    pub(super) range: Range<usize>,
    pub(super) label: String,
    pub(super) value: MentionValue,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct MentionPopup {
    token_range: Option<Range<usize>>,
    query: Option<String>,
    plugin_catalog: Vec<MentionPluginItem>,
    conversation_matches: Vec<MentionMatch>,
    file_matches: Vec<MentionMatch>,
    matches: Vec<MentionMatch>,
    selected: usize,
    dismissed: bool,
    searching: bool,
}

impl MentionPopup {
    pub(super) fn sync(&mut self, active: Option<ActiveMention<'_>>) {
        let Some(active) = active else {
            self.clear();
            return;
        };
        if self.token_range.as_ref() == Some(&active.range)
            && self.query.as_deref() == Some(active.query)
        {
            return;
        }

        self.token_range = Some(active.range);
        self.query = Some(active.query.to_owned());
        self.file_matches.clear();
        self.conversation_matches.clear();
        self.matches.clear();
        self.selected = 0;
        self.dismissed = false;
        self.searching = true;
        self.refresh_matches();
    }

    pub(super) fn query(&self) -> Option<&str> {
        self.query.as_deref()
    }

    pub(super) fn apply_search_snapshot(&mut self, root: &Path, snapshot: PathSearchSnapshot) {
        if self.query.as_deref() != Some(snapshot.query.as_str()) {
            return;
        }
        self.file_matches = snapshot
            .matches
            .into_iter()
            .map(|matched| (matched, MentionMatchKind::File))
            .chain(
                snapshot
                    .directory_matches
                    .into_iter()
                    .map(|matched| (matched, MentionMatchKind::Folder)),
            )
            .filter_map(|(matched, kind)| {
                let label = matched.path.to_str()?.to_owned();
                let item = ChatInputItem::WorkspaceResource {
                    name: label.clone(),
                    path: root.join(matched.path),
                    is_directory: kind == MentionMatchKind::Folder,
                };
                Some(MentionMatch {
                    label,
                    completion: MentionValue::Context(item),
                    kind,
                    indices: matched
                        .indices
                        .into_iter()
                        .map(|index| index as usize)
                        .collect(),
                    score: matched.score,
                })
            })
            .collect();
        self.searching = !snapshot.search_complete;
        self.refresh_matches();
    }

    pub(super) fn replace_plugin_catalog(&mut self, catalog: Vec<MentionPluginItem>) {
        self.plugin_catalog = catalog;
        self.refresh_matches();
    }

    pub(super) fn replace_conversation_matches(&mut self, matches: Vec<MentionMatch>) {
        if self.conversation_matches != matches {
            self.conversation_matches = matches;
            self.refresh_matches();
        }
    }

    pub(super) fn view(&self) -> Option<MentionPopupView<'_>> {
        (!self.dismissed && self.query.is_some()).then_some(MentionPopupView {
            matches: &self.matches,
            selected: self.selected,
            searching: self.searching,
            show_groups: self.query.as_deref() == Some(""),
        })
    }

    pub(super) fn select_previous(&mut self) {
        if self.matches.is_empty() {
            return;
        }
        self.selected = if self.selected == 0 {
            self.matches.len() - 1
        } else {
            self.selected - 1
        };
    }

    pub(super) fn select_next(&mut self) {
        if !self.matches.is_empty() {
            self.selected = (self.selected + 1) % self.matches.len();
        }
    }

    pub(super) fn dismiss(&mut self) {
        self.dismissed = true;
    }

    pub(super) fn selected_completion(&self) -> Option<MentionCompletion> {
        self.completion_at(self.selected)
    }

    pub(super) fn completion_at(&self, index: usize) -> Option<MentionCompletion> {
        let item = self.view()?.matches.get(index)?;
        Some(MentionCompletion {
            range: self.token_range.clone()?,
            label: item.label.clone(),
            value: item.completion.clone(),
        })
    }

    pub(super) fn clear(&mut self) {
        self.token_range = None;
        self.query = None;
        self.file_matches.clear();
        self.conversation_matches.clear();
        self.matches.clear();
        self.selected = 0;
        self.dismissed = false;
        self.searching = false;
    }

    fn refresh_matches(&mut self) {
        let Some(query) = self.query.as_deref() else {
            self.matches.clear();
            return;
        };
        let query = query.to_ascii_lowercase();
        let selected = self
            .matches
            .get(self.selected)
            .map(|item| item.completion.clone());
        let plugins = self
            .plugin_catalog
            .iter()
            .filter(|plugin| plugin.id.to_ascii_lowercase().starts_with(&query))
            .map(|plugin| MentionMatch {
                label: plugin.id.clone(),
                completion: MentionValue::Plugin(format!(
                    "{PLUGIN_TEXT_MENTION_SIGIL}{}",
                    plugin.id
                )),
                kind: MentionMatchKind::Plugin,
                indices: (0..query.chars().count()).collect(),
                score: u32::MAX,
            });
        self.matches = self
            .conversation_matches
            .iter()
            .cloned()
            .chain(self.file_matches.iter().cloned())
            .chain(plugins)
            .collect();
        self.selected = selected
            .and_then(|value| {
                self.matches
                    .iter()
                    .position(|item| item.completion == value)
            })
            .unwrap_or_else(|| self.selected.min(self.matches.len().saturating_sub(1)));
    }
}

pub(crate) fn conversation_matches(
    catalog: &[Session],
    current: Option<&ThreadId>,
    query: &str,
) -> Vec<MentionMatch> {
    let query = query.to_lowercase();
    let mut conversations = catalog
        .iter()
        .filter(|session| session.status == SessionStatus::Active)
        .flat_map(|session| session.threads.iter().map(move |thread| (session, thread)))
        .filter(|(_, thread)| {
            thread.status == ThreadStatus::Active && current != Some(&thread.thread_id)
        })
        .filter_map(|(session, thread)| {
            let title = if thread.title.trim().is_empty() {
                &session.title
            } else {
                &thread.title
            };
            let label = title.split_whitespace().collect::<Vec<_>>().join(" ");
            if label.is_empty() || !label.to_lowercase().contains(&query) {
                return None;
            }
            let item = ChatInputItem::ChatReference {
                name: label.clone(),
                session_id: session.session_id.clone(),
                thread_id: thread.thread_id.clone(),
            };
            Some((
                thread
                    .last_activity_at_unix_ms
                    .unwrap_or(thread.created_at_unix_ms),
                MentionMatch {
                    label,
                    completion: MentionValue::Context(item),
                    kind: MentionMatchKind::Conversation,
                    indices: Vec::new(),
                    score: 0,
                },
            ))
        })
        .collect::<Vec<_>>();
    conversations.sort_by_key(|(activity, _)| std::cmp::Reverse(*activity));
    conversations
        .into_iter()
        .take(50)
        .map(|(_, item)| item)
        .collect()
}

/// Owns the active context token and completion popup state.
#[derive(Debug, Default, Eq, PartialEq)]
pub(in crate::thread::composer) struct Mentions {
    popup: MentionPopup,
}

impl Mentions {
    pub(in crate::thread::composer) fn sync(&mut self, text: &str, cursor: usize) {
        self.popup.sync(active_mention(text, cursor));
    }

    pub(in crate::thread::composer) fn query(&self) -> Option<&str> {
        self.popup.query()
    }

    pub(in crate::thread::composer) fn apply_search_snapshot(
        &mut self,
        root: &Path,
        snapshot: PathSearchSnapshot,
    ) {
        self.popup.apply_search_snapshot(root, snapshot);
    }

    pub(in crate::thread::composer) fn replace_plugin_catalog(
        &mut self,
        catalog: Vec<MentionPluginItem>,
    ) {
        self.popup.replace_plugin_catalog(catalog);
    }

    pub(in crate::thread::composer) fn replace_conversation_matches(
        &mut self,
        matches: Vec<MentionMatch>,
    ) {
        self.popup.replace_conversation_matches(matches);
    }

    pub(in crate::thread::composer) fn view(&self) -> Option<MentionPopupView<'_>> {
        self.popup.view()
    }

    pub(in crate::thread::composer) fn select_previous(&mut self) {
        self.popup.select_previous();
    }

    pub(in crate::thread::composer) fn select_next(&mut self) {
        self.popup.select_next();
    }

    pub(in crate::thread::composer) fn dismiss(&mut self) {
        self.popup.dismiss();
    }

    pub(in crate::thread::composer) fn complete_selected(&mut self) -> Option<MentionCompletion> {
        let completion = self.popup.selected_completion()?;
        self.popup.clear();
        Some(completion)
    }

    pub(in crate::thread::composer) fn complete_at(
        &mut self,
        index: usize,
    ) -> Option<MentionCompletion> {
        let completion = self.popup.completion_at(index)?;
        self.popup.clear();
        Some(completion)
    }

    pub(in crate::thread::composer) fn clear(&mut self) {
        self.popup.clear();
    }
}

#[cfg(test)]
#[path = "mention_tests.rs"]
mod tests;
