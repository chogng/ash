use crate::Node;
use crate::TextEdit;
use crate::parse;

/// Reparse a window of top-level blocks and stop only after two unchanged
/// suffix blocks converge with the old tree. Definitions and HTML retain the
/// full parser because their context can affect content outside that window.
pub(crate) fn update(old: &str, new: &str, nodes: &mut Vec<Node>, edits: &[TextEdit]) -> bool {
    let [edit] = edits else { return false };
    if nodes.is_empty() || old.contains(['[', '<']) || new.contains(['[', '<']) {
        return false;
    }
    let index = match crate::SourceIndex::new(old) {
        Ok(index) => index,
        Err(_) => return false,
    };
    let range = match index.byte_range(edit.range) {
        Ok(range) => range,
        Err(_) => return false,
    };
    let first = nodes
        .partition_point(|node| node.source.bytes.end < range.start)
        .saturating_sub(1);
    let last = nodes.partition_point(|node| node.source.bytes.start <= range.end);
    let start = old[..nodes[first].source.bytes.start]
        .rfind('\n')
        .map_or(0, |offset| offset + 1);
    let byte_delta = new.len() as i64 - old.len() as i64;
    let unit_delta =
        edit.text.encode_utf16().count() as i64 - i64::from(edit.range.end - edit.range.start);
    let start_units = match index.byte_to_utf16(start) {
        Ok(offset) => offset,
        Err(_) => return false,
    };
    let mut end_block = (last + 2).min(nodes.len());
    while end_block <= nodes.len() {
        if first == 0 && end_block == nodes.len() {
            return false;
        }
        let old_end = if end_block == nodes.len() {
            old.len()
        } else {
            old[..nodes[end_block].source.bytes.start]
                .rfind('\n')
                .map_or(0, |offset| offset + 1)
        };
        let end = (old_end as i64 + byte_delta) as usize;
        let Ok(mut replacement) = parse(&new[start..end]) else {
            return false;
        };
        for node in &mut replacement {
            shift(node, start as i64, i64::from(start_units));
        }
        let converged = end_block >= 2
            && replacement.len() >= 2
            && replacement[replacement.len() - 2..]
                .iter()
                .zip(&nodes[end_block - 2..end_block])
                .all(|(parsed, old)| {
                    let mut expected = old.clone();
                    shift(&mut expected, byte_delta, unit_delta);
                    *parsed == expected
                });
        if (converged && (first > 0 || end_block < nodes.len()))
            || end_block == nodes.len() && first > 0
        {
            // Reused and newly parsed nodes share the same document-wide budget.
            let count = nodes[..first]
                .iter()
                .chain(&replacement)
                .chain(&nodes[end_block..])
                .map(node_count)
                .sum::<usize>();
            if count > 100_000 {
                return false;
            }
            for node in &mut nodes[end_block..] {
                shift(node, byte_delta, unit_delta);
            }
            nodes.splice(first..end_block, replacement);
            return true;
        }
        if end_block == nodes.len() {
            break;
        }
        // Grow geometrically when a container swallows the suffix.
        end_block = (end_block + (end_block - first).max(2)).min(nodes.len());
    }
    // The caller falls back when no bounded window retains enough context.
    false
}

fn node_count(node: &Node) -> usize {
    1 + node.children.iter().map(node_count).sum::<usize>()
}

fn shift(node: &mut Node, bytes: i64, units: i64) {
    node.source.bytes.start = (node.source.bytes.start as i64 + bytes) as usize;
    node.source.bytes.end = (node.source.bytes.end as i64 + bytes) as usize;
    node.source.utf16.start = (i64::from(node.source.utf16.start) + units) as u32;
    node.source.utf16.end = (i64::from(node.source.utf16.end) + units) as u32;
    for child in &mut node.children {
        shift(child, bytes, units);
    }
}

/// Cache for a host-owned source. It accepts complete authoritative source values,
/// exposes no editing or history methods, and commits a new projection atomically.
#[cfg(any(test, all(feature = "wasm", target_arch = "wasm32")))]
#[derive(Default)]
pub(crate) struct Projection {
    cached: Option<(String, Vec<Node>)>,
}

#[cfg(any(test, all(feature = "wasm", target_arch = "wasm32")))]
impl Projection {
    pub(crate) fn parse(&mut self, source: &str) -> Result<&[Node], crate::Error> {
        crate::check_source_size(source.len())?;
        if let Some((old, nodes)) = &mut self.cached {
            if old == source {
                return Ok(&self.cached.as_ref().expect("cache exists").1);
            }
            let prefix = old
                .chars()
                .zip(source.chars())
                .take_while(|(a, b)| a == b)
                .map(|(ch, _)| ch.len_utf8())
                .sum::<usize>();
            let suffix = old[prefix..]
                .chars()
                .rev()
                .zip(source[prefix..].chars().rev())
                .take_while(|(a, b)| a == b)
                .map(|(ch, _)| ch.len_utf8())
                .sum::<usize>();
            let index = crate::SourceIndex::new(old)?;
            let edit = TextEdit {
                range: crate::Utf16Range {
                    start: index.byte_to_utf16(prefix)?,
                    end: index.byte_to_utf16(old.len() - suffix)?,
                },
                text: source[prefix..source.len() - suffix].to_owned(),
            };
            if update(old, source, nodes, &[edit]) {
                *old = source.to_owned();
                return Ok(&self.cached.as_ref().expect("cache exists").1);
            }
        }
        let nodes = parse(source)?;
        self.cached = Some((source.to_owned(), nodes));
        Ok(&self.cached.as_ref().expect("cache initialized").1)
    }
}
