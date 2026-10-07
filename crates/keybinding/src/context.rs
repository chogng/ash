//! Product-neutral boolean and string conditions for shortcut rules.

use std::fmt;

/// One value exposed by a product host to keybinding `when` expressions.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ContextValue {
    Boolean(bool),
    String(String),
}

impl ContextValue {
    fn is_truthy(&self) -> bool {
        matches!(self, Self::Boolean(true))
    }
}

/// A parsed boolean condition used to enable a keybinding in the current product context.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ContextExpression {
    expression: Expression,
}

impl ContextExpression {
    pub const fn always() -> Self {
        Self {
            expression: Expression::Literal(true),
        }
    }

    pub fn key(name: impl Into<String>) -> Self {
        Self {
            expression: Expression::Key(name.into()),
        }
    }

    pub fn parse(source: &str) -> Result<Self, ContextExpressionError> {
        let tokens = tokenize(source)?;
        if tokens.is_empty() {
            return Err(ContextExpressionError::new(0, "an expression is required"));
        }
        let mut parser = Parser::new(tokens);
        let expression = parser.parse_or()?;
        if let Some(token) = parser.peek() {
            return Err(ContextExpressionError::new(
                token.offset,
                "unexpected token after the expression",
            ));
        }
        Ok(Self { expression })
    }

    pub fn evaluate(&self, lookup: impl Fn(&str) -> Option<ContextValue>) -> bool {
        self.expression.evaluate(&lookup)
    }

    pub fn referenced_keys(&self) -> Vec<&str> {
        let mut keys = Vec::new();
        self.expression.collect_keys(&mut keys);
        keys.sort_unstable();
        keys.dedup();
        keys
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum Expression {
    Literal(bool),
    Key(String),
    Equals {
        key: String,
        expected: ContextValue,
        negated: bool,
    },
    Not(Box<Expression>),
    And(Box<Expression>, Box<Expression>),
    Or(Box<Expression>, Box<Expression>),
}

impl Expression {
    fn evaluate(&self, lookup: &impl Fn(&str) -> Option<ContextValue>) -> bool {
        match self {
            Self::Literal(value) => *value,
            Self::Key(key) => lookup(key).is_some_and(|value| value.is_truthy()),
            Self::Equals {
                key,
                expected,
                negated,
            } => lookup(key).is_some_and(|actual| (actual == *expected) != *negated),
            Self::Not(expression) => !expression.evaluate(lookup),
            Self::And(left, right) => left.evaluate(lookup) && right.evaluate(lookup),
            Self::Or(left, right) => left.evaluate(lookup) || right.evaluate(lookup),
        }
    }

    fn collect_keys<'a>(&'a self, keys: &mut Vec<&'a str>) {
        match self {
            Self::Literal(_) => {}
            Self::Key(key) | Self::Equals { key, .. } => keys.push(key),
            Self::Not(expression) => expression.collect_keys(keys),
            Self::And(left, right) | Self::Or(left, right) => {
                left.collect_keys(keys);
                right.collect_keys(keys);
            }
        }
    }
}

/// A syntax error in a keybinding context expression.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextExpressionError {
    offset: usize,
    message: String,
}

impl ContextExpressionError {
    fn new(offset: usize, message: impl Into<String>) -> Self {
        Self {
            offset,
            message: message.into(),
        }
    }

    pub const fn offset(&self) -> usize {
        self.offset
    }
}

impl fmt::Display for ContextExpressionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for ContextExpressionError {}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Token {
    kind: TokenKind,
    offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TokenKind {
    Identifier(String),
    String(String),
    Boolean(bool),
    Not,
    And,
    Or,
    Equal,
    NotEqual,
    LeftParenthesis,
    RightParenthesis,
}

fn tokenize(source: &str) -> Result<Vec<Token>, ContextExpressionError> {
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("cursor must remain on a character boundary");
        if character.is_whitespace() {
            cursor += character.len_utf8();
            continue;
        }
        let remaining = &source[cursor..];
        let (kind, length) = if remaining.starts_with("&&") {
            (TokenKind::And, 2)
        } else if remaining.starts_with("||") {
            (TokenKind::Or, 2)
        } else if remaining.starts_with("==") {
            (TokenKind::Equal, 2)
        } else if remaining.starts_with("!=") {
            (TokenKind::NotEqual, 2)
        } else {
            match character {
                '!' => (TokenKind::Not, 1),
                '(' => (TokenKind::LeftParenthesis, 1),
                ')' => (TokenKind::RightParenthesis, 1),
                '\'' | '"' => {
                    let (value, length) = quoted_string(remaining, character, cursor)?;
                    (TokenKind::String(value), length)
                }
                _ if is_identifier_character(character) => {
                    let length = remaining
                        .char_indices()
                        .take_while(|(_, character)| is_identifier_character(*character))
                        .map(|(offset, character)| offset + character.len_utf8())
                        .last()
                        .unwrap_or(character.len_utf8());
                    let value = &remaining[..length];
                    let kind = match value {
                        "true" => TokenKind::Boolean(true),
                        "false" => TokenKind::Boolean(false),
                        _ => TokenKind::Identifier(value.to_owned()),
                    };
                    (kind, length)
                }
                _ => {
                    return Err(ContextExpressionError::new(
                        cursor,
                        format!("unexpected character `{character}`"),
                    ));
                }
            }
        };
        tokens.push(Token {
            kind,
            offset: cursor,
        });
        cursor += length;
    }
    Ok(tokens)
}

