/// Terminal color fidelity inferred from process environment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorLevel {
    /// 24-bit RGB color sequences are supported.
    TrueColor,
    /// The indexed 256-color palette is supported.
    Ansi256,
    /// Only the base ANSI palette should be assumed.
    Ansi16,
    /// Color output is disabled or the terminal is non-interactive.
    Monochrome,
}

/// RGB color reported by the host terminal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalRgb {
    /// Red channel.
    pub red: u8,
    /// Green channel.
    pub green: u8,
    /// Blue channel.
    pub blue: u8,
}

impl TerminalRgb {
    pub const fn new(red: u8, green: u8, blue: u8) -> Self {
        Self { red, green, blue }
    }
}

impl From<[u8; 3]> for TerminalRgb {
    fn from([red, green, blue]: [u8; 3]) -> Self {
        Self::new(red, green, blue)
    }
}

/// Light or dark appearance inferred for the terminal background.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundAppearance {
    /// Background brightness is below the terminal appearance threshold.
    Dark,
    /// Background brightness reaches the terminal appearance threshold.
    Light,
}

/// Evidence used to classify the terminal background.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundSource {
    /// The terminal replied to an OSC 11 query with an RGB value.
    Osc11,
    /// The environment supplied a usable `COLORFGBG` background index.
    ColorFgBg,
    /// No reliable signal was available, so detection selected Dark.
    ConservativeFallback,
}

/// Resolved terminal appearance together with the evidence that produced it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackgroundDetection {
    /// Resolved light or dark appearance.
    pub appearance: BackgroundAppearance,
    /// Evidence that produced the resolution.
    pub source: BackgroundSource,
}

/// Resolves terminal appearance from an optional OSC 11 result and process environment.
pub fn resolve_background(reported: Option<TerminalRgb>) -> BackgroundDetection {
    let colorfgbg = std::env::var("COLORFGBG").ok();
    resolve_background_with_colorfgbg(reported, colorfgbg.as_deref())
}

pub(crate) fn detect_color_level(env: &impl EnvironmentValues) -> ColorLevel {
    if env.has("NO_COLOR") || env.value("CLICOLOR").is_some_and(|value| value == "0") {
        return ColorLevel::Monochrome;
    }
    let color_term = env
        .value("COLORTERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(color_term.as_str(), "truecolor" | "24bit") {
        return ColorLevel::TrueColor;
    }
    let term = env.value("TERM").unwrap_or_default().to_ascii_lowercase();
    if term == "dumb" {
        ColorLevel::Monochrome
    } else if term.contains("256color") {
        ColorLevel::Ansi256
    } else {
        ColorLevel::Ansi16
    }
}

fn resolve_background_with_colorfgbg(
    reported: Option<TerminalRgb>,
    colorfgbg: Option<&str>,
) -> BackgroundDetection {
    if let Some(color) = reported {
        return BackgroundDetection {
            appearance: appearance_from_rgb(color),
            source: BackgroundSource::Osc11,
        };
    }
    if let Some(appearance) = colorfgbg.and_then(appearance_from_colorfgbg) {
        return BackgroundDetection {
            appearance,
            source: BackgroundSource::ColorFgBg,
        };
    }
    BackgroundDetection {
        appearance: BackgroundAppearance::Dark,
        source: BackgroundSource::ConservativeFallback,
    }
}

fn appearance_from_rgb(color: TerminalRgb) -> BackgroundAppearance {
    let brightness =
        299 * u32::from(color.red) + 587 * u32::from(color.green) + 114 * u32::from(color.blue);
    if brightness >= 128_000 {
        BackgroundAppearance::Light
    } else {
        BackgroundAppearance::Dark
    }
}

fn appearance_from_colorfgbg(value: &str) -> Option<BackgroundAppearance> {
    let background = value.rsplit(';').next()?.trim().parse::<u8>().ok()? % 16;
    Some(if matches!(background, 7 | 10..=15) {
        BackgroundAppearance::Light
    } else {
        BackgroundAppearance::Dark
    })
}

/// Environment lookup boundary used by process detection and deterministic tests.
pub(crate) trait EnvironmentValues {
    fn value(&self, name: &str) -> Option<String>;

    fn has(&self, name: &str) -> bool {
        self.value(name).is_some()
    }
}

#[cfg(test)]
#[path = "appearance_tests.rs"]
mod tests;
