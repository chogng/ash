use unicode_segmentation::UnicodeSegmentation;

use crate::myers::{self, Edit};
use crate::{DiffCancellation, DiffError, DiffLimits, InlineChange};

pub(crate) fn changes(
    old: &str,
    new: &str,
    limits: DiffLimits,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<InlineChange>, DiffError> {
    let (old_graphemes, old_offsets) = graphemes(old);
    let (new_graphemes, new_offsets) = graphemes(new);
    let edits = myers::edits(&old_graphemes, &new_graphemes, limits, cancellation)?;
    let mut changes = Vec::new();
    let mut old_cursor = 0;
    let mut new_cursor = 0;
    let mut run_start = None;

    for edit in edits {
        match edit {
            Edit::Equal { .. } => {
                finish_run(
                    &mut changes,
                    &mut run_start,
                    old_cursor,
                    new_cursor,
                    &old_offsets,
                    &new_offsets,
                );
                old_cursor += 1;
                new_cursor += 1;
            }
            Edit::Delete { .. } => {
                run_start.get_or_insert((old_cursor, new_cursor));
                old_cursor += 1;
            }
            Edit::Insert { .. } => {
                run_start.get_or_insert((old_cursor, new_cursor));
                new_cursor += 1;
            }
        }
    }
    finish_run(
        &mut changes,
        &mut run_start,
        old_cursor,
        new_cursor,
        &old_offsets,
        &new_offsets,
    );
    Ok(changes)
}

fn graphemes(text: &str) -> (Vec<&str>, Vec<usize>) {
    let mut graphemes = Vec::new();
    let mut offsets = Vec::new();
    for (offset, grapheme) in text.grapheme_indices(true) {
        offsets.push(offset);
        graphemes.push(grapheme);
    }
    offsets.push(text.len());
    (graphemes, offsets)
}

fn finish_run(
    changes: &mut Vec<InlineChange>,
    run_start: &mut Option<(usize, usize)>,
    old_cursor: usize,
    new_cursor: usize,
    old_offsets: &[usize],
    new_offsets: &[usize],
) {
    let Some((old_start, new_start)) = run_start.take() else {
        return;
    };
    changes.push(InlineChange::new(
        old_offsets[old_start]..old_offsets[old_cursor],
        new_offsets[new_start]..new_offsets[new_cursor],
    ));
}
