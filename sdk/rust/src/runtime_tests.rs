use std::io::Cursor;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use external_ext_protocol::ActivateParams;
use external_ext_protocol::ExtensionCapability;
use external_ext_protocol::ExtensionHostRequest;
use external_ext_protocol::ExtensionHostResponse;
use external_ext_protocol::HostRequestKind;
use external_ext_protocol::HostResponseKind;
use external_ext_protocol::InitializeParams;
use external_ext_protocol::PackageBinding;
use external_ext_protocol::RequestContext;

use super::RuntimeOptions;
use super::run;
use crate::Command;
use crate::Extension;
use crate::ExtensionContext;
use crate::ExtensionError;
use crate::HostErrorCode;

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct CommandsOnly {
    deactivations: Arc<AtomicUsize>,
}

impl Extension for CommandsOnly {
    fn id(&self) -> &str {
        "example.commands"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        context
            .commands
            .register_command(Command::new("example.echo", "Echo"), |invocation, _| {
                Ok(
                    if invocation.arguments.first() == Some(&serde_json::json!("expand")) {
                        serde_json::json!("x".repeat(4096))
                    } else {
                        serde_json::json!(invocation.arguments)
                    },
                )
            })
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        self.deactivations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn oversized_callback_returns_a_quota_error_and_keeps_the_runtime_usable() {
    let buffer = Buffer::default();
    let options = RuntimeOptions {
        protocol: external_ext_protocol::ProtocolLimits {
            maximum_payload_bytes: 1024,
            maximum_frame_bytes: 8192,
            ..Default::default()
        },
        ..Default::default()
    };
    let writer = super::Writer {
        stream: Arc::new(Mutex::new(Box::new(buffer.clone()))),
        maximum_bytes: options.protocol.maximum_frame_bytes,
    };
    let mut runtime = super::Runtime {
        client: crate::client::Client::new(writer.clone(), options.maximum_in_flight_requests),
        services: crate::services::Services::new(
            writer.clone(),
            options.maximum_in_flight_requests,
        ),
        extension: CommandsOnly {
            deactivations: Arc::new(AtomicUsize::new(0)),
        },
        writer,
        options,
        phase: super::Phase::New,
        environment: None,
        fence: None,
        context: None,
        registrations: Default::default(),
        invocations: Default::default(),
    };
    runtime.dispatch(initialize(1, 1)).unwrap();
    runtime
        .dispatch(activate(2, vec![ExtensionCapability::Command]))
        .unwrap();
    for (id, argument) in [(3, "expand"), (5, "small")] {
        runtime
            .invoke(
                RequestContext::new(id, 2, 3),
                external_ext_protocol::InvokeParams {
                    extension_id: "example.commands".into(),
                    registration_id: "example.echo".into(),
                    operation: "execute".into(),
                    payload: serde_json::json!({"arguments":[argument]}),
                    deadline_unix_millis: 1_900_000_000_000,
                },
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while runtime
            .invocations
            .values()
            .any(|invocation| !invocation.thread.is_finished())
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        runtime.reap_finished().unwrap();
        runtime
            .dispatch(ExtensionHostRequest {
                context: RequestContext::new(id + 1, 2, 3),
                request: HostRequestKind::Ping,
            })
            .unwrap();
    }
    let replies = responses(&buffer);
    assert!(
        matches!(&replies[2].response, HostResponseKind::Failure(failure) if failure.code == HostErrorCode::QuotaExceeded)
    );
    assert!(matches!(
        &replies[3].response,
        HostResponseKind::Success(external_ext_protocol::HostSuccess::Pong)
    ));
    assert!(
        matches!(&replies[4].response, HostResponseKind::Success(external_ext_protocol::HostSuccess::Invoked(result)) if result.payload == serde_json::json!(["small"]))
    );
    runtime.deactivate().unwrap();
}

fn initialize(id: u64, runtime_api_version: u16) -> ExtensionHostRequest {
    ExtensionHostRequest {
        context: RequestContext::new(id, 2, 3),
        request: HostRequestKind::Initialize(InitializeParams {
            extension_id: "example.commands".into(),
            runtime_api_version,
            environment: Default::default(),
        }),
    }
}

fn activate(id: u64, capabilities: Vec<ExtensionCapability>) -> ExtensionHostRequest {
    ExtensionHostRequest {
        context: RequestContext::new(id, 2, 3),
        request: HostRequestKind::Activate(ActivateParams {
            initialization: None,
            extension_id: "example.commands".into(),
            package: PackageBinding {
                package_id: "example/commands@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "bin/commands".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["onCommand:example.echo".into()],
            capabilities,
        }),
    }
}

fn input(requests: &[ExtensionHostRequest]) -> Cursor<Vec<u8>> {
    let mut input = Vec::new();
    for request in requests {
        input.extend(serde_json::to_vec(request).unwrap());
        input.push(b'\n');
    }
    Cursor::new(input)
}

fn responses(buffer: &Buffer) -> Vec<ExtensionHostResponse> {
    buffer
        .0
        .lock()
        .unwrap()
        .split(|byte| *byte == b'\n')
        .filter(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_slice(frame).unwrap())
        .collect()
}

#[test]
fn eof_releases_the_active_extension_exactly_once() {
    let deactivations = Arc::new(AtomicUsize::new(0));
    let buffer = Buffer::default();
    let requests = [
        initialize(1, 1),
        activate(2, vec![ExtensionCapability::Command]),
    ];
    run(
        CommandsOnly {
            deactivations: deactivations.clone(),
        },
        input(&requests),
        buffer.clone(),
        RuntimeOptions::default(),
    )
    .unwrap();
    let replies = responses(&buffer);
    for (reply, request) in replies.iter().zip(&requests) {
        reply
            .validate_for(request, &RuntimeOptions::default().protocol)
            .unwrap();
    }
    assert_eq!(deactivations.load(Ordering::SeqCst), 1);
    assert_eq!(replies.len(), 2);
}

#[test]
fn unsupported_api_version_is_rejected_before_activation() {
    let buffer = Buffer::default();
    run(
        CommandsOnly {
            deactivations: Arc::new(AtomicUsize::new(0)),
        },
        input(&[initialize(1, 2)]),
        buffer.clone(),
        RuntimeOptions::default(),
    )
    .unwrap();
    assert!(
        matches!(&responses(&buffer)[0].response, HostResponseKind::Failure(failure) if failure.code == HostErrorCode::UnsupportedRuntimeApiVersion)
    );
}

#[test]
fn activation_cannot_publish_undeclared_commands() {
    let buffer = Buffer::default();
    let deactivations = Arc::new(AtomicUsize::new(0));
    run(
        CommandsOnly {
            deactivations: deactivations.clone(),
        },
        input(&[
            initialize(1, 1),
            activate(2, vec![ExtensionCapability::LanguageProvider]),
        ]),
        buffer.clone(),
        RuntimeOptions::default(),
    )
    .unwrap();
    assert!(
        matches!(&responses(&buffer)[1].response, HostResponseKind::Failure(failure) if failure.code == HostErrorCode::ActivationFailed)
    );
    assert_eq!(deactivations.load(Ordering::SeqCst), 1);
}

#[test]
fn malformed_input_and_changed_process_identity_end_the_runtime() {
    for reader in [Cursor::new(b"{}\n".to_vec()), Cursor::new(b"{}".to_vec())] {
        assert!(
            run(
                CommandsOnly {
                    deactivations: Arc::new(AtomicUsize::new(0))
                },
                reader,
                Buffer::default(),
                RuntimeOptions::default()
            )
            .is_err()
        );
    }
    let mut other = initialize(2, 1);
    other.context.incarnation += 1;
    assert!(
        run(
            CommandsOnly {
                deactivations: Arc::new(AtomicUsize::new(0))
            },
            input(&[initialize(1, 1), other]),
            Buffer::default(),
            RuntimeOptions::default()
        )
        .is_err()
    );
}
