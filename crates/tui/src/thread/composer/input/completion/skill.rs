//! `$skill` query, completion, and exact Skill binding state owned by `ChatInput`.

use ash_protocol::SkillRef;
use std::ops::Range;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillCompletionItem {
    name: String,
    description: String,
    skill: SkillRef,
}

impl SkillCompletionItem {
    pub(crate) fn new(name: String, description: String, skill: SkillRef) -> Self {
        Self {
            name,
            description,
            skill,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn description(&self) -> &str {
        &self.description
    }

    #[cfg(test)]
    pub(crate) fn skill(&self) -> &SkillRef {
        &self.skill
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SkillCompletionView<'a> {
    pub(crate) items: &'a [SkillCompletionItem],
    pub(crate) selected: usize,
}

pub(super) struct SkillCompletion {
    pub(super) range: Range<usize>,
    pub(super) value: String,
    pub(super) skill: SkillRef,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(in crate::thread::composer) struct SkillCompletionState {
    catalog: Vec<SkillCompletionItem>,
    token_range: Option<Range<usize>>,
    query: Option<String>,
    matches: Vec<SkillCompletionItem>,
    selected: usize,
    dismissed: bool,
}

impl SkillCompletionState {
    pub(in crate::thread::composer) fn replace_catalog(
        &mut self,
        catalog: Vec<SkillCompletionItem>,
    ) {
        self.catalog = catalog;
        self.refresh_matches();
    }

    pub(in crate::thread::composer) fn sync(&mut self, text: &str, cursor: usize) {
        let Some((range, query)) = active_skill(text, cursor) else {
            self.close_popup();
            return;
        };
        if self.token_range.as_ref() == Some(&range) && self.query.as_deref() == Some(query) {
            return;
        }
        self.token_range = Some(range);
        self.query = Some(query.to_owned());
        self.selected = 0;
        self.dismissed = false;
        self.refresh_matches();
    }

    pub(in crate::thread::composer) fn view(&self) -> Option<SkillCompletionView<'_>> {
        (!self.dismissed && self.query.is_some()).then_some(SkillCompletionView {
            items: &self.matches,
            selected: self.selected,
        })
    }

    pub(in crate::thread::composer) fn select_previous(&mut self) {
        if self.matches.is_empty() {
            return;
        }
        self.selected = if self.selected == 0 {
            self.matches.len() - 1
        } else {
            self.selected - 1
        };
    }

    pub(in crate::thread::composer) fn select_next(&mut self) {
        if !self.matches.is_empty() {
            self.selected = (self.selected + 1) % self.matches.len();
        }
    }

    pub(in crate::thread::composer) fn dismiss(&mut self) {
        self.dismissed = true;
    }

    pub(in crate::thread::composer) fn complete_selected(&mut self) -> Option<SkillCompletion> {
        self.complete_at(self.selected)
    }

    pub(in crate::thread::composer) fn complete_at(
        &mut self,
        index: usize,
    ) -> Option<SkillCompletion> {
        let item = self
            .view()
            .and_then(|view| view.items.get(index))
            .cloned()?;
        let range = self.token_range.clone()?;
        self.close_popup();
        Some(SkillCompletion {
            range,
            value: format!("${}", item.name),
            skill: item.skill,
        })
    }

    pub(in crate::thread::composer) fn clear(&mut self) {
        self.close_popup();
    }

    fn refresh_matches(&mut self) {
        let Some(query) = self.query.as_deref() else {
            self.matches.clear();
            return;
        };
        self.matches = self
            .catalog
            .iter()
            .filter(|item| item.name.starts_with(query))
            .cloned()
            .collect();
        self.selected = self.selected.min(self.matches.len().saturating_sub(1));
    }

    fn close_popup(&mut self) {
        self.token_range = None;
        self.query = None;
        self.matches.clear();
        self.selected = 0;
        self.dismissed = false;
    }
}

fn active_skill(text: &str, cursor: usize) -> Option<(Range<usize>, &str)> {
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
    let query = token.strip_prefix('$')?;
    query
        .chars()
        .all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        .then_some((start..end, query))
}

#[cfg(test)]
#[path = "skill_tests.rs"]
mod tests;
