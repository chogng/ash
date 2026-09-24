use crate::RenderError;
use crate::canvas::Stroke;
use crate::graph::Direction;
use crate::graph::Graph;
use crate::graph::Shape;

pub(crate) fn render<'a>(
    lines: impl Iterator<Item = &'a str>,
    width: usize,
) -> Result<Vec<String>, RenderError> {
    let mut graph = Graph::new(Direction::Down, Shape::Rounded);
    for line in lines {
        if let Some(direction) = line.strip_prefix("direction ") {
            graph.direction = Direction::parse(direction.trim())?;
        } else if let Some(declaration) = line.strip_prefix("state ") {
            if let Some(quoted) = declaration.strip_prefix('"') {
                let (name, rest) = quoted.split_once('"').ok_or(RenderError::Unsupported)?;
                let id = rest
                    .trim()
                    .strip_prefix("as ")
                    .ok_or(RenderError::Unsupported)?
                    .trim();
                state(id, &mut graph)?;
                graph.define(id, crate::label(name)?, Shape::Rounded)?;
            } else {
                state(declaration.trim(), &mut graph)?;
            }
        } else if let Some((from, rest)) = line.split_once("-->") {
            let (to, label) = match rest.split_once(':') {
                Some((to, label)) => (to.trim(), crate::label(label)?),
                None => (rest.trim(), ""),
            };
            let from = if from.trim() == "[*]" {
                graph.define("$start", "", Shape::Start)?
            } else {
                state(from.trim(), &mut graph)?
            };
            let to = if to == "[*]" {
                graph.define("$end", "", Shape::End)?
            } else {
                state(to, &mut graph)?
            };
            graph.connect(from, to, label, Stroke::Solid)?;
        } else if let Some((id, name)) = line.split_once(':') {
            let id = id.trim();
            state(id, &mut graph)?;
            graph.define(id, crate::label(name)?, Shape::Rounded)?;
        } else {
            state(line, &mut graph)?;
        }
    }
    graph.render(width)
}

fn state(id: &str, graph: &mut Graph) -> Result<usize, RenderError> {
    if !crate::identifier(id)
        || matches!(
            id,
            "state" | "note" | "end" | "direction" | "classDef" | "class" | "click"
        )
    {
        return Err(RenderError::Unsupported);
    }
    graph.reference(id)
}
