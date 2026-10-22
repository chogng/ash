use super::*;

#[test]
#[ignore = "real native helper for live backend tests"]
fn native_process_helper() {
    run_native_watcher().unwrap();
}

fn child_command(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "native::tests::process_helper",
        "--ignored",
        "--nocapture",
    ]);
    command.env("ASH_WATCHER_TEST_CHILD", mode);
    command
}

#[test]
#[ignore = "private subprocess fixture, launched by the tests below"]
fn process_helper() {
    let mode = std::env::var("ASH_WATCHER_TEST_CHILD").expect("child fixture mode");
    let socket = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
    let mut output = socket.try_clone().unwrap();
    write_frame(&mut output, &Reply::Ready { version: VERSION }).unwrap();
    let mut input = BufReader::new(socket);
    let request = read_frame::<WatchRequest>(&mut input).unwrap().unwrap();
    match mode.as_str() {
        "hang-on-second" => {
            write_frame(
                &mut output,
                &Reply::Applied {
                    id: request.id,
                    error: None,
                },
            )
            .unwrap();
            let _ = read_frame::<WatchRequest>(&mut input).unwrap().unwrap();
            loop {
                thread::park();
            }
        }
        "hang" => loop {
            thread::park();
        },
        "invalid" => {
            output.write_all(b"{\"type\":\"unknown\"}\n").unwrap();
            loop {
                thread::park();
            }
        }
        "event-storm" => {
            // Fill the parent's ingress before acknowledging registration. Waiting
            // for consumer capacity in its reader would deadlock this transaction.
            for _ in 0..4096 {
                write_frame(
                    &mut output,
                    &Reply::Changed {
                        kind: Change::Content,
                        paths: vec![request.paths[0].path.clone()],
                    },
                )
                .unwrap();
            }
            write_frame(
                &mut output,
                &Reply::Applied {
                    id: request.id,
                    error: None,
                },
            )
            .unwrap();
            let request = read_frame::<WatchRequest>(&mut input).unwrap().unwrap();
            write_frame(
                &mut output,
                &Reply::Changed {
                    kind: Change::Content,
                    paths: vec![request.paths[0].path.clone()],
                },
            )
            .unwrap();
            write_frame(
                &mut output,
                &Reply::Applied {
                    id: request.id,
                    error: None,
                },
            )
            .unwrap();
            let _ = read_frame::<WatchRequest>(&mut input);
        }
        "healthy" => {
            assert_eq!(request.paths.len(), 2);
            assert!(request.replace.is_empty());
            write_frame(
                &mut output,
                &Reply::Changed {
                    kind: Change::Content,
                    paths: vec![request.paths[0].path.clone()],
                },
            )
            .unwrap();
            write_frame(
                &mut output,
                &Reply::Applied {
                    id: request.id,
                    error: None,
                },
            )
            .unwrap();
            let request = read_frame::<WatchRequest>(&mut input).unwrap().unwrap();
            assert_eq!(request.paths.len(), 1);
            assert_eq!(request.replace.len(), 1);
            write_frame(
                &mut output,
                &Reply::Applied {
                    id: request.id,
                    error: None,
                },
            )
            .unwrap();
            // Remain alive until the parent disposes the helper.
            let _ = read_frame::<WatchRequest>(&mut input);
        }
        _ => panic!("unknown fixture mode"),
    }
}

fn roots() -> BTreeMap<PathBuf, RecursiveMode> {
    BTreeMap::from([
        (
            PathBuf::from("/private/tmp/ash-watch-a"),
            RecursiveMode::Recursive,
        ),
        (
            PathBuf::from("/private/tmp/ash-watch-b"),
            RecursiveMode::NonRecursive,
        ),
    ])
}

