use super::RequestIds;
use std::collections::BTreeSet;

#[test]
fn request_ids_keep_a_long_connection_in_one_interval() {
    let mut ids = RequestIds::default();
    for id in 1..=1_000_000 {
        assert!(ids.insert(id));
    }
    assert_eq!(ids.ranges.len(), 1);
    for id in [1, 500_000, 1_000_000] {
        assert!(!ids.insert(id));
    }
}

#[test]
fn request_ids_merge_gaps_and_preserve_out_of_order_uniqueness() {
    let mut ids = RequestIds::default();
    let mut expected = BTreeSet::new();
    // Exercise every ID in a permuted order, with duplicates and both-sided merges.
    for id in (0..4096).map(|step| (step * 73) % 257).chain(0..257) {
        assert_eq!(ids.insert(id), expected.insert(id), "request {id}");
    }
    assert_eq!(ids.ranges.into_iter().collect::<Vec<_>>(), [(0, 256)]);
}

#[test]
fn request_ids_do_not_join_across_integer_overflow() {
    let mut ids = RequestIds::default();
    for id in [u64::MAX, 0, u64::MAX - 2, 2, u64::MAX - 1, 1] {
        assert!(ids.insert(id));
    }
    assert_eq!(
        ids.ranges
            .iter()
            .map(|(&start, &end)| (start, end))
            .collect::<Vec<_>>(),
        [(0, 2), (u64::MAX - 2, u64::MAX)]
    );
    for id in [0, 1, 2, u64::MAX - 2, u64::MAX - 1, u64::MAX] {
        assert!(!ids.insert(id));
    }
}
