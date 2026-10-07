//! Command-line parsing and shell command display without product services.

use clap::Parser;
use std::ffi::OsString;

/// Parsing either yields arguments or has already printed help, version, or a usage error.
pub enum ParseOutcome<T> {
    Parsed(T),
    Exit(i32),
}

pub fn parse_arguments<T: Parser>(
    arguments: impl IntoIterator<Item = impl Into<OsString> + Clone>,
) -> ParseOutcome<T> {
    match T::try_parse_from(arguments) {
        Ok(arguments) => ParseOutcome::Parsed(arguments),
        Err(error) => ParseOutcome::Exit(print_error(error)),
    }
}

// Printing depends only on Clap's error, so do not duplicate it for each argument type.
fn print_error(error: clap::Error) -> i32 {
    let code = error.exit_code();
    if error.print().is_ok() { code } else { 1 }
}

/// Formats arguments for the shell used by Ash's reconnect hints.
pub fn format_command(command: &[String]) -> String {
    command
        .iter()
        .map(|argument| quote_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_argument(argument: &str) -> String {
    if !argument.is_empty()
        && argument.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':' | b'@')
        })
    {
        argument.to_owned()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
