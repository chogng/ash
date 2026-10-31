use super::*;

const TEST_LIFETIME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct Peer {
    service: Option<TerminalService>,
    grant: Grant,
    worker: Option<thread::JoinHandle<()>>,
}

impl Peer {
    fn new(root: &Path, services: &Services, next_owner: &Arc<AtomicU64>) -> Self {
        services
            .lock()
            .unwrap()
            .lifetimes
            .entry(TEST_LIFETIME.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(true)));
        // Use the actual cross-platform endpoint and codec, with independent
        // connection-ID spaces as two different App Server processes would have.
        #[cfg(unix)]
        let temporary = tempfile::tempdir_in("/tmp").unwrap();
        #[cfg(windows)]
        let temporary = tempfile::tempdir().unwrap();
        let directory = SocketDirectory::create(&temporary.path().join("socket")).unwrap();
        let listener = directory.bind(Path::new(SOCKET)).unwrap();
        let stream = connect(&directory).unwrap();
        let (accepted, _) = listener.accept().unwrap();
        validate_peer(&accepted).unwrap();
        let services = Arc::clone(services);
        let next_owner = Arc::clone(next_owner);
        let worker = thread::spawn(move || {
            serve(accepted, services, next_owner);
            drop(listener);
            drop(directory);
            drop(temporary);
        });
        let grant = Grant::for_environment(
            Dir::open_local(root).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([Permission::ExecuteCommands]),
        );
        let mut service =
            TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap();
        service.backend = TerminalBackend::Hosted(Client {
            stream: Mutex::new(BufReader::new(stream)),
            disconnected: AtomicBool::new(false),
            connection: None,
            authorizations: Mutex::default(),
        });
        Self {
            service: Some(service),
            grant,
            worker: Some(worker),
        }
    }

    fn service(&self) -> &TerminalService {
        self.service.as_ref().unwrap()
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        drop(self.service.take());
        self.worker.take().unwrap().join().unwrap();
    }
}

fn create(service: &TerminalService, lifecycle: TerminalLifecycle) -> TerminalCreateResult {
    create_owned(service, lifecycle, Some(TEST_LIFETIME))
}

fn create_owned(
    service: &TerminalService,
    lifecycle: TerminalLifecycle,
    lifetime: Option<&str>,
) -> TerminalCreateResult {
    service
        .create(
            1,
            TerminalCreateRequest {
                lifetime_token: lifetime.map(str::to_owned),
                auto_replies: vec![],
                rows: 24,
                cols: 80,
                profile: TerminalProfileSelection::Default,
                lifecycle,
                env: None,
                strict_env: None,
                cwd: None,
                execution: None,
            },
        )
        .unwrap()
}

fn attach(
    service: &TerminalService,
    id: &str,
    token: &str,
) -> Result<TerminalAttachResult, TerminalError> {
    service.attach(
        1,
        TerminalAttachRequest {
            lifetime_token: Some(TEST_LIFETIME.into()),
            terminal_id: id.into(),
            reconnect_token: token.into(),
            rows: 30,
            cols: 100,
        },
    )
}

