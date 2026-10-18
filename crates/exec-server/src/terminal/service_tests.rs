use super::*;

#[test]
fn terminal_identities_are_unique_across_directories_and_runtime_recreation() {
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let first = terminal_service_for(first_root.path());
    let second = terminal_service_for(second_root.path());
    let request = terminal_request(TerminalLifecycle::ConnectionOwned);
    let first_terminal = first.create(1, request.clone()).unwrap();
    let second_terminal = second.create(1, request.clone()).unwrap();
    assert_ne!(first_terminal.terminal_id, second_terminal.terminal_id);
    first.close(1, &first_terminal.terminal_id).unwrap();
    second.close(1, &second_terminal.terminal_id).unwrap();
    drop(second);

    let replacement = terminal_service_for(second_root.path());
    let restored = replacement.create(1, request).unwrap();
    assert_ne!(second_terminal.terminal_id, restored.terminal_id);
    replacement.close(1, &restored.terminal_id).unwrap();
}

#[test]
fn revoked_directory_terminates_detached_sessions_and_rejects_new_work() {
    let root = tempfile::tempdir().unwrap();
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(root.path()).unwrap(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([Permission::ExecuteCommands]),
    );
    let service =
        TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap();
    let request = TerminalCreateRequest {
        strict_env: None,
        env: None,
        cwd: None,
        execution: None,
        rows: 24,
        cols: 80,
        profile: TerminalProfileSelection::Default,
        lifecycle: TerminalLifecycle::Reconnectable,
    };
    let created = service.create(1, request.clone()).unwrap();
    service.close_owner(1);
    assert_eq!(service.active_count(), 1);

    grant.revoke();
    service.terminate_revoked_dirs();
    assert_eq!(service.active_count(), 0);
    assert_eq!(
        service.create(2, request),
        Err(TerminalError::OperationFailed)
    );
    assert_eq!(
        service.attach(
            2,
            TerminalAttachRequest {
                terminal_id: created.terminal_id,
                reconnect_token: created.reconnect.unwrap().reconnect_token,
                rows: 24,
                cols: 80,
            }
        ),
        Err(TerminalError::OperationFailed),
    );
}

#[test]
fn explicit_handoff_revokes_live_owner_preserves_pid_and_rotates_credentials() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::Reconnectable))
        .unwrap();
    let identity = &created.terminal_id;
    assert_eq!(service.detach(2, identity), Err(TerminalError::NotOwner));
    let handoff = service.detach(1, identity).unwrap();
    assert_ne!(
        handoff.reconnect_token,
        created.reconnect.unwrap().reconnect_token
    );
    assert_eq!(service.detach(1, identity), Err(TerminalError::NotOwner));
    assert_eq!(
        service.write(
            1,
            TerminalWriteRequest {
                terminal_id: identity.clone(),
                data: "echo forbidden\n".into(),
            }
        ),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        service.read(
            1,
            TerminalReadRequest {
                terminal_id: identity.clone(),
                after_sequence: 0,
                after_command_sequence: 0,
                max_chunks: 1,
            }
        ),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(service.close(1, identity), Err(TerminalError::NotOwner));
    // Closing the still-live source connection cannot kill the offered process.
    service.close_owner(1);
    let attached = service
        .attach(
            2,
            TerminalAttachRequest {
                terminal_id: identity.clone(),
                reconnect_token: handoff.reconnect_token.clone(),
                rows: 30,
                cols: 100,
            },
        )
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    assert_ne!(attached.reconnect.reconnect_token, handoff.reconnect_token);
    service.close_owner(2);
    assert_eq!(
        service.attach(
            1,
            TerminalAttachRequest {
                terminal_id: identity.clone(),
                reconnect_token: handoff.reconnect_token,
                rows: 24,
                cols: 80,
            }
        ),
        Err(TerminalError::AttachRejected)
    );
    service
        .attach(
            2,
            TerminalAttachRequest {
                terminal_id: identity.clone(),
                reconnect_token: attached.reconnect.reconnect_token,
                rows: 24,
                cols: 80,
            },
        )
        .unwrap();
    service.close(2, identity).unwrap();
}

#[test]
fn cancelled_handoff_can_be_reclaimed_and_expired_handoff_is_terminated() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    let handoff = service.detach(1, &created.terminal_id).unwrap();
    let restored = service
        .attach(
            1,
            TerminalAttachRequest {
                terminal_id: created.terminal_id.clone(),
                reconnect_token: handoff.reconnect_token,
                rows: 24,
                cols: 80,
            },
        )
        .unwrap();
    assert_eq!(restored.ready.pid, created.ready.pid);
    service.detach(1, &created.terminal_id).unwrap();
    {
        let mut sessions = service.sessions.lock().unwrap();
        remove_expired_sessions(&mut sessions, Instant::now() + RECONNECT_GRACE_PERIOD);
        assert!(sessions.is_empty());
    }
    assert_eq!(service.active_count(), 0);
}

#[test]
fn output_preserves_binary_bytes_across_cursor_reads() {
    let mut state = TerminalState::default();
    push_output(&mut state, vec![0xff, 0, 0xe2]);
    push_output(&mut state, vec![0x82, 0xac]);
    let mut request = TerminalReadRequest {
        terminal_id: "terminal-1".into(),
        after_sequence: 0,
        after_command_sequence: 0,
        max_chunks: 1,
    };

    let first = read_state(&request, &state);
    assert_eq!(first.chunks[0].data, [0xff, 0, 0xe2]);
    request.after_sequence = first.next_sequence;
    let second = read_state(&request, &state);
    assert_eq!(second.chunks[0].data, [0x82, 0xac]);
    assert_eq!(second.next_sequence, 2);
    assert!(!second.output_gap);
}

#[test]
fn output_ring_reports_a_gap_after_eviction() {
    let mut state = TerminalState::default();
    for _ in 0..3 {
        push_output(&mut state, vec![b'x'; MAX_OUTPUT_BYTES / 2]);
    }

    let result = read_state(
        &TerminalReadRequest {
            terminal_id: "terminal-1".into(),
            after_sequence: 0,
            after_command_sequence: 0,
            max_chunks: 128,
        },
        &state,
    );

    assert!(result.output_gap);
    assert_eq!(result.chunks.len(), 2);
    assert_eq!(result.chunks[0].sequence, 2);
    assert_eq!(result.next_sequence, 3);
}

#[test]
fn output_ring_advances_the_cursor_when_one_oversized_chunk_is_evicted() {
    let mut state = TerminalState::default();
    push_output(&mut state, vec![b'x'; MAX_OUTPUT_BYTES + 1]);

    let result = read_state(
        &TerminalReadRequest {
            terminal_id: "terminal-1".into(),
            after_sequence: 0,
            after_command_sequence: 0,
            max_chunks: 128,
        },
        &state,
    );

    assert!(result.output_gap);
    assert!(result.chunks.is_empty());
    assert_eq!(result.next_sequence, 1);
}

