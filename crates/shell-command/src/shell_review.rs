//! A restricted, literal subset of shell syntax suitable for permission review.

use ash_execpolicy::ExecPolicyCommand;
use std::path::Path;
use tree_sitter::Node;

#[derive(Debug, Eq, PartialEq)]
pub enum ShellInvocation {
    Direct,
    Literal {
        commands: Vec<ExecPolicyCommand>,
        redirects: Vec<Redirect>,
        login_shell: bool,
    },
    Opaque,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Redirect {
    Read(String),
    Write(String),
}

/// Only explicit interpreter invocations have shell syntax. Direct argv values are literal.
pub fn analyze(program: &str, arguments: &[String]) -> ShellInvocation {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    if !cfg!(windows)
        && matches!(
            program,
            "sh" | "bash"
                | "dash"
                | "/bin/sh"
                | "/bin/bash"
                | "/bin/dash"
                | "/usr/bin/sh"
                | "/usr/bin/bash"
                | "/usr/bin/dash"
        )
    {
        let [option, script] = arguments else {
            return ShellInvocation::Opaque;
        };
        if matches!(option.as_str(), "-c" | "-lc") {
            return parse(script, option == "-lc").unwrap_or(ShellInvocation::Opaque);
        }
    }
    if opaque_program(name)
        || Path::new(program).extension().is_some_and(|suffix| {
            ["bat", "cmd", "ps1", "sh"]
                .iter()
                .any(|extension| suffix.eq_ignore_ascii_case(extension))
        })
    {
        ShellInvocation::Opaque
    } else {
        ShellInvocation::Direct
    }
}

/// The executor inherits a small base environment. Prevent explicit host overrides from adding
/// startup code to the non-login shells whose script is eligible for prefix approval.
pub(super) fn filter_shell_startup(
    program: &str,
    arguments: &[String],
    environment: &mut ash_tool_executor::CommandEnvironment,
) {
    if arguments.first().is_some_and(|argument| argument == "-c")
        && matches!(analyze(program, arguments), ShellInvocation::Literal { .. })
    {
        environment.0.retain(|key, _| {
            !matches!(
                key.as_str(),
                "BASH_ENV" | "ENV" | "BASHOPTS" | "SHELLOPTS" | "BASH_COMPAT" | "POSIXLY_CORRECT"
            ) && !key.starts_with("BASH_FUNC_")
        });
    }
}

fn opaque_program(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash"
            | "dash"
            | "zsh"
            | "ksh"
            | "fish"
            | "ash"
            | "csh"
            | "tcsh"
            | "cmd"
            | "command"
            | "powershell"
            | "pwsh"
            | "env"
            | "busybox"
            | "sudo"
            | "doas"
            | "nohup"
            | "xargs"
            | "timeout"
            | "nice"
            | "setsid"
            | "wsl"
    )
}

fn parse(script: &str, login_shell: bool) -> Option<ShellInvocation> {
    if script.len() > 16_384 || script.contains('\0') {
        return None;
    }
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&ash_grammars::language("bash")?.into())
        .ok()?;
    let tree = parser.parse(script, None)?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    let mut commands = Vec::new();
    let mut redirects = Vec::new();
    visit(root, script, 0, &mut commands, &mut redirects)?;
    (!commands.is_empty()).then_some(ShellInvocation::Literal {
        commands,
        redirects,
        login_shell,
    })
}

