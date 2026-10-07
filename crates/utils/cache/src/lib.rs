use std::borrow::Borrow;
use std::hash::Hash;
use std::num::NonZeroUsize;

use lru::LruCache;
use sha1::Digest;
use sha1::Sha1;
use std::sync::Mutex;
use std::sync::MutexGuard;

/// A bounded synchronous LRU cache shared by ordinary threads and async runtimes.
/// Factories run under the cache lock and must not re-enter this cache or await work.
pub struct BlockingLruCache<K, V> {
    inner: Mutex<LruCache<K, V>>,
}

impl<K, V> BlockingLruCache<K, V>
where
    K: Eq + Hash,
{
    /// Creates a cache with the provided non-zero capacity.
    #[must_use]
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(capacity)),
        }
    }

    /// Returns a clone of the cached value for `key`, or computes and inserts it.
    pub fn get_or_insert_with(&self, key: K, value: impl FnOnce() -> V) -> V
    where
        V: Clone,
    {
        let mut guard = self.blocking_lock();
        if let Some(value) = guard.get(&key) {
            return value.clone();
        }
        let value = value();
        guard.put(key, value.clone());
        value
    }

    /// Like `get_or_insert_with`, but the value factory may fail.
    pub fn get_or_try_insert_with<E>(
        &self,
        key: K,
        value: impl FnOnce() -> Result<V, E>,
    ) -> Result<V, E>
    where
        V: Clone,
    {
        let mut guard = self.blocking_lock();
        if let Some(value) = guard.get(&key) {
            return Ok(value.clone());
        }
        let value = value()?;
        guard.put(key, value.clone());
        Ok(value)
    }

    /// Builds a cache if `capacity` is non-zero, returning `None` otherwise.
    #[must_use]
    pub fn try_with_capacity(capacity: usize) -> Option<Self> {
        NonZeroUsize::new(capacity).map(Self::new)
    }

    /// Returns a clone of the cached value corresponding to `key`, if present.
    pub fn get<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
        V: Clone,
    {
        let mut guard = self.blocking_lock();
        guard.get(key).cloned()
    }

    /// Inserts `value` for `key`, returning the previous entry if it existed.
    pub fn insert(&self, key: K, value: V) -> Option<V> {
        let mut guard = self.blocking_lock();
        guard.put(key, value)
    }

    /// Removes the entry for `key` if it exists, returning it.
    pub fn remove<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let mut guard = self.blocking_lock();
        guard.pop(key)
    }

    /// Clears all entries from the cache.
    pub fn clear(&self) {
        self.blocking_lock().clear();
    }

    /// Executes a synchronous callback under the cache lock.
    pub fn with_mut<R>(&self, callback: impl FnOnce(&mut LruCache<K, V>) -> R) -> R {
        callback(&mut self.blocking_lock())
    }

    /// Borrows the cache under its synchronous lock. Do not hold this guard across async work.
    pub fn blocking_lock(&self) -> MutexGuard<'_, LruCache<K, V>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Computes the SHA-1 digest of `bytes`.
///
/// Useful for content-based cache keys when you want to avoid staleness
/// caused by path-only keys.
#[must_use]
pub fn sha1_digest(bytes: &[u8]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    let mut digest = [0; 20];
    digest.copy_from_slice(&result);
    digest
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
