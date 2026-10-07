use super::ConnectionResourceUsage;
use super::MAX_RESOURCE_BYTES_PER_CONNECTION;
use super::MAX_RESOURCES_PER_CONNECTION;
use super::ResourceError;
use super::ResourceStore;
use std::time::Duration;

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
