use crate::RenderError;
use crate::canvas::Stroke;
use crate::graph::Direction;
use crate::graph::Graph;
use crate::graph::Shape;

pub(crate) fn render<'a>(
    direction: &str,
    lines: impl Iterator<Item = &'a str>,
    width: usize,
) -> Result<Vec<String>, RenderError> {
    let mut graph = Graph::new(Direction::parse(direction)?, Shape::Rectangle);
    for line in lines {
        for statement in statements(line)? {
            let (mut from, mut rest) = node(statement, &mut graph)?;
            while !rest.trim().is_empty() {
                let (after, stroke) = if let Some(after) = rest.trim().strip_prefix("-->") {
                    (after, Stroke::Solid)
                } else if let Some(after) = rest.trim().strip_prefix("-.->") {
                    (after, Stroke::Dashed)
                } else {
                    return Err(RenderError::Unsupported);
                };
                rest = after.trim();
                let mut label = "";
                if let Some(after) = rest.strip_prefix('|') {
                    let (text, remaining) = enclosed(after, '|')?;
                    label = crate::label(text)?;
                    rest = remaining.trim();
                }
                let (to, remaining) = node(rest, &mut graph)?;
                graph.connect(from, to, label, stroke)?;
                from = to;
                rest = remaining;
            }
        }
    }
    graph.render(width)
}

fn node<'a>(source: &'a str, graph: &mut Graph) -> Result<(usize, &'a str), RenderError> {
    let end = source
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(source.len());
    let id = &source[..end];
    if !crate::identifier(id)
        || matches!(
            id,
            "end"
                | "subgraph"
                | "style"
                | "classDef"
                | "class"
                | "click"
                | "direction"
                | "linkStyle"
        )
    {
        return Err(RenderError::Unsupported);
    }
    let rest = source[end..].trim_start();
    let shape = match rest.as_bytes().first() {
        Some(b'[') => Some((']', Shape::Rectangle)),
        Some(b'(') => Some((')', Shape::Rounded)),
        Some(b'{') => Some(('}', Shape::Decision)),
        _ => None,
    };
    if let Some((closing, shape)) = shape {
        let (text, rest) = enclosed(&rest[1..], closing)?;
        let label = crate::label(text)?;
        Ok((graph.define(id, label, shape)?, rest))
    } else {
        Ok((graph.reference(id)?, rest))
    }
}

fn enclosed(source: &str, closing: char) -> Result<(&str, &str), RenderError> {
    let mut quoted = false;
    for (index, c) in source.char_indices() {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted {
            if c == closing {
                return Ok((&source[..index], &source[index + c.len_utf8()..]));
            }
            // Nested delimiters name other Mermaid shapes, outside this subset.
            if matches!(c, '[' | ']' | '(' | ')' | '{' | '}') {
                return Err(RenderError::Unsupported);
            }
        }
    }
    Err(RenderError::Unsupported)
}

fn statements(line: &str) -> Result<Vec<&str>, RenderError> {
    let mut closing = None;
    let mut quoted = false;
    let mut start = 0;
    let mut result = Vec::new();
    for (index, c) in line.char_indices() {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted {
            match closing {
                Some(end) if c == end => closing = None,
                Some(_) => {}
                None => match c {
                    '[' => closing = Some(']'),
                    '(' => closing = Some(')'),
                    '{' => closing = Some('}'),
                    '|' => closing = Some('|'),
                    ';' => {
                        let part = line[start..index].trim();
                        if !part.is_empty() {
                            result.push(part);
                        }
                        start = index + 1;
                    }
                    _ => {}
                },
            }
        }
    }
    if closing.is_some() || quoted {
        return Err(RenderError::Unsupported);
    }
    let part = line[start..].trim();
    if !part.is_empty() {
        result.push(part);
    }
    Ok(result)
}
