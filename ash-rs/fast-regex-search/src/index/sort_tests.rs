use super::*;

#[test]
fn bounded_multi_pass_merge_matches_sorted_unique_postings() {
    let root = tempfile::tempdir().unwrap();
    let mut sorter = Sorter::with_capacity(root.path(), 7).unwrap();
    let temporary = sorter.directory.path().to_path_buf();
    let mut expected = std::collections::BTreeSet::new();
    for id in (0..100).rev() {
        let grams = (0..35)
            .map(|i| (((i * 13 + id * 7) as u64 % 71) << 8) | 1)
            .collect::<Vec<_>>();
        for gram in &grams {
            expected.insert((
                trigram::key(*gram),
                trigram::posting(id, trigram::mask(*gram)),
            ));
        }
        sorter.push(id, &grams).unwrap();
        sorter.push(id, &grams).unwrap();
    }
    let sorted = sorter.finish().unwrap();
    let actual = sorted.collect::<io::Result<Vec<_>>>().unwrap();
    assert_eq!(actual, expected.into_iter().collect::<Vec<_>>());
    assert!(!temporary.exists());
}

#[test]
fn truncated_runs_fail_without_returning_a_partial_success() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("broken");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    assert!(Merge::open(&[path]).is_err());
    let sorter = Sorter::with_capacity(root.path(), 2).unwrap();
    assert_eq!(sorter.finish().unwrap().count(), 0);
}

#[test]
fn cleanup_preserves_an_active_sort_and_removes_abandoned_runs() {
    let root = tempfile::tempdir().unwrap();
    let active = Sorter::with_capacity(root.path(), 2).unwrap();
    let active_path = active.directory.path().to_path_buf();
    let abandoned = root.path().join(".build-abandoned");
    std::fs::create_dir(&abandoned).unwrap();
    File::create(abandoned.join("lease")).unwrap();
    std::fs::write(abandoned.join("run-0"), b"orphaned spill").unwrap();
    let second = Sorter::with_capacity(root.path(), 2).unwrap();
    assert!(active_path.exists());
    assert!(!abandoned.exists());
    drop(second);
    drop(active);
    assert!(!active_path.exists());
}
