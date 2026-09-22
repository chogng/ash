use std::iter::Peekable;
use std::ops::Range;
use std::str::CharIndices;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ParsedWordKind {
    Word,
    RedirectionTarget,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedShellWord {
    pub text: String,
    pub span: Range<usize>,
    pub kind: ParsedWordKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedShellCommand {
    pub words: Vec<ParsedShellWord>,
}

pub(crate) fn parse_shell_commands(input: &str) -> Vec<ParsedShellCommand> {
    ShellLexer::new(input).parse()
}

struct ShellLexer<'a> {
    input: &'a str,
    characters: Peekable<CharIndices<'a>>,
    commands: Vec<ParsedShellCommand>,
    words: Vec<ParsedShellWord>,
    token: String,
    token_start: Option<usize>,
    token_kind: ParsedWordKind,
    quote: Option<char>,
    escaped: bool,
    in_comment: bool,
    redirection_target_pending: bool,
}

impl<'a> ShellLexer<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input,
            characters: input.char_indices().peekable(),
            commands: Vec::new(),
            words: Vec::new(),
            token: String::new(),
            token_start: None,
            token_kind: ParsedWordKind::Word,
            quote: None,
            escaped: false,
            in_comment: false,
            redirection_target_pending: false,
        }
    }

    fn parse(mut self) -> Vec<ParsedShellCommand> {
        while let Some((index, character)) = self.characters.next() {
            if self.in_comment {
                if character == '\n' {
                    self.in_comment = false;
                    self.finish_command(index);
                }
                continue;
            }
            if self.escaped {
                self.push_character(index, character);
                self.escaped = false;
                continue;
            }
            if character == '\\' && self.quote != Some('\'') {
                self.push_character(index, character);
                self.escaped = true;
                continue;
            }
            if matches!(character, '\'' | '"' | '`') {
                self.push_character(index, character);
                if self.quote == Some(character) {
                    self.quote = None;
                } else if self.quote.is_none() {
                    self.quote = Some(character);
                }
                continue;
            }
            if self.quote.is_some() {
                self.push_character(index, character);
                continue;
            }
            if character == '#' && self.token_start.is_none() {
                self.in_comment = true;
                continue;
            }
            if character.is_whitespace() {
                self.finish_token(index);
                if character == '\n' {
                    self.finish_command(index);
                }
                continue;
            }
            if matches!(character, '|' | ';' | '&' | '(' | ')') {
                if character == '&' && self.characters.peek().is_some_and(|(_, next)| *next == '>')
                {
                    self.finish_token(index);
                    self.characters.next();
                    self.redirection_target_pending = true;
                    continue;
                }
                self.finish_token(index);
                if self
                    .characters
                    .peek()
                    .is_some_and(|(_, next)| *next == character && matches!(character, '|' | '&'))
                {
                    self.characters.next();
                }
                self.finish_command(index);
                continue;
            }
            if matches!(character, '<' | '>') {
                self.discard_file_descriptor_or_finish_token(index);
                if self
                    .characters
                    .peek()
                    .is_some_and(|(_, next)| matches!(*next, '<' | '>' | '&'))
                {
                    self.characters.next();
                }
                self.redirection_target_pending = true;
                continue;
            }
            self.push_character(index, character);
        }
        self.finish_token(self.input.len());
        self.finish_command(self.input.len());
        self.commands
    }

    fn push_character(&mut self, index: usize, character: char) {
        if self.token_start.is_none() {
            self.token_start = Some(index);
            self.token_kind = if self.redirection_target_pending {
                self.redirection_target_pending = false;
                ParsedWordKind::RedirectionTarget
            } else {
                ParsedWordKind::Word
            };
        }
        self.token.push(character);
    }

    fn discard_file_descriptor_or_finish_token(&mut self, end: usize) {
        if self
            .token
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            self.token.clear();
            self.token_start = None;
            self.token_kind = ParsedWordKind::Word;
        } else {
            self.finish_token(end);
        }
    }

    fn finish_token(&mut self, end: usize) {
        let Some(start) = self.token_start.take() else {
            return;
        };
        let text = std::mem::take(&mut self.token);
        let kind = self.token_kind;
        self.token_kind = ParsedWordKind::Word;
        if kind == ParsedWordKind::Word
            && text.starts_with('-')
            && let Some(separator) = text.find('=')
        {
            let separator_offset = start + separator;
            self.words.push(ParsedShellWord {
                text: text[..separator].to_owned(),
                span: start..separator_offset,
                kind,
            });
            if separator + 1 < text.len() {
                self.words.push(ParsedShellWord {
                    text: text[separator + 1..].to_owned(),
                    span: separator_offset + 1..end,
                    kind,
                });
            }
        } else if !text.is_empty() {
            self.words.push(ParsedShellWord {
                text,
                span: start..end,
                kind,
            });
        }
    }

    fn finish_command(&mut self, _end: usize) {
        if self.words.is_empty() {
            self.redirection_target_pending = false;
            return;
        }
        self.commands.push(ParsedShellCommand {
            words: std::mem::take(&mut self.words),
        });
        self.redirection_target_pending = false;
    }
}

pub(crate) fn normalized_shell_word(word: &str) -> String {
    let unquoted = if word.len() >= 2
        && ((word.starts_with('\'') && word.ends_with('\''))
            || (word.starts_with('"') && word.ends_with('"'))
            || (word.starts_with('`') && word.ends_with('`')))
    {
        &word[1..word.len() - 1]
    } else {
        word
    };
    let mut normalized = String::with_capacity(unquoted.len());
    let mut escaped = false;
    for character in unquoted.chars() {
        if escaped {
            normalized.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            normalized.push(character);
        }
    }
    if escaped {
        normalized.push('\\');
    }
    normalized
}

pub(crate) fn is_environment_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