fn wait_output(service: &TerminalService, id: &str, marker: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let read = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: id.into(),
                    after_sequence: 0,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        let bytes = read
            .chunks
            .into_iter()
            .flat_map(|chunk| chunk.data)
            .collect::<Vec<_>>();
        if bytes.windows(marker.len()).any(|value| value == marker) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "terminal did not produce expected output"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn host_retains_the_same_pty_across_app_server_connection_replacement() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let first = Peer::new(root.path(), &services, &next_owner);
    let created = create(first.service(), TerminalLifecycle::Reconnectable);
    // A quiet connection must not be mistaken for EOF by an inherited
    // nonblocking accepted socket.
    thread::sleep(Duration::from_millis(50));
    let id = &created.terminal_id;
    first
        .service()
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: id.clone(),
                data: "echo HOST_BEFORE\r".into(),
            },
        )
        .unwrap();
    wait_output(first.service(), id, b"HOST_BEFORE");
    let lease = created.reconnect.unwrap();
    assert_eq!(lease.reconnect_grace_period_millis, 0);
    let token = lease.reconnect_token;

    // This peer deliberately reuses the original connection ID. It receives no
    // authority over the old process merely by knowing its public terminal ID.
    let second = Peer::new(root.path(), &services, &next_owner);
    assert_eq!(
        second.service().process_info(1, id),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        attach(second.service(), id, &token),
        Err(TerminalError::Busy)
    );
    drop(first);
    for service in services.lock().unwrap().services.values() {
        let mut sessions = service.sessions.lock().unwrap();
        remove_expired_sessions(&mut sessions, Instant::now() + Duration::from_secs(86400));
        assert_eq!(sessions.len(), 1, "backend loss must not expire a live PTY");
    }
    assert_eq!(
        attach(second.service(), id, "invalid"),
        Err(TerminalError::AttachRejected)
    );
    let attached = attach(second.service(), id, &token).unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    assert_ne!(attached.reconnect.reconnect_token, token);
    second
        .service()
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: id.clone(),
                data: "echo HOST_AFTER\r".into(),
            },
        )
        .unwrap();
    wait_output(second.service(), id, b"HOST_AFTER");
    let info = second.service().process_info(1, id).unwrap();
    assert_eq!((info.rows, info.cols), (30, 100));
    assert_eq!(info.ready.pid, created.ready.pid);
    second.service().close_owner(1);
    assert_eq!(
        attach(second.service(), id, &token),
        Err(TerminalError::AttachRejected)
    );
    attach(second.service(), id, &attached.reconnect.reconnect_token).unwrap();
    second.service().close(1, id).unwrap();
    assert_eq!(second.service().active_count(), 0);
}

#[test]
fn host_scopes_teardown_and_revocation_to_the_actual_process_owner() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let first = Peer::new(root.path(), &services, &next_owner);
    let second = Peer::new(root.path(), &services, &next_owner);
    let created = create(first.service(), TerminalLifecycle::Reconnectable);
    let unrelated = create(second.service(), TerminalLifecycle::ConnectionOwned);
    let lease = first.service().detach(1, &created.terminal_id).unwrap();
    attach(
        second.service(),
        &created.terminal_id,
        &lease.reconnect_token,
    )
    .unwrap();
    // The old facade still has its grant proof after detach. Revoking it cannot
    // terminate a process that was transferred with a rotated credential.
    first.grant.revoke();
    first.service().terminate_revoked_dirs();
    first.service().terminate_all();
    assert_eq!(second.service().active_count(), 2);
    assert_eq!(
        second
            .service()
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    assert_eq!(
        second
            .service()
            .process_info(1, &unrelated.terminal_id)
            .unwrap()
            .ready
            .pid,
        unrelated.ready.pid
    );
    second.service().terminate_all();
    assert_eq!(second.service().active_count(), 0);
}

#[test]
fn host_retires_detached_revoked_processes_and_connection_owned_processes() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    let lease = peer.service().detach(1, &created.terminal_id).unwrap();
    peer.grant.revoke();
    peer.service().terminate_revoked_dirs();
    drop(peer);
    let next = Peer::new(root.path(), &services, &next_owner);
    assert_eq!(
        attach(next.service(), &created.terminal_id, &lease.reconnect_token),
        Err(TerminalError::NotFound)
    );
    let owned = create(next.service(), TerminalLifecycle::ConnectionOwned);
    drop(next);
    let next = Peer::new(root.path(), &services, &next_owner);
    assert_eq!(
        next.service().process_info(1, &owned.terminal_id),
        Err(TerminalError::NotFound)
    );
    assert!(
        services
            .lock()
            .unwrap()
            .services
            .values()
            .all(|service| service.active_count() == 0)
    );
}

#[test]
fn host_rejects_cross_root_reattachment() {
    let root = tempfile::tempdir().unwrap();
    let other_root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    let lease = peer.service().detach(1, &created.terminal_id).unwrap();
    let other = Peer::new(other_root.path(), &services, &next_owner);
    assert_eq!(
        attach(
            other.service(),
            &created.terminal_id,
            &lease.reconnect_token
        ),
        Err(TerminalError::AttachRejected)
    );
    attach(peer.service(), &created.terminal_id, &lease.reconnect_token).unwrap();
    peer.service().close(1, &created.terminal_id).unwrap();
}