fn visit(
    node: Node<'_>,
    script: &str,
    depth: usize,
    commands: &mut Vec<ExecPolicyCommand>,
    redirects: &mut Vec<Redirect>,
) -> Option<()> {
    if depth > 32 || commands.len() >= 64 || redirects.len() >= 64 {
        return None;
    }
    match node.kind() {
        "program" | "list" | "pipeline" | "redirected_statement" => {
            for child in node.children(&mut node.walk()) {
                visit(child, script, depth + 1, commands, redirects)?;
            }
        }
        "command" => {
            let name = node.child_by_field_name("name")?;
            let program = literal(name.named_child(0)?, script)?;
            let name_only = program.rsplit('/').next()?;
            if name_only.is_empty()
                || opaque_program(name_only)
                || matches!(
                    name_only,
                    "." | "source"
                        | "eval"
                        | "exec"
                        | "builtin"
                        | "cd"
                        | "pushd"
                        | "popd"
                        | "trap"
                        | "alias"
                        | "set"
                        | "shopt"
                )
            {
                return None;
            }
            let mut arguments = Vec::new();
            for child in node
                .children(&mut node.walk())
                .filter(|child| *child != name)
            {
                match child.kind() {
                    "file_redirect" => redirects.push(redirect(child, script)?),
                    "comment" => {}
                    _ => arguments.push(literal(child, script)?),
                }
                if redirects.len() >= 64 {
                    return None;
                }
            }
            commands.push(ExecPolicyCommand::new(program, arguments));
        }
        "file_redirect" => redirects.push(redirect(node, script)?),
        "&&" | "||" | "|" | "|&" | ";" | "\n" | "comment" => {}
        _ => return None,
    }
    Some(())
}

fn redirect(node: Node<'_>, script: &str) -> Option<Redirect> {
    let destination = node.child_by_field_name("destination")?;
    let path = literal(destination, script)?;
    if path.is_empty() || path.contains(['\n', '\r']) {
        return None;
    }
    // Requiring a single operand also rules out descriptor duplication and here strings.
    if node
        .children(&mut node.walk())
        .filter(|child| child.kind() == destination.kind())
        .count()
        != 1
    {
        return None;
    }
    let operator = script
        .get(node.start_byte()..destination.start_byte())?
        .trim_end();
    let operator = operator.trim_start_matches(|c: char| c.is_ascii_digit());
    match operator {
        "<" => Some(Redirect::Read(path)),
        ">" | ">>" | ">|" | "&>" | "&>>" => Some(Redirect::Write(path)),
        _ => None,
    }
}

fn literal(node: Node<'_>, script: &str) -> Option<String> {
    let text = script.get(node.byte_range())?;
    match node.kind() {
        "word" | "number"
            if !text.is_empty()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_./:-+=,@%".contains(&byte)) =>
        {
            Some(text.to_owned())
        }
        "raw_string" => Some(text.strip_prefix('\'')?.strip_suffix('\'')?.to_owned()),
        "string" => {
            let text = text.strip_prefix('"')?.strip_suffix('"')?;
            (!text.contains(['$', '`', '\\', '"'])).then(|| text.to_owned())
        }
        _ => None,
    }
}

/// The initial reusable set is deliberately limited to read-only command forms with reviewed flags.
/// Matching a program name alone would let an option or another subcommand enlarge the approval.
pub fn session_prefix(command: &ExecPolicyCommand) -> Option<ExecPolicyCommand> {
    let arguments = command.arguments();
    match command.program() {
        "git"
            if arguments
                .first()
                .is_some_and(|argument| argument == "status")
                && arguments[1..].iter().all(|argument| {
                    matches!(
                        argument.as_str(),
                        "-s" | "--short"
                            | "-b"
                            | "--branch"
                            | "--porcelain"
                            | "--porcelain=v1"
                            | "--porcelain=v2"
                            | "--long"
                            | "--show-stash"
                            | "--ahead-behind"
                            | "--no-ahead-behind"
                            | "--no-renames"
                            | "-uno"
                            | "-unormal"
                            | "-uall"
                            | "--untracked-files=no"
                            | "--untracked-files=normal"
                            | "--untracked-files=all"
                    )
                }) =>
        {
            Some(ExecPolicyCommand::new("git", ["status".into()]))
        }
        "pwd"
            if arguments
                .iter()
                .all(|argument| matches!(argument.as_str(), "-L" | "-P")) =>
        {
            Some(ExecPolicyCommand::new("pwd", []))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "shell_review_tests.rs"]
mod tests;
