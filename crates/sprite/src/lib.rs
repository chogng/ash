//! Terminal-cell sprite assets and image-to-block conversion.

#[cfg(feature = "compiler")]
pub mod compiler;

#[cfg(feature = "rust-source")]
mod rust_source;
#[cfg(feature = "sheet")]
mod sheet;

#[cfg(feature = "rust-source")]
pub use rust_source::terminal_sprite_rust_source;
#[cfg(all(feature = "sheet", feature = "rust-source"))]
pub use rust_source::terminal_sprite_sheet_rust_source;
#[cfg(feature = "sheet")]
pub use sheet::CompiledSpriteAction;
#[cfg(feature = "sheet")]
pub use sheet::CompiledSpriteActionStep;
#[cfg(feature = "sheet")]
pub use sheet::CompiledSpriteFrame;
#[cfg(feature = "sheet")]
pub use sheet::CompiledSpriteSheet;
#[cfg(feature = "sheet")]
pub use sheet::compile_sprite_sheet;

use std::error::Error;
use std::fmt;

/// One opaque RGB color used by a terminal sprite.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Rgb {
    red: u8,
    green: u8,
    blue: u8,
}

impl Rgb {
    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }

    pub const fn components(self) -> [u8; 3] {
        [self.red, self.green, self.blue]
    }
}

/// One terminal cell containing a block glyph and optional foreground/background colors.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpriteCell {
    symbol: char,
    foreground: Option<Rgb>,
    background: Option<Rgb>,
}

impl SpriteCell {
    pub const fn new(symbol: char, foreground: Option<Rgb>, background: Option<Rgb>) -> Self {
        Self {
            symbol,
            foreground,
            background,
        }
    }

    pub const fn symbol(self) -> char {
        self.symbol
    }

    pub const fn foreground(self) -> Option<Rgb> {
        self.foreground
    }

    pub const fn background(self) -> Option<Rgb> {
        self.background
    }
}

/// Borrowed terminal sprite suitable for checked-in generated assets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSprite<'a> {
    width: u16,
    height: u16,
    cells: &'a [SpriteCell],
}

impl<'a> TerminalSprite<'a> {
    pub const fn new(width: u16, height: u16, cells: &'a [SpriteCell]) -> Self {
        assert!(cells.len() == width as usize * height as usize);
        Self {
            width,
            height,
            cells,
        }
    }

    pub const fn width(self) -> u16 {
        self.width
    }

    pub const fn height(self) -> u16 {
        self.height
    }

    pub const fn cells(self) -> &'a [SpriteCell] {
        self.cells
    }
}

/// Owned terminal sprite produced by an image or sprite-sheet compiler.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedTerminalSprite {
    width: u16,
    height: u16,
    cells: Vec<SpriteCell>,
}

impl OwnedTerminalSprite {
    pub fn as_sprite(&self) -> TerminalSprite<'_> {
        TerminalSprite::new(self.width, self.height, &self.cells)
    }
}

/// One named frame in an embedded terminal sprite sheet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSpriteFrame<'a> {
    name: &'a str,
    sprite: TerminalSprite<'a>,
}

impl<'a> TerminalSpriteFrame<'a> {
    pub const fn new(name: &'a str, sprite: TerminalSprite<'a>) -> Self {
        Self { name, sprite }
    }

    pub const fn name(self) -> &'a str {
        self.name
    }

    pub const fn sprite(self) -> TerminalSprite<'a> {
        self.sprite
    }
}

/// One timed frame reference in an embedded sprite action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSpriteActionStep {
    frame_index: u16,
    duration_ms: u16,
}

impl TerminalSpriteActionStep {
    pub const fn new(frame_index: u16, duration_ms: u16) -> Self {
        Self {
            frame_index,
            duration_ms,
        }
    }

    pub const fn frame_index(self) -> u16 {
        self.frame_index
    }

    pub const fn duration_ms(self) -> u16 {
        self.duration_ms
    }
}

/// One named action in an embedded terminal sprite sheet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSpriteAction<'a> {
    name: &'a str,
    steps: &'a [TerminalSpriteActionStep],
}

