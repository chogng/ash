use std::cell::Cell;
use std::num::NonZeroUsize;

use super::BlockingLruCache;
use super::sha1_digest;

#[tokio::test(flavor = "multi_thread")]
async fn stores_reuses_and_removes_values() {
    let cache = BlockingLruCache::new(NonZeroUsize::new(2).expect("non-zero capacity"));
    let calls = Cell::new(0);

    assert_eq!(
        cache.get_or_insert_with("first", || {
            calls.set(calls.get() + 1);
            1
        }),
        1
    );
    assert_eq!(cache.get_or_insert_with("first", || 2), 1);
    assert_eq!(calls.get(), 1);
    assert_eq!(cache.insert("first", 3), Some(1));
    assert_eq!(cache.remove(&"first"), Some(3));
    assert_eq!(cache.get(&"first"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn evicts_the_least_recently_used_entry() {
    let cache = BlockingLruCache::new(NonZeroUsize::new(2).expect("non-zero capacity"));
    cache.insert("a", 1);
    cache.insert("b", 2);
    assert_eq!(cache.get(&"a"), Some(1));

    cache.insert("c", 3);

    assert_eq!(cache.get(&"b"), None);
    assert_eq!(cache.get(&"a"), Some(1));
    assert_eq!(cache.get(&"c"), Some(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn fallible_factory_only_caches_success() {
    let cache = BlockingLruCache::new(NonZeroUsize::new(1).expect("non-zero capacity"));

    assert_eq!(
        cache.get_or_try_insert_with("key", || Err::<usize, _>("failed")),
        Err("failed")
    );
    assert_eq!(cache.get(&"key"), None);
    assert_eq!(
        cache.get_or_try_insert_with("key", || Ok::<_, &str>(7)),
        Ok(7)
    );
    assert_eq!(
        cache.get_or_try_insert_with("key", || Ok::<_, &str>(8)),
        Ok(7)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn exposes_mutation_clear_and_guard_operations() {
    let cache = BlockingLruCache::new(NonZeroUsize::new(2).expect("non-zero capacity"));

    cache.with_mut(|inner| {
        inner.put("first", 1);
    });
    assert_eq!(cache.get(&"first"), Some(1));
    drop(cache.blocking_lock());
    cache.clear();
    assert_eq!(cache.get(&"first"), None);
}

#[test]
fn zero_capacity_disables_construction() {
    assert!(BlockingLruCache::<String, String>::try_with_capacity(0).is_none());
    assert!(BlockingLruCache::<String, String>::try_with_capacity(1).is_some());
}

#[test]
fn ordinary_threads_reuse_and_mutate_the_same_cache() {
    let cache = BlockingLruCache::new(NonZeroUsize::MIN);
    cache.insert("first", 1);
    assert_eq!(
        cache.get_or_insert_with("first", || panic!("cached value must be reused")),
        1
    );
    cache.with_mut(|inner| {
        inner.put("second", 2);
    });
    assert_eq!(cache.get(&"first"), None);
    assert_eq!(cache.blocking_lock().get(&"second"), Some(&2));
    assert_eq!(cache.remove(&"second"), Some(2));
    cache.clear();
    assert_eq!(cache.get(&"second"), None);
}

#[tokio::test(flavor = "current_thread")]
async fn current_thread_runtime_reuses_cached_values() {
    let cache = BlockingLruCache::new(NonZeroUsize::MIN);
    cache.insert("key", 1);
    assert_eq!(cache.get(&"key"), Some(1));
    assert_eq!(
        cache.get_or_insert_with("key", || panic!("cached value must be reused")),
        1
    );
    cache.clear();
    assert_eq!(cache.get(&"key"), None);
}

#[test]
fn concurrent_factories_compute_a_shared_key_once() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    let cache = BlockingLruCache::new(NonZeroUsize::MIN);
    let calls = AtomicUsize::new(0);
    let ready = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                ready.wait();
                assert_eq!(
                    cache.get_or_insert_with("key", || calls.fetch_add(1, Ordering::SeqCst)),
                    0
                );
            });
        }
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn panicking_factory_does_not_disable_the_cache() {
    let cache = BlockingLruCache::new(NonZeroUsize::MIN);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cache.get_or_insert_with("key", || panic!("factory failed"))
        }))
        .is_err()
    );
    assert_eq!(cache.get_or_insert_with("key", || 42), 42);
    assert_eq!(cache.get(&"key"), Some(42));
}

#[test]
fn computes_the_standard_sha1_digest() {
    assert_eq!(
        sha1_digest(b"abc"),
        [
            0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e, 0x25, 0x71, 0x78, 0x50,
            0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d,
        ]
    );
}
