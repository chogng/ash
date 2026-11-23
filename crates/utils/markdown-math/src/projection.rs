use pulldown_cmark::Event;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use std::collections::BTreeMap;
use std::ops::Range;

/// Protect recognized formulas from Markdown's escape/emphasis processing without
/// changing any byte offsets. The temporary code spans are converted back to math
/// events before consumers see them; editor ranges always address original source.
pub struct MathSource<'a> {
    source: &'a str,
    text: std::borrow::Cow<'a, str>,
    formulas: BTreeMap<usize, (usize, crate::Formula)>,
}

impl<'a> MathSource<'a> {
    pub fn new<E>(
        source: &'a str,
        options: Options,
        enabled: bool,
        check: &impl Fn() -> Result<(), E>,
    ) -> Result<Self, E> {
        let mut text = None::<Vec<u8>>;
        let mut formulas = BTreeMap::new();
        if enabled && (source.contains('$') || source.contains("\\(") || source.contains("\\[")) {
            let mut consumed = 0;
            let mut protected = 0;
            // Only ordinary text can open a formula. Code, images, destinations,
            // HTML and metadata retain their Markdown meaning and never invoke math.
            for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
                check()?;
                if matches!(
                    event,
                    Event::Start(
                        Tag::CodeBlock(_)
                            | Tag::Image { .. }
                            | Tag::HtmlBlock
                            | Tag::MetadataBlock(_)
                    )
                ) {
                    protected = protected.max(range.end);
                }
                if !matches!(event, Event::Text(_)) || range.start < protected {
                    continue;
                }
                let start = if range.start > 0 && source.as_bytes()[range.start - 1] == b'\\' {
                    range.start - 1
                } else {
                    range.start
                };
                let mut index = start.max(consumed);
                while index < range.end {
                    if let Some((length, formula)) = read_math(source, index) {
                        let end = index + length;
                        let text = text.get_or_insert_with(|| source.as_bytes().to_vec());
                        text[index..end].fill(b'x');
                        text[index] = b'`';
                        text[end - 1] = b'`';
                        formulas.insert(index, (end, formula));
                        consumed = end;
                        index = end;
                    } else {
                        let character = source[index..].chars().next().unwrap();
                        index += character.len_utf8();
                        if character == '\\' {
                            index += source[index..].chars().next().map_or(0, char::len_utf8);
                        }
                    }
                }
            }
        }
        Ok(Self {
            source,
            text: match text {
                Some(text) => String::from_utf8(text)
                    .expect("formula masking preserves UTF-8")
                    .into(),
                None => source.into(),
            },
            formulas,
        })
    }

    pub fn events(&self, options: Options) -> impl Iterator<Item = (Event<'_>, Range<usize>)> {
        let mut events = Parser::new_ext(&self.text, options).into_offset_iter();
        let mut pending = std::collections::VecDeque::new();
        std::iter::from_fn(move || {
            if let Some(event) = pending.pop_front() {
                return Some(event);
            }
            let (event, range) = events.next()?;
            if matches!(event, Event::Code(_)) {
                let mut cursor = range.start;
                // Adjacent original code spans can merge with the temporary ones.
                // Recover only those fragments from original source, keeping math
                // opaque and preserving the source ranges of neighboring code.
                for (&start, (end, formula)) in self.formulas.range(range.clone()) {
                    if *end > range.end {
                        continue;
                    }
                    if cursor < start {
                        pending.extend(
                            Parser::new_ext(&self.source[cursor..start], options)
                                .into_offset_iter()
                                .filter(|(event, _)| {
                                    !matches!(
                                        event,
                                        Event::Start(Tag::Paragraph)
                                            | Event::End(pulldown_cmark::TagEnd::Paragraph)
                                    )
                                })
                                .map(|(event, range)| {
                                    (event, range.start + cursor..range.end + cursor)
                                }),
                        );
                    }
                    let event = match formula.display {
                        crate::Display::Inline => Event::InlineMath(formula.source.clone().into()),
                        crate::Display::Block => Event::DisplayMath(formula.source.clone().into()),
                    };
                    pending.push_back((event, start..*end));
                    cursor = *end;
                }
                if !pending.is_empty() {
                    if cursor < range.end {
                        pending.extend(
                            Parser::new_ext(&self.source[cursor..range.end], options)
                                .into_offset_iter()
                                .filter(|(event, _)| {
                                    !matches!(
                                        event,
                                        Event::Start(Tag::Paragraph)
                                            | Event::End(pulldown_cmark::TagEnd::Paragraph)
                                    )
                                })
                                .map(|(event, range)| {
                                    (event, range.start + cursor..range.end + cursor)
                                }),
                        );
                    }
                    return pending.pop_front();
                }
            }
            Some((event, range))
        })
    }
}

