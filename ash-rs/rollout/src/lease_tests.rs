use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_protocol::ThreadId;
use core_api::WriterLease;

use super::LeaseDirectory;

#[cfg(unix)]
#[test]
fn dropping_the_writer_releases_a_lock_with_an_inherited_descriptor() {
    let directory = lease_directory("inherited-descriptor");
    let leases = LeaseDirectory::open(&directory).unwrap();
    let thread_id = ThreadId::new("thread_1").unwrap();
    let path = directory.join(format!(
        "thread-{}.lease",
        super::encode_hex(thread_id.as_str())
    ));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap();
    file.try_lock().unwrap();
    let first = super::FileLease { file };
    // A descriptor inherited during fork shares the open file description, as a clone does.
    let inherited = first.file.try_clone().unwrap();
    drop(first);
    let second = leases.acquire(&thread_id).unwrap();
    drop(second);
    drop(inherited);
    fs::remove_dir_all(directory).unwrap();
}

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
