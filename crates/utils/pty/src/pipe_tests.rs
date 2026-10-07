#[test]
fn closing_stops_waiting_for_output_while_a_pipe_writer_is_still_alive() {
    use std::io::Read;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = ChildGuard(
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Write('ready'); Start-Sleep -Seconds 10",
            ])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let closing = Arc::new(AtomicBool::new(false));
    let mut output =
        crate::CancellablePipeReader::new(child.0.stdout.take().unwrap(), closing.clone());
    let (ready, received) = std::sync::mpsc::channel();
    let (closed, completed) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = [0; 5];
        output.read_exact(&mut bytes).unwrap();
        ready.send(bytes).unwrap();
        let result = output.read(&mut bytes);
        closed.send(result.unwrap()).unwrap();
    });
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        *b"ready"
    );
    closing.store(true, Ordering::Release);
    assert_eq!(completed.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
    assert!(
        child.0.try_wait().unwrap().is_none(),
        "reader closes without waiting for the writer to exit"
    );
    reader.join().unwrap();
}
