use crate::WatchPath;
use crate::state::SubscriberWatchKey;
use crate::state::SubscriberWatchState;
use std::path::Path;
use std::path::PathBuf;

pub(crate) fn dedupe_watched_paths(mut watched_paths: Vec<WatchPath>) -> Vec<WatchPath> {
    watched_paths.sort_unstable_by(|left, right| {
        left.path
            .as_os_str()
            .cmp(right.path.as_os_str())
            .then(left.recursive.cmp(&right.recursive))
    });
    watched_paths.dedup();
    watched_paths
}

/// Resolves a requested path into an OS watch and a canonical match path.
///
/// Missing targets use their nearest existing directory ancestor
/// non-recursively. The watcher moves closer as path components appear.
pub(crate) fn actual_watch_path(requested: &WatchPath) -> (WatchPath, WatchPath, bool) {
    if requested.path.exists() {
        let matched_path = requested
            .path
            .canonicalize()
            .unwrap_or_else(|_| requested.path.clone());
        return (
            requested.clone(),
            WatchPath {
                path: matched_path,
                recursive: requested.recursive,
            },
            false,
        );
    }

    let mut ancestor = requested.path.parent();
    while let Some(path) = ancestor {
        if path.is_dir() {
            let actual_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            let matched_path = requested
                .path
                .strip_prefix(path)
                .map(|suffix| actual_path.join(suffix))
                .unwrap_or_else(|_| requested.path.clone());
            return (
                WatchPath {
                    path: path.to_path_buf(),
                    recursive: false,
                },
                WatchPath {
                    path: matched_path,
                    recursive: requested.recursive,
                },
                true,
            );
        }
        ancestor = path.parent();
    }

    (requested.clone(), requested.clone(), false)
}

pub(crate) fn changed_path_for_event(
    key: &SubscriberWatchKey,
    state: &mut SubscriberWatchState,
    event_path: &Path,
) -> Option<PathBuf> {
    let changed =
        changed_path_for_namespace(key, state, &key.matched, event_path).or_else(|| {
            (key.matched.path != key.requested.path)
                .then(|| changed_path_for_namespace(key, state, &key.requested, event_path))
                .flatten()
        })?;
    #[cfg(target_os = "macos")]
    {
        // PollWatcher compares directory mtimes at second resolution. A rename + recreate
        // can keep that timestamp, while deleted children still reveal the replacement.
        let identity = root_identity(&key.requested.path);
        if identity != state.root_identity {
            state.root_identity = identity;
        }
    }
    Some(changed)
}

#[cfg(target_os = "macos")]
pub(crate) fn root_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

fn changed_path_for_namespace(
    key: &SubscriberWatchKey,
    state: &mut SubscriberWatchState,
    matched: &WatchPath,
    event_path: &Path,
) -> Option<PathBuf> {
    let requested = &key.requested;
    if event_path == matched.path {
        state.last_exists = matched.path.exists();
        return Some(requested.path.clone());
    }
    if matched.path.starts_with(event_path) {
        let now_exists = matched.path.exists();
        if state.fallback || state.actual.path != matched.path {
            let should_notify = now_exists || state.last_exists;
            state.last_exists = now_exists;
            return should_notify.then(|| requested.path.clone());
        }
        state.last_exists = now_exists;
        // Parent watches invalidate the requested root, never its ancestor's namespace.
        return Some(requested.path.clone());
    }
    if !event_path.starts_with(&matched.path) {
        return None;
    }
    if !(matched.recursive || event_path.parent() == Some(matched.path.as_path())) {
        return None;
    }
    state.last_exists = matched.path.exists();
    Some(
        event_path
            .strip_prefix(&matched.path)
            .map(|suffix| requested.path.join(suffix))
            .unwrap_or_else(|_| event_path.to_path_buf()),
    )
}
