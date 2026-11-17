use super::ConnectionResourceUsage;
use super::MAX_RESOURCE_BYTES;
use super::MAX_RESOURCE_BYTES_PER_CONNECTION;
use super::MAX_RESOURCES_PER_CONNECTION;
use super::ResourceError;
use super::ResourceStore;
use std::io::Read;
use std::io::Write;
use std::time::Duration;

#[test]
fn file_snapshot_preserves_random_reads_and_connection_ownership() {
    let mut store = ResourceStore::default();
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"snapshot").unwrap();
    let metadata = store
        .create_file_snapshot(
            7,
            "application/octet-stream".into(),
            file,
            8,
            "revision",
            Duration::from_secs(60),
        )
        .unwrap();
    assert_eq!(metadata.sha256, "sha256:revision");
    assert!(matches!(
        store.read(8, &metadata.resource_id, 0, 3),
        Err(ResourceError::NotOwner)
    ));
    let tail = store.read(7, &metadata.resource_id, 4, 8).unwrap();
    assert_eq!(tail.data, b"shot");
    assert!(tail.eof);
    let start = store.read(7, &metadata.resource_id, 0, 4).unwrap();
    assert_eq!(start.data, b"snap");
    assert!(!start.eof);
    store.release_owner(7);
    assert!(matches!(
        store.read(7, &metadata.resource_id, 0, 3),
        Err(ResourceError::NotFound)
    ));
}

#[test]
fn transferring_a_file_snapshot_rewinds_it_and_releases_its_quota() {
    let mut store = ResourceStore::default();
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"snapshot").unwrap();
    let id = store
        .create_file_snapshot(
            1,
            "application/pdf".into(),
            file,
            8,
            "revision",
            Duration::from_secs(60),
        )
        .unwrap()
        .resource_id;
    assert!(matches!(
        store.take_reader(2, &id),
        Err(ResourceError::NotOwner)
    ));
    assert_eq!(store.read(1, &id, 4, 4).unwrap().data, b"shot");

    let (size, mut reader) = store.take_reader(1, &id).unwrap();
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(size, 8);
    assert_eq!(bytes, b"snapshot");
    assert!(!store.usage_by_connection.contains_key(&1));
    assert!(matches!(
        store.take_reader(1, &id),
        Err(ResourceError::NotFound)
    ));
}

#[test]
fn domain_read_limit_preserves_general_resource_limit() {
    let mut store = ResourceStore::default();
    let size = MAX_RESOURCE_BYTES + 1;
    assert!(matches!(
        store.create(
            1,
            "application/octet-stream".into(),
            vec![42; size],
            Duration::from_secs(60)
        ),
        Err(ResourceError::TooLarge)
    ));
    let metadata = store
        .create_with_limit(
            1,
            "application/octet-stream".into(),
            vec![42; size],
            Duration::from_secs(60),
            size,
        )
        .expect("file within its domain limit");
    assert_eq!(metadata.size, size);
    assert!(matches!(
        store.metadata(2, &metadata.resource_id),
        Err(ResourceError::NotOwner)
    ));
    let chunk = store
        .read(1, &metadata.resource_id, size - 1, 1)
        .expect("read final byte");
    assert_eq!(chunk.data, vec![42]);
    assert!(chunk.eof);
    store
        .release(1, &metadata.resource_id)
        .expect("release large file");
    assert!(!store.usage_by_connection.contains_key(&1));
}

#[test]
fn domain_read_limit_still_enforces_connection_byte_quota() {
    let mut store = ResourceStore::default();
    let max_bytes = 50 * 1024 * 1024;
    let first = store
        .create_with_limit(
            1,
            "application/octet-stream".into(),
            vec![0; max_bytes],
            Duration::from_secs(60),
            max_bytes,
        )
        .expect("first file within connection quota");
    let next_size = MAX_RESOURCE_BYTES + 1;
    assert!(matches!(
        store.create_with_limit(
            1,
            "application/octet-stream".into(),
            vec![0; next_size],
            Duration::from_secs(60),
            max_bytes,
        ),
        Err(ResourceError::TooLarge)
    ));
    store
        .release(1, &first.resource_id)
        .expect("release first file");
    assert!(
        store
            .create_with_limit(
                1,
                "application/octet-stream".into(),
                vec![0; next_size],
                Duration::from_secs(60),
                max_bytes,
            )
            .is_ok()
    );
}

#[test]
fn enforces_resource_count_per_connection_and_releases_capacity() {
    let mut store = ResourceStore::default();
    let mut first_resource_id = None;
    for index in 0..MAX_RESOURCES_PER_CONNECTION {
        let metadata = store
            .create(
                1,
                "application/octet-stream".into(),
                Vec::new(),
                Duration::from_secs(60),
            )
            .expect("resource within connection count limit");
        if index == 0 {
            first_resource_id = Some(metadata.resource_id);
        }
    }

    assert!(matches!(
        store.create(
            1,
            "application/octet-stream".into(),
            Vec::new(),
            Duration::from_secs(60)
        ),
        Err(ResourceError::TooLarge)
    ));
    assert!(
        store
            .create(
                2,
                "application/octet-stream".into(),
                Vec::new(),
                Duration::from_secs(60)
            )
            .is_ok()
    );

    store
        .release(1, &first_resource_id.expect("first resource ID"))
        .expect("release resource");
    assert!(
        store
            .create(
                1,
                "application/octet-stream".into(),
                Vec::new(),
                Duration::from_secs(60)
            )
            .is_ok()
    );
}

#[test]
fn enforces_total_resource_bytes_per_connection() {
    let at_boundary = ConnectionResourceUsage {
        count: 1,
        bytes: MAX_RESOURCE_BYTES_PER_CONNECTION - 1,
    };
    assert!(at_boundary.can_add(1));
    assert!(!at_boundary.can_add(2));

    let at_count_limit = ConnectionResourceUsage {
        count: MAX_RESOURCES_PER_CONNECTION,
        bytes: 0,
    };
    assert!(!at_count_limit.can_add(0));
}

#[test]
fn tracks_actual_bytes_across_create_and_release() {
    let mut store = ResourceStore::default();
    let first = store
        .create(
            1,
            "application/octet-stream".into(),
            vec![0; 3],
            Duration::from_secs(60),
        )
        .expect("first resource");
    store
        .create(
            1,
            "application/octet-stream".into(),
            vec![0; 5],
            Duration::from_secs(60),
        )
        .expect("second resource");

    assert_eq!(store.usage_by_connection[&1].count, 2);
    assert_eq!(store.usage_by_connection[&1].bytes, 8);
    store.release(1, &first.resource_id).expect("release first");
    assert_eq!(store.usage_by_connection[&1].count, 1);
    assert_eq!(store.usage_by_connection[&1].bytes, 5);
    store.release_owner(1);
    assert!(!store.usage_by_connection.contains_key(&1));
}

#[test]
fn expired_resources_do_not_consume_connection_capacity() {
    let mut store = ResourceStore::default();
    for _ in 0..MAX_RESOURCES_PER_CONNECTION {
        store
            .create(
                1,
                "application/octet-stream".into(),
                Vec::new(),
                Duration::from_nanos(1),
            )
            .expect("expired resource is cleaned before the next create");
    }

    assert!(
        store
            .create(
                1,
                "application/octet-stream".into(),
                Vec::new(),
                Duration::from_secs(60)
            )
            .is_ok()
    );
}
