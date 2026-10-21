//! Manually driven, finite RSS experiment. The legacy arm models the former
//! unbounded ingress + subscriber set; it is not a benchmark of an old Desktop.

use crate::channel::watch_channel;
use crate::ingress::event_channel;
use notify::Event;
use notify::EventKind;
use notify::event::CreateKind;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;

fn checkpoint(round: usize) {
    println!("MEMORY_CHECKPOINT {round}");
    std::io::stdout().flush().unwrap();
    // The external harness samples RSS, enforces its memory/time ceiling, and
    // acknowledges each checkpoint. No unbounded writer or filesystem churn.
    let mut acknowledgement = String::new();
    assert!(std::io::stdin().read_line(&mut acknowledgement).unwrap() > 0);
}

fn produce(mut accept: impl FnMut(Event, PathBuf)) {
    checkpoint(0);
    for round in 1..=12 {
        for index in 0..20_000 {
            let path = PathBuf::from(format!("/workspace/{round}/{index}/{}", "x".repeat(160)));
            accept(
                Event::new(EventKind::Create(CreateKind::File)).add_path(path.clone()),
                path,
            );
        }
        checkpoint(round);
    }
}

#[test]
#[ignore = "finite RSS probe; requires the supervising checkpoint/memory-limit harness"]
fn slow_consumer_memory_probe() {
    match std::env::var("ASH_WATCHER_MEMORY_PROBE").unwrap().as_str() {
        "legacy" => {
            // Deliberately retained only for a bounded before/after control.
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            let mut pending = BTreeSet::new();
            produce(|event, path| {
                sender.send(event).unwrap();
                pending.insert(path);
            });
            assert_eq!(receiver.len(), 240_000);
            assert_eq!(pending.len(), 240_000);
        }
        "bounded" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            let (sender, mut receiver) = event_channel();
            let (subscriber, mut changes) = watch_channel();
            produce(|event, path| {
                sender.send(Ok(event)).unwrap();
                runtime.block_on(
                    subscriber.add_changed_paths(&[path], || vec![PathBuf::from("/workspace")]),
                );
            });
            runtime.block_on(async {
                assert!(receiver.recv().await.unwrap().unwrap().need_rescan());
                assert_eq!(
                    changes.recv().await,
                    Some(crate::FileWatcherEvent::RescanRequired {
                        watched_paths: vec![PathBuf::from("/workspace")]
                    })
                );
            });
        }
        mode => panic!("unknown probe mode {mode}"),
    }
}
