//! PollWatcher's initial content scan is synchronous too. Admit complete root snapshots on
//! the control thread, scan them in this killable process, then invalidate the baseline gap.

use super::*;
use std::os::unix::fs::MetadataExt;
use std::sync::Condvar;

type Roots = BTreeMap<PathBuf, (RecursiveMode, bool)>;

/// Runs the private macOS polling helper; it loads no product state or credentials.
pub fn run_polling_watcher() -> Result<(), String> {
    run_with_scan(|watcher, path, mode| {
        watcher.watch(path, mode).map_err(|error| error.to_string())
    })
}

pub(super) fn run_with_scan(
    mut scan: impl FnMut(
        &mut notify::PollWatcher,
        &std::path::Path,
        RecursiveMode,
    ) -> Result<(), String>,
) -> Result<(), String> {
    let socket = UnixStream::from(
        std::io::stdin()
            .as_fd()
            .try_clone_to_owned()
            .map_err(|error| error.to_string())?,
    );
    socket
        .set_write_timeout(Some(REGISTER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(
        socket.try_clone().map_err(|error| error.to_string())?,
    ));
    let desired: Arc<(Mutex<Option<(Roots, BTreeSet<PathBuf>, u64)>>, Condvar)> =
        Arc::new((Mutex::new(None), Condvar::new()));
    write_frame(
        &mut *writer.lock().unwrap(),
        &Reply::Ready { version: VERSION },
    )?;
    let pending = Arc::clone(&desired);
    let replies = Arc::clone(&writer);
    thread::Builder::new()
        .name("ash-polling-watcher-control".into())
        .spawn(move || {
            let mut reader = BufReader::new(socket);
            let mut last_id = 0;
            let mut interval = None;
            loop {
                let request = match read_frame::<WatchRequest>(&mut reader) {
                    Ok(Some(request)) => request,
                    Ok(None) => std::process::exit(0),
                    Err(_) => std::process::exit(1),
                };
                let id = request.id;
                let result = decode_roots(request, last_id, interval);
                let error = match result {
                    Ok((roots, mut replaced, next_interval)) => {
                        last_id = id;
                        interval = Some(next_interval);
                        // Only the latest complete snapshot is retained while a scan is busy.
                        let mut latest = pending.0.lock().unwrap();
                        if let Some((_, previous_replaced, _)) = latest.take() {
                            replaced.extend(previous_replaced);
                        }
                        // Re-added roots carry their own replacement marker. Retain only
                        // current roots so a blocked scan cannot accumulate removed-path tombstones.
                        replaced.retain(|path| roots.contains_key(path));
                        *latest = Some((roots, replaced, next_interval));
                        drop(latest);
                        pending.1.notify_one();
                        None
                    }
                    Err(error) => Some(ApplyFailure::Path(error)),
                };
                if write_frame(&mut *replies.lock().unwrap(), &Reply::Applied { id, error })
                    .is_err()
                {
                    std::process::exit(1);
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let mut watchers = None;
    let mut active = Roots::new();
    let mut root_metadata = BTreeMap::new();
    let mut poll_interval = Duration::from_millis(200);
    loop {
        let (roots, replaced, interval) = {
            let mut next = desired.0.lock().unwrap();
            if next.is_none() {
                next = desired.1.wait_timeout(next, poll_interval).unwrap().0;
            }
            let Some(next) = next.take() else {
                drop(next);
                observe_root_identity(&active, &mut root_metadata, &writer)?;
                continue;
            };
            next
        };
        poll_interval = Duration::from_millis(interval);
        let (contents, metadata) = match watchers.as_mut() {
            Some(watchers) => watchers,
            None => watchers.insert((
                poller(Arc::clone(&writer), interval, true)?,
                poller(Arc::clone(&writer), interval, false)?,
            )),
        };
        for (path, settings) in &active {
            if roots.get(path) != Some(settings) || replaced.contains(path) {
                let watcher = if settings.1 {
                    &mut *contents
                } else {
                    &mut *metadata
                };
                if let Err(error) = watcher.unwatch(path)
                    && !matches!(error.kind, notify::ErrorKind::WatchNotFound)
                {
                    return Err(error.to_string());
                }
            }
        }
        for (path, settings) in &roots {
            if active.get(path) != Some(settings) || replaced.contains(path) {
                let watcher = if settings.1 {
                    &mut *contents
                } else {
                    &mut *metadata
                };
                scan(watcher, path, settings.0)?;
            }
        }
        active = roots;
        root_metadata = active
            .keys()
            .map(|path| (path.clone(), fingerprint(path)))
            .collect();
        // A mutation can precede its polling baseline. Consumers must reread their owned state
        // after that baseline; successful registration alone does not assert an initial snapshot.
        write_frame(&mut *writer.lock().unwrap(), &Reply::Rescan {})?;
    }
}

// notify's PollWatcher compares second-resolution mtimes and file hashes. A rapid directory
// replacement can preserve both and lose its descendants; stat only the registered roots at
// nanosecond/inode resolution, without reading unrelated ancestor contents.
type Fingerprint = Option<(u64, u64, u64, i64, i64)>;

fn fingerprint(path: &std::path::Path) -> Fingerprint {
    std::fs::metadata(path).ok().map(|metadata| {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
        )
    })
}

fn observe_root_identity(
    roots: &Roots,
    previous: &mut BTreeMap<PathBuf, Fingerprint>,
    writer: &Mutex<UnixStream>,
) -> Result<(), String> {
    let mut topology = Vec::new();
    let mut metadata = Vec::new();
    for path in roots.keys() {
        let current = fingerprint(path);
        if let Some(old) = previous.insert(path.clone(), current)
            && old != current
        {
            let same_identity = match (old, current) {
                (Some(old), Some(current)) => old.0 == current.0 && old.1 == current.1,
                _ => false,
            };
            if same_identity {
                metadata.push(path.as_os_str().as_bytes().to_vec());
            } else {
                topology.push(path.as_os_str().as_bytes().to_vec());
            }
        }
    }
    for (kind, paths) in [(Change::Topology, topology), (Change::Metadata, metadata)] {
        if !paths.is_empty() {
            write_frame(
                &mut *writer.lock().unwrap(),
                &Reply::Changed { kind, paths },
            )?;
        }
    }
    Ok(())
}

fn decode_roots(
    request: WatchRequest,
    last_id: u64,
    interval: Option<u64>,
) -> Result<(Roots, BTreeSet<PathBuf>, u64), String> {
    let millis = request
        .polling_interval_millis
        .ok_or("missing polling interval")?;
    if request.id <= last_id
        || !(1..=60_000).contains(&millis)
        || interval.is_some_and(|interval| interval != millis)
        || request.paths.len() > MAX_PATHS
        || request.replace.len() > MAX_PATHS
        || !request.probe.is_empty()
    {
        return Err("invalid polling watcher snapshot".into());
    }
    let mut roots = Roots::new();
    for path in request.paths {
        if roots
            .insert(
                decode_path(path.path)?,
                (
                    if path.recursive {
                        RecursiveMode::Recursive
                    } else {
                        RecursiveMode::NonRecursive
                    },
                    path.contents,
                ),
            )
            .is_some()
        {
            return Err("duplicate polling watcher root".into());
        }
    }
    let replaced = request
        .replace
        .into_iter()
        .map(decode_path)
        .collect::<Result<BTreeSet<_>, _>>()?;
    Ok((roots, replaced, millis))
}

fn poller(
    writer: Arc<Mutex<UnixStream>>,
    interval: u64,
    contents: bool,
) -> Result<notify::PollWatcher, String> {
    notify::PollWatcher::new(
        move |event: notify::Result<Event>| {
            let reply = match event {
                Ok(event) if !event.need_rescan() && is_mutation(event.kind) => Reply::Changed {
                    kind: match event.kind {
                        EventKind::Modify(ModifyKind::Data(_)) => Change::Content,
                        EventKind::Modify(ModifyKind::Metadata(_)) => Change::Metadata,
                        _ => Change::Topology,
                    },
                    paths: event
                        .paths
                        .iter()
                        .map(|path| path.as_os_str().as_bytes().to_vec())
                        .collect(),
                },
                Ok(event) if !event.need_rescan() => return,
                Ok(_) | Err(_) => Reply::Rescan {},
            };
            if write_frame(&mut *writer.lock().unwrap(), &reply).is_err() {
                std::process::exit(1);
            }
        },
        notify::Config::default()
            .with_compare_contents(contents)
            .with_poll_interval(Duration::from_millis(interval)),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "polling_tests.rs"]
mod tests;