impl<'a> TerminalSpriteAction<'a> {
    pub const fn new(name: &'a str, steps: &'a [TerminalSpriteActionStep]) -> Self {
        Self { name, steps }
    }

    pub const fn name(self) -> &'a str {
        self.name
    }

    pub const fn steps(self) -> &'a [TerminalSpriteActionStep] {
        self.steps
    }
}

/// Borrowed named frames and actions suitable for generated product assets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSpriteSheet<'a> {
    frames: &'a [TerminalSpriteFrame<'a>],
    actions: &'a [TerminalSpriteAction<'a>],
    idle_frame_index: u16,
}

impl<'a> TerminalSpriteSheet<'a> {
    pub const fn new(
        frames: &'a [TerminalSpriteFrame<'a>],
        actions: &'a [TerminalSpriteAction<'a>],
        idle_frame_index: u16,
    ) -> Self {
        assert!((idle_frame_index as usize) < frames.len());
        Self {
            frames,
            actions,
            idle_frame_index,
        }
    }

    pub const fn frames(self) -> &'a [TerminalSpriteFrame<'a>] {
        self.frames
    }

    pub const fn actions(self) -> &'a [TerminalSpriteAction<'a>] {
        self.actions
    }

    pub const fn idle(self) -> TerminalSprite<'a> {
        self.frames[self.idle_frame_index as usize].sprite()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PackError {
    EmptyImage,
    ImageTooLarge,
    PixelCount { expected: usize, actual: usize },
    CellPalette { x: u32, y: u32, colors: usize },
}

impl fmt::Display for PackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyImage => formatter.write_str("source image dimensions must be non-zero"),
            Self::ImageTooLarge => formatter.write_str("terminal sprite dimensions exceed u16"),
            Self::PixelCount { expected, actual } => {
                write!(
                    formatter,
                    "expected {expected} RGBA pixels, received {actual}"
                )
            }
            Self::CellPalette { x, y, colors } => write!(
                formatter,
                "terminal cell ({x}, {y}) cannot encode {colors} opaque colors with its transparency pattern"
            ),
        }
    }
}

impl Error for PackError {}

/// Packs each 2×2 logical pixel block into one Unicode quadrant cell.
pub fn pack_quadrants_rgba(
    width: u32,
    height: u32,
    pixels: &[[u8; 4]],
    alpha_threshold: u8,
) -> Result<OwnedTerminalSprite, PackError> {
    validate_pixels(width, height, pixels)?;
    let cell_width = width.div_ceil(2);
    let cell_height = height.div_ceil(2);
    let cell_count = usize::try_from(u64::from(cell_width) * u64::from(cell_height))
        .map_err(|_| PackError::ImageTooLarge)?;
    let terminal_width = u16::try_from(cell_width).map_err(|_| PackError::ImageTooLarge)?;
    let terminal_height = u16::try_from(cell_height).map_err(|_| PackError::ImageTooLarge)?;
    let mut cells = Vec::with_capacity(cell_count);
    for cell_y in 0..cell_height {
        for cell_x in 0..cell_width {
            let quadrants = [
                pixel_color(
                    pixels,
                    width,
                    height,
                    cell_x * 2,
                    cell_y * 2,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    cell_x * 2 + 1,
                    cell_y * 2,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    cell_x * 2,
                    cell_y * 2 + 1,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    cell_x * 2 + 1,
                    cell_y * 2 + 1,
                    alpha_threshold,
                ),
            ];
            cells.push(
                pack_quadrants(quadrants).ok_or_else(|| PackError::CellPalette {
                    x: cell_x,
                    y: cell_y,
                    colors: opaque_colors(quadrants).len(),
                })?,
            );
        }
    }
    Ok(OwnedTerminalSprite {
        width: terminal_width,
        height: terminal_height,
        cells,
    })
}