#[test]
fn hung_registration_is_bounded_and_child_is_reaped() {
    let (events, _receiver) = crate::ingress::event_channel();
    let mut watcher =
        NativeWatcher::spawn(child_command("hang"), events, Duration::from_millis(100)).unwrap();
    let started = std::time::Instant::now();
    assert!(watcher.apply(&roots(), &BTreeSet::new()).is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(watcher.child.try_wait().unwrap().is_some());
    assert!(watcher.reader.is_none());
    assert!(!watcher.is_alive());
}

#[test]
fn malformed_reply_fails_the_transaction_and_reaps_the_child() {
    let (events, _receiver) = crate::ingress::event_channel();
    let mut watcher =
        NativeWatcher::spawn(child_command("invalid"), events, Duration::from_secs(1)).unwrap();
    assert!(watcher.apply(&roots(), &BTreeSet::new()).is_err());
    assert!(watcher.child.try_wait().unwrap().is_some());
    assert!(watcher.reader.is_none());
}

#[test]
fn root_snapshots_and_content_event_kinds_cross_the_process_boundary() {
    let (events, mut receiver) = crate::ingress::event_channel();
    let mut watcher =
        NativeWatcher::spawn(child_command("healthy"), events, Duration::from_secs(1)).unwrap();
    let mut roots = roots();
    watcher.apply(&roots, &BTreeSet::new()).unwrap();
    let event = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(receiver.recv())
        .unwrap()
        .unwrap();
    assert_eq!(
        event.kind,
        EventKind::Modify(ModifyKind::Data(DataChange::Any))
    );
    assert_eq!(
        event.paths,
        vec![roots.first_key_value().unwrap().0.clone()]
    );
    let removed = roots.keys().cloned().collect();
    roots.pop_last();
    watcher.apply(&roots, &removed).unwrap();
    assert!(watcher.is_alive());
    watcher.stop();
    assert!(watcher.child.try_wait().unwrap().is_some());
    assert!(watcher.reader.is_none());
}

#[test]
fn saturated_ingress_does_not_block_helper_replies_or_repeat_recovery() {
    let (events, mut receiver) = crate::ingress::event_channel();
    let mut watcher =
        NativeWatcher::spawn(child_command("event-storm"), events, Duration::from_secs(3)).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let mut roots = roots();
    // No receiver is running until the helper's reply has crossed the full queue.
    watcher.apply(&roots, &BTreeSet::new()).unwrap();
    runtime.block_on(async {
        assert!(receiver.recv().await.unwrap().unwrap().need_rescan());
    });
    let removed = BTreeSet::from([roots.pop_last().unwrap().0]);
    watcher.apply(&roots, &removed).unwrap();
    runtime.block_on(async {
        let event = receiver.recv().await.unwrap().unwrap();
        assert!(!event.need_rescan());
        assert_eq!(
            event.paths,
            vec![roots.first_key_value().unwrap().0.clone()]
        );
        assert!(
            tokio::time::timeout(
                crate::ingress::RESCAN_INTERVAL + Duration::from_millis(25),
                receiver.recv(),
            )
            .await
            .is_err(),
            "a recovered, quiet helper must not schedule another rescan"
        );
    });
    watcher.stop();
    assert!(watcher.child.try_wait().unwrap().is_some());
    assert!(watcher.reader.is_none());
}

#[test]
fn process_protocol_rejects_invalid_paths_and_oversized_frames() {
    for path in [b"relative".to_vec(), Vec::new(), b"/tmp/bad\0path".to_vec()] {
        assert!(decode_path(path).is_err());
    }
    let path = b"/tmp/non-utf8-\xff".to_vec();
    assert_eq!(
        decode_path(path.clone()).unwrap().as_os_str().as_bytes(),
        path
    );
    assert!(read_frame::<Reply>(&mut &b"{\"type\":\"rescan\",\"extra\":true}\n"[..]).is_err());
    assert!(read_frame::<Reply>(&mut vec![b'x'; MAX_FRAME as usize + 1].as_slice()).is_err());
}

#[test]
fn closing_the_parent_socket_terminates_the_real_helper() {
    let (mut socket, child_socket) = UnixStream::pair().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let input: std::os::fd::OwnedFd = child_socket.into();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "native::tests::native_process_helper",
            "--ignored",
            "--nocapture",
        ])
        .stdin(Stdio::from(input))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(socket.try_clone().unwrap());
    let ready = read_frame::<Reply>(&mut reader);
    let initialized = matches!(ready, Ok(Some(Reply::Ready { version: VERSION })));
    if initialized {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch
            .path()
            .canonicalize()
            .unwrap()
            .as_os_str()
            .as_bytes()
            .to_vec();
        let _ = write_frame(
            &mut socket,
            &WatchRequest {
                polling_interval_millis: None,
                id: 1,
                paths: vec![WireWatch {
                    path: root.clone(),
                    recursive: true,
                    contents: true,
                }],
                replace: vec![],
                probe: root,
            },
        );
    }
    drop(reader);
    drop(socket);
    let started = std::time::Instant::now();
    let exited = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if started.elapsed() > Duration::from_secs(2) {
            break false;
        }
        thread::sleep(Duration::from_millis(10));
    };
    if !exited {
        let _ = child.kill();
    }
    child.wait().unwrap();
    assert!(initialized, "real helper did not initialize");
    assert!(exited, "helper survived parent socket closure");
}

