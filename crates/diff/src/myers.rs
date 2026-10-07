use crate::{DiffCancellation, DiffError, DiffLimits};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Edit {
    Equal { old: usize, new: usize },
    Delete { old: usize },
    Insert { new: usize },
}

pub(crate) fn edits<T: Eq>(
    old: &[T],
    new: &[T],
    limits: DiffLimits,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<Edit>, DiffError> {
    if cancellation.is_cancelled() {
        return Err(DiffError::Cancelled);
    }
    if old.is_empty() {
        return linear_edits(new.len(), |new| Edit::Insert { new }, limits, cancellation);
    }
    if new.is_empty() {
        return linear_edits(old.len(), |old| Edit::Delete { old }, limits, cancellation);
    }

    let n = old.len() as isize;
    let m = new.len() as isize;
    let max = old.len().saturating_add(new.len());
    let frontier_len = max
        .checked_mul(2)
        .and_then(|value| value.checked_add(1))
        .ok_or(DiffError::TraceLimit {
            limit: limits.max_trace_cells(),
        })?;
    if frontier_len > limits.max_trace_cells() {
        return Err(DiffError::TraceLimit {
            limit: limits.max_trace_cells(),
        });
    }
    let offset = max as isize;
    let mut frontier = vec![0isize; frontier_len];
    let mut trace = Vec::new();
    let mut final_depth = None;

    'search: for depth in 0..=max {
        if depth > limits.max_edit_distance() {
            return Err(DiffError::EditDistanceLimit {
                limit: limits.max_edit_distance(),
            });
        }
        let next_trace_cells = trace
            .len()
            .checked_add(1)
            .and_then(|count| count.checked_mul(frontier_len))
            .ok_or(DiffError::TraceLimit {
                limit: limits.max_trace_cells(),
            })?;
        if next_trace_cells > limits.max_trace_cells() {
            return Err(DiffError::TraceLimit {
                limit: limits.max_trace_cells(),
            });
        }
        if cancellation.is_cancelled() {
            return Err(DiffError::Cancelled);
        }

        let depth = depth as isize;
        let mut reached_end = false;
        for diagonal in (-depth..=depth).step_by(2) {
            if diagonal & 255 == 0 && cancellation.is_cancelled() {
                return Err(DiffError::Cancelled);
            }
            let index = (offset + diagonal) as usize;
            let mut x = if diagonal == -depth
                || (diagonal != depth && frontier[index - 1] < frontier[index + 1])
            {
                frontier[index + 1]
            } else {
                frontier[index - 1] + 1
            };
            let mut y = x - diagonal;
            let mut snake_steps = 0usize;
            while x < n && y < m && old[x as usize] == new[y as usize] {
                x += 1;
                y += 1;
                snake_steps += 1;
                if snake_steps & 1023 == 0 && cancellation.is_cancelled() {
                    return Err(DiffError::Cancelled);
                }
            }
            frontier[index] = x;
            if x >= n && y >= m {
                reached_end = true;
                break;
            }
        }
        trace.push(frontier.clone());
        if reached_end {
            final_depth = Some(depth as usize);
            break 'search;
        }
    }

    Ok(reconstruct(
        old.len(),
        new.len(),
        offset,
        final_depth.expect("bounded Myers search reaches its terminal diagonal"),
        &trace,
    ))
}

fn linear_edits(
    length: usize,
    edit: impl Fn(usize) -> Edit,
    limits: DiffLimits,
    cancellation: &dyn DiffCancellation,
) -> Result<Vec<Edit>, DiffError> {
    if length > limits.max_edit_distance() {
        return Err(DiffError::EditDistanceLimit {
            limit: limits.max_edit_distance(),
        });
    }
    let mut edits = Vec::with_capacity(length);
    for index in 0..length {
        if index > 0 && index & 1023 == 0 && cancellation.is_cancelled() {
            return Err(DiffError::Cancelled);
        }
        edits.push(edit(index));
    }
    Ok(edits)
}

fn reconstruct(
    old_len: usize,
    new_len: usize,
    offset: isize,
    final_depth: usize,
    trace: &[Vec<isize>],
) -> Vec<Edit> {
    let mut result = Vec::with_capacity(old_len.max(new_len));
    let mut x = old_len as isize;
    let mut y = new_len as isize;
    for depth in (1..=final_depth).rev() {
        let diagonal = x - y;
        let previous = &trace[depth - 1];
        let previous_diagonal = if diagonal == -(depth as isize)
            || (diagonal != depth as isize
                && previous[(offset + diagonal - 1) as usize]
                    < previous[(offset + diagonal + 1) as usize])
        {
            diagonal + 1
        } else {
            diagonal - 1
        };
        let previous_x = previous[(offset + previous_diagonal) as usize];
        let previous_y = previous_x - previous_diagonal;
        while x > previous_x && y > previous_y {
            x -= 1;
            y -= 1;
            result.push(Edit::Equal {
                old: x as usize,
                new: y as usize,
            });
        }
        if x == previous_x {
            debug_assert!(y > 0);
            y -= 1;
            result.push(Edit::Insert { new: y as usize });
        } else {
            debug_assert!(x > 0);
            x -= 1;
            result.push(Edit::Delete { old: x as usize });
        }
        x = previous_x;
        y = previous_y;
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        result.push(Edit::Equal {
            old: x as usize,
            new: y as usize,
        });
    }
    while x > 0 {
        x -= 1;
        result.push(Edit::Delete { old: x as usize });
    }
    while y > 0 {
        y -= 1;
        result.push(Edit::Insert { new: y as usize });
    }
    result.reverse();
    result
}

#[cfg(test)]
#[path = "myers_tests.rs"]
mod tests;
