use std::io;
use std::io::Read;
use std::io::Write;
use std::thread;

use crate::SocketDirectory;
use crate::UnixListener;
use crate::UnixStream;

#[test]
fn exchanges_bytes_over_socket_path() -> io::Result<()> {
    let socket_directory = tempfile::tempdir()?;
    let socket_path = socket_directory.path().join("round-trip.sock");
    let listener = UnixListener::bind(&socket_path)?;

    let server = thread::spawn(move || -> io::Result<()> {
        let (mut stream, _) = listener.accept()?;
        let mut request = [0; 4];
        stream.read_exact(&mut request)?;
        assert_eq!(&request, b"ping");
        stream.write_all(b"pong")?;
        Ok(())
    });

    let mut client = UnixStream::connect(&socket_path)?;
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
