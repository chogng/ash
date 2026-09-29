use super::FileSystem;
use super::SystemFileTransferOperation;
use super::TestDir;
use super::read_x11_clipboard_format;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::AtomEnum;
use x11rb::protocol::xproto::ChangeWindowAttributesAux;
use x11rb::protocol::xproto::ConnectionExt;
use x11rb::protocol::xproto::CreateWindowAux;
use x11rb::protocol::xproto::EventMask;
use x11rb::protocol::xproto::PropMode;
use x11rb::protocol::xproto::Property;
use x11rb::protocol::xproto::SelectionNotifyEvent;
use x11rb::protocol::xproto::WindowClass;
use x11rb::wrapper::ConnectionExt as _;

#[test]
#[ignore = "requires an isolated X11 display; run with --ignored --test-threads=1"]
fn incremental_file_lists_reassemble_chunks_and_enforce_the_total_size_limit() {
    let format = "x-special/gnome-copied-files";
    let bytes = b"cut\nfile:///tmp/a%20b\nfile:///tmp/second\n";
    let clipboard = IncrementalClipboard::new(format, bytes.chunks(7).map(Vec::from).collect());
    assert_eq!(
        read_x11_clipboard_format(format).unwrap(),
        Some(bytes.to_vec())
    );
    drop(clipboard);

    let maximum = vec![vec![b'a'; 64 * 1024]; 16];
    let clipboard = IncrementalClipboard::new(format, maximum.clone());
    assert_eq!(
        read_x11_clipboard_format(format).unwrap(),
        Some(maximum.concat())
    );
    drop(clipboard);

    let clipboard = IncrementalClipboard::new(format, Vec::new());
    assert_eq!(read_x11_clipboard_format(format).unwrap(), Some(Vec::new()));
    drop(clipboard);

    let clipboard = IncrementalClipboard::new(format, vec![vec![b'a'; 64 * 1024]; 17]);
    let error = read_x11_clipboard_format(format).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Clipboard file list is too large"),
        "{error}"
    );
    drop(clipboard);
}

#[test]
#[ignore = "requires an isolated X11 display; run with --ignored --test-threads=1"]
fn system_paste_reads_direct_uri_lists_and_incremental_private_directories() {
    use std::os::unix::fs::PermissionsExt;

    {
        let source = TestDir::new();
        let target = TestDir::new();
        let file = source.path.join("direct file.bin");
        std::fs::write(&file, [0, 255, 42]).unwrap();
        let mut clipboard = arboard::Clipboard::new().unwrap();
        clipboard.set().file_list(&[file.clone()]).unwrap();
        assert!(
            target
                .file_system()
                .paste_system_files(std::path::Path::new("."), SystemFileTransferOperation::Copy)
                .unwrap()
        );
        assert_eq!(
            std::fs::read(target.path.join("direct file.bin")).unwrap(),
            [0, 255, 42]
        );
        assert!(file.exists());
    }

    for marker in ["copy", "cut"] {
        let source = TestDir::new();
        let target = TestDir::new();
        let directory = source.path.join("private");
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.join("binary"), [0, 255, 42]).unwrap();
        let uri = url::Url::from_file_path(&directory).unwrap();
        let payload = format!("{marker}\n{uri}\n");
        let clipboard = IncrementalClipboard::new(
            "x-special/gnome-copied-files",
            payload.as_bytes().chunks(7).map(Vec::from).collect(),
        );
        assert!(
            target
                .file_system()
                .paste_system_files(std::path::Path::new("."), SystemFileTransferOperation::Copy)
                .unwrap()
        );
        assert_eq!(
            std::fs::read(target.path.join("private/binary")).unwrap(),
            [0, 255, 42]
        );
        assert_eq!(
            std::fs::metadata(target.path.join("private"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(directory.exists(), marker == "copy");
        drop(clipboard);
    }
}

/// Selection owner that waits for the receiver's property deletion before each chunk.
struct IncrementalClipboard {
    running: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl IncrementalClipboard {
    fn new(format: &str, chunks: Vec<Vec<u8>>) -> Self {
        let (connection, screen) = x11rb::connect(None).unwrap();
        let window = connection.generate_id().unwrap();
        connection
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                window,
                connection.setup().roots[screen].root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new(),
            )
            .unwrap()
            .check()
            .unwrap();
        let atom = |name: &[u8]| {
            connection
                .intern_atom(false, name)
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let selection = atom(b"CLIPBOARD");
        let target = atom(format.as_bytes());
        let targets = atom(b"TARGETS");
        let incr = atom(b"INCR");
        connection
            .set_selection_owner(window, selection, x11rb::CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let active = running.clone();
        let worker = thread::spawn(move || {
            // Other X11 clients may query the selection too; each receiver has its own stream.
            let mut transfers = std::collections::HashMap::new();
            while active.load(Ordering::SeqCst) {
                match connection.poll_for_event().unwrap() {
                    Some(Event::SelectionRequest(event)) => {
                        let property = if event.target == targets {
                            connection
                                .change_property32(
                                    PropMode::REPLACE,
                                    event.requestor,
                                    event.property,
                                    AtomEnum::ATOM,
                                    &[targets, target],
                                )
                                .unwrap();
                            event.property
                        } else if event.target == target {
                            connection
                                .change_window_attributes(
                                    event.requestor,
                                    &ChangeWindowAttributesAux::new()
                                        .event_mask(EventMask::PROPERTY_CHANGE),
                                )
                                .unwrap();
                            // Zero is a valid lower bound, so the receiver must bound accumulated bytes.
                            connection
                                .change_property32(
                                    PropMode::REPLACE,
                                    event.requestor,
                                    event.property,
                                    incr,
                                    &[0],
                                )
                                .unwrap();
                            transfers.insert((event.requestor, event.property), 0);
                            event.property
                        } else {
                            x11rb::NONE
                        };
                        connection
                            .send_event(
                                false,
                                event.requestor,
                                EventMask::NO_EVENT,
                                SelectionNotifyEvent {
                                    response_type: x11rb::protocol::xproto::SELECTION_NOTIFY_EVENT,
                                    sequence: 0,
                                    time: event.time,
                                    requestor: event.requestor,
                                    selection: event.selection,
                                    target: event.target,
                                    property,
                                },
                            )
                            .unwrap();
                        connection.flush().unwrap();
                    }
                    Some(Event::PropertyNotify(event)) if event.state == Property::DELETE => {
                        if let Some(index) = transfers.get_mut(&(event.window, event.atom)) {
                            let chunk = chunks.get(*index).map(Vec::as_slice).unwrap_or(&[]);
                            connection
                                .change_property8(
                                    PropMode::REPLACE,
                                    event.window,
                                    event.atom,
                                    target,
                                    chunk,
                                )
                                .unwrap();
                            *index += 1;
                            if chunk.is_empty() {
                                transfers.remove(&(event.window, event.atom));
                            }
                            connection.flush().unwrap();
                        }
                    }
                    None => thread::sleep(Duration::from_millis(1)),
                    _ => {}
                }
            }
        });
        Self {
            running,
            worker: Some(worker),
        }
    }
}

impl Drop for IncrementalClipboard {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
