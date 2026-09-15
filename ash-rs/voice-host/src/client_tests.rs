use super::*;
use std::os::unix::fs::PermissionsExt;

async fn stalled_host() -> (tempfile::TempDir, AudioHost) {
    let directory = tempfile::tempdir().unwrap();
    let reply = directory.path().join("reply");
    std::fs::write(
        &reply,
        wire::encode(&Event::Reply {
            id: 1,
            epoch: 0,
            error: None,
        })
        .unwrap(),
    )
    .unwrap();
    let script = directory.path().join("host");
    let quoted = format!("'{}'", reply.display().to_string().replace('\'', "'\\''"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\n/bin/cat {quoted}\nexec /bin/sleep 30\n"),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let host = AudioHost::spawn(&script.canonicalize().unwrap())
        .await
        .unwrap();
    (directory, host)
}

#[tokio::test]
async fn cancelling_a_control_request_kills_the_unresponsive_process() {
    let (_directory, mut host) = stalled_host().await;
    assert!(
        timeout(Duration::from_millis(30), host.stop())
            .await
            .is_err()
    );
    let status = timeout(Duration::from_secs(2), host.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(!status.success());
    assert!(host.stop().await.is_err());
}

#[tokio::test]
async fn owner_drop_reaps_the_process() {
    let (_directory, host) = stalled_host().await;
    let pid = host.child.id().unwrap();
    drop(host);
    timeout(Duration::from_secs(2), async {
        while Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap()
            .success()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
