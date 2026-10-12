use super::TerminalArguments;
use super::profiles::ShellKind;
use super::profiles::TerminalProfileSpec;
use std::collections::HashMap;
use std::io;
use tempfile::TempDir;

/// Keeps injected startup files alive until the PTY has finished reading output.
pub(super) struct ShellIntegration {
    pub(super) args: TerminalArguments,
    pub(super) environment: HashMap<String, String>,
    pub(super) nonce: Option<String>,
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
            nonce: None,
        };
        if profile.shell_kind() == ShellKind::PowerShell {
            if let TerminalArguments::Argv(args) = &mut launch.args
                && !args.iter().any(|arg| {
                    matches!(
                        arg.to_ascii_lowercase().as_str(),
                        "-c" | "-command" | "-file" | "-f" | "-encodedcommand" | "-ec"
                    )
                })
            {
                let nonce = new_nonce()?;
                args.extend([
                    "-NoExit".into(),
                    "-Command".into(),
                    POWERSHELL.replace("__ASH_SHELL_NONCE__", &nonce),
                ]);
                launch.nonce = Some(nonce);
            }
            return Ok(launch);
        }
        // Raw Windows profile arguments keep their original representation.
        if !matches!(profile.shell_kind(), ShellKind::Zsh | ShellKind::Bash)
            || matches!(profile.args, TerminalArguments::CommandLine(_))
        {
            return Ok(launch);
        }
        if let TerminalArguments::Argv(args) = &profile.args
            && args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "-c" | "-lc" | "-ic" | "--norc" | "--rcfile" | "--init-file"
                )
            })
        {
            return Ok(launch);
        }
        let nonce = new_nonce()?;
        let directory = tempfile::Builder::new().prefix("ash-shell-").tempdir()?;
        let path = directory.path();
        if profile.shell_kind() == ShellKind::Zsh {
            std::fs::write(
                path.join(".zshenv"),
                ZSH_ENV.replace("__ASH_SHELL_NONCE__", &nonce),
            )?;
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
            let path = path.to_string_lossy().replace('\\', "/");
            launch.environment.insert("ZDOTDIR".into(), path.clone());
            launch
                .environment
                .insert("ASH_SHELL_DIRECTORY".into(), path);
            let TerminalArguments::Argv(args) = &mut launch.args else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "raw command lines require Windows",
                ));
            };
            args.push("-i".into());
        } else {
            let rc = path.join("bashrc");
            std::fs::write(&rc, BASH_RC.replace("__ASH_SHELL_NONCE__", &nonce))?;
            let TerminalArguments::Argv(profile_args) = &profile.args else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "raw command lines require Windows",
                ));
            };
            let mut args = vec![
                "--rcfile".into(),
                rc.to_string_lossy().replace('\\', "/"),
                "-i".into(),
            ];
            let login = profile_args
                .iter()
                .any(|arg| matches!(arg.as_str(), "-l" | "--login" | "-il" | "-li"));
            if login {
                launch
                    .environment
                    .insert("ASH_SHELL_LOGIN".into(), "1".into());
            }
            if profile_args.iter().any(|arg| arg == "--noprofile") {
                launch
                    .environment
                    .insert("ASH_SHELL_SKIP_PROFILE".into(), "1".into());
            }
            args.extend(
                profile_args
                    .iter()
                    .filter(|arg| {
                        !matches!(
                            arg.as_str(),
                            "-l" | "--login" | "-il" | "-li" | "-i" | "--noprofile"
                        )
                    })
                    .cloned(),
            );
            launch.args = TerminalArguments::Argv(args);
        }
        launch.directory = Some(directory);
        launch.nonce = Some(nonce);
        Ok(launch)
    }
}