#[test]
fn host_reattachment_retains_the_current_session_directory_revocation_proof() {
    let root = tempfile::tempdir().unwrap();
    let session_root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let grant = Grant::for_environment(
        Dir::open_local(session_root.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ExecuteCommands]),
    );
    let proof = grant.authorize(Permission::ExecuteCommands).unwrap();
    let mut params = TerminalCreateRequest {
        lifetime_token: Some(TEST_LIFETIME.into()),
        auto_replies: vec![],
        rows: 24,
        cols: 80,
        profile: TerminalProfileSelection::Default,
        lifecycle: TerminalLifecycle::Reconnectable,
        env: None,
        strict_env: None,
        cwd: None,
        execution: None,
    };
    // The process is in a Session directory rather than its selected workspace.
    params.cwd = Some(proof.dir().canonical_path().into());
    let created = peer
        .service()
        .create_in_dir(1, params, proof.clone())
        .unwrap();
    let token = created.reconnect.unwrap().reconnect_token;
    drop(peer);
    let next = Peer::new(root.path(), &services, &next_owner);
    let request = TerminalAttachRequest {
        lifetime_token: Some(TEST_LIFETIME.into()),
        terminal_id: created.terminal_id.clone(),
        reconnect_token: token,
        rows: 24,
        cols: 80,
    };
    assert_eq!(
        next.service()
            .attach_in_dir(1, request.clone(), next.service().host_authorization()),
        Err(TerminalError::AttachRejected)
    );
    let attached = next
        .service()
        .attach_in_dir(1, request.clone(), proof)
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    grant.revoke();
    assert_eq!(
        next.service().process_info(1, &created.terminal_id),
        Err(TerminalError::OperationFailed)
    );
    next.service().terminate_revoked_dirs();
    assert_eq!(next.service().active_count(), 0);
}

#[test]
fn transferred_credential_history_cannot_obstruct_revoking_a_live_process() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let source = Peer::new(root.path(), &services, &next_owner);
    let target = Peer::new(root.path(), &services, &next_owner);
    for _ in 0..MAX_ACTIVE_TERMINALS {
        let created = create(source.service(), TerminalLifecycle::Reconnectable);
        let lease = source.service().detach(1, &created.terminal_id).unwrap();
        attach(
            target.service(),
            &created.terminal_id,
            &lease.reconnect_token,
        )
        .unwrap();
        target.service().close(1, &created.terminal_id).unwrap();
    }
    let live = create(source.service(), TerminalLifecycle::Reconnectable);
    source.service().detach(1, &live.terminal_id).unwrap();
    source.grant.revoke();
    source.service().terminate_revoked_dirs();
    assert_eq!(source.service().active_count(), 0);
}

#[test]
fn retired_connection_id_history_cannot_exhaust_or_reassign_live_process_authority() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    for owner in 2..(MAX_OWNERS_PER_PEER as u64 * 2) {
        assert_eq!(
            peer.service().process_info(owner, &created.terminal_id),
            Err(TerminalError::NotOwner)
        );
    }
    assert_eq!(
        peer.service()
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    peer.service().close(1, &created.terminal_id).unwrap();
}

