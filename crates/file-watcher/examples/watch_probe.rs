//! Minimal process-isolated reproduction: `watch_probe <mode> <scratch-directory>`.
//! Run with an external deadline: the native API may never return from registration.

use ash_file_watcher::FileWatcher;
use ash_file_watcher::FileWatcherBackend;
use ash_file_watcher::FileWatcherEvent;
use ash_file_watcher::WatchPath;
use notify::Watcher;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn phase(value: &str) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some(ash_file_watcher::NATIVE_WATCHER_ARGUMENT) {
        return ash_file_watcher::run_native_watcher().map_err(Into::into);
    }
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some(ash_file_watcher::POLLING_WATCHER_ARGUMENT) {
        return ash_file_watcher::run_polling_watcher().map_err(Into::into);
    }
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let [mode, root] = arguments.as_slice() else {
        return Err("usage: watch_probe native|ash|poll|native-delete|native-alias-delete|ash-root|poll-root <directory>".into());
    };
    if !matches!(
        mode.as_str(),
        "native"
            | "ash"
            | "poll"
            | "native-delete"
            | "native-alias-delete"
            | "ash-root"
            | "poll-root"
    ) {
        return Err("unknown probe mode".into());
    }
    if mode.ends_with("-root") {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?;
        let _entered = executor.enter();
        let watcher = Arc::new(FileWatcher::new_with_backend(if mode == "poll-root" {
            FileWatcherBackend::Polling {
                interval: Duration::from_millis(200),
            }
        } else {
            FileWatcherBackend::Recommended
        })?);
        let (subscriber, _events) = watcher.add_subscriber();
        phase("before_root_registration");
        let registration = subscriber.register_paths(vec![WatchPath {
            path: PathBuf::from(root).canonicalize()?,
            recursive: true,
        }])?;
        phase("after_root_registration");
        drop(registration);
        phase("after_root_unregistration");
        return Ok(());
    }
    if mode.ends_with("delete") {
        let directory = PathBuf::from(root).join(format!("watch-probe-dir-{}", std::process::id()));
        fs::create_dir(&directory)?;
        let directory = if mode == "native-delete" {
            directory.canonicalize()?
        } else {
            directory
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        phase("before_native_registration");
        let mut changes = watcher.paths_mut();
        changes.add(&directory, notify::RecursiveMode::Recursive)?;
        changes.add(
            directory.parent().unwrap(),
            notify::RecursiveMode::NonRecursive,
        )?;
        changes.commit()?;
        phase("after_native_registration");
        fs::remove_dir(&directory)?;
        let event: notify::Result<notify::Event> = receiver.recv_timeout(Duration::from_secs(3))?;
        println!("{event:?}");
        phase("observed_deletion");
        return Ok(());
    }
    let file = PathBuf::from(root)
        .canonicalize()?
        .join(format!("watch-probe-{}", std::process::id()));
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&file)?
        .write_all(b"initial")?;
    phase("created_scratch_file");

    if mode == "native" {
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        phase("before_native_registration");
        watcher.watch(&file, notify::RecursiveMode::NonRecursive)?;
        phase("after_native_registration");
        fs::write(&file, "changed")?;
        receiver.recv_timeout(Duration::from_secs(3))??;
    } else {
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?;
        let watcher = {
            let _entered = executor.enter();
            Arc::new(FileWatcher::new_with_backend(if mode == "poll" {
                FileWatcherBackend::Polling {
                    interval: Duration::from_millis(50),
                }
            } else {
                FileWatcherBackend::Recommended
            })?)
        };
        let (subscriber, mut events) = watcher.add_subscriber();
        phase("before_ash_registration");
        let _registration = subscriber.register_paths(vec![WatchPath {
            path: file.clone(),
            recursive: false,
        }])?;
        phase("after_ash_registration");
        fs::write(&file, "changed")?;
        executor.block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    match events.recv().await.ok_or("watcher closed")? {
                        FileWatcherEvent::PathsChanged { paths } if paths.contains(&file) => {
                            return Ok::<(), &'static str>(());
                        }
                        _ => {}
                    }
                }
            })
            .await
        })??;
    }
    phase("observed_write");
    fs::remove_file(file)?;
    phase("completed");
    Ok(())
}
