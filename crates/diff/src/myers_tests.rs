use super::{Edit, edits};
use crate::{DiffCancellation, DiffError, DiffLimits, NeverCancel};
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn exhaustive_small_sequences_produce_a_shortest_ordered_edit_script() {
    let sequences = binary_sequences(5);
    for old in &sequences {
        for new in &sequences {
            let script = edits(old, new, DiffLimits::default(), &NeverCancel).unwrap();
            assert_script_reconstructs(old, new, &script);
            assert_eq!(
                script
                    .iter()
                    .filter(|edit| !matches!(edit, Edit::Equal { .. }))
                    .count(),
                reference_edit_distance(old, new),
                "old={old:?}, new={new:?}, script={script:?}"
            );
        }
    }
}

#[test]
fn empty_side_respects_the_edit_distance_limit() {
    let limits = DiffLimits::default().with_max_edit_distance(0);

    assert_eq!(
        edits(&[] as &[u8], &[1], limits, &NeverCancel),
        Err(DiffError::EditDistanceLimit { limit: 0 })
    );
    assert_eq!(
        edits(&[1], &[] as &[u8], limits, &NeverCancel),
        Err(DiffError::EditDistanceLimit { limit: 0 })
    );
}

#[test]
fn empty_side_observes_cancellation_while_building_the_edit_script() {
    struct CancelAfter {
        calls: AtomicUsize,
        allowed_calls: usize,
    }

    impl DiffCancellation for CancelAfter {
        fn is_cancelled(&self) -> bool {
            self.calls.fetch_add(1, Ordering::Relaxed) >= self.allowed_calls
        }
    }

    for (old, new) in [(Vec::new(), vec![1; 2_048]), (vec![1; 2_048], Vec::new())] {
        let cancellation = CancelAfter {
            calls: AtomicUsize::new(0),
            allowed_calls: 1,
        };
        assert_eq!(
            edits(&old, &new, DiffLimits::default(), &cancellation),
            Err(DiffError::Cancelled)
        );
    }
}

fn binary_sequences(maximum_length: usize) -> Vec<Vec<u8>> {
    let mut sequences = Vec::new();
    for length in 0..=maximum_length {
        for bits in 0..(1usize << length) {
            sequences.push(
                (0..length)
                    .map(|position| ((bits >> position) & 1) as u8)
                    .collect(),
            );
        }
    }
    sequences
}

fn assert_script_reconstructs(old: &[u8], new: &[u8], script: &[Edit]) {
    let mut old_cursor = 0;
    let mut new_cursor = 0;
    for edit in script {
        match *edit {
            Edit::Equal {
                old: old_index,
                new: new_index,
            } => {
                assert_eq!((old_index, new_index), (old_cursor, new_cursor));
                assert_eq!(old[old_index], new[new_index]);
                old_cursor += 1;
                new_cursor += 1;
            }
            Edit::Delete { old: old_index } => {
                assert_eq!(old_index, old_cursor);
                old_cursor += 1;
            }
            Edit::Insert { new: new_index } => {
                assert_eq!(new_index, new_cursor);
                new_cursor += 1;
            }
        }
    }
    assert_eq!(old_cursor, old.len());
    assert_eq!(new_cursor, new.len());
}

fn reference_edit_distance(old: &[u8], new: &[u8]) -> usize {
    let mut previous = (0..=new.len()).collect::<Vec<_>>();
    for (old_index, old_value) in old.iter().enumerate() {
        let mut current = vec![old_index + 1; new.len() + 1];
        for (new_index, new_value) in new.iter().enumerate() {
            current[new_index + 1] = if old_value == new_value {
                previous[new_index]
            } else {
                1 + previous[new_index + 1].min(current[new_index])
            };
        }
        previous = current;
    }
    previous[new.len()]
}