#[test]
fn input_backpressure_leaves_the_host_available_for_output_and_explicit_close() {
    for binary in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let services = Services::default();
        let next_owner = Arc::new(AtomicU64::new(1));
        let peer = Peer::new(root.path(), &services, &next_owner);
        let created = create(peer.service(), TerminalLifecycle::ConnectionOwned);
        let process = {
            let services = services.lock().unwrap();
            let sessions = services
                .services
                .values()
                .next()
                .unwrap()
                .sessions
                .lock()
                .unwrap();
            Arc::clone(&sessions[&created.terminal_id].process)
        };
        // Reserve the real PTY writer's capacity without admitting any bytes.
        // This exercises transport contention with a deterministically full queue.
        let mut permits = Vec::new();
        loop {
            match process.writer_sender().try_reserve_owned() {
                Ok(permit) => permits.push(permit),
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => break,
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    panic!("PTY input unexpectedly closed")
                }
            }
        }
        assert!(!permits.is_empty());
        thread::scope(|scope| {
            let (started, starting) = std::sync::mpsc::channel();
            let (completed, completion) = std::sync::mpsc::channel();
            let service = peer.service();
            let id = &created.terminal_id;
            scope.spawn(move || {
                started.send(()).unwrap();
                let result = if binary {
                    service.write_binary(
                        1,
                        TerminalWriteBinaryRequest {
                            terminal_id: id.clone(),
                            data: vec![0, 255, 3],
                        },
                    )
                } else {
                    service.write(
                        1,
                        TerminalWriteRequest {
                            terminal_id: id.clone(),
                            data: "pending input".into(),
                        },
                    )
                };
                completed.send(result).unwrap();
            });
            starting.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                completion.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            );
            let read = service
                .read(
                    1,
                    TerminalReadRequest {
                        terminal_id: id.clone(),
                        after_sequence: 0,
                        after_command_sequence: 0,
                        max_chunks: 128,
                    },
                )
                .unwrap();
            assert_eq!(read.terminal_id, *id);
            service.close(1, id).unwrap();
            assert_eq!(
                completion.recv_timeout(Duration::from_secs(5)).unwrap(),
                Err(TerminalError::NotFound)
            );
        });
        drop(permits);
        assert_eq!(peer.service().active_count(), 0);
    }
}

#[test]
fn terminal_replay_survives_binary_json_expansion_with_a_bounded_wire_frame() {
    let replay = TerminalReadResult {
        terminal_id: "terminal-replay".into(),
        chunks: (1..=128)
            .map(|sequence| TerminalOutputChunk {
                sequence,
                data: vec![255; 8192],
                shell_integration: None,
            })
            .collect(),
        next_sequence: 128,
        output_gap: false,
        command_events: vec![],
        next_command_sequence: 0,
        command_event_gap: false,
        exited: false,
        exit_code: None,
        cwd: None,
        shell_integration: None,
    };
    let response: Reply = Ok(Response::Read(replay.clone()));
    let mut encoded = Vec::new();
    write_frame(&mut encoded, &response).unwrap();
    assert!(encoded.len() > exec_server_protocol::MAX_FRAME_BYTES);
    assert!(encoded.len() < MAX_FRAME_BYTES);
    let decoded: Result<TerminalReadResult, TerminalError> =
        read_frame(&mut std::io::Cursor::new(encoded)).unwrap();
    assert_eq!(decoded.unwrap(), replay);
    let mut oversized = Vec::new();
    assert!(write_frame(&mut oversized, &"x".repeat(MAX_FRAME_BYTES)).is_err());
    assert!(
        oversized.is_empty(),
        "oversized frames must be rejected before publishing bytes"
    );
}

