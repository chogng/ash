use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::relay_output;

#[test]
fn response_is_flushed_before_the_stream_closes() {
    struct PausedReader {
        first: bool,
        release: mpsc::Receiver<()>,
    }

    impl Read for PausedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if !self.first {
                self.first = true;
                let response = b"{\"id\":1}\n";
                buffer[..response.len()].copy_from_slice(response);
                return Ok(response.len());
            }
            self.release.recv().unwrap();
            Ok(0)
        }
    }

    struct FlushObserver {
        buffered: Vec<u8>,
        delivered: mpsc::Sender<Vec<u8>>,
    }

    impl Write for FlushObserver {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.buffered.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.delivered
                .send(std::mem::take(&mut self.buffered))
                .unwrap();
            Ok(())
        }
    }

    let (release, receiver) = mpsc::channel();
    let (delivered, output) = mpsc::channel();
    let worker = thread::spawn(move || {
        relay_output(
            &mut PausedReader {
                first: false,
                release: receiver,
            },
            &mut FlushObserver {
                buffered: Vec::new(),
                delivered,
            },
        )
    });
    let response = output.recv_timeout(Duration::from_secs(1));
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(response.unwrap(), b"{\"id\":1}\n");
}
