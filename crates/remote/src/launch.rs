use crate::RemoteProfile;

/// Builds the POSIX command executed by OpenSSH for a selected Remote Directory.
pub fn remote_app_server_command(profile: &RemoteProfile) -> String {
    [
        "env".to_owned(),
        format!("ASH_WORKSPACE_ROOT={}", profile.target().dir().as_str()),
        profile.runtime().executable().to_owned(),
        "connect".to_owned(),
    ]
    .into_iter()
    .map(|argument| quote_posix_shell_argument(&argument))
    .collect::<Vec<_>>()
    .join(" ")
}

fn quote_posix_shell_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
