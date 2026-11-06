use super::*;

#[test]
fn executable_mapping_identifies_the_loaded_vnode() {
    let path = std::env::current_exe().unwrap();
    let image = running_image_stamp().unwrap();
    assert_eq!(image, FileStamp::read(fs::metadata(path).unwrap()).unwrap());
}

#[test]
fn a_replaced_path_cannot_reuse_the_hashed_inode() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("backend");
    let replacement = directory.path().join("replacement");
    fs::write(&path, b"original").unwrap();
    fs::write(&replacement, b"modified").unwrap();
    let file = File::open(&path).unwrap();
    let executable = VerifiedExecutable {
        stamp: FileStamp::read(file.metadata().unwrap()).unwrap(),
        file,
    };
    executable.check(&path).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert!(executable.check(&path).is_err());
}

#[test]
fn launch_socket_identifies_its_creator() {
    let (_parent, child) = UnixStream::pair().unwrap();
    assert_eq!(
        peer_pid(child.as_fd()).unwrap(),
        std::process::id() as libc::pid_t
    );
}
