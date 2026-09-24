use ash_editor::CodeEditorTextEdit;
use ash_input_classifier::ShellCompletion;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ShellGhostSuggestion {
    pub(super) edit: CodeEditorTextEdit,
}

pub(super) fn shell_ghost_suggestion(
    input: &str,
    cursor: usize,
    completions: Vec<ShellCompletion>,
) -> Option<ShellGhostSuggestion> {
    let first = completions.iter().find(|completion| {
        let range = completion.replace_range();
        range.end == cursor
            && input
                .get(range)
                .is_some_and(|typed| completion.replacement().starts_with(typed))
    })?;
    let range = first.replace_range();
    let typed = input.get(range.clone())?;
    let replacements = completions
        .iter()
        .filter(|completion| completion.replace_range() == range)
        .map(ShellCompletion::replacement)
        .filter(|replacement| replacement.starts_with(typed))
        .collect::<Vec<_>>();
    let first_replacement = *replacements.first()?;
    let common_prefix_length = replacements
        .iter()
        .skip(1)
        .fold(first_replacement.len(), |length, replacement| {
            common_prefix_length(&first_replacement[..length], replacement)
        });
    if common_prefix_length <= typed.len() {
        return None;
    }
    Some(ShellGhostSuggestion {
        edit: CodeEditorTextEdit {
            range,
            new_text: first_replacement[..common_prefix_length].to_owned(),
        },
    })
}

fn common_prefix_length(left: &str, right: &str) -> usize {
    for ((offset, left), right) in left.char_indices().zip(right.chars()) {
        if left != right {
            return offset;
        }
    }
    left.len().min(right.len())
}
