use super::RemoteAddressError;
use super::RemoteDirPath;
use super::RemoteProfile;
use super::RemoteRuntime;
use super::SshHost;
use super::SshTarget;

#[test]
fn remote_profile_keeps_credentials_out_of_the_ssh_target() {
    let profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("build-linux").unwrap(),
            RemoteDirPath::parse("/srv/ash/project").unwrap(),
        ),
        RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
    );

    assert_eq!(profile.target().host().as_str(), "build-linux");
    assert_eq!(profile.target().dir().as_str(), "/srv/ash/project");
    assert_eq!(
        profile.runtime().executable(),
        "/opt/ash/bin/ash-remote-server"
    );
}

#[test]
fn ssh_host_rejects_credentials_and_shell_syntax() {
    assert!(SshHost::parse("build-linux").is_ok());
    assert_eq!(
        SshHost::parse("Build-Linux").unwrap().as_str(),
        "build-linux"
    );
    assert!(SshHost::parse("user@build-linux").is_err());
    assert!(SshHost::parse("build-linux; rm").is_err());
    assert!(SshHost::parse("-build-linux").is_err());
    assert!(SshHost::parse("build-linux-").is_err());
}

#[test]
fn dir_path_requires_a_canonical_posix_path() {
    assert!(RemoteDirPath::parse("/srv/ash/project").is_ok());
    assert!(RemoteDirPath::parse("relative/project").is_err());
    assert!(RemoteDirPath::parse("/srv/ash/../project").is_err());
    assert!(RemoteDirPath::parse("/srv/ash/").is_err());
}

#[test]
fn exact_runtime_requires_a_canonical_absolute_posix_executable() {
    assert_eq!(
        RemoteRuntime::new_exact_executable("/srv/ash/runtime/bin/ash-remote-server")
            .unwrap()
            .executable(),
        "/srv/ash/runtime/bin/ash-remote-server"
    );
    for invalid in ["ash", "/", "/srv//ash", "/srv/../ash", "/srv/ash/"] {
        assert_eq!(
            RemoteRuntime::new_exact_executable(invalid),
            Err(RemoteAddressError::InvalidRuntime)
        );
    }
}

#[test]
fn windows_paths_are_normalized_without_using_the_clients_filesystem() {
    for (input, expected) in [
        (
            r"c:\Users\开发者\Ash project",
            "C:/Users/开发者/Ash project",
        ),
        (r"\\server\share\project", "//server/share/project"),
        ("C:/", "C:/"),
    ] {
        let path = RemoteDirPath::parse(input).unwrap();
        assert_eq!(path.as_str(), expected);
        assert_eq!(path.style(), super::RemotePathStyle::Windows);
    }
    for invalid in [
        r"C:relative",
        r"\project",
        r"\\?\C:\project",
        "C:/../project",
        "C:/project/",
        "C://project",
        "C:/file:stream",
        "C:/NUL.txt",
        "C:/NUL .txt",
        "C:/COM¹",
        "C:/x.",
        "C:/x ",
        "C:/x\n",
        "//server",
        "//server/share/../project",
    ] {
        assert!(RemoteDirPath::parse(invalid).is_err(), "{invalid:?}");
    }
    assert!(RemoteRuntime::new_exact_executable("C:/").is_err());
    assert!(RemoteRuntime::new_exact_executable("//server/share").is_err());
    assert_eq!(
        RemoteRuntime::new_exact_executable(r"c:\Program Files\Ash\ash-remote-server.exe")
            .unwrap()
            .executable(),
        "C:/Program Files/Ash/ash-remote-server.exe"
    );
    assert_eq!(
        RemoteDirPath::parse(r"/srv/back\slash").unwrap().as_str(),
        r"/srv/back\slash"
    );
}