/// Packs each 2×4 source-pixel block into one Unicode block-octant cell.
pub fn pack_octants_rgba(
    width: u32,
    height: u32,
    pixels: &[[u8; 4]],
    alpha_threshold: u8,
) -> Result<OwnedTerminalSprite, PackError> {
    validate_pixels(width, height, pixels)?;
    let cell_width = width.div_ceil(2);
    let cell_height = height.div_ceil(4);
    let cell_count = usize::try_from(u64::from(cell_width) * u64::from(cell_height))
        .map_err(|_| PackError::ImageTooLarge)?;
    let terminal_width = u16::try_from(cell_width).map_err(|_| PackError::ImageTooLarge)?;
    let terminal_height = u16::try_from(cell_height).map_err(|_| PackError::ImageTooLarge)?;
    let mut cells = Vec::with_capacity(cell_count);
    for cell_y in 0..cell_height {
        for cell_x in 0..cell_width {
            let source_x = cell_x.checked_mul(2).ok_or(PackError::ImageTooLarge)?;
            let source_y = cell_y.checked_mul(4).ok_or(PackError::ImageTooLarge)?;
            let octants = [
                pixel_color(pixels, width, height, source_x, source_y, alpha_threshold),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x + 1,
                    source_y,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x,
                    source_y + 1,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x + 1,
                    source_y + 1,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x,
                    source_y + 2,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x + 1,
                    source_y + 2,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x,
                    source_y + 3,
                    alpha_threshold,
                ),
                pixel_color(
                    pixels,
                    width,
                    height,
                    source_x + 1,
                    source_y + 3,
                    alpha_threshold,
                ),
            ];
            cells.push(pack_octants(octants).ok_or_else(|| PackError::CellPalette {
                x: cell_x,
                y: cell_y,
                colors: opaque_colors(octants).len(),
            })?);
        }
    }
    Ok(OwnedTerminalSprite {
        width: terminal_width,
        height: terminal_height,
        cells,
    })
}

/// Packs a row-major RGBA image into Unicode half-block cells.
pub fn pack_half_blocks_rgba(
    width: u32,
    height: u32,
    pixels: &[[u8; 4]],
    alpha_threshold: u8,
) -> Result<OwnedTerminalSprite, PackError> {
    validate_pixels(width, height, pixels)?;
    let source_width = width;
    let source_height = height;
    let cell_width = source_width;
    let cell_height = source_height.div_ceil(2);
    let cell_count = usize::try_from(u64::from(cell_width) * u64::from(cell_height))
        .map_err(|_| PackError::ImageTooLarge)?;
    let width = u16::try_from(cell_width).map_err(|_| PackError::ImageTooLarge)?;
    let height = u16::try_from(cell_height).map_err(|_| PackError::ImageTooLarge)?;
    let mut cells = Vec::with_capacity(cell_count);
    for cell_y in 0..u32::from(height) {
        for cell_x in 0..u32::from(width) {
            let top = pixel_color(
                pixels,
                source_width,
                source_height,
                cell_x,
                cell_y * 2,
                alpha_threshold,
            );
            let bottom = pixel_color(
                pixels,
                source_width,
                source_height,
                cell_x,
                cell_y * 2 + 1,
                alpha_threshold,
            );
            cells.push(pack_pair(top, bottom));
        }
    }
    Ok(OwnedTerminalSprite {
        width,
        height,
        cells,
    })
}

fn validate_pixels(width: u32, height: u32, pixels: &[[u8; 4]]) -> Result<(), PackError> {
    if width == 0 || height == 0 {
        return Err(PackError::EmptyImage);
    }
    let expected = usize::try_from(u64::from(width) * u64::from(height))
        .map_err(|_| PackError::ImageTooLarge)?;
    if pixels.len() != expected {
        return Err(PackError::PixelCount {
            expected,
            actual: pixels.len(),
        });
    }
    Ok(())
}

fn pixel_color(
    pixels: &[[u8; 4]],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    alpha_threshold: u8,
) -> Option<Rgb> {
    if x >= width || y >= height {
        return None;
    }
    let pixel = pixels[(y * width + x) as usize];
    (pixel[3] >= alpha_threshold).then(|| Rgb::new(pixel[0], pixel[1], pixel[2]))
}

