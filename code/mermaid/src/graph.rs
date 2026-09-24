use crate::RenderError;
use crate::canvas::Canvas;
use crate::canvas::Stroke;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy)]
pub(crate) enum Direction {
    Down,
    Up,
    Right,
    Left,
}

impl Direction {
    pub(crate) fn parse(text: &str) -> Result<Self, RenderError> {
        match text {
            "TD" | "TB" => Ok(Self::Down),
            "BT" => Ok(Self::Up),
            "LR" => Ok(Self::Right),
            "RL" => Ok(Self::Left),
            _ => Err(RenderError::Unsupported),
        }
    }

    fn horizontal(self) -> bool {
        matches!(self, Self::Right | Self::Left)
    }
    fn reverse(self) -> bool {
        matches!(self, Self::Up | Self::Left)
    }
    fn arrow(self) -> &'static str {
        match self {
            Self::Down => "▼",
            Self::Up => "▲",
            Self::Right => "▶",
            Self::Left => "◀",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Shape {
    Rectangle,
    Rounded,
    Decision,
    Start,
    End,
}

struct Node {
    id: String,
    label: String,
    shape: Shape,
}

impl Node {
    fn size(&self) -> (usize, usize) {
        match self.shape {
            Shape::Rectangle | Shape::Rounded => (self.label.width() + 4, 3),
            Shape::Decision => {
                let radius = (self.label.width() + 2).div_ceil(2);
                (2 * radius + 2, 2 * radius + 1)
            }
            Shape::Start | Shape::End => (1, 1),
        }
    }

    fn draw(&self, canvas: &mut Canvas, bounds: Bounds) -> Result<(), RenderError> {
        let Bounds {
            x,
            y,
            width,
            height,
        } = bounds;
        match self.shape {
            Shape::Rectangle => canvas.box_at(x, y, width, &self.label),
            Shape::Rounded => {
                canvas.text(x, y, &format!("╭{}╮", "─".repeat(width - 2)))?;
                canvas.text(
                    x,
                    y + 1,
                    &format!(
                        "│ {}{} │",
                        self.label,
                        " ".repeat(width - self.label.width() - 4)
                    ),
                )?;
                canvas.text(x, y + 2, &format!("╰{}╯", "─".repeat(width - 2)))
            }
            Shape::Decision => {
                let center = height / 2;
                for row in 0..height {
                    if row == center {
                        canvas.text(
                            x,
                            y + row,
                            &format!(
                                "< {}{} >",
                                self.label,
                                " ".repeat(width - self.label.width() - 4)
                            ),
                        )?;
                    } else {
                        let inset = center.abs_diff(row);
                        let (left, right) = if row < center {
                            ("╱", "╲")
                        } else {
                            ("╲", "╱")
                        };
                        canvas.text(x + inset, y + row, left)?;
                        canvas.text(x + width - 1 - inset, y + row, right)?;
                    }
                }
                Ok(())
            }
            Shape::Start => canvas.text(x, y, "●"),
            Shape::End => canvas.text(x, y, "◉"),
        }
    }
}

struct Edge {
    from: usize,
    to: usize,
    label: String,
    stroke: Stroke,
}

#[derive(Clone, Copy)]
struct Bounds {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

pub(crate) struct Graph {
    pub(crate) direction: Direction,
    default_shape: Shape,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

impl Graph {
    pub(crate) fn new(direction: Direction, default_shape: Shape) -> Self {
        Self {
            direction,
            default_shape,
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }

    pub(crate) fn reference(&mut self, id: &str) -> Result<usize, RenderError> {
        if let Some(index) = self.nodes.iter().position(|node| node.id == id) {
            return Ok(index);
        }
        if self.nodes.len() == 64 {
            return Err(RenderError::Limit);
        }
        self.nodes.push(Node {
            id: id.into(),
            label: id.into(),
            shape: self.default_shape,
        });
        Ok(self.nodes.len() - 1)
    }

    pub(crate) fn define(
        &mut self,
        id: &str,
        label: &str,
        shape: Shape,
    ) -> Result<usize, RenderError> {
        let index = self.reference(id)?;
        self.nodes[index].label = label.into();
        self.nodes[index].shape = shape;
        Ok(index)
    }

    pub(crate) fn connect(
        &mut self,
        from: usize,
        to: usize,
        label: &str,
        stroke: Stroke,
    ) -> Result<(), RenderError> {
        if self.edges.len() == 128 {
            return Err(RenderError::Limit);
        }
        self.edges.push(Edge {
            from,
            to,
            label: label.into(),
            stroke,
        });
        Ok(())
    }

    pub(crate) fn render(&self, width: usize) -> Result<Vec<String>, RenderError> {
        if self.nodes.is_empty() {
            return Err(RenderError::Unsupported);
        }
        let rank = self.ranks();
        let depth = rank.iter().max().copied().unwrap() + 1;
        let mut counts = vec![0; depth];
        let mut heights = vec![0; depth];
        for (node, &level) in self.nodes.iter().zip(&rank) {
            counts[level] += 1;
            heights[level] = heights[level].max(node.size().1);
        }
        let breadth = counts.iter().max().copied().unwrap();
        let slot_width = self.nodes.iter().map(|node| node.size().0).max().unwrap();
        let slot_height = heights.iter().max().copied().unwrap();
        let outside = self
            .edges
            .iter()
            .filter(|edge| rank[edge.to] != rank[edge.from] + 1)
            .count();
        let margin = if outside == 0 { 0 } else { outside + 2 };
        let label_width = self
            .edges
            .iter()
            .map(|edge| edge.label.width())
            .max()
            .unwrap_or(0);
        let horizontal = self.direction.horizontal();
        let top = usize::from(horizontal && slot_height == 1 && label_width > 0);
        let gap = if horizontal {
            (label_width + 4).max(6)
        } else {
            5
        }
        .max(2 * outside + 3);
        let mut offsets = vec![0; depth];
        let mut cursor = margin;
        for position in 0..depth {
            let level = if self.direction.reverse() {
                depth - 1 - position
            } else {
                position
            };
            offsets[level] = cursor;
            cursor += if horizontal {
                slot_width
            } else {
                heights[level]
            };
            cursor += gap;
        }
        let extent = cursor - gap + margin;
        let (mut columns, mut rows) = if horizontal {
            (extent, breadth * (slot_height + 2) - 2 + top)
        } else {
            (breadth * (slot_width + 6) - 6, extent)
        };
        let mut placed = vec![0; depth];
        let mut bounds = Vec::new();
        for (node, &level) in self.nodes.iter().zip(&rank) {
            let (node_width, node_height) = match node.shape {
                Shape::Rectangle | Shape::Rounded => (slot_width, 3),
                _ => node.size(),
            };
            let across = placed[level];
            placed[level] += 1;
            let (x, y) = if horizontal {
                (
                    offsets[level] + (slot_width - node_width) / 2,
                    top + across * (slot_height + 2)
                        + (breadth - counts[level]) * (slot_height + 2) / 2
                        + (slot_height - node_height) / 2,
                )
            } else {
                (
                    across * (slot_width + 6)
                        + (breadth - counts[level]) * (slot_width + 6) / 2
                        + (slot_width - node_width) / 2,
                    offsets[level] + (heights[level] - node_height) / 2,
                )
            };
            bounds.push(Bounds {
                x,
                y,
                width: node_width,
                height: node_height,
            });
        }

        let mut paths = Vec::new();
        let mut labels = Vec::new();
        let mut lane = 0;
        let mut rail = if horizontal { rows + 2 } else { columns + 2 };
        for edge in &self.edges {
            let a = bounds[edge.from];
            let b = bounds[edge.to];
            let (start, end) = match self.direction {
                Direction::Down => (
                    (a.x + a.width / 2, a.y + a.height),
                    (b.x + b.width / 2, b.y - 1),
                ),
                Direction::Up => (
                    (a.x + a.width / 2, a.y - 1),
                    (b.x + b.width / 2, b.y + b.height),
                ),
                Direction::Right => (
                    (a.x + a.width, a.y + a.height / 2),
                    (b.x - 1, b.y + b.height / 2),
                ),
                Direction::Left => (
                    (a.x - 1, a.y + a.height / 2),
                    (b.x + b.width, b.y + b.height / 2),
                ),
            };
            let mut points;
            let label;
            if rank[edge.to] == rank[edge.from] + 1 {
                if horizontal {
                    let mid = if self.direction.reverse() {
                        start.0 - 1
                    } else {
                        start.0 + 1
                    };
                    points = vec![start, (mid, start.1), (mid, end.1), end];
                    label = if edge.label.is_empty() {
                        (0, 0)
                    } else {
                        (
                            if self.direction.reverse() {
                                end.0 + 1
                            } else {
                                end.0 - edge.label.width()
                            },
                            end.1 - 1,
                        )
                    };
                } else {
                    let mid = if self.direction.reverse() {
                        (offsets[rank[edge.to]] + heights[rank[edge.to]] + offsets[rank[edge.from]])
                            / 2
                    } else {
                        (offsets[rank[edge.from]]
                            + heights[rank[edge.from]]
                            + offsets[rank[edge.to]])
                            / 2
                    };
                    points = vec![start, (start.0, mid), (end.0, mid), end];
                    label = (
                        end.0 + 2,
                        if self.direction.reverse() {
                            end.1 + 1
                        } else {
                            end.1 - 1
                        },
                    );
                }
            } else {
                let from_offset = offsets[rank[edge.from]];
                let to_offset = offsets[rank[edge.to]];
                let (exit, entry) = if self.direction.reverse() {
                    (
                        from_offset - 2 - lane,
                        to_offset
                            + if horizontal {
                                slot_width
                            } else {
                                heights[rank[edge.to]]
                            }
                            + 1
                            + lane,
                    )
                } else {
                    (
                        from_offset
                            + if horizontal {
                                slot_width
                            } else {
                                heights[rank[edge.from]]
                            }
                            + 1
                            + lane,
                        to_offset - 2 - lane,
                    )
                };
                if horizontal {
                    points = vec![
                        start,
                        (exit, start.1),
                        (exit, rail),
                        (entry, rail),
                        (entry, end.1),
                        end,
                    ];
                    label = (exit.min(entry) + 1, rail + 1);
                    rows = rail + 2;
                    rail += 3;
                } else {
                    points = vec![
                        start,
                        (start.0, exit),
                        (rail, exit),
                        (rail, entry),
                        (end.0, entry),
                        end,
                    ];
                    label = (rail + 2, exit);
                    columns = rail + edge.label.width() + 3;
                    rail = columns + 2;
                }
                lane += 1;
            }
            points.dedup();
            if !edge.label.is_empty() {
                columns = columns.max(label.0 + edge.label.width());
                rows = rows.max(label.1 + 1);
                labels.push((label, edge.label.as_str()));
            }
            paths.push((points, edge.stroke, end));
        }
        if columns > width {
            return Err(RenderError::Width);
        }
        let mut canvas = Canvas::new(columns, rows)?;
        for (node, bounds) in self.nodes.iter().zip(bounds) {
            node.draw(&mut canvas, bounds)?;
        }
        for (points, stroke, _) in &paths {
            canvas.path(points, *stroke)?;
        }
        for (_, _, end) in paths {
            canvas.arrow(end.0, end.1, self.direction.arrow())?;
        }
        for ((x, y), label) in labels {
            canvas.text(x, y, label)?;
        }
        Ok(canvas.rows())
    }

    fn ranks(&self) -> Vec<usize> {
        // DFS identifies return edges; remove only those for ranking, then route them outside.
        fn visit(graph: &Graph, node: usize, state: &mut [u8], returning: &mut [bool]) {
            state[node] = 1;
            for (index, edge) in graph
                .edges
                .iter()
                .enumerate()
                .filter(|(_, edge)| edge.from == node)
            {
                match state[edge.to] {
                    0 => visit(graph, edge.to, state, returning),
                    1 => returning[index] = true,
                    _ => {}
                }
            }
            state[node] = 2;
        }
        let mut state = vec![0; self.nodes.len()];
        let mut returning = vec![false; self.edges.len()];
        for node in 0..self.nodes.len() {
            if state[node] == 0 {
                visit(self, node, &mut state, &mut returning);
            }
        }
        let edges: Vec<_> = self
            .edges
            .iter()
            .zip(returning)
            .filter_map(|(edge, returning)| (!returning).then_some(edge))
            .collect();
        let mut remaining = vec![0usize; self.nodes.len()];
        let mut rank = vec![0; self.nodes.len()];
        for edge in &edges {
            remaining[edge.to] += 1;
        }
        let mut ready: Vec<_> = (0..self.nodes.len())
            .filter(|&node| remaining[node] == 0)
            .collect();
        while let Some(from) = ready.pop() {
            for edge in edges.iter().filter(|edge| edge.from == from) {
                rank[edge.to] = rank[edge.to].max(rank[from] + 1);
                remaining[edge.to] -= 1;
                if remaining[edge.to] == 0 {
                    ready.push(edge.to);
                }
            }
        }
        rank
    }
}
