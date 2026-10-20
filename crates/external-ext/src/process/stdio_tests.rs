use super::*;
use crate::HostRequestKind;
use crate::HostResponseKind;
use crate::HostSuccess;
use crate::RequestContext;
use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientRequest;
use external_ext_protocol::ExtensionClientResponse;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::ExtensionHostResponse;
use external_ext_protocol::HostErrorCode;
use external_ext_protocol::HostFailure;
use external_ext_protocol::InvokeParams;
use external_ext_protocol::read_frame;
use external_ext_protocol::write_frame;
use serde_json::Value;
use std::net::TcpListener;
use std::time::Duration;

fn transport() -> (StdioExtensionHostProcess, BufReader<TcpStream>) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let (stream, _) = listener.accept().unwrap();
    let pending = Arc::new(Mutex::new(BTreeMap::new()));
    let exited = Arc::new(AtomicBool::new(false));
    let output_events = Arc::new(Mutex::new(OutputEventQueue::default()));
    let background = Arc::new(Mutex::new(BackgroundClientQueue::default()));
    let registration_handler = Arc::new(Mutex::new(None));
    let limits = ExtensionHostLimits::default();
    let reader = spawn_stdout_reader(
        Box::new(stream.try_clone().unwrap()),
        pending.clone(),
        exited.clone(),
        output_events.clone(),
        background.clone(),
        registration_handler.clone(),
        false,
        limits.clone(),
    );
    let (writer, writer_thread) = spawn_writer(
        Box::new(stream.try_clone().unwrap()),
        pending.clone(),
        exited.clone(),
        &limits,
    );
    (
        StdioExtensionHostProcess {
            registration_handler,
            child: Mutex::new(None),
            writer: Mutex::new(Some(writer)),
            pending,
            exited,
            stderr: Arc::new(Mutex::new(Vec::new())),
            output_events,
            background,
            writer_thread: Mutex::new(Some(writer_thread)),
            stdout_thread: Mutex::new(Some(reader)),
            stderr_thread: Mutex::new(None),
            diagnostic_stdout_thread: Mutex::new(None),
            control: Some(stream),
            limits,
        },
        BufReader::new(peer),
    )
}

#[test]
fn cancelled_invocation_keeps_its_client_reply_until_the_host_callback_finishes() {
    let (process, mut peer) = transport();
    let context = RequestContext::new(1, 1, 1);
    let request = ExtensionHostRequest {
        context,
        request: HostRequestKind::Invoke(InvokeParams {
            extension_id: "test.extension".into(),
            registration_id: "scm".into(),
            registration_generation: None,
            operation: "decoration".into(),
            payload: Value::Null,
            deadline_unix_millis: u64::MAX,
        }),
    };
    let waiter = process.dispatch(request).unwrap();
    read_frame(&mut peer, process.limits.maximum_frame_bytes)
        .unwrap()
        .unwrap();
    let call = ExtensionClientRequest {
        context,
        call_id: 1,
        operation: ExtensionClientOperation::ReadConfiguration {
            section: "git".into(),
            resource: None,
        },
    };
    write_frame(peer.get_mut(), &call, process.limits.maximum_frame_bytes).unwrap();
    assert!(matches!(
        waiter.recv_next_timeout(Duration::from_secs(2)).unwrap(),
        Some(PendingMessage::ClientRequest(_))
    ));

    // A cooperative cancellation can finish the extension callback while its host-side
    // configuration or Git request is still returning. Observe the terminal frame first.
    let terminal = ExtensionHostResponse {
        context,
        response: HostResponseKind::Failure(HostFailure {
            code: HostErrorCode::Cancelled,
            message: "label query cancelled".into(),
        }),
    };
    write_frame(
        peer.get_mut(),
        &terminal,
        process.limits.maximum_frame_bytes,
    )
    .unwrap();
    assert_eq!(
        waiter.recv_timeout(Duration::from_secs(2)).unwrap(),
        Some(terminal)
    );

    let reply = ExtensionClientResponse {
        context,
        call_id: call.call_id,
        outcome: Ok(ExtensionClientResult::Configuration { value: Value::Null }),
    };
    let mut wrong = reply.clone();
    wrong.context = RequestContext::new(1, 2, 1);
    assert!(process.respond_client(wrong).is_err());
    process.respond_client(reply.clone()).unwrap();
    let bytes = read_frame(&mut peer, process.limits.maximum_frame_bytes)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<ExtensionClientResponse>(&bytes).unwrap(),
        reply
    );
    assert!(process.respond_client(reply).is_err());
    assert!(process.pending.lock().unwrap().is_empty());

    // The unrelated next invocation must still use this same transport incarnation.
    let context = RequestContext::new(2, 1, 1);
    let waiter = process
        .dispatch(ExtensionHostRequest {
            context,
            request: HostRequestKind::Ping,
        })
        .unwrap();
    read_frame(&mut peer, process.limits.maximum_frame_bytes)
        .unwrap()
        .unwrap();
    let pong = ExtensionHostResponse {
        context,
        response: HostResponseKind::Success(HostSuccess::Pong),
    };
    write_frame(peer.get_mut(), &pong, process.limits.maximum_frame_bytes).unwrap();
    assert_eq!(
        waiter.recv_timeout(Duration::from_secs(2)).unwrap(),
        Some(pong)
    );
    assert!(!process.has_exited());
}