fn pack_pair(top: Option<Rgb>, bottom: Option<Rgb>) -> SpriteCell {
    match (top, bottom) {
        (None, None) => SpriteCell::new(' ', None, None),
        (Some(color), None) => SpriteCell::new('▀', Some(color), None),
        (None, Some(color)) => SpriteCell::new('▄', Some(color), None),
        (Some(top), Some(bottom)) if top == bottom => SpriteCell::new('█', Some(top), None),
        (Some(top), Some(bottom)) => SpriteCell::new('▀', Some(top), Some(bottom)),
    }
}

fn pack_quadrants(quadrants: [Option<Rgb>; 4]) -> Option<SpriteCell> {
    let colors = opaque_colors(quadrants);
    match colors.as_slice() {
        [] => Some(SpriteCell::new(' ', None, None)),
        [foreground] => {
            let mask = quadrant_color_mask(quadrants, *foreground);
            Some(SpriteCell::new(
                quadrant_symbol(mask),
                Some(*foreground),
                None,
            ))
        }
        [first, second] if quadrants.iter().all(Option::is_some) => {
            let first_count = quadrants
                .iter()
                .filter(|color| **color == Some(*first))
                .count();
            let (foreground, background) = if first_count <= 2 {
                (*first, *second)
            } else {
                (*second, *first)
            };
            let mask = quadrant_color_mask(quadrants, foreground);
            Some(SpriteCell::new(
                quadrant_symbol(mask),
                Some(foreground),
                Some(background),
            ))
        }
        _ => None,
    }
}

fn pack_octants(octants: [Option<Rgb>; 8]) -> Option<SpriteCell> {
    let colors = opaque_colors(octants);
    match colors.as_slice() {
        [] => Some(SpriteCell::new(' ', None, None)),
        [foreground] => {
            let mask = color_mask(octants, *foreground);
            Some(SpriteCell::new(
                octant_symbol(mask),
                Some(*foreground),
                None,
            ))
        }
        [first, second] if octants.iter().all(Option::is_some) => {
            let first_count = octants
                .iter()
                .filter(|color| **color == Some(*first))
                .count();
            let (foreground, background) = if first_count <= 4 {
                (*first, *second)
            } else {
                (*second, *first)
            };
            let mask = color_mask(octants, foreground);
            Some(SpriteCell::new(
                octant_symbol(mask),
                Some(foreground),
                Some(background),
            ))
        }
        _ => None,
    }
}

fn opaque_colors<const N: usize>(pixels: [Option<Rgb>; N]) -> Vec<Rgb> {
    let mut colors = Vec::with_capacity(2);
    for color in pixels.into_iter().flatten() {
        if !colors.contains(&color) {
            colors.push(color);
        }
    }
    colors
}

fn quadrant_color_mask(quadrants: [Option<Rgb>; 4], foreground: Rgb) -> u8 {
    color_mask(quadrants, foreground)
}

fn color_mask<const N: usize>(pixels: [Option<Rgb>; N], foreground: Rgb) -> u8 {
    pixels
        .into_iter()
        .enumerate()
        .fold(0, |mask, (index, color)| {
            mask | u8::from(color == Some(foreground)) << index
        })
}

fn quadrant_symbol(mask: u8) -> char {
    const SYMBOLS: [char; 16] = [
        ' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█',
    ];
    SYMBOLS[usize::from(mask)]
}

fn octant_symbol(mask: u8) -> char {
    OCTANT_SYMBOLS[usize::from(mask)]
}

/// Returns the row-major 2×4 source mask represented by a Unicode block-octant character.
pub fn octant_mask(symbol: char) -> Option<u8> {
    OCTANT_SYMBOLS
        .iter()
        .position(|candidate| *candidate == symbol)
        .and_then(|index| u8::try_from(index).ok())
}