#[cfg(unix)]
#[test]
fn slow_terminal_consumer_retains_every_output_byte() {
    use sha2::Digest;

    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.execution = Some(TerminalExecution::Process {
        program: "/bin/sh".into(),
        args: TerminalArguments::Argv(vec![
            "-c".into(),
            "printf ready > producer-ready; awk 'BEGIN { for (i=0; i<60000; i++) printf \"ROW:%06d abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n\", i }'".into(),
        ]),
    });
    let created = service.create(1, request).unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("producer-ready").exists() {
        assert!(Instant::now() < ready_deadline, "producer did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    // Deliberately stop consumption, then emulate a screen committing one page at a time.
    std::thread::sleep(Duration::from_millis(250));
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = Vec::new();
    let mut sequence = 0;
    let mut command_sequence = 0;
    loop {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: created.terminal_id.clone(),
                    after_sequence: sequence,
                    after_command_sequence: command_sequence,
                    max_chunks: 1,
                },
            )
            .unwrap();
        assert!(!result.output_gap, "unconsumed terminal output was evicted");
        sequence = result.next_sequence;
        command_sequence = result.next_command_sequence;
        let complete = result.exited && result.chunks.is_empty();
        output.extend(result.chunks.into_iter().flat_map(|chunk| chunk.data));
        if complete {
            assert_eq!(result.exit_code, Some(0));
            break;
        }
        assert!(Instant::now() < deadline, "slow consumer did not finish");
        std::thread::sleep(Duration::from_millis(2));
    }
    let actual = output
        .into_iter()
        .filter(|byte| *byte != b'\r')
        .collect::<Vec<_>>();
    let expected = (0..60000)
        .map(|index| {
            format!(
                "ROW:{index:06} abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n"
            )
        })
        .collect::<String>();
    assert_eq!(actual.len(), expected.len());
    assert_eq!(
        sha2::Sha256::digest(&actual),
        sha2::Sha256::digest(expected.as_bytes())
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn removing_a_backpressured_terminal_releases_its_process_and_drainer() {
    enum Removal {
        Close,
        ConnectionClosed,
        Shutdown,
        LeaseExpired,
        GrantRevoked,
    }

    for removal in [
        Removal::Close,
        Removal::ConnectionClosed,
        Removal::Shutdown,
        Removal::LeaseExpired,
        Removal::GrantRevoked,
    ] {
        let root = tempfile::tempdir().unwrap();
        let grant = ash_file_access::Grant::for_environment(
            ash_file_access::Dir::open_local(root.path()).unwrap(),
            ash_file_access::GrantSource::HostConfiguration,
            ash_file_access::Permissions::new([Permission::ExecuteCommands]),
        );
        let service =
            TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap();
        let lifecycle = match removal {
            Removal::LeaseExpired => TerminalLifecycle::Reconnectable,
            Removal::Close
            | Removal::ConnectionClosed
            | Removal::Shutdown
            | Removal::GrantRevoked => TerminalLifecycle::ConnectionOwned,
        };
        let mut request = terminal_request(lifecycle);
        request.execution = Some(TerminalExecution::Process {
            program: "/bin/sh".into(),
            args: TerminalArguments::Argv(vec![
                "-c".into(),
                "exec awk 'BEGIN { while (1) print \"abcdefghijklmnopqrstuvwxyz0123456789\" }'"
                    .into(),
            ]),
        });
        let created = service.create(1, request).unwrap();
        let (state, process) = {
            let sessions = service.sessions.lock().unwrap();
            let session = sessions.get(&created.terminal_id).unwrap();
            (Arc::downgrade(&session.state), session.process.clone())
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let full =
                state.upgrade().unwrap().lock().unwrap().output_bytes >= OUTPUT_HIGH_WATER_BYTES;
            if full {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "producer did not reach backpressure"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!process.has_exited());
        match removal {
            Removal::Close => service.close(1, &created.terminal_id).unwrap(),
            Removal::ConnectionClosed => service.close_owner(1),
            Removal::Shutdown => service.terminate_all(),
            Removal::LeaseExpired => {
                service.close_owner(1);
                remove_expired_sessions(
                    &mut service.sessions.lock().unwrap(),
                    Instant::now() + RECONNECT_GRACE_PERIOD,
                );
            }
            Removal::GrantRevoked => {
                grant.revoke();
                service.terminate_revoked_dirs();
            }
        }
        assert_eq!(service.active_count(), 0);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process.has_exited() || state.upgrade().is_some() {
            assert!(
                Instant::now() < deadline,
                "removed terminal retained its producer or output drainer"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
#[test]
fn backpressure_is_isolated_and_a_detached_producer_resumes_after_attach() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::Reconnectable);
    request.execution = Some(TerminalExecution::Process {
        program: "/bin/sh".into(),
        args: TerminalArguments::Argv(vec![
            "-c".into(),
            "exec awk 'BEGIN { while (1) print \"abcdefghijklmnopqrstuvwxyz0123456789\" }'".into(),
        ]),
    });
    let created = service.create(1, request).unwrap();
    let state = service.sessions.lock().unwrap()[&created.terminal_id]
        .state
        .clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if state.lock().unwrap().output_bytes >= OUTPUT_HIGH_WATER_BYTES {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    // No acknowledgement: the bounded drainer must remain paused, rather than
    // evicting unread bytes or occupying the runtime's other worker.
    std::thread::sleep(Duration::from_millis(30));
    let paused_sequence = state.lock().unwrap().next_sequence;
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(state.lock().unwrap().next_sequence, paused_sequence);
    assert!(state.lock().unwrap().output_bytes <= MAX_OUTPUT_BYTES);

    let mut other = terminal_request(TerminalLifecycle::ConnectionOwned);
    other.execution = Some(TerminalExecution::Process {
        program: "/bin/sh".into(),
        args: TerminalArguments::Argv(vec!["-c".into(), "printf 'OTHER_ALIVE\\n'".into()]),
    });
    let other = service.create(1, other).unwrap();
    read_until(&service, &other.terminal_id, "OTHER_ALIVE\r\n");
    service.close(1, &other.terminal_id).unwrap();

    service.close_owner(1);
    let attached = service
        .attach(
            2,
            TerminalAttachRequest {
                terminal_id: created.terminal_id.clone(),
                reconnect_token: created.reconnect.unwrap().reconnect_token,
                rows: 24,
                cols: 80,
            },
        )
        .unwrap();
    assert_eq!(attached.ready.pid, created.ready.pid);
    let mut request = TerminalReadRequest {
        terminal_id: created.terminal_id.clone(),
        after_sequence: 0,
        after_command_sequence: 0,
        max_chunks: 128,
    };
    let pending = service.read(2, request.clone()).unwrap();
    assert!(!pending.output_gap);
    assert!(!pending.chunks.is_empty());
    // Merely returning output does not acknowledge consumption or resume reads.
    assert_eq!(state.lock().unwrap().acknowledged_sequence, 0);
    request.after_sequence = pending.next_sequence;
    service.read(2, request.clone()).unwrap();
    let committed = state.lock().unwrap().acknowledged_sequence;
    request.after_sequence = 0;
    service.read(2, request).unwrap();
    assert_eq!(state.lock().unwrap().acknowledged_sequence, committed);
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.lock().unwrap().next_sequence <= paused_sequence {
        assert!(
            Instant::now() < deadline,
            "reattached producer did not resume"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Control requests must not wait behind a producer's full output queue.
    service
        .send_signal(2, &created.terminal_id, TerminalSignal::Interrupt)
        .unwrap();
    let mut sequence = committed;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = service
            .read(
                2,
                TerminalReadRequest {
                    terminal_id: created.terminal_id.clone(),
                    after_sequence: sequence,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        assert!(!result.output_gap);
        sequence = result.next_sequence;
        if result.exited && result.chunks.is_empty() {
            assert_ne!(result.exit_code, Some(0));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "interrupt did not finish the producer"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    service.close(2, &created.terminal_id).unwrap();
}

#[test]
fn terminal_size_and_input_limits_are_explicit() {
    assert_eq!(validate_size(0, 80), Err(TerminalError::InvalidInput));
    assert_eq!(validate_size(24, 0), Err(TerminalError::InvalidInput));
    assert_eq!(validate_size(512, 512), Ok(()));
    assert_eq!(validate_size(513, 80), Err(TerminalError::InvalidInput));
}

#[test]
fn process_is_not_terminal_until_output_has_closed() {
    let mut state = TerminalState {
        exit_code: Some(0),
        ..TerminalState::default()
    };
    state.exited = state.output_closed;
    assert!(!state.exited);

    state.output_closed = true;
    state.exited = state.exit_code.is_some();
    assert!(state.exited);
}

#[test]
fn terminal_process_properties_follow_resize_and_reject_other_connections() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::Reconnectable))
        .unwrap();
    assert!(created.ready.pid > 0);
    // Windows process paths can omit the extended-length prefix. The terminal
    // must still start in the exact filesystem directory that was authorized.
    assert_eq!(
        std::path::Path::new(&created.ready.cwd)
            .canonicalize()
            .unwrap(),
        root.path().canonicalize().unwrap()
    );
    assert_eq!(
        service.process_info(2, &created.terminal_id),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        service.send_signal(2, &created.terminal_id, TerminalSignal::Interrupt),
        Err(TerminalError::NotOwner)
    );
    assert_eq!(
        service.write_binary(
            2,
            TerminalWriteBinaryRequest {
                terminal_id: created.terminal_id.clone(),
                data: vec![0xff]
            }
        ),
        Err(TerminalError::NotOwner)
    );
    for data in [vec![], vec![0xff; MAX_INPUT_BYTES + 1]] {
        assert_eq!(
            service.write_binary(
                1,
                TerminalWriteBinaryRequest {
                    terminal_id: created.terminal_id.clone(),
                    data
                }
            ),
            Err(TerminalError::InvalidInput)
        );
    }
    service
        .resize(
            1,
            TerminalResizeRequest {
                terminal_id: created.terminal_id.clone(),
                rows: 40,
                cols: 120,
            },
        )
        .unwrap();
    let info = service.process_info(1, &created.terminal_id).unwrap();
    assert_eq!((info.rows, info.cols), (40, 120));
    assert_eq!(info.ready, created.ready);
    service.close_owner(1);
    let attached = service
        .attach(
            2,
            TerminalAttachRequest {
                terminal_id: created.terminal_id.clone(),
                reconnect_token: created.reconnect.unwrap().reconnect_token,
                rows: 25,
                cols: 90,
            },
        )
        .unwrap();
    assert_eq!(attached.ready, created.ready);
    let info = service.process_info(2, &created.terminal_id).unwrap();
    assert_eq!((info.rows, info.cols), (25, 90));
    service.close(2, &created.terminal_id).unwrap();
    assert_eq!(
        service.process_info(2, &created.terminal_id),
        Err(TerminalError::NotFound)
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn terminal_reports_shell_pid_and_real_cwd_after_cd() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("changed")).unwrap();
    let service = terminal_service_for(root.path());
    // Cwd metadata requires shell integration; the user's default may be sh or fish.
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.profile = TerminalProfileSelection::Profile {
        profile_id: "bash".into(),
    };
    let created = service.create(1, request).unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "cd changed; printf '\\nROOT_PID:%s\\nCWD_READY\\n' \"$$\"\n".into(),
            },
        )
        .unwrap();
    let output = read_until(&service, &created.terminal_id, "CWD_READY\r\n");
    assert!(
        String::from_utf8_lossy(&output).contains(&format!("ROOT_PID:{}\r\n", created.ready.pid))
    );
    wait_shell_cwd(
        &service,
        &created.terminal_id,
        root.path()
            .join("changed")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap(),
    );
    assert_eq!(
        service.process_info(1, &created.terminal_id).unwrap().cwd,
        Some(
            root.path()
                .join("changed")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        )
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn terminal_binary_input_preserves_nul_and_non_utf8_bytes() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    service.write(1, TerminalWriteRequest { terminal_id: created.terminal_id.clone(), data: "stty -echo -icanon min 1 time 0; printf '\\nRAW_READY\\n'; dd bs=1 count=3 2>/dev/null | od -An -tx1; stty sane; printf '\\nRAW_DONE\\n'\n".into() }).unwrap();
    read_until(&service, &created.terminal_id, "RAW_READY\r\n");
    service
        .write_binary(
            1,
            TerminalWriteBinaryRequest {
                terminal_id: created.terminal_id.clone(),
                data: vec![0, 0x80, 0xff],
            },
        )
        .unwrap();
    let output = read_until(&service, &created.terminal_id, "RAW_DONE\r\n");
    assert!(
        String::from_utf8_lossy(&output)
            .lines()
            .any(|line| line.split_whitespace().collect::<Vec<_>>() == ["00", "80", "ff"]),
        "raw output: {:?}",
        String::from_utf8_lossy(&output)
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn close_protection_observes_real_child_processes_and_interrupt_returns_to_idle() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    let write = |data: &str| {
        service
            .write(
                1,
                TerminalWriteRequest {
                    terminal_id: created.terminal_id.clone(),
                    data: data.into(),
                },
            )
            .unwrap()
    };
    let wait_children = |expected| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if service
                .process_info(1, &created.terminal_id)
                .unwrap()
                .has_child_processes
                == Some(expected)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "child process state did not become {expected}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    write("printf 'CHILD_%s\\n' IDLE\n");
    read_until(&service, &created.terminal_id, "CHILD_IDLE\r\n");
    wait_children(false);
    write("printf 'CHILD_%s\\n' RUNNING; sleep 60\n");
    read_until(&service, &created.terminal_id, "CHILD_RUNNING\r\n");
    wait_children(true);
    service
        .send_signal(1, &created.terminal_id, TerminalSignal::Interrupt)
        .unwrap();
    write("printf 'CHILD_%s\\n' RESUMED\n");
    read_until(&service, &created.terminal_id, "CHILD_RESUMED\r\n");
    wait_children(false);
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn terminal_signal_interrupts_foreground_job_and_keeps_shell_alive() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "sh -c 'printf \"\\nSLEEP_READY\\n\"; exec sleep 60'\n".into(),
            },
        )
        .unwrap();
    read_until(&service, &created.terminal_id, "SLEEP_READY\r\n");
    service
        .send_signal(1, &created.terminal_id, TerminalSignal::Interrupt)
        .unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "printf '\\nSHELL_ALIVE\\n'\n".into(),
            },
        )
        .unwrap();
    read_until(&service, &created.terminal_id, "SHELL_ALIVE\r\n");
    assert_eq!(
        service
            .process_info(1, &created.terminal_id)
            .unwrap()
            .ready
            .pid,
        created.ready.pid
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(windows)]
#[test]
fn terminal_signal_reports_unsupported_without_injecting_input() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(1, terminal_request(TerminalLifecycle::ConnectionOwned))
        .unwrap();
    assert_eq!(
        service.send_signal(1, &created.terminal_id, TerminalSignal::Interrupt),
        Err(TerminalError::Unsupported)
    );
    assert_eq!(
        service.process_info(1, &created.terminal_id).unwrap().cwd,
        None
    );
    service.close(1, &created.terminal_id).unwrap();
}

fn terminal_service_for(path: &std::path::Path) -> TerminalService {
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(path).unwrap(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([Permission::ExecuteCommands]),
    );
    TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap()
}

fn terminal_request(lifecycle: TerminalLifecycle) -> TerminalCreateRequest {
    TerminalCreateRequest {
        strict_env: None,
        env: None,
        cwd: None,
        execution: None,
        rows: 24,
        cols: 80,
        profile: TerminalProfileSelection::Default,
        lifecycle,
    }
}

fn read_until(service: &TerminalService, terminal_id: &str, marker: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    let mut sequence = 0;
    while Instant::now() < deadline {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: terminal_id.to_owned(),
                    after_sequence: sequence,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        sequence = result.next_sequence;
        output.extend(result.chunks.into_iter().flat_map(|chunk| chunk.data));
        if output
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
        {
            return output;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "terminal did not produce {marker:?}; output={:?}",
        String::from_utf8_lossy(&output)
    );
}

#[cfg(unix)]
#[test]
fn interactive_shell_commands_report_real_boundaries_and_keep_user_configuration() {
    const CHILD: &str = "ASH_SHELL_STATUS_TEST_PROFILE";
    let Ok(profile_id) = std::env::var(CHILD) else {
        let current = std::thread::current();
        let profiles = TerminalProfileCatalog::discover().list();
        for profile in profiles
            .iter()
            .filter(|profile| matches!(profile.profile_id.as_str(), "zsh" | "bash"))
        {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir(home.path().join("startup")).unwrap();
            std::fs::create_dir(home.path().join("configured")).unwrap();
            std::fs::write(
                home.path().join("startup/.zshenv"),
                "export ZDOTDIR=\"$HOME/configured\"\n",
            )
            .unwrap();
            std::fs::write(home.path().join("configured/.zshrc"), "PS1='ASH_PROMPT> '; PS2='ASH_CONTINUE> '; export ASH_RC_LOADED=yes\nexport STARSHIP_SESSION_KEY=prompt-framework-test\nprecmd() { return 0; }\nuser_precmd() { printf '%s\\n' \"$?\" >> \"$HOME/prompt-status\"; }\nprecmd_functions=(user_precmd)\nset -u\n").unwrap();
            std::fs::write(home.path().join(".bashrc"), "PS1='ASH_PROMPT> '; PS2='ASH_CONTINUE> '; export ASH_RC_LOADED=yes\nexport STARSHIP_SESSION_KEY=prompt-framework-test\nPROMPT_COMMAND='printf \"%s\\n\" \"$?\" >> \"$HOME/prompt-status\"'\nset -u\n").unwrap();
            std::fs::write(
                home.path().join(".bash_profile"),
                "export ASH_LOGIN_LOADED=yes\nsource \"$HOME/.bashrc\"\n",
            )
            .unwrap();
            std::fs::write(
                home.path().join("configured/.zprofile"),
                "export ASH_LOGIN_LOADED=yes\n",
            )
            .unwrap();
            // A child test process isolates HOME/ZDOTDIR from parallel tests.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", current.name().unwrap(), "--nocapture"])
                .env(CHILD, &profile.profile_id)
                .env("HOME", home.path())
                .env("ZDOTDIR", home.path().join("startup"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}: {output:?}",
                profile.profile_id
            );
            let login = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", current.name().unwrap(), "--nocapture"])
                .env(CHILD, &profile.profile_id)
                .env("ASH_SHELL_STATUS_TEST_LOGIN", "1")
                .env("HOME", home.path())
                .env("ZDOTDIR", home.path().join("startup"))
                .output()
                .unwrap();
            assert!(
                login.status.success(),
                "login {}: {login:?}",
                profile.profile_id
            );
            if profile.profile_id == "bash" {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", current.name().unwrap(), "--nocapture"])
                    .env(CHILD, "bash")
                    .env("ASH_SHELL_STATUS_TEST_HISTORY_OFF", "1")
                    .env("HISTCONTROL", "ignorespace")
                    .env("HOME", home.path())
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "disabled/ignored history: {output:?}"
                );
                let rc = home.path().join(".bashrc");
                let mut script = std::fs::read_to_string(&rc).unwrap();
                script.push_str("trap 'printf debug >> \"$HOME/debug-calls\"' DEBUG\n");
                std::fs::write(rc, script).unwrap();
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", current.name().unwrap(), "--nocapture"])
                    .env(CHILD, "bash")
                    .env("ASH_SHELL_STATUS_TEST_DEBUG", "1")
                    .env("HOME", home.path())
                    .output()
                    .unwrap();
                assert!(output.status.success(), "user DEBUG trap: {output:?}");
            }
        }
        assert!(profiles.iter().any(|profile| profile.profile_id == "bash"));
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(
            1,
            TerminalCreateRequest {
                strict_env: None,
                env: None,
                cwd: None,
                execution: None,
                profile: TerminalProfileSelection::Custom {
                    name: "Configured shell".into(),
                    path: vec![if profile_id == "bash"
                        && std::env::var_os("ASH_TEST_BASH").is_some()
                    {
                        std::env::var("ASH_TEST_BASH").unwrap()
                    } else {
                        service
                            .profiles
                            .resolve(&TerminalProfileSelection::Profile {
                                profile_id: profile_id.clone(),
                            })
                            .unwrap()
                            .program
                            .clone()
                    }],
                    args: TerminalArguments::Argv(
                        if std::env::var_os("ASH_SHELL_STATUS_TEST_LOGIN").is_some() {
                            vec!["-l".into()]
                        } else {
                            Vec::new()
                        },
                    ),
                },
                ..terminal_request(TerminalLifecycle::ConnectionOwned)
            },
        )
        .unwrap();
    let id = &created.terminal_id;
    read_until(&service, id, "ASH_PROMPT> ");
    let expected_shell = if profile_id == "bash" {
        TerminalShellType::Bash
    } else {
        TerminalShellType::Zsh
    };
    assert_eq!(created.ready.shell_type, Some(expected_shell));
    assert!(read_shell_boundaries(&service, id).iter().any(|event| matches!(
        event,
        TerminalShellIntegrationEvent::ProcessReady { shell_type: Some(shell), .. } if *shell == expected_shell
    )));
    assert!(shell_status(&service, id).command_events.is_empty());

    if std::env::var_os("ASH_SHELL_STATUS_TEST_DEBUG").is_some() {
        let path = std::path::Path::new(&std::env::var("HOME").unwrap()).join("debug-calls");
        let initial_debug_calls = std::fs::read(&path).unwrap().len();
        let initial = shell_status(&service, id).next_sequence;
        write_shell(&service, id, "false\n");
        wait_shell_output(&service, id, initial);
        let result = shell_status(&service, id);
        // PS0 remains usable with an existing DEBUG trap; older Bash leaves
        // command detection unavailable instead of disturbing that trap.
        if result.command_events.len() == 2 {
            assert_eq!(
                result.command_events[1].status,
                TerminalCommandStatus::Failed
            );
        } else {
            assert!(result.command_events.is_empty(), "{result:?}");
        }
        let debug_calls = std::fs::read(path).unwrap();
        assert!(debug_calls.len() > initial_debug_calls);
        assert!(debug_calls.ends_with(b"debug"));
        service.close(1, id).unwrap();
        return;
    }

    if std::env::var_os("ASH_SHELL_STATUS_TEST_HISTORY_OFF").is_some() {
        write_shell(&service, id, "printf 'ASH_HISTORY_READY\\n'\n");
        wait_shell_events(&service, id, 2);
        assert_eq!(
            shell_status(&service, id).command_events[1].is_trusted,
            Some(true)
        );
        write_shell(&service, id, " set +o history\n");
        wait_shell_events(&service, id, 4);
        assert_eq!(shell_status(&service, id).command_events[3].command, None);
        write_shell(&service, id, "printf 'ASH_HISTORY_DISABLED\\n'\n");
        wait_shell_events(&service, id, 6);
        let history = shell_status(&service, id)
            .shell_integration
            .unwrap()
            .commands;
        assert_eq!(history.len(), 3);
        assert_eq!(history[2].command, None);
        service.close(1, id).unwrap();
        return;
    }

    write_shell(&service, id, "printf '%s\\n' \\\n");
    read_until(&service, id, "ASH_CONTINUE> ");
    assert!(shell_status(&service, id).command_events.is_empty());
    write_shell(
        &service,
        id,
        "\"CONFIG:$ASH_RC_LOADED\" \"LOGIN:${ASH_LOGIN_LOADED-no}\" \"UNICODE:中文🙂\"\n",
    );
    wait_shell_events(&service, id, 2);
    read_until(&service, id, "CONFIG:yes\r\n");
    let success = shell_status(&service, id);
    if std::env::var_os("ASH_SHELL_STATUS_TEST_LOGIN").is_some() {
        read_until(&service, id, "LOGIN:yes\r\n");
    }
    assert_eq!(
        success.command_events[1].status,
        TerminalCommandStatus::Succeeded
    );
    assert_eq!(success.command_events[1].exit_code, Some(0));
    assert_eq!(success.command_events[1].is_trusted, Some(true));
    assert!(
        success.command_events[1]
            .command
            .as_ref()
            .unwrap()
            .contains("中文🙂")
    );
    assert!(
        success.command_events[1]
            .command
            .as_ref()
            .unwrap()
            .contains("CONFIG:")
    );
    let boundaries = read_shell_boundaries(&service, id);
    assert!(
        boundaries
            .iter()
            .any(|event| matches!(event, TerminalShellIntegrationEvent::PromptStart))
    );
    assert!(
        boundaries
            .iter()
            .any(|event| matches!(event, TerminalShellIntegrationEvent::CommandStart))
    );
    assert!(boundaries.iter().any(|event| matches!(event, TerminalShellIntegrationEvent::CommandExecuted { timestamp_millis, is_trusted: true, .. } if *timestamp_millis > 0)));
    assert!(boundaries.iter().any(|event| matches!(
        event,
        TerminalShellIntegrationEvent::CommandFinished {
            exit_code: Some(0),
            duration_millis: Some(_),
            ..
        }
    )));
    assert!(boundaries.iter().any(|event| matches!(event, TerminalShellIntegrationEvent::EnvironmentEntry { key, value: Some(value), is_trusted: true } if key == "ASH_RC_LOADED" && value == "yes")));
    assert!(boundaries.iter().any(|event| matches!(
        event,
        TerminalShellIntegrationEvent::EnvironmentEnd { is_trusted: true }
    )));
    let integration = success.shell_integration.as_ref().unwrap();
    assert_eq!(integration.prompt_type.as_deref(), Some("starship"));
    assert!(
        integration.command_detection
            && integration.cwd_detection
            && integration.has_rich_command_detection
    );
    assert_eq!(integration.commands.len(), 1);
    assert_eq!(success.cwd.as_ref().unwrap().is_trusted, Some(true));
    let prompt_sequence = success.next_sequence;
    write_shell(&service, id, "\n");
    wait_shell_output(&service, id, prompt_sequence);
    assert_eq!(shell_status(&service, id).command_events.len(), 2);

    write_shell(&service, id, "false\n");
    wait_shell_events(&service, id, 4);
    let failure = shell_status(&service, id);
    assert_eq!(
        failure.command_events[3].status,
        TerminalCommandStatus::Failed
    );
    assert_eq!(failure.command_events[3].exit_code, Some(1));
    assert_eq!(failure.command_events[3].command.as_deref(), Some("false"));
    assert_eq!(failure.command_events[3].is_trusted, Some(true));
    let status_path = std::path::Path::new(&std::env::var("HOME").unwrap()).join("prompt-status");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let statuses = std::fs::read_to_string(&status_path).unwrap();
        if statuses.lines().last() == Some("1") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "user prompt hook did not receive the failed command's status"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    write_shell(
        &service,
        id,
        "printf '\\nASH_READ_READY\\n'; printf '\\033]633;E;spoofed;wrong\\007'; read answer; printf '\\nANSWER:%s\\n' \"$answer\"\n",
    );
    read_until(&service, id, "ASH_READ_READY\r\n");
    assert_eq!(shell_status(&service, id).command_events.len(), 5);
    assert_eq!(
        shell_status(&service, id).command_events[4].is_trusted,
        Some(true)
    );
    write_shell(&service, id, "inside-program\n");
    wait_shell_events(&service, id, 6);
    read_until(&service, id, "ANSWER:inside-program\r\n");
    assert_eq!(
        shell_status(&service, id).command_events[5]
            .command
            .as_deref(),
        Some("spoofed")
    );
    assert_eq!(
        shell_status(&service, id).command_events[5].is_trusted,
        Some(false)
    );

    let child = root.path().join("cwd; with space\\slash\nline");
    std::fs::create_dir(&child).unwrap();
    let current = shell_status(&service, id);
    assert_eq!(
        current.cwd.as_ref().unwrap().value,
        root.path().canonicalize().unwrap().to_str().unwrap()
    );
    write_shell(&service, id, "cd 'cwd; with space\\slash\nline'\n");
    wait_shell_events(&service, id, 8);
    let changed = wait_shell_cwd(
        &service,
        id,
        child.canonicalize().unwrap().to_str().unwrap(),
    );
    assert_eq!(
        changed.cwd.as_ref().unwrap().value,
        child.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(
        service.process_info(1, id).unwrap().cwd,
        changed.cwd.as_ref().map(|cwd| cwd.value.clone())
    );
    assert_eq!(
        changed.command_events[6].cwd.as_deref(),
        current.cwd.as_ref().map(|cwd| cwd.value.as_str())
    );

    write_shell(&service, id, "printf 'ASH_SLEEP_READY\\n'; sleep 60\n");
    wait_shell_events(&service, id, 9);
    // The preexec boundary precedes job startup. Wait until the foreground job
    // has produced output before sending its interrupt.
    read_until(&service, id, "ASH_SLEEP_READY\r\n");
    write_shell(&service, id, "\u{3}");
    wait_shell_events(&service, id, 10);
    let interrupted = shell_status(&service, id);
    assert_eq!(
        interrupted.command_events[9].status,
        TerminalCommandStatus::Failed
    );
    assert_ne!(interrupted.command_events[9].exit_code, Some(0));
    assert!(!interrupted.exited);
    let bytes = interrupted
        .chunks
        .into_iter()
        .flat_map(|chunk| chunk.data)
        .collect::<Vec<_>>();
    assert!(
        !bytes
            .windows(6)
            .any(|bytes| bytes == b"]633;C" || bytes == b"]633;D")
    );
    write_shell(&service, id, "printf '\\nASH_EXIT_OUTPUT\\n'; exit 17\n");
    wait_shell_events(&service, id, 12);
    let mut exited = shell_status(&service, id);
    assert!(exited.exited);
    assert_eq!(exited.command_events[11].exit_code, Some(17));
    assert_eq!(
        exited.command_events[11].command.as_deref(),
        Some("printf '\\nASH_EXIT_OUTPUT\\n'; exit 17")
    );
    assert_eq!(exited.shell_integration.as_ref().unwrap().commands.len(), 6);
    // Command events can describe output beyond the current bounded read page.
    while exited.next_sequence < exited.command_events[11].after_output_sequence {
        let page = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: id.into(),
                    after_sequence: exited.next_sequence,
                    after_command_sequence: exited.next_command_sequence,
                    max_chunks: 128,
                },
            )
            .unwrap();
        assert!(!page.chunks.is_empty());
        exited.next_sequence = page.next_sequence;
        exited.chunks.extend(page.chunks);
    }
    assert_eq!(
        exited.command_events[11].after_output_sequence,
        exited.next_sequence
    );
    let output = exited
        .chunks
        .into_iter()
        .flat_map(|chunk| chunk.data)
        .collect::<Vec<_>>();
    assert!(String::from_utf8_lossy(&output).contains("ASH_EXIT_OUTPUT\r\n"));
    service.close(1, id).unwrap();
}

#[cfg(unix)]
fn write_shell(service: &TerminalService, terminal_id: &str, data: &str) {
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: terminal_id.into(),
                data: data.into(),
            },
        )
        .unwrap();
}

#[cfg(unix)]
fn wait_shell_cwd(
    service: &TerminalService,
    terminal_id: &str,
    expected: &str,
) -> TerminalReadResult {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = shell_status(service, terminal_id);
        if result.cwd.as_ref().is_some_and(|cwd| cwd.value == expected) {
            return result;
        }
        assert!(
            Instant::now() < deadline,
            "shell did not report cwd {expected:?}: {result:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn read_shell_boundaries(
    service: &TerminalService,
    terminal_id: &str,
) -> Vec<TerminalShellIntegrationEvent> {
    let mut sequence = 0;
    let mut boundaries = Vec::new();
    loop {
        let read = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: terminal_id.into(),
                    after_sequence: sequence,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        sequence = read.next_sequence;
        let complete = read.chunks.len() < 128;
        boundaries.extend(
            read.chunks
                .into_iter()
                .filter_map(|chunk| chunk.shell_integration),
        );
        if complete {
            break;
        }
    }
    boundaries
}

#[cfg(unix)]
fn shell_status(service: &TerminalService, terminal_id: &str) -> TerminalReadResult {
    service
        .read(
            1,
            TerminalReadRequest {
                terminal_id: terminal_id.into(),
                after_sequence: 0,
                after_command_sequence: 0,
                max_chunks: 128,
            },
        )
        .unwrap()
}

#[cfg(unix)]
fn wait_shell_events(service: &TerminalService, terminal_id: &str, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = shell_status(service, terminal_id);
        if result.command_events.len() >= count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {count} events: {result:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn wait_shell_output(service: &TerminalService, terminal_id: &str, after_sequence: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: terminal_id.into(),
                    after_sequence,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        if result
            .chunks
            .iter()
            .flat_map(|chunk| &chunk.data)
            .copied()
            .collect::<Vec<_>>()
            .windows(12)
            .any(|bytes| bytes == b"ASH_PROMPT> ")
        {
            return;
        }
        assert!(Instant::now() < deadline, "no new prompt: {result:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
fn powershell_host_reports_commands_and_preserves_profile_hooks() {
    const CHILD: &str = "ASH_TEST_POWERSHELL_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let Ok(program) = std::env::var("ASH_TEST_POWERSHELL") else {
            println!("PowerShell PTY test requires ASH_TEST_POWERSHELL on Unix");
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let configuration = home.path().join(".config/powershell");
        std::fs::create_dir_all(&configuration).unwrap();
        std::fs::write(
            configuration.join("Microsoft.PowerShell_profile.ps1"),
            r#"
Import-Module PSReadLine
$global:AshTestReadLine = $function:PSConsoleHostReadLine
function global:PSConsoleHostReadLine {
    Add-Content -LiteralPath "$HOME/readline-calls" -Value 'read'
    $global:AshTestReadLine.Invoke()
}
function global:prompt {
    $wasSuccessful = $?
    Add-Content -LiteralPath "$HOME/prompt-status" -Value $wasSuccessful
    'ASH_PS_PROMPT> '
}
"#,
        )
        .unwrap();
        let current = std::thread::current();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", current.name().unwrap(), "--nocapture"])
            .env(CHILD, "1")
            .env("SHELL", program)
            .env("HOME", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let created = service
        .create(
            1,
            TerminalCreateRequest {
                strict_env: None,
                profile: TerminalProfileSelection::Custom {
                    name: "Configured PowerShell".into(),
                    path: vec![std::env::var("SHELL").unwrap()],
                    args: TerminalArguments::Argv(vec!["-NoLogo".into()]),
                },
                ..terminal_request(TerminalLifecycle::ConnectionOwned)
            },
        )
        .unwrap();
    assert_eq!(created.profile.profile_id, "custom:Configured PowerShell");
    let id = &created.terminal_id;
    let mut observed = PowerShellObservation::default();
    observed.wait_for(&service, id, |state| state.prompt_count() >= 1);
    assert!(observed.events.is_empty());

    write_shell(&service, id, "Write-Output (\r");
    observed.wait_for(&service, id, |state| {
        state.bytes.windows(2).any(|bytes| bytes == b">>")
    });
    assert!(observed.events.is_empty());
    write_shell(&service, id, "'ASH_PS_READY', '中文🙂')\r");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 2 && state.prompt_count() >= 2
    });
    assert_eq!(observed.events[1].status, TerminalCommandStatus::Succeeded);
    assert_eq!(observed.events[1].is_trusted, Some(true));
    assert!(
        observed.events[1]
            .command
            .as_ref()
            .unwrap()
            .contains("中文🙂")
    );
    assert!(
        observed.events[1]
            .command
            .as_ref()
            .unwrap()
            .contains("ASH_PS_READY")
    );
    assert!(observed.events[1].command.as_ref().unwrap().contains('\n'));
    let integration = shell_status(&service, id).shell_integration.unwrap();
    assert!(
        integration.has_rich_command_detection
            && integration.command_detection
            && integration.cwd_detection
    );
    assert_eq!(integration.commands.len(), 1);
    assert!(String::from_utf8_lossy(&observed.bytes).contains("ASH_PS_READY\r\n"));

    write_shell(&service, id, "Write-Error 'expected failure'\r");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 4 && state.prompt_count() >= 3
    });
    assert_eq!(observed.events[3].status, TerminalCommandStatus::Failed);
    let home = std::env::var("HOME").unwrap();
    let statuses =
        std::fs::read_to_string(std::path::Path::new(&home).join("prompt-status")).unwrap();
    assert_eq!(statuses.lines().last(), Some("False"));

    let prompts = observed.prompt_count();
    write_shell(&service, id, "\r");
    observed.wait_for(&service, id, |state| state.prompt_count() > prompts);
    assert_eq!(observed.events.len(), 4);

    write_shell(
        &service,
        id,
        "$global:LASTEXITCODE = 7; Write-Output ('ASH_PS_' + 'SUCCESS')\r",
    );
    observed.wait_for(&service, id, |state| {
        state.events.len() == 6 && state.prompt_count() >= 5
    });
    assert_eq!(observed.events[5].status, TerminalCommandStatus::Succeeded);
    assert_eq!(observed.events[5].exit_code, Some(0));
    let directory = root.path().join("directory; with spaces");
    std::fs::create_dir(&directory).unwrap();
    write_shell(
        &service,
        id,
        "Set-Location -LiteralPath 'directory; with spaces'\r",
    );
    observed.wait_for(&service, id, |state| {
        state.events.len() == 8 && state.prompt_count() >= 6
    });
    let info = service.process_info(1, id).unwrap();
    assert_eq!(
        info.cwd.as_deref(),
        directory.canonicalize().unwrap().to_str()
    );
    write_shell(
        &service,
        id,
        "Write-Error 'stale external status must not replace failure'\r",
    );
    observed.wait_for(&service, id, |state| {
        state.events.len() == 10 && state.prompt_count() >= 7
    });
    assert_eq!(observed.events[9].exit_code, Some(1));
    assert_eq!(observed.events[8].cwd, info.cwd);
    let previous_bytes = observed.bytes.len();
    write_shell(
        &service,
        id,
        "Write-Output 'ASH_PS_INPUT_READY'; [Console]::Write(\"$([char]27)]633;E;spoofed;wrong$([char]7)\"); $value = Read-Host; Write-Output ('ASH_PS_VALUE:' + $value)\r",
    );
    observed.wait_for(&service, id, |state| {
        String::from_utf8_lossy(&state.bytes[previous_bytes..]).contains("ASH_PS_INPUT_READY\r\n")
    });
    assert_eq!(observed.events.len(), 11);
    assert_eq!(observed.events[10].is_trusted, Some(true));
    write_shell(&service, id, "inside-program\r");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 12 && state.prompt_count() >= 8
    });
    assert!(String::from_utf8_lossy(&observed.bytes).contains("ASH_PS_VALUE:inside-program"));
    assert_eq!(observed.events[11].command.as_deref(), Some("spoofed"));
    assert_eq!(observed.events[11].is_trusted, Some(false));
    write_shell(&service, id, "Start-Sleep -Seconds 60\r");
    observed.wait_for(&service, id, |state| state.events.len() == 13);
    write_shell(&service, id, "\u{3}");
    observed.wait_for(&service, id, |state| {
        state.events.len() == 14 && state.prompt_count() >= 9
    });
    assert_ne!(observed.events[13].exit_code, Some(0));
    assert!(!shell_status(&service, id).exited);
    let calls =
        std::fs::read_to_string(std::path::Path::new(&home).join("readline-calls")).unwrap();
    assert!(calls.lines().count() >= 4);
    write_shell(&service, id, "exit 19\r");
    observed.wait_for(&service, id, |state| state.events.len() == 16);
    let exited = shell_status(&service, id);
    assert!(exited.exited);
    assert_eq!(exited.exit_code, Some(19));
    assert_eq!(observed.events[15].exit_code, Some(19));
    assert_eq!(observed.events[15].command.as_deref(), Some("exit 19"));
    assert_eq!(observed.events[15].is_trusted, Some(true));
    assert_eq!(exited.shell_integration.unwrap().commands.len(), 8);
    assert_eq!(service.process_info(1, id).unwrap().cwd, info.cwd);
    service.close(1, id).unwrap();
}

#[cfg(unix)]
#[derive(Default)]
struct PowerShellObservation {
    bytes: Vec<u8>,
    events: Vec<TerminalCommandStatusEvent>,
    output_sequence: u64,
    command_sequence: u64,
    cursor_replies: usize,
}

#[cfg(unix)]
impl PowerShellObservation {
    fn prompt_count(&self) -> usize {
        self.bytes
            .windows(15)
            .filter(|bytes| *bytes == b"ASH_PS_PROMPT> ")
            .count()
    }

    fn wait_for(
        &mut self,
        service: &TerminalService,
        terminal_id: &str,
        ready: impl Fn(&Self) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let result = service
                .read(
                    1,
                    TerminalReadRequest {
                        terminal_id: terminal_id.into(),
                        after_sequence: self.output_sequence,
                        after_command_sequence: self.command_sequence,
                        max_chunks: 128,
                    },
                )
                .unwrap();
            self.output_sequence = result.next_sequence;
            self.command_sequence = result.next_command_sequence;
            self.bytes
                .extend(result.chunks.into_iter().flat_map(|chunk| chunk.data));
            self.events.extend(result.command_events);
            // PSReadLine queries cursor position; xterm supplies these replies in the product.
            let requests = self
                .bytes
                .windows(4)
                .filter(|bytes| *bytes == b"\x1b[6n")
                .count();
            while self.cursor_replies < requests {
                service
                    .write_binary(
                        1,
                        TerminalWriteBinaryRequest {
                            terminal_id: terminal_id.into(),
                            data: b"\x1b[1;1R".to_vec(),
                        },
                    )
                    .unwrap();
                self.cursor_replies += 1;
            }
            if ready(self) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "PowerShell output: {:?}; events: {:?}",
                String::from_utf8_lossy(&self.bytes),
                self.events
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
#[test]
fn terminal_process_execution_preserves_literal_arguments_cwd_and_exit_status() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("child")).unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.cwd = Some("child".into());
    request.execution = Some(TerminalExecution::Process {
        program: "/bin/sh".into(),
        args: TerminalArguments::Argv(vec![
            "-c".into(),
            "printf 'ARG:<%s>\\nCWD:<%s>\\nDONE\\n' \"$1\" \"$PWD\"; exit 7".into(),
            "test".into(),
            "$(touch ../injected) $HOME ; spaces".into(),
        ]),
    });
    let created = service.create(1, request).unwrap();
    let output = read_until(&service, &created.terminal_id, "DONE\r\n");
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("ARG:<$(touch ../injected) $HOME ; spaces>"));
    assert!(text.contains(&format!(
        "CWD:<{}>",
        root.path().join("child").canonicalize().unwrap().display()
    )));
    assert!(!root.path().join("injected").exists());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: created.terminal_id.clone(),
                    after_sequence: 0,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        if result.exited {
            assert_eq!(result.exit_code, Some(7));
            service
                .resize(
                    1,
                    TerminalResizeRequest {
                        terminal_id: created.terminal_id.clone(),
                        rows: 40,
                        cols: 120,
                    },
                )
                .expect("retained output remains resizable after process exit");
            assert_eq!(
                service.resize(
                    2,
                    TerminalResizeRequest {
                        terminal_id: created.terminal_id.clone(),
                        rows: 40,
                        cols: 120,
                    }
                ),
                Err(TerminalError::NotOwner)
            );
            assert_eq!(
                service.resize(
                    1,
                    TerminalResizeRequest {
                        terminal_id: created.terminal_id.clone(),
                        rows: 0,
                        cols: 120,
                    }
                ),
                Err(TerminalError::InvalidInput)
            );
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    service.close(1, &created.terminal_id).unwrap();
}

#[test]
fn terminal_execution_rejects_invalid_arguments_and_cwd_before_spawning() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.cwd = Some(outside.path().into());
    assert_eq!(service.create(1, request), Err(TerminalError::InvalidInput));
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.execution = Some(TerminalExecution::Process {
        program: "unused".into(),
        args: TerminalArguments::Argv(vec!["invalid\0argument".into()]),
    });
    assert_eq!(service.create(1, request), Err(TerminalError::InvalidInput));
    assert_eq!(service.active_count(), 0);
}

#[test]
fn raw_process_arguments_reject_invalid_or_non_windows_requests_before_spawning() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut invalid = vec!["bad\0value".into(), "x".repeat(32769)];
    if !cfg!(windows) {
        invalid.extend(["/c echo raw".into(), "".into()]);
    }
    for args in invalid {
        let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
        request.execution = Some(TerminalExecution::Process {
            program: "unused".into(),
            args: TerminalArguments::CommandLine(args),
        });
        assert_eq!(service.create(1, request), Err(TerminalError::InvalidInput));
    }
    assert_eq!(service.active_count(), 0);
}

