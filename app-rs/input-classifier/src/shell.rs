use std::path::Path;
use std::path::PathBuf;

use ash_shell_completion::ShellAlias;
use ash_shell_completion::ShellCompletion;
use ash_shell_completion::ShellCompletionEngine;
use ash_shell_completion::ShellCompletionSnapshot;
use ash_shell_completion::ShellTokenKind;

use crate::rules::is_shell_command_keyword;

#[derive(Clone, Debug)]
pub(super) struct ShellContext {
    engine: ShellCompletionEngine,
}

impl ShellContext {
    pub(super) fn new(working_directory: impl Into<PathBuf>) -> Self {
        Self {
            engine: ShellCompletionEngine::for_working_directory(working_directory),
        }
    }

    pub(super) fn set_working_directory(&mut self, working_directory: &Path) {
        self.engine.set_working_directory(working_directory);
    }

    pub(super) fn set_path_entries(&mut self, entries: impl IntoIterator<Item = PathBuf>) {
        self.engine.set_path_entries(entries);
    }

    pub(super) fn replace_aliases(&mut self, aliases: impl IntoIterator<Item = ShellAlias>) {
        self.engine.replace_aliases(aliases);
    }

    pub(super) fn refresh_dir_catalog(&mut self) {
        self.engine.refresh_dir_catalog();
    }

    pub(super) fn complete(&self, input: &str, cursor: usize) -> Vec<ShellCompletion> {
        self.engine.complete(input, cursor)
    }

    pub(super) fn complete_snapshot(&self, input: &str, cursor: usize) -> ShellCompletionSnapshot {
        self.engine.complete_snapshot(input, cursor)
    }

    pub(super) fn analyze(&self, input: &str) -> ShellTokenSnapshot {
        ShellTokenSnapshot {
            inner: self.engine.analyze(input),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ShellTokenSnapshot {
    inner: ash_shell_completion::ShellTokenSnapshot,
}

impl ShellTokenSnapshot {
    pub(super) fn is_likely_shell_command(&self, word_token_count: usize) -> bool {
        let tokens = self.inner.tokens();
        if tokens.is_empty() {
            return false;
        }
        if tokens.iter().any(|token| {
            token.position().token_index == 0
                && is_shell_command_keyword(&token.text().to_lowercase())
        }) {
            return true;
        }
        let described_count = tokens
            .iter()
            .filter(|token| token.description().is_some())
            .count();
        let last_command_is_known = tokens
            .iter()
            .rev()
            .find(|token| token.position().token_index == 0)
            .is_some_and(is_command_token);
        described_count == tokens.len() || (word_token_count < 3 && last_command_is_known)
    }

    pub(super) fn first_token_is_command(&self) -> bool {
        self.inner.tokens().first().is_some_and(is_command_token)
    }
}

fn is_command_token(token: &ash_shell_completion::ShellToken) -> bool {
    token.description().is_some_and(|description| {
        matches!(
            description.kind(),
            ShellTokenKind::Alias | ShellTokenKind::Command
        )
    })
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
