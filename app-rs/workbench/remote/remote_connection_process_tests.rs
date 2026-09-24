use std::path::Path;

use ash_remote_connections::RemoteConnectionName;

use super::remote_connection_command;
use crate::launch_progress::REMOTE_LAUNCH_PROGRESS_ENV;

#[test]
fn process_launch_passes_only_the_canonical_named_connection_without_a_shell() {
    let name = RemoteConnectionName::parse("Build-01").unwrap();
    let command = remote_connection_command(Path::new("/opt/app/bin/app"), &name);

    assert_eq!(command.get_program(), "/opt/app/bin/app");
    assert_eq!(
        command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        vec!["remote", "connect", "build-01"]
    );
    assert_eq!(
        command
            .get_envs()
            .find(|(name, _)| *name == REMOTE_LAUNCH_PROGRESS_ENV)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned()),
        Some("json-lines".into())
    );
}