#[cfg(windows)]
#[test]
fn raw_command_line_executes_through_the_original_terminal_owner() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.execution = Some(TerminalExecution::Process {
        program: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
        args: TerminalArguments::CommandLine(
            r#"/d /s /c "echo RAW:two words&echo DONE&exit /b 7""#.into(),
        ),
    });
    let created = service.create(1, request).unwrap();
    let output = read_until(&service, &created.terminal_id, "DONE\r\n");
    assert!(String::from_utf8_lossy(&output).contains("RAW:two words"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = service
            .read(
                1,
                TerminalReadRequest {
                    terminal_id: created.terminal_id.clone(),
                    after_sequence: 0,
                    after_command_sequence: 0,
                    max_chunks: 128,
                },
            )
            .unwrap();
        if result.exited {
            assert_eq!(result.exit_code, Some(7));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    service.close(1, &created.terminal_id).unwrap();
    assert_eq!(service.active_count(), 0);
}

#[test]
fn environment_reads_requested_spawn_values_without_allocating_a_terminal() {
    let root = tempfile::tempdir().unwrap();
    let grant = ash_file_access::Grant::for_environment(
        ash_file_access::Dir::open_local(root.path()).unwrap(),
        ash_file_access::GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([Permission::ExecuteCommands]),
    );
    let service =
        TerminalService::new(grant.authorize(Permission::ExecuteCommands).unwrap()).unwrap();
    assert_eq!(
        service
            .environment(&["TERM_PROGRAM".into(), "ASH_MISSING_VALUE".into()])
            .unwrap(),
        HashMap::from([("TERM_PROGRAM".into(), "ash".into())])
    );
    assert_eq!(service.active_count(), 0);
    assert_eq!(
        service.environment(&["INVALID=NAME".into()]),
        Err(TerminalError::InvalidInput)
    );
    assert_eq!(
        service.environment(&vec!["HOME".into(); 129]),
        Err(TerminalError::InvalidInput)
    );
    let expected = if cfg!(windows) {
        HashMap::from([("term_program".into(), "ash".into())])
    } else {
        HashMap::new()
    };
    assert_eq!(
        service.environment(&["term_program".into()]).unwrap(),
        expected
    );
    grant.revoke();
    assert_eq!(
        service.environment(&["HOME".into()]),
        Err(TerminalError::OperationFailed)
    );
}

#[cfg(unix)]
#[test]
fn environment_overrides_apply_at_spawn_without_changing_the_host_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.env = Some(HashMap::from([
        ("ASH_TASK_MODE".into(), Some("literal value".into())),
        ("COLORTERM".into(), None),
        (
            "NODE_REPL_AUTH_TOKEN".into(),
            Some("synthetic-host-control".into()),
        ),
    ]));
    let created = service.create(1, request).unwrap();
    service
        .write(
            1,
            TerminalWriteRequest {
                terminal_id: created.terminal_id.clone(),
                data: "printf '\nENV_RESULT:%s:%s:%s\n' \"$ASH_TASK_MODE\" \"${COLORTERM-unset}\" \"${NODE_REPL_AUTH_TOKEN-private-excluded}\"\n"
                    .into(),
            },
        )
        .unwrap();
    let output = read_until(
        &service,
        &created.terminal_id,
        "ENV_RESULT:literal value:unset:private-excluded",
    );
    assert!(
        String::from_utf8_lossy(&output)
            .contains("ENV_RESULT:literal value:unset:private-excluded")
    );
    assert_eq!(
        service.environment(&["COLORTERM".into()]).unwrap(),
        HashMap::from([("COLORTERM".into(), "truecolor".into())])
    );
    service.close(1, &created.terminal_id).unwrap();
    let mut invalid = terminal_request(TerminalLifecycle::ConnectionOwned);
    invalid.env = Some(HashMap::from([("BAD=NAME".into(), Some("value".into()))]));
    assert_eq!(service.create(1, invalid), Err(TerminalError::InvalidInput));
    assert_eq!(service.active_count(), 0);
}

#[cfg(unix)]
#[test]
fn shell_environment_metadata_runs_after_user_rc_without_evaluating_literal_values() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    for file in [".bashrc", ".zshrc"] {
        std::fs::write(home.path().join(file), "printf '%s:%s\\n' \"${STAGE-unset}\" \"${VSCODE_ENV_APPEND-unset}\" > \"$HOME/before-stage\"\nexport STAGE=rc\nPS1='MUTATION_READY> '\n").unwrap();
    }
    let service = terminal_service_for(root.path());
    let literal = format!(
        "quote ' 中文🙂 : \\x3a $HOME $(touch {}) __ASH_SHELL_NONCE__\n",
        home.path().join("injected").display()
    );
    let encode = |value: &str| value.replace('\\', "\\\\").replace(':', "\\x3a");
    let mut count = 0;
    for profile in service
        .profiles()
        .iter()
        .filter(|profile| matches!(profile.profile_id.as_str(), "bash" | "zsh"))
    {
        count += 1;
        let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
        request.profile = TerminalProfileSelection::Profile {
            profile_id: profile.profile_id.clone(),
        };
        request.env = Some(HashMap::from([
            (
                "HOME".into(),
                Some(home.path().to_string_lossy().into_owned()),
            ),
            (
                "ZDOTDIR".into(),
                Some(home.path().to_string_lossy().into_owned()),
            ),
            ("STAGE".into(), Some("process".into())),
            (
                "VSCODE_ENV_REPLACE".into(),
                Some(format!(
                    "LITERAL={}:EMPTY=:NODE_REPL_AUTH_TOKEN=forged:__ash_nonce=forged",
                    encode(&literal)
                )),
            ),
            (
                "VSCODE_ENV_PREPEND".into(),
                Some("STAGE=before\\x3a".into()),
            ),
            ("VSCODE_ENV_APPEND".into(), Some("STAGE=\\x3aafter".into())),
        ]));
        let created = service.create(1, request).unwrap();
        read_until(&service, &created.terminal_id, "MUTATION_READY> ");
        assert_eq!(
            std::fs::read_to_string(home.path().join("before-stage")).unwrap(),
            "process:unset\n"
        );
        let boundaries = read_shell_boundaries(&service, &created.terminal_id);
        let entries: HashMap<_, _> = boundaries
            .into_iter()
            .filter_map(|event| match event {
                TerminalShellIntegrationEvent::EnvironmentEntry {
                    key,
                    value,
                    is_trusted: true,
                } => Some((key, value)),
                _ => None,
            })
            .collect();
        assert_eq!(
            entries.get("STAGE").and_then(|value| value.as_deref()),
            Some("before:rc:after")
        );
        assert_eq!(
            entries.get("LITERAL").and_then(|value| value.as_deref()),
            Some(literal.as_str())
        );
        assert_eq!(
            entries.get("EMPTY").and_then(|value| value.as_deref()),
            Some("")
        );
        assert!(!entries.contains_key("VSCODE_ENV_APPEND"));
        assert!(!entries.contains_key("NODE_REPL_AUTH_TOKEN"));
        assert!(!home.path().join("injected").exists());
        service.close(1, &created.terminal_id).unwrap();

        let mut strict = terminal_request(TerminalLifecycle::ConnectionOwned);
        strict.strict_env = Some(true);
        strict.profile = TerminalProfileSelection::Profile {
            profile_id: profile.profile_id.clone(),
        };
        strict.env = Some(HashMap::from([
            (
                "HOME".into(),
                Some(home.path().to_string_lossy().into_owned()),
            ),
            (
                "ZDOTDIR".into(),
                Some(home.path().to_string_lossy().into_owned()),
            ),
            ("STAGE".into(), Some("explicit".into())),
            ("VSCODE_ENV_APPEND".into(), Some("not-metadata".into())),
        ]));
        let created = service.create(1, strict).unwrap();
        read_until(&service, &created.terminal_id, "MUTATION_READY> ");
        assert_eq!(
            std::fs::read_to_string(home.path().join("before-stage")).unwrap(),
            "explicit:not-metadata\n"
        );
        service.close(1, &created.terminal_id).unwrap();
    }
    assert!(count > 0);
    let mut invalid = terminal_request(TerminalLifecycle::ConnectionOwned);
    invalid.profile = TerminalProfileSelection::Profile {
        profile_id: "bash".into(),
    };
    invalid.env = Some(HashMap::from([(
        "VSCODE_ENV_APPEND".into(),
        Some("BAD;NAME=value".into()),
    )]));
    assert_eq!(service.create(1, invalid), Err(TerminalError::InvalidInput));
    assert_eq!(service.active_count(), 0);
}

