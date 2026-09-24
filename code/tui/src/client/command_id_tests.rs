use super::new_command_id;

#[test]
fn new_logical_commands_receive_distinct_prefixed_ids() {
    let first = new_command_id("turn");
    let second = new_command_id("turn");

    assert!(first.as_str().starts_with("turn-"));
    assert!(second.as_str().starts_with("turn-"));
    assert_ne!(first, second);
}

#[test]
fn concurrent_commands_keep_distinct_identities() {
    let workers = (0..4)
        .map(|_| {
            std::thread::spawn(|| {
                (0..256)
                    .map(|_| new_command_id("issue"))
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let ids = workers
        .into_iter()
        .flat_map(|worker| worker.join().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 1024);
    assert!(ids.iter().all(|id| id.as_str().starts_with("issue-")));
}
