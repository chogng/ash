#![cfg(windows)]

use std::io::BufRead;
use std::io::BufReader;
use std::num::NonZeroU64;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_computer_use_protocol::Action;
use ash_computer_use_protocol::CHANNEL;
use ash_computer_use_protocol::EXTENSION_ID;
use ash_computer_use_protocol::Request;
use ash_computer_use_protocol::Response;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use base64::Engine;

struct Fixture(Child);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Fixture {
    fn start() -> Self {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let powershell = system.join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let source: Vec<_> = include_str!("fixture.ps1")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let command = base64::engine::general_purpose::STANDARD.encode(source);
        let mut fixture = Self(
            Command::new(powershell)
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW keeps the console hidden, not the fixture.
                .args(["-NoLogo", "-NoProfile", "-Sta", "-EncodedCommand", &command])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let pipe = fixture.0.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(pipe).read_line(&mut line).unwrap();
            let _ = send.send(line);
        });
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .trim(),
            "ready"
        );
        fixture
    }
}

fn request(provider: &ExtensionHostSupervisor, request: Request) -> Response {
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(10);
    let result = provider
        .invoke(ExtensionInvocation {
            registration_id: CHANNEL.into(),
            operation: "receiveData".into(),
            deadline_unix_millis: NonZeroU64::new(deadline.as_millis() as u64).unwrap(),
            payload: serde_json::to_value(request).unwrap(),
        })
        .unwrap();
    serde_json::from_value(result.payload).unwrap()
}

#[test]
#[ignore = "requires a Windows interactive session and captures only an owned fixture window"]
fn computer_use_provider_observes_and_operates_only_a_fresh_granted_window() {
    let fixture = Fixture::start();
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-computer-use"));
    let provider =
        ExtensionHostSupervisor::start_product_resource(executable, EXTENSION_ID, 12 * 1024 * 1024)
            .unwrap();
    assert!(matches!(
        request(
            &provider,
            Request::Observe {
                observation: 1,
                screenshot: false
            }
        ),
        Response::Failed { .. }
    ));
    let Response::Windows { mut windows } = request(
        &provider,
        Request::ListWindows {
            query: Some(format!("Ash Computer Use fixture {}", fixture.0.id())),
        },
    ) else {
        panic!("missing fixture window list");
    };
    assert_eq!(windows.len(), 1);
    let window = windows.pop().unwrap();
    assert_eq!(window.process, fixture.0.id());
    assert!(matches!(
        request(
            &provider,
            Request::Bind {
                window: window.clone()
            }
        ),
        Response::Bound
    ));

    let other =
        ExtensionHostSupervisor::start_product_resource(executable, EXTENSION_ID, 1024 * 1024)
            .unwrap();
    assert!(matches!(
        request(
            &other,
            Request::Bind {
                window: window.clone()
            }
        ),
        Response::Failed { .. }
    ));
    let mut next_observation = 1;
    let mut observe = |screenshot| {
        next_observation += 1;
        request(
            &provider,
            Request::Observe {
                observation: next_observation,
                screenshot,
            },
        )
    };
    let Response::Observation {
        observation,
        elements,
        screenshot_png: Some(png),
        ..
    } = observe(true)
    else {
        panic!("missing screenshot or observation");
    };
    assert!(
        base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n")
    );
    let edit = elements
        .iter()
        .find(|element| element.name == "Test value")
        .unwrap();
    let button = elements
        .iter()
        .find(|element| element.name == "Apply test value")
        .unwrap();
    assert!(matches!(
        request(
            &provider,
            Request::Act {
                observation,
                element: edit.id,
                action: Action::SetValue {
                    value: "scope verified".into()
                }
            }
        ),
        Response::Applied
    ));
    assert!(matches!(
        request(
            &provider,
            Request::Act {
                observation,
                element: button.id,
                action: Action::Invoke
            }
        ),
        Response::Failed { .. }
    ));

    let Response::Observation {
        observation,
        elements,
        ..
    } = observe(false)
    else {
        panic!("missing fresh observation");
    };
    let button = elements
        .iter()
        .find(|element| element.name == "Apply test value")
        .unwrap();
    assert!(matches!(
        request(
            &provider,
            Request::Act {
                observation,
                element: button.id,
                action: Action::Invoke
            }
        ),
        Response::Applied
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let Response::Observation { elements, .. } = observe(false) else {
            panic!("missing action result");
        };
        if elements
            .iter()
            .any(|element| element.name == "Applied: scope verified")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the target did not apply the value"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    provider.shutdown().unwrap();
    assert!(matches!(
        request(&other, Request::Bind { window }),
        Response::Bound
    ));
    assert!(matches!(
        request(
            &other,
            Request::Observe {
                observation: next_observation + 1,
                screenshot: false
            }
        ),
        Response::Observation { .. }
    ));
    assert!(matches!(
        request(
            &other,
            Request::Act {
                observation,
                element: button.id,
                action: Action::Invoke
            }
        ),
        Response::Failed { .. }
    ));
    drop(fixture);
    assert!(matches!(
        request(
            &other,
            Request::Observe {
                observation: next_observation + 2,
                screenshot: false
            }
        ),
        Response::Failed { .. }
    ));
    other.shutdown().unwrap();
}
