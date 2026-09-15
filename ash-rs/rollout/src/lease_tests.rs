use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use core_api::WriterLease;
use ash_protocol::ThreadId;

use super::LeaseDirectory;

fn lease_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ash-rollout-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn advisory_lease_blocks_a_second_writer_until_the_guard_drops() {
    let directory = lease_directory("lease-contention");
    let leases = LeaseDirectory::open(&directory).unwrap();
    let thread_id = ThreadId::new("thread_1").expect("test ID is non-empty");

    let first = leases.acquire(&thread_id).unwrap();
    assert!(leases.acquire(&thread_id).is_err());
    drop(first);
    leases.acquire(&thread_id).unwrap();

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stale_lease_file_does_not_block_a_new_process_incarnation() {
    let directory = lease_directory("stale-lease");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("thread_1.lease"), "stale marker").unwrap();
    let leases = LeaseDirectory::open(&directory).unwrap();

    leases
        .acquire(&ThreadId::new("thread_1").expect("test ID is non-empty"))
        .unwrap();

    fs::remove_dir_all(directory).unwrap();
}
