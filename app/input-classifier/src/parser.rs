use std::iter::Peekable;
use std::mem;
use std::str::Chars;

/// Parses prose-like input while retaining complete quoted spans as one token.
pub(super) fn parse_query_into_tokens(query: &str) -> Vec<String> {
    SentenceParser {
        chars: query.chars().peekable(),
        active_delimiter: None,
        active_token: String::new(),
    }
    .collect()
}

#[derive(PartialEq, Eq)]
enum WordDelimiter {
    Separator,
    DoubleQuote,
    SingleQuote,
    Backtick,
    Whitespace,
}

fn convert_char_to_delimiter(character: char) -> Option<WordDelimiter> {
    match character {
        '\'' => Some(WordDelimiter::SingleQuote),
        '"' => Some(WordDelimiter::DoubleQuote),
        '`' => Some(WordDelimiter::Backtick),
        ',' | '.' | '!' | '?' => Some(WordDelimiter::Separator),
        character if character.is_whitespace() => Some(WordDelimiter::Whitespace),
        _ => None,
    }
}

struct SentenceParser<'a> {
    chars: Peekable<Chars<'a>>,
    active_delimiter: Option<WordDelimiter>,
    active_token: String,
}

impl Iterator for SentenceParser<'_> {
    type Item = String;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(character) = self.chars.next() {
            let delimiter = convert_char_to_delimiter(character);
            let next_delimiter = self
                .chars
                .peek()
                .map(|character| convert_char_to_delimiter(*character));

            match delimiter {
                Some(WordDelimiter::Whitespace) if self.active_delimiter.is_none() => {
                    if self.active_token.is_empty() {
                        continue;
                    }
                    return Some(mem::take(&mut self.active_token));
                }
                Some(WordDelimiter::Separator) if self.active_delimiter.is_none() => {
                    if self.active_token.is_empty() {
                        continue;
                    }
                    if next_delimiter
                        .map(|delimiter| delimiter == Some(WordDelimiter::Whitespace))
                        .unwrap_or(true)
                    {
                        return Some(mem::take(&mut self.active_token));
                    }
                    self.active_token.push(character);
                }
                Some(WordDelimiter::DoubleQuote) => {
                    let complete = if self.active_delimiter == Some(WordDelimiter::DoubleQuote) {
                        self.active_delimiter = None;
                        true
                    } else if !self.active_token.is_empty() || self.active_delimiter.is_some() {
                        false
                    } else {
                        self.active_delimiter = Some(WordDelimiter::DoubleQuote);
                        false
                    };
                    self.active_token.push(character);
                    if complete {
                        let token = mem::take(&mut self.active_token);
                        if token == "\"\"" {
                            continue;
                        }
                        return Some(token);
                    }
                }
                Some(WordDelimiter::SingleQuote) => {
                    let complete = if self.active_delimiter == Some(WordDelimiter::SingleQuote) {
                        self.active_delimiter = None;
                        true
                    } else if !self.active_token.is_empty() || self.active_delimiter.is_some() {
                        false
                    } else {
                        self.active_delimiter = Some(WordDelimiter::SingleQuote);
                        false
                    };
                    self.active_token.push(character);
                    if complete {
                        let token = mem::take(&mut self.active_token);
                        if token == "''" {
                            continue;
                        }
                        return Some(token);
                    }
                }
                Some(WordDelimiter::Backtick) => {
                    let complete = if self.active_delimiter == Some(WordDelimiter::Backtick) {
                        self.active_delimiter = None;
                        true
                    } else if !self.active_token.is_empty() || self.active_delimiter.is_some() {
                        false
                    } else {
                        self.active_delimiter = Some(WordDelimiter::Backtick);
                        false
                    };
                    self.active_token.push(character);
                    if complete {
                        return Some(mem::take(&mut self.active_token));
                    }
                }
                _ => self.active_token.push(character),
            }
        }

        (!self.active_token.is_empty()).then(|| mem::take(&mut self.active_token))
    }
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
