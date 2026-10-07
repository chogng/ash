//! Parsing and compilation for terminal-cell sprite frames and actions.

use crate::OwnedTerminalSprite;
use crate::Rgb;
use crate::SpriteCell;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use std::collections::BTreeMap;
use std::path::Path;

const FORMAT_VERSION: &str = "version 2";
const MAX_DIMENSION: u16 = 256;
const MAX_ACTION_STEPS: usize = 8;
const MAX_ACTION_DURATION_MS: u16 = 600;
const MIN_STEP_DURATION_MS: u16 = 25;
const MAX_STEP_DURATION_MS: u16 = 250;
const TRANSPARENT_CELL: SpriteCell = SpriteCell::new(' ', None, None);
const BLOCK_SYMBOLS: &str = "▘▝▀▖▌▞▛▗▚▐▜▄▙▟█▂▆";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SpriteFrameSource {
    pub(crate) name: String,
    pub(crate) cells: Vec<SpriteCell>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SpriteSheetSource {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) frames: Vec<SpriteFrameSource>,
    pub(crate) actions: Vec<SpriteActionSource>,
    pub(crate) idle_frame_index: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SpriteActionSource {
    pub(crate) name: String,
    pub(crate) steps: Vec<CompiledSpriteActionStep>,
}

/// One named, compiled terminal frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledSpriteFrame {
    name: String,
    sprite: OwnedTerminalSprite,
}

impl CompiledSpriteFrame {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn sprite(&self) -> &OwnedTerminalSprite {
        &self.sprite
    }
}

/// One frame reference and duration in a compiled sprite action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompiledSpriteActionStep {
    frame_index: u16,
    duration_ms: u16,
}

impl CompiledSpriteActionStep {
    pub fn frame_index(self) -> u16 {
        self.frame_index
    }

    pub fn duration_ms(self) -> u16 {
        self.duration_ms
    }
}

/// One named sequence of compiled sprite frames.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledSpriteAction {
    name: String,
    steps: Vec<CompiledSpriteActionStep>,
}

impl CompiledSpriteAction {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn steps(&self) -> &[CompiledSpriteActionStep] {
        &self.steps
    }
}

/// Fully validated terminal-cell frames and action timings from one `.sprite` source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledSpriteSheet {
    width: u16,
    height: u16,
    frames: Vec<CompiledSpriteFrame>,
    actions: Vec<CompiledSpriteAction>,
    idle_frame_index: u16,
}

impl CompiledSpriteSheet {
    pub fn dimensions(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    pub fn frames(&self) -> &[CompiledSpriteFrame] {
        &self.frames
    }

    pub fn actions(&self) -> &[CompiledSpriteAction] {
        &self.actions
    }

    pub fn idle_frame_index(&self) -> u16 {
        self.idle_frame_index
    }

    pub fn idle(&self) -> &CompiledSpriteFrame {
        &self.frames[usize::from(self.idle_frame_index)]
    }

    pub fn action(&self, name: &str) -> Option<&CompiledSpriteAction> {
        self.actions.iter().find(|action| action.name == name)
    }
}

/// Parses every terminal cell, named frame, and action in a `.sprite` design source.
pub fn compile_sprite_sheet(path: &Path) -> Result<CompiledSpriteSheet> {
    let source = read_sprite_sheet(path)?;
    let frames = source
        .frames
        .into_iter()
        .map(|frame| CompiledSpriteFrame {
            name: frame.name,
            sprite: OwnedTerminalSprite {
                width: source.width,
                height: source.height,
                cells: frame.cells,
            },
        })
        .collect();
    let actions = source
        .actions
        .into_iter()
        .map(|action| CompiledSpriteAction {
            name: action.name,
            steps: action.steps,
        })
        .collect();
    Ok(CompiledSpriteSheet {
        width: source.width,
        height: source.height,
        frames,
        actions,
        idle_frame_index: source.idle_frame_index,
    })
}

pub(crate) fn read_sprite_sheet(path: &Path) -> Result<SpriteSheetSource> {
    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("read sprite sheet {}", path.display()))?;
    parse_sprite_sheet(path, &contents)
}