#[test]
fn lost_mutation_responses_are_not_replayed_but_configuration_can_reconnect() {
    for create in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let socket_directory = directory(profile.path()).unwrap();
        let listener = socket_directory.bind(Path::new(SOCKET)).unwrap();
        let worker = thread::spawn(move || {
            let (first, _) = listener.accept().unwrap();
            first.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
            let mut first = BufReader::new(first);
            assert!(matches!(
                read_frame::<Request>(&mut first).unwrap().operation,
                Operation::Ping
            ));
            write_frame(first.get_mut(), &Ok::<_, TerminalError>(Response::Unit)).unwrap();
            let mutation = read_frame::<Request>(&mut first).unwrap();
            assert!(matches!(
                mutation.operation,
                Operation::Create { .. } | Operation::Write(_)
            ));
            // The mutation committed, but its acknowledgement is lost.
            drop(first);
            let (second, _) = listener.accept().unwrap();
            second.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
            let mut second = BufReader::new(second);
            assert!(matches!(
                read_frame::<Request>(&mut second).unwrap().operation,
                Operation::Ping
            ));
            write_frame(second.get_mut(), &Ok::<_, TerminalError>(Response::Unit)).unwrap();
            assert!(
                matches!(
                    read_frame::<Request>(&mut second).unwrap().operation,
                    Operation::Environment(_)
                ),
                "the committed mutation must not be repeated on the replacement connection"
            );
            write_frame(
                second.get_mut(),
                &Ok::<_, TerminalError>(Response::Environment(HashMap::from([(
                    "HOST_TEST".into(),
                    "ready".into(),
                )]))),
            )
            .unwrap();
        });
        let client = Client::connect(profile.path(), Path::new("/unused-test-backend")).unwrap();
        let proof = authorization(profile.path()).unwrap();
        let result = if create {
            client
                .request::<TerminalCreateResult>(
                    &proof,
                    1,
                    Operation::Create {
                        root: proof.dir().canonical_path().into(),
                        params: TerminalCreateRequest {
                            lifetime_token: Some(TEST_LIFETIME.into()),
                            auto_replies: vec![],
                            rows: 24,
                            cols: 80,
                            profile: TerminalProfileSelection::Default,
                            lifecycle: TerminalLifecycle::ConnectionOwned,
                            env: None,
                            strict_env: None,
                            cwd: None,
                            execution: None,
                        },
                    },
                )
                .map(|_| ())
        } else {
            client.write(
                &proof,
                1,
                TerminalWriteRequest {
                    terminal_id: "terminal-once".into(),
                    data: "run once".into(),
                },
            )
        };
        assert_eq!(result, Err(TerminalError::OperationFailed));
        assert!(client.disconnected.load(Ordering::Acquire));
        let environment: HashMap<String, String> = client
            .request(&proof, 1, Operation::Environment(None))
            .unwrap();
        assert_eq!(environment.get("HOST_TEST").unwrap(), "ready");
        drop(client);
        worker.join().unwrap();
        #[cfg(unix)]
        socket_directory.remove_socket(Path::new(SOCKET)).unwrap();
        std::fs::remove_file(socket_directory.path().join("startup.lock")).unwrap();
        let path = socket_directory.path().to_path_buf();
        drop(socket_directory);
        std::fs::remove_dir(path).unwrap();
    }
}

#[test]
fn retiring_a_known_process_allows_cleanup_without_hiding_wrong_owner_errors() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    assert_eq!(
        peer.service().close(2, &created.terminal_id),
        Err(TerminalError::NotOwner)
    );
    {
        let services = services.lock().unwrap();
        let service = services.services.values().next().unwrap();
        let owner = match service.sessions.lock().unwrap()[&created.terminal_id].owner {
            TerminalOwner::Attached(owner) => owner,
            TerminalOwner::Detached { .. } | TerminalOwner::Disconnected { .. } => {
                panic!("test process unexpectedly detached")
            }
        };
        service.close(owner, &created.terminal_id).unwrap();
    }
    peer.service().close(1, &created.terminal_id).unwrap();
    assert_eq!(
        peer.service().close(1, "never-owned"),
        Err(TerminalError::NotFound)
    );
    assert_eq!(peer.service().active_count(), 0);
}

