use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use ash_sprite::CompiledSpriteSheet;
use ash_sprite::compile_sprite_sheet;
use ash_sprite::compiler::ansi_preview;
use ash_sprite::compiler::rasterize;
use ash_sprite::compiler::source_dimensions;
use ash_sprite::pack_octants_rgba;
use ash_sprite::terminal_sprite_rust_source;
use ash_sprite::terminal_sprite_sheet_rust_source;
use clap::Parser;
use std::io;
use std::io::IsTerminal;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Parser)]
#[command(about = "Compile terminal-cell sprite sheets or convert images into Unicode sprites")]
struct Args {
    /// SVG, PNG, or terminal-cell .sprite design source.
    input: PathBuf,

    /// For `.sprite`: `frames` prints every frame; an action name plays that action.
    preview: Option<String>,

    /// Output width in terminal cells.
    #[arg(long, value_parser = positive_u32)]
    columns: Option<u32>,

    /// Output height in terminal cells.
    #[arg(long, value_parser = positive_u32)]
    rows: Option<u32>,

    /// Write a checked-in Rust sprite constant to this path.
    #[arg(long = "rust")]
    rust_output: Option<PathBuf>,

    /// Verify the checked-in Rust sprite instead of writing it.
    #[arg(long, requires = "rust_output")]
    check: bool,

    /// Rust constant name used with --rust.
    #[arg(long, default_value = "PET", value_parser = constant_name)]
    name: String,

    /// For SVG or PNG conversion, alpha values below this threshold become transparent.
    #[arg(long, default_value_t = 128, value_parser = clap::value_parser!(u8).range(1..))]
    alpha_threshold: u8,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if has_extension(&args.input, "sprite") {
        return run_sprite_sheet(&args);
    }
    if let Some(preview) = &args.preview {
        bail!("preview selection '{preview}' is only supported for a named .sprite source");
    }
    let (source_width, source_height) = source_dimensions(&args.input)?;
    let (columns, rows) =
        terminal_dimensions(source_width, source_height, args.columns, args.rows)?;
    let (raster_width, raster_height) = raster_dimensions(columns, rows)?;
    let image = rasterize(&args.input, raster_width, raster_height)?;
    let sprite = pack_octants_rgba(
        image.width,
        image.height,
        &image.pixels,
        args.alpha_threshold,
    )?;

    if !args.check {
        print!("{}", ansi_preview(sprite.as_sprite()));
        eprintln!(
            "{}x{} source -> {}x{} raster pixels -> {}x{} terminal cells",
            source_width, source_height, raster_width, raster_height, columns, rows
        );
    }

    if let Some(path) = args.rust_output {
        let source = terminal_sprite_rust_source(&args.name, &sprite);
        if args.check {
            check_rust_output(&path, &source)?;
            eprintln!("checked {}", path.display());
        } else {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create output directory {}", parent.display()))?;
            }
            std::fs::write(&path, source)
                .with_context(|| format!("write Rust sprite {}", path.display()))?;
            eprintln!("wrote {}", path.display());
        }
    }
    Ok(())
}

fn run_sprite_sheet(args: &Args) -> Result<()> {
    if args.columns.is_some() || args.rows.is_some() {
        bail!("named .sprite sources use their exact terminal canvas and cannot be resized");
    }
    let sheet = compile_sprite_sheet(&args.input)?;
    if !args.check {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        match args.preview.as_deref() {
            None => output.write_all(ansi_preview(sheet.idle().sprite().as_sprite()).as_bytes())?,
            Some("frames") => write_frames(&mut output, &sheet)?,
            Some(action_name) => {
                let action = sheet.action(action_name).ok_or_else(|| {
                    anyhow::anyhow!("sprite sheet defines no action '{action_name}'")
                })?;
                write_action(&mut output, &sheet, action.steps(), stdout.is_terminal())?;
            }
        }
        let sprite = sheet.idle().sprite().as_sprite();
        eprintln!(
            "{} frames, {} actions -> {}x{} terminal cells",
            sheet.frames().len(),
            sheet.actions().len(),
            sprite.width(),
            sprite.height()
        );
    }

    if let Some(path) = &args.rust_output {
        let source = terminal_sprite_sheet_rust_source(&args.name, &sheet);
        if args.check {
            check_rust_output(path, &source)?;
            eprintln!("checked {}", path.display());
        } else {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create output directory {}", parent.display()))?;
            }
            std::fs::write(path, source)
                .with_context(|| format!("write Rust sprite sheet {}", path.display()))?;
            eprintln!("wrote {}", path.display());
        }
    }
    Ok(())
}