fn parse_sprite_sheet(path: &Path, contents: &str) -> Result<SpriteSheetSource> {
    let mut lines = contents.lines().enumerate().peekable();
    let Some((_, version)) = lines.next() else {
        bail!("sprite sheet {} is empty", path.display());
    };
    if version != FORMAT_VERSION {
        bail!(
            "sprite sheet {} line 1 must be '{FORMAT_VERSION}'",
            path.display()
        );
    }
    let (size_line, size) = next_content_line(&mut lines)
        .with_context(|| format!("sprite sheet {} is missing its size", path.display()))?;
    let (width, height) =
        parse_size(size).with_context(|| format!("parse {} line {size_line}", path.display()))?;

    let mut colors = BTreeMap::new();
    let mut cell_kinds = BTreeMap::new();
    let mut frames = Vec::new();
    let mut frame_indices = BTreeMap::new();
    let mut unresolved_actions = Vec::new();
    let mut action_names = BTreeMap::new();
    let mut actions_started = false;

    while let Some((index, line)) = lines.next() {
        let line_number = index + 1;
        if line.is_empty() {
            continue;
        }
        if let Some(entry) = line.strip_prefix("color ") {
            if !cell_kinds.is_empty() || !frames.is_empty() || actions_started {
                bail!(
                    "sprite sheet {} line {line_number} defines a color after its cells or frames",
                    path.display()
                );
            }
            let (symbol, color) = parse_color(entry)
                .with_context(|| format!("parse {} line {line_number}", path.display()))?;
            if colors.insert(symbol, color).is_some() {
                bail!(
                    "sprite sheet {} line {line_number} defines color '{symbol}' more than once",
                    path.display()
                );
            }
            continue;
        }
        if let Some(entry) = line.strip_prefix("cell ") {
            if !frames.is_empty() || actions_started {
                bail!(
                    "sprite sheet {} line {line_number} defines a cell after its frames",
                    path.display()
                );
            }
            let (alias, cell) = parse_cell(entry, &colors)
                .with_context(|| format!("parse {} line {line_number}", path.display()))?;
            if cell_kinds.insert(alias, cell).is_some() {
                bail!(
                    "sprite sheet {} line {line_number} defines cell '{alias}' more than once",
                    path.display()
                );
            }
            continue;
        }
        if let Some(name) = line.strip_prefix("frame ") {
            if actions_started {
                bail!(
                    "sprite sheet {} line {line_number} defines a frame after its actions",
                    path.display()
                );
            }
            validate_name(name)
                .with_context(|| format!("parse {} line {line_number}", path.display()))?;
            if frame_indices.contains_key(name) {
                bail!(
                    "sprite sheet {} line {line_number} defines frame '{name}' more than once",
                    path.display()
                );
            }
            let cells = parse_frame(path, &mut lines, name, width, height, &cell_kinds)?;
            let frame_index =
                u16::try_from(frames.len()).context("sprite frame count exceeds u16")?;
            frame_indices.insert(name.to_owned(), frame_index);
            frames.push(SpriteFrameSource {
                name: name.to_owned(),
                cells,
            });
            continue;
        }
        if let Some(name) = line.strip_prefix("action ") {
            actions_started = true;
            validate_name(name)
                .with_context(|| format!("parse {} line {line_number}", path.display()))?;
            if action_names.insert(name.to_owned(), line_number).is_some() {
                bail!(
                    "sprite sheet {} line {line_number} defines action '{name}' more than once",
                    path.display()
                );
            }
            unresolved_actions.push(parse_action(path, &mut lines, name)?);
            continue;
        }
        bail!(
            "sprite sheet {} line {line_number} must define a color, cell, frame, or action",
            path.display()
        );
    }

    if cell_kinds.is_empty() {
        bail!("sprite sheet {} defines no terminal cells", path.display());
    }
    if frames.is_empty() {
        bail!("sprite sheet {} defines no frames", path.display());
    }
    let Some(&idle_frame_index) = frame_indices.get("idle") else {
        bail!("sprite sheet {} must define frame 'idle'", path.display());
    };
    let actions = resolve_actions(path, unresolved_actions, &frame_indices)?;
    Ok(SpriteSheetSource {
        width,
        height,
        frames,
        actions,
        idle_frame_index,
    })
}