fn new_nonce() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// Restore the user's startup path before sourcing each file, including changes
// made by .zshenv/.zprofile. Later login/logout files use the restored ZDOTDIR.
const ZSH_ENV: &str = r#"
__ash_nonce='__ASH_SHELL_NONCE__'
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
__ash_osc_value() {
    local LC_ALL=C value=$1 char code index
    for ((index=0; index<${#value}; index++)); do
        char=${value:$index:1}
        if [[ $char == '\' ]]; then
            builtin printf '\\\\'
        elif [[ $char == ';' || $char < '!' ]]; then
            builtin printf -v code '%d' "'$char"
            builtin printf '\\x%02x' "$code"
        else
            builtin printf '%s' "$char"
        fi
    done
}
__ash_command_started() {
    builtin printf '\033]633;E;%s;%s\007\033]633;C\007' "$(__ash_osc_value "$1")" "$__ash_nonce"
}
__ash_command_finished() {
    local result=$?
    builtin printf '\033]633;D;%s\007\033]633;A\007' "$result"
    builtin printf '\033]633;P;Cwd=%s;%s\007' "$(__ash_osc_value "$PWD")" "$__ash_nonce"
    return "$result"
}
builtin printf '\033]633;P;HasRichCommandDetection=True\007'
typeset -ga preexec_functions precmd_functions
preexec_functions=(__ash_command_started ${preexec_functions:#__ash_command_started})
precmd_functions=(__ash_command_finished ${precmd_functions:#__ash_command_finished})
PS1="${PS1-}"$'%{\e]633;B\a%}'
"#;

const BASH_RC: &str = r#"
__ash_nonce='__ASH_SHELL_NONCE__'
# --rcfile is ignored by a login Bash, so preserve login startup in this wrapper.
if [[ ${ASH_SHELL_LOGIN-} == 1 ]]; then
    if [[ ${ASH_SHELL_SKIP_PROFILE-} != 1 ]]; then
        [[ -r /etc/profile ]] && source /etc/profile
        for __ash_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
            if [[ -r $__ash_profile ]]; then source "$__ash_profile"; break; fi
        done
        unset __ash_profile
    fi
else
    [[ -r $HOME/.bashrc ]] && source "$HOME/.bashrc"
fi
unset ASH_SHELL_LOGIN ASH_SHELL_SKIP_PROFILE
__ash_osc_value() {
    local LC_ALL=C value=$1 char code index
    for ((index=0; index<${#value}; index++)); do
        char=${value:$index:1}
        if [[ $char == '\' ]]; then
            builtin printf '\\\\'
        elif [[ $char == ';' || $char < '!' ]]; then
            builtin printf -v code '%d' "'$char"
            builtin printf '\\x%02x' "$code"
        else
            builtin printf '%s' "$char"
        fi
    done
}
__ash_prompt_commands=("${PROMPT_COMMAND[@]-}")
__ash_history_index=0
__ash_at_prompt=0
__ash_inside_prompt=0
__ash_restore_status() { return "$1"; }
__ash_command_started() {
    local entry
    entry=$(HISTTIMEFORMAT= builtin history 1)
    # Ignored input and disabled history leave the index unchanged. Never reuse
    # the previous history entry as the text of a new execution.
    if [[ $entry =~ ^[[:space:]]*([0-9]+)[[:space:]][[:space:]](.*)$ && ${BASH_REMATCH[1]} != "$__ash_history_index" ]]; then
        builtin printf '\033]633;E;%s;%s\007' "$(__ash_osc_value "${BASH_REMATCH[2]}")" "$__ash_nonce"
    fi
    builtin printf '\033]633;C\007'
}
__ash_prompt() {
    local result=$? command entry
    __ash_inside_prompt=1
    builtin printf '\033]633;D;%s\007\033]633;A\007' "$result"
    for command in "${__ash_prompt_commands[@]-}"; do
        __ash_restore_status "$result"
        eval "$command"
        result=$?
    done
    builtin printf '\033]633;P;Cwd=%s;%s\007' "$(__ash_osc_value "$PWD")" "$__ash_nonce"
    __ash_inside_prompt=0
    __ash_at_prompt=1
    entry=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $entry =~ ^[[:space:]]*([0-9]+)[[:space:]] ]]; then __ash_history_index=${BASH_REMATCH[1]}; fi
}
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
    # PS0 expands after a complete command is read; existing DEBUG traps stay intact.
    PS0='$(__ash_command_started)'${PS0-}
    builtin printf '\033]633;P;HasRichCommandDetection=True\007'
elif [[ -z $(trap -p DEBUG) ]]; then
    # Bash 3.2 has no PS0. Do not replace a user's DEBUG trap to emulate it.
    __ash_before_command() {
        if [[ $__ash_at_prompt == 1 && $__ash_inside_prompt == 0 && $BASH_COMMAND != __ash_prompt ]]; then
            __ash_at_prompt=0
            __ash_command_started
        fi
    }
    trap '__ash_before_command' DEBUG
    builtin printf '\033]633;P;HasRichCommandDetection=True\007'
fi
PROMPT_COMMAND=__ash_prompt
PS1="${PS1-}"$'\[\e]633;B\a\]'
"#;

// PSConsoleHostReadLine returns a complete accepted command, including multiline
// input. Without that host hook, leave command detection unavailable.
const POWERSHELL: &str = r#"
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
    $global:__AshNonce = '__ASH_SHELL_NONCE__'
    function global:__AshOscValue($value) {
        [regex]::Replace($value, '[\x00-\x20\\;]', {
            param($match) '\x{0:x2}' -f [int][char]$match.Value
        })
    }
    $global:__AshReadLine = $function:PSConsoleHostReadLine
    $global:__AshPrompt = $function:prompt
    $global:__AshCommandActive = $false
    if (Test-Path Function:PSConsoleHostReadLine) {
      [Console]::Write("$([char]27)]633;P;HasRichCommandDetection=True$([char]7)")
      function global:PSConsoleHostReadLine {
        $line = $global:__AshReadLine.Invoke()
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $global:__AshCommandActive = $true
            $command = __AshOscValue $line
            [Console]::Write("$([char]27)]633;E;$command;$global:__AshNonce$([char]7)$([char]27)]633;C$([char]7)")
        }
        $line
      }
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
        [Console]::Write("$([char]27)]633;A$([char]7)")
        if ($pwd.Provider.Name -eq 'FileSystem') {
            $directory = __AshOscValue $pwd.ProviderPath
            [Console]::Write("$([char]27)]633;P;Cwd=$directory;$global:__AshNonce$([char]7)")
        }
        # Preserve $? for prompts that render the last command's status.
        if (-not $succeeded) { Write-Error 'command failed' -ErrorAction Ignore }
        $global:__AshPrompt.Invoke()
        "$([char]27)]633;B$([char]7)"
    }
}
"#;