#[test]
fn blocked_stdin_does_not_block_dispatch_or_termination() {
    let node = std::process::Command::new("node")
        .args(["--print", "process.execPath"])
        .output()
        .expect("Node is required for the extension process contract tests");
    assert!(node.status.success());
    let executable = std::path::PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let command = ExtensionLaunchCommand::new(
        executable,
        ["-e", "setTimeout(() => process.exit(0), 5000)"],
        std::env::temp_dir(),
        BTreeMap::new(),
    )
    .unwrap();
    let process = Arc::new(
        StdioExtensionHostProcess::spawn(
            &command,
            &ExtensionHostLimits {
                isolation: crate::ProcessIsolationPolicy::TrustedDevelopment,
                maximum_frame_bytes: 4 * 1024 * 1024,
                maximum_payload_bytes: 3 * 1024 * 1024,
                ..Default::default()
            },
        )
        .unwrap(),
    );
    let sending = process.clone();
    let (sent, dispatched) = mpsc::channel();
    let writer = thread::spawn(move || {
        sent.send(sending.dispatch(ExtensionHostRequest {
            context: RequestContext::new(1, 1, 1),
            request: HostRequestKind::Invoke(InvokeParams {
                extension_id: "test.extension".into(),
                registration_id: "test".into(),
                registration_generation: None,
                operation: "execute".into(),
                payload: Value::String("x".repeat(2 * 1024 * 1024)),
                deadline_unix_millis: u64::MAX,
            }),
        }))
        .unwrap()
    });
    let dispatch_result = dispatched.recv_timeout(Duration::from_secs(1));
    let stopping = process.clone();
    let (done, finished) = std::sync::mpsc::channel();
    let killer = thread::spawn(move || done.send(stopping.terminate()).unwrap());
    let result = finished.recv_timeout(Duration::from_secs(1));
    // The fixture exits by itself after five seconds, so even the broken ordering can
    // be joined without leaking a blocked test process or an orchestration thread.
    killer.join().unwrap();
    writer.join().unwrap();
    let waiter = dispatch_result
        .expect("dispatch blocked before returning the cancellable waiter")
        .unwrap();
    assert!(matches!(
        waiter.recv_timeout(Duration::from_secs(1)),
        Err(ExtensionHostError::HostExited)
    ));
    result
        .expect("termination waited for the blocked writer instead of interrupting it")
        .unwrap();
    assert!(process.has_exited());
}

#[test]
fn retiring_a_full_callback_queue_does_not_wait_for_its_consumer() {
    let (waiter, sender) = PendingHostRequest::channel(1);
    while sender.try_send(Err(PendingFailure::Exited)).is_ok() {}
    let pending = Arc::new(Mutex::new(BTreeMap::from([(
        1,
        PendingEntry {
            request: ExtensionHostRequest {
                context: RequestContext::new(1, 1, 1),
                request: HostRequestKind::Ping,
            },
            sender,
            client_ids: Default::default(),
            last_client_id: 0,
            response_received: false,
            control: false,
        },
    )])));
    let retiring = pending.clone();
    let (done, finished) = mpsc::channel();
    let thread = thread::spawn(move || {
        fail_all_pending(&retiring, PendingFailure::Transport);
        done.send(()).unwrap();
    });
    let result = finished.recv_timeout(Duration::from_millis(500));
    // Drain once before joining so a regression cannot strand the test worker.
    assert!(waiter.recv_timeout(Duration::from_secs(1)).is_err());
    thread.join().unwrap();
    result.expect("retirement blocked on the abandoned callback queue");
    assert!(pending.lock().unwrap().is_empty());
}