#[cfg(unix)]
#[test]
fn custom_profile_resolution_and_creation_share_identity_argv_and_environment() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let selection = TerminalProfileSelection::Custom {
        name: "Literal shell".into(),
        path: vec!["/missing/shell".into(), "/bin/sh".into()],
        args: TerminalArguments::Argv(vec![
            "-c".into(),
            "printf 'profile:%s:%s' \"$1\" \"$ASH_PROFILE_TEST\"".into(),
            "profile".into(),
            "literal;$HOME".into(),
        ]),
    };
    let resolved = service.resolve_profile(&selection).unwrap();
    assert_eq!(resolved.executable, "/bin/sh");
    assert_eq!(service.active_count(), 0);
    let created = service
        .create(
            1,
            TerminalCreateRequest {
                strict_env: None,
                rows: 24,
                cols: 80,
                profile: selection,
                lifecycle: TerminalLifecycle::ConnectionOwned,
                env: Some(HashMap::from([(
                    "ASH_PROFILE_TEST".into(),
                    Some("value with spaces".into()),
                )])),
                cwd: None,
                execution: None,
            },
        )
        .unwrap();
    assert_eq!(created.profile, resolved.profile);
    let output = read_until(
        &service,
        &created.terminal_id,
        "profile:literal;$HOME:value with spaces",
    );
    assert!(String::from_utf8_lossy(&output).contains("profile:literal;$HOME:value with spaces"));
    service.close_owner(1);
}

