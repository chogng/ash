use crate::RenderError;
use crate::canvas::Canvas;
use unicode_width::UnicodeWidthStr;

struct Participant {
    id: String,
    label: String,
}
struct Message {
    from: usize,
    to: usize,
    text: String,
    dashed: bool,
}

pub(crate) fn render<'a>(
    lines: impl Iterator<Item = &'a str>,
    width: usize,
) -> Result<Vec<String>, RenderError> {
    let mut participants = Vec::new();
    let mut messages = Vec::new();
    for line in lines {
        if let Some(declaration) = line.strip_prefix("participant ") {
            let (id, label) = declaration
                .split_once(" as ")
                .unwrap_or((declaration, declaration));
            let index = participant(id.trim(), &mut participants)?;
            participants[index].label = crate::label(label)?.into();
            continue;
        }
        let (route, text) = line.split_once(':').ok_or(RenderError::Unsupported)?;
        let (arrow, dashed) = if route.contains("-->>") {
            ("-->>", true)
        } else if route.contains("->>") {
            ("->>", false)
        } else {
            return Err(RenderError::Unsupported);
        };
        let (from, to) = route.split_once(arrow).ok_or(RenderError::Unsupported)?;
        let from = participant(from.trim(), &mut participants)?;
        let to = participant(to.trim(), &mut participants)?;
        if from == to && dashed {
            return Err(RenderError::Unsupported);
        }
        messages.push(Message {
            from,
            to,
            text: crate::label(text)?.into(),
            dashed,
        });
        if messages.len() > 128 {
            return Err(RenderError::Limit);
        }
    }
    if participants.is_empty() {
        return Err(RenderError::Unsupported);
    }
    let box_width = participants
        .iter()
        .map(|p| p.label.width() + 4)
        .max()
        .unwrap();
    let gap = messages
        .iter()
        .map(|m| m.text.width() + 3)
        .max()
        .unwrap_or(4)
        .max(box_width + 3);
    let mut columns = (participants.len() - 1) * gap + box_width;
    for message in messages.iter().filter(|m| m.from == m.to) {
        columns = columns.max(message.from * gap + box_width / 2 + message.text.width() + 5);
    }
    if columns > width {
        return Err(RenderError::Width);
    }
    let rows = 4 + messages
        .iter()
        .map(|m| if m.from == m.to { 5 } else { 3 })
        .sum::<usize>();
    let mut canvas = Canvas::new(columns, rows)?;
    for (index, participant) in participants.iter().enumerate() {
        canvas.box_at(index * gap, 0, box_width, &participant.label)?;
        canvas.path(&[
            (index * gap + box_width / 2, 3),
            (index * gap + box_width / 2, rows - 1),
        ])?;
    }
    let mut y = 4;
    for message in messages {
        let from = message.from * gap + box_width / 2;
        let to = message.to * gap + box_width / 2;
        canvas.text(from.min(to) + 1, y - 1, &message.text)?;
        if from == to {
            let bend = from + message.text.width() + 3;
            canvas.path(&[(from + 1, y), (bend, y), (bend, y + 2), (from + 1, y + 2)])?;
            canvas.arrow(from + 1, y + 2, "◀")?;
            y += 5;
        } else {
            let left = from.min(to) + 1;
            let right = from.max(to) - 1;
            if message.dashed {
                for x in left..=right {
                    if x % 2 == 0 {
                        canvas.text(x, y, "┄")?;
                    }
                }
            } else {
                canvas.path(&[(left, y), (right, y)])?;
            }
            canvas.arrow(
                if from < to { right } else { left },
                y,
                if from < to { "▶" } else { "◀" },
            )?;
            y += 3;
        }
    }
    Ok(canvas.rows())
}

fn participant(id: &str, participants: &mut Vec<Participant>) -> Result<usize, RenderError> {
    if !crate::identifier(id) {
        return Err(RenderError::Unsupported);
    }
    if let Some(index) = participants.iter().position(|p| p.id == id) {
        return Ok(index);
    }
    if participants.len() == 32 {
        return Err(RenderError::Limit);
    }
    participants.push(Participant {
        id: id.into(),
        label: id.into(),
    });
    Ok(participants.len() - 1)
}
