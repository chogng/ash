//! Large-text paste placeholders and their deferred payloads.

use super::editor::TextArea;
use super::editor::TextElementId;

const LARGE_PASTE_CHAR_THRESHOLD: usize = 1000;

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingPaste {
    element_id: TextElementId,
    placeholder: String,
    contents: String,
}

/// Owns the mapping between atomic chat_input placeholders and large pasted text payloads.
///
/// Large payloads stay out of the visible text buffer while the user edits the draft. The
/// placeholders are expanded only when the chat_input prepares a submission.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct PendingPastes {
    entries: Vec<PendingPaste>,
}

impl PendingPastes {
    pub(super) fn insert_text(&mut self, textarea: &mut TextArea, pasted: String) {
        let pasted = pasted.replace("\r\n", "\n").replace('\r', "\n");
        let char_count = pasted.chars().count();
        if char_count <= LARGE_PASTE_CHAR_THRESHOLD {
            textarea.insert_text(&pasted);
            return;
        }

        let placeholder = self.next_placeholder(char_count);
        let element_id = textarea.insert_element(&placeholder);
        self.entries.push(PendingPaste {
            element_id,
            placeholder,
            contents: pasted,
        });
    }

    pub(super) fn retain_present_in(&mut self, textarea: &TextArea) {
        self.entries
            .retain(|paste| textarea.has_element(paste.element_id));
    }

    pub(super) fn replacement(&self, element_id: TextElementId) -> Option<&str> {
        self.entries
            .iter()
            .find(|paste| paste.element_id == element_id)
            .map(|paste| paste.contents.as_str())
    }

    pub(super) fn expand(&self, textarea: &TextArea) -> String {
        let text = textarea.text();
        if self.entries.is_empty() {
            return text.to_owned();
        }

        let mut expanded = String::with_capacity(text.len());
        let mut cursor = 0;
        for (element_id, range) in textarea.elements() {
            expanded.push_str(&text[cursor..range.start]);
            let element = &text[range.clone()];
            if let Some(paste) = self
                .entries
                .iter()
                .find(|paste| paste.element_id == element_id)
            {
                expanded.push_str(&paste.contents);
            } else {
                expanded.push_str(element);
            }
            cursor = range.end;
        }
        expanded.push_str(&text[cursor..]);
        expanded
    }

    pub(super) fn clear(&mut self) {
        self.entries.clear();
    }

    fn next_placeholder(&self, char_count: usize) -> String {
        let base = format!("[Pasted Content {char_count} chars]");
        let prefix = format!("{base} #");
        let mut max_suffix = 0;

        for paste in &self.entries {
            if paste.placeholder == base {
                max_suffix = max_suffix.max(1);
            } else if let Some(suffix) = paste.placeholder.strip_prefix(&prefix)
                && let Ok(suffix) = suffix.parse::<usize>()
            {
                max_suffix = max_suffix.max(suffix);
            }
        }

        if max_suffix == 0 {
            base
        } else {
            format!("{base} #{}", max_suffix + 1)
        }
    }
}
