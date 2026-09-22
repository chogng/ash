use crate::RenderError;
use crate::canvas::Canvas;
use unicode_width::UnicodeWidthStr;

struct Node {
    id: String,
    label: String,
}

struct Edge {
    from: usize,
    to: usize,
    label: String,
}

pub(crate) fn render<'a>(
    direction: &str,
    lines: impl Iterator<Item = &'a str>,
    width: usize,
) -> Result<Vec<String>, RenderError> {
    let horizontal = match direction {
        "LR" | "RL" => true,
        "TB" | "TD" | "BT" => false,
        _ => return Err(RenderError::Unsupported),
    };
    let reverse = matches!(direction, "RL" | "BT");
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for line in lines {
        for statement in statements(line)? {
            let (mut from, mut rest) = node(statement.trim(), &mut nodes)?;
            while !rest.trim().is_empty() {
                rest = rest
                    .trim()
                    .strip_prefix("-->")
                    .ok_or(RenderError::Unsupported)?
                    .trim();
                let mut label = "";
                if let Some(after) = rest.strip_prefix('|') {
                    let (text, remaining) =
                        after.split_once('|').ok_or(RenderError::Unsupported)?;
                    label = crate::label(text)?;
                    rest = remaining.trim();
                }
                let (to, remaining) = node(rest, &mut nodes)?;
                edges.push(Edge {
                    from,
                    to,
                    label: label.into(),
                });
                if edges.len() > 128 {
                    return Err(RenderError::Limit);
                }
                from = to;
                rest = remaining;
            }
        }
    }
    if nodes.is_empty() {
        return Err(RenderError::Unsupported);
    }
    let mut rank = vec![0; nodes.len()];
    let mut remaining = vec![0usize; nodes.len()];
    for edge in &edges {
        remaining[edge.to] += 1;
    }
    let mut ready: Vec<usize> = (0..nodes.len()).filter(|&n| remaining[n] == 0).collect();
    let mut visited = 0;
    while let Some(from) = ready.pop() {
        visited += 1;
        for edge in edges.iter().filter(|edge| edge.from == from) {
            rank[edge.to] = rank[edge.to].max(rank[from] + 1);
            remaining[edge.to] -= 1;
            if remaining[edge.to] == 0 {
                ready.push(edge.to);
            }
        }
    }
    if visited != nodes.len() {
        return Err(RenderError::Unsupported);
    }
    let depth = rank.iter().max().copied().unwrap() + 1;
    let mut counts = vec![0; depth];
    for &level in &rank {
        counts[level] += 1;
    }
    let breadth = counts.iter().max().copied().unwrap();
    let box_width = nodes
        .iter()
        .map(|node| node.label.width() + 4)
        .max()
        .unwrap();
    let gap = if horizontal {
        edges
            .iter()
            .map(|edge| edge.label.width() + 4)
            .max()
            .unwrap_or(6)
            .max(6)
    } else {
        5
    };
    let (mut columns, rows) = if horizontal {
        (depth * box_width + (depth - 1) * gap, breadth * 5 - 2)
    } else {
        (breadth * (box_width + 6) - 6, depth * (3 + gap) - gap)
    };
    if columns > width {
        return Err(RenderError::Width);
    }
    let mut placed = vec![0; depth];
    let mut positions = Vec::new();
    for index in 0..nodes.len() {
        let level = rank[index];
        let along = if reverse { depth - 1 - level } else { level };
        let across = placed[level];
        placed[level] += 1;
        let (x, y) = if horizontal {
            (
                along * (box_width + gap),
                across * 5 + (breadth - counts[level]) * 5 / 2,
            )
        } else {
            (
                across * (box_width + 6) + (breadth - counts[level]) * (box_width + 6) / 2,
                along * (3 + gap),
            )
        };
        positions.push((x, y));
    }
    if !horizontal {
        for edge in &edges {
            columns = columns.max(positions[edge.from].0 + box_width / 2 + 2 + edge.label.width());
        }
    }
    if columns > width {
        return Err(RenderError::Width);
    }
    let mut canvas = Canvas::new(columns, rows)?;
    for (node, &(x, y)) in nodes.iter().zip(&positions) {
        canvas.box_at(x, y, box_width, &node.label)?;
    }
    for edge in edges {
        let (a, b) = (positions[edge.from], positions[edge.to]);
        if horizontal {
            let (start, end) = if reverse {
                ((a.0 - 1, a.1 + 1), (b.0 + box_width, b.1 + 1))
            } else {
                ((a.0 + box_width, a.1 + 1), (b.0 - 1, b.1 + 1))
            };
            let mid = (start.0 + end.0) / 2;
            canvas.path(&[start, (mid, start.1), (mid, end.1), end])?;
            canvas.arrow(end.0, end.1, if reverse { "◀" } else { "▶" })?;
            if !edge.label.is_empty() {
                canvas.text(start.0.min(end.0) + 1, start.1 - 1, &edge.label)?;
            }
        } else {
            let (start, end) = if reverse {
                (
                    (a.0 + box_width / 2, a.1 - 1),
                    (b.0 + box_width / 2, b.1 + 3),
                )
            } else {
                (
                    (a.0 + box_width / 2, a.1 + 3),
                    (b.0 + box_width / 2, b.1 - 1),
                )
            };
            let mid = (start.1 + end.1) / 2;
            canvas.path(&[start, (start.0, mid), (end.0, mid), end])?;
            canvas.arrow(end.0, end.1, if reverse { "▲" } else { "▼" })?;
            if !edge.label.is_empty() {
                canvas.text(start.0 + 2, start.1, &edge.label)?;
            }
        }
    }
    Ok(canvas.rows())
}

fn node<'a>(source: &'a str, nodes: &mut Vec<Node>) -> Result<(usize, &'a str), RenderError> {
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
    let mut rest = source[end..].trim_start();
    let label = if let Some(after) = rest.strip_prefix('[') {
        let (text, remaining) = after.split_once(']').ok_or(RenderError::Unsupported)?;
        rest = remaining;
        Some(crate::label(text)?.to_owned())
    } else {
        None
    };
    if let Some(index) = nodes.iter().position(|node| node.id == id) {
        if let Some(label) = label {
            nodes[index].label = label;
        }
        return Ok((index, rest));
    }
    if nodes.len() == 64 {
        return Err(RenderError::Limit);
    }
    nodes.push(Node {
        id: id.into(),
        label: label.unwrap_or_else(|| id.into()),
    });
    Ok((nodes.len() - 1, rest))
}

fn statements(line: &str) -> Result<Vec<&str>, RenderError> {
    let mut bracket = false;
    let mut edge_label = false;
    let mut start = 0;
    let mut result = Vec::new();
    for (index, c) in line.char_indices() {
        match c {
            '[' if !bracket && !edge_label => bracket = true,
            ']' if bracket => bracket = false,
            '|' if !bracket => edge_label = !edge_label,
            ';' if !bracket && !edge_label => {
                let part = line[start..index].trim();
                if !part.is_empty() {
                    result.push(part);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    if bracket || edge_label {
        return Err(RenderError::Unsupported);
    }
    let part = line[start..].trim();
    if !part.is_empty() {
        result.push(part);
    }
    Ok(result)
}