fn next_content_line<'a, I>(lines: &mut std::iter::Peekable<I>) -> Option<(usize, &'a str)>
where
    I: Iterator<Item = (usize, &'a str)>,
{
    lines
        .find(|(_, line)| !line.is_empty())
        .map(|(index, line)| (index + 1, line))
}

fn parse_size(line: &str) -> Result<(u16, u16)> {
    let values = line.split_whitespace().collect::<Vec<_>>();
    if values.len() != 3 || values[0] != "size" {
        bail!("size must use 'size WIDTH HEIGHT'");
    }
    let width = values[1].parse::<u16>().context("parse sprite width")?;
    let height = values[2].parse::<u16>().context("parse sprite height")?;
    if width == 0 || height == 0 {
        bail!("sprite dimensions must be non-zero");
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        bail!("sprite dimensions {width}x{height} exceed the {MAX_DIMENSION}-cell compiler limit");
    }
    Ok((width, height))
}

fn parse_color(entry: &str) -> Result<(char, Rgb)> {
    let values = entry.split_whitespace().collect::<Vec<_>>();
    if values.len() != 2 {
        bail!("color must use 'color SYMBOL #RRGGBB'");
    }
    let symbol = parse_ascii_key(values[0], "color")?;
    let hex = values[1]
        .strip_prefix('#')
        .context("color must use #RRGGBB")?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("color must use #RRGGBB");
    }
    Ok((
        symbol,
        Rgb::new(
            u8::from_str_radix(&hex[0..2], 16).context("parse red color component")?,
            u8::from_str_radix(&hex[2..4], 16).context("parse green color component")?,
            u8::from_str_radix(&hex[4..6], 16).context("parse blue color component")?,
        ),
    ))
}

fn parse_cell(entry: &str, colors: &BTreeMap<char, Rgb>) -> Result<(char, SpriteCell)> {
    let values = entry.split_whitespace().collect::<Vec<_>>();
    if values.len() != 4 {
        bail!("cell must use 'cell ALIAS GLYPH FOREGROUND BACKGROUND'");
    }
    let alias = parse_ascii_key(values[0], "cell")?;
    let symbol = if values[1] == "space" {
        ' '
    } else {
        let mut symbols = values[1].chars();
        let Some(symbol) = symbols.next() else {
            bail!("cell glyph must not be empty");
        };
        if symbols.next().is_some() || !BLOCK_SYMBOLS.contains(symbol) {
            bail!("cell glyph must be 'space' or one classic Unicode block character");
        }
        symbol
    };
    let foreground = parse_cell_color(values[2], colors, "foreground")?;
    let background = parse_cell_color(values[3], colors, "background")?;
    if symbol == ' ' && background.is_none() {
        bail!("space cells must define a background color");
    }
    if symbol != ' ' && foreground.is_none() && background.is_none() {
        bail!("visible block cells must define a foreground or background color");
    }
    Ok((alias, SpriteCell::new(symbol, foreground, background)))
}

fn parse_ascii_key(value: &str, kind: &str) -> Result<char> {
    let mut symbols = value.chars();
    let Some(symbol) = symbols.next() else {
        bail!("{kind} symbol must not be empty");
    };
    if symbols.next().is_some() || symbol == '.' || symbol.is_whitespace() || !symbol.is_ascii() {
        bail!("{kind} symbol must be one non-whitespace ASCII character other than '.'");
    }
    Ok(symbol)
}

fn parse_cell_color(value: &str, colors: &BTreeMap<char, Rgb>, role: &str) -> Result<Option<Rgb>> {
    if value == "." {
        return Ok(None);
    }
    let symbol = parse_ascii_key(value, role)?;
    colors
        .get(&symbol)
        .copied()
        .map(Some)
        .with_context(|| format!("cell {role} uses undefined color '{symbol}'"))
}