#[test]
fn session_directory_restore_order_does_not_change_the_original_pty_owner() {
    let original_default = tempfile::tempdir().unwrap();
    let session_directory = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let first = Peer::new(original_default.path(), &services, &next_owner);
    let grant = Grant::for_environment(
        Dir::open_local(session_directory.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ExecuteCommands]),
    );
    let proof = grant.authorize(Permission::ExecuteCommands).unwrap();
    let created = first
        .service()
        .create_in_dir(
            1,
            TerminalCreateRequest {
                lifetime_token: Some(TEST_LIFETIME.into()),
                auto_replies: vec![],
                rows: 24,
                cols: 80,
                profile: TerminalProfileSelection::Default,
                lifecycle: TerminalLifecycle::Reconnectable,
                env: None,
                strict_env: None,
                cwd: None,
                execution: None,
            },
            proof.clone(),
        )
        .unwrap();
    let token = created.reconnect.unwrap().reconnect_token;
    drop(first);
    // A projectless backend can encounter this Session directory first after
    // restart, instead of the default directory used by its previous service.
    let restored = Peer::new(session_directory.path(), &services, &next_owner);
    let attached = restored
        .service()
        .attach_in_dir(
            1,
            TerminalAttachRequest {
                lifetime_token: Some(TEST_LIFETIME.into()),
                terminal_id: created.terminal_id.clone(),
                reconnect_token: token,
                rows: 30,
                cols: 100,
            },
            proof,
        )
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    assert_eq!(restored.service().active_count(), 1);
    assert_eq!(
        restored
            .service()
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    restored
        .service()
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "echo RESTORED_SESSION\r".into(),
            },
        )
        .unwrap();
    wait_output(
        restored.service(),
        &created.terminal_id,
        b"RESTORED_SESSION",
    );
    restored.service().close_owner(1);
    assert!(services.lock().unwrap().services.values().any(|service| {
        matches!(
            service
                .sessions
                .lock()
                .unwrap()
                .get(&created.terminal_id)
                .map(|session| session.owner),
            Some(TerminalOwner::Disconnected { .. })
        )
    }));
    let attached = restored
        .service()
        .attach_in_dir(
            1,
            TerminalAttachRequest {
                lifetime_token: Some(TEST_LIFETIME.into()),
                terminal_id: created.terminal_id.clone(),
                reconnect_token: attached.reconnect.reconnect_token,
                rows: 30,
                cols: 100,
            },
            grant.authorize(Permission::ExecuteCommands).unwrap(),
        )
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    grant.revoke();
    restored.service().terminate_revoked_dirs();
    assert_eq!(restored.service().active_count(), 0);
}

#[test]
fn persistent_host_handoffs_still_expire_and_exited_orphans_are_reclaimed() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let next_owner = Arc::new(AtomicU64::new(1));
    let peer = Peer::new(root.path(), &services, &next_owner);
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    let lease = peer.service().detach(1, &created.terminal_id).unwrap();
    assert_eq!(
        lease.reconnect_grace_period_millis,
        RECONNECT_GRACE_PERIOD_MILLIS
    );
    for service in services.lock().unwrap().services.values() {
        remove_expired_sessions(
            &mut service.sessions.lock().unwrap(),
            Instant::now() + RECONNECT_GRACE_PERIOD,
        );
        assert!(service.sessions.lock().unwrap().is_empty());
    }
    let created = create(peer.service(), TerminalLifecycle::Reconnectable);
    peer.service()
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "exit\r".into(),
            },
        )
        .unwrap();
    drop(peer);
    let service = services
        .lock()
        .unwrap()
        .services
        .values()
        .next()
        .unwrap()
        .clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if service.sessions.lock().unwrap()[&created.terminal_id]
            .state
            .lock()
            .unwrap()
            .exited
        {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let now = Instant::now();
    let mut sessions = service.sessions.lock().unwrap();
    remove_expired_sessions(&mut sessions, now);
    assert_eq!(
        sessions.len(),
        1,
        "retain final output for immediate recovery"
    );
    remove_expired_sessions(&mut sessions, now + RECONNECT_GRACE_PERIOD);
    assert!(sessions.is_empty());
}

fn register_guard(peer: &Peer, token: &str) -> Result<(), TerminalError> {
    match &peer.service().backend {
        TerminalBackend::Hosted(client) => {
            client.unchecked(Path::new(""), 0, Operation::Guard(token.into()))
        }
        TerminalBackend::Local(_) => unreachable!("fixture must use the hosted transport"),
    }
}