fn write_frames(output: &mut impl Write, sheet: &CompiledSpriteSheet) -> io::Result<()> {
    for (index, frame) in sheet.frames().iter().enumerate() {
        if index > 0 {
            writeln!(output)?;
        }
        writeln!(output, "{}", frame.name())?;
        output.write_all(ansi_preview(frame.sprite().as_sprite()).as_bytes())?;
    }
    Ok(())
}

fn write_action(
    output: &mut impl Write,
    sheet: &CompiledSpriteSheet,
    steps: &[ash_sprite::CompiledSpriteActionStep],
    animate: bool,
) -> io::Result<()> {
    if !animate {
        for step in steps {
            let frame = &sheet.frames()[usize::from(step.frame_index())];
            writeln!(output, "{} {}ms", frame.name(), step.duration_ms())?;
            output.write_all(ansi_preview(frame.sprite().as_sprite()).as_bytes())?;
        }
        writeln!(output, "idle")?;
        output.write_all(ansi_preview(sheet.idle().sprite().as_sprite()).as_bytes())?;
        return Ok(());
    }

    let height = sheet.idle().sprite().as_sprite().height();
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            write!(output, "\x1b[{height}A")?;
        }
        let frame = &sheet.frames()[usize::from(step.frame_index())];
        output.write_all(ansi_preview(frame.sprite().as_sprite()).as_bytes())?;
        output.flush()?;
        std::thread::sleep(Duration::from_millis(u64::from(step.duration_ms())));
    }
    write!(output, "\x1b[{height}A")?;
    output.write_all(ansi_preview(sheet.idle().sprite().as_sprite()).as_bytes())?;
    output.flush()
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

fn check_rust_output(path: &Path, expected: &str) -> Result<()> {
    let actual = std::fs::read_to_string(path)
        .with_context(|| format!("read Rust sprite {}", path.display()))?;
    if actual != expected {
        bail!(
            "Rust sprite {} is out of date; regenerate it without --check",
            path.display()
        );
    }
    Ok(())
}

fn terminal_dimensions(
    source_width: u32,
    source_height: u32,
    columns: Option<u32>,
    rows: Option<u32>,
) -> Result<(u32, u32)> {
    let dimensions = match (columns, rows) {
        (Some(columns), Some(rows)) => (columns, rows),
        (Some(columns), None) => (
            columns,
            ceil_ratio(
                u64::from(columns) * u64::from(source_height),
                u64::from(source_width) * 2,
            ),
        ),
        (None, Some(rows)) => (
            ceil_ratio(
                u64::from(rows) * u64::from(source_width) * 2,
                u64::from(source_height),
            ),
            rows,
        ),
        (None, None) => (source_width, source_height.div_ceil(2)),
    };
    if dimensions.0 == 0 || dimensions.1 == 0 {
        bail!("terminal sprite dimensions must be non-zero");
    }
    if dimensions.0 > u32::from(u16::MAX) || dimensions.1 > u32::from(u16::MAX) {
        bail!("terminal sprite dimensions exceed u16");
    }
    Ok(dimensions)
}

fn raster_dimensions(columns: u32, rows: u32) -> Result<(u32, u32)> {
    Ok((
        columns
            .checked_mul(2)
            .context("terminal sprite width is too large")?,
        rows.checked_mul(4)
            .context("terminal sprite height is too large")?,
    ))
}

fn ceil_ratio(numerator: u64, denominator: u64) -> u32 {
    u32::try_from(numerator.div_ceil(denominator).max(1)).unwrap_or(u32::MAX)
}

fn positive_u32(value: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|error| error.to_string())
        .and_then(|value| {
            if value == 0 {
                Err("value must be greater than zero".into())
            } else {
                Ok(value)
            }
        })
}

fn constant_name(value: &str) -> Result<String, String> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err("constant name must not be empty".into());
    };
    if !(first.is_ascii_uppercase() || first == '_')
        || !chars.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
    {
        return Err("constant name must be an uppercase Rust identifier".into());
    }
    Ok(value.into())
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