#[test]
#[ignore = "real polling helper for live backend tests"]
fn polling_process_helper() {
    run_polling_watcher().unwrap();
}

#[tokio::test]
async fn unchanged_polling_registrations_do_not_trigger_another_consumer_rescan() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().canonicalize().unwrap();
    let file = root.join("tracked.txt");
    std::fs::write(&file, "before").unwrap();
    let (events, mut receiver) = crate::ingress::event_channel();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "native::tests::polling_process_helper",
        "--ignored",
        "--nocapture",
    ]);
    let mut watcher = NativeWatcher::spawn(command, events, REGISTER_TIMEOUT).unwrap();
    let roots = BTreeMap::from([(root, (RecursiveMode::Recursive, true))]);
    watcher
        .apply_polling(&roots, &BTreeSet::new(), Duration::from_millis(20))
        .unwrap();
    let baseline = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(baseline.need_rescan());
    for _ in 0..20 {
        watcher
            .apply_polling(&roots, &BTreeSet::new(), Duration::from_millis(20))
            .unwrap();
    }
    // Ingress rate-limits rescans to one second. Wait beyond that deadline to
    // distinguish a suppressed duplicate from a merely delayed recovery marker.
    assert!(
        tokio::time::timeout(Duration::from_millis(1200), receiver.recv())
            .await
            .is_err()
    );
    std::fs::write(&file, "after").unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = receiver.recv().await.unwrap().unwrap();
            if event.paths.contains(&file) {
                break;
            }
        }
    })
    .await
    .unwrap();
    watcher.stop();
}

#[test]
#[ignore = "polling helper with a blocked baseline scan"]
fn polling_blocked_process_helper() {
    polling::run_with_scan(|_, _, _| {
        std::fs::write(
            std::env::var_os("ASH_TEST_POLL_SCAN_ENTERED").unwrap(),
            b"scanning",
        )
        .unwrap();
        loop {
            thread::park();
        }
    })
    .unwrap();
}

#[test]
fn polling_scan_cannot_block_registration_updates_or_helper_shutdown() {
    let scratch = tempfile::tempdir().unwrap();
    let entered = scratch.path().join("entered");
    let mut child = Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "native::tests::polling_blocked_process_helper",
        "--ignored",
        "--nocapture",
    ]);
    child.env("ASH_TEST_POLL_SCAN_ENTERED", &entered);
    let (events, _receiver) = crate::ingress::event_channel();
    let mut watcher = NativeWatcher::spawn(child, events, Duration::from_millis(500)).unwrap();
    let root = scratch.path().canonicalize().unwrap();
    watcher
        .apply_polling(
            &BTreeMap::from([(root, (RecursiveMode::Recursive, true))]),
            &BTreeSet::new(),
            Duration::from_millis(20),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !entered.exists() {
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    let started = Instant::now();
    watcher
        .apply_polling(
            &BTreeMap::new(),
            &BTreeSet::new(),
            Duration::from_millis(20),
        )
        .unwrap();
    watcher.stop();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(watcher.child.try_wait().unwrap().is_some());
    assert!(watcher.reader.is_none());
}
