use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use voice_host::AudioHost;

fn executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_ash-voice-host"))
        .canonicalize()
        .unwrap()
}

async fn ready() -> (
    tokio::process::Child,
    tokio::process::ChildStdin,
    tokio::process::ChildStdout,
) {
    let mut child = Command::new(executable())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();
    // Establish readiness before measuring protocol rejection or EOF shutdown time.
    let hello = br#"{"id":1,"command":{"operation":"hello","version":1}}"#;
    input.write_u32_le(hello.len() as u32).await.unwrap();
    input.write_all(hello).await.unwrap();
    timeout(Duration::from_secs(5), async {
        let len = output.read_u32_le().await.unwrap();
        assert!(len < 16 * 1024);
        let mut body = vec![0; len as usize];
        output.read_exact(&mut body).await.unwrap();
        let event: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(event["error"].is_null());
    })
    .await
    .unwrap();
    (child, input, output)
}

#[tokio::test]
async fn relocated_executable_needs_no_media_runtime_and_releases_process() {
    let package = tempfile::tempdir().unwrap();
    let path = package.path().join(if cfg!(windows) {
        "audio host.exe"
    } else {
        "audio host"
    });
    std::fs::copy(executable(), &path).unwrap();
    AudioHost::spawn(&path.canonicalize().unwrap())
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn invalid_request_is_rejected_and_parent_pipe_loss_exits() {
    let (mut child, mut input, mut output) = ready().await;
    let payload = br#"{"id":2,"command":{"operation":"capture","state":"muted"}}"#;
    input.write_u32_le(payload.len() as u32).await.unwrap();
    input.write_all(payload).await.unwrap();
    let len = timeout(Duration::from_secs(3), output.read_u32_le())
        .await
        .unwrap()
        .unwrap();
    let mut response = vec![0; len as usize];
    output.read_exact(&mut response).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&response).unwrap();
    assert!(
        value["error"]
            .as_str()
            .unwrap()
            .contains("no audio session")
    );
    drop(input);
    assert!(
        timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn oversized_frame_terminates_without_waiting_for_its_body() {
    let (mut child, mut input, _output) = ready().await;
    input.write_u32_le(u32::MAX).await.unwrap();
    assert!(
        !timeout(Duration::from_secs(3), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn stop_before_start_and_repeated_stop_are_device_free() {
    let mut host = AudioHost::spawn(&executable()).await.unwrap();
    host.stop().await.unwrap();
    host.stop().await.unwrap();
    host.close().await.unwrap();
}
