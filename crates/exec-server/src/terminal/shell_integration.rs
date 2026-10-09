use super::profiles::TerminalProfileSpec;
use std::collections::HashMap;
use std::io;
use tempfile::TempDir;

/// Keeps injected startup files alive until the PTY has finished reading output.
pub(super) struct ShellIntegration {
    pub(super) args: Vec<String>,
    pub(super) environment: HashMap<String, String>,
    directory: Option<TempDir>,
}

impl ShellIntegration {
    pub(super) fn prepare(
        profile: &TerminalProfileSpec,
        environment: &HashMap<String, String>,
    ) -> io::Result<Self> {
        let mut launch = Self {
            args: profile.launch_args(),
            environment: environment.clone(),
            directory: None,
        };
        // Windows shell startup and paths follow their existing profile integration.
        if cfg!(windows) || !matches!(profile.profile_id.as_str(), "zsh" | "bash") {
            return Ok(launch);
        }
        let directory = tempfile::Builder::new().prefix("ash-shell-").tempdir()?;
        let path = directory.path();
        if profile.profile_id == "zsh" {
            std::fs::write(path.join(".zshenv"), ZSH_ENV)?;
            std::fs::write(path.join(".zprofile"), ZSH_PROFILE)?;
            std::fs::write(path.join(".zshrc"), ZSH_RC)?;
            launch.environment.insert(
                "ASH_SHELL_USER_ZDOTDIR".into(),
                environment.get("ZDOTDIR").cloned().unwrap_or_default(),
            );
            launch.environment.insert(
                "ASH_SHELL_USER_ZDOTDIR_SET".into(),
                if environment.contains_key("ZDOTDIR") {
                    "1"
                } else {
                    "0"
                }
                .into(),
            );
            let path = path.to_string_lossy().into_owned();
            launch.environment.insert("ZDOTDIR".into(), path.clone());
            launch
                .environment
                .insert("ASH_SHELL_DIRECTORY".into(), path);
            launch.args.push("-i".into());
        } else {
            let rc = path.join("bashrc");
            std::fs::write(&rc, BASH_RC)?;
            launch.args = vec![
                "--rcfile".into(),
                rc.to_string_lossy().into_owned(),
                "-i".into(),
            ];
            launch.args.extend(profile.args.iter().cloned());
        }
        launch.directory = Some(directory);
        Ok(launch)
    }
}

// Restore the user's startup path before sourcing each file, including changes
// made by .zshenv/.zprofile. Later login/logout files use the restored ZDOTDIR.
const ZSH_ENV: &str = r#"
if [[ $ASH_SHELL_USER_ZDOTDIR_SET == 1 ]]; then
    ZDOTDIR=$ASH_SHELL_USER_ZDOTDIR
else
    unset ZDOTDIR
fi
[[ -r ${ZDOTDIR-$HOME}/.zshenv ]] && source "${ZDOTDIR-$HOME}/.zshenv"
__ash_zdotdir=${ZDOTDIR-$HOME}
__ash_zdotdir_set=${+ZDOTDIR}
ZDOTDIR=$ASH_SHELL_DIRECTORY
"#;

const ZSH_PROFILE: &str = r#"
if [[ $__ash_zdotdir_set == 1 ]]; then ZDOTDIR=$__ash_zdotdir; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR-$HOME}/.zprofile ]] && source "${ZDOTDIR-$HOME}/.zprofile"
__ash_zdotdir=${ZDOTDIR-$HOME}
__ash_zdotdir_set=${+ZDOTDIR}
ZDOTDIR=$ASH_SHELL_DIRECTORY
"#;

const ZSH_RC: &str = r#"
if [[ $__ash_zdotdir_set == 1 ]]; then ZDOTDIR=$__ash_zdotdir; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR-$HOME}/.zshrc ]] && source "${ZDOTDIR-$HOME}/.zshrc"
unset ASH_SHELL_USER_ZDOTDIR ASH_SHELL_USER_ZDOTDIR_SET ASH_SHELL_DIRECTORY
unset __ash_zdotdir __ash_zdotdir_set
__ash_command_started() { builtin printf '\033]633;C\007'; }
__ash_command_finished() {
    local result=$?
    builtin printf '\033]633;D;%s\007' "$result"
    return "$result"
}
preexec_functions=(__ash_command_started ${preexec_functions:#__ash_command_started})
precmd_functions=(__ash_command_finished ${precmd_functions:#__ash_command_finished})
"#;

const BASH_RC: &str = r#"
[[ -r $HOME/.bashrc ]] && source "$HOME/.bashrc"
__ash_prompt_commands=("${PROMPT_COMMAND[@]}")
__ash_at_prompt=0
__ash_inside_prompt=0
__ash_restore_status() { return "$1"; }
__ash_prompt() {
    local result=$? command
    __ash_inside_prompt=1
    builtin printf '\033]633;D;%s\007' "$result"
    for command in "${__ash_prompt_commands[@]}"; do
        __ash_restore_status "$result"
        eval "$command"
        result=$?
    done
    __ash_inside_prompt=0
    __ash_at_prompt=1
}
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
    # PS0 expands after a complete command is read; existing DEBUG traps stay intact.
    PS0=$'\033]633;C\007'${PS0-}
elif [[ -z $(trap -p DEBUG) ]]; then
    # Bash 3.2 has no PS0. Do not replace a user's DEBUG trap to emulate it.
    __ash_before_command() {
        if [[ $__ash_at_prompt == 1 && $__ash_inside_prompt == 0 && $BASH_COMMAND != __ash_prompt ]]; then
            __ash_at_prompt=0
            builtin printf '\033]633;C\007'
        fi
    }
    trap '__ash_before_command' DEBUG
fi
PROMPT_COMMAND=__ash_prompt
"#;

// PSConsoleHostReadLine returns a complete accepted command, including multiline
// input. Without that host hook, leave command detection unavailable.
pub(super) const POWERSHELL: &str = r#"
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage' -and
    (Test-Path Function:PSConsoleHostReadLine)) {
    $global:__AshReadLine = $function:PSConsoleHostReadLine
    $global:__AshPrompt = $function:prompt
    $global:__AshCommandActive = $false
    function global:PSConsoleHostReadLine {
        $line = $global:__AshReadLine.Invoke()
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $global:__AshCommandActive = $true
            [Console]::Write("$([char]27)]633;C$([char]7)")
        }
        $line
    }
    function global:prompt {
        $succeeded = $?
        if ($global:__AshCommandActive) {
            $global:__AshCommandActive = $false
            # PowerShell pipelines report success through $?, independently of
            # stale LASTEXITCODE values left by earlier external programs.
            $result = [int](-not $succeeded)
            [Console]::Write("$([char]27)]633;D;$result$([char]7)")
        }
        # Preserve $? for prompts that render the last command's status.
        if (-not $succeeded) { Write-Error 'command failed' -ErrorAction Ignore }
        $global:__AshPrompt.Invoke()
    }
}
"#;