// The table follows Ratatui's row-major convention: bits 0..7 are
// (x=0..1, y=0..3), from top to bottom. Existing block characters are reused
// where Unicode already has an equivalent glyph; the remaining masks use the
// Block Octant characters from Symbols for Legacy Computing.
const OCTANT_SYMBOLS: [char; 256] = [
    ' ', '𜺨', '𜺫', '🮂', '𜴀', '▘', '𜴁', '𜴂', '𜴃', '𜴄', '▝', '𜴅', '𜴆', '𜴇', '𜴈', '▀', '𜴉', '𜴊', '𜴋',
    '𜴌', '🯦', '𜴍', '𜴎', '𜴏', '𜴐', '𜴑', '𜴒', '𜴓', '𜴔', '𜴕', '𜴖', '𜴗', '𜴘', '𜴙', '𜴚', '𜴛', '𜴜', '𜴝',
    '𜴞', '𜴟', '🯧', '𜴠', '𜴡', '𜴢', '𜴣', '𜴤', '𜴥', '𜴦', '𜴧', '𜴨', '𜴩', '𜴪', '𜴫', '𜴬', '𜴭', '𜴮', '𜴯',
    '𜴰', '𜴱', '𜴲', '𜴳', '𜴴', '𜴵', '🮅', '𜺣', '𜴶', '𜴷', '𜴸', '𜴹', '𜴺', '𜴻', '𜴼', '𜴽', '𜴾', '𜴿', '𜵀',
    '𜵁', '𜵂', '𜵃', '𜵄', '▖', '𜵅', '𜵆', '𜵇', '𜵈', '▌', '𜵉', '𜵊', '𜵋', '𜵌', '▞', '𜵍', '𜵎', '𜵏', '𜵐',
    '▛', '𜵑', '𜵒', '𜵓', '𜵔', '𜵕', '𜵖', '𜵗', '𜵘', '𜵙', '𜵚', '𜵛', '𜵜', '𜵝', '𜵞', '𜵟', '𜵠', '𜵡', '𜵢',
    '𜵣', '𜵤', '𜵥', '𜵦', '𜵧', '𜵨', '𜵩', '𜵪', '𜵫', '𜵬', '𜵭', '𜵮', '𜵯', '𜵰', '𜺠', '𜵱', '𜵲', '𜵳', '𜵴',
    '𜵵', '𜵶', '𜵷', '𜵸', '𜵹', '𜵺', '𜵻', '𜵼', '𜵽', '𜵾', '𜵿', '𜶀', '𜶁', '𜶂', '𜶃', '𜶄', '𜶅', '𜶆', '𜶇',
    '𜶈', '𜶉', '𜶊', '𜶋', '𜶌', '𜶍', '𜶎', '𜶏', '▗', '𜶐', '𜶑', '𜶒', '𜶓', '▚', '𜶔', '𜶕', '𜶖', '𜶗', '▐',
    '𜶘', '𜶙', '𜶚', '𜶛', '▜', '𜶜', '𜶝', '𜶞', '𜶟', '𜶠', '𜶡', '𜶢', '𜶣', '𜶤', '𜶥', '𜶦', '𜶧', '𜶨', '𜶩',
    '𜶪', '𜶫', '▂', '𜶬', '𜶭', '𜶮', '𜶯', '𜶰', '𜶱', '𜶲', '𜶳', '𜶴', '𜶵', '𜶶', '𜶷', '𜶸', '𜶹', '𜶺', '𜶻',
    '𜶼', '𜶽', '𜶾', '𜶿', '𜷀', '𜷁', '𜷂', '𜷃', '𜷄', '𜷅', '𜷆', '𜷇', '𜷈', '𜷉', '𜷊', '𜷋', '𜷌', '𜷍', '𜷎',
    '𜷏', '𜷐', '𜷑', '𜷒', '𜷓', '𜷔', '𜷕', '𜷖', '𜷗', '𜷘', '𜷙', '𜷚', '▄', '𜷛', '𜷜', '𜷝', '𜷞', '▙', '𜷟',
    '𜷠', '𜷡', '𜷢', '▟', '𜷣', '▆', '𜷤', '𜷥', '█',
];

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
