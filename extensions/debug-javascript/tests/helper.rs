//! The real helper process must release a waiting runtime even when its provider is gone.
use serde_json::json;
use std::io::Write;
use std::net::TcpListener;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use tokio_tungstenite::tungstenite;

#[test]
fn dead_broker_resumes_the_exact_waiting_inspector() {
    let inspector = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = inspector.local_addr().unwrap();
    let broker = TcpListener::bind("127.0.0.1:0").unwrap();
    let retired = broker.local_addr().unwrap();
    drop(broker);
    let expected = std::thread::spawn(move || {
        let (stream, _) = inspector.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        let message = socket.read().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&message).unwrap(),
            json!({"id":1,"method":"Runtime.runIfWaitingForDebugger"})
        );
        socket
            .send(tungstenite::Message::Text(
                json!({"id":1,"result":{}}).to_string().into(),
            ))
            .unwrap();
    });
    // Bootstrap passes the payload in the environment: Node waits synchronously
    // for Inspector, so waiting for its event loop to close stdin would deadlock.
    let mut helper = Command::new(env!("CARGO_BIN_EXE_ash-debug-javascript"))
        .arg("--auto-attach")
        .env("ASH_JS_DEBUG_REQUEST", json!({"token":"retired","address":retired.to_string(),"inspector":format!("ws://{address}/owned-target"),"pid":42,"cwd":"/","script":"main.js","flagged":false}).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while helper.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = helper.kill();
            panic!("auto-attach helper failed to release Inspector");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    expected.join().unwrap();
}

#[test]
fn malformed_helper_input_exits_without_starting_an_extension_host() {
    let mut helper = Command::new(env!("CARGO_BIN_EXE_ash-debug-javascript"))
        .arg("--auto-attach")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    helper
        .stdin
        .take()
        .unwrap()
        .write_all(b"{bad input}")
        .unwrap();
    let output = helper.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
}