fn quoted_string(
    source: &str,
    quote: char,
    source_offset: usize,
) -> Result<(String, usize), ContextExpressionError> {
    let mut value = String::new();
    let mut escaped = false;
    for (offset, character) in source.char_indices().skip(1) {
        if escaped {
            match character {
                '\\' | '\'' | '"' => value.push(character),
                'n' => value.push('\n'),
                't' => value.push('\t'),
                _ => {
                    return Err(ContextExpressionError::new(
                        source_offset + offset,
                        "unsupported string escape",
                    ));
                }
            }
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            return Ok((value, offset + character.len_utf8()));
        } else {
            value.push(character);
        }
    }
    Err(ContextExpressionError::new(
        source_offset,
        "unterminated string literal",
    ))
}

fn is_identifier_character(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '.' | '-' | '/')
}

struct Parser {
    tokens: Vec<Token>,
    cursor: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, cursor: 0 }
    }

    fn parse_or(&mut self) -> Result<Expression, ContextExpressionError> {
        let mut expression = self.parse_and()?;
        while self.consume(&TokenKind::Or) {
            expression = Expression::Or(Box::new(expression), Box::new(self.parse_and()?));
        }
        Ok(expression)
    }

    fn parse_and(&mut self) -> Result<Expression, ContextExpressionError> {
        let mut expression = self.parse_unary()?;
        while self.consume(&TokenKind::And) {
            expression = Expression::And(Box::new(expression), Box::new(self.parse_unary()?));
        }
        Ok(expression)
    }

    fn parse_unary(&mut self) -> Result<Expression, ContextExpressionError> {
        if self.consume(&TokenKind::Not) {
            return Ok(Expression::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expression, ContextExpressionError> {
        let Some(token) = self.advance() else {
            return Err(ContextExpressionError::new(
                self.end_offset(),
                "an operand is required",
            ));
        };
        match token.kind {
            TokenKind::Boolean(value) => Ok(Expression::Literal(value)),
            TokenKind::Identifier(key) => {
                let operator = self.peek().map(|token| token.kind.clone());
                match operator {
                    Some(TokenKind::Equal) | Some(TokenKind::NotEqual) => {
                        self.cursor += 1;
                        let expected = self.parse_value()?;
                        Ok(Expression::Equals {
                            key,
                            expected,
                            negated: operator == Some(TokenKind::NotEqual),
                        })
                    }
                    _ => Ok(Expression::Key(key)),
                }
            }
            TokenKind::LeftParenthesis => {
                let expression = self.parse_or()?;
                if !self.consume(&TokenKind::RightParenthesis) {
                    return Err(ContextExpressionError::new(
                        self.end_offset(),
                        "a closing parenthesis is required",
                    ));
                }
                Ok(expression)
            }
            _ => Err(ContextExpressionError::new(
                token.offset,
                "an operand is required",
            )),
        }
    }

    fn parse_value(&mut self) -> Result<ContextValue, ContextExpressionError> {
        let Some(token) = self.advance() else {
            return Err(ContextExpressionError::new(
                self.end_offset(),
                "a comparison value is required",
            ));
        };
        match token.kind {
            TokenKind::Boolean(value) => Ok(ContextValue::Boolean(value)),
            TokenKind::Identifier(value) | TokenKind::String(value) => {
                Ok(ContextValue::String(value))
            }
            _ => Err(ContextExpressionError::new(
                token.offset,
                "a comparison value is required",
            )),
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }

    fn advance(&mut self) -> Option<Token> {
        let token = self.peek()?.clone();
        self.cursor += 1;
        Some(token)
    }

    fn consume(&mut self, expected: &TokenKind) -> bool {
        if self.peek().is_some_and(|token| &token.kind == expected) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn end_offset(&self) -> usize {
        self.tokens
            .last()
            .map(|token| token.offset + 1)
            .unwrap_or(0)
    }
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
