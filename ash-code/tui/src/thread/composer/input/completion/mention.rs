//! Workspace-file mention query and completion state owned by `ChatInput`.

use ash_file_search::PathSearchSnapshot;
use ash_protocol::InstructionRef;
use std::ops::Range;

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
    let query = token.strip_prefix('@')?;
    Some(ActiveMention {
        range: start..end,
        query,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MentionMatchKind {
    File,
    Plugin,
    Instruction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MentionMatch {
    pub(crate) label: String,
    pub(crate) completion: String,
    pub(crate) kind: MentionMatchKind,
    pub(crate) indices: Vec<usize>,
    pub(crate) score: u32,
    pub(crate) instruction: Option<InstructionRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstructionCompletionItem {
    name: String,
    path: String,
    reference: InstructionRef,
}

impl InstructionCompletionItem {
    pub(crate) fn new(name: String, path: String, reference: InstructionRef) -> Self {
        Self {
            name,
            path,
            reference,
        }
    }
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
}

pub(super) struct MentionCompletion {
    pub(super) range: Range<usize>,
    pub(super) value: String,
    pub(super) instruction: Option<InstructionRef>,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct MentionPopup {
    token_range: Option<Range<usize>>,
    query: Option<String>,
    plugin_catalog: Vec<MentionPluginItem>,
    instruction_catalog: Vec<InstructionCompletionItem>,
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
        self.selected = 0;
        self.dismissed = false;
        self.searching = true;
        self.refresh_matches();
    }

    pub(super) fn query(&self) -> Option<&str> {
        self.query.as_deref()
    }

    pub(super) fn apply_search_snapshot(&mut self, snapshot: PathSearchSnapshot) {
        if self.query.as_deref() != Some(snapshot.query.as_str()) {
            return;
        }
        self.file_matches = snapshot
            .matches
            .into_iter()
            .filter_map(|matched| {
                let path = matched.path.to_str()?.to_owned();
                Some(MentionMatch {
                    label: path.clone(),
                    completion: path,
                    kind: MentionMatchKind::File,
                    indices: matched
                        .indices
                        .into_iter()
                        .map(|index| index as usize)
                        .collect(),
                    score: matched.score,
                    instruction: None,
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

    pub(super) fn replace_instruction_catalog(&mut self, catalog: Vec<InstructionCompletionItem>) {
        self.instruction_catalog = catalog;
        self.refresh_matches();
    }

    pub(super) fn view(&self) -> Option<MentionPopupView<'_>> {
        (!self.dismissed && self.query.is_some()).then_some(MentionPopupView {
            matches: &self.matches,
            selected: self.selected,
            searching: self.searching,
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

    pub(super) fn selected_completion(
        &self,
    ) -> Option<(Range<usize>, String, Option<InstructionRef>)> {
        self.completion_at(self.selected)
    }

    pub(super) fn completion_at(
        &self,
        index: usize,
    ) -> Option<(Range<usize>, String, Option<InstructionRef>)> {
        let view = self.view()?;
        let selected = view.matches.get(index)?;
        Some((
            self.token_range.clone()?,
            selected.completion.clone(),
            selected.instruction.clone(),
        ))
    }

    pub(super) fn clear(&mut self) {
        self.token_range = None;
        self.query = None;
        self.file_matches.clear();
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
        self.matches = self
            .plugin_catalog
            .iter()
            .filter(|plugin| plugin.id.to_ascii_lowercase().starts_with(&query))
            .map(|plugin| MentionMatch {
                label: plugin.id.clone(),
                completion: format!("@{}", plugin.id),
                kind: MentionMatchKind::Plugin,
                indices: (0..query.chars().count()).collect(),
                score: u32::MAX,
                instruction: None,
            })
            .chain(self.instruction_catalog.iter().filter_map(|item| {
                let name = item.name.to_ascii_lowercase();
                if !name.starts_with(&query) {
                    return None;
                }
                Some(MentionMatch {
                    label: format!("{} · {}", item.name, item.path),
                    completion: format!("@{}", item.name),
                    kind: MentionMatchKind::Instruction,
                    indices: (0..query.chars().count()).collect(),
                    score: u32::MAX - 1,
                    instruction: Some(item.reference.clone()),
                })
            }))
            .chain(self.file_matches.iter().cloned())
            .collect();
        self.selected = self.selected.min(self.matches.len().saturating_sub(1));
    }
}

/// Owns the active `@file` token and completion popup state.
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
        snapshot: PathSearchSnapshot,
    ) {
        self.popup.apply_search_snapshot(snapshot);
    }

    pub(in crate::thread::composer) fn replace_plugin_catalog(
        &mut self,
        catalog: Vec<MentionPluginItem>,
    ) {
        self.popup.replace_plugin_catalog(catalog);
    }

    pub(in crate::thread::composer) fn replace_instruction_catalog(
        &mut self,
        catalog: Vec<InstructionCompletionItem>,
    ) {
        self.popup.replace_instruction_catalog(catalog);
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
        let (range, value, instruction) = self.popup.selected_completion()?;
        self.popup.clear();
        Some(MentionCompletion {
            range,
            value,
            instruction,
        })
    }

    pub(in crate::thread::composer) fn complete_at(
        &mut self,
        index: usize,
    ) -> Option<MentionCompletion> {
        let (range, value, instruction) = self.popup.completion_at(index)?;
        self.popup.clear();
        Some(MentionCompletion {
            range,
            value,
            instruction,
        })
    }

    pub(in crate::thread::composer) fn clear(&mut self) {
        self.popup.clear();
    }
}

#[cfg(test)]
#[path = "mention_tests.rs"]
mod tests;