#[test]
fn window_eof_reclaims_attached_and_backend_disconnected_processes_without_touching_other_windows()
{
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let owners = Arc::new(AtomicU64::new(1));
    let first_guard = Peer::new(root.path(), &services, &owners);
    let second_guard = Peer::new(root.path(), &services, &owners);
    let first_token = "b".repeat(64);
    let second_token = "c".repeat(64);
    register_guard(&first_guard, &first_token).unwrap();
    register_guard(&second_guard, &second_token).unwrap();
    let first = Peer::new(root.path(), &services, &owners);
    let disconnected = Peer::new(root.path(), &services, &owners);
    let second = Peer::new(root.path(), &services, &owners);
    let a = create_owned(
        first.service(),
        TerminalLifecycle::Reconnectable,
        Some(&first_token),
    );
    let b = create_owned(
        disconnected.service(),
        TerminalLifecycle::Reconnectable,
        Some(&first_token),
    );
    let c = create_owned(
        second.service(),
        TerminalLifecycle::Reconnectable,
        Some(&second_token),
    );
    drop(disconnected);
    drop(first_guard);
    assert_eq!(
        first.service().process_info(1, &a.terminal_id),
        Err(TerminalError::NotFound)
    );
    let retained = services
        .lock()
        .unwrap()
        .services
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(
        !retained
            .sessions
            .lock()
            .unwrap()
            .contains_key(&b.terminal_id)
    );
    assert_eq!(
        second
            .service()
            .process_info(1, &c.terminal_id)
            .unwrap()
            .ready
            .pid,
        c.ready.pid
    );
    drop(second_guard);
    assert_eq!(
        second.service().process_info(1, &c.terminal_id),
        Err(TerminalError::NotFound)
    );
}

#[test]
fn offered_handoffs_outlive_the_source_window_and_adopt_the_target_window_lifetime() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let owners = Arc::new(AtomicU64::new(1));
    let source_guard = Peer::new(root.path(), &services, &owners);
    let target_guard = Peer::new(root.path(), &services, &owners);
    let source_token = "b".repeat(64);
    let target_token = "c".repeat(64);
    register_guard(&source_guard, &source_token).unwrap();
    register_guard(&target_guard, &target_token).unwrap();
    let source = Peer::new(root.path(), &services, &owners);
    let target = Peer::new(root.path(), &services, &owners);
    let created = create_owned(
        source.service(),
        TerminalLifecycle::Reconnectable,
        Some(&source_token),
    );
    let lease = source.service().detach(1, &created.terminal_id).unwrap();
    drop(source_guard);
    let attached = target
        .service()
        .attach(
            1,
            TerminalAttachRequest {
                lifetime_token: Some(target_token),
                terminal_id: created.terminal_id.clone(),
                reconnect_token: lease.reconnect_token,
                rows: 24,
                cols: 80,
            },
        )
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    assert_eq!(attached.reconnect.reconnect_grace_period_millis, 0);
    drop(source);
    assert_eq!(
        target
            .service()
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    drop(target_guard);
    assert_eq!(
        target.service().process_info(1, &created.terminal_id),
        Err(TerminalError::NotFound)
    );
}

#[test]
fn duplicate_guards_cannot_displace_a_live_window_and_unguarded_processes_have_bounded_leases() {
    let root = tempfile::tempdir().unwrap();
    let services = Services::default();
    let owners = Arc::new(AtomicU64::new(1));
    let guard = Peer::new(root.path(), &services, &owners);
    let token = "b".repeat(64);
    register_guard(&guard, &token).unwrap();
    let duplicate = Peer::new(root.path(), &services, &owners);
    assert_eq!(
        register_guard(&duplicate, &token),
        Err(TerminalError::InvalidInput)
    );
    drop(duplicate);
    let peer = Peer::new(root.path(), &services, &owners);
    let a = create_owned(
        peer.service(),
        TerminalLifecycle::Reconnectable,
        Some(&token),
    );
    let b = create_owned(peer.service(), TerminalLifecycle::Reconnectable, None);
    assert_eq!(a.reconnect.unwrap().reconnect_grace_period_millis, 0);
    assert_eq!(
        b.reconnect.unwrap().reconnect_grace_period_millis,
        RECONNECT_GRACE_PERIOD_MILLIS
    );
    peer.service().close_owner(1);
    for service in services.lock().unwrap().services.values() {
        let mut sessions = service.sessions.lock().unwrap();
        remove_expired_sessions(&mut sessions, Instant::now() + RECONNECT_GRACE_PERIOD);
        assert!(sessions.contains_key(&a.terminal_id));
        assert!(!sessions.contains_key(&b.terminal_id));
    }
    drop(guard);
    assert_eq!(peer.service().active_count(), 0);
}