#[cfg(unix)]
#[test]
fn task_process_execution_keeps_osc_output_without_creating_shell_command_state() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.profile = TerminalProfileSelection::Profile {
        profile_id: "bash".into(),
    };
    request.execution = Some(TerminalExecution::Process {
        program: "/bin/sh".into(),
        args: TerminalArguments::Argv(vec![
            "-c".into(),
            "printf '\\033]633;P;Cwd=/spoof\\007\\033]633;C\\007\\033]633;D;0\\007DONE\\n'".into(),
        ]),
    });
    let created = service.create(1, request).unwrap();
    let output = read_until(&service, &created.terminal_id, "DONE\r\n");
    assert!(output.windows(10).any(|bytes| bytes == b"633;P;Cwd="));
    let state = shell_status(&service, &created.terminal_id);
    assert!(state.command_events.is_empty());
    assert!(state.cwd.is_none());
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn strict_terminal_spawn_uses_only_explicit_environment_and_keeps_host_defaults() {
    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
    request.strict_env = Some(true);
    request.env = Some(HashMap::from([
        ("ONLY".into(), Some("literal ${env:HOME} 中文".into())),
        ("REMOVED".into(), None),
    ]));
    request.execution = Some(TerminalExecution::Process {
        program: "/usr/bin/env".into(),
        args: TerminalArguments::Argv(vec![]),
    });
    let created = service.create(1, request).unwrap();
    let output = read_until(
        &service,
        &created.terminal_id,
        "ONLY=literal ${env:HOME} 中文",
    );
    assert_eq!(
        String::from_utf8(output).unwrap().trim(),
        "ONLY=literal ${env:HOME} 中文"
    );
    assert_eq!(
        service
            .environment(&["COLORTERM".into()])
            .unwrap()
            .get("COLORTERM")
            .map(String::as_str),
        Some("truecolor")
    );
    service.close(1, &created.terminal_id).unwrap();
}