fn parse_frame<'a, I>(
    path: &Path,
    lines: &mut std::iter::Peekable<I>,
    name: &str,
    width: u16,
    height: u16,
    cell_kinds: &BTreeMap<char, SpriteCell>,
) -> Result<Vec<SpriteCell>>
where
    I: Iterator<Item = (usize, &'a str)>,
{
    let mut cells = Vec::with_capacity(usize::from(width) * usize::from(height));
    let mut row_count = 0usize;
    for (index, row) in lines.by_ref() {
        let line_number = index + 1;
        if row == "end" {
            if row_count != usize::from(height) {
                bail!(
                    "sprite sheet {} frame '{name}' has {row_count} rows; expected {height}",
                    path.display()
                );
            }
            return Ok(cells);
        }
        if row.is_empty() {
            bail!(
                "sprite sheet {} line {line_number} must not be empty inside frame '{name}'",
                path.display()
            );
        }
        if row_count >= usize::from(height) {
            bail!(
                "sprite sheet {} frame '{name}' has more than {height} rows",
                path.display()
            );
        }
        let row_width = row.chars().count();
        if row_width != usize::from(width) {
            bail!(
                "sprite sheet {} line {line_number} in frame '{name}' has width {row_width}; expected {width}",
                path.display()
            );
        }
        for alias in row.chars() {
            if alias == '.' {
                cells.push(TRANSPARENT_CELL);
            } else if let Some(cell) = cell_kinds.get(&alias) {
                cells.push(*cell);
            } else {
                bail!(
                    "sprite sheet {} line {line_number} in frame '{name}' uses undefined cell '{alias}'",
                    path.display()
                );
            }
        }
        row_count += 1;
    }
    bail!(
        "sprite sheet {} frame '{name}' is missing its end",
        path.display()
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct UnresolvedAction {
    name: String,
    steps: Vec<(String, u16, usize)>,
}

fn parse_action<'a, I>(
    path: &Path,
    lines: &mut std::iter::Peekable<I>,
    name: &str,
) -> Result<UnresolvedAction>
where
    I: Iterator<Item = (usize, &'a str)>,
{
    let mut steps = Vec::new();
    let mut total_duration = 0u16;
    for (index, line) in lines.by_ref() {
        let line_number = index + 1;
        if line == "end" {
            if steps.is_empty() {
                bail!(
                    "sprite sheet {} action '{name}' has no steps",
                    path.display()
                );
            }
            return Ok(UnresolvedAction {
                name: name.to_owned(),
                steps,
            });
        }
        if line.is_empty() {
            bail!(
                "sprite sheet {} line {line_number} must not be empty inside action '{name}'",
                path.display()
            );
        }
        if steps.len() == MAX_ACTION_STEPS {
            bail!(
                "sprite sheet {} action '{name}' exceeds {MAX_ACTION_STEPS} steps",
                path.display()
            );
        }
        let values = line.split_whitespace().collect::<Vec<_>>();
        if values.len() != 2 {
            bail!(
                "sprite sheet {} line {line_number} action step must use 'FRAME DURATION_MS'",
                path.display()
            );
        }
        validate_name(values[0])
            .with_context(|| format!("parse {} line {line_number}", path.display()))?;
        let duration_ms = values[1]
            .parse::<u16>()
            .with_context(|| format!("parse {} line {line_number} duration", path.display()))?;
        if !(MIN_STEP_DURATION_MS..=MAX_STEP_DURATION_MS).contains(&duration_ms)
            || duration_ms % MIN_STEP_DURATION_MS != 0
        {
            bail!(
                "sprite sheet {} line {line_number} duration must be a multiple of {MIN_STEP_DURATION_MS}ms between {MIN_STEP_DURATION_MS}ms and {MAX_STEP_DURATION_MS}ms",
                path.display()
            );
        }
        total_duration = total_duration
            .checked_add(duration_ms)
            .context("sprite action duration exceeds u16")?;
        if total_duration > MAX_ACTION_DURATION_MS {
            bail!(
                "sprite sheet {} action '{name}' exceeds {MAX_ACTION_DURATION_MS}ms",
                path.display()
            );
        }
        steps.push((values[0].to_owned(), duration_ms, line_number));
    }
    bail!(
        "sprite sheet {} action '{name}' is missing its end",
        path.display()
    )
}

fn resolve_actions(
    path: &Path,
    actions: Vec<UnresolvedAction>,
    frame_indices: &BTreeMap<String, u16>,
) -> Result<Vec<SpriteActionSource>> {
    actions
        .into_iter()
        .map(|action| {
            let steps = action
                .steps
                .into_iter()
                .map(|(frame, duration_ms, line_number)| {
                    if frame == "idle" {
                        bail!(
                            "sprite sheet {} line {line_number} action '{}' must not reference idle; actions return to idle automatically",
                            path.display(),
                            action.name
                        );
                    }
                    let Some(&frame_index) = frame_indices.get(&frame) else {
                        bail!(
                            "sprite sheet {} line {line_number} action '{}' references unknown frame '{frame}'",
                            path.display(),
                            action.name
                        );
                    };
                    Ok(CompiledSpriteActionStep {
                        frame_index,
                        duration_ms,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(SpriteActionSource {
                name: action.name,
                steps,
            })
        })
        .collect()
}

fn validate_name(name: &str) -> Result<()> {
    let mut segments = name.split('-');
    if name.is_empty()
        || segments.any(|segment| {
            segment.is_empty()
                || !segment.starts_with(|character: char| character.is_ascii_lowercase())
                || !segment
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
    {
        bail!("name '{name}' must use lowercase kebab-case");
    }
    Ok(())
}

#[cfg(test)]
#[path = "sheet_tests.rs"]
mod tests;
