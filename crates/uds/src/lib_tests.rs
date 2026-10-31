use std::io;
use std::io::Read;
use std::io::Write;
use std::thread;

use crate::IpcListener;
use crate::IpcStream;
use crate::SocketDirectory;

#[cfg(windows)]
#[test]
fn long_unicode_runtime_paths_use_stable_isolated_named_pipes() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let preferred = temporary.path().join("很长的运行目录-".repeat(12));
    let directory = SocketDirectory::prepare(&preferred)?;
    let name = std::path::Path::new("runtime.sock");
    let path = directory.socket_path(name)?;
    assert!(path.as_os_str().as_encoded_bytes().len() > 108);
    let pipe = crate::windows::pipe::pipe_name(&path)?;
    assert!(pipe.starts_with(r"\\.\pipe\ash-ipc-"));
    assert!(pipe.len() < 100);
    assert_eq!(
        pipe,
        crate::windows::pipe::pipe_name(&SocketDirectory::prepare(&preferred)?.socket_path(name)?)?
    );
    assert_ne!(
        pipe,
        crate::windows::pipe::pipe_name(
            &directory.socket_path(std::path::Path::new("other.sock"))?
        )?
    );
    let listener = directory.bind(name)?;
    assert!(
        !path.exists(),
        "Windows IPC must not create an AF_UNIX filesystem entry"
    );
    assert!(
        directory.bind(name).is_err(),
        "a second listener must not claim the same namespace"
    );
    let mut client = directory.connect(name)?;
    let (mut peer, _) = listener.accept()?;
    assert!(crate::peer_identity(&peer)?.same_user);
    peer.write_all(b"ok")?;
    let mut reply = [0; 2];
    client.read_exact(&mut reply)?;
    assert_eq!(&reply, b"ok");
    drop(peer);
    drop(client);
    drop(listener);
    Ok(())
}
#[test]
fn exchanges_bytes_over_socket_path() -> io::Result<()> {
    let socket_directory = tempfile::tempdir()?;
    let socket_path = socket_directory.path().join("round-trip.sock");
    let listener = IpcListener::bind(&socket_path)?;

    let server = thread::spawn(move || -> io::Result<()> {
        let (mut stream, _) = listener.accept()?;
        let mut request = [0; 4];
        stream.read_exact(&mut request)?;
        assert_eq!(&request, b"ping");
        stream.write_all(b"pong")?;
        Ok(())
    });

    let mut client = IpcStream::connect(&socket_path)?;
    client.write_all(b"ping")?;
    let mut response = [0; 4];
    client.read_exact(&mut response)?;
    assert_eq!(&response, b"pong");

    server.join().expect("socket server thread panicked")?;
    Ok(())
}

#[test]
fn private_endpoint_exchanges_data_only_after_peer_identity_is_observed() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let directory = SocketDirectory::create(&temporary.path().join("private"))?;
    let listener = directory.bind(std::path::Path::new("peer.sock"))?;
    let server = thread::spawn(move || -> io::Result<()> {
        let (mut stream, _) = listener.accept()?;
        assert_eq!(
            crate::peer_identity(&stream)?,
            crate::PeerIdentity {
                same_user: true,
                same_elevation: true
            }
        );
        stream.write_all(b"ok")
    });
    let mut client = directory.connect(std::path::Path::new("peer.sock"))?;
    assert_eq!(
        crate::peer_identity(&client)?,
        crate::PeerIdentity {
            same_user: true,
            same_elevation: true
        }
    );
    let mut bytes = [0; 2];
    client.read_exact(&mut bytes)?;
    assert_eq!(&bytes, b"ok");
    server.join().unwrap()?;
    drop(client);
    #[cfg(unix)]
    directory.remove_socket(std::path::Path::new("peer.sock"))?;
    Ok(())
}