/// Delimiters are independent of TeX validity: malformed TeX receives a structured
/// diagnostic, while currency, escapes and incomplete streams remain ordinary text.
fn read_math(source: &str, start: usize) -> Option<(usize, crate::Formula)> {
    use crate::Display;
    use crate::Formula;
    if source[..start]
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'\\')
        .count()
        % 2
        == 1
    {
        return None;
    }
    let tail = &source[start..];
    let (opening, closing, display) = if tail.starts_with("\\(") {
        ("\\(", "\\)", Display::Inline)
    } else if tail.starts_with("\\[") {
        ("\\[", "\\]", Display::Block)
    } else if tail.starts_with("$$") {
        ("$$", "$$", Display::Block)
    } else if tail.starts_with('$') {
        ("$", "$", Display::Inline)
    } else {
        return None;
    };
    if opening.starts_with('$')
        && source[..start]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
    {
        return None;
    }
    if opening == "$"
        && tail[1..]
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || matches!(c, '.' | '('))
    {
        return None;
    }
    let mut index = opening.len();
    let mut units = index;
    while index < tail.len() && units < 20_000 {
        if tail[index..].starts_with(closing) {
            if opening.starts_with('$')
                && tail[index + closing.len()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric)
            {
                return None;
            }
            let value = tail[opening.len()..index].trim();
            if value.is_empty()
                || opening == "$"
                    && (value.contains(['\n', '\r'])
                        || tail[..index]
                            .chars()
                            .next_back()
                            .is_some_and(char::is_whitespace))
            {
                return None;
            }
            return Some((
                index + closing.len(),
                Formula {
                    source: value.into(),
                    display,
                },
            ));
        }
        let character = tail[index..].chars().next().unwrap();
        index += character.len_utf8();
        units += character.len_utf16();
        if character == '\\'
            && let Some(escaped) = tail[index..].chars().next()
        {
            index += escaped.len_utf8();
            units += escaped.len_utf16();
        }
    }
    None
}

/// Unclosed fences stay code while a response or document is still being typed.
pub fn complete_code_fence(source: &str, range: &Range<usize>) -> bool {
    let prefix = source[..range.start]
        .rsplit('\n')
        .next()
        .unwrap_or_default();
    let mut quotes = prefix.bytes().filter(|byte| *byte == b'>').count();
    let mut lines = source[range.clone()].trim_end().lines();
    let Some(opening) = lines.next() else {
        return false;
    };
    let mut opening = opening.trim_start();
    while let Some(rest) = opening.strip_prefix('>') {
        quotes += 1;
        opening = rest.trim_start();
    }
    let Some(marker @ (b'`' | b'~')) = opening.as_bytes().first().copied() else {
        return false;
    };
    let count = opening.bytes().take_while(|byte| *byte == marker).count();
    let Some(closing) = lines.next_back() else {
        return false;
    };
    let mut closing = closing.trim();
    for _ in 0..quotes {
        let Some(rest) = closing.strip_prefix('>') else {
            return false;
        };
        closing = rest.trim_start();
    }
    closing.len() >= count && closing.bytes().all(|byte| byte == marker)
}
