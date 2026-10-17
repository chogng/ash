use crate::RemoteDirPath;
use crate::RemotePathStyle;
use crate::RemoteProfile;
use crate::RemoteRuntime;
use crate::powershell_command;
use crate::quote_powershell_argument;

/// Builds the command executed by OpenSSH using the selected remote path syntax.
pub fn remote_app_server_command(profile: &RemoteProfile) -> String {
    remote_runtime_command(Some(profile.target().dir()), profile.runtime())
}

/// Builds a connection command, clearing any inherited workspace grant when no root is selected.
pub fn remote_runtime_command(dir: Option<&RemoteDirPath>, runtime: &RemoteRuntime) -> String {
    if dir.is_some_and(|dir| dir.style() == RemotePathStyle::Windows)
        || crate::target::is_windows_path(runtime.executable())
    {
        // Start the child with inherited byte streams. PowerShell's native-command
        // pipeline would decode/re-encode protocol bytes using the console code page.
        return powershell_command(&format!(
            "$ErrorActionPreference='Stop'; $env:ASH_WORKSPACE_ROOT={}; $s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName={}; $s.Arguments='connect'; $s.UseShellExecute=$false; $p=[System.Diagnostics.Process]::Start($s); $p.WaitForExit(); exit $p.ExitCode",
            dir.map_or_else(
                || "$null".to_owned(),
                |dir| quote_powershell_argument(dir.as_str())
            ),
            quote_powershell_argument(runtime.executable()),
        ));
    }
    let mut args = vec!["env".to_owned()];
    match dir {
        Some(dir) => args.push(format!("ASH_WORKSPACE_ROOT={}", dir.as_str())),
        None => args.extend(["-u".into(), "ASH_WORKSPACE_ROOT".into()]),
    }
    args.extend([runtime.executable().to_owned(), "connect".to_owned()]);
    args.into_iter()
        .map(|argument| quote_posix_shell_argument(&argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_posix_shell_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