#[test]
fn unsafe_directories_and_names_are_rejected_without_repair() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let regular = temporary.path().join("file");
    std::fs::write(&regular, b"unchanged")?;
    assert!(SocketDirectory::prepare(&regular).is_err());
    assert_eq!(std::fs::read(&regular)?, b"unchanged");
    let private = temporary.path().join("private");
    let directory = SocketDirectory::create(&private)?;
    std::fs::write(private.join("ordinary-file"), b"keep")?;
    #[cfg(unix)]
    assert!(
        directory
            .remove_socket(std::path::Path::new("ordinary-file"))
            .is_err()
    );
    assert!(
        directory
            .connect(std::path::Path::new("ordinary-file"))
            .is_err()
    );
    assert_eq!(std::fs::read(private.join("ordinary-file"))?, b"keep");
    assert!(SocketDirectory::create(&private).is_err());
    assert_eq!(SocketDirectory::prepare(&private)?.path(), directory.path());
    for name in [
        "",
        "..",
        "../escape.sock",
        "nested/socket",
        "socket\0suffix",
    ] {
        assert!(directory.bind(std::path::Path::new(name)).is_err());
        assert!(directory.connect(std::path::Path::new(name)).is_err());
        #[cfg(unix)]
        assert!(directory.remove_socket(std::path::Path::new(name)).is_err());
    }
    #[cfg(windows)]
    assert!(
        directory
            .bind(std::path::Path::new("socket:stream"))
            .is_err()
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_directory_guard_pins_the_private_path_until_last_clone_drops() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let path = temporary.path().join("private");
    let moved = temporary.path().join("moved");
    let directory = SocketDirectory::create(&path)?;
    let clone = directory.clone();
    drop(directory);
    assert!(std::fs::rename(&path, &moved).is_err());
    drop(clone);
    std::fs::rename(&path, &moved)?;
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_existing_inherited_acl_is_not_silently_replaced() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let inherited = temporary.path().join("inherited");
    std::fs::create_dir(&inherited)?;
    std::fs::write(inherited.join("data"), b"keep")?;
    assert!(SocketDirectory::prepare(&inherited).is_err());
    assert_eq!(std::fs::read(inherited.join("data"))?, b"keep");
    Ok(())
}

#[cfg(windows)]
#[test]
fn named_pipe_lifetime_is_independent_of_same_named_files() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let directory = SocketDirectory::prepare(&temporary.path().join("runtime"))?;
    let name = std::path::Path::new("endpoint.sock");
    let file = directory.socket_path(name)?;
    std::fs::write(&file, b"keep this file")?;
    let listener = directory.bind(name)?;
    let client = directory.connect(name)?;
    let (peer, _) = listener.accept()?;
    assert!(crate::peer_identity(&peer)?.same_user);
    drop(peer);
    drop(client);
    drop(listener);
    assert_eq!(std::fs::read(file)?, b"keep this file");
    Ok(())
}

#[cfg(windows)]
#[test]
fn named_pipe_listener_can_restart_with_a_disconnected_client_handle() -> io::Result<()> {
    let temporary = tempfile::tempdir()?;
    let path = temporary.path().join("restart.sock");
    let listener = IpcListener::bind(&path)?;
    let _client = IpcStream::connect(&path)?;
    let (server, _) = listener.accept()?;
    server.shutdown(std::net::Shutdown::Both)?;
    drop(server);
    drop(listener);
    // The renderer may still hold the old client when a managed generation restarts.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    let _replacement = loop {
        match IpcListener::bind(&path) {
            Ok(listener) => break listener,
            Err(_) if std::time::Instant::now() < deadline => thread::yield_now(),
            Err(error) => return Err(error),
        }
    };
    Ok(())
}

#[cfg(windows)]
#[test]
fn named_pipe_close_interrupts_a_blocked_read_across_clones() -> io::Result<()> {
    let (mut stream, _peer) = IpcStream::pair()?;
    let shutdown = stream.try_clone()?;
    let (started, waiting) = std::sync::mpsc::channel();
    let (finished, result) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        started.send(()).unwrap();
        finished.send(stream.read(&mut [0])).unwrap();
    });
    waiting.recv().unwrap();
    shutdown.shutdown(std::net::Shutdown::Both)?;
    assert!(
        result
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .is_err()
    );
    worker.join().unwrap();
    assert_eq!(
        crate::peer_identity(&shutdown).unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn unix_existing_permissions_symlinks_and_regular_endpoint_files_are_rejected() -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temporary = tempfile::tempdir()?;
    let path = temporary.path().join("private");
    let directory = SocketDirectory::create(&path)?;
    std::fs::write(path.join("not-socket"), b"keep")?;
    assert!(
        directory
            .remove_socket(std::path::Path::new("not-socket"))
            .is_err()
    );
    let link = temporary.path().join("link");
    std::os::unix::fs::symlink(&path, &link)?;
    assert!(SocketDirectory::open(&link).is_err());
    drop(directory);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    assert!(SocketDirectory::prepare(&path).is_err());
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o755
    );
    Ok(())
}
