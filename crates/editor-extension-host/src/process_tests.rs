use std::collections::BTreeMap;
use std::io::BufReader;
use std::io::Cursor;
use std::time::Duration;

use super::PendingEntry;
use super::reserve_pending;
use crate::ExtensionHostRequest;
use crate::ExtensionHostResponse;
use crate::HostRequestKind;
use crate::HostResponseKind;
use crate::HostSuccess;
use crate::PendingHostRequest;
use crate::RequestContext;
use extension_protocol::read_frame as read_bounded_line;

#[test]
fn product_js_policy_cannot_authorize_an_independent_executable_or_another_host() {
    use crate::ExtensionHostLauncher;
    let root = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let executable = root.join("ash-js-extension-host");
    let launcher = crate::ProductJavaScriptLauncher::new(executable.clone());
    let limits = crate::ExtensionHostLimits {
        isolation: crate::ProcessIsolationPolicy::RequireJavaScriptEnforcement(
            crate::JavaScriptMemoryLimits::default(),
        ),
        ..Default::default()
    };
    let independent = super::ExtensionLaunchCommand::new(
        &executable,
        std::iter::empty::<String>(),
        &root,
        BTreeMap::new(),
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&independent, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let other_host = super::ExtensionLaunchCommand::javascript(
        root.join("other-host"),
        std::iter::empty::<String>(),
        &root,
    )
    .unwrap();
    assert!(matches!(
        launcher.spawn(&other_host, &limits),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
    let javascript =
        super::ExtensionLaunchCommand::javascript(executable, std::iter::empty::<String>(), root)
            .unwrap();
    assert!(matches!(
        launcher.spawn(&javascript, &crate::ExtensionHostLimits::default()),
        Err(crate::ExtensionHostError::IsolationUnavailable)
    ));
}

#[test]
fn bounded_reader_never_accepts_an_oversized_line() {
    let input = Cursor::new(b"123456\nnext\n".to_vec());
    let mut reader = BufReader::with_capacity(2, input);
    assert!(read_bounded_line(&mut reader, 5).is_err());
}

#[test]
fn bounded_reader_handles_chunked_crlf_and_clean_eof() {
    let input = Cursor::new(b"one\r\ntwo\n".to_vec());
    let mut reader = BufReader::with_capacity(2, input);
    assert_eq!(
        read_bounded_line(&mut reader, 8).unwrap(),
        Some(b"one".to_vec())
    );
    assert_eq!(
        read_bounded_line(&mut reader, 8).unwrap(),
        Some(b"two".to_vec())
    );
    assert_eq!(read_bounded_line(&mut reader, 8).unwrap(), None);
}

#[test]
fn duplicate_request_id_never_replaces_the_original_waiter() {
    let request = ExtensionHostRequest {
        context: RequestContext::new(1, 1, 1),
        request: HostRequestKind::Ping,
    };
    let (original, original_sender) = PendingHostRequest::channel(1);
    let mut pending = BTreeMap::new();
    reserve_pending(
        &mut pending,
        PendingEntry {
            client_ids: std::collections::BTreeSet::new(),
            request: request.clone(),
            sender: original_sender,
            control: false,
        },
        2,
        1,
    )
    .unwrap();
    let (_duplicate, duplicate_sender) = PendingHostRequest::channel(1);
    assert!(
        reserve_pending(
            &mut pending,
            PendingEntry {
                client_ids: std::collections::BTreeSet::new(),
                request: request.clone(),
                sender: duplicate_sender,
                control: false,
            },
            2,
            1,
        )
        .is_err()
    );
    pending
        .remove(&1)
        .unwrap()
        .sender
        .send(Ok(super::PendingMessage::Response(ExtensionHostResponse {
            context: request.context,
            response: HostResponseKind::Success(HostSuccess::Pong),
        })))
        .unwrap();
    assert!(
        original
            .recv_timeout(Duration::from_millis(10))
            .unwrap()
            .is_some()
    );
}

#[test]
fn control_request_capacity_is_reserved_when_normal_requests_are_full() {
    let mut pending = BTreeMap::new();
    let normal = ExtensionHostRequest {
        context: RequestContext::new(1, 1, 1),
        request: HostRequestKind::Ping,
    };
    let (_, normal_sender) = PendingHostRequest::channel(1);
    reserve_pending(
        &mut pending,
        PendingEntry {
            client_ids: std::collections::BTreeSet::new(),
            request: normal,
            sender: normal_sender,
            control: false,
        },
        1,
        1,
    )
    .unwrap();
    let cancel = ExtensionHostRequest {
        context: RequestContext::new(2, 1, 1),
        request: HostRequestKind::Cancel(crate::CancelParams {
            target_request_id: 1,
            reason: crate::CancelReason::Deadline,
        }),
    };
    let (_, cancel_sender) = PendingHostRequest::channel(2);
    assert!(
        reserve_pending(
            &mut pending,
            PendingEntry {
                client_ids: std::collections::BTreeSet::new(),
                request: cancel,
                sender: cancel_sender,
                control: true,
            },
            1,
            1,
        )
        .is_ok()
    );
}