#[cfg(unix)]
#[test]
fn interactive_terminal_agent_identity_is_explicit_and_does_not_mutate_the_host() {
    const CHILD: &str = "ASH_AI_AGENT_TERMINAL_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let current = std::thread::current();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", current.name().unwrap(), "--nocapture"])
            .env(CHILD, "1")
            .env("AI_AGENT", "enclosing-agent")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let service = terminal_service_for(root.path());
    assert!(
        service
            .environment(&["AI_AGENT".into()])
            .unwrap()
            .is_empty()
    );
    for (explicit, expected) in [
        (None, "unset"),
        (Some("user-selected-agent"), "user-selected-agent"),
    ] {
        let mut request = terminal_request(TerminalLifecycle::ConnectionOwned);
        request.execution = Some(TerminalExecution::Process {
            program: "/bin/sh".into(),
            args: TerminalArguments::Argv(vec![
                "-c".into(),
                "printf 'MANUAL_AGENT=%s\n' \"${AI_AGENT-unset}\"".into(),
            ]),
        });
        request.env =
            explicit.map(|value| HashMap::from([("AI_AGENT".into(), Some(value.into()))]));
        let created = service.create(1, request).unwrap();
        let marker = format!("MANUAL_AGENT={expected}");
        let output = read_until(&service, &created.terminal_id, &marker);
        assert!(String::from_utf8_lossy(&output).contains(&marker));
        service.close(1, &created.terminal_id).unwrap();
    }
    assert!(
        service
            .environment(&["AI_AGENT".into()])
            .unwrap()
            .is_empty()
    );
    assert_eq!(std::env::var("AI_AGENT").unwrap(), "enclosing-agent");
}
