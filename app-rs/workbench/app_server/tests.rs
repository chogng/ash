use std::path::Path;
use std::path::PathBuf;

use super::AppServerHost;
use super::local_app_server_command;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_daemon::APP_SERVER_PATH_ENV;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;

#[test]
fn ssh_app_server_host_retargets_the_same_backend_to_another_dir() {
    let host = AppServerHost::remote_with_executable(
        RemoteProfile::new(
            SshTarget::new(
                SshHost::parse("build-linux").unwrap(),
                RemoteDirPath::parse("/srv/ash").unwrap(),
            ),
            RemoteRuntime::new("ash-remote-server").unwrap(),
        ),
        None,
    );

    assert_eq!(host.cwd(), Path::new("/srv/ash"));
    let (ssh_host, ssh_executable) = host.ssh_transport().unwrap();
    assert_eq!(ssh_host.as_str(), "build-linux");
    assert_eq!(ssh_executable, Path::new("ssh"));
    let switched = host.with_cwd(Path::new("/srv/other")).unwrap();
    assert_eq!(switched.cwd(), Path::new("/srv/other"));
    let (switched_host, _) = switched.ssh_transport().unwrap();
    assert_eq!(switched_host.as_str(), "build-linux");
}

#[test]
fn local_app_server_host_connects_through_the_profile_dir_broker() {
    let executable = PathBuf::from("/opt/ash/app");
    let backend = PathBuf::from("/opt/ash/ash-app-server");
    let profile = PathBuf::from("/profiles/ash");
    let dir = PathBuf::from("/dirs/project");
    let command = local_app_server_command(
        executable.clone(),
        profile.clone(),
        &dir,
        Some(backend.clone()),
    );

    assert_eq!(command.executable(), executable);
    assert_eq!(
        command.arguments_as_strings(),
        ["app-server-daemon", "connect"]
    );
    assert_eq!(
        command,
        StdioAppServerCommand::new("/opt/ash/app")
            .with_argument("app-server-daemon")
            .with_argument("connect")
            .with_environment_variable("ASH_HOME", profile.into_os_string())
            .with_environment_variable("ASH_WORKSPACE_ROOT", "/dirs/project")
            .with_environment_variable(APP_SERVER_PATH_ENV, backend.into_os_string()),
    );
    assert_eq!(
        AppServerHost::local(dir)
            .with_cwd(Path::new("/dirs/other"))
            .unwrap()
            .cwd(),
        Path::new("/dirs/other"),
    );
}
