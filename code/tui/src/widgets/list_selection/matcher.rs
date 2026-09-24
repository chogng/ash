#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct ListSelectionMatchScore {
    field: ListSelectionMatchField,
    text: TextMatchScore,
}

impl ListSelectionMatchScore {
    fn new(field: ListSelectionMatchField, text: TextMatchScore) -> Self {
        Self { field, text }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ListSelectionMatchField {
    Label,
    Description,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct TextMatchScore {
    kind: TextMatchKind,
    gap: usize,
    start: usize,
}

impl TextMatchScore {
    fn new(kind: TextMatchKind, gap: usize, start: usize) -> Self {
        Self { kind, gap, start }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum TextMatchKind {
    Exact,
    Prefix,
    WordPrefix,
    Substring,
    Fuzzy,
}

pub(super) fn selection_match_score(
    label: &str,
    description: Option<&str>,
    normalized_query: &str,
) -> Option<ListSelectionMatchScore> {
    text_match_score(label, normalized_query)
        .map(|score| ListSelectionMatchScore::new(ListSelectionMatchField::Label, score))
        .or_else(|| {
            description.and_then(|description| {
                text_match_score(description, normalized_query).map(|score| {
                    ListSelectionMatchScore::new(ListSelectionMatchField::Description, score)
                })
            })
        })
}

fn text_match_score(text: &str, normalized_query: &str) -> Option<TextMatchScore> {
    let normalized_text = text.to_lowercase();
    if normalized_text == normalized_query {
        return Some(TextMatchScore::new(TextMatchKind::Exact, 0, 0));
    }
    if normalized_text.starts_with(normalized_query) {
        return Some(TextMatchScore::new(TextMatchKind::Prefix, 0, 0));
    }
    if let Some(start) = word_prefix_start(&normalized_text, normalized_query) {
        return Some(TextMatchScore::new(TextMatchKind::WordPrefix, 0, start));
    }
    if let Some(start) = normalized_text.find(normalized_query) {
        return Some(TextMatchScore::new(TextMatchKind::Substring, 0, start));
    }
    fuzzy_match_score(&normalized_text, normalized_query)
}

fn word_prefix_start(text: &str, query: &str) -> Option<usize> {
    text.match_indices(query).find_map(|(start, _)| {
        let preceding = text[..start].chars().next_back()?;
        (!preceding.is_alphanumeric()).then_some(start)
    })
}

fn fuzzy_match_score(text: &str, query: &str) -> Option<TextMatchScore> {
    let mut query_characters = query.chars();
    let mut expected = query_characters.next()?;
    let query_length = query.chars().count();
    let mut first = None;

    for (index, character) in text.chars().enumerate() {
        if character != expected {
            continue;
        }
        first.get_or_insert(index);
        let Some(next) = query_characters.next() else {
            let start = first.unwrap_or_default();
            let span = index.saturating_sub(start).saturating_add(1);
            return Some(TextMatchScore::new(
                TextMatchKind::Fuzzy,
                span.saturating_sub(query_length),
                start,
            ));
        };
        expected = next;
    }
    None
}

#[cfg(test)]
#[path = "matcher_tests.rs"]
mod tests;
